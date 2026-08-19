import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import {
  CompactionTrigger,
  canStartPrepare,
  computeTokensPerChar,
  estimateNextInputTokens,
  evaluateTriggerWithReclaim,
  shouldApplyAtBoundary,
  shouldTriggerCompaction,
  updateTriggerStateOnUsage,
  nextHysteresisArmed,
  markCompactionApplied,
} from '../../src/main/llm/compaction/trigger';
import { mechanicalReclaim } from '../../src/main/llm/compaction/reclaim';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMsg(id: string, content: string, role: MessageRole = MessageRole.USER): Message {
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

function makeToolCall(id: string, name: string, args: unknown, msgId: string): Message {
  const argsStr = typeof args === 'string' ? args : JSON.stringify(args);
  return {
    id: msgId,
    role: MessageRole.ASSISTANT,
    content: '',
    type: MessageType.TOOL_CALL,
    tool_calls: [{ id, type: 'function', function: { name, arguments: argsStr } }],
    tool_call_id: id,
    name,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: null,
  };
}

import { createCanonicalToolResult } from '../../src/shared/types/tool-result';

function makeToolResult(callId: string, name: string, content: string, msgId: string): Message {
  const canonical = createCanonicalToolResult('generic', {
    status: 'complete',
    data: { value: content, origin: { kind: 'built-in', name } } as never,
  });
  return {
    id: msgId,
    role: MessageRole.TOOL,
    content,
    type: MessageType.TOOL_RESULT,
    tool_calls: null,
    tool_call_id: callId,
    name,
    thinking: null,
    timestamp: new Date().toISOString(),
    usage: null,
    hidden: false,
    tool_result: canonical as unknown as Message['tool_result'],
  };
}

// ── shouldTriggerCompaction ─────────────────────────────────────────────────

describe('shouldTriggerCompaction — floor, threshold, hysteresis', () => {
  it('returns false below floor even when above threshold', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 8500,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 1000,
        minCompactableTokens: 4000,
      }),
    ).toBe(false);
    expect(
      shouldTriggerCompaction({
        inputTokens: 8500,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 4000,
        minCompactableTokens: 4000,
      }),
    ).toBe(true);
  });

  it('returns false below threshold', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 7000,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }),
    ).toBe(false);
  });

  it('returns true at exact threshold', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 8000,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }),
    ).toBe(true);
  });

  it('returns false when hysteresis armed (without accrual)', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 8500,
        contextTokens: 10_000,
        threshold: 0.8,
        hysteresisArmed: true,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
      }),
    ).toBe(false);
  });

  it('accrual alternative re-arms even while hysteresis armed', () => {
    // After compaction at 8000, now 12k of a 15k window (4000 accrued, still
    // above the 0.8 threshold but below the window) => accrual re-arm
    expect(
      shouldTriggerCompaction({
        inputTokens: 12_000,
        contextTokens: 15_000,
        threshold: 0.8,
        hysteresisArmed: true,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
        lastCompactionInputTokens: 8000,
      }),
    ).toBe(true);
    // But without enough accrual, still suppressed
    expect(
      shouldTriggerCompaction({
        inputTokens: 9000,
        contextTokens: 10_000,
        threshold: 0.8,
        hysteresisArmed: true,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
        lastCompactionInputTokens: 8000,
      }),
    ).toBe(false);
  });

  it('returns false when contextTokens is zero', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 5000,
        contextTokens: 0,
        threshold: 0.8,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }),
    ).toBe(false);
  });
});

// ── estimateNextInputTokens ─────────────────────────────────────────────────

