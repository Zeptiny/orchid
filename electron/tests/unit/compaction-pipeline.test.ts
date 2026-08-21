/**
 * Scope-parameterized compaction gate pipeline (R34) — unit coverage for
 * `llm/compaction/pipeline.ts`.
 *
 * Pins:
 *  - scope parity: identical inputs produce identical gate decisions under the
 *    main and subagents config shapes (one engine, scope adapters);
 *  - calibrate-or-skip: no calibrated tokens-per-char → no-op, never chars/4;
 *  - serialization economy (review #47): one `estimateMessageChars` call per
 *    message per evaluation — the total, range estimate, and preserve-window
 *    walk all read the same single pass;
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { CompactionScopeConfig } from '../../src/shared/types/ipc-boundary';
import type { TriggerState } from '../../src/main/llm/compaction/trigger';

const recorder = vi.hoisted(() => ({ chars: [] as Message[] }));

vi.mock('../../src/main/llm/compaction/message-chars', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/llm/compaction/message-chars')>();
  return {
    ...actual,
    estimateMessageChars: (message: Message): number => {
      recorder.chars.push(message);
      return actual.estimateMessageChars(message);
    },
  };
});

import {
  calibratedCut,
  clampTokensPerChar,
  computeMessageCharCache,
  deriveTokensPerChar,
  preserveBaseTokens,
  runCompactionGate,
  type CompactableRange,
  type MessageCharCache,
} from '../../src/main/llm/compaction/pipeline';
import { resolveUserExemptIds } from '../../src/main/llm/compaction/select';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CONTEXT_TOKENS = 10_000;

function makeMsg(id: string, content: string, role: MessageRole): Message {
  return {
    id,
    role,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

/** Six user/assistant chains with bulky assistant turns — a compactable prefix. */
function bulkyHistory(): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < 6; i += 1) {
    messages.push(makeMsg(`u-${i}`, `request ${i}`, MessageRole.USER));
    messages.push(makeMsg(`a-${i}`, 'y'.repeat(10_000), MessageRole.ASSISTANT));
  }
  return messages;
}

/** Matched knobs across scopes; only the scope-identity fields differ. */
function scopeConfig(agentName: string): CompactionScopeConfig {
  return {
    mode: 'simple',
    threshold: 0.5,
    model: null,
    agent_name: agentName,
    preserve_percent: 0.25,
    min_compactable_tokens: 100,
    mechanical_reclaim: false,
    hysteresis_delta: 0.1,
    keep_last_user_messages: 1,
    pin_first_user_message: false,
  };
}

const UNARMED: TriggerState = { hysteresisArmed: false, pendingPrepare: false };

function gateInput(overrides: Partial<Parameters<typeof runCompactionGate>[0]> = {}) {
  return {
    messages: bulkyHistory(),
    config: scopeConfig('compactor'),
    scope: 'main' as const,
    inputTokens: 8_000,
    contextTokens: CONTEXT_TOKENS,
    tokensPerChar: null,
    triggerState: UNARMED,
    ...overrides,
  };
}

function rangeOf(cache: MessageCharCache, range: CompactableRange): number {
  let sum = 0;
  for (let i = range.start; i < range.end; i += 1) sum += cache.chars[i] ?? 0;
  return sum;
}

beforeEach(() => {
  recorder.chars.length = 0;
});

// ── Gate: scope parity (R34) ─────────────────────────────────────────────────

