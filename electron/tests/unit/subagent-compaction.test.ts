/**
 * Subagent mid-run compaction orchestration (U9/U5) — manager-level coverage.
 *
 * Covers the run-loop plumbing in SubagentManager._startRun:
 *  - ARM:      usage event over threshold → prepare starts (compactor caller
 *              invoked with the compactable range), a scoped pending is
 *              registered and the scoped pause is armed.
 *  - APPLY:    the pause gate consumes the pending at the step boundary —
 *              re-validated against the live chain history (R37), applied
 *              over it (originals preserved: excludeFromModel flags + one
 *              summary head at the cut), markCompaction revision bumped,
 *              trigger re-armed with a post-compaction baseline, and the
 *              stream restarted with the compacted history (R28).
 *  - DEGRADE:  still over the window after an apply with no compactable range
 *              left → run COMPLETES (not fails) with buildSubagentPartialReport
 *              content in record.result (R17) — including the two-apply
 *              reclaim → summarizer flow (re-compact at the next boundary).
 *
 * The LLM compactor is faked by mocking llm/compaction/summarize; everything
 * else (selectCut, trigger engine, mechanical reclaim, buildCompactionApply,
 * persistence bookkeeping) runs for real. Model context limits come from a
 * mocked provider runtime, mirroring how resolveSubagentContextTokens
 * resolves them (R16).
 *
 * Harness follows subagent-runtime.test.ts (manager construction, scripted
 * stream runners) and subagent-compaction-selective.test.ts (module mocks for
 * subagent-runner's static graph). The scripted runners drive the pause gate
 * via the compaction controller the manager hands to the production runner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Agent } from '../../src/shared/types/agent';
import type { Message } from '../../src/shared/types/message';
import type { ModelSelection } from '../../src/shared/types/provider';
import type { StreamEvent } from '../../src/main/llm/orchestrator';
import type { Config } from '../../src/shared/types/ipc-boundary';
import { defaults } from '../../src/main/config/schema';
import { createCanonicalToolResult } from '../../src/shared/types/tool-result';
import { ChainStatus } from '../../src/shared/types/chain';
import type { SubagentPersistence } from '../../src/main/agents/subagent-persistence';
import type { SubagentCompactionPayload } from '../../src/main/session/storage';

// ── Module mocks ─────────────────────────────────────────────────────────────
// The manager only needs config + provider mocks; subagent-runner (dynamically
// imported by the compaction path) additionally pulls the provider/IPC-heavy
// leaves, which are stubbed exactly like subagent-compaction-selective.test.ts.
// llm/compaction/* (select, trigger, apply, reclaim, message-chars) load for
// real; only the LLM summarizer is faked.

const mocks = vi.hoisted(() => ({
  config: null as Config | null,
  resolveExecution: vi.fn(),
  summarize: vi.fn(),
}));

vi.mock('../../src/main/config/loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/config/loader')>();
  return {
    ...actual,
    getConfig: () => mocks.config ?? actual.getConfig(),
  };
});

vi.mock('../../src/main/session/singleton', () => ({
  getSessionManager: () => ({
    getSession: vi.fn(() => ({ cwd: null })),
    getActive: vi.fn(() => ({ cwd: null })),
  }),
}));

vi.mock('../../src/main/project/runtime', () => ({
  getProjectRuntimeRegistry: () => ({ get: vi.fn() }),
}));

vi.mock('../../src/main/providers', () => ({
  getProviderRuntime: () => ({ resolveExecution: mocks.resolveExecution }),
}));

vi.mock('../../src/main/providers/accounting/store', () => ({
  getProviderAccountingStore: () => ({}),
}));

vi.mock('../../src/main/providers/accounting/subagent-attribution-store', () => ({
  getSubagentAttributionStore: () => ({ insert: vi.fn(), finalize: vi.fn() }),
}));

vi.mock('../../src/main/llm/orchestrator', () => ({
  streamChat: vi.fn(),
}));

vi.mock('../../src/main/llm/build-prompt-context', () => ({
  buildSystemPromptContext: vi.fn(async () => ({})),
}));

vi.mock('../../src/main/mcp/project-registry', () => ({
  acquireProjectMCPManager: vi.fn(),
  releaseProjectMCPManager: vi.fn(),
}));

vi.mock('../../src/main/tools', () => ({
  getBuiltinToolRegistryForRuntime: vi.fn(),
}));

vi.mock('../../src/main/llm/compaction/summarize', () => ({
  summarizeCompactableRange: mocks.summarize,
}));

import {
  SubagentManager,
  SubagentState,
  runtimeToDomain,
  type SubagentCompactionPauseController,
} from '../../src/main/agents/manager';
import {
  applySubagentPendingCompaction,
  buildSubagentPartialReport,
  resolveSubagentContextTokens,
} from '../../src/main/agents/subagent-compaction';
import {
  getCompactionPending,
  isPendingCutStillValid,
  setCompactionPending,
  type CompactionPendingEntry,
} from '../../src/main/llm/compaction/pending-store';
import { resolveUserExemptIds, type CutResult } from '../../src/main/llm/compaction/select';
import type { ApplyResult } from '../../src/main/llm/compaction/apply';
import type { SelectiveCompactionResult } from '../../src/main/llm/compaction/selective/run';
import { shouldPauseForCompaction } from '../../src/main/ipc/next-request-stop';
import {
  SubagentDeltaEventType,
  type SubagentCompactionProgressEvent,
  type SubagentDeltaEvent,
} from '../../src/shared/types/subagent';
import { SubagentCompactionController } from '../../src/main/agents/subagent-compaction-controller';
import { SubagentRunAssembler } from '../../src/main/agents/subagent-run-assembler';
import type { SubagentRecord as RuntimeSubagentRecord } from '../../src/main/agents/manager';
import type { Chain } from '../../src/shared/types/chain';
import type { Usage } from '../../src/shared/types/message';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONTEXT_TOKENS = 1000;
const SELECTION: ModelSelection = {
  connectionId: '5cd0d624-57cd-4bdb-8d75-932be0b60c36',
  modelId: 'test-model',
};

const testAgent: Agent = {
  name: 'explorer',
  type: 'subagent',
  tier: 'bloom',
  description: 'test',
  system_prompt: 'You explore.',
  allowed_tools: ['read', 'grep'],
  allowed_skills: [],
};

const TASK = 'Map the authentication flow across services.';

/** Subagents compaction scope with explicit knobs (default: summarizer path). */
function compactionConfig(overrides: Record<string, unknown> = {}): Config {
  const base = defaults();
  return {
    ...base,
    compaction: {
      main: base.compaction.main,
      subagents: {
        ...base.compaction.subagents,
        mode: 'simple',
        threshold: 0.5,
        preserve_percent: 0.25,
        min_compactable_tokens: 20,
        hysteresis_delta: 0.1,
        mechanical_reclaim: false,
        ...overrides,
      },
    },
  };
}

function successfulToolResult(
  toolCallId: string,
  content: string,
): Extract<StreamEvent, { type: 'tool_result' }> {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: content },
  });
  return {
    type: 'tool_result',
    toolCallId,
    content,
    execution: {
      canonical,
      agentProjection: { content, completeness: 'complete' },
    },
  };
}

function usageEvent(promptTokens: number): StreamEvent {
  return {
    type: 'usage',
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 10,
      total_tokens: promptTokens + 10,
      cached_tokens: 0,
    },
  };
}

const STEP_TEXT_LEN = 90;
const RESULT_LEN = 90;
const DUP_ARGS = '{"path":"/repo/same.ts"}';

