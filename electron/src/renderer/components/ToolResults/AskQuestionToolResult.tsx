import { z } from 'zod';
import {
  genericToolResultDataSchema,
  type CanonicalToolResult,
} from '../../../shared/types/tool-result';
import { StatusBadge } from '../ui/StatusBadge';
import { GenericToolResult } from './GenericToolResult';

export interface AskQuestionToolResultProps {
  canonical: CanonicalToolResult;
}

const askQuestionAnswerSchema = z.object({
  selected: z.array(z.string()),
  text: z.string().nullable(),
  skipped: z.boolean(),
});

const askQuestionQuestionSchema = z.object({
  type: z.enum(['single', 'multi']),
  title: z.string(),
  description: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })),
});

const askQuestionValueSchema = z.object({
  questions: z.array(askQuestionQuestionSchema).optional(),
  answers: z.array(askQuestionAnswerSchema),
  cancelled: z.boolean().optional(),
}).passthrough();

/** Non-interactive history summary of a completed ask_question tool call. */
export function AskQuestionToolResult({ canonical }: AskQuestionToolResultProps) {
  const outer = genericToolResultDataSchema.safeParse(canonical.data);
  if (!outer.success) {
    return <GenericToolResult canonical={canonical} />;
  }
  const parsed = askQuestionValueSchema.safeParse(outer.data.value);
  if (!parsed.success) {
    return <GenericToolResult canonical={canonical} />;
  }

  const { questions, answers, cancelled } = parsed.data;

  if (cancelled || canonical.status === 'cancelled') {
    return (
      <div className="orchid-ask-result" data-result-family="generic">
        <div className="orchid-ask-result-cancelled">
          <StatusBadge tone="warning" size="xs">Cancelled</StatusBadge>
          <span>Question was cancelled before it was answered.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="orchid-ask-result" data-result-family="generic">
      {answers.map((answer, index) => (
        <section key={index} className="orchid-ask-result-item">
          <header className="orchid-ask-result-item-header">
            <span className="orchid-ask-result-item-title">
              {questions?.[index]?.title ?? `Question ${index + 1}`}
            </span>
            {answer.skipped && (
              <StatusBadge tone="ghost" size="xs">Skipped</StatusBadge>
            )}
          </header>
          {answer.selected.length > 0 && (
            <div className="orchid-ask-result-chips">
              {answer.selected.map((label) => (
                <span key={label} className="orchid-ask-result-chip">{label}</span>
              ))}
            </div>
          )}
          {answer.text && (
            <blockquote className="orchid-ask-result-text">{answer.text}</blockquote>
          )}
          {answer.skipped && answer.selected.length === 0 && !answer.text && (
            <span className="orchid-ask-result-empty">No answer provided</span>
          )}
        </section>
      ))}
    </div>
  );
}
