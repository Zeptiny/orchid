/**
 * Architecture Validation Tests — U28/U29.
 *
 * Validates that the TS/Electron architecture delivers the properties
 * promised by the migration, by exercising REAL app modules:
 *
 * 1. Parallel subagents — SubagentManager + concurrent runners
 * 2. Reactive state updates — agentMachine tool lifecycle context
 * 3. Responsive control during stream — CANCEL / interrupt while streaming
 * 4. Correct auto-scroll — pure helpers used by ChatStream
 *
 * These are architecture-property tests, not hollow Promise.all/setTimeout
 * simulations that only prove the JavaScript runtime works.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createActor } from 'xstate';
import {
  SubagentManager,
  SubagentState,
} from '../../src/main/agents/manager';
import { agentMachine } from '../../src/main/agents/xstate/agent-machine';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import {
  createCanonicalToolResult,
  type ToolExecutionResult,
} from '../../src/shared/types/tool-result';
import type { Agent } from '../../src/shared/types/agent';
import { AgentType, AgentTier } from '../../src/shared/types/agent';
import {
  AUTO_SCROLL_THRESHOLD_PX,
  isUserScrolledAwayFromBottom,
  shouldAutoScroll,
} from '../../src/renderer/components/ChatStream';

// ── Shared fixtures ──────────────────────────────────────────────────────────

const testAgent: Agent = {
  name: 'explorer',
  type: AgentType.SUBAGENT,
  tier: AgentTier.BLOOM,
  description: 'test subagent',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

const mockAgent: Agent = {
  name: 'general',
  type: AgentType.INTERNAL,
  tier: AgentTier.BLOOM,
  description: 'General-purpose agent',
  allowed_tools: ['*'],
  allowed_skills: ['*'],
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function streamExecution(content: string): ToolExecutionResult {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: content },
  });
  return {
    canonical,
    agentProjection: { content, completeness: 'complete' },
  };
}

/**
 * Wait for an actor to reach a target state value.
 * Checks current snapshot first (handles synchronous transitions).
 */
