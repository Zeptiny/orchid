// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompactedRangeStub,
  CompactionRunningWidget,
  CompactionWidget,
  ReclaimStub,
} from '../../src/renderer/components/ToolResults/CompactionWidget';
import {
  MessageRole,
  MessageType,
  type CompactedMarker,
  type Message,
  type Usage,
} from '../../src/shared/types/message';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function marker(overrides: Partial<CompactedMarker> = {}): CompactedMarker {
  return {
    rangeStart: 'start-message-id-0001',
    rangeEnd: 'end-message-id-0002',
    mode: 'simple',
    summarizedCount: 12,
    ...overrides,
  };
}

function summaryMessage(content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'sum-1',
    role: MessageRole.ASSISTANT,
    content,
    type: MessageType.TEXT,
    tool_calls: null,
    tool_call_id: null,
    name: null,
    thinking: null,
    timestamp: '2026-01-01T00:00:00.000Z',
    usage: null,
    hidden: false,
    compacted: marker(),
    ...overrides,
  };
}

function usageTotal(totalTokens: number): Usage {
  return {
    prompt_tokens: Math.floor(totalTokens / 2),
    completion_tokens: totalTokens - Math.floor(totalTokens / 2),
    total_tokens: totalTokens,
    cached_tokens: 0,
  };
}

afterEach(cleanup);

// ── Summary card ─────────────────────────────────────────────────────────────

describe('CompactionWidget — summary rendering', () => {
  it('renders a collapsed disclosure row with mode and summarized-count badges', () => {
    render(
      <CompactionWidget
        message={summaryMessage('## Handoff\nEarlier work: built the parser.')}
      />,
    );

    const card = screen
      .getByText('Compaction summary')
      .closest('[data-compaction="summary"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-tool-result-status')).toBe('complete');

    const toggle = screen.getByRole('button', { name: /Compaction summary/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('simple')).toBeTruthy();
    expect(screen.getByText('12 messages')).toBeTruthy();

    // Lazy mount: the handoff body is not rendered while collapsed.
    expect(screen.queryByText('Earlier work: built the parser.')).toBeNull();
    expect(screen.queryByText(/range start-me…end-mess/)).toBeNull();
  });

  it('expands to reveal the handoff markdown and collapses again', () => {
    render(
      <CompactionWidget
        message={summaryMessage(
          '## Handoff\nEarlier work: built the parser.',
          { compacted: marker({ tokensFreed: 105577 }) },
        )}
      />,
    );

    const toggle = screen.getByRole('button', { name: /Compaction summary/ });
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Earlier work: built the parser.')).toBeTruthy();
    expect(screen.getByText(/range start-me…end-mess/)).toBeTruthy();
    expect(screen.getByText(/agent compactor/)).toBeTruthy();
    expect(screen.getAllByText(/~105,577 tokens freed/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByTitle('Click to collapse'));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders nothing for a message without a compaction marker', () => {
    const plain = { ...summaryMessage('Real assistant text'), compacted: undefined };
    const { container } = render(<CompactionWidget message={plain} />);
    expect(container.innerHTML).toBe('');
  });

  it('never derives freed tokens from a stamped main-model usage (regression)', () => {
    render(
      <CompactionWidget
        message={summaryMessage('## Handoff\nEarlier work.', {
          usage: usageTotal(105577),
          compacted: marker(),
        })}
      />,
    );

    // A usage stamped onto the summary head by a later step is NOT a freed
    // metric; without marker metrics nothing is claimed.
    expect(screen.queryByText(/tokens freed/)).toBeNull();
  });

  it('shows the compactor cost attribution when the marker carries it', () => {
    render(
      <CompactionWidget
        message={summaryMessage('## Handoff', {
          compacted: marker({
            tokensFreed: 9000,
            compactorTokens: { inputTokens: 5841, outputTokens: 895 },
          }),
        })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Compaction summary/ }));
    expect(screen.getByText(/compactor 5,841 in \/ 895 out/)).toBeTruthy();
    expect(screen.getAllByText(/~9,000 tokens freed/).length).toBeGreaterThan(0);
  });
});

// ── Running widget — live streaming tail ─────────────────────────────────────

