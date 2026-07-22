/**
 * ask_question renderer — stepper hook helpers, overlay, and terminal summary.
 *
 * Uses ReactDOMServer static markup so Vitest stays on Node (no jsdom),
 * matching the renderer-ui-primitives convention. Hook IPC wiring is asserted
 * at the source level (composer-contract style); state transitions are covered
 * through the exported pure helpers the hook calls.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  applyQuestionResult,
  applyOptionSelection,
  applyText,
  buildSubmissions,
  createActiveQuestion,
  enqueueQuestion,
  markAnswerSkipped,
  reconcileQuestionSnapshot,
  removeSettledQuestion,
  updateActiveQuestion,
  type ActiveQuestion,
  type Question,
  type UseAskQuestionReturn,
} from '../../src/renderer/hooks/useAskQuestion';
import { resolveInputEscapeAction } from '../../src/renderer/components/InputArea';
import { AskQuestionOverlay } from '../../src/renderer/components/AskQuestionOverlay';
import { AskQuestionToolResult } from '../../src/renderer/components/ToolResults/AskQuestionToolResult';
import {
  resolveToolResultRenderer,
  rendererRegistrySnapshot,
} from '../../src/renderer/components/ToolResults/registry';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import type { AskQuestionAskedEvent } from '../../src/shared/types/ipc';

const RENDERER = path.resolve(__dirname, '../../src/renderer');

function read(rel: string): string {
  return fs.readFileSync(path.join(RENDERER, rel), 'utf8');
}

const QUESTIONS: Question[] = [
  {
    type: 'single',
    title: 'Which database?',
    description: 'Pick one storage engine.',
    options: [
      { label: 'PostgreSQL', description: 'Relational, battle-tested' },
      { label: 'SQLite', description: 'Embedded, zero-config' },
    ],
  },
  {
    type: 'multi',
    title: 'Which extras?',
    options: [
      { label: 'Migrations' },
      { label: 'Seeds' },
      { label: 'Backups' },
    ],
  },
];

function makeState(questions: Question[] = QUESTIONS): ActiveQuestion {
  return createActiveQuestion('tool-call-1', questions, 'session-1');
}

function asked(toolCallId: string, sessionId = 'session-1'): AskQuestionAskedEvent {
  return { sessionId, toolCallId, questions: QUESTIONS };
}

function makeController(active: ActiveQuestion | null): UseAskQuestionReturn {
  return {
    active,
    selectOption: () => {},
    setText: () => {},
    next: () => {},
    back: () => {},
    skip: () => {},
    submit: async () => {},
    cancelAll: async () => {},
  };
}

function renderOverlay(active: ActiveQuestion | null): string {
  const node: ReactElement = createElement(AskQuestionOverlay, {
    question: makeController(active),
  });
  return renderToStaticMarkup(node);
}

function canonical(value: unknown, status: 'complete' | 'cancelled' = 'complete'): CanonicalToolResult {
  return {
    schemaVersion: 1,
    family: 'generic',
    status,
    completeness: 'complete',
    data: { value, origin: { kind: 'built-in', name: 'ask_question' } },
  } as CanonicalToolResult;
}

function renderResult(canonicalResult: CanonicalToolResult): string {
  return renderToStaticMarkup(createElement(AskQuestionToolResult, { canonical: canonicalResult }));
}

// ── Pure state transitions ───────────────────────────────────────────────────

describe('createActiveQuestion', () => {
  it('starts on the first question with one empty answer per question', () => {
    const state = makeState();
    expect(state.toolCallId).toBe('tool-call-1');
    expect(state.currentIndex).toBe(0);
    expect(state.answers).toEqual([
      { selected: [], text: '', skipped: false },
      { selected: [], text: '', skipped: false },
    ]);
  });
});

describe('applyOptionSelection', () => {
  it('single-choice replaces the previous selection', () => {
    let state = applyOptionSelection(makeState(), 0, 'PostgreSQL');
    state = applyOptionSelection(state, 0, 'SQLite');
    expect(state.answers[0]!.selected).toEqual(['SQLite']);
  });

  it('multi-choice toggles options on and off', () => {
    let state = applyOptionSelection(makeState(), 1, 'Migrations');
    state = applyOptionSelection(state, 1, 'Backups');
    expect(state.answers[1]!.selected).toEqual(['Migrations', 'Backups']);
    state = applyOptionSelection(state, 1, 'Migrations');
    expect(state.answers[1]!.selected).toEqual(['Backups']);
  });

  it('selecting an option clears a prior skip mark', () => {
    let state = markAnswerSkipped(makeState(), 0);
    expect(state.answers[0]!.skipped).toBe(true);
    state = applyOptionSelection(state, 0, 'PostgreSQL');
    expect(state.answers[0]!.skipped).toBe(false);
  });

  it('ignores out-of-range question indexes', () => {
    const state = makeState();
    expect(applyOptionSelection(state, 9, 'PostgreSQL')).toBe(state);
  });
});

describe('applyText', () => {
  it('sets free text independently of selections and clears skip', () => {
    let state = applyOptionSelection(makeState(), 0, 'PostgreSQL');
    state = markAnswerSkipped(state, 0);
    state = applyText(state, 0, '  prefer managed hosting ');
    expect(state.answers[0]!.text).toBe('  prefer managed hosting ');
    expect(state.answers[0]!.selected).toEqual(['PostgreSQL']);
    expect(state.answers[0]!.skipped).toBe(false);
  });
});

describe('markAnswerSkipped', () => {
  it('marks skipped without touching selections or text', () => {
    let state = applyOptionSelection(makeState(), 0, 'SQLite');
    state = applyText(state, 0, 'note');
    state = markAnswerSkipped(state, 0);
    expect(state.answers[0]).toEqual({ selected: ['SQLite'], text: 'note', skipped: true });
  });
});

describe('buildSubmissions', () => {
  it('trims text and sends null when empty', () => {
    let state = applyText(makeState(), 0, '  hello  ');
    state = applyOptionSelection(state, 1, 'Seeds');
    state = markAnswerSkipped(state, 1);
    expect(buildSubmissions(state)).toEqual([
      { selected: [], text: 'hello', skipped: false },
      { selected: ['Seeds'], text: null, skipped: true },
    ]);
  });
});

// ── Session-affine pending queue ─────────────────────────────────────────────

describe('ask_question pending queue', () => {
  it('keeps overlapping events in FIFO order and deduplicates by session + tool call', () => {
    let queue: ActiveQuestion[] = [];
    queue = enqueueQuestion(queue, asked('tool-call-1'), 'session-1');
    queue = enqueueQuestion(queue, asked('tool-call-2'), 'session-1');
    queue = enqueueQuestion(queue, asked('tool-call-1'), 'session-1');

    expect(queue.map((item) => item.toolCallId)).toEqual(['tool-call-1', 'tool-call-2']);
  });

  it('retains controls when an invoke rejects or returns ok:false', () => {
    const queue = [
      createActiveQuestion('tool-call-1', QUESTIONS, 'session-1'),
      createActiveQuestion('tool-call-2', QUESTIONS, 'session-1'),
    ];

    expect(applyQuestionResult(queue, queue[0]!)).toBe(queue);
    expect(applyQuestionResult(queue, queue[0]!, { ok: false })).toBe(queue);
  });

  it('promotes only the next item after an acknowledged settlement', () => {
    const queue = [
      createActiveQuestion('tool-call-1', QUESTIONS, 'session-1'),
      createActiveQuestion('tool-call-2', QUESTIONS, 'session-1'),
    ];

    expect(applyQuestionResult(queue, queue[0]!, { ok: true }).map((item) => item.toolCallId))
      .toEqual(['tool-call-2']);
  });

  it('updates only the active FIFO entry and preserves identity for stale or no-op edits', () => {
    const first = createActiveQuestion('tool-call-1', QUESTIONS, 'session-1');
    const second = createActiveQuestion('tool-call-2', QUESTIONS, 'session-1');
    const queue = [first, second];

    expect(updateActiveQuestion(queue, first, (state) => state)).toBe(queue);
    expect(updateActiveQuestion(
      queue,
      createActiveQuestion('stale', QUESTIONS, 'session-1'),
      (state) => ({ ...state, currentIndex: 1 }),
    )).toBe(queue);

    const updated = updateActiveQuestion(queue, first, (state) => ({
      ...state,
      currentIndex: 1,
    }));
    expect(updated[0]?.currentIndex).toBe(1);
    expect(updated[1]).toBe(second);
  });

  it('hydrates a changed session from its snapshot and replays buffered events', () => {
    const queue = reconcileQuestionSnapshot(
      'session-2',
      [asked('snapshot-question', 'session-2')],
      [
        asked('snapshot-question', 'session-2'),
        asked('live-question', 'session-2'),
        asked('wrong-session', 'session-1'),
      ],
    );

    expect(queue.map((item) => [item.sessionId, item.toolCallId])).toEqual([
      ['session-2', 'snapshot-question'],
      ['session-2', 'live-question'],
    ]);
  });

  it('does not resurrect a snapshot entry settled while hydration was in flight', () => {
    const settledKeys = new Set(['session-1\u0000snapshot-question']);

    const queue = reconcileQuestionSnapshot(
      'session-1',
      [asked('snapshot-question')],
      [asked('live-question')],
      settledKeys,
    );

    expect(queue.map((item) => item.toolCallId)).toEqual(['live-question']);
  });

  it('removes a settled queue entry idempotently and promotes the next question', () => {
    const queue = [
      createActiveQuestion('tool-call-1', QUESTIONS, 'session-1'),
      createActiveQuestion('tool-call-2', QUESTIONS, 'session-1'),
    ];
    const settled = {
      sessionId: 'session-1',
      toolCallId: 'tool-call-1',
      result: 'cancelled' as const,
    };

    const promoted = removeSettledQuestion(queue, settled);
    expect(promoted.map((item) => item.toolCallId)).toEqual(['tool-call-2']);
    expect(removeSettledQuestion(promoted, settled)).toBe(promoted);
  });

  it('defensively ignores live and snapshot questions for another session', () => {
    expect(enqueueQuestion([], asked('wrong', 'session-2'), 'session-1')).toEqual([]);
    expect(reconcileQuestionSnapshot('session-1', [asked('wrong', 'session-2')], []))
      .toEqual([]);
  });
});

describe('InputArea Escape ownership', () => {
  it('prioritizes the active question over chat interruption', () => {
    expect(resolveInputEscapeAction({
      hasActiveQuestion: true,
      canInterrupt: true,
      isSlashMode: false,
      isViewActive: false,
      settingsOpen: false,
    })).toBe('cancel-question');
  });

  it('leaves Escape to settings, inactive views, and slash menus', () => {
    const base = {
      hasActiveQuestion: false,
      canInterrupt: true,
      isSlashMode: false,
      isViewActive: false,
      settingsOpen: false,
    };
    expect(resolveInputEscapeAction({ ...base, settingsOpen: true })).toBe('none');
    expect(resolveInputEscapeAction({ ...base, isViewActive: true })).toBe('none');
    expect(resolveInputEscapeAction({ ...base, isSlashMode: true })).toBe('none');
  });
});

// ── Overlay markup ───────────────────────────────────────────────────────────

describe('AskQuestionOverlay', () => {
  it('renders nothing without an active question', () => {
    expect(renderOverlay(null)).toBe('');
  });

  it('renders the first question with progress, options, and navigation', () => {
    const html = renderOverlay(makeState());
    expect(html).toContain('Agent question');
    expect(html).toContain('Question 1 of 2');
    expect(html).toContain('Which database?');
    expect(html).toContain('Pick one storage engine.');
    expect(html).toContain('PostgreSQL');
    expect(html).toContain('Relational, battle-tested');
    expect(html).toContain('SQLite');
    expect(html).toContain('Additional thoughts (optional)');
    expect(html).toContain('Back');
    expect(html).toContain('Skip');
    expect(html).toContain('Next');
    expect(html).not.toContain('Submit');
  });

  it('disables Back on the first question', () => {
    const html = renderOverlay(makeState());
    const backTag = html.slice(html.lastIndexOf('<button', html.indexOf('Back')), html.indexOf('Back'));
    expect(backTag).toContain('disabled');
  });

  it('uses radio semantics for single-choice questions', () => {
    const html = renderOverlay(makeState());
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('aria-checked="false"');
  });

  it('uses checkbox semantics for multi-choice questions', () => {
    const state = { ...makeState(), currentIndex: 1 };
    const html = renderOverlay(state);
    expect(html).toContain('role="group"');
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('Question 2 of 2');
  });

  it('marks the selected option and shows Submit on the last question', () => {
    let state = applyOptionSelection(makeState(), 1, 'Seeds');
    state = { ...state, currentIndex: 1 };
    const html = renderOverlay(state);
    expect(html).toContain('orchid-ask-option-selected');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Submit');
    expect(html).not.toContain('Next');
  });

  it('shows a Skipped badge when returning to a skipped question', () => {
    const state = markAnswerSkipped(makeState(), 0);
    expect(renderOverlay(state)).toContain('Skipped');
  });

  it('renders free text into the note textarea', () => {
    const state = applyText(makeState(), 0, 'thinking out loud');
    expect(renderOverlay(state)).toContain('thinking out loud');
  });
});

// ── Terminal summary markup ──────────────────────────────────────────────────

describe('AskQuestionToolResult', () => {
  it('summarizes answered questions with selections and free text', () => {
    const html = renderResult(canonical({
      answers: [
        { selected: ['PostgreSQL'], text: 'hosted please', skipped: false },
        { selected: ['Seeds', 'Backups'], text: null, skipped: false },
      ],
    }));
    expect(html).toContain('Question 1');
    expect(html).toContain('Question 2');
    expect(html).toContain('PostgreSQL');
    expect(html).toContain('Seeds');
    expect(html).toContain('Backups');
    expect(html).toContain('hosted please');
    expect(html).not.toContain('Skipped');
  });

  it('flags skipped questions', () => {
    const html = renderResult(canonical({
      answers: [{ selected: [], text: null, skipped: true }],
    }));
    expect(html).toContain('Skipped');
    expect(html).toContain('No answer provided');
  });

  it('reports cancelled tool calls', () => {
    const html = renderResult(canonical({ answers: [], cancelled: true }, 'cancelled'));
    expect(html).toContain('Cancelled');
    expect(html).toContain('cancelled before it was answered');
  });

  it('falls back to the generic renderer on unexpected payloads', () => {
    const html = renderResult(canonical({ unrelated: 42 }));
    expect(html).toContain('unrelated');
    expect(html).not.toContain('orchid-ask-result-item');
  });
});

// ── Registry + wiring ────────────────────────────────────────────────────────

describe('ask_question registry and wiring', () => {
  it('registers the terminal renderer for ask_question', () => {
    expect(resolveToolResultRenderer('ask_question', 'generic')).toBe(AskQuestionToolResult);
    expect(rendererRegistrySnapshot().tools).toContain('ask_question');
  });

  it('useAskQuestion subscribes via the askQuestion bridge and cleans up', () => {
    const src = read('hooks/useAskQuestion.ts');
    expect(src).toMatch(/window\.orchid\?\.askQuestion/);
    expect(src).toMatch(/bridge\.onAsked\(/);
    expect(src).toMatch(/bridge\.onSettled\(/);
    expect(src).toMatch(/unsubscribeAsked\(\)/);
    expect(src).toMatch(/unsubscribeSettled\(\)/);
    expect(src).toMatch(/bridge\.answer\(\{/);
    expect(src).toMatch(/bridge\.cancel\(\{/);
  });

  it('InputArea swaps the composer for the overlay while a question is active', () => {
    const src = read('components/InputArea.tsx');
    expect(src).toMatch(/useAskQuestion\(sessionId\)/);
    expect(src).toMatch(/if \(askQuestion\.active\) \{/);
    expect(src).toMatch(/<AskQuestionOverlay question=\{askQuestion\} \/>/);
  });
});
