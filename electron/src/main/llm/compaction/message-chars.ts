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
