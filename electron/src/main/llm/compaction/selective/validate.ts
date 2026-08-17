/**
 * U13: Selective validator and auto-corrector
 *
 * Requirements R8,R9,R24. Dependencies U12.
 *
 * Checks: op ids are subsequence of manifest order; every user message present;
 * tool_call/result pairing intact (reuse reconcileOrphanToolResults + survival pre-pass);
 * ranged keeps within bounds; summarized spans contiguous; thinking kept verbatim or dropped,
 * never summarized. Auto-correct: drop dangling refs, clamp ranges, sort to manifest order.
 * Semantic errors (missing user messages, un-inferable broken pairs) -> return error for re-prompt.
 * Must enforce R24: thinking never summarized.
 */

import type { Message } from '../../../../shared/types/message';
import { MessageType, MessageRole } from '../../../../shared/types/message';
import type { Manifest, SelectiveOp, KeepOp, KeepRangeOp, SummarizeOp } from './manifest';

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

function findOpForId(ops: readonly SelectiveOp[], id: string): SelectiveOp | undefined {
  for (const op of ops) {
    if (op.type === 'keep' && op.id === id) return op;
    if (op.type === 'keep_range' && op.id === id) return op;
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
 * - Check every user message present — semantic
 * - Check tool_call/result pairing intact — semantic (un-inferable broken pairs)
 *
 * Returns {valid, correctedOps, errors, mechanicalCorrections}
 */
export function validateSelectiveOps(
  ops: readonly SelectiveOp[],
  manifest: Manifest,
  messages: readonly Message[],
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
    if (changed) {
      opsAfterClamp.push({ type: 'keep_range', id: op.id, startLine: start, endLine: end });
    } else {
      opsAfterClamp.push(op);
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
  // Ensure each manifest id appears in at most one op
  const seen = new Set<string>();
  const opsAfterDedup: SelectiveOp[] = [];
  for (const op of opsAfterClamp) {
    if (op.type === 'keep' || op.type === 'keep_range') {
      if (seen.has(op.id)) {
        mechanicalCorrections.push(`duplicate id ${op.id} dropped (keeping first occurrence)`);
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
          mechanicalCorrections.push(`duplicate id ${id} across ops dropped from later summarize`);
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
        // keep original sorted if identical
        if (sorted.length !== unique.length || sorted.some((v, i) => v !== unique[i])) {
          opsAfterDedup.push({ type: 'summarize', ids: sorted, text: op.text });
        } else {
          opsAfterDedup.push(op.type === 'summarize' && sorted !== (op.ids as unknown) ? { type: 'summarize', ids: sorted, text: op.text } : op);
          // Simplify: ensure corrected has sorted
          if (orderChanged) {
            opsAfterDedup[opsAfterDedup.length - 1] = { type: 'summarize', ids: sorted, text: op.text };
          }
        }
      }
    }
  }

  // ── Step E: sort ops to manifest order ────────────────────────────────────
  const opsWithKey = opsAfterDedup.map((op) => {
    let key: number;
    if (op.type === 'keep' || op.type === 'keep_range') key = manifestPos.get(op.id) ?? 9999;
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
      if (op.type === 'keep' || op.type === 'keep_range') return op.id;
      return `summarize[${(op.ids as readonly string[]).join(',')}]`;
    });
    const afterKeys = sortedOps.map((op) => {
      if (op.type === 'keep' || op.type === 'keep_range') return op.id;
      return `summarize[${(op.ids as readonly string[]).join(',')}]`;
    });
    if (beforeKeys.join('|') !== afterKeys.join('|')) {
      mechanicalCorrections.push(`ops reordered to manifest order: ${beforeKeys.join(' → ')} → ${afterKeys.join(' → ')}`);
    }
  }
  const opsSorted = needsSort ? sortedOps : opsAfterDedup;

  // ── Step F: summarized spans contiguous ────────────────────────────────────
  for (const op of opsSorted) {
    if (op.type !== 'summarize') continue;
    const ids = op.ids as readonly string[];
    const positions = ids.map((id) => manifestPos.get(id) ?? -1).sort((a, b) => a - b);
    for (let i = 1; i < positions.length; i += 1) {
      if (positions[i] !== positions[i - 1]! + 1) {
        errors.push(
          `summarize span not contiguous: ids ${ids.join(',')} map to positions ${positions.join(',')} (gap at ${positions[i - 1]}→${positions[i]})`,
        );
        break;
      }
    }
    // Also check text non-empty?
    if (!op.text || op.text.trim().length === 0) {
      errors.push(`summarize op for ids ${ids.join(',')} has empty text`);
    }
  }

  // ── Step G: every user message present ───────────────────────────────────
  for (const entry of manifest.entries) {
    if (entry.role === MessageRole.USER || entry.kind === 'user') {
      if (!findOpForId(opsSorted, entry.id)) {
        errors.push(`user message ${entry.id} missing from ops (R9: user messages must be kept verbatim)`);
      }
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
