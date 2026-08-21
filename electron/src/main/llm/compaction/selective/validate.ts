/**
 * U13: Selective validator and auto-corrector
 *
 * Requirements R8,R9,R24. Dependencies U12.
 *
 * Checks: op ids are subsequence of manifest order; every EXEMPT user message
 * present (R9, scoped via exemptIds);
 * tool_call/result pairing intact (reuse reconcileOrphanToolResults + survival pre-pass);
 * ranged keeps within bounds; summarized spans contiguous; thinking kept verbatim or dropped,
 * never summarized. Auto-correct: drop dangling refs, clamp ranges, sort to manifest order.
 * Semantic errors (missing user messages, un-inferable broken pairs) -> return error for re-prompt.
 * Must enforce R24: thinking never summarized.
 */

import type { Message } from '../../../../shared/types/message';
import { MessageType, MessageRole } from '../../../../shared/types/message';
import type { Manifest, SelectiveOp, SummarizeOp } from './manifest';
import { isSubstantiveHandoffText } from '../message-chars';
import { SELECTIVE_TRANSCRIPT_SEPARATOR, selectiveTranscriptChars } from './transcript';

/**
 * Minimum source chars a summarize span must cover before its text is held
 * to the full handoff-substance rule (isSubstantiveHandoffText). Spans that
 * replace substantial content must carry a real handoff — a one-line
 * activity log ("assistant read some files") silently destroys findings the
 * continuation needs. Tiny spans keep the non-empty rule only: forcing 200+
 * chars out of a 50-char span wastes correction rounds for nothing.
 */
export const SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS = 1000;

export interface ValidateResult {
  readonly valid: boolean;
  readonly correctedOps: SelectiveOp[];
  readonly errors: string[];
  readonly mechanicalCorrections: string[];
}

// Helper to get line count for a message's content
function lineCountForMessage(msg: Message): number {
  const content = msg.content ?? '';
  if (content.length === 0) return 1;
  return content.split('\n').length;
}

/**
 * R9/R31: user ids the keep-verbatim rule protects under a scoped exempt set.
 * `exemptIds` omitted/undefined → EVERY user message (backcompat universal
 * protection); provided → only the exempt ids present as user messages. User
 * ids outside the set follow normal compaction semantics (flaggable,
 * summarizable). Apply-side counterpart: scopedExemptUserIds in apply.ts.
 */
export function scopedExemptUserIds(
  messages: readonly Message[],
  exemptIds?: ReadonlySet<string> | readonly string[],
): Set<string> {
  const exempt = exemptIds ? (exemptIds instanceof Set ? exemptIds : new Set(exemptIds)) : null;
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.role !== MessageRole.USER) continue;
    if (!exempt || exempt.has(m.id)) ids.add(m.id);
  }
  return ids;
}

function findOpForId(ops: readonly SelectiveOp[], id: string): SelectiveOp | undefined {
  for (const op of ops) {
    if (op.type === 'keep' && op.id === id) return op;
    if (op.type === 'keep_range' && op.id === id) return op;
    if (op.type === 'drop' && op.id === id) return op;
    if (op.type === 'summarize' && (op.ids as readonly string[]).includes(id)) return op;
  }
  return undefined;
}

function summarizeOpContainingId(ops: readonly SelectiveOp[], id: string): SummarizeOp | undefined {
  for (const op of ops) {
    if (op.type === 'summarize' && (op.ids as readonly string[]).includes(id)) return op as SummarizeOp;
  }
  return undefined;
}

/**
 * Validate and auto-correct an op list.
 *
 * Steps:
 * - Drop dangling refs (ids not in manifest) — mechanical
 * - Clamp ranged keeps — mechanical
 * - Reject summarized thinking (R24) — semantic
 * - Sort to manifest order — mechanical
 * - Check summarized spans contiguous — semantic
 * - Check exempt user messages kept verbatim (R9, scoped via `exemptIds`) — semantic
 * - Check every exempt user message present — semantic
 * - Check tool_call/result pairing intact — semantic (un-inferable broken pairs)
 *
 * `exemptIds` (`resolveUserExemptIds` output) scopes R9's keep-verbatim rule to
 * the exempt user ids; non-exempt user ids may be summarized like any other
 * entry. Omitted → every user message is protected (backcompat default).
 *
 * Returns {valid, correctedOps, errors, mechanicalCorrections}
 */
