/**
 * Model-visible transcript serialization for selective compaction.
 *
 * Single source of truth for the per-message transcript line the compactor
 * reads (formatSelectiveConversation in run.ts) and the validator's span-size
 * measure (spanSourceChars in validate.ts): spanSourceChars must count exactly
 * the fields the compactor actually sees — measuring Message.content alone
 * under-counts spans of small tool calls (tool names/arguments, tool_call_id,
 * thinking), which could slip a substantive span under
 * SUBSTANTIVE_SPAN_MIN_SOURCE_CHARS and skip the handoff-substance rule.
 */

import type { Message } from '../../../../shared/types/message';
import { escapeXml } from '../summarize';

/** Separator `formatSelectiveConversation` joins transcript lines with. */
export const SELECTIVE_TRANSCRIPT_SEPARATOR = '\n\n';

/** Header for one transcript entry (`[id=… role (type)]`). */
function transcriptHeader(msg: Message): string {
  const typeSuffix = msg.type !== 'text' ? ` (${msg.type})` : '';
  return `[id=${msg.id} ${msg.role}${typeSuffix}]`;
}

/** Transcript body for one entry: content, tool_calls, tool_call_id, thinking — nothing else. */
export function selectiveTranscriptBody(msg: Message): string {
  let body = msg.content ?? '';
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const calls = msg.tool_calls
      .map((tc) => `${tc.function.name}(${tc.function.arguments}) [id=${tc.id}]`)
      .join(', ');
    body = body ? `${body}\n  tool_calls: ${calls}` : `tool_calls: ${calls}`;
  }
  if (msg.tool_call_id) {
    body = body ? `${body}\n  tool_call_id: ${msg.tool_call_id}` : `tool_call_id: ${msg.tool_call_id}`;
  }
  if (msg.thinking) {
    body = body ? `${body}\n  thinking: ${msg.thinking}` : `thinking: ${msg.thinking}`;
  }
  return body;
}

/** One full transcript line (header + escaped body) — the exact unit formatSelectiveConversation joins. */
export function selectiveTranscriptLine(msg: Message): string {
  return `${transcriptHeader(msg)} ${escapeXml(selectiveTranscriptBody(msg))}`.trimEnd();
}

/** Serialized transcript size of one message — measures what the compactor reads for it. */
export function selectiveTranscriptChars(msg: Message): number {
  return selectiveTranscriptLine(msg).length;
}