/** One stream "step": assistant text → tool call → tool result (3 chain messages). */
function stepEvents(index: number, opts: { args?: string; resultChars?: number } = {}): StreamEvent[] {
  const callId = `tc-${index}`;
  return [
    { type: 'content', text: `Step ${index}: ${'x'.repeat(STEP_TEXT_LEN)}` },
    {
      type: 'tool_call',
      toolCallId: callId,
      toolName: 'read_file',
      args: opts.args ?? `{"path":"/repo/file-${index}.ts"}`,
    },
    successfulToolResult(callId, 'r'.repeat(opts.resultChars ?? RESULT_LEN)),
  ];
}

/** Unique steps — no mechanical reclaim candidates. */
function steps(count: number): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (let i = 0; i < count; i += 1) events.push(...stepEvents(i));
  return events;
}

/** Identical steps — every tool result is an exact duplicate (reclaim fodder). */
function duplicateSteps(count: number): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (let i = 0; i < count; i += 1) events.push(...stepEvents(i, { args: DUP_ARGS }));
  return events;
}

type ScriptItem =
  | StreamEvent
  | { readonly sleepMs: number }
  | { readonly probe: () => void }
  | { readonly until: () => boolean; readonly label?: string }
  /**
   * Pause-gate choreography (U5): wait until this run's scoped compaction
   * pause is armed, then consume it the way the production runner does at a
   * step boundary (await the controller's apply). A 'degraded' outcome stops
   * the script — the run ends at the boundary, exactly like the real runner.
   */
  | { readonly pauseGate: true }
  /**
   * Overflow-retry choreography (U6): invoke the controller's reactive
   * overflow entry exactly as the production runner does when streamChat
   * yields a classified context_length_exceeded error — `true` marks the
   * post-retry (alreadyRetried) terminal call. A 'degraded' or 'aborted'
   * outcome stops the script, mirroring the real runner; 'unavailable'
   * leaves the error to propagate, so the script must yield it next.
   */
  | { readonly overflowGate: boolean };

/** Wait until the summarizer prepare has actually started (implies the run's pending promise is registered). */
const summarizerStarted: ScriptItem = {
  until: () => mocks.summarize.mock.calls.length >= 1,
  label: 'summarizer prepare to start',
};

/**
 * Wait until the manager's fire-and-forget compaction prepare evaluation #n
 * has settled (it either registered its pending promise or decided not to
 * start one). Scripts using this reference the manager itself, so build them
 * after construction (inline `new SubagentManager()` + setRunner) instead of
 * via managerWith.
 */
const prepareEvaluated = (manager: SubagentManager, count: number): ScriptItem => ({
  until: () => manager.compactionPreparesEvaluated() >= count,
  label: `compaction prepare evaluation #${count}`,
});