function waitForState(
  actor: ReturnType<typeof createActor>,
  targetState: string,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (actor.getSnapshot().value === targetState) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      sub.unsubscribe();
      const snap = actor.getSnapshot();
      reject(
        new Error(
          `Timeout waiting for state ${targetState}. ` +
            `Current: ${JSON.stringify(snap.value)}, context.error: ${snap.context.error}`,
        ),
      );
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    const sub = actor.subscribe((snapshot) => {
      if (snapshot.value === targetState) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

function waitForContext<T>(
  actor: ReturnType<typeof createActor>,
  predicate: (ctx: T) => boolean,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate(actor.getSnapshot().context as T)) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(new Error('Timeout waiting for context condition'));
    }, timeoutMs);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();

    const sub = actor.subscribe((snapshot) => {
      if (predicate(snapshot.context as T)) {
        clearTimeout(timer);
        sub.unsubscribe();
        resolve();
      }
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Architecture Properties (real modules)', () => {
  describe('1. Parallel subagents', () => {
    let manager: SubagentManager;

    beforeEach(() => {
      manager = new SubagentManager();
    });

    it('SubagentManager spawns 4 runners that execute in parallel', async () => {
      const DELAY_MS = 80;
      const SUBAGENT_COUNT = 4;
      const startTimes = new Map<string, number>();

      // Real manager API: setRunner drives isolated streams on spawn().
      manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
        startTimes.set(params.task, Date.now());
        try {
          await delay(DELAY_MS, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: `done:${params.task}` };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const wallStart = Date.now();
      const records = Array.from({ length: SUBAGENT_COUNT }, (_, i) =>
        manager.spawn(`explorer-${i}`, `task-${i}`, testAgent, { sessionId: `sess-parallel-${i}` }),
      );

      // Runner starts immediately for each spawn
      for (const r of records) {
        expect(manager.getRunPromise(r.id)).not.toBeNull();
      }

      const results = await manager.wait(records.map((r) => r.id));
      const wallDuration = Date.now() - wallStart;

      expect(results.size).toBe(SUBAGENT_COUNT);
      for (const r of records) {
        expect(results.get(r.id)?.state).toBe(SubagentState.COMPLETED);
        expect(results.get(r.id)?.result).toBe(`done:task-${records.indexOf(r)}`);
      }

      // Parallel: wall clock ≈ one delay, not N × delay
      expect(wallDuration).toBeLessThan(DELAY_MS * SUBAGENT_COUNT * 0.6);

      // All runners should have started near-simultaneously
      const starts = Array.from(startTimes.values());
      expect(starts).toHaveLength(SUBAGENT_COUNT);
      const maxStartSpread = Math.max(...starts) - Math.min(...starts);
      expect(maxStartSpread).toBeLessThan(DELAY_MS * 0.5);
    });

  });

  describe('2. Reactive state updates', () => {
    it('agentMachine tool lifecycle updates context between tool events', async () => {
      // Stream yields two sequential tool cycles; context must reflect each step.
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'Checking…' };
        yield {
          type: 'tool_call',
          toolCallId: 'tc-read',
          toolName: 'read',
          args: '{"file_path":"a.ts"}',
        };
        // Brief yield so subscribers observe intermediate state
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_result',
          toolCallId: 'tc-read',
          content: 'file contents',
          execution: streamExecution('file contents'),
        };
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_call',
          toolCallId: 'tc-edit',
          toolName: 'edit',
          args: '{"file_path":"a.ts","old_string":"a","new_string":"b"}',
        };
        await delay(5, params.abortSignal);
        yield {
          type: 'tool_result',
          toolCallId: 'tc-edit',
          content: 'ok',
          execution: streamExecution('ok'),
        };
        yield { type: 'content', text: ' Done.' };
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          interruptResetMs: 100,
        },
      });

      // Capture reactive snapshots of toolLifecycleUpdate as events arrive
      const lifecycleSnapshots: Array<{
        toolCallId: string;
        toolName?: string;
        status: string;
      }> = [];
      const seen = new Set<string>();
      const sub = actor.subscribe((snap) => {
        const u = snap.context.toolLifecycleUpdate;
        if (!u) return;
        const key = `${u.sequence}:${u.toolCallId}:${u.status}`;
        if (seen.has(key)) return;
        seen.add(key);
        lifecycleSnapshots.push({
          toolCallId: u.toolCallId,
          toolName: u.toolName,
          status: u.status,
        });
      });

      actor.start();
      actor.send({ type: 'USER_INPUT', message: 'Edit a.ts' });

      await waitForState(actor, 'idle');
      sub.unsubscribe();

      // At least one update per tool (running + completed) — context progressed
      expect(lifecycleSnapshots.length).toBeGreaterThanOrEqual(4);
      expect(lifecycleSnapshots.map((s) => s.toolCallId)).toEqual(
        expect.arrayContaining(['tc-read', 'tc-edit']),
      );

      const statusesFor = (id: string) =>
        lifecycleSnapshots.filter((s) => s.toolCallId === id).map((s) => s.status);
      expect(statusesFor('tc-read')).toContain('running');
      expect(statusesFor('tc-read')).toContain('complete');
      expect(statusesFor('tc-edit')).toContain('running');
      expect(statusesFor('tc-edit')).toContain('complete');

      // Final context retains last lifecycle update and full response text
      const final = actor.getSnapshot().context;
      expect(final.response).toContain('Checking…');
      expect(final.response).toContain('Done.');
      expect(final.toolLifecycleUpdate?.toolCallId).toBe('tc-edit');
      expect(final.toolLifecycleUpdate?.status).toBe('complete');
      expect(final.toolUpdateSequence).toBeGreaterThanOrEqual(4);

      actor.stop();
    });

    it('SubagentManager onChange notifies as each subagent progresses', async () => {
      const changeCounts: number[] = [];
      let lastRunningCount = 0;

      const manager = new SubagentManager();
      manager.setOnChange((records) => {
        changeCounts.push(records.length);
        lastRunningCount = records.filter(
          (r) => r.state === SubagentState.RUNNING || r.state === SubagentState.COMPLETED,
        ).length;
      });

      manager.setRunner(async function* (params): AsyncGenerator<StreamEvent> {
        try {
          await delay(30, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: 'done' };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const a = manager.spawn('a', 'task-a', testAgent);
      const b = manager.spawn('b', 'task-b', testAgent);

      await manager.wait([a.id, b.id]);

      // setOnChange fired for spawn + running + completion steps
      expect(changeCounts.length).toBeGreaterThanOrEqual(4);
      expect(lastRunningCount).toBe(2);
      expect(manager.getRecord(a.id)?.state).toBe(SubagentState.COMPLETED);
      expect(manager.getRecord(b.id)?.state).toBe(SubagentState.COMPLETED);
    });

    it('returns only the last step text as the result, not full narration', async () => {
      const manager = new SubagentManager();
      manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'Let me search the codebase.' };
        yield { type: 'step_finish', stepIndex: 0, finishReason: 'tool-calls' };
        yield { type: 'content', text: 'Reading the file now.' };
        yield { type: 'step_finish', stepIndex: 1, finishReason: 'tool-calls' };
        yield { type: 'content', text: 'Here is the final answer.' };
        yield { type: 'step_finish', stepIndex: 2, finishReason: 'stop' };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const record = manager.spawn('s', 'multi-step task', testAgent);
      await manager.wait([record.id]);

      const result = manager.getRecord(record.id)?.result;
      expect(result).toBe('Here is the final answer.');
      expect(result).not.toContain('Let me search');
      expect(result).not.toContain('Reading the file');
    });

    it('keeps the last text-bearing step when the final step is tool-only', async () => {
      const manager = new SubagentManager();
      manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'The answer is 42.' };
        yield { type: 'step_finish', stepIndex: 0, finishReason: 'tool-calls' };
        // Trailing step performs a tool call and emits no text.
        yield { type: 'step_finish', stepIndex: 1, finishReason: 'stop' };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const record = manager.spawn('s', 'trailing tool task', testAgent);
      await manager.wait([record.id]);

      expect(manager.getRecord(record.id)?.result).toBe('The answer is 42.');
    });

    it('falls back to full accumulation when no step boundaries are emitted', async () => {
      const manager = new SubagentManager();
      manager.setRunner(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'hello ' };
        yield { type: 'content', text: 'world' };
        yield { type: 'finish', finishReason: 'stop' };
      });

      const record = manager.spawn('s', 'no-step task', testAgent);
      await manager.wait([record.id]);

      expect(manager.getRecord(record.id)?.result).toBe('hello world');
    });
  });

  describe('3. Responsive control during stream', () => {
    it('agentMachine accepts CANCEL while streaming and transitions without hang', async () => {
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        yield { type: 'content', text: 'Starting…' };
        // Long-running stream that honors abort
        try {
          await delay(2000, params.abortSignal);
        } catch {
          return;
        }
        yield { type: 'content', text: ' should not appear' };
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          interruptResetMs: 50,
        },
      });

      actor.start();
      actor.send({ type: 'USER_INPUT', message: 'long task' });
      expect(actor.getSnapshot().value).toBe('streaming');

      await waitForContext(actor, (ctx: { response: string }) =>
        ctx.response.includes('Starting'),
      );

      // CANCEL must be processed while stream is still in flight
      actor.send({ type: 'CANCEL' });
      await waitForState(actor, 'interrupted', 2000);

      expect(actor.getSnapshot().context.wasInterrupted).toBe(true);
      expect(actor.getSnapshot().context.response).toContain('Starting');
      expect(actor.getSnapshot().context.response).not.toContain('should not appear');

      // Second CANCEL returns to idle (interrupt machine style confirmation)
      actor.send({ type: 'CANCEL' });
      await waitForState(actor, 'idle', 2000);

      actor.stop();
    }, 10000);

    it('streaming response keeps updating while interrupt remains available', async () => {
      let chunkCount = 0;
      const streamFn = async function* (params: {
        message: string;
        agent: Agent;
        systemPrompt: string;
        abortSignal: AbortSignal;
      }): AsyncGenerator<StreamEvent> {
        for (let i = 0; i < 5; i++) {
          if (params.abortSignal.aborted) return;
          yield { type: 'content', text: `c${i}` };
          chunkCount++;
          await delay(15, params.abortSignal).catch(() => undefined);
          if (params.abortSignal.aborted) return;
        }
        yield { type: 'finish', finishReason: 'stop' };
      };

      const actor = createActor(agentMachine, {
        input: {
          agent: mockAgent,
          systemPrompt: 'You are helpful.',
          streamFn,
          interruptResetMs: 100,
        },
      });

      const responses: string[] = [];
      actor.start();
      const sub = actor.subscribe((snap) => {
        if (snap.value === 'streaming' && snap.context.response) {
          responses.push(snap.context.response);
        }
      });

      actor.send({ type: 'USER_INPUT', message: 'stream me' });

      // Mid-stream: machine is still streaming and CANCEL is a valid event
      await waitForContext(actor, (ctx: { response: string }) =>
        ctx.response.length >= 4,
      );
      expect(actor.getSnapshot().value).toBe('streaming');
      // XState still accepts CANCEL in streaming (responsive control plane)
      const canCancel = actor
        .getSnapshot()
        .can({ type: 'CANCEL' });
      expect(canCancel).toBe(true);

      await waitForState(actor, 'idle');
      sub.unsubscribe();

      // Response grew reactively across multiple subscriptions
      expect(chunkCount).toBe(5);
      expect(responses.length).toBeGreaterThan(1);
      expect(actor.getSnapshot().context.response).toBe('c0c1c2c3c4');

      actor.stop();
    });
  });

  describe('4. Correct auto-scroll (ChatStream helpers)', () => {
    it('isUserScrolledAwayFromBottom matches ChatStream threshold semantics', () => {
      // Exactly at threshold → still considered at bottom
      expect(
        isUserScrolledAwayFromBottom(500, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(false); // distance = 100, not > 100

      // Past threshold → scrolled up
      expect(
        isUserScrolledAwayFromBottom(400, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(true); // distance = 200

      // At bottom
      expect(
        isUserScrolledAwayFromBottom(600, 1000, 400, AUTO_SCROLL_THRESHOLD_PX),
      ).toBe(false); // distance = 0
    });

    it('shouldAutoScroll is independent of message count', () => {
      // Adding messages does not flip the flag by itself — only scroll position does.
      const messageCounts = [0, 1, 10, 50, 100];
      for (const _n of messageCounts) {
        expect(shouldAutoScroll(false)).toBe(true);
        expect(shouldAutoScroll(true)).toBe(false);
      }
    });

    it('auto-scroll re-enables only after user returns near bottom', () => {
      let isUserScrolledUp = false;
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(true);

      // User scrolls up past threshold
      isUserScrolledUp = isUserScrolledAwayFromBottom(200, 2000, 400);
      expect(isUserScrolledUp).toBe(true);
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(false);

      // New messages arrive — flag stays based on scroll position, not count
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(false);

      // User scrolls back near bottom
      isUserScrolledUp = isUserScrolledAwayFromBottom(1500, 2000, 400);
      expect(isUserScrolledUp).toBe(false);
      expect(shouldAutoScroll(isUserScrolledUp)).toBe(true);
    });
  });
});

describe('Provider architecture invariants (U9)', () => {
  const sourceRoot = path.resolve(__dirname, '../../src');
  const read = (...parts: string[]) => fs.readFileSync(path.join(sourceRoot, ...parts), 'utf8');

  function sourceFiles(directory: string): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(entryPath);
      return /\.tsx?$/.test(entry.name) ? [entryPath] : [];
    });
  }

  it('has no shipping default provider or alias-derived adapter fallback', () => {
    // The zod literals moved to the shared config schema when the host
    // protocol began validating config payloads against it (waves 1-2);
    // main/config/schema.ts is a re-export facade.
    const config = read('shared', 'types', 'config-schema.ts');
    const runtime = read('main', 'providers', 'index.ts');
    const toolSources = [
      read('main', 'tools', 'index.ts'),
      read('main', 'tools', 'subagent', 'delegate.ts'),
    ].join('\n');

    expect(config).toContain('default_model: modelSelectionSchema.nullable().default(null)');
    expect(runtime).toContain('resolveModelSelection(selection, connections, definitions)');
    expect(runtime).not.toContain('default_model');
    expect(runtime).not.toContain('createOpenAICompatible');
    expect(runtime).not.toContain('createOpenAI(');
    expect(toolSources).toContain('getTierModelSelection');
    expect(toolSources).not.toMatch(/llm\/providers/);
  });

  it('removes obsolete compatibility modules and their production imports', () => {
    const obsoletePaths = [
      ['main', 'llm', 'providers.ts'],
      ['main', 'llm', 'providers-factory.ts'],
      ['renderer', 'components', 'Onboarding', 'ProviderDetector.tsx'],
    ];

    for (const parts of obsoletePaths) {
      expect(fs.existsSync(path.join(sourceRoot, ...parts))).toBe(false);
    }

    const legacyImport = /(?:from\s*|import\s*\(|require\()\s*['"][^'"]*(?:\/llm\/providers(?:-factory)?|\/Onboarding\/ProviderDetector)['"]/;
    const offenders = sourceFiles(sourceRoot).filter((filePath) =>
      legacyImport.test(fs.readFileSync(filePath, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('uses the credential vault and removes the legacy keychain fallback', () => {
    const vault = read('main', 'providers', 'credentials', 'vault.ts');
    const legacyKeychainPath = path.join(sourceRoot, 'main', 'config', 'keychain.ts');

    expect(fs.existsSync(legacyKeychainPath)).toBe(false);
    expect(vault).toContain("if (backend === 'basic_text') return { available: false, reason: 'basic_text' }");
    expect(vault).toContain('this.storage.encryptString(JSON.stringify(secret))');
    expect(vault).not.toMatch(/encryptedPayload:\s*JSON\.stringify/);
  });

  it('keeps renderer provider operations intent-only and credential-safe', () => {
    const ipc = read('shared', 'types', 'ipc.ts');
    const providerIpc = read('main', 'ipc', 'providers.ts');
    const preload = read('preload', 'index.ts');

    expect(ipc).toContain('ProviderSubmitApiKeyMessage');
    const connectionView = ipc.match(
      /export interface ProviderConnectionView \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(connectionView).toBeDefined();
    expect(connectionView).not.toContain('credentialHandle');
    expect(connectionView).not.toContain('encrypted');
    expect(connectionView).not.toContain('apiKey');
    expect(providerIpc).toContain('Invalid providers:submit_api_key payload');
    expect(providerIpc).toContain('replaceConnectionApiKey');
    expect(preload).toContain('submitApiKey');
    expect(preload).not.toContain('readCredential');
  });

  it('binds generic credentials to an origin and invalidates them before rebinding', () => {
    const providerIpc = read('main', 'ipc', 'providers.ts');
    const vault = read('main', 'providers', 'credentials', 'vault.ts');

    expect(providerIpc).toContain('genericOrigin(existing, current) !== genericOrigin(candidate, current)');
    expect(providerIpc).toContain('deleteConnectionCredentials(existing.id)');
    expect(vault).toContain('replaceConnectionApiKey');
    expect(vault).toContain('normalizeCredentialBinding');
  });

  it('records every provider call through the durable accounting middleware with no SDK retry layer', () => {
    const middleware = read('main', 'providers', 'accounting', 'middleware.ts');
    const orchestrator = read('main', 'llm', 'orchestrator.ts');
    const store = read('main', 'providers', 'accounting', 'store.ts');

    expect(middleware).toContain('insertPending');
    expect(middleware).toContain('finalize');
    expect(orchestrator).toMatch(/maxRetries:\s*0/);
    expect(store).toContain('interruptPendingForConnection');
  });

  it('retains Lilac supply-discount fields without using them to gate requests', () => {
    const lilac = read('main', 'providers', 'drivers', 'lilac.ts');
    const status = read('main', 'providers', 'status', 'service.ts');

    expect(lilac).toContain('current_subscription_discount_percent');
    expect(lilac).toContain('current_subscription_credit_multiplier');
    expect(lilac).toContain('current_subscription_supply_state');
    expect(status).toContain('never mutates a connection or selects a model');
  });
});