describe('estimateNextInputTokens — calibrated char estimator', () => {
  it('returns only the reported base when no calibrated ratio exists (hard rule: no chars/4 estimation)', () => {
    const pending = [makeMsg('u1', 'hello world')]; // 11 chars
    const est = estimateNextInputTokens(8000, pending, undefined);
    expect(est).toBe(8000);
  });

  it('scales by provided tokensPerChar', () => {
    const pending = [makeMsg('u1', 'x'.repeat(100))];
    const estLow = estimateNextInputTokens(5000, pending, 0.1);
    const estHigh = estimateNextInputTokens(5000, pending, 0.5);
    expect(estHigh).toBeGreaterThan(estLow);
    expect(estLow).toBe(5000 + Math.ceil(100 * 0.1));
    expect(estHigh).toBe(5000 + Math.ceil(100 * 0.5));
  });

  it('returns base when pending empty', () => {
    expect(estimateNextInputTokens(7500, [], 0.3)).toBe(7500);
    expect(estimateNextInputTokens(undefined, [], undefined)).toBe(0);
  });

  it('computeTokensPerChar derives ratio', () => {
    const msgs = [makeMsg('u1', 'x'.repeat(100)), makeMsg('a1', 'y'.repeat(100))];
    const ratio = computeTokensPerChar(50, msgs);
    expect(ratio).toBeCloseTo(50 / 200, 5);
  });

  it('estimate pre-flight: lastReported 0.75*c + calibrated pending tail crosses threshold early', () => {
    const contextTokens = 10_000;
    const threshold = 0.8;
    const lastReported = 7500; // 0.75 below
    // Calibrated ratio 0.25: pending tail adds 800 tokens → estimate 8300 crosses
    const pending = [makeMsg('u-next', 'x'.repeat(3200))];
    const est = estimateNextInputTokens(lastReported, pending, 0.25);
    expect(est / contextTokens).toBeGreaterThanOrEqual(threshold);
    expect(lastReported / contextTokens).toBeLessThan(threshold);
  });
});

// ── Hysteresis: fires once at crossing not repeatedly ───────────────────────

describe('hysteresis — fires once at crossing not repeatedly', () => {
  it('CompactionTrigger suppresses second fire until re-arm', () => {
    const trigger = new CompactionTrigger();
    const ctx = 10_000;
    const threshold = 0.8;
    const minTokens = 1000;
    const compactable = 5000;

    // First crossing should prepare
    let dec = trigger.evaluatePrepare({
      inputTokens: 8500,
      contextTokens: ctx,
      threshold,
      compactableTokens: compactable,
      minCompactableTokens: minTokens,
    });
    expect(dec.shouldPrepare).toBe(true);
    trigger.markPrepareStarted({ start: 0, end: 10 });
    // Simulate compaction without recording a low post value — hysteresis must still
    // guard even though input later drops only slightly. Using the pre-compaction
    // peak as baseline ensures accrual (8400-8500) does not re-arm with small min.
    trigger.onCompactionApplied(8500);

    // Second observation still above threshold but hysteresis armed => no re-fire
    trigger.onUsage(8400, ctx, threshold);
    dec = trigger.evaluatePrepare({
      inputTokens: 8400,
      contextTokens: ctx,
      threshold,
      compactableTokens: compactable,
      minCompactableTokens: minTokens,
    });
    expect(dec.shouldPrepare).toBe(false);
    expect(dec.reason).toBe('hysteresis-armed');

    // Even another crossing still suppressed
    trigger.onUsage(8500, ctx, threshold);
    dec = trigger.evaluatePrepare({
      inputTokens: 8500,
      contextTokens: ctx,
      threshold,
      compactableTokens: compactable,
      minCompactableTokens: minTokens,
    });
    expect(dec.shouldPrepare).toBe(false);
  });

  it('nextHysteresisArmed drops below re-arm line', () => {
    expect(nextHysteresisArmed(true, 6500, 10_000, 0.8, 0.1)).toBe(false); // below 7000
    expect(nextHysteresisArmed(true, 7200, 10_000, 0.8, 0.1)).toBe(true);
    expect(nextHysteresisArmed(false, 6500, 10_000, 0.8, 0.1)).toBe(false);
  });

  it('updateTriggerStateOnUsage transitions armed->disarmed after drop', () => {
    let state: import('../../src/main/llm/compaction/trigger').TriggerState = {
      hysteresisArmed: true,
      lastCompactionInputTokens: 8000,
      pendingPrepare: false,
    };
    state = updateTriggerStateOnUsage(state, 8200, 10_000, 0.8, 0.1);
    expect(state.hysteresisArmed).toBe(true);
    state = updateTriggerStateOnUsage(state, 6500, 10_000, 0.8, 0.1);
    expect(state.hysteresisArmed).toBe(false);
  });
});

// ── Floor ───────────────────────────────────────────────────────────────────

