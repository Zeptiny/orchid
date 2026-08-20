/**
 * Scope-parameterized compaction gate pipeline (R34) and compactor concurrency
 * cap — unit coverage for `llm/compaction/pipeline.ts`.
 *
 * Pins:
 *  - scope parity: identical inputs produce identical gate decisions under the
 *    main and subagents config shapes (one engine, scope adapters);
 *  - calibrate-or-skip: no calibrated tokens-per-char → no-op, never chars/4;
 *  - serialization economy (review #47): one `estimateMessageChars` call per
 *    message per evaluation — the total, range estimate, and preserve-window
 *    walk all read the same single pass;
 *  - the semaphore caps concurrent compactor prepares (default 2), queues the
 *    rest FIFO, and never queues the gate itself.
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
  DEFAULT_MAX_CONCURRENT_COMPACTORS,
  acquireCompactionSlot,
  calibratedCut,
  clampTokensPerChar,
  computeMessageCharCache,
  deriveTokensPerChar,
  runCompactionGate,
  type CompactionGateDecision,
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

// ── Compactor concurrency cap ────────────────────────────────────────────────

/** Fresh module registry per test so the shared semaphore starts unheld. */
async function freshSlots() {
  vi.resetModules();
  return import('../../src/main/llm/compaction/pipeline');
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('acquireCompactionSlot — compactor concurrency cap', () => {
  it('admits at most two concurrent prepares by default and queues the third', async () => {
    const { acquireCompactionSlot: acquire, DEFAULT_MAX_CONCURRENT_COMPACTORS } = await freshSlots();
    expect(DEFAULT_MAX_CONCURRENT_COMPACTORS).toBe(2);
    const release1 = await acquire();
    const release2 = await acquire();
    let thirdAcquired = false;
    const third = acquire().then(() => { thirdAcquired = true; });
    await tick();
    expect(thirdAcquired).toBe(false);
    release1();
    await third;
    expect(thirdAcquired).toBe(true);
    release2();
  });

  it('hands released slots to waiters in FIFO order', async () => {
    const { acquireCompactionSlot: acquire } = await freshSlots();
    const release1 = await acquire();
    const release2 = await acquire();
    const order: number[] = [];
    const third = acquire().then(() => order.push(3));
    const fourth = acquire().then(() => order.push(4));
    await tick();
    expect(order).toEqual([]);
    release1();
    await third;
    expect(order).toEqual([3]);
    release2();
    await fourth;
    expect(order).toEqual([3, 4]);
  });

  it('honors a configured limit below the default', async () => {
    const { acquireCompactionSlot: acquire } = await freshSlots();
    const release1 = await acquire(1);
    let secondAcquired = false;
    const second = acquire().then(() => { secondAcquired = true; });
    await tick();
    expect(secondAcquired).toBe(false);
    release1();
    await second;
    expect(secondAcquired).toBe(true);
  });

  it('treats release as idempotent so a released slot is never double-counted', async () => {
    const { acquireCompactionSlot: acquire } = await freshSlots();
    const release1 = await acquire();
    const release2 = await acquire();
    // A double release must count once: without the guard both slots would be
    // free and a FOURTH prepare could run concurrently with two others.
    release1();
    release1();
    let thirdAcquired = false;
    let fourthAcquired = false;
    const third = acquire().then(() => { thirdAcquired = true; });
    const fourth = acquire().then(() => { fourthAcquired = true; });
    await tick();
    expect(thirdAcquired).toBe(true);
    expect(fourthAcquired).toBe(false);
    release2();
    await fourth;
    expect(fourthAcquired).toBe(true);
  });

  it('keeps excess waiters queued when the limit is lowered below the active count', async () => {
    const { acquireCompactionSlot: acquire } = await freshSlots();
    const release1 = await acquire();
    const release2 = await acquire();
    // Lower the limit to 1 while both permits are held; the lowering acquire
    // itself queues as a waiter.
    let loweredAcquired = false;
    const lowered = acquire(1).then(() => { loweredAcquired = true; });
    let secondAcquired = false;
    const second = acquire().then(() => { secondAcquired = true; });
    await tick();
    expect(loweredAcquired).toBe(false);
    expect(secondAcquired).toBe(false);
    // First release: active 2→1, but the limit is 1 — NO waiter may proceed.
    release1();
    await tick();
    expect(loweredAcquired).toBe(false);
    expect(secondAcquired).toBe(false);
    // Second release frees the only permit: exactly ONE waiter proceeds and
    // the other stays queued.
    release2();
    await lowered;
    expect(loweredAcquired).toBe(true);
    await tick();
    expect(secondAcquired).toBe(false);
  });

  it('never queues the gate — decisions stay synchronous while every slot is held', async () => {
    const { acquireCompactionSlot: acquire, runCompactionGate: gate } = await freshSlots();
    const release1 = await acquire();
    const release2 = await acquire();
    const decision: CompactionGateDecision = gate(gateInput());
    expect(decision.kind).toBe('prepare');
    release1();
    release2();
  });
});
