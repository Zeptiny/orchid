/**
 * AskQuestionOverlay — interactive stepper shown in place of the composer
 * while an ask_question tool call awaits the user.
 *
 * One question at a time: single-choice (radio-style) or multi-choice
 * (checkbox-style) options, an optional free-text note, Back/Skip/Next
 * navigation, and a persistent Cancel that aborts the pending tool call.
 */
import type { UseAskQuestionReturn } from '../hooks/useAskQuestion';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';

export interface AskQuestionOverlayProps {
  /** Stepper state + actions from useAskQuestion. */
  question: UseAskQuestionReturn;
}

export function AskQuestionOverlay({ question }: AskQuestionOverlayProps) {
  const { active } = question;
  if (!active) return null;

  const current = active.questions[active.currentIndex];
  const answer = active.answers[active.currentIndex];
  if (!current || !answer) return null;

  const isFirst = active.currentIndex === 0;
  const isLast = active.currentIndex === active.questions.length - 1;
  const isMulti = current.type === 'multi';

  return (
    <section className="orchid-ask" aria-label="Agent question">
      <header className="orchid-ask-header">
        <span className="orchid-ask-eyebrow">
          <Icon name="messageSquare" size={12} />
          <span>Agent question</span>
        </span>
        <span className="orchid-ask-count">
          Question {active.currentIndex + 1} of {active.questions.length}
        </span>
        <Button
          variant="ghost"
          size="xs"
          icon="x"
          className="orchid-ask-cancel"
          onClick={() => {
            void question.cancelAll();
          }}
        >
          Cancel
        </Button>
      </header>

      <div className="orchid-ask-progress" aria-hidden>
        {active.questions.map((item, index) => (
          <span
            key={`${item.title}:${index}`}
            className={`orchid-ask-progress-segment ${
              index < active.currentIndex
                ? 'orchid-ask-progress-done'
                : index === active.currentIndex
                  ? 'orchid-ask-progress-current'
                  : ''
            }`.trim()}
          />
        ))}
      </div>

      <div className="orchid-ask-body" key={active.currentIndex}>
        <div className="orchid-ask-heading">
          <h3 className="orchid-ask-title">{current.title}</h3>
          {answer.skipped && (
            <StatusBadge tone="ghost" size="xs">Skipped</StatusBadge>
          )}
        </div>
        {current.description && (
          <p className="orchid-ask-description">{current.description}</p>
        )}

        <div
          className="orchid-ask-options"
          role={isMulti ? 'group' : 'radiogroup'}
          aria-label={current.title}
        >
          {current.options.map((option) => {
            const selected = answer.selected.includes(option.label);
            return (
              <button
                key={option.label}
                type="button"
                role={isMulti ? 'checkbox' : 'radio'}
                aria-checked={selected}
                className={`orchid-ask-option ${selected ? 'orchid-ask-option-selected' : ''}`.trim()}
                onClick={() => question.selectOption(active.currentIndex, option.label)}
              >
                <span
                  className={`orchid-ask-option-indicator ${
                    isMulti
                      ? 'orchid-ask-option-indicator-multi'
                      : 'orchid-ask-option-indicator-single'
                  }`}
                  aria-hidden
                >
                  {isMulti && selected && <Icon name="check" size={10} />}
                </span>
                <span className="orchid-ask-option-text">
                  <span className="orchid-ask-option-label">{option.label}</span>
                  {option.description && (
                    <span className="orchid-ask-option-hint">{option.description}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        <label className="orchid-ask-note">
          <span className="orchid-ask-note-label">Additional thoughts (optional)</span>
          <textarea
            className="orchid-ask-note-input"
            value={answer.text}
            onChange={(event) => question.setText(active.currentIndex, event.target.value)}
            rows={2}
          />
        </label>
      </div>

      <footer className="orchid-ask-nav">
        <div className="orchid-ask-nav-start">
          <Button
            variant="ghost"
            size="sm"
            icon="arrowLeft"
            disabled={isFirst}
            onClick={question.back}
          >
            Back
          </Button>
          <Button variant="ghost" size="sm" onClick={question.skip}>
            Skip
          </Button>
        </div>
        {isLast ? (
          <Button
            variant="primary"
            size="sm"
            iconRight="check"
            onClick={() => {
              void question.submit();
            }}
          >
            Submit
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            iconRight="arrowRight"
            onClick={question.next}
          >
            Next
          </Button>
        )}
      </footer>
    </section>
  );
}