function scriptedRunner(script: readonly ScriptItem[]) {
  return async function* (params: {
    compaction?: SubagentCompactionPauseController;
  }): AsyncGenerator<StreamEvent> {
    for (const item of script) {
      if ('sleepMs' in item) {
        await new Promise((resolve) => setTimeout(resolve, item.sleepMs));
        continue;
      }
      if ('probe' in item) {
        item.probe();
        continue;
      }
      if ('until' in item) {
        const deadline = Date.now() + 4000;
        while (!item.until()) {
          if (Date.now() > deadline) {
            throw new Error(`scriptedRunner timed out waiting for ${item.label ?? 'condition'}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        continue;
      }
      if ('pauseGate' in item) {
        const gate = params.compaction;
        if (!gate) {
          throw new Error('scriptedRunner pauseGate requires the compaction pause controller');
        }
        const deadline = Date.now() + 4000;
        while (!gate.shouldPause()) {
          if (Date.now() > deadline) {
            throw new Error('scriptedRunner timed out waiting for the compaction pause to arm');
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const outcome = await gate.applyAtPause();
        if (outcome === 'degraded' || outcome === 'aborted') return;
        continue;
      }
      if ('overflowGate' in item) {
        const gate = params.compaction?.compactForOverflow;
        if (!gate) {
          throw new Error('scriptedRunner overflowGate requires the compaction overflow controller');
        }
        const outcome = await gate({ alreadyRetried: item.overflowGate });
        if (outcome === 'degraded' || outcome === 'aborted') return;
        continue;
      }
      yield item;
    }
  };
}

function managerWith(script: readonly ScriptItem[]): SubagentManager {
  const manager = new SubagentManager();
  manager.setRunner(scriptedRunner(script));
  return manager;
}

function spawnCompactionSubagent(manager: SubagentManager, sessionId = 'session-compaction') {
  return manager.spawn('compaction probe', TASK, testAgent, {
    sessionId,
    selection: SELECTION,
  });
}

function summarizeCalls(): Array<Record<string, unknown>> {
  return mocks.summarize.mock.calls.map((call) => call[0] as Record<string, unknown>);
}

/** The manager's private persistence collaborator (compaction revision bookkeeping). */
function persistenceOf(manager: SubagentManager): SubagentPersistence {
  const persistence = (manager as unknown as { _persistence?: SubagentPersistence })._persistence;
  if (!persistence) {
    throw new Error('SubagentManager._persistence is unavailable — the private collaborator was renamed or not initialized; update persistenceOf() in subagent-compaction.test.ts');
  }
  return persistence;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config = compactionConfig();
  mocks.resolveExecution.mockResolvedValue({
    model: { limits: { contextTokens: CONTEXT_TOKENS } },
  });
  mocks.summarize.mockResolvedValue({ text: `Summary: ${'s'.repeat(300)}`, usage: null });
});

// ── ARM: usage over threshold starts a prepare ───────────────────────────────

describe('SubagentManager mid-run compaction (U9): arm', () => {
  it('starts the compactor prepare when a usage event crosses the subagent threshold', async () => {
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).toHaveBeenCalledTimes(1);

    const call = summarizeCalls()[0]!;
    expect(call['scope']).toBe('subagents');
    expect(call['subagentId']).toBe(record.id);
    expect(call['fallbackSelection']).toEqual(SELECTION);
    expect(call['existingModelSelection']).toEqual(SELECTION);
    // Subagent-scoped accounting attribution: per-run turn id `id#generation`.
    expect(call['accounting']).toMatchObject({
      sessionId: 'session-compaction',
      chainId: record.chain?.id,
      turnId: `${record.id}#1`,
    });

    // The compactor received the compactable range: a non-empty contiguous
    // run of the live chain starting right after the delegated task head —
    // R31/R32 exempt user messages never enter the compactable range — while
    // the preserve window stays verbatim at the tail.
    const slice = call['messages'] as Message[];
    const chainIds = (record.chain?.messages ?? []).map((m) => m.id);
    const sliceIds = slice.map((m) => m.id);
    expect(sliceIds.length).toBeGreaterThan(0);
    expect(sliceIds.length).toBeLessThan(chainIds.length);
    expect(chainIds.slice(1, 1 + sliceIds.length)).toEqual(sliceIds);
    expect(sliceIds).not.toContain(chainIds.at(-1));
    expect(sliceIds).not.toContain(chainIds[0]);

    // No boundary was crossed in this run: the pending prepare never applied.
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
    expect((record.chain?.messages ?? []).some((m) => m.excludeFromModel)).toBe(false);
  });

  it('does not arm below the threshold', async () => {
    // The script observes the manager itself (prepareEvaluated), so construct
    // it inline instead of via managerWith.
    const manager = new SubagentManager();
    manager.setRunner(scriptedRunner([
      ...steps(10),
      usageEvent(300),
      // The below-threshold decision never calls the summarizer — wait for
      // the prepare evaluation itself to settle instead.
      prepareEvaluated(manager, 1),
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
  });
});

// ── APPLY: step_finish boundary applies the pending compaction ───────────────

describe('SubagentManager mid-run compaction (U9): apply at boundary', () => {
  it('applies the pending compaction at the next step boundary, preserving every original', async () => {
    const summaryText = `Summary: ${'s'.repeat(300)}`;
    mocks.summarize.mockResolvedValue({ text: summaryText, usage: null });
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      // The pause-gate choreography (U5): the stream stops at the step
      // boundary once the scoped pause arms; the runner awaits the
      // controller's apply before the next segment.
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    expect(record.state).toBe(SubagentState.COMPLETED);

    // Compacted transcript shape: every original survives, exactly one summary
    // head is inserted at the cut, and the covered prefix leaves the model view.
    // R31/R32: the subagent's delegated task head (first user message) is NEVER
    // flagged — it stays in the model view for the run's entire lifetime. The
    // universal settle in buildCompactionApply un-flags user messages in any
    // mode, so the task head survives verbatim alongside the summary head.
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const summary = chain.find((m) => m.compacted)!;
    expect(summary.compacted?.mode).toBe('simple');
    expect(summary.content).toBe(summaryText);
    const cut = chain.indexOf(summary);
    expect(cut).toBeGreaterThan(0);
    // Originals preserved: chain length = originals + 1 summary head, no ids lost.
    const originalIds = new Set(chain.filter((m) => !m.compacted).map((m) => m.id));
    expect(chain).toHaveLength(originalIds.size + 1);
    // R31: user messages (the task head) are never excluded from the model view.
    const userMessages = chain.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);
    expect(userMessages.every((m) => m.excludeFromModel !== true)).toBe(true);
    // Non-user messages in the compacted prefix are flagged; the preserved tail
    // after the summary head stays unflagged.
    expect(chain.slice(cut + 1).every((m) => m.excludeFromModel !== true)).toBe(true);

    // Persistence: compaction is a checkpointable mutation (crash resume, R22).
    const persistence = persistenceOf(manager);
    expect(persistence.getLastCompactionRevision(record.id)).not.toBeNull();
    expect(persistence.hasPendingCompaction(record.id)).toBe(true);

    // The boundary did NOT degrade the run: it completed normally with the
    // streamed result (no partial report).
    expect(record.result).not.toContain('[Subagent partial report');
    expect(record.result).toContain('Step 0');
    expect(record.chain?.status).toBe(ChainStatus.COMPLETED);
  });

  it('re-arms hysteresis from the post-compaction model view; a re-attempt within the run no-ops on the summary-marked chain', async () => {
    let callsAfterReArm = -1;
    // The script observes the manager itself (prepareEvaluated), so construct
    // it inline instead of via managerWith.
    const manager = new SubagentManager();
    manager.setRunner(scriptedRunner([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true }, // apply #1 at the pause boundary
      usageEvent(450),
      // The re-opened prepare resolves to a no-op and never calls the
      // summarizer — wait for its evaluation (#2: the first settled after the
      // initial usage event) instead of a bounded settle.
      prepareEvaluated(manager, 2),
      { probe: () => { callsAfterReArm = mocks.summarize.mock.calls.length; } },
      { type: 'step_finish', stepIndex: 1, finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    // Post-compaction baseline (current behavior — sibling fix): the estimate
    // in the pause-boundary apply EXCLUDES excludeFromModel originals, so the
    // accrual baseline is the post-compaction model view (summary head +
    // preserved tail ≈ 300 tokens here), NOT the pre-compaction input (600).
    // A 450 usage event (above the 400 re-arm line, 150 tokens of accrual past
    // the baseline) therefore re-opens the prepare gate. Under the older
    // overestimating shape (baseline ≈ 600) it would have stayed closed.
    //
    // The re-opened prepare cannot summarize again, though: selectCut infers
    // chain boundaries from USER messages, and a subagent run has exactly one
    // user turn — once the chain contains a compacted marker the whole chain
    // counts as summarized (realChains = []) and the compactable range comes
    // back empty. The gate no-ops before registering a pending — the run is
    // never wedged and never double-compacts.
    expect(callsAfterReArm).toBe(1);
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    expect(record.result).not.toContain('[Subagent partial report');
  });
});

// ── Durable sink (R36): the compaction write leaves the manager via the sink ─

describe('SubagentManager mid-run compaction (U9): durable sink', () => {
  it('routes the pause-boundary apply through the injected compaction sink with the targeted-write payload', async () => {
    // The default sink resolves the session singleton via a lazy require that
    // cannot load under Vitest — injecting a recording sink makes the durable
    // path manager-level testable and pins the payload shape the storage
    // transaction consumes.
    const summaryText = `Summary: ${'s'.repeat(300)}`;
    mocks.summarize.mockResolvedValue({ text: summaryText, usage: null });
    const durableCalls: Array<{
      sessionId: string;
      subagentId: string;
      payload: SubagentCompactionPayload;
    }> = [];
    const manager = new SubagentManager({
      compactionSink: (sessionId, subagentId, payload) => {
        durableCalls.push({ sessionId, subagentId, payload });
        return null;
      },
    });
    let liveIdsBeforeApply: string[] = [];
    manager.setRunner(scriptedRunner([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      {
        probe: () => {
          liveIdsBeforeApply = (record.chain?.messages ?? []).map((m) => m.id);
        },
      },
      { pauseGate: true },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager, 'session-durable-sink');
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(durableCalls).toHaveLength(1);
    const durable = durableCalls[0]!;
    expect(durable.sessionId).toBe('session-durable-sink');
    expect(durable.subagentId).toBe(record.id);

    const payload = durable.payload;
    // liveMessages: the apply-time live transcript the flagged ids and the
    // summary anchor were computed over.
    expect(payload.liveMessages?.map((m) => m.id)).toEqual(liveIdsBeforeApply);

    const chain = record.chain?.messages ?? [];
    const summaryIdx = chain.findIndex((m) => m.compacted);
    expect(summaryIdx).toBeGreaterThan(0);
    // summaryMessage: exactly the summary head the apply inserted into the chain.
    expect(payload.summaryMessage?.id).toBe(chain[summaryIdx]!.id);
    // insertBeforeMessageId: the first preserved-window message after the cut.
    expect(payload.insertBeforeMessageId).toBe(chain[summaryIdx + 1]?.id ?? null);
    // flaggedMessageIds: the covered prefix, never the exempt task head, and
    // exactly the ids the chain flags with excludeFromModel.
    expect(payload.flaggedMessageIds.length).toBeGreaterThan(0);
    expect(new Set(payload.flaggedMessageIds).size).toBe(payload.flaggedMessageIds.length);
    expect(payload.flaggedMessageIds).not.toContain(liveIdsBeforeApply[0]);
    expect(new Set(payload.flaggedMessageIds)).toEqual(
      new Set(chain.filter((m) => m.excludeFromModel === true).map((m) => m.id)),
    );

    // The durable write is checkpointable like the real sink's (R36).
    expect(persistenceOf(manager).getLastCompactionRevision(record.id)).not.toBeNull();
  });
});

// ── PAUSE GATE (U5): re-validation, re-anchor, widget lifecycle ─────────────

describe('SubagentManager compaction pause gate (U5)', () => {
  it('discards the pending when the live history diverges from the prepare-time cut (R37)', async () => {
    // The pending's expected ids are captured at prepare time; if the chain
    // history mutates in a way that invalidates the cut (here simulated by a
    // stale expected-ids anchor, e.g. messages inserted inside the range),
    // the pause-boundary apply must discard the pending — never compact
    // against a cut that no longer matches the live history.
    const manager = new SubagentManager();
    let recordId = '';
    manager.setRunner(scriptedRunner([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      {
        probe: () => {
          const pending = getCompactionPending('session-compaction', recordId);
          expect(pending).toBeDefined();
          setCompactionPending('session-compaction', recordId, {
            ...pending!,
            expectedIds: ['shifted-away-from-the-live-range'],
          } as CompactionPendingEntry);
        },
      },
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    recordId = record.id;
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    // Discarded, not applied: the chain stays un-compacted and no compaction
    // checkpoint was persisted.
    const chain = record.chain?.messages ?? [];
    expect(chain.some((m) => m.compacted)).toBe(false);
    expect(chain.some((m) => m.excludeFromModel)).toBe(false);
    expect(persistenceOf(manager).getLastCompactionRevision(record.id)).toBeNull();
    // The restart after the skip kept the run's progress.
    expect(record.result).toContain('Step 0');
  });

  it('re-anchors the apply onto the live history: the post-prepare suffix survives un-flagged (R37)', async () => {
    const summaryText = `Summary: ${'s'.repeat(300)}`;
    mocks.summarize.mockResolvedValue({ text: summaryText, usage: null });
    let suffixIds: string[] = [];
    const manager = managerWith([
      ...steps(6),
      usageEvent(600), // prepare runs over this chain
      summarizerStarted,
      // Two more steps appended between prepare and apply (unique ids — a
      // re-used tool-call id would collide with the pre-prepare steps).
      ...stepEvents(6),
      ...stepEvents(7),
      {
        probe: () => {
          suffixIds = (record.chain?.messages ?? []).slice(-6).map((m) => m.id);
        },
      },
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const cut = chain.findIndex((m) => m.compacted);
    // The apply is built over the APPLY-time history, so every message
    // appended after the prepare lands in the preserved suffix — verbatim and
    // un-flagged, never silently dropped by a prepare-time snapshot.
    expect(suffixIds).toHaveLength(6);
    for (const id of suffixIds) {
      const message = chain.find((m) => m.id === id);
      expect(message, `post-prepare message ${id} must survive`).toBeDefined();
      expect(message!.excludeFromModel).not.toBe(true);
      expect(chain.indexOf(message!)).toBeGreaterThan(cut);
    }
    // R31/R32: the delegated task head stays in the model view.
    expect(chain[0]?.excludeFromModel).not.toBe(true);
    expect(persistenceOf(manager).getLastCompactionRevision(record.id)).not.toBeNull();
  });

  it('emits preparing → compacting → complete widget events for a paused compaction', async () => {
    const manager = new SubagentManager();
    const phases: string[] = [];
    manager.setOnDelta((event: SubagentDeltaEvent) => {
      if (event.type === SubagentDeltaEventType.COMPACTION_PROGRESS) {
        phases.push((event as SubagentCompactionProgressEvent).phase);
      }
    });
    manager.setRunner(scriptedRunner([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(phases.length).toBeGreaterThanOrEqual(3);
    expect(phases[0]).toBe('preparing');
    expect(phases).toContain('compacting');
    expect(phases.at(-1)).toBe('complete');
    expect(phases.indexOf('preparing')).toBeLessThan(phases.indexOf('compacting'));
    expect(phases.lastIndexOf('compacting')).toBeLessThan(phases.lastIndexOf('complete'));
  });

  it('validates pendings index-anchored: range shifts invalidate, tail appends stay valid (R37)', () => {
    const base = [
      { id: 'u0', role: 'user', content: 'task' },
      { id: 'a1', role: 'assistant', content: 'one' },
      { id: 'a2', role: 'assistant', content: 'two' },
      { id: 'a3', role: 'assistant', content: 'three' },
    ].map((m) => ({ ...m, type: 'text' })) as unknown as Message[];
    const cut = {
      cutIndex: 3,
      compactableRange: { start: 1, end: 3 },
      preservedCount: 1,
      openGroupStart: null,
      preservedRange: { start: 3, end: 4 },
    };
    const pending = { cut, flaggedIds: [] as string[], expectedIds: ['a1', 'a2'] };

    expect(isPendingCutStillValid(pending, base)).toBe(true);
    // Messages appended at the tail keep the range anchored — the apply
    // re-anchors onto the longer live history instead of discarding.
    expect(isPendingCutStillValid(pending, [...base, { ...base[3]!, id: 'a4' }])).toBe(true);
    // A message inserted before the range shifts every index — discard.
    const shifted = [base[0]!, { ...base[1]!, id: 'inserted' }, ...base.slice(1)];
    expect(isPendingCutStillValid(pending, shifted)).toBe(false);
    // A compacted summary head deeper than the range start would summarize a
    // summary — discard.
    const withHead = base.map((m, i) =>
      i === 2 ? { ...m, compacted: { rangeStart: 'a1', rangeEnd: 'a2', mode: 'simple' } } : m,
    );
    expect(isPendingCutStillValid(pending, withHead)).toBe(false);
  });
});

// ── DEGRADE (R17): still over the window after compaction ────────────────────

describe('SubagentManager mid-run compaction (U9): degrade to partial report', () => {
  it('completes (does not fail) with a partial report when the post-compaction model view still exceeds the window', async () => {
    // A large summary head keeps the post-compaction model view over the
    // threshold, and the compacted chain (single user turn + summary marker)
    // has no further compactable range → R17 degradation at the pause boundary.
    mocks.summarize.mockResolvedValue({ text: `Summary: ${'s'.repeat(1500)}`, usage: null });
    const manager = managerWith([
      ...steps(5),
      usageEvent(900),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true }, // degrades: the run ends at the pause boundary
      { type: 'finish', finishReason: 'stop' }, // unreachable: the run ends at the boundary
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    // Degraded runs COMPLETE with the partial report as a normal result — they
    // are not failures (R17).
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();
    expect(mocks.summarize).toHaveBeenCalledTimes(1);

    const result = record.result ?? '';
    expect(result).toContain('[Subagent partial report — context window limit reached after compaction]');
    expect(result).toContain('Done:');
    // Originals are preserved by the apply, so every tool result still counts.
    expect(result).toContain('5 tool results');
    expect(result).toContain('Remaining:');
    expect(result).toContain(TASK);
    expect(result).toContain('Stopped at: step 0');
    expect(result).toContain('partial result returned as a normal tool result to the parent');

    // The compacted chain is still persisted underneath (flags + summary head).
    // R31/R32: the task head (user message) is never flagged — it survives in
    // the model view. Non-user messages in the prefix are flagged.
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const cut = chain.findIndex((m) => m.compacted);
    const userMessages = chain.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);
    expect(userMessages.every((m) => m.excludeFromModel !== true)).toBe(true);
    expect(chain.slice(cut + 1).every((m) => m.excludeFromModel !== true)).toBe(true);
    expect(record.chain?.status).toBe(ChainStatus.COMPLETED);

    // Parent-visible: the domain record (what wait_for_subagent surfaces)
    // carries the partial report with a completed status.
    const domain = runtimeToDomain(record);
    expect(domain.status).toBe('completed');
    expect(domain.result).toBe(result);
  });

  it('re-compacts at the next boundary (reclaim → summarizer) before degrading when still over', async () => {
    // R17 narrative: over the window → boundary 1 applies a reclaim-only
    // compaction (duplicate tool outputs flagged, no summary head) → still
    // growing → boundary 2 applies a summarizer compaction → post-compaction
    // model view still over the window with nothing left to compact →
    // partial report, run COMPLETED.
    mocks.config = compactionConfig({ preserve_percent: 0.15, mechanical_reclaim: true });
    mocks.summarize.mockResolvedValue({ text: `Summary: ${'s'.repeat(6000)}`, usage: null });
    // The script observes the manager itself (prepareEvaluated), so construct
    // it inline instead of via managerWith.
    const manager = new SubagentManager();
    manager.setRunner(scriptedRunner([
      ...duplicateSteps(10),
      usageEvent(550),
      // The reclaim-only prepare flags duplicates without calling the
      // summarizer — wait for its evaluation to settle instead of a bounded
      // settle. The pending registers before the evaluation settles, so the
      // pause is already armed when the gate item below runs.
      prepareEvaluated(manager, 1),
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true }, // reclaim-only apply at the pause boundary
      usageEvent(560), // accrual past the post-compaction baseline re-arms the trigger
      summarizerStarted,
      { type: 'step_finish', stepIndex: 1, finishReason: 'stop' },
      { pauseGate: true }, // summarizer apply → degrade at the pause boundary
      { type: 'finish', finishReason: 'stop' }, // unreachable: the run ends at the boundary
    ]));
    // Install the spy BEFORE spawning so every markCompaction call is captured.
    const markCompaction = vi.spyOn(persistenceOf(manager), 'markCompaction');
    const record = spawnCompactionSubagent(manager, 'session-two-applies');
    await manager.getRunPromise(record.id);

    // Both boundaries applied: reclaim-only first (no summarizer call), then
    // the summarizer compaction.
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    expect(markCompaction).toHaveBeenCalledTimes(2);
    expect(persistenceOf(manager).getLastCompactionRevision(record.id)).not.toBeNull();

    // The 560 bump only re-arms because the hysteresis baseline is the
    // post-compaction model view (≈364 tokens after the reclaim apply): the
    // accrual 560 − 364 = 196 clears min_compactable_tokens (20). Against the
    // pre-compaction peak (550) the accrual would be 10 < 20 and the second
    // compaction could never fire.
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();

    const result = record.result ?? '';
    expect(result).toContain('[Subagent partial report — context window limit reached after compaction]');
    expect(result).toContain('10 tool results');
    expect(result).toContain('Stopped at: step 1');
    expect(result).toContain(TASK);

    // Final chain: reclaim-flagged originals + exactly one summary head.
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const cut = chain.findIndex((m) => m.compacted);
    expect(chain.slice(0, cut).filter((m) => m.excludeFromModel === true).length).toBeGreaterThan(0);
    expect(record.chain?.status).toBe(ChainStatus.COMPLETED);
    const domain = runtimeToDomain(record);
    expect(domain.status).toBe('completed');
    expect(domain.result).toBe(result);
  });
});

// ── OVERFLOW RETRY (U6: R30 / R29 fire point 3) ──────────────────────────────

describe('SubagentManager compaction: overflow retry (U6)', () => {
  it('compacts synchronously on a mid-run overflow and the run completes on the retry', async () => {
    // No usage events anywhere: the only way the gate can calibrate is the
    // measured lower bound the overflow itself records (input >= window) —
    // this test pins that calibration, not just the plumbing.
    const summaryText = `Summary: ${'s'.repeat(300)}`;
    mocks.summarize.mockResolvedValue({ text: summaryText, usage: null });
    const phases: string[] = [];
    const manager = new SubagentManager();
    manager.setOnDelta((event: SubagentDeltaEvent) => {
      if (event.type === SubagentDeltaEventType.COMPACTION_PROGRESS) {
        phases.push((event as SubagentCompactionProgressEvent).phase);
      }
    });
    manager.setRunner(scriptedRunner([
      ...steps(10),
      { overflowGate: false }, // provider overflow → synchronous compact → retry
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { type: 'content', text: 'Recovered after compaction.' },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    const call = summarizeCalls()[0]!;
    expect(call['scope']).toBe('subagents');
    expect(call['subagentId']).toBe(record.id);

    // Compacted transcript shape: one summary head, originals preserved, the
    // task head and the post-retry progress never flagged (R31/R32).
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const cut = chain.findIndex((m) => m.compacted);
    const userMessages = chain.filter((m) => m.role === 'user');
    expect(userMessages.length).toBeGreaterThan(0);
    expect(userMessages.every((m) => m.excludeFromModel !== true)).toBe(true);
    expect(chain.slice(cut + 1).every((m) => m.excludeFromModel !== true)).toBe(true);

    // The run completed with the retried stream's result — no error surfaced,
    // no partial report, and the compaction checkpoint persisted (R36).
    expect(record.result).toContain('Recovered after compaction.');
    expect(record.result).not.toContain('[Subagent partial report');
    expect(persistenceOf(manager).getLastCompactionRevision(record.id)).not.toBeNull();
    // Widget lifecycle via the existing onProgress path.
    expect(phases).toContain('preparing');
    expect(phases).toContain('compacting');
    expect(phases.at(-1)).toBe('complete');
  });

  it('degrades to the partial report when the retried stream still overflows (exactly one compaction)', async () => {
    const summaryText = `Summary: ${'s'.repeat(300)}`;
    mocks.summarize.mockResolvedValue({ text: summaryText, usage: null });
    const manager = managerWith([
      ...steps(5),
      { overflowGate: false }, // first overflow → compact → retry ('applied')
      { type: 'step_finish', stepIndex: 2, finishReason: 'stop' },
      { type: 'content', text: 'still over the window' },
      { overflowGate: true }, // retried stream overflowed again → degraded
      { type: 'finish', finishReason: 'stop' }, // unreachable: the run ends
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    // The retry budget is one per run: exactly one compaction ran.
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    // Degradation completes the run normally with the structured partial
    // report (R17) — done/remaining/stoppedAt, not a failure.
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();
    const result = record.result ?? '';
    expect(result).toContain('[Subagent partial report');
    expect(result).toContain('Done:');
    expect(result).toContain('5 tool results');
    expect(result).toContain('Remaining:');
    expect(result).toContain(TASK);
    expect(result).toContain('Stopped at: step 2');
    // The first compaction's flags + summary head are still persisted under
    // the degraded result.
    expect((record.chain?.messages ?? []).filter((m) => m.compacted)).toHaveLength(1);
    expect(record.chain?.status).toBe(ChainStatus.COMPLETED);
    const domain = runtimeToDomain(record);
    expect(domain.status).toBe('completed');
    expect(domain.result).toBe(result);
  });

  it('degrades without a retry when the gate finds nothing left to compact (empty cut)', async () => {
    // A floor no real range can clear makes the gate no-op: nothing is
    // compactable, so the partial report is the terminal fallback and no
    // compaction-retry loop can start.
    mocks.config = compactionConfig({ min_compactable_tokens: 1_000_000 });
    const manager = managerWith([
      ...steps(3),
      { overflowGate: false }, // gate no-op → degraded immediately
      { type: 'finish', finishReason: 'stop' }, // unreachable
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
    expect((record.chain?.messages ?? []).some((m) => m.excludeFromModel)).toBe(false);
    const result = record.result ?? '';
    expect(result).toContain('[Subagent partial report');
    expect(result).toContain('3 tool results');
    expect(result).toContain(TASK);
  });

  it('aborts cleanly when interrupted during the overflow compaction (no partial report, no stuck state)', async () => {
    // The summarizer never resolves: the compaction stays in flight until the
    // run's abort signal races it out.
    mocks.summarize.mockImplementation(() => new Promise(() => undefined));
    const manager = managerWith([
      ...steps(5),
      { overflowGate: false }, // parks inside the compaction
    ]);
    const record = spawnCompactionSubagent(manager);
    await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledTimes(1));
    manager.cancelOne(record.id);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.INTERRUPTED);
    // Clean abort: no partial report was set and no compaction applied.
    expect(record.result).not.toContain('[Subagent partial report');
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
    // No stuck state: the scoped pending and pause gate are both clear.
    expect(getCompactionPending('session-compaction', record.id)).toBeUndefined();
    expect(shouldPauseForCompaction('session-compaction', record.id)).toBe(false);
  });

  it('propagates the overflow error unchanged when the model has no context limits', async () => {
    mocks.resolveExecution.mockResolvedValue({ model: {} });
    const overflowDetail =
      "This model's maximum context length is 4096 tokens. However, your messages resulted in 5000 tokens.";
    const manager = managerWith([
      ...steps(3),
      { overflowGate: false }, // compaction unavailable → error propagates
      { type: 'error', title: 'Provider Error', detail: overflowDetail },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    // Pre-U6 behavior: no context window → no compaction → the run fails with
    // the provider's overflow error.
    expect(record.state).toBe(SubagentState.FAILED);
    expect(record.error).toContain('maximum context length');
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
  });
});

// ── SPAWN/RESUME GATE (R29 fire point 1) ─────────────────────────────────────

describe('SubagentManager compaction: spawn/resume estimate gate', () => {
  it('starts a prepare before the first usage event on a resumed run with hydrated calibration', async () => {
    // Run 1 accumulates chain messages and an over-threshold usage event, but
    // crosses no step boundary — the pending prepare never applies and the run
    // completes. The trailing text commit stamps the observed usage onto the
    // chain, which is what the resume hydrates calibration from.
    const manager = new SubagentManager();
    manager.setRunner(scriptedRunner([
      ...steps(6),
      usageEvent(600),
      summarizerStarted,
      { type: 'content', text: 'Wrapping up the exploration.' },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    // Run 1's usage-event prepare (the mid-run fire point).
    expect(mocks.summarize).toHaveBeenCalledTimes(1);

    // Run 2 (resume): the chain's stamped usage hydrates the fresh per-run
    // trigger, so the spawn-time gate can calibrate and fire. The script emits
    // NO usage events — the summarizer call can only come from the spawn gate.
    mocks.summarize.mockClear();
    manager.setRunner(scriptedRunner([
      summarizerStarted,
      { type: 'finish', finishReason: 'stop' },
    ]));
    manager.followUp(record.id, 'Continue from where you stopped.');
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    const call = summarizeCalls()[0]!;
    expect(call['scope']).toBe('subagents');
    expect(call['subagentId']).toBe(record.id);
  });

  it('no-ops the spawn-time gate without calibration (calibrate-or-skip hard rule)', async () => {
    // Run 1 grows the chain without ever emitting a usage event, so the record
    // carries no observed input tokens into the resume.
    const manager = new SubagentManager();
    manager.setRunner(scriptedRunner([
      ...steps(6),
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.usage).toBeNull();

    // The resumed chain is far past what a heuristic ratio would flag, but no
    // calibrated tokens-per-char exists — the gate must no-op rather than
    // estimate. The sleep lets the fire-and-forget gate settle before the run
    // completes and the assertion reads it.
    manager.setRunner(scriptedRunner([
      ...steps(2),
      { sleepMs: 80 },
      { type: 'finish', finishReason: 'stop' },
    ]));
    manager.followUp(record.id, 'Continue.');
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).not.toHaveBeenCalled();
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
  });
});

// ── Disabled compaction and compactor failure ────────────────────────────────
describe('SubagentManager mid-run compaction (U9): disabled / failing compactor', () => {
  it('skips compaction without crashing when the model has no context limits (null path)', async () => {
    mocks.resolveExecution.mockResolvedValue({ model: {} });
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      // No wait needed: the null-limits usage handler returns early after
      // ensureCompactionInit resolves false (maybeStartCompactionPrepare is
      // never invoked), and the loop is sequential — the boundary below
      // deterministically sees no pending prepare.
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).not.toHaveBeenCalled();
    const chain = record.chain?.messages ?? [];
    expect(chain.some((m) => m.compacted)).toBe(false);
    expect(chain.some((m) => m.excludeFromModel)).toBe(false);
  });

  it('continues the run un-compacted when the compactor fails mid-run', async () => {
    // The summarizer (LLM caller) rejects. applySubagentPendingCompaction
    // contains the failure and resolves null, so the pause-boundary apply
    // returns 'skipped', the stream restarts with the accumulated history,
    // and the run finishes normally un-compacted.
    mocks.summarize.mockRejectedValue(new Error('compactor provider down'));
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      // The rejected call still counts — mock.calls grows on invocation.
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { pauseGate: true }, // consumes the rejected pending as a skip + restart
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(record.error).toBeNull();
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    const chain = record.chain?.messages ?? [];
    expect(chain.some((m) => m.compacted)).toBe(false);
    expect(chain.some((m) => m.excludeFromModel)).toBe(false);
    expect(record.result).toContain('Step 0');
  });
});

// ── resolveSubagentContextTokens (R16) ───────────────────────────────────────

describe('resolveSubagentContextTokens', () => {
  it('returns the catalog context window for a resolved selection', async () => {
    mocks.resolveExecution.mockResolvedValue({
      model: { limits: { contextTokens: 128_000 } },
    });
    await expect(resolveSubagentContextTokens(SELECTION)).resolves.toBe(128_000);
    expect(mocks.resolveExecution).toHaveBeenCalledWith(SELECTION);
  });

  it('returns null for a missing selection', async () => {
    await expect(resolveSubagentContextTokens(null)).resolves.toBeNull();
    expect(mocks.resolveExecution).not.toHaveBeenCalled();
  });

  it('returns null when the catalog model carries no context limits', async () => {
    mocks.resolveExecution.mockResolvedValue({ model: {} });
    await expect(resolveSubagentContextTokens(SELECTION)).resolves.toBeNull();
  });

  it('returns null (non-fatally) when provider resolution rejects', async () => {
    mocks.resolveExecution.mockRejectedValue(new Error('no provider'));
    await expect(resolveSubagentContextTokens(SELECTION)).resolves.toBeNull();
  });
});

// ── buildSubagentPartialReport (R17) ─────────────────────────────────────────

describe('buildSubagentPartialReport', () => {
  it('renders done/remaining/stopped-at sections in the canonical partial-report shape', () => {
    const report = buildSubagentPartialReport({
      done: '3 tool results recorded',
      remaining: 'validate outputs',
      stoppedAt: 'step 7',
    });
    expect(report).toBe([
      '[Subagent partial report — context window limit reached after compaction]',
      '',
      'Done:',
      '3 tool results recorded',
      '',
      'Remaining:',
      'validate outputs',
      '',
      'Stopped at: step 7',
      '',
      'Note: The subagent stopped early because the context window was still exceeded after compaction. This is a partial result returned as a normal tool result to the parent.',
    ].join('\n'));
  });

  it('falls back to placeholders for empty sections', () => {
    const report = buildSubagentPartialReport({ done: '  ', remaining: '', stoppedAt: '' });
    expect(report).toContain('Done:\n(no completed steps reported)');
    expect(report).toContain('Remaining:\n(unknown remaining work)');
    expect(report).toContain('Stopped at: unknown step');
  });
});

// ── Widget lifecycle (B): terminal epoch guards the trailing stream tail ────

describe('SubagentManager compaction widget lifecycle (B): interrupt mid-prepare', () => {
  it('emits no non-terminal compaction_progress after the terminal projection event', async () => {
    // The compactor streams partial summary text (arming the throttled
    // trailing flush) and parks; the user interrupts mid-prepare. The terminal
    // projection event settles the widget — a trailing 'compacting' flush
    // firing after it must be suppressed (the controller's terminal epoch +
    // discard() timer cleanup).
    let releaseCompactor!: (value: { text: string; usage: null }) => void;
    mocks.summarize.mockImplementation(async (params: { onTextDelta?: (text: string) => void }) => {
      params.onTextDelta?.('partial summary text');
      // Second delta within the throttle interval schedules the trailing timer.
      params.onTextDelta?.('partial summary text with more content');
      return new Promise((resolve) => { releaseCompactor = resolve; });
    });
    const manager = new SubagentManager();
    const events: SubagentDeltaEvent[] = [];
    manager.setOnDelta((event) => { events.push(event); });
    manager.setRunner(scriptedRunner([
      ...steps(5),
      usageEvent(600),
      // Keep the run alive long enough for the interrupt to land mid-prepare.
      { sleepMs: 60 },
      { type: 'finish', finishReason: 'stop' },
    ]));
    const record = spawnCompactionSubagent(manager, 'session-epoch');
    await vi.waitFor(() => expect(mocks.summarize).toHaveBeenCalledTimes(1));
    manager.cancelOne(record.id);
    await manager.getRunPromise(record.id);

    // Wait past the throttle interval so a leaked trailing timer would have
    // fired by now.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const terminalIndex = events.map((e) => e.type).lastIndexOf(SubagentDeltaEventType.TERMINAL);
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    // The immediate first delta landed before the terminal event (the widget
    // did stream while compacting)...
    const compactingBeforeTerminal = events
      .slice(0, terminalIndex)
      .filter((e) => e.type === SubagentDeltaEventType.COMPACTION_PROGRESS)
      .some((e) => (e as SubagentCompactionProgressEvent).phase === 'compacting');
    expect(compactingBeforeTerminal).toBe(true);
    // ...and NOTHING non-terminal follows the terminal projection event.
    const after = events.slice(terminalIndex + 1);
    expect(after.filter((e) => e.type === SubagentDeltaEventType.COMPACTION_PROGRESS)).toEqual([]);
    expect(record.state).toBe(SubagentState.INTERRUPTED);
    // Resolve the parked compactor so the test leaves no pending promise
    // behind (the pending was already discarded by the run's teardown, so the
    // late resolution has no further effect).
    releaseCompactor({ text: 'late summary', usage: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ── Prepare in-flight latch (C9): one compactor per concurrent fire points ──

describe('SubagentCompactionController prepare in-flight latch (C9)', () => {
  const LATCH_SESSION = 'session-latch';
  const LATCH_SUB = 'sub-latch-1';

  /** Runtime record with a compactable chain and a calibrated usage stamp. */
  function latchRecord(chain: Chain): RuntimeSubagentRecord {
    const usage: Usage = {
      prompt_tokens: 700,
      completion_tokens: 10,
      total_tokens: 710,
      cached_tokens: 0,
    };
    return {
      id: LATCH_SUB,
      agent: testAgent,
      state: SubagentState.RUNNING,
      label: 'latch probe',
      task: TASK,
      result: null,
      error: null,
      startTime: Date.now(),
      queuedAt: null,
      startedAt: Date.now(),
      endTime: null,
      chain,
      usage,
      selection: SELECTION,
      parentChainIndex: null,
      sessionId: LATCH_SESSION,
      closed: false,
    } as unknown as RuntimeSubagentRecord;
  }

  it('runs exactly one compactor when the spawn-gate and usage-event prepares overlap', async () => {
    const messages = [
      { id: 'task-head', role: 'user', content: TASK, type: 'text' },
      { id: 'a-1', role: 'assistant', content: 'x'.repeat(400), type: 'text' },
      { id: 'a-2', role: 'assistant', content: 'y'.repeat(400), type: 'text' },
    ] as unknown as Message[];
    const chain: Chain = {
      id: 'chain-latch',
      sessionId: LATCH_SESSION,
      messages,
      status: ChainStatus.ACTIVE,
      selection: SELECTION,
      modelLabel: 'test-model',
      agentName: 'explorer',
      agentType: 'subagent',
      agentTier: 'bloom',
      subagentRecord: null,
      startTime: new Date().toISOString(),
      endTime: null,
      errorDetail: null,
      errorTitle: null,
    } as unknown as Chain;
    const record = latchRecord(chain);
    const evaluated = vi.fn();
    const controller = new SubagentCompactionController({
      record,
      runGeneration: 1,
      abortSignal: new AbortController().signal,
      historyBox: { messages: [...messages] },
      assembler: new SubagentRunAssembler(messages),
      emitProgress: () => undefined,
      setChainMessages: () => undefined,
      applySubagentCompaction: () => undefined,
      markCompaction: () => undefined,
      markRecordDirty: () => undefined,
      emptyChain: () => chain,
      onPrepareEvaluated: evaluated,
    });
    // Initialize the controller first (context-window lookup) so both racing
    // fire points see init done — isolating the latch from the init race.
    await (controller as unknown as { _ensureInit: () => Promise<boolean> })._ensureInit();
    // Both fire points funnel into _maybePrepare; drive it directly so the
    // overlap is deterministic: the first call's synchronous prefix passes the
    // pending-check and sets the latch BEFORE its first await, so the second
    // (the usage event racing the spawn gate) must skip instead of
    // double-firing the compactor.
    const maybePrepare = (inputTokens: number): Promise<void> =>
      (controller as unknown as {
        _maybePrepare: (this: SubagentCompactionController, inputTokens: number) => Promise<void>;
      })._maybePrepare.call(controller, inputTokens);
    const spawnGatePrepare = maybePrepare(700);
    const usageEventPrepare = maybePrepare(800);
    await spawnGatePrepare;
    await usageEventPrepare;

    expect(evaluated).toHaveBeenCalledTimes(2);
    // Exactly ONE compactor invocation registered the pending.
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    expect(mocks.summarize.mock.calls[0]![0] as Record<string, unknown>).toMatchObject({
      scope: 'subagents',
      subagentId: LATCH_SUB,
    });
    controller.discard();
    expect(getCompactionPending(LATCH_SESSION, LATCH_SUB)).toBeUndefined();
  });
});

// ── Scoped user settle (R31/R33): keep_last_user_messages as a real knob ────

describe('Subagent compaction scoped user settle (keep_last_user_messages)', () => {
  const SCOPED_SESSION = 'session-scoped-settle';
  const SCOPED_SUB = 'sub-scoped-settle';

  /** Task head + two answer-exchange turns; compactable range [0,5), preserved [5,6). */
  function exchangeMessages(): Message[] {
    return [
      { id: 'u-task', role: 'user', content: TASK, type: 'text' },
      { id: 'a-1', role: 'assistant', content: 'working on the task', type: 'text' },
      { id: 'u-q1', role: 'user', content: 'answer-exchange question 1', type: 'text' },
      { id: 'a-2', role: 'assistant', content: 'answer 1', type: 'text' },
      { id: 'u-q2', role: 'user', content: 'answer-exchange question 2', type: 'text' },
      { id: 'a-3', role: 'assistant', content: 'answer 2', type: 'text' },
    ] as unknown as Message[];
  }
  const EXCHANGE_CUT: CutResult = {
    cutIndex: 5,
    compactableRange: { start: 0, end: 5 },
    preservedCount: 1,
    openGroupStart: null,
    preservedRange: { start: 5, end: 6 },
  };

  function exchangeChain(messages: Message[]): Chain {
    return {
      id: 'chain-scoped',
      sessionId: SCOPED_SESSION,
      messages,
      status: ChainStatus.ACTIVE,
      selection: SELECTION,
      modelLabel: 'test-model',
      agentName: 'explorer',
      agentType: 'subagent',
      agentTier: 'bloom',
      subagentRecord: null,
      startTime: new Date().toISOString(),
      endTime: null,
      errorDetail: null,
      errorTitle: null,
    } as unknown as Chain;
  }

  function simplePending(): CompactionPendingEntry {
    return {
      cut: EXCHANGE_CUT,
      flaggedIds: [],
      expectedIds: ['u-task', 'a-1', 'u-q1', 'a-2', 'u-q2'],
      estimatedInput: 800,
      contextTokens: CONTEXT_TOKENS,
      mode: 'simple',
      promise: Promise.resolve({ text: `Summary: ${'s'.repeat(300)}`, usage: null }),
    };
  }

  function selectivePending(flaggedIds: string[]): CompactionPendingEntry {
    const summaryMessage = {
      id: 'summary-part',
      role: 'assistant',
      content: 'Summarized exchange.',
      type: 'text',
      compacted: { rangeStart: 'u-task', rangeEnd: 'u-q2', mode: 'selective' },
    } as unknown as Message;
    const result: SelectiveCompactionResult = {
      kind: 'selective',
      replayMessages: [],
      flaggedIds,
      summaryMessages: [summaryMessage],
      summaryMessage,
      correctedOps: [],
      attempts: 1,
    };
    return {
      cut: EXCHANGE_CUT,
      flaggedIds: [],
      expectedIds: ['u-task', 'a-1', 'u-q1', 'a-2', 'u-q2'],
      estimatedInput: 800,
      contextTokens: CONTEXT_TOKENS,
      mode: 'selective',
      selectivePromise: Promise.resolve({ kind: 'ran' as const, result }),
    };
  }

  it('keep_last=null (default) pins every user message through the simple apply', async () => {
    const messages = exchangeMessages();
    const exempt = resolveUserExemptIds(messages, { keepLast: null, pinFirst: true });
    const apply = await applySubagentPendingCompaction({
      pending: simplePending(),
      messages,
      chains: [exchangeChain(messages)],
      sessionId: SCOPED_SESSION,
      exemptIds: exempt,
    });
    expect(apply).not.toBeNull();
    expect(apply!.flaggedIds).toEqual(['a-1', 'a-2']);
    for (const id of ['u-task', 'u-q1', 'u-q2']) {
      expect(apply!.updatedMessages.find((m) => m.id === id)!.excludeFromModel).not.toBe(true);
    }
  });

  it('keep_last=1 + pin_first=true protects the task head; older answer exchanges are flagged', async () => {
    const messages = exchangeMessages();
    const exempt = resolveUserExemptIds(messages, { keepLast: 1, pinFirst: true });
    expect(exempt.has('u-task')).toBe(true);
    expect(exempt.has('u-q2')).toBe(true);
    const apply = await applySubagentPendingCompaction({
      pending: simplePending(),
      messages,
      chains: [exchangeChain(messages)],
      sessionId: SCOPED_SESSION,
      exemptIds: exempt,
    });
    expect(apply).not.toBeNull();
    expect([...apply!.flaggedIds].sort()).toEqual(['a-1', 'a-2', 'u-q1']);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-task')!.excludeFromModel).not.toBe(true);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-q1')!.excludeFromModel).toBe(true);
  });

  it('keep_last=1 + pin_first=false can flag the task head and older user messages', async () => {
    const messages = exchangeMessages();
    const exempt = resolveUserExemptIds(messages, { keepLast: 1, pinFirst: false });
    expect(exempt.has('u-q2')).toBe(true);
    expect(exempt.has('u-task')).toBe(false);
    const apply = await applySubagentPendingCompaction({
      pending: simplePending(),
      messages,
      chains: [exchangeChain(messages)],
      sessionId: SCOPED_SESSION,
      exemptIds: exempt,
    });
    expect(apply).not.toBeNull();
    expect([...apply!.flaggedIds].sort()).toEqual(['a-1', 'a-2', 'u-q1', 'u-task']);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-task')!.excludeFromModel).toBe(true);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-q2')!.excludeFromModel).not.toBe(true);
  });

  it('selective mode respects the scoped exempt set (task head protected, old exchange flagged)', async () => {
    const messages = exchangeMessages();
    const exempt = resolveUserExemptIds(messages, { keepLast: 1, pinFirst: true });
    const apply = await applySubagentPendingCompaction({
      pending: selectivePending(['u-task', 'u-q1', 'a-1']),
      messages,
      chains: [exchangeChain(messages)],
      sessionId: SCOPED_SESSION,
      exemptIds: exempt,
    });
    expect(apply).not.toBeNull();
    expect([...apply!.flaggedIds].sort()).toEqual(['a-1', 'u-q1']);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-task')!.excludeFromModel).not.toBe(true);
    expect(apply!.updatedMessages.find((m) => m.id === 'u-q1')!.excludeFromModel).toBe(true);
  });

  it('the controller re-resolves the exempt set from the CURRENT config at apply time', async () => {
    const messages = exchangeMessages();
    const chain = exchangeChain(messages);
    const usage: Usage = {
      prompt_tokens: 700,
      completion_tokens: 10,
      total_tokens: 710,
      cached_tokens: 0,
    };
    const record = {
      id: SCOPED_SUB,
      agent: testAgent,
      state: SubagentState.RUNNING,
      label: 'scoped settle probe',
      task: TASK,
      result: null,
      error: null,
      startTime: Date.now(),
      queuedAt: null,
      startedAt: Date.now(),
      endTime: null,
      chain,
      usage,
      selection: SELECTION,
      parentChainIndex: null,
      sessionId: SCOPED_SESSION,
      closed: false,
    } as unknown as RuntimeSubagentRecord;
    const makeController = () => new SubagentCompactionController({
      record,
      runGeneration: 1,
      abortSignal: new AbortController().signal,
      historyBox: { messages: [...messages] },
      assembler: new SubagentRunAssembler(messages),
      emitProgress: () => undefined,
      setChainMessages: () => undefined,
      applySubagentCompaction: () => undefined,
      markCompaction: () => undefined,
      markRecordDirty: () => undefined,
      emptyChain: () => chain,
      onPrepareEvaluated: () => undefined,
    });
    const raceApply = (controller: SubagentCompactionController): Promise<ApplyResult | null> =>
      (controller as unknown as {
        _raceAbortableApply: (
          this: SubagentCompactionController,
          pending: CompactionPendingEntry,
          liveHistory: readonly Message[],
        ) => Promise<ApplyResult | null>;
      })._raceAbortableApply.call(controller, simplePending(), messages);

    // Default config (keep_last=null): the controller resolves an all-users
    // set — the task head survives even with pin_first disabled.
    mocks.config = compactionConfig({ pin_first_user_message: false });
    const defaultCfgController = makeController();
    await (defaultCfgController as unknown as { _ensureInit: () => Promise<boolean> })._ensureInit();
    const pinned = await raceApply(defaultCfgController);
    expect(pinned!.flaggedIds).toEqual(['a-1', 'a-2']);
    expect(pinned!.updatedMessages.find((m) => m.id === 'u-task')!.excludeFromModel).not.toBe(true);
    defaultCfgController.discard();

    // keep_last=1 + pin_first=false: the apply-time set no longer covers the
    // task head, so it leaves the model view with the summarized prefix.
    mocks.config = compactionConfig({ keep_last_user_messages: 1, pin_first_user_message: false });
    const scopedCfgController = makeController();
    await (scopedCfgController as unknown as { _ensureInit: () => Promise<boolean> })._ensureInit();
    const scoped = await raceApply(scopedCfgController);
    expect(scoped!.flaggedIds).toContain('u-task');
    expect(scoped!.updatedMessages.find((m) => m.id === 'u-task')!.excludeFromModel).toBe(true);
    scopedCfgController.discard();
  });
});
