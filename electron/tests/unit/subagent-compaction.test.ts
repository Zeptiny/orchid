/**
 * Subagent mid-run compaction orchestration (U9) — manager-level coverage.
 *
 * Covers the run-loop plumbing in SubagentManager._startRun:
 *  - ARM:      usage event over threshold → prepare starts (compactor caller
 *              invoked with the compactable range), pending armed.
 *  - APPLY:    step_finish boundary applies the pending compaction through
 *              _setChainMessages (originals preserved: excludeFromModel flags +
 *              one summary head at the cut), markCompaction revision bumped,
 *              trigger re-armed with a post-compaction baseline.
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
 * subagent-runner's static graph).
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
} from '../../src/main/agents/manager';
import {
  buildSubagentPartialReport,
  resolveSubagentContextTokens,
} from '../../src/main/agents/subagent-runner';

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
  | { readonly until: () => boolean; readonly label?: string };

/**
 * Bounded settle for fire-and-forget prepares that produce NO observable
 * (e.g. a below-threshold decision that never calls the summarizer). Every
 * wait with a real observable uses `until` instead.
 */
const SETTLE: ScriptItem = { sleepMs: 40 };

/** Wait until the summarizer prepare has actually started (implies the run's pending promise is registered). */
const summarizerStarted: ScriptItem = {
  until: () => mocks.summarize.mock.calls.length >= 1,
  label: 'summarizer prepare to start',
};

function scriptedRunner(script: readonly ScriptItem[]) {
  return async function* (): AsyncGenerator<StreamEvent> {
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
  return (manager as unknown as { _persistence: SubagentPersistence })._persistence;
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
    // PREFIX of the live chain (the preserve window stays verbatim at the tail).
    const slice = call['messages'] as Message[];
    const chainIds = (record.chain?.messages ?? []).map((m) => m.id);
    const sliceIds = slice.map((m) => m.id);
    expect(sliceIds.length).toBeGreaterThan(0);
    expect(sliceIds.length).toBeLessThan(chainIds.length);
    expect(chainIds.slice(0, sliceIds.length)).toEqual(sliceIds);
    expect(sliceIds).not.toContain(chainIds.at(-1));

    // No boundary was crossed in this run: the pending prepare never applied.
    expect((record.chain?.messages ?? []).some((m) => m.compacted)).toBe(false);
    expect((record.chain?.messages ?? []).some((m) => m.excludeFromModel)).toBe(false);
  });

  it('does not arm below the threshold', async () => {
    const manager = managerWith([
      ...steps(10),
      usageEvent(300),
      // No observable exists for a below-threshold decision (the summarizer is
      // never called) — bounded settle only.
      SETTLE,
      { type: 'finish', finishReason: 'stop' },
    ]);
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
      // The boundary handler awaits the pending prepare before the loop pulls
      // the next event, so no settle is needed after step_finish.
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    expect(record.state).toBe(SubagentState.COMPLETED);

    // Compacted transcript shape: every original survives, exactly one summary
    // head is inserted at the cut, and the covered prefix leaves the model view.
    // (Simple mode — the default — flags the whole compactable range including
    // the seeding user turn; the R9 never-flag-user protection is the selective
    // path's, see subagent-compaction-selective.test.ts.)
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
    expect(chain.slice(0, cut).every((m) => m.excludeFromModel === true)).toBe(true);
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
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' }, // apply #1
      usageEvent(450),
      // The re-opened prepare resolves to a no-op and never calls the
      // summarizer — no observable, bounded settle only.
      SETTLE,
      { probe: () => { callsAfterReArm = mocks.summarize.mock.calls.length; } },
      { type: 'step_finish', stepIndex: 1, finishReason: 'stop' }, // consumes the no-op pending
      { type: 'finish', finishReason: 'stop' },
    ]);
    const record = spawnCompactionSubagent(manager);
    await manager.getRunPromise(record.id);

    // Post-compaction baseline (current behavior — sibling fix): the estimate
    // in maybeApplyCompactionAtBoundary EXCLUDES excludeFromModel originals, so
    // the accrual baseline is the post-compaction model view (summary head +
    // preserved tail ≈ 300 tokens here), NOT the pre-compaction input (600).
    // A 450 usage event (above the 400 re-arm line, 150 tokens of accrual past
    // the baseline) therefore re-opens the prepare gate. Under the older
    // overestimating shape (baseline ≈ 600) it would have stayed closed.
    //
    // The re-opened prepare cannot summarize again, though: selectCut infers
    // chain boundaries from USER messages, and a subagent run has exactly one
    // user turn — once the chain contains a compacted marker the whole chain
    // counts as summarized (realChains = []) and the compactable range comes
    // back empty. The pending resolves null and the boundary consumes it as a
    // no-op — the run is never wedged and never double-compacts.
    expect(callsAfterReArm).toBe(1);
    expect(record.state).toBe(SubagentState.COMPLETED);
    expect(mocks.summarize).toHaveBeenCalledTimes(1);
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    expect(record.result).not.toContain('[Subagent partial report');
  });
});

// ── DEGRADE (R17): still over the window after compaction ────────────────────

describe('SubagentManager mid-run compaction (U9): degrade to partial report', () => {
  it('completes (does not fail) with a partial report when the post-compaction model view still exceeds the window', async () => {
    // A large summary head keeps the post-compaction model view over the
    // threshold, and the compacted chain (single user turn + summary marker)
    // has no further compactable range → R17 degradation at the boundary.
    mocks.summarize.mockResolvedValue({ text: `Summary: ${'s'.repeat(1500)}`, usage: null });
    const manager = managerWith([
      ...steps(5),
      usageEvent(900),
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
      { type: 'finish', finishReason: 'stop' }, // unreachable: the run breaks at the boundary
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
    const chain = record.chain?.messages ?? [];
    expect(chain.filter((m) => m.compacted)).toHaveLength(1);
    const cut = chain.findIndex((m) => m.compacted);
    expect(chain.slice(0, cut).every((m) => m.excludeFromModel === true)).toBe(true);
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
    const manager = managerWith([
      ...duplicateSteps(10),
      usageEvent(550),
      // The reclaim-only prepare flags duplicates without calling the
      // summarizer — no observable, bounded settle only.
      SETTLE,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' }, // reclaim-only apply
      usageEvent(560), // accrual past the post-compaction baseline re-arms the trigger
      summarizerStarted,
      { type: 'step_finish', stepIndex: 1, finishReason: 'stop' }, // summarizer apply → degrade
      { type: 'finish', finishReason: 'stop' }, // unreachable: the run breaks at the boundary
    ]);
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

// ── Disabled compaction and compactor failure ────────────────────────────────

describe('SubagentManager mid-run compaction (U9): disabled / failing compactor', () => {
  it('skips compaction without crashing when the model has no context limits (null path)', async () => {
    mocks.resolveExecution.mockResolvedValue({ model: {} });
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      // Null-limits path never starts a prepare — no observable, bounded settle only.
      SETTLE,
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
    // The summarizer (LLM caller) rejects. tryCompactSubagentHistory contains
    // the failure and resolves null, so the boundary consumes the pending as a
    // no-op and the run finishes normally. (The manager's own rejected-pending
    // catch is additionally defensive — tryCompactSubagentHistory never rejects
    // through public seams, so the compactor failure is the reachable path.)
    mocks.summarize.mockRejectedValue(new Error('compactor provider down'));
    const manager = managerWith([
      ...steps(10),
      usageEvent(600),
      // The rejected call still counts — mock.calls grows on invocation.
      summarizerStarted,
      { type: 'step_finish', stepIndex: 0, finishReason: 'stop' },
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
