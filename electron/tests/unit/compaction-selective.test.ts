import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import { buildManifest, parseSelectiveOps, selectiveOpsToJson, PREVIEW_MAX_LENGTH } from '../../src/main/llm/compaction/selective/manifest';
import { validateSelectiveOps } from '../../src/main/llm/compaction/selective/validate';
import { materializeSelectiveOps, runSelectiveCompaction, passesReplayInvariant } from '../../src/main/llm/compaction/selective/run';
import type { SelectiveOp } from '../../src/main/llm/compaction/selective/manifest';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 9)}`,
    role: overrides.role ?? MessageRole.USER,
    content: overrides.content ?? '',
    type: overrides.type ?? MessageType.TEXT,
    tool_calls: overrides.tool_calls ?? null,
    tool_call_id: overrides.tool_call_id ?? null,
    name: overrides.name ?? null,
    thinking: overrides.thinking ?? null,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    usage: overrides.usage ?? null,
    hidden: overrides.hidden ?? false,
    excludeFromModel: overrides.excludeFromModel,
    compacted: overrides.compacted,
    tool_result: overrides.tool_result ?? null,
  } as Message;
}
function makeUser(id: string, content: string): Message { return makeMessage({ id, role: MessageRole.USER, content, type: MessageType.TEXT }); }
function makeAssistant(id: string, content: string): Message { return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.TEXT }); }
function makeThinking(id: string, content: string): Message { return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.THINKING, thinking: content }); }
function makeToolCallMsg(id: string, callId: string, name: string, args='{}', content=''): Message {
  const tc: ToolCall = { id: callId, type: 'function', function: { name, arguments: args } };
  return makeMessage({ id, role: MessageRole.ASSISTANT, content, type: MessageType.TOOL_CALL, tool_calls: [tc], tool_call_id: callId, name });
}
function makeToolResult(id: string, callId: string, name: string, content: string): Message {
  return makeMessage({ id, role: MessageRole.TOOL, content, type: MessageType.TOOL_RESULT, tool_call_id: callId, name });
}
function multiLineContent(lines: number, prefix='line'): string {
  return Array.from({ length: lines }, (_, i) => `${prefix} ${i + 1}`).join('\n');
}

// ── U12 manifest builder ────────────────────────────────────────────────────

describe('U12 manifest builder', () => {
  it('covers all replayable elements with stable ids', () => {
    const msgs: Message[] = [
      makeUser('u1', 'hello'),
      makeAssistant('a1', 'hi'),
      makeToolCallMsg('tc1', 'call-1', 'read'),
      makeToolResult('tr1', 'call-1', 'read', 'content'),
      makeThinking('th1', 'thinking text'),
      makeUser('u2', 'follow up'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: msgs.length });
    expect(manifest.entries).toHaveLength(msgs.length);
    expect(manifest.entries.map(e => e.id)).toEqual(msgs.map(m => m.id));
    expect(manifest.entries[0]!.index).toBe(0);
    expect(manifest.byId.get('u1')!.id).toBe('u1');
    // compactable range preserved
    expect(manifest.compactableRange).toEqual({ start: 0, end: 6 });
  });

  it('previews bounded to PREVIEW_MAX_LENGTH and one line', () => {
    const long = 'a'.repeat(500) + '\n' + 'b'.repeat(200);
    const msg = makeUser('u1', long);
    const manifest = buildManifest([msg], { start: 0, end: 1 });
    const preview = manifest.entries[0]!.preview;
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_LENGTH);
    expect(preview).not.toContain('\n');
    // short content unchanged
    const shortMsg = makeUser('u2', 'short');
    const m2 = buildManifest([shortMsg], { start: 0, end: 1 });
    expect(m2.entries[0]!.preview).toBe('short');
  });

  it('preview for tool call includes function names', () => {
    const msg = makeToolCallMsg('tc1', 'call-1', 'grep', JSON.stringify({ pattern: 'foo' }));
    const manifest = buildManifest([msg], { start: 0, end: 1 });
    expect(manifest.entries[0]!.kind).toBe('tool_call');
    expect(manifest.entries[0]!.preview).toContain('grep');
  });

  it('compactableRange slice only', () => {
    const msgs = [makeUser('u1','a'), makeUser('u2','b'), makeUser('u3','c'), makeUser('u4','d')];
    const manifest = buildManifest(msgs, { start: 1, end: 3 });
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0]!.id).toBe('u2');
    expect(manifest.entries[1]!.id).toBe('u3');
  });

  it('ops parse and round-trip', () => {
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep_range', id: 'tr1', startLine: 1, endLine: 5 },
      { type: 'summarize', ids: ['a1', 'tc1'], text: 'summary text' },
    ];
    const json = selectiveOpsToJson(ops);
    const parsed = parseSelectiveOps(json);
    expect(parsed).toEqual(ops);
  });
});

// ── U13 validator ───────────────────────────────────────────────────────────

describe('U13 validator', () => {
  it('valid list passes clean', () => {
    const msgs: Message[] = [
      makeUser('u1', 'user question'),
      makeAssistant('a1', 'answer'),
      makeToolCallMsg('tc1', 'call-1', 'read'),
      makeToolResult('tr1', 'call-1', 'read', 'file content'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: msgs.length });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1', 'tc1', 'tr1'], text: 'summarized' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
    expect(res.correctedOps).toEqual(ops);
  });

  it('out-of-order ops sorted to manifest order (mechanical)', () => {
    const msgs = [makeUser('u1','a'), makeAssistant('a1','b'), makeUser('u2','c')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u2' },
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'a1' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.correctedOps.map(o => (o as any).id)).toEqual(['u1','a1','u2']);
    expect(res.mechanicalCorrections.some(c => c.includes('reordered'))).toBe(true);
    // Still valid if all users present (they are)
    expect(res.valid).toBe(true);
  });

  it('dangling refs dropped (mechanical)', () => {
    const msgs = [makeUser('u1','a'), makeAssistant('a1','b')];
    const manifest = buildManifest(msgs, { start: 0, end: 2 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'ghost' },
      { type: 'summarize', ids: ['a1', 'ghost2'], text: 'hi' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.mechanicalCorrections.some(c => c.includes('dangling'))).toBe(true);
    // ghost dropped, summarize filtered to just a1
    expect(res.correctedOps.some(o => (o as any).id === 'ghost')).toBe(false);
    const sumOp = res.correctedOps.find(o => o.type === 'summarize') as any;
    expect(sumOp.ids).toEqual(['a1']);
    expect(res.valid).toBe(true); // all required users present? u1 present yes
  });

  it('out-of-range lines clamped', () => {
    const content = multiLineContent(5);
    const msg = makeToolResult('tr1', 'call-1', 'read', content);
    const call = makeToolCallMsg('tc1', 'call-1', 'read');
    const user = makeUser('u1', 'q');
    const msgs = [user, call, msg];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'tc1' },
      { type: 'keep_range', id: 'tr1', startLine: -5, endLine: 1000 },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.mechanicalCorrections.some(c => c.includes('clamped'))).toBe(true);
    const kr = res.correctedOps.find(o => o.type === 'keep_range') as any;
    expect(kr.startLine).toBe(1);
    expect(kr.endLine).toBe(5);
    expect(res.valid).toBe(true);
  });

  it('missing user message -> semantic error for re-prompt', () => {
    const msgs = [makeUser('u1','question'), makeAssistant('a1','answer'), makeUser('u2','follow')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      // u2 missing
      { type: 'keep', id: 'a1' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('u2') && e.includes('missing'))).toBe(true);
  });

  it('summarized thinking rejected (R24)', () => {
    const msgs = [makeUser('u1','hi'), makeThinking('th1','deep thought'), makeAssistant('a1','answer')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['th1', 'a1'], text: 'summary' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('th1') && e.includes('thinking'))).toBe(true);
  });

  it('summarized spans must be contiguous -> semantic error', () => {
    const msgs = [makeUser('u1','a'), makeAssistant('a1','b'), makeToolCallMsg('tc1','c1','read'), makeToolResult('tr1','c1','read','out')];
    const manifest = buildManifest(msgs, { start: 0, end: 4 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1','tr1'], text: 'non contiguous' }, // gap at tc1
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('contiguous'))).toBe(true);
  });

  it('tool_call/result pairing broken -> semantic error', () => {
    const msgs = [makeUser('u1','q'), makeToolCallMsg('tc1','call-1','read'), makeToolResult('tr1','call-1','read','out')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'tc1' },
      // tr1 missing -> broken pair
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('call-1') || e.includes('broken'))).toBe(true);
  });

  it('tool pair split across different summarize ops -> error', () => {
    const msgs = [makeUser('u1','q'), makeToolCallMsg('tc1','c1','read'), makeToolResult('tr1','c1','read','out'), makeAssistant('a1','done')];
    const manifest = buildManifest(msgs, { start: 0, end: 4 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['tc1'], text: 'call summary' },
      { type: 'summarize', ids: ['tr1'], text: 'result summary' },
      { type: 'keep', id: 'a1' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('split'))).toBe(true);
  });

  it('same manifest id in multiple ops -> exact-once coverage error', () => {
    const msgs = [makeUser('u1','q'), makeAssistant('a1','answer'), makeAssistant('a2','more')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'a1' },
      { type: 'summarize', ids: ['a1', 'a2'], text: 'summary' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('a1') && e.includes('exact-once'))).toBe(true);
    // First occurrence wins in the corrected list so mechanical steps stay sane.
    expect(res.correctedOps.filter((o) => o.type === 'keep' && o.id === 'a1')).toHaveLength(1);
  });

  it('drop on a non-thinking message -> rejected (R24)', () => {
    const msgs = [makeUser('u1','q'), makeAssistant('a1','answer')];
    const manifest = buildManifest(msgs, { start: 0, end: 2 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'drop', id: 'a1' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('a1') && e.includes('drop on non-thinking'))).toBe(true);
  });
});

// ── U14 materialization and loop ────────────────────────────────────────────

describe('U14 materialization', () => {
  it('ranged keep truncates and annotates', () => {
    const content = multiLineContent(500, 'content line');
    const tr = makeToolResult('tr1', 'call-1', 'read', content);
    const call = makeToolCallMsg('tc1', 'call-1', 'read');
    const u1 = makeUser('u1','q');
    const msgs = [u1, call, tr, makeUser('u2','preserve')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'tc1' },
      { type: 'keep_range', id: 'tr1', startLine: 5, endLine: 50 },
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });
    // flagged includes tr1 original
    expect(m.flaggedIds).toContain('tr1');
    // replay contains truncated copy, not original
    const rangedCopy = m.replayMessages.find(r => r.id.includes('tr1:range'));
    expect(rangedCopy).toBeDefined();
    expect(rangedCopy!.content).toContain('truncated: lines 5-50 of 500');
    expect(rangedCopy!.content).toContain('content line 5');
    expect(rangedCopy!.content).toContain('content line 50');
    expect(rangedCopy!.content).not.toContain('content line 51');
    // preserve suffix still present
    expect(m.replayMessages.some(r => r.id === 'u2')).toBe(true);
  });

  it('materialized list passes replay invariant', () => {
    const msgs = [
      makeUser('u1','q'),
      makeToolCallMsg('tc1','call-1','read'),
      makeToolResult('tr1','call-1','read','out'),
      makeAssistant('a1','done'),
      makeUser('u2','next'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 4 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['tc1','tr1','a1'], text: 'summarized work' },
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });
    const inv = passesReplayInvariant(m.replayMessages);
    expect(inv.ok).toBe(true);
    // summarize synthetic plus preserve
    expect(m.replayMessages.length).toBe(3); // synthetic + u2 +? actually prefix 2 (u1 + synthetic) + preserve 1 = 3
    expect(m.flaggedIds).toEqual(expect.arrayContaining(['tc1','tr1','a1']));
  });

  it('thinking kept verbatim or dropped, materialization flags dropped', () => {
    const msgs = [makeUser('u1','q'), makeThinking('th1','thought'), makeAssistant('a1','ans')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep', id: 'a1' },
      // th1 omitted -> dropped
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });
    expect(m.flaggedIds).toContain('th1');
    expect(m.replayMessages.some(r => r.id === 'th1')).toBe(false);
  });
});

describe('U14 runSelectiveCompaction loop', () => {
  it('end-to-end selective compaction (valid on first try)', async () => {
    const msgs = [
      makeUser('u1','q'),
      makeAssistant('a1','a'),
      makeToolCallMsg('tc1','c1','read'),
      makeToolResult('tr1','c1','read','out'),
      makeUser('u2','preserve me'),
    ];
    const range = { start: 0, end: 4 };
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      selectiveCaller: async () => [
        { type: 'keep', id: 'u1' },
        { type: 'summarize', ids: ['a1','tc1','tr1'], text: 'handoff summary' },
      ],
    });
    expect(result.kind).toBe('selective');
    if (result.kind === 'selective') {
      expect(result.flaggedIds).toEqual(expect.arrayContaining(['a1','tc1','tr1']));
      expect(result.replayMessages.some(r => r.content === 'handoff summary')).toBe(true);
      expect(result.replayMessages.some(r => r.id === 'u2')).toBe(true);
      expect(result.attempts).toBe(1);
    }
  });

  it('correction round on seeded error (missing user) -> retries and succeeds', async () => {
    const msgs = [makeUser('u1','q'), makeAssistant('a1','a'), makeUser('u2','q2')];
    const range = { start: 0, end: 3 };
    let calls = 0;
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 3,
      selectiveCaller: async ({ attempt, previousErrors }) => {
        calls += 1;
        if (attempt === 0) {
          // missing u2 -> semantic error
          return [{ type: 'keep', id: 'u1' }, { type: 'keep', id: 'a1' }];
        }
        // second attempt fixes, includes previousErrors for prompt
        expect(previousErrors?.some(e => e.includes('u2'))).toBe(true);
        return [{ type: 'keep', id: 'u1' }, { type: 'keep', id: 'a1' }, { type: 'keep', id: 'u2' }];
      },
    });
    expect(result.kind).toBe('selective');
    expect(calls).toBe(2);
    if (result.kind === 'selective') expect(result.attempts).toBe(2);
  });

  it('fallback to simple after cap exhausted', async () => {
    const msgs = [makeUser('u1','q'), makeAssistant('a1','a')];
    const range = { start: 0, end: 2 };
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 2,
      selectiveCaller: async () => [{ type: 'keep', id: 'a1' }], // always missing u1
      simpleFallback: () => ({ text: 'simple fallback summary' }),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.fallbackText).toBe('simple fallback summary');
      expect(result.reason).toContain('failed after');
      expect(result.replayMessages?.some(r => r.content === 'simple fallback summary')).toBe(true);
    }
  });

  it('out-of-order ops are auto-corrected and still succeed', async () => {
    const msgs = [makeUser('u1','a'), makeAssistant('a1','b'), makeUser('u2','c')];
    const range = { start: 0, end: 3 };
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      selectiveCaller: async () => [
        { type: 'keep', id: 'u2' },
        { type: 'keep', id: 'u1' },
        { type: 'keep', id: 'a1' },
      ],
    });
    expect(result.kind).toBe('selective');
    if (result.kind === 'selective') {
      // Should be sorted in replay
      const ids = result.replayMessages.filter(r => ['u1','a1','u2'].includes(r.id)).map(r=>r.id);
      expect(ids).toEqual(['u1','a1','u2']);
    }
  });
});
