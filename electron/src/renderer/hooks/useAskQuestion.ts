/**
 * useAskQuestion — interactive ask_question stepper state.
 *
 * Subscribes to the `ask_question:asked` IPC event, holds the active question
 * set with per-question answer state, and exposes stepper actions. Submit and
 * cancel round-trip through the askQuestion bridge and clear the active state
 * so the overlay unmounts and the composer reappears.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskQuestionAskedEvent } from '../../shared/types/ipc';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Question {
  type: 'single' | 'multi';
  title: string;
  description?: string;
  options: Array<{ label: string; description?: string }>;
}

export interface AnswerState {
  selected: string[];
  text: string;
  skipped: boolean;
}

export interface ActiveQuestion {
  toolCallId: string;
  questions: Question[];
  currentIndex: number;
  answers: AnswerState[];
}

/** One answer serialized for the askQuestion.answer IPC payload. */
export interface AskQuestionSubmission {
  selected: string[];
  text: string | null;
  skipped: boolean;
}

export interface UseAskQuestionReturn {
  /** Active stepper state; null when no question is pending. */
  active: ActiveQuestion | null;
  /** Select an option: single-choice replaces, multi-choice toggles. */
  selectOption: (questionIndex: number, label: string) => void;
  /** Set the free-text note for a question. */
  setText: (questionIndex: number, text: string) => void;
  /** Advance to the next question (no-op on the last). */
  next: () => void;
  /** Return to the previous question (no-op on the first). */
  back: () => void;
  /** Mark the current question skipped and advance, or submit on the last. */
  skip: () => void;
  /** Send all answers through the askQuestion bridge and close the stepper. */
  submit: () => Promise<void>;
  /** Cancel the pending tool call and close the stepper. */
  cancelAll: () => Promise<void>;
}

// ── Pure state transitions ───────────────────────────────────────────────────

/** Build a fresh stepper state with one empty answer per question. */
export function createActiveQuestion(
  toolCallId: string,
  questions: Question[],
): ActiveQuestion {
  return {
    toolCallId,
    questions,
    currentIndex: 0,
    answers: questions.map(() => ({ selected: [], text: '', skipped: false })),
  };
}

function withAnswer(
  state: ActiveQuestion,
  questionIndex: number,
  answer: AnswerState,
): ActiveQuestion {
  const answers = state.answers.slice();
  answers[questionIndex] = answer;
  return { ...state, answers };
}

/** Apply an option click: single replaces the selection, multi toggles it. */
export function applyOptionSelection(
  state: ActiveQuestion,
  questionIndex: number,
  label: string,
): ActiveQuestion {
  const question = state.questions[questionIndex];
  const answer = state.answers[questionIndex];
  if (!question || !answer) return state;
  const selected =
    question.type === 'single'
      ? [label]
      : answer.selected.includes(label)
        ? answer.selected.filter((item) => item !== label)
        : [...answer.selected, label];
  return withAnswer(state, questionIndex, { ...answer, selected, skipped: false });
}

/** Set free text for a question (independent of option selections). */
export function applyText(
  state: ActiveQuestion,
  questionIndex: number,
  text: string,
): ActiveQuestion {
  const answer = state.answers[questionIndex];
  if (!answer) return state;
  return withAnswer(state, questionIndex, { ...answer, text, skipped: false });
}

/** Mark one question as skipped without touching its selections or text. */
export function markAnswerSkipped(
  state: ActiveQuestion,
  questionIndex: number,
): ActiveQuestion {
  const answer = state.answers[questionIndex];
  if (!answer) return state;
  return withAnswer(state, questionIndex, { ...answer, skipped: true });
}

/** Serialize answers for IPC: trimmed text, null when empty. */
export function buildSubmissions(state: ActiveQuestion): AskQuestionSubmission[] {
  return state.answers.map((answer) => {
    const text = answer.text.trim();
    return {
      selected: answer.selected,
      text: text ? text : null,
      skipped: answer.skipped,
    };
  });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useAskQuestion(): UseAskQuestionReturn {
  const [active, setActive] = useState<ActiveQuestion | null>(null);
  const activeRef = useRef<ActiveQuestion | null>(null);
  /** Guards against overlapping submit/cancel round-trips. */
  const busyRef = useRef(false);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const bridge = window.orchid?.askQuestion;
    if (!bridge) return;
    return bridge.onAsked((event: AskQuestionAskedEvent) => {
      if (!Array.isArray(event.questions) || event.questions.length === 0) return;
      setActive(createActiveQuestion(event.toolCallId, event.questions));
    });
  }, []);

  const update = useCallback((updater: (state: ActiveQuestion) => ActiveQuestion) => {
    setActive((prev) => (prev ? updater(prev) : prev));
  }, []);

  const selectOption = useCallback(
    (questionIndex: number, label: string) => {
      update((state) => applyOptionSelection(state, questionIndex, label));
    },
    [update],
  );

  const setText = useCallback(
    (questionIndex: number, text: string) => {
      update((state) => applyText(state, questionIndex, text));
    },
    [update],
  );

  const next = useCallback(() => {
    update((state) =>
      state.currentIndex < state.questions.length - 1
        ? { ...state, currentIndex: state.currentIndex + 1 }
        : state,
    );
  }, [update]);

  const back = useCallback(() => {
    update((state) =>
      state.currentIndex > 0
        ? { ...state, currentIndex: state.currentIndex - 1 }
        : state,
    );
  }, [update]);

  /** Clear the stepper only when the settled round-trip still owns it. */
  const release = useCallback((toolCallId: string) => {
    busyRef.current = false;
    setActive((prev) => (prev && prev.toolCallId === toolCallId ? null : prev));
  }, []);

  const sendAnswers = useCallback(
    async (state: ActiveQuestion) => {
      const bridge = window.orchid?.askQuestion;
      if (!bridge) {
        release(state.toolCallId);
        return;
      }
      busyRef.current = true;
      try {
        await bridge.answer({
          toolCallId: state.toolCallId,
          answers: buildSubmissions(state),
        });
      } catch {
        // The widget must release even when the bridge fails; main reports the
        // turn-level error through the normal chat error path.
      } finally {
        release(state.toolCallId);
      }
    },
    [release],
  );

  const submit = useCallback(async () => {
    const state = activeRef.current;
    if (!state || busyRef.current) return;
    await sendAnswers(state);
  }, [sendAnswers]);

  const skip = useCallback(() => {
    const state = activeRef.current;
    if (!state || busyRef.current) return;
    const skipped = markAnswerSkipped(state, state.currentIndex);
    if (state.currentIndex >= state.questions.length - 1) {
      void sendAnswers(skipped);
      return;
    }
    setActive({ ...skipped, currentIndex: state.currentIndex + 1 });
  }, [sendAnswers]);

  const cancelAll = useCallback(async () => {
    const state = activeRef.current;
    if (!state || busyRef.current) return;
    const bridge = window.orchid?.askQuestion;
    if (!bridge) {
      release(state.toolCallId);
      return;
    }
    busyRef.current = true;
    try {
      await bridge.cancel({ toolCallId: state.toolCallId });
    } catch {
      // Release regardless — a stuck overlay would block the composer forever.
    } finally {
      release(state.toolCallId);
    }
  }, [release]);

  return useMemo(
    () => ({
      active,
      selectOption,
      setText,
      next,
      back,
      skip,
      submit,
      cancelAll,
    }),
    [active, selectOption, setText, next, back, skip, submit, cancelAll],
  );
}
