/**
 * answer_subagent tool — answers or declines a subagent's pending question.
 *
 * Params: subagent_id plus exactly one of `answers` or `decline`.
 * Resolves the subagent's pending question so its paused turn can continue.
 * Use after wait_for_subagent returns a subagent with a pending question.
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome } from '../result';
import type { SubagentManager, SubagentQuestionResult } from '../../agents/manager';
import type { SubagentToolResult } from './delegate';

/**
 * Build the answer_subagent tool.
 *
 * @param manager - SubagentManager instance for resolving subagent questions
 */
export function buildAnswerSubagentTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'answer_subagent',
    description:
      "Answer or decline a subagent's pending question. " +
      'Use after wait_for_subagent returns with a pending question.',
    inputSchema: z.object({
      subagent_id: z.string().describe('The subagent ID to answer.'),
      answers: z
        .array(
          z.object({
            selected: z.array(z.string()),
            text: z.string().nullable(),
            skipped: z.boolean(),
          }),
        )
        .optional()
        .describe('Answers to the subagent questions. Provide this OR decline, not both.'),
      decline: z
        .boolean()
        .optional()
        .describe('Decline to answer. The subagent receives a declined status.'),
    }),
    actionLabel: 'Answering subagent...',
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown): Promise<SubagentToolResult> => {
    const { subagent_id, answers, decline } = input as {
      subagent_id: string;
      answers?: Array<{ selected: string[]; text: string | null; skipped: boolean }>;
      decline?: boolean;
    };

    const hasAnswers = answers !== undefined;
    const hasDecline = decline !== undefined;
    if (hasAnswers === hasDecline) {
      return genericBuiltInToolOutcome(
        'answer_subagent',
        'Error: provide exactly one of "answers" or "decline".',
        'error',
      );
    }

    const result: SubagentQuestionResult = hasAnswers
      ? { type: 'answered', answers: answers! }
      : { type: 'declined' };

    const resolved = manager.answerSubagentQuestion(subagent_id, result);
    if (!resolved) {
      return genericBuiltInToolOutcome(
        'answer_subagent',
        `Error: subagent '${subagent_id}' has no pending question.`,
        'error',
      );
    }

    return genericBuiltInToolOutcome(
      'answer_subagent',
      { subagent_id, status: hasAnswers ? 'answered' : 'declined' },
      'complete',
    );
  };

  return { definition, handler };
}
