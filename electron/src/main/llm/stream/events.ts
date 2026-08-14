import type { ToolExecutionResult } from '../../../shared/types/tool-result';
import type { ThinkingReplayPayload, Usage } from '../../../shared/types/message';

/** Events yielded by the LLM stream orchestrator. */
export type StreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'content'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string }
  | { type: 'tool_call_delta'; toolCallId: string; argsDelta: string }
  | {
      type: 'tool_result';
      toolCallId: string;
      content: string;
      /** Raw canonical execution retained by Orchid; U3 transports it durably. */
      execution: ToolExecutionResult;
    }
  | { type: 'usage'; usage: Usage }
  /**
   * One reasoning sequence's replay artifact, emitted when the sequence closes
   * (signatures/encrypted content are only complete at that point). `hasText`
   * is true when the sequence streamed displayable thinking text — the payload
   * then belongs to the thinking text accumulated so far; otherwise it becomes
   * its own text-less THINKING message (redacted/opaque blocks).
   */
  | { type: 'thinking_artifact'; payload: ThinkingReplayPayload; hasText: boolean }
  | { type: 'error'; title: string; detail: string }
  | { type: 'step_finish'; stepIndex: number; finishReason: string }
  | { type: 'finish'; finishReason: string };
