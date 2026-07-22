/**
 * useAskQuestion — interactive ask_question stepper state.
 *
 * Subscribes to the `ask_question:asked` IPC event, hydrates pending calls for
 * the selected session, and exposes stepper actions over a deduplicated FIFO.
 * Successful submit/cancel round-trips promote the next pending call.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  AskQuestionAskedEvent,
  AskQuestionResult,
  AskQuestionSettledEvent,
} from '../../shared/types/ipc';

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
  sessionId: string;
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
  sessionId = '',
): ActiveQuestion {
  return {
    sessionId,
    toolCallId,
    questions,
    currentIndex: 0,
    answers: questions.map(() => ({ selected: [], text: '', skipped: false })),
  };
}

function questionKey(question: Pick<ActiveQuestion, 'sessionId' | 'toolCallId'>): string {
  return `${question.sessionId}\u0000${question.toolCallId}`;
}

function isUsableEvent(event: AskQuestionAskedEvent): boolean {
  return Boolean(
    event.sessionId &&
    event.toolCallId &&
    Array.isArray(event.questions) &&
    event.questions.length > 0,
  );
}

/** Append one pending question for the selected session without overwriting FIFO state. */
export function enqueueQuestion(
  queue: ActiveQuestion[],
  event: AskQuestionAskedEvent,
  selectedSessionId: string | null,
): ActiveQuestion[] {
  if (!selectedSessionId || event.sessionId !== selectedSessionId || !isUsableEvent(event)) {
    return queue;
  }
  const pending = createActiveQuestion(event.toolCallId, event.questions, event.sessionId);
  return queue.some((item) => questionKey(item) === questionKey(pending))
    ? queue
    : [...queue, pending];
}

/** Seed session-affine pending state, then replay events received during hydration. */
export function reconcileQuestionSnapshot(
  selectedSessionId: string | null,
  snapshot: AskQuestionAskedEvent[],
  buffered: AskQuestionAskedEvent[],
  settledKeys: ReadonlySet<string> = new Set(),
): ActiveQuestion[] {
  return [...snapshot, ...buffered].reduce<ActiveQuestion[]>(
    (queue, event) => settledKeys.has(questionKey(event))
      ? queue
      : enqueueQuestion(queue, event, selectedSessionId),
    [],
  );
}

/** Idempotently remove one question settled by the main-process store. */
export function removeSettledQuestion(
  queue: ActiveQuestion[],
  settled: Pick<AskQuestionSettledEvent, 'sessionId' | 'toolCallId'>,
): ActiveQuestion[] {
  const settledKey = questionKey(settled);
  const next = queue.filter((item) => questionKey(item) !== settledKey);
  return next.length === queue.length ? queue : next;
}

/** Remove exactly one acknowledged question; rejected settlements retain the controls. */
export function applyQuestionResult(
  queue: ActiveQuestion[],
  settled: Pick<ActiveQuestion, 'sessionId' | 'toolCallId'>,
  result?: AskQuestionResult,
): ActiveQuestion[] {
  if (!result?.ok) return queue;
  const settledKey = questionKey(settled);
  return queue.filter((item) => questionKey(item) !== settledKey);
}