describe('CompactionRunningWidget — streaming tail', () => {
  it('shows the placeholder copy before any stream text arrives', () => {
    render(
      <CompactionRunningWidget status="running" phase="summarizing" mode="simple" />,
    );

    expect(screen.getByText(/the summary will appear when ready\./)).toBeTruthy();
    expect(screen.queryByText(/streaming/)).toBeNull();
  });

  it('renders the tail of the streamed summary text with a char count', () => {
    const streamText = ['## Handoff', ...Array.from({ length: 12 }, (_, i) => `context line ${i + 1}.`)].join('\n');
    render(
      <CompactionRunningWidget
        status="generating"
        phase="summarizing"
        mode="simple"
        streamText={streamText}
      />,
    );

    const tail = screen.getByText(/streaming/).closest('[data-compaction-stream="tail"]');
    expect(tail).not.toBeNull();
    expect(tail?.textContent).toContain(`${streamText.length.toLocaleString()} chars`);
    // Only the last few lines are shown — the header line is clipped.
    expect(tail?.textContent).not.toContain('## Handoff');
    expect(tail?.textContent).toContain('context line 12.');
  });

  it('shows the calibrated token estimate in place of the char count', () => {
    const streamText = ['## Handoff', ...Array.from({ length: 12 }, (_, i) => `context line ${i + 1}.`)].join('\n');
    render(
      <CompactionRunningWidget
        status="generating"
        phase="summarizing"
        mode="simple"
        streamText={streamText}
        estimatedTokens={1461}
      />,
    );

    const tail = screen.getByText(/streaming/).closest('[data-compaction-stream="tail"]');
    expect(tail?.textContent).toContain('~1,461 tokens');
    expect(tail?.textContent).not.toContain('chars');
  });

  it('falls back to the char count when no calibration exists', () => {
    const streamText = 'partial summary';
    render(
      <CompactionRunningWidget
        status="generating"
        phase="summarizing"
        mode="simple"
        streamText={streamText}
        estimatedTokens={null}
      />,
    );

    const tail = screen.getByText(/streaming/).closest('[data-compaction-stream="tail"]');
    expect(tail?.textContent).toContain(`${streamText.length.toLocaleString()} chars`);
  });

  it('renders raw selective ops JSON as-is while streaming', () => {
    const opsJson = '[{"type":"keep","id":"m1"},{"type":"drop","id":"m2"}]';
    render(
      <CompactionRunningWidget
        status="generating"
        phase="summarizing"
        mode="selective"
        streamText={opsJson}
      />,
    );

    const tail = screen.getByText(/streaming/).closest('[data-compaction-stream="tail"]');
    expect(tail?.textContent).toContain('"type":"keep"');
    expect(screen.getByText('selective')).toBeTruthy();
  });

  it('falls back to placeholder copy for empty stream text', () => {
    render(
      <CompactionRunningWidget status="generating" phase="summarizing" streamText="" />,
    );

    expect(screen.getByText(/the summary will appear when ready\./)).toBeTruthy();
    expect(screen.queryByText(/streaming/)).toBeNull();
  });
});

// ── Reclaim-only classification ──────────────────────────────────────────────

describe('CompactionWidget — reclaim-only classification', () => {
  it('renders the lighter reclaim note when the summary body is empty', () => {
    render(<CompactionWidget message={summaryMessage('')} />);

    const note = screen
      .getByText(/Reclaimed 12 duplicate tool outputs/)
      .closest('[data-compaction="reclaim"]');
    expect(note).not.toBeNull();
    // Not the full summary card.
    expect(screen.queryByText('Compaction summary')).toBeNull();
  });

  it('classifies a zero-count short note as reclaim-only', () => {
    render(
      <CompactionWidget
        message={summaryMessage('Nothing further to summarize.', {
          compacted: marker({ summarizedCount: 0 }),
        })}
      />,
    );

    expect(
      screen.getByText(/Reclaimed 0 duplicate tool outputs — Nothing further to summarize\./),
    ).toBeTruthy();
    expect(screen.queryByText('Compaction summary')).toBeNull();
  });

  it('classifies short reclaim-worded notes as reclaim-only', () => {
    render(
      <CompactionWidget
        message={summaryMessage('Reclaim applied to duplicate outputs.', {
          compacted: marker({ summarizedCount: undefined }),
        })}
      />,
    );

    expect(screen.getByText(/Reclaimed duplicate tool outputs/).closest('[data-compaction="reclaim"]'))
      .not.toBeNull();
    expect(screen.queryByText('Compaction summary')).toBeNull();
  });

  it('keeps a short note without reclaim wording as a full summary card', () => {
    render(
      <CompactionWidget
        message={summaryMessage('Short handoff note.', {
          compacted: marker({ summarizedCount: undefined }),
        })}
      />,
    );

    expect(screen.getByText('Compaction summary').closest('[data-compaction="summary"]'))
      .not.toBeNull();
    expect(screen.queryByText(/duplicate tool outputs/)).toBeNull();
  });

  it('keeps a long reclaim-worded summary as a full summary card', () => {
    const longBody = `Reclaim context: ${'detailed handoff. '.repeat(20)}`;
    expect(longBody.length).toBeGreaterThan(200);
    render(<CompactionWidget message={summaryMessage(longBody)} />);

    expect(screen.getByText('Compaction summary').closest('[data-compaction="summary"]'))
      .not.toBeNull();
  });
});

// ── Collapsed stub affordances ───────────────────────────────────────────────

describe('CompactedRangeStub — collapsed stub affordance', () => {
  it('exposes an expand control labelled with the compacted count', () => {
    const onExpand = vi.fn();
    render(<CompactedRangeStub count={3} onExpand={onExpand} />);

    const button = screen.getByRole('button', { name: 'Expand compacted 3 messages' });
    expect(
      screen.getByText(/Compacted 3 messages — hidden from model, visible here\. Click to expand\./),
    ).toBeTruthy();

    fireEvent.click(button);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('uses singular copy for a single compacted message', () => {
    render(<CompactedRangeStub count={1} onExpand={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Expand compacted 1 message' })).toBeTruthy();
    expect(screen.getByText(/Compacted 1 message — hidden from model/)).toBeTruthy();
  });
});

describe('ReclaimStub — reclaim stub affordance', () => {
  it('exposes an expand control for reclaimed tool outputs', () => {
    const onExpand = vi.fn();
    render(<ReclaimStub count={2} onExpand={onExpand} />);

    const button = screen.getByRole('button', { name: 'Expand 2 reclaimed tool outputs' });
    expect(screen.getByText(/Reclaimed 2 duplicate tool outputs — click to expand\./)).toBeTruthy();

    fireEvent.click(button);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