describe('runCompactionGate — one engine, scope adapters', () => {
  it('returns identical decisions for identical inputs under the main and subagents config shapes', () => {
    const main = runCompactionGate({ ...gateInput(), scope: 'main', config: scopeConfig('compactor') });
    const subagents = runCompactionGate({ ...gateInput(), scope: 'subagents', config: scopeConfig('compactor-subagent') });
    expect(subagents).toEqual(main);
    expect(main.kind).toBe('prepare');
  });

  it('derives calibration from the observed input tokens and clamps it into the shared band', () => {
    const decision = runCompactionGate(gateInput());
    expect(decision.kind).toBe('prepare');
    if (decision.kind === 'no-op') throw new Error('expected an action decision');
    const cache = computeMessageCharCache(bulkyHistory());
    expect(decision.tokensPerChar).toBe(clampTokensPerChar(8_000 / cache.total));
    expect(decision.estimatedInput).toBe(8_000);
  });

  it('prefers an existing calibration over re-deriving one', () => {
    const derived = runCompactionGate(gateInput());
    const supplied = runCompactionGate(gateInput({ tokensPerChar: 0.2 }));
    expect(supplied.kind).toBe('prepare');
    if (supplied.kind === 'no-op' || derived.kind === 'no-op') throw new Error('expected action decisions');
    expect(supplied.tokensPerChar).toBe(0.2);
    expect(supplied.tokensPerChar).not.toBe(derived.tokensPerChar);
  });

  it('no-ops without calibration (calibrate-or-skip hard rule — never chars/4)', () => {
    const decision = runCompactionGate(gateInput({ inputTokens: null }));
    expect(decision).toMatchObject({ kind: 'no-op', reason: 'uncalibrated', tokensPerChar: null });
  });

  it('no-ops below the threshold', () => {
    const decision = runCompactionGate(gateInput({ inputTokens: 1_000 }));
    expect(decision).toMatchObject({ kind: 'no-op', reason: 'below-threshold' });
  });

  it('no-ops without a context window and on an empty compactable range', () => {
    expect(runCompactionGate(gateInput({ contextTokens: 0 }))).toMatchObject({ kind: 'no-op', reason: 'no-context-window' });
    const singleChain = [makeMsg('u-0', 'request 0', MessageRole.USER), makeMsg('a-0', 'y'.repeat(10), MessageRole.ASSISTANT)];
    expect(runCompactionGate(gateInput({ messages: singleChain }))).toMatchObject({ kind: 'no-op', reason: 'empty-compactable-range' });
  });

  it('suppresses re-fire while hysteresis is armed without enough accrual', () => {
    const armed: TriggerState = {
      hysteresisArmed: true,
      pendingPrepare: false,
      postCompactionInputTokens: 7_950,
    };
    expect(runCompactionGate(gateInput({ triggerState: armed }))).toMatchObject({ kind: 'no-op', reason: 'hysteresis-armed' });
    const accrued: TriggerState = { ...armed, postCompactionInputTokens: 5_000 };
    expect(runCompactionGate(gateInput({ triggerState: accrued })).kind).toBe('prepare');
  });

  it('keeps the compactable-range estimate consistent with the cut it returns', () => {
    const decision = runCompactionGate(gateInput());
    if (decision.kind === 'no-op') throw new Error('expected an action decision');
    const cache = computeMessageCharCache(bulkyHistory());
    expect(decision.compactableTokens).toBe(Math.ceil(rangeOf(cache, decision.cut.compactableRange) * decision.tokensPerChar));
    expect(decision.cut.compactableRange.end).toBeGreaterThan(decision.cut.compactableRange.start);
  });
});

// ── Calibration helpers ──────────────────────────────────────────────────────

describe('deriveTokensPerChar / clampTokensPerChar', () => {
  it('rejects unusable observations and clamps pathological ratios', () => {
    expect(deriveTokensPerChar(null, 1_000)).toBeNull();
    expect(deriveTokensPerChar(0, 1_000)).toBeNull();
    expect(deriveTokensPerChar(100, 0)).toBeNull();
    expect(deriveTokensPerChar(100, -5)).toBeNull();
    expect(clampTokensPerChar(0.001)).toBe(0.05);
    expect(clampTokensPerChar(50)).toBe(2);
    expect(clampTokensPerChar(0.25)).toBe(0.25);
  });

  it('floors the char-cache total so tiny histories never divide by zero', () => {
    expect(computeMessageCharCache([])).toEqual({ chars: [], total: 1 });
  });
});

// ── Preserve base (current usage, clamped to the window) ─────────────────────

describe('preserveBaseTokens', () => {
  it('scales the preserve base to current usage and clamps at the window', () => {
    expect(preserveBaseTokens(4_000, 10_000)).toBe(4_000);
    expect(preserveBaseTokens(12_000, 10_000)).toBe(10_000);
  });

  it('falls back to the window when no usable current estimate exists', () => {
    expect(preserveBaseTokens(null, 10_000)).toBe(10_000);
    expect(preserveBaseTokens(0, 10_000)).toBe(10_000);
    expect(preserveBaseTokens(Number.NaN, 10_000)).toBe(10_000);
    expect(preserveBaseTokens(undefined, 10_000)).toBe(10_000);
  });
});

