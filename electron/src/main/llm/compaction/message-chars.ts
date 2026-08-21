import type { Message } from '../../../shared/types/message';

export function estimateMessageChars(msg: Message): number {
  let n = 0;
  if (msg.content) n += msg.content.length;
  if (msg.thinking) n += msg.thinking.length;
  if (msg.tool_calls) n += JSON.stringify(msg.tool_calls).length;
  if (msg.tool_result) n += JSON.stringify(msg.tool_result).length;
  if (msg.tool_call_id) n += msg.tool_call_id.length;
  if (msg.name) n += msg.name.length;
  if ((msg as unknown as { compacted?: unknown }).compacted) {
    n += JSON.stringify((msg as unknown as { compacted: unknown }).compacted).length;
  }
  return n === 0 ? 1 : n;
}

export function totalCharsForMessages(messages: readonly Message[]): number {
  let sum = 0;
  for (const m of messages) sum += estimateMessageChars(m);
  return sum === 0 ? 1 : sum;
}

// ── Handoff substance guard ──────────────────────────────────────────────────

/**
 * Minimum characters a handoff summary must carry to be applied.
 *
 * Compaction only fires when the compactable range clears
 * `min_compactable_tokens` (thousands of tokens by default), so a faithful
 * handoff is never near this floor. Degenerate outputs — a model that spends
 * its whole output budget inside a stripped `<analysis>` block and ends with
 * `...`, or a truncation tail — must be refused, not applied: a summary head
 * with no substance silently removes the range (including its user messages)
 * from the model view and the next step loses the task.
 */
export const MIN_HANDOFF_SUMMARY_CHARS = 200;

/**
 * Whether extracted summarizer text carries enough substance to replace a
 * compactable range in the model view. Pure so every compaction seam (simple
 * summarizer, selective fallback, per-op selective validation) can share the
 * exact same rule.
 */
export function isSubstantiveHandoffText(text: string): boolean {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length < MIN_HANDOFF_SUMMARY_CHARS) return false;
  // Punctuation shells (ellipses, dashes, markdown fences) carry no handoff.
  const alphanumeric = collapsed.replace(/[^\p{L}\p{N}]/gu, '');
  return alphanumeric.length >= Math.floor(MIN_HANDOFF_SUMMARY_CHARS / 4);
}