/** Update the active FIFO entry while rejecting stale session/tool identities. */
export function updateActiveQuestion(
  queue: ActiveQuestion[],
  active: Pick<ActiveQuestion, 'sessionId' | 'toolCallId'>,
  updater: (state: ActiveQuestion) => ActiveQuestion,
): ActiveQuestion[] {
  const current = queue[0];
  if (!current || questionKey(current) !== questionKey(active)) return queue;
  const updated = updater(current);
  return updated === current ? queue : [updated, ...queue.slice(1)];
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

export function useAskQuestion(sessionId: string | null): UseAskQuestionReturn {
  const [queue, setQueue] = useState<ActiveQuestion[]>([]);
  const active = queue[0]?.sessionId === sessionId ? queue[0] : null;
  const activeRef = useRef<ActiveQuestion | null>(null);
  const selectedSessionRef = useRef(sessionId);
  const hydrationGenerationRef = useRef(0);
  const hydrationRef = useRef<{
    generation: number;
    sessionId: string;
    buffered: AskQuestionAskedEvent[];
    settledKeys: Set<string>;
  } | null>(null);
  /** Identity of the question with an in-flight answer/cancel round-trip. */
  const busyRef = useRef<string | null>(null);

  selectedSessionRef.current = sessionId;

  useLayoutEffect(() => {
    activeRef.current = active;
  }, [active]);

  // A snapshot makes pending questions replayable after remounts and session
  // switches. Live events received while it is in flight are buffered, then
  // appended in arrival order after the authoritative snapshot.
  useEffect(() => {
    const bridge = window.orchid?.askQuestion;
    const generation = ++hydrationGenerationRef.current;
    busyRef.current = null;
    setQueue([]);

    if (!bridge || !sessionId) {
      hydrationRef.current = null;
      return;
    }

    const pending = {
      generation,
      sessionId,
      buffered: [] as AskQuestionAskedEvent[],
      settledKeys: new Set<string>(),
    };
    hydrationRef.current = pending;
    let cancelled = false;

    const unsubscribeAsked = bridge.onAsked((event: AskQuestionAskedEvent) => {
      if (event.sessionId !== sessionId || !isUsableEvent(event)) return;
      const currentHydration = hydrationRef.current;
      if (currentHydration?.sessionId === sessionId) {
        const key = questionKey(event);
        if (!currentHydration.buffered.some((item) => questionKey(item) === key)) {
          currentHydration.buffered.push(event);
        }
        return;
      }
      setQueue((previous) => enqueueQuestion(previous, event, sessionId));
    });
    const unsubscribeSettled = bridge.onSettled((event: AskQuestionSettledEvent) => {
      if (event.sessionId !== sessionId || !event.toolCallId) return;
      const key = questionKey(event);
      if (busyRef.current === key) busyRef.current = null;
      const currentHydration = hydrationRef.current;
      if (currentHydration?.sessionId === sessionId) {
        currentHydration.settledKeys.add(key);
        currentHydration.buffered = currentHydration.buffered.filter(
          (item) => questionKey(item) !== key,
        );
      }
      setQueue((previous) => removeSettledQuestion(previous, event));
    });

    void bridge.snapshot().then(
      (snapshot) => {
        if (
          cancelled ||
          hydrationGenerationRef.current !== generation ||
          selectedSessionRef.current !== sessionId
        ) return;
        const buffered = hydrationRef.current === pending ? pending.buffered : [];
        const settledKeys = hydrationRef.current === pending
          ? pending.settledKeys
          : new Set<string>();
        hydrationRef.current = null;
        setQueue(reconcileQuestionSnapshot(
          sessionId,
          snapshot.questions,
          buffered,
          settledKeys,
        ));
      },
      () => {
        if (
          cancelled ||
          hydrationGenerationRef.current !== generation ||
          selectedSessionRef.current !== sessionId
        ) return;
        const buffered = hydrationRef.current === pending ? pending.buffered : [];
        const settledKeys = hydrationRef.current === pending
          ? pending.settledKeys
          : new Set<string>();
        hydrationRef.current = null;
        setQueue(reconcileQuestionSnapshot(sessionId, [], buffered, settledKeys));
      },
    );

    return () => {
      cancelled = true;
      if (hydrationRef.current === pending) hydrationRef.current = null;
      unsubscribeAsked();
      unsubscribeSettled();
    };
  }, [sessionId]);

  const update = useCallback((updater: (state: ActiveQuestion) => ActiveQuestion) => {
    const current = activeRef.current;
    if (!current) return;
    setQueue((previous) => updateActiveQuestion(previous, current, updater));
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

  const finishRoundTrip = useCallback((state: ActiveQuestion, result?: AskQuestionResult) => {
    const key = questionKey(state);
    if (busyRef.current === key) busyRef.current = null;
    setQueue((previous) => applyQuestionResult(previous, state, result));
  }, []);

  const sendAnswers = useCallback(
    async (state: ActiveQuestion) => {
      const bridge = window.orchid?.askQuestion;
      if (!bridge) return;
      busyRef.current = questionKey(state);
      try {
        const result = await bridge.answer({
          toolCallId: state.toolCallId,
          answers: buildSubmissions(state),
        });
        finishRoundTrip(state, result);
      } catch {
        finishRoundTrip(state);
      }
    },
    [finishRoundTrip],
  );

  const submit = useCallback(async () => {
    const state = activeRef.current;
    if (!state || busyRef.current !== null) return;
    await sendAnswers(state);
  }, [sendAnswers]);

  const skip = useCallback(() => {
    const state = activeRef.current;
    if (!state || busyRef.current !== null) return;
    const skipped = markAnswerSkipped(state, state.currentIndex);
    if (state.currentIndex >= state.questions.length - 1) {
      setQueue((previous) => updateActiveQuestion(previous, state, () => skipped));
      void sendAnswers(skipped);
      return;
    }
    const advanced = { ...skipped, currentIndex: state.currentIndex + 1 };
    setQueue((previous) => updateActiveQuestion(previous, state, () => advanced));
  }, [sendAnswers]);

  const cancelAll = useCallback(async () => {
    const state = activeRef.current;
    if (!state || busyRef.current !== null) return;
    const bridge = window.orchid?.askQuestion;
    if (!bridge) return;
    busyRef.current = questionKey(state);
    try {
      const result = await bridge.cancel({ toolCallId: state.toolCallId });
      finishRoundTrip(state, result);
    } catch {
      finishRoundTrip(state);
    }
  }, [finishRoundTrip]);

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
