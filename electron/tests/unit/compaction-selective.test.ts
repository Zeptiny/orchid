import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/shared/types/message';
import { MessageRole, MessageType, SUMMARY_SECTION_SEPARATOR } from '../../src/shared/types/message';
import type { ToolCall } from '../../src/shared/types/tool';
import { buildManifest, parseSelectiveOps, selectiveOpsToJson, PREVIEW_MAX_LENGTH } from '../../src/main/llm/compaction/selective/manifest';
import { validateSelectiveOps, SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS } from '../../src/main/llm/compaction/selective/validate';
import { selectiveTranscriptChars } from '../../src/main/llm/compaction/selective/transcript';
import { materializeSelectiveOps, runSelectiveCompaction, passesReplayInvariant } from '../../src/main/llm/compaction/selective/run';
import { buildSelectiveCompactionApply } from '../../src/main/llm/compaction/apply';
import type { CutResult } from '../../src/main/llm/compaction/select';
import type { Chain } from '../../src/shared/types/chain';
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

  it('substantive span summarized with an activity log -> rejected for re-prompt', () => {
    const bigContent = 'f'.repeat(1500); // >= SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS
    const msgs: Message[] = [
      makeUser('u1','q'),
      makeToolCallMsg('tc1','c1','read'),
      makeToolResult('tr1','c1','read', bigContent),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['tc1','tr1'], text: 'Assistant read a file.' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('not a substantive handoff'))).toBe(true);
  });

  it('substantive span with a real handoff text passes', () => {
    const bigContent = 'f'.repeat(1500);
    const handoff = [
      '**Goal:** fix the login bug from u1.',
      '**Key Findings:** read returned the trigger engine layout; the expiry bug is the units mismatch between exp (seconds) and Date.now() (milliseconds).',
      '**Files:** src/auth.ts — handleLogin compares exp against Date.now() at line 42.',
      '**Next Step:** patch the comparison and add a regression test.',
    ].join('\n');
    const msgs: Message[] = [
      makeUser('u1','q'),
      makeToolCallMsg('tc1','c1','read'),
      makeToolResult('tr1','c1','read', bigContent),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['tc1','tr1'], text: handoff },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('tiny span keeps the non-empty rule only (no substance floor)', () => {
    const msgs: Message[] = [
      makeUser('u1','q'),
      makeAssistant('a1','short note'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 2 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1'], text: 'brief' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(true);
  });

  it('span size counts the serialized transcript fields, not content alone (F5)', () => {
    // Five tool pairs whose results carry only 60 content chars each (300
    // total — under SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS when measuring content
    // alone), but the transcript serialization the compactor reads adds the
    // tool names/arguments and tool_call_id lines, pushing the span over the
    // substance floor — so the activity-log text must be rejected.
    const msgs: Message[] = [makeUser('u1','q')];
    for (let i = 0; i < 5; i += 1) {
      msgs.push(makeToolCallMsg(`tc-${i}`, `c${i}`, 'grep', JSON.stringify({ pattern: 'x'.repeat(50) })));
      msgs.push(makeToolResult(`tr-${i}`, `c${i}`, 'grep', 'y'.repeat(60)));
    }
    const manifest = buildManifest(msgs, { start: 0, end: msgs.length });
    const spanIds = msgs.slice(1).map((m) => m.id);
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: spanIds, text: 'Assistant ran some searches.' },
    ];
    const res = validateSelectiveOps(ops, manifest, msgs);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('not a substantive handoff'))).toBe(true);
  });

  it('span size counts the "\\n\\n" separators between entries — separators alone can cross the substance floor', () => {
    // formatSelectiveConversation joins the selected entries with "\n\n"
    // (none before the first entry). Size a two-message span whose line chars
    // sum to 999 — under the 1000-char floor without separators, over it once
    // the single 2-char separator counts — and one at 997 (999 with the
    // separator, still under), so the separators alone decide whether the
    // handoff-substance rule applies.
    // Header overhead per id (a 1-char body, minus that char; an empty body
    // would trim the header's trailing space and undercount by one).
    const overheadA1 = selectiveTranscriptChars(makeAssistant('a1', 'x')) - 1;
    const overheadA2 = selectiveTranscriptChars(makeAssistant('a2', 'x')) - 1;
    const activityLog = 'Assistant did some work.';
    function spanOf(totalLineChars: number): { msgs: Message[]; ops: SelectiveOp[] } {
      const contentChars = totalLineChars - overheadA1 - overheadA2;
      const first = Math.ceil(contentChars / 2);
      const msgs: Message[] = [
        makeUser('u1', 'q'),
        makeAssistant('a1', 'x'.repeat(first)),
        makeAssistant('a2', 'x'.repeat(contentChars - first)),
      ];
      return {
        msgs,
        ops: [
          { type: 'keep', id: 'u1' },
          { type: 'summarize', ids: ['a1', 'a2'], text: activityLog },
        ],
      };
    }

    const atFloor = spanOf(SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS - 1); // 999 + 2 separators = 1001 ≥ floor
    const manifest = buildManifest(atFloor.msgs, { start: 0, end: atFloor.msgs.length });
    const rejected = validateSelectiveOps(atFloor.ops, manifest, atFloor.msgs);
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.some(e => e.includes('not a substantive handoff'))).toBe(true);

    const belowFloor = spanOf(SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS - 3); // 997 + 2 = 999 < floor
    const manifest2 = buildManifest(belowFloor.msgs, { start: 0, end: belowFloor.msgs.length });
    const accepted = validateSelectiveOps(belowFloor.ops, manifest2, belowFloor.msgs);
    expect(accepted.valid).toBe(true);
    expect(accepted.errors).toHaveLength(0);
  });

  it('scoped exemptIds: non-exempt user ids may be summarized; exempt ids must be kept verbatim (F11/R31)', () => {
    const msgs = [makeUser('u1','task head'), makeUser('u2','old question'), makeAssistant('a1','answer')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['u2', 'a1'], text: 'summarized exchange' },
    ];
    // Backcompat default (no exemptIds): summarizing any user id is rejected.
    const universal = validateSelectiveOps(ops, manifest, msgs);
    expect(universal.valid).toBe(false);
    expect(universal.errors.some(e => e.includes('u2') && e.includes('must be kept verbatim'))).toBe(true);
    // Scoped set: u1 is exempt (and kept), u2 is not — the span is valid.
    const scoped = validateSelectiveOps(ops, manifest, msgs, new Set(['u1']));
    expect(scoped.valid).toBe(true);
    expect(scoped.errors).toHaveLength(0);
  });

  it('scoped exemptIds: an exempt user message left out of ops is still required present (F11/R31)', () => {
    const msgs = [makeUser('u1','q'), makeUser('u2','q2'), makeAssistant('a1','a')];
    const manifest = buildManifest(msgs, { start: 0, end: 3 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u2' },
      { type: 'summarize', ids: ['a1'], text: 'summarized' },
      // u1 (exempt) missing
    ];
    const res = validateSelectiveOps(ops, manifest, msgs, new Set(['u1']));
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('u1') && e.includes('missing'))).toBe(true);
  });

  it('scoped exemptIds: keep_range on a non-exempt user passes; on an exempt user it errors (F11)', () => {
    const msgs = [makeUser('u1','task head'), makeUser('u2', multiLineContent(10))];
    const manifest = buildManifest(msgs, { start: 0, end: 2 });
    const exempt = new Set(['u1']);
    const rangedNonExempt: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'keep_range', id: 'u2', startLine: 1, endLine: 5 },
    ];
    expect(validateSelectiveOps(rangedNonExempt, manifest, msgs, exempt).valid).toBe(true);
    const rangedExempt: SelectiveOp[] = [
      { type: 'keep', id: 'u2' },
      { type: 'keep_range', id: 'u1', startLine: 1, endLine: 5 },
    ];
    const res = validateSelectiveOps(rangedExempt, manifest, msgs, exempt);
    expect(res.valid).toBe(false);
    expect(res.errors.some(e => e.includes('keep_range on user message u1'))).toBe(true);
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

  it('coalesces MULTIPLE summarize ops into ONE synthetic summary head (review #53)', () => {
    // Spans hold only valid non-thinking messages (assistant text) —
    // summarizing thinking is rejected by the validator (R24).
    const msgs = [
      makeUser('u1', 'q'),
      makeAssistant('a1', 'first work'),
      makeAssistant('th1', 'reasoning one'),
      makeAssistant('a2', 'second work'),
      makeAssistant('th2', 'reasoning two'),
      makeUser('u2', 'preserve'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 5 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1', 'th1'], text: 'Section one summary.' },
      { type: 'summarize', ids: ['a2', 'th2'], text: 'Section two summary.' },
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });

    // ONE synthetic summary message in the replay — not one per op.
    const heads = m.replayMessages.filter((r) => r.compacted);
    expect(heads).toHaveLength(1);
    expect(m.summaryMessages).toHaveLength(1);
    expect(m.summaryMessage?.id).toBe(heads[0]!.id);
    // Combined sections joined with a separator.
    expect(heads[0]!.content).toBe(['Section one summary.', 'Section two summary.'].join(SUMMARY_SECTION_SEPARATOR));
    // Marker anchors span all summarized ids with the total count.
    expect(heads[0]!.compacted?.rangeStart).toBe('a1');
    expect(heads[0]!.compacted?.rangeEnd).toBe('th2');
    expect(heads[0]!.compacted?.summarizedCount).toBe(4);
    // Positioned at the FIRST summarize op's slot — after the kept user head.
    expect(m.replayMessages.map((r) => r.id)).toEqual(['u1', heads[0]!.id, 'u2']);
    // All summarized originals flagged exactly once.
    expect(m.flaggedIds).toEqual(expect.arrayContaining(['a1', 'th1', 'a2', 'th2']));
    expect(m.flaggedIds).toHaveLength(4);
  });

  it('keeps a kept milestone between summarize spans at its replay position (F4)', () => {
    // summarize(A), keep(B), summarize(C): B must stay BETWEEN the two summary
    // heads — coalescing everything into ONE head at the first span's slot
    // would surface B after C's summarized content (A,B,C → summary(A+C),B).
    const msgs = [
      makeUser('u1', 'q'),
      makeAssistant('a1', 'work A'),
      makeAssistant('a2', 'milestone B'),
      makeAssistant('a3', 'work C'),
      makeUser('u2', 'preserve'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 4 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1'], text: 'Section one summary.' },
      { type: 'keep', id: 'a2' },
      { type: 'summarize', ids: ['a3'], text: 'Section two summary.' },
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });

    expect(m.summaryMessages).toHaveLength(2);
    expect(m.summaryMessage?.id).toBe(m.summaryMessages[0]!.id);
    // Replay order preserved: A's summary, then B verbatim, then C's summary.
    expect(m.replayMessages.map((r) => r.id)).toEqual([
      'u1', m.summaryMessages[0]!.id, 'a2', m.summaryMessages[1]!.id, 'u2',
    ]);
    // Each head anchors only its own span.
    expect(m.summaryMessages[0]!.compacted?.rangeStart).toBe('a1');
    expect(m.summaryMessages[0]!.compacted?.rangeEnd).toBe('a1');
    expect(m.summaryMessages[1]!.compacted?.rangeStart).toBe('a3');
    expect(m.flaggedIds).toEqual(expect.arrayContaining(['a1', 'a3']));
  });

  it('kept thinking between summarize spans does not split the coalesced head (review #53 shape)', () => {
    const msgs = [
      makeUser('u1', 'q'),
      makeAssistant('a1', 'work A'),
      makeThinking('th1', 'reasoning'),
      makeAssistant('a2', 'work B'),
      makeUser('u2', 'preserve'),
    ];
    const manifest = buildManifest(msgs, { start: 0, end: 4 });
    const ops: SelectiveOp[] = [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['a1'], text: 'Section one summary.' },
      { type: 'keep', id: 'th1' },
      { type: 'summarize', ids: ['a2'], text: 'Section two summary.' },
    ];
    const m = materializeSelectiveOps({ manifest, messages: msgs, ops });
    // Thinking separators are transparent (deliberation interleaved with tool
    // work): one head covering both spans, kept thinking after it.
    expect(m.summaryMessages).toHaveLength(1);
    expect(m.summaryMessages[0]!.compacted?.summarizedCount).toBe(2);
    expect(m.replayMessages.map((r) => r.id)).toEqual(['u1', m.summaryMessages[0]!.id, 'th1', 'u2']);
  });
});