export function validateSelectiveOps(
  ops: readonly SelectiveOp[],
  manifest: Manifest,
  messages: readonly Message[],
  exemptIds?: ReadonlySet<string> | readonly string[],
): ValidateResult {
  const errors: string[] = [];
  const mechanicalCorrections: string[] = [];

  // Build helpers
  const manifestById = manifest.byId;
  const manifestPos = new Map<string, number>();
  for (const e of manifest.entries) manifestPos.set(e.id, e.index);

  // Quick message by id
  const msgById = new Map<string, Message>();
  for (const m of messages) msgById.set(m.id, m);

  // R9 keep-verbatim protection set (scoped via exemptIds; universal when omitted)
  const protectedUsers = scopedExemptUserIds(messages, exemptIds);

  // ── Step A: drop dangling refs ──────────────────────────────────────────────
  const opsAfterDangling: SelectiveOp[] = [];
  for (const op of ops) {
    if (op.type === 'keep') {
      if (!manifestById.has(op.id)) {
        mechanicalCorrections.push(`dangling keep id ${op.id} dropped`);
        continue;
      }
      opsAfterDangling.push(op);
    } else if (op.type === 'keep_range') {
      if (!manifestById.has(op.id)) {
        mechanicalCorrections.push(`dangling keep_range id ${op.id} dropped`);
        continue;
      }
      opsAfterDangling.push(op);
    } else if (op.type === 'drop') {
      if (!manifestById.has(op.id)) {
        mechanicalCorrections.push(`dangling drop id ${op.id} dropped`);
        continue;
      }
      opsAfterDangling.push(op);
    } else {
      // summarize
      const filtered = (op.ids as readonly string[]).filter((id) => manifestById.has(id));
      const dropped = (op.ids as readonly string[]).filter((id) => !manifestById.has(id));
      if (dropped.length > 0) {
        mechanicalCorrections.push(`summarize dropped dangling refs: ${dropped.join(', ')}`);
      }
      if (filtered.length === 0) {
        mechanicalCorrections.push(`summarize with all dangling refs dropped — op removed`);
        continue;
      }
      if (filtered.length !== op.ids.length) {
        opsAfterDangling.push({ type: 'summarize', ids: filtered, text: op.text });
      } else {
        opsAfterDangling.push(op);
      }
    }
  }

  // ── Step B: clamp ranged keeps ────────────────────────────────────────────
  const opsAfterClamp: SelectiveOp[] = [];
  for (const op of opsAfterDangling) {
    if (op.type !== 'keep_range') {
      opsAfterClamp.push(op);
      continue;
    }
    const msg = msgById.get(op.id);
    const totalLines = msg ? lineCountForMessage(msg) : 1;
    let start = Math.floor(op.startLine);
    let end = Math.floor(op.endLine);
    let changed = false;
    const origStart = start;
    const origEnd = end;
    if (!Number.isFinite(start) || start < 1) {
      start = 1;
      changed = true;
    }
    if (!Number.isFinite(end) || end < 1) {
      end = 1;
      changed = true;
    }
    if (start > totalLines) {
      start = totalLines;
      changed = true;
    }
    if (end > totalLines) {
      end = totalLines;
      changed = true;
    }
    if (start > end) {
      // swap to make valid range
      const tmp = start;
      start = end;
      end = tmp;
      changed = true;
    }
    if (changed) {
      mechanicalCorrections.push(
        `keep_range ${op.id} clamped ${origStart}-${origEnd} → ${start}-${end} (total ${totalLines})`,
      );
    }
    // Also reject keep_range on thinking? Treat as mechanical -> convert to keep
    const entry = manifestById.get(op.id);
    if (entry && entry.type === MessageType.THINKING) {
      errors.push(`keep_range on thinking message ${op.id} is not allowed (R24: thinking kept verbatim or dropped)`);
      // Keep as keep for correctedOps to avoid further mechanical confusion, but still error
      opsAfterClamp.push({ type: 'keep', id: op.id });
      mechanicalCorrections.push(`keep_range on thinking ${op.id} converted to keep`);
      continue;
    }
    // Also reject keep_range on a protected user entry — R9's verbatim rule is
    // scoped to the exempt set; non-exempt user messages are compactable and
    // may be ranged-kept like any other entry.
    if (entry && protectedUsers.has(op.id)) {
      errors.push(`keep_range on user message ${op.id} is not allowed (R9: user kept verbatim)`);
      opsAfterClamp.push({ type: 'keep', id: op.id });
      mechanicalCorrections.push(`keep_range on user ${op.id} converted to keep`);
      continue;
    }
    if (changed) {
      opsAfterClamp.push({ type: 'keep_range', id: op.id, startLine: start, endLine: end });
    } else {
      opsAfterClamp.push(op);
    }
  }

  // ── Step B2: drop only for thinking (R24) ───────────────────────────────────
  for (const op of opsAfterClamp) {
    if (op.type === 'drop') {
      const entry = manifestById.get(op.id);
      const msg = msgById.get(op.id);
      const isThinking = (entry && entry.type === MessageType.THINKING) || (msg && msg.type === MessageType.THINKING);
      if (!isThinking) {
        errors.push(`drop on non-thinking message ${op.id} is not allowed (R24: only thinking may be dropped)`);
      }
    }
  }

  // ── Step C: thinking never summarized (R24) ───────────────────────────────
  for (const op of opsAfterClamp) {
    if (op.type === 'summarize') {
      for (const id of op.ids as readonly string[]) {
        const entry = manifestById.get(id);
        if (entry && entry.type === MessageType.THINKING) {
          errors.push(`thinking message ${id} cannot be summarized (R24: thinking never summarized)`);
        }
        // Also check role? THINKING type is canonical
        const msg = msgById.get(id);
        if (msg && msg.type === MessageType.THINKING) {
          // ensure error already pushed if not via entry
          if (!entry || entry.type !== MessageType.THINKING) {
            // still error if message is thinking but entry kind mismatched
            if (!errors.some((e) => e.includes(id))) {
              errors.push(`thinking message ${id} cannot be summarized (R24)`);
            }
          }
        }
      }
    }
  }

  // ── Step D: deduplicate ids across ops & handle duplicates ────────────────
  // Ensure each manifest id appears in at most one op. Cross-op duplicates are
  // a SEMANTIC error (exact-once coverage): two different treatments for one
  // message are ambiguous, so the op list is rejected for re-prompting rather
  // than silently resolved first-wins. The corrected list still keeps the
  // first occurrence so downstream mechanical steps stay well-formed.
  const seen = new Set<string>();
  const opsAfterDedup: SelectiveOp[] = [];
  for (const op of opsAfterClamp) {
    if (op.type === 'keep' || op.type === 'keep_range' || op.type === 'drop') {
      if (seen.has(op.id)) {
        errors.push(`duplicate id ${op.id} across ops violates exact-once coverage (first occurrence kept)`);
        continue;
      }
      seen.add(op.id);
      opsAfterDedup.push(op);
    } else {
      // summarize: filter ids to remove duplicates already seen
      const unique: string[] = [];
      const dupInOp = new Set<string>();
      for (const id of op.ids as readonly string[]) {
        if (dupInOp.has(id)) {
          mechanicalCorrections.push(`duplicate id ${id} inside summarize op removed`);
          continue;
        }
        dupInOp.add(id);
        if (seen.has(id)) {
          errors.push(`duplicate id ${id} across ops violates exact-once coverage (first occurrence kept)`);
          continue;
        }
        seen.add(id);
        unique.push(id);
      }
      if (unique.length === 0) {
        mechanicalCorrections.push(`summarize became empty after dedup — op removed`);
        continue;
      }
      // Sort ids inside summarize to manifest order (mechanical)
      const sorted = [...unique].sort((a, b) => (manifestPos.get(a) ?? 9999) - (manifestPos.get(b) ?? 9999));
      const orderChanged = sorted.some((id, i) => id !== unique[i]);
      if (orderChanged) {
        mechanicalCorrections.push(`summarize ids reordered to manifest order: ${unique.join(',')} → ${sorted.join(',')}`);
      }
      if (sorted.length !== op.ids.length || orderChanged) {
        opsAfterDedup.push({ type: 'summarize', ids: sorted, text: op.text });
      } else {
        opsAfterDedup.push(op);
      }
    }
  }

  // ── Step E: sort ops to manifest order ────────────────────────────────────
  const opsWithKey = opsAfterDedup.map((op) => {
    let key: number;
    if (op.type === 'keep' || op.type === 'keep_range' || op.type === 'drop') key = manifestPos.get(op.id) ?? 9999;
    else {
      const ids = op.ids as readonly string[];
      key = Math.min(...ids.map((id) => manifestPos.get(id) ?? 9999));
    }
    return { op, key };
  });
  const sortedOps = [...opsWithKey].sort((a, b) => a.key - b.key).map((x) => x.op);
  const orderChanged = sortedOps.some((op, i) => op !== opsAfterDedup[i]);
  // More robust: check ids sequence
  let needsSort = false;
  for (let i = 1; i < opsWithKey.length; i += 1) {
    if (opsWithKey[i]!.key < opsWithKey[i - 1]!.key) {
      needsSort = true;
      break;
    }
  }
  if (needsSort || orderChanged) {
    // Only record if actually out of order
    const beforeKeys = opsAfterDedup.map((op) => {
      if (op.type === 'keep' || op.type === 'keep_range' || op.type === 'drop') return op.id;
      return `summarize[${(op.ids as readonly string[]).join(',')}]`;
    });
    const afterKeys = sortedOps.map((op) => {
      if (op.type === 'keep' || op.type === 'keep_range' || op.type === 'drop') return op.id;
      return `summarize[${(op.ids as readonly string[]).join(',')}]`;
    });
    if (beforeKeys.join('|') !== afterKeys.join('|')) {
      mechanicalCorrections.push(`ops reordered to manifest order: ${beforeKeys.join(' → ')} → ${afterKeys.join(' → ')}`);
    }
  }
  const opsSorted = needsSort ? sortedOps : opsAfterDedup;

  // ── Step F: summarized spans contiguous ────────────────────────────────────
  // Drop ops do not count as coverage: a dropped thinking entry inside a span
  // gap is removed entirely (R24), so summarizing across it stays contiguous.
  // Kept or summarized entries in a gap DO break contiguity — the summary would
  // skip material that survives in replay.
  const coveredPositions = new Set<number>();
  for (const op of opsSorted) {
    if (op.type === 'drop') continue;
    const ids = op.type === 'summarize' ? (op.ids as readonly string[]) : [op.id];
    for (const id of ids) {
      const pos = manifestPos.get(id);
      if (pos !== undefined) coveredPositions.add(pos);
    }
  }
  for (const op of opsSorted) {
    if (op.type !== 'summarize') continue;
    const ids = op.ids as readonly string[];
    const positions = ids.map((id) => manifestPos.get(id) ?? -1).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i += 1) {
      let gapViolates = false;
      for (let p = positions[i - 1]! + 1; p < positions[i]!; p += 1) {
        if (coveredPositions.has(p)) { gapViolates = true; break; }
        const entry = manifest.entries[p];
        if (!entry || entry.type !== MessageType.THINKING) { gapViolates = true; break; }
      }
      if (gapViolates) {
        errors.push(
          `summarize span not contiguous: ids ${ids.join(',')} map to positions ${positions.join(',')} (gap at ${positions[i - 1]}→${positions[i]})`,
        );
        break;
      }
    }
    // Also check text non-empty / substantive
    if (!op.text || op.text.trim().length === 0) {
      errors.push(`summarize op for ids ${ids.join(',')} has empty text`);
    } else {
      // Measure the serialized transcript fields the compactor reads for the
      // span (content, tool names/arguments, tool_call_id, thinking) — content
      // alone under-counts spans of small tool calls under the substance floor.
      // formatSelectiveConversation joins the selected entries with "\n\n"
      // separators (none before the first entry), so the separators count too.
      const spanSourceChars = ids.reduce((sum, id) => {
        const msg = msgById.get(id);
        return sum + (msg ? selectiveTranscriptChars(msg) : 0);
      }, 0) + SELECTIVE_TRANSCRIPT_SEPARATOR.length * Math.max(0, ids.length - 1);
      if (spanSourceChars >= SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS && !isSubstantiveHandoffText(op.text)) {
        errors.push(
          `summarize op for ids ${ids.join(',')} replaces ${spanSourceChars} chars of source content but its text is not a substantive handoff ` +
          `(${op.text.trim().length} chars) — rewrite it as a continuation handoff carrying goals, decisions, exact file paths, key findings, errors, and the next step, ` +
          `not an activity log`,
        );
      }
    }
  }

  // ── Step F2: exempt user messages must be kept verbatim (R9/R31) ─────────
  // Summarize covering an EXEMPT user id is rejected — only those ids are held
  // to the keep-verbatim rule; user ids outside the scoped set may be
  // summarized like any other compactable entry.
  for (const op of opsSorted) {
    if (op.type !== 'summarize') continue;
    for (const id of op.ids as readonly string[]) {
      if (!protectedUsers.has(id)) continue;
      errors.push(`exempt user message ${id} must be kept verbatim (R9: summarize covering user ids rejected)`);
    }
  }

  // ── Step G: every exempt user message present ────────────────────────────
  for (const entry of manifest.entries) {
    if (!protectedUsers.has(entry.id)) continue;
    if (!findOpForId(opsSorted, entry.id)) {
      errors.push(`exempt user message ${entry.id} missing from ops (R9: user messages must be kept verbatim)`);
    }
  }

  // ── Step H: tool_call/result pairing intact ───────────────────────────────
  // Build callMap and resultMap
  const callMap = new Map<string, { callMessageId: string }>(); // tcId -> callMsgId
  const resultMap = new Map<string, string>(); // tcId -> resultMsgId
  for (const msg of messages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls as readonly { id: string }[]) {
        if (tc.id && !callMap.has(tc.id)) callMap.set(tc.id, { callMessageId: msg.id });
      }
    }
    if (msg.role === MessageRole.TOOL && msg.tool_call_id) {
      if (!resultMap.has(msg.tool_call_id)) resultMap.set(msg.tool_call_id, msg.id);
    }
  }
  // For each tc where both sides in manifest, check they are treated consistently
  const allTcIds = new Set<string>([...callMap.keys(), ...resultMap.keys()]);
  for (const tcId of allTcIds) {
    const callEntry = callMap.get(tcId);
    const resultId = resultMap.get(tcId);
    const callMsgId = callEntry?.callMessageId;
    const resultMsgId = resultId;
    const callInManifest = callMsgId ? manifestById.has(callMsgId) : false;
    const resultInManifest = resultMsgId ? manifestById.has(resultMsgId) : false;
    if (!callInManifest && !resultInManifest) continue;
    // If only one side in manifest, pairing check is not required (other side in preserve window)
    // Still, if the manifest side is kept and counterpart is outside manifest but not present in replay?
    // For safety, only enforce when both are in manifest.
    if (callInManifest && resultInManifest) {
      const callOp = callMsgId ? findOpForId(opsSorted, callMsgId) : undefined;
      const resultOp = resultMsgId ? findOpForId(opsSorted, resultMsgId) : undefined;
      const callPresent = Boolean(callOp);
      const resultPresent = Boolean(resultOp);
      if (!callPresent && !resultPresent) {
        // Both dropped -> not error (both flagged), but if either is user? not. So skip.
        continue;
      }
      if (callPresent !== resultPresent) {
        errors.push(
          `tool pair ${tcId} broken: call ${callMsgId} ${callPresent ? 'present' : 'missing'} vs result ${resultMsgId} ${resultPresent ? 'present' : 'missing'}`,
        );
        continue;
      }
      // Both present — check they are in same treatment
      // If both summarized, they must be in same summarize op
      if (callOp && resultOp && callOp.type === 'summarize' && resultOp.type === 'summarize') {
        // Need to ensure same op instance (by identity of ids list)
        const callSummarize = summarizeOpContainingId(opsSorted, callMsgId!);
        const resultSummarize = summarizeOpContainingId(opsSorted, resultMsgId!);
        if (callSummarize !== resultSummarize) {
          errors.push(
            `tool pair ${tcId} split across different summarize ops: call ${callMsgId} and result ${resultMsgId} must be in same summarize`,
          );
        }
      } else if (
        (callOp?.type === 'summarize' && resultOp?.type !== 'summarize') ||
        (resultOp?.type === 'summarize' && callOp?.type !== 'summarize')
      ) {
        errors.push(
          `tool pair ${tcId} mixed keep/summarize: call ${callMsgId} (${callOp?.type}) vs result ${resultMsgId} (${resultOp?.type})`,
        );
      }
      // Both kept (keep or keep_range) is ok
    }
  }

  // Additional check: dangling tool_call without result in full history before compaction?
  // Not needed; original history already pairing-checked via select.ts cut.

  const valid = errors.length === 0;
  return {
    valid,
    correctedOps: opsSorted,
    errors,
    mechanicalCorrections,
  };
}