describe('runCompactionGate — preserve budget scales with current usage', () => {
  it('compacts more when current usage is below the window', () => {
    // Same history, fixed calibration; only the observed input differs. Both
    // sit above the 0.5 threshold, so both prepare — but the 6k observation
    // shrinks the preserve budget (0.25 × 6k < 0.25 × 10k), leaving a larger
    // compactable range than the 10k observation.
    const atWindow = runCompactionGate(gateInput({ inputTokens: 10_000, tokensPerChar: 0.2 }));
    const belowWindow = runCompactionGate(gateInput({ inputTokens: 6_000, tokensPerChar: 0.2 }));
    expect(atWindow.kind).toBe('prepare');
    expect(belowWindow.kind).toBe('prepare');
    if (atWindow.kind === 'no-op' || belowWindow.kind === 'no-op') throw new Error('expected action decisions');
    expect(belowWindow.cut.compactableRange.end).toBeGreaterThanOrEqual(atWindow.cut.compactableRange.end);
    expect(belowWindow.compactableTokens).toBeGreaterThan(atWindow.compactableTokens);
  });

  it('keeps the window base when the estimate is over-window (overflow clamp)', () => {
    // Fixed calibration so only the preserve base varies with the observation.
    const atWindow = runCompactionGate(gateInput({ inputTokens: 10_000, tokensPerChar: 0.2 }));
    const overWindow = runCompactionGate(gateInput({ inputTokens: 25_000, tokensPerChar: 0.2 }));
    if (atWindow.kind === 'no-op' || overWindow.kind === 'no-op') throw new Error('expected action decisions');
    expect(overWindow.cut.cutIndex).toBe(atWindow.cut.cutIndex);
    expect(overWindow.cut.compactableRange).toEqual(atWindow.cut.compactableRange);
  });
});

// ── Manual mode (/compact) ───────────────────────────────────────────────────