// ── U7/R35: unified never-delete selective apply ────────────────────────────

describe('buildSelectiveCompactionApply — shared never-delete selective settle (R35)', () => {
  /** Chain of 6: compactable range [0,4), preserved window [4,6). */
  const CUT: CutResult = {
    cutIndex: 4,
    compactableRange: { start: 0, end: 4 },
    preservedCount: 1,
    openGroupStart: null,
    preservedRange: { start: 4, end: 6 },
  };
  function baseMessages(): Message[] {
    return [
      makeUser('u1', 'explore the repo'),
      makeAssistant('a1', 'I will read the config files.'),
      makeToolCallMsg('tc1', 'call-1', 'read_file'),
      makeToolResult('tr1', 'call-1', 'read_file', 'file contents'),
      makeAssistant('a2', 'done reading'),
      makeUser('u2', 'follow up'),
    ];
  }
  function makeChainFor(messages: readonly Message[]): Chain {
    return {
      id: 'chain-main',
      sessionId: 'session-main',
      messages: [...messages],
      status: 'active',
      selection: null,
      modelLabel: null,
      agentName: 'general',
      agentType: 'subagent',
      agentTier: 'bloom',
      subagentRecord: null,
      startTime: new Date().toISOString(),
      endTime: null,
      errorDetail: null,
      errorTitle: null,
    } as Chain;
  }

  it('main-scope invocation (replay-only, null summaryText) settles flags without deleting originals', () => {
    const messages = baseMessages();
    const chains = [makeChainFor(messages)];

    // The way persistSelectiveCompaction invokes the builder: replay-only
    // (main persists the replay rows itself), flags from the selective run.
    const settled = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      flaggedIds: ['a1', 'tc1', 'tr1'],
      summaryText: null,
      sessionId: 'session-main',
    });

    expect(settled).not.toBeNull();
    expect(settled!.didApply).toBe(true);
    // Replay-only shape: flags without a summary head.
    expect(settled!.summaryMessage).toBeNull();
    expect(settled!.newChain).toBeNull();
    expect(settled!.compactedMarker).toBeNull();
    // Never-delete: every original survives untouched by the flag pass.
    expect(settled!.updatedMessages.map((m) => m.id)).toEqual(messages.map((m) => m.id));
    expect(settled!.flaggedIds).toEqual(['a1', 'tc1', 'tr1']);
    for (const id of ['a1', 'tc1', 'tr1']) {
      expect(settled!.updatedMessages.find((m) => m.id === id)!.excludeFromModel).toBe(true);
    }
  });

  it('never flags user messages in any invocation shape and resets pre-existing user flags (R31)', () => {
    const messages = baseMessages();
    // u1 pre-flagged by a hypothetical earlier (superseded) selective run.
    messages[0] = { ...messages[0]!, excludeFromModel: true };
    const chains = [makeChainFor(messages)];

    for (const summaryText of ['Summarized work.', null]) {
      const settled = buildSelectiveCompactionApply({
        messages,
        chains,
        cutResult: CUT,
        flaggedIds: ['u1', 'a1'],
        summaryText,
        sessionId: 'session-main',
      });
      expect(settled, `summaryText=${summaryText}`).not.toBeNull();
      expect(settled!.flaggedIds).toEqual(['a1']);
      const u1 = settled!.updatedMessages.find((m) => m.id === 'u1')!;
      expect(u1.excludeFromModel).not.toBe(true);
      expect(settled!.updatedMessages.find((m) => m.id === 'a1')!.excludeFromModel).toBe(true);
    }
  });

  it('pre-excluded ids stay excluded inside the range and settle resets kept-verbatim ids', () => {
    const messages = baseMessages();
    // tc1 excluded by an EARLIER compaction (pre-existing flag, in range).
    messages[2] = { ...messages[2]!, excludeFromModel: true };
    const chains = [makeChainFor(messages)];

    const settled = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      // The selective pass kept tr1 verbatim and summarized a1; buildCompactionApply
      // would flag the whole range, so settle must reset tr1 and keep tc1 excluded.
      flaggedIds: ['a1'],
      summaryText: 'Summarized.',
      sessionId: 'session-main',
    });

    expect(settled).not.toBeNull();
    expect(settled!.updatedMessages.find((m) => m.id === 'tc1')!.excludeFromModel).toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'a1')!.excludeFromModel).toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'tr1')!.excludeFromModel).not.toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'u1')!.excludeFromModel).not.toBe(true);
  });

  it('identical inputs produce identical applies across scopes (R35)', () => {
    const messages = baseMessages();
    const chains = [makeChainFor(messages)];

    const subagentShape = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      flaggedIds: ['a1', 'tc1', 'tr1'],
      summaryText: 'Summarized exploration work.',
      sessionId: 'session-x',
    });
    const subagentShapeAgain = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      flaggedIds: ['a1', 'tc1', 'tr1'],
      summaryText: 'Summarized exploration work.',
      sessionId: 'session-x',
    });
    // One builder, two scopes: the apply (and the settled flag set the main
    // scope persists) is a pure function of the inputs — never of the scope.
    // (Summary-head ids are generated per invocation; normalize them.)
    const shape = (apply: NonNullable<ReturnType<typeof buildSelectiveCompactionApply>>) => {
      const headId = apply.summaryMessage?.id ?? null;
      return apply.updatedMessages.map((m) => [headId != null && m.id === headId ? '<head>' : m.id, m.excludeFromModel]);
    };
    expect(subagentShapeAgain!.flaggedIds).toEqual(subagentShape!.flaggedIds);
    expect(shape(subagentShapeAgain!)).toEqual(shape(subagentShape!));
    expect(subagentShape!.flaggedIds).toEqual(['a1', 'tc1', 'tr1']);
    // Reclaim ids merge into the same settled set for both scopes.
    const withReclaim = buildSelectiveCompactionApply({
      messages,
      chains,
      cutResult: CUT,
      flaggedIds: ['a1'],
      reclaimedIds: ['tr1', 'tr1'],
      summaryText: null,
    });
    expect([...withReclaim!.flaggedIds].sort()).toEqual(['a1', 'tr1']);
  });

  it('returns null (no-op) when the selective pass kept everything', () => {
    const messages = baseMessages();
    const settled = buildSelectiveCompactionApply({
      messages,
      chains: [makeChainFor(messages)],
      cutResult: CUT,
      flaggedIds: [],
      summaryText: null,
    });
    expect(settled).toBeNull();
  });

  it('scoped exempt set: exempt user id never flagged; non-exempt user id flaggable', () => {
    const messages = [
      makeUser('u1', 'explore the repo'),
      makeUser('u3', 'clarify the goal'),
      makeAssistant('a1', 'I will read the config files.'),
    ];
    const scopedCut: CutResult = {
      cutIndex: 3,
      compactableRange: { start: 0, end: 3 },
      preservedCount: 0,
      openGroupStart: null,
      preservedRange: { start: 3, end: 3 },
    };
    const settled = buildSelectiveCompactionApply({
      messages,
      chains: [makeChainFor(messages)],
      cutResult: scopedCut,
      flaggedIds: ['u1', 'u3', 'a1'],
      summaryText: 'Summarized.',
      sessionId: 'session-main',
      exemptIds: new Set(['u1']),
    });

    expect(settled).not.toBeNull();
    expect([...settled!.flaggedIds].sort()).toEqual(['a1', 'u3']);
    expect(settled!.updatedMessages.find((m) => m.id === 'u1')!.excludeFromModel).not.toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'u3')!.excludeFromModel).toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'a1')!.excludeFromModel).toBe(true);
  });

  it('scoped exempt set restores a pre-flagged exempt user message', () => {
    const messages = [
      makeUser('u1', 'explore the repo'),
      makeUser('u3', 'clarify the goal'),
      makeAssistant('a1', 'I will read the config files.'),
    ];
    // u1 flagged by a prior (now superseded) selective run.
    messages[0] = { ...messages[0]!, excludeFromModel: true };
    const scopedCut: CutResult = {
      cutIndex: 3,
      compactableRange: { start: 0, end: 3 },
      preservedCount: 0,
      openGroupStart: null,
      preservedRange: { start: 3, end: 3 },
    };

    const settled = buildSelectiveCompactionApply({
      messages,
      chains: [makeChainFor(messages)],
      cutResult: scopedCut,
      flaggedIds: ['u3', 'a1'],
      summaryText: 'Summarized.',
      sessionId: 'session-main',
      exemptIds: new Set(['u1']),
    });

    expect(settled).not.toBeNull();
    expect(settled!.flaggedIds).toEqual(['u3', 'a1']);
    expect(settled!.updatedMessages.find((m) => m.id === 'u1')!.excludeFromModel).not.toBe(true);
    expect(settled!.updatedMessages.find((m) => m.id === 'u3')!.excludeFromModel).toBe(true);
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
    const fallbackText = 'Fallback handoff summary: the exploration covered the compaction trigger engine, the select/apply pipeline, and the summarizer invocation; remaining work is the IPC wiring, renderer widgets, and subagent integration.';
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 2,
      selectiveCaller: async () => [{ type: 'keep', id: 'a1' }], // always missing u1
      simpleFallback: () => ({ text: fallbackText }),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.fallbackText).toBe(fallbackText);
      expect(result.reason).toContain('failed after');
      expect(result.replayMessages?.some(r => r.content === fallbackText)).toBe(true);
    }
  });

  it('rejects a degenerate fallback text instead of applying it as the handoff', async () => {
    const msgs = [makeUser('u1','q'), makeAssistant('a1','a')];
    const range = { start: 0, end: 2 };
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 1,
      selectiveCaller: async () => [{ type: 'keep', id: 'a1' }], // always missing u1
      simpleFallback: () => ({ text: '...' }),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      expect(result.fallbackText).toBeNull();
      expect(result.replayMessages).toBeUndefined();
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

  it('threads exemptIds into validation: non-exempt user summarizable on first try (F11/R31)', async () => {
    const msgs = [
      makeUser('u1','task head'),
      makeUser('u2','old question'),
      makeAssistant('a1','a'),
      makeUser('u3','preserve me'),
    ];
    const range = { start: 0, end: 3 };
    const ops = (): SelectiveOp[] => [
      { type: 'keep', id: 'u1' },
      { type: 'summarize', ids: ['u2', 'a1'], text: 'summarized exchange' },
    ];
    // Backcompat default (no exemptIds): u2 is protected, so the ops fail
    // validation and the run exhausts into fallback.
    const universal = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 1,
      selectiveCaller: async () => ops(),
      simpleFallback: () => null,
    });
    expect(universal.kind).toBe('fallback');
    // Scoped exempt set: the same ops are valid on the first attempt.
    const scoped = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      exemptIds: new Set(['u1']),
      selectiveCaller: async () => ops(),
    });
    expect(scoped.kind).toBe('selective');
    if (scoped.kind === 'selective') {
      expect(scoped.attempts).toBe(1);
      expect(scoped.flaggedIds).toEqual(expect.arrayContaining(['u2', 'a1']));
    }
  });

  it('fallback replay preserves only EXEMPT user messages verbatim (F11/R31)', async () => {
    const msgs = [
      makeUser('u1','task head'),
      makeUser('u2','old question'),
      makeAssistant('a1','a'),
      makeUser('u3','preserve me'),
    ];
    const range = { start: 0, end: 3 };
    const fallbackText = 'Fallback handoff summary: the exploration covered the compaction trigger engine, the select and apply pipeline, and the selective validator; the remaining work is the IPC wiring, renderer widgets, and subagent integration.';
    const result = await runSelectiveCompaction({
      messages: msgs,
      compactableRange: range,
      maxCorrectionRounds: 1,
      exemptIds: new Set(['u1']),
      selectiveCaller: async () => [], // exhausts correction rounds → simple fallback
      simpleFallback: () => ({ text: fallbackText }),
    });
    expect(result.kind).toBe('fallback');
    if (result.kind === 'fallback') {
      // Only the exempt task head rides in the replay verbatim; the
      // non-exempt u2 leaves the model view with the rest of the range.
      expect(result.replayMessages?.map((m) => m.id)).toEqual(['u1', result.summaryMessage!.id, 'u3']);
      expect(result.flaggedIds).toEqual(expect.arrayContaining(['u2', 'a1']));
      expect(result.flaggedIds).not.toContain('u1');
    }
  });
});
