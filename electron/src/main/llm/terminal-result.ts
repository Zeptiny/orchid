import {
  createCanonicalToolResult,
  toolExecutionResultSchema,
  type ToolExecutionResult,
} from '../../shared/types/tool-result';
import { finalizeToolExecutionResult, genericAgentProjector } from '../tools/result';

/** Build a canonical terminal (error/cancelled) tool result that never ran a handler. */
export function genericTerminalExecution(
  toolCallId: string,
  toolName: string,
  status: 'error' | 'cancelled',
  message: string,
  code: string,
): ToolExecutionResult {
  const canonical = status === 'error'
    ? createCanonicalToolResult('generic', {
        status,
        data: {
          value: message,
          origin: { kind: 'built-in', name: toolName },
        },
        error: { code, message },
      })
    : createCanonicalToolResult('generic', {
        status,
        data: {
          value: message,
          origin: { kind: 'built-in', name: toolName },
        },
      });
  const execution = finalizeToolExecutionResult({
    canonical,
    toolName,
    toolCallId,
    expectedFamily: 'generic',
    projector: genericAgentProjector,
  });
  return toolExecutionResultSchema.parse(execution) as ToolExecutionResult;
}