describe('runCompactionGate — manual mode', () => {
  it('bypasses the threshold gate entirely', () => {
    const below = runCompactionGate(gateInput({ inputTokens: 1_000 }));
    expect(below).toMatchObject({ kind: 'no-op', reason: 'below-threshold' });
    const manual = runCompactionGate(gateInput({ inputTokens: 1_000, manual: true }));
    expect(manual).toMatchObject({ kind: 'prepare', reason: 'manual' });
  });

  it('bypasses armed hysteresis without accrual', () => {
    const armed: TriggerState = {
      hysteresisArmed: true,
      pendingPrepare: false,
      postCompactionInputTokens: 7_950,
    };
    expect(runCompactionGate(gateInput({ triggerState: armed }))).toMatchObject({ kind: 'no-op', reason: 'hysteresis-armed' });
    expect(runCompactionGate(gateInput({ triggerState: armed, manual: true }))).toMatchObject({ kind: 'prepare', reason: 'manual' });
  });

  it('ignores the min_compactable_tokens floor', () => {
    // Small history + low floor-failing range: auto no-ops below-floor, manual prepares.
    const smallHistory = [
      makeMsg('u-0', 'request 0', MessageRole.USER),
      makeMsg('a-0', 'y'.repeat(4_000), MessageRole.ASSISTANT),
      makeMsg('u-1', 'request 1', MessageRole.USER),
      makeMsg('a-1', 'y'.repeat(4_000), MessageRole.ASSISTANT),
    ];
    const config = { ...scopeConfig('compactor'), min_compactable_tokens: 1_000_000 };
    expect(runCompactionGate(gateInput({ messages: smallHistory, config }))).toMatchObject({ kind: 'no-op', reason: 'below-floor' });
    expect(runCompactionGate(gateInput({ messages: smallHistory, config, manual: true }))).toMatchObject({ kind: 'prepare', reason: 'manual' });
  });

  it('never takes the reclaim short-circuit — reclaim flags merge into a prepare', () => {
    const toolCall = (id: string, callId: string): Message => ({
      ...makeMsg(id, 'do it', MessageRole.ASSISTANT),
      type: MessageType.TOOL_CALL,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'read', arguments: '{"file_path":"a"}' } }],
    });
    const toolResult = (id: string, callId: string): Message => ({
      ...makeMsg(id, 'duplicate output', MessageRole.TOOL),
      type: MessageType.TOOL_RESULT,
      tool_call_id: callId,
      name: 'read',
    });
    const messages = [
      makeMsg('u-0', 'request 0', MessageRole.USER),
      toolCall('a-0', 'tc-1'),
      toolResult('t-1', 'tc-1'),
      makeMsg('a-1', 'y'.repeat(8_000), MessageRole.ASSISTANT),
      toolCall('a-2', 'tc-2'),
      toolResult('t-2', 'tc-2'),
      makeMsg('u-1', 'request 1', MessageRole.USER),
      makeMsg('a-3', 'y'.repeat(8_000), MessageRole.ASSISTANT),
    ];
    const config = { ...scopeConfig('compactor'), mechanical_reclaim: true };
    const auto = runCompactionGate(gateInput({ messages, config }));
    expect(auto.kind).toBe('prepare');
    if (auto.kind !== 'prepare') throw new Error('expected prepare');
    const manual = runCompactionGate(gateInput({ messages, config, manual: true }));
    expect(manual).toMatchObject({ kind: 'prepare', reason: 'manual' });
    if (manual.kind !== 'prepare') throw new Error('expected prepare');
    // Both carry the reclaim flags; manual just never downgrades to reclaim-only.
    expect(manual.flaggedIds).toContain('t-1');
    expect(manual.flaggedIds).toEqual(auto.flaggedIds);
  });

  it('still respects the uncalibrated gate and the empty-range guard', () => {
    expect(runCompactionGate(gateInput({ inputTokens: null, manual: true }))).toMatchObject({ kind: 'no-op', reason: 'uncalibrated' });
    const singleChain = [makeMsg('u-0', 'request 0', MessageRole.USER), makeMsg('a-0', 'y'.repeat(10), MessageRole.ASSISTANT)];
    expect(runCompactionGate(gateInput({ messages: singleChain, manual: true }))).toMatchObject({ kind: 'no-op', reason: 'empty-compactable-range' });
  });

  it('still respects exempt user-message pinning', () => {
    const config = { ...scopeConfig('compactor'), keep_last_user_messages: 1 };
    const decision = runCompactionGate(gateInput({ config, manual: true }));
    expect(decision.kind).toBe('prepare');
    if (decision.kind === 'no-op') throw new Error('expected an action decision');
    const rangeIds = bulkyHistory().slice(decision.cut.compactableRange.start, decision.cut.compactableRange.end).map((m) => m.id);
    expect(rangeIds).not.toContain('u-5');
  });
});

// ── Serialization economy (review #47) ───────────────────────────────────────

describe('runCompactionGate — single-pass char estimation', () => {
  it('measures each message exactly once per evaluation', () => {
    const messages = bulkyHistory();
    const decision = runCompactionGate(gateInput({ messages }));
    expect(decision.kind).toBe('prepare');
    expect(recorder.chars).toHaveLength(messages.length);
    expect(recorder.chars.map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  it('reuses a caller-supplied char cache instead of re-measuring', () => {
    const messages = bulkyHistory();
    const cache = computeMessageCharCache(messages);
    recorder.chars.length = 0;
    const decision = runCompactionGate(gateInput({ messages, charCache: cache }));
    expect(decision.kind).toBe('prepare');
    expect(recorder.chars).toHaveLength(0);
  });
});

// ── calibratedCut ────────────────────────────────────────────────────────────

describe('calibratedCut', () => {
  it('threads exempt user ids so pinned messages never enter the compactable range', () => {
    const messages = bulkyHistory();
    const config = { ...scopeConfig('compactor-subagent'), keep_last_user_messages: null, pin_first_user_message: true };
    const cut = calibratedCut(messages, { config, contextTokens: CONTEXT_TOKENS, tokensPerChar: 0.2 });
    const exempt = resolveUserExemptIds(messages, { keepLast: null, pinFirst: true });
    const rangeIds = messages.slice(cut.compactableRange.start, cut.compactableRange.end).map((m) => m.id);
    expect(exempt.size).toBe(6);
    expect(rangeIds).not.toContain('u-0');
  });
});
