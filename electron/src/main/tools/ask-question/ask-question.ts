/**
 * ask_question tool — pause the agent turn to ask the user interactive questions.
 *
 * The handler generates a unique question ID, registers a pending entry in the
 * QuestionStore, and awaits the user's response (delivered via IPC). The store's
 * EventEmitter bridges to the IPC layer which forwards to the renderer.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonValue } from '../../../shared/types/tool-result';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import { questionStore } from './store';

/** Result returned by the ask_question handler. */
export type AskQuestionToolResult = GenericBuiltInToolOutcome;

/** Build the ask_question tool definition and handler. */
export function buildAskQuestionTool(): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'ask_question',
    description:
      'Ask the user or the agent responsible for you one or more questionss.' +
      'Each question can be single-choice or multi-choice.' +
      'Use this tool if you need clarifications before doing your work / assigned task' +
      'You are paused from doing any more work until the question is answered' +
      'If declined, the result contains { status: "declined" } ' +
      '— continue with your best judgment rather than retrying.',
    inputSchema: z.object({
      questions: z.array(z.object({
        type: z.enum(['single', 'multi']),
        title: z.string().min(1),
        description: z.string().optional(),
        options: z.array(z.object({
          label: z.string(),
          description: z.string().optional(),
        })).min(1),
      })).min(1),
    }),
    actionLabel: 'Asking question...',
    category: 'ask_question',
    noTimeout: true,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<AskQuestionToolResult> => {
    const { questions } = input as { questions: JsonValue[] };
    const toolCallId = randomUUID();

    const result = await questionStore.create(
      toolCallId,
      ctx.sessionId ?? '',
      questions,
    );

    if (result.type === 'answered') {
      return genericBuiltInToolOutcome('ask_question', { questions, answers: result.answers }, 'complete');
    }
    return genericBuiltInToolOutcome('ask_question', { questions, answers: [], cancelled: true }, 'cancelled');
  };

  return { definition, handler };
}