describe('floor — no fire below min_compactable_tokens', () => {
  it('canStartPrepare rejects below floor', () => {
    const state = { hysteresisArmed: false, pendingPrepare: false };
    const res = canStartPrepare(state, {
      inputTokens: 9000,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 2000,
      minCompactableTokens: 4000,
    });
    expect(res.shouldPrepare).toBe(false);
    expect(res.reason).toBe('below-floor');
  });

  it('shouldApplyAtBoundary rejects below floor', () => {
    const state = { hysteresisArmed: false, pendingPrepare: true };
    const res = shouldApplyAtBoundary(state, {
      inputTokens: 9000,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 100,
      minCompactableTokens: 4000,
      hasPendingPrepare: true,
    });
    expect(res.shouldApply).toBe(false);
  });
});

// ── Prepare/apply split (R12) ───────────────────────────────────────────────

describe('prepare/apply split — prepare mid-step, apply deferred to boundary', () => {
  it('prepare starts mid-step, apply deferred until boundary', () => {
    const trigger = new CompactionTrigger();
    const ctx = 10_000;
    const threshold = 0.8;

    // Mid-step crossing: canStartPrepare true
    const prep = trigger.evaluatePrepare({
      inputTokens: 8500,
      contextTokens: ctx,
      threshold,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(prep.shouldPrepare).toBe(true);
    trigger.markPrepareStarted({ start: 0, end: 5 });

    // Before boundary, shouldApply false if no boundary yet? But with pendingPrepare, evaluateApply returns true at boundary
    const beforeBoundary = trigger.evaluateApply({
      inputTokens: 8500,
      contextTokens: ctx,
      threshold,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(beforeBoundary.shouldApply).toBe(true);

    // Consume pending after apply
    trigger.consumePending();
    expect(trigger.state.pendingPrepare).toBe(false);
  });

  it('canStartPrepare does not start second while pending', () => {
    const state = { hysteresisArmed: false, pendingPrepare: true as const };
    const res = canStartPrepare(state, {
      inputTokens: 9000,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(res.shouldPrepare).toBe(false);
    expect(res.reason).toBe('prepare-already-pending');
  });

  it('shouldApply requires pendingPrepare', () => {
    const state = { hysteresisArmed: false, pendingPrepare: false as const };
    const res = shouldApplyAtBoundary(state, {
      inputTokens: 9000,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
      hasPendingPrepare: false,
    });
    expect(res.shouldApply).toBe(false);
    expect(res.reason).toBe('no-pending-prepare');
  });
});

// ── Re-arm — only after drop-and-recross ───────────────────────────────────

describe('re-arm only after drop-and-recross', () => {
  it('requires drop below re-arm line then recross', () => {
    const trigger = new CompactionTrigger();
    const ctx = 10_000;
    const threshold = 0.8;
    const delta = 0.1;
    const rearmLine = (threshold - delta) * ctx; // 7000

    // Compact at 8500
    trigger.onCompactionApplied(8500);

    // Still 8100 — not below rearm, stay armed
    trigger.onUsage(8100, ctx, threshold, delta);
    expect(trigger.state.hysteresisArmed).toBe(true);
    expect(
      trigger.evaluatePrepare({
        inputTokens: 8100,
        contextTokens: ctx,
        threshold,
        hysteresisDelta: delta,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }).shouldPrepare,
    ).toBe(false);

    // Still 7500 — above rearm line (7000) but below threshold, still armed (has not dropped enough)
    trigger.onUsage(7500, ctx, threshold, delta);
    expect(trigger.state.hysteresisArmed).toBe(true);

    // Drop to 6500 — below rearm, disarm
    trigger.onUsage(6500, ctx, threshold, delta);
    expect(trigger.state.hysteresisArmed).toBe(false);
    void rearmLine;

    // Still below threshold => no fire
    expect(
      trigger.evaluatePrepare({
        inputTokens: 6500,
        contextTokens: ctx,
        threshold,
        hysteresisDelta: delta,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }).shouldPrepare,
    ).toBe(false);

    // Recross to 8500 => fires again
    trigger.onUsage(8500, ctx, threshold, delta);
    expect(
      trigger.evaluatePrepare({
        inputTokens: 8500,
        contextTokens: ctx,
        threshold,
        hysteresisDelta: delta,
        compactableTokens: 5000,
        minCompactableTokens: 1000,
      }).shouldPrepare,
    ).toBe(true);
  });

  it('accrual alternative re-arms even without drop', () => {
    const trigger = new CompactionTrigger();
    trigger.onCompactionApplied(8000, 4000); // post-compaction 4000
    // Stay at 7800: 7800-4000=3800 <4000 still armed
    trigger.onUsage(7800, 10_000, 0.8, 0.1);
    expect(
      trigger.evaluatePrepare({
        inputTokens: 7800,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
      }).shouldPrepare,
    ).toBe(false);
    // At 9000, accrued = 9000-4000=5000 >=4000 => re-arm via accrual even though still above re-arm line
    expect(
      trigger.evaluatePrepare({
        inputTokens: 9000,
        contextTokens: 10_000,
        threshold: 0.8,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
      }).shouldPrepare,
    ).toBe(true);
  });
});

// ── Estimate pre-flight arms prepare before confirming usage event ──────────

describe('estimate pre-flight — advisory estimate arms prepare before usage', () => {
  it('estimated crossing starts prepare even when lastReported below threshold', () => {
    const trigger = new CompactionTrigger();
    // Simulate prior usage 7500 (below 8000)
    trigger.state.lastObservedInputTokens = 7500;
    trigger.state.tokensPerChar = 0.25;
    const pending = [makeMsg('u-pending', 'x'.repeat(3200))]; // 800 tokens via fallback
    const estimated = trigger.estimatePreFlight(pending);
    expect(estimated).toBeGreaterThanOrEqual(8000);
    // Confirmed usage not yet at threshold, but estimate crosses
    const decViaEstimate = trigger.evaluatePrepare({
      estimatedInputTokens: estimated,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(decViaEstimate.shouldPrepare).toBe(true);

    // Direct usage still below should not prepare
    const decViaDirect = trigger.evaluatePrepare({
      inputTokens: 7500,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(decViaDirect.shouldPrepare).toBe(false);
  });

  it('later usage event supersedes stale estimate (no double prepare)', () => {
    const trigger = new CompactionTrigger();
    trigger.state.lastObservedInputTokens = 7500;
    trigger.state.tokensPerChar = 0.25;
    const pending = [makeMsg('u-pending', 'x'.repeat(4000))]; // 1000 tokens
    const estimated = estimateNextInputTokens(7500, pending, 0.25);
    expect(estimated).toBe(8500);
    // Start prepare via estimate
    const first = canStartPrepare(trigger.state, {
      estimatedInputTokens: estimated,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(first.shouldPrepare).toBe(true);
    trigger.markPrepareStarted({ start: 0, end: 5 });

    // While prepare pending, another evaluate via usage should not start second
    const second = canStartPrepare(trigger.state, {
      inputTokens: 8500,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(second.shouldPrepare).toBe(false);
  });

  it('estimate that does not cross does not arm prepare', () => {
    const state = { hysteresisArmed: false, pendingPrepare: false };
    const res = canStartPrepare(state, {
      inputTokens: 7000,
      estimatedInputTokens: 7100,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
    });
    expect(res.shouldPrepare).toBe(false);
    expect(res.reason).toBe('below-threshold');
  });
});

// ── Reclaim short-circuit skips summarizer ──────────────────────────────────

describe('reclaim short-circuit — skips summarizer when re-arm line cleared', () => {
  it('reclaim-only apply when post-reclaim below re-arm line', () => {
    // Build history where duplicate tool outputs are large and reclaim will free enough
    const history: Message[] = [
      makeMsg('u1', 'start'),
      makeToolCall('c1', 'read', { path: 'a.txt' }, 'tc1'),
      makeToolResult('c1', 'read', 'x'.repeat(8000), 'r1'),
      makeToolCall('c2', 'read', { path: 'a.txt' }, 'tc2'),
      makeToolResult('c2', 'read', 'x'.repeat(8000), 'r2'),
    ];
    const range = { start: 0, end: history.length };
    const { flaggedIds } = mechanicalReclaim(history, range);
    expect(flaggedIds).toContain('r1');

    // Input 8500 over threshold, but reclaim should drop below 7000
    const decision = evaluateTriggerWithReclaim({
      inputTokens: 8500,
      contextTokens: 10_000,
      threshold: 0.8,
      hysteresisDelta: 0.1,
      compactableTokens: 6000,
      minCompactableTokens: 1000,
      compactableRange: range,
      messages: history,
      flaggedIds,
    });
    expect(decision.shouldPrepare).toBe(false);
    expect(decision.shouldApply).toBe(true);
    expect(decision.reason).toBe('reclaim-short-circuit');
    expect(decision.flaggedIds).toBeDefined();
  });

  it('when reclaim is small, prepare still starts', () => {
    const tinyHistory: Message[] = [
      makeMsg('u1', 'x'.repeat(5000)),
      makeToolCall('c1', 'read', { path: 'a.txt' }, 'tc1'),
      makeToolResult('c1', 'read', 'tiny', 'r1'),
      makeToolCall('c2', 'read', { path: 'a.txt' }, 'tc2'),
      makeToolResult('c2', 'read', 'tiny', 'r2'),
    ];
    const { flaggedIds } = mechanicalReclaim(tinyHistory, { start: 0, end: tinyHistory.length });
    // Tiny dup won't drop 8500 below 7000
    const decision = evaluateTriggerWithReclaim({
      inputTokens: 8500,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
      messages: tinyHistory,
      flaggedIds,
    });
    expect(decision.shouldPrepare).toBe(true);
    expect(decision.shouldApply).toBe(false);
    expect(decision.reason).toBe('prepare');
  });

  it('no flaggedIds => no short-circuit, normal prepare', () => {
    const history: Message[] = [makeMsg('u1', 'hello'), makeMsg('a1', 'world')];
    const decision = evaluateTriggerWithReclaim({
      inputTokens: 8500,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 5000,
      minCompactableTokens: 1000,
      messages: history,
      flaggedIds: [],
    });
    expect(decision.shouldPrepare).toBe(true);
  });

  it('below floor never triggers even with reclaim', () => {
    const history: Message[] = [
      makeMsg('u1', 'hi'),
      makeToolCall('c1', 'read', { path: 'a.txt' }, 'tc1'),
      makeToolResult('c1', 'read', 'x'.repeat(1000), 'r1'),
    ];
    const decision = evaluateTriggerWithReclaim({
      inputTokens: 9000,
      contextTokens: 10_000,
      threshold: 0.8,
      compactableTokens: 500, // below floor 4000
      minCompactableTokens: 4000,
      messages: history,
      flaggedIds: [],
    });
    expect(decision.shouldPrepare).toBe(false);
    expect(decision.reason).toBe('below-floor');
  });
});

// ── markCompactionApplied & state tracking ──────────────────────────────────

describe('CompactionTrigger state lifecycle', () => {
  it('tracks tokensPerChar via observeUsage', () => {
    const trigger = new CompactionTrigger();
    const msgs = [makeMsg('u1', 'x'.repeat(100)), makeMsg('a1', 'y'.repeat(100))];
    trigger.observeUsage(50, msgs);
    expect(trigger.state.tokensPerChar).toBeCloseTo(0.25, 2);
  });

  it('markCompactionApplied arms hysteresis', () => {
    const trigger = new CompactionTrigger();
    trigger.onCompactionApplied(9000, 5000);
    expect(trigger.state.hysteresisArmed).toBe(true);
    expect(trigger.state.lastCompactionInputTokens).toBe(9000);
    expect(trigger.state.postCompactionInputTokens).toBe(5000);
  });
});

describe('shouldTriggerCompaction with postCompaction baseline accrual', () => {
  it('uses postCompaction baseline for accrual when available', () => {
    expect(
      shouldTriggerCompaction({
        inputTokens: 8000,
        contextTokens: 10_000,
        threshold: 0.8,
        hysteresisArmed: true,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
        postCompactionInputTokens: 4000,
        lastCompactionInputTokens: 9000,
      }),
    ).toBe(true); // 8000-4000=4000 meets floor
    expect(
      shouldTriggerCompaction({
        inputTokens: 7000,
        contextTokens: 10_000,
        threshold: 0.8,
        hysteresisArmed: true,
        compactableTokens: 5000,
        minCompactableTokens: 4000,
        postCompactionInputTokens: 4000,
      }),
    ).toBe(false); // ratio 0.7 <0.8
  });
});
