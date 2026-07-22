/**
 * MessageQueue rendering contract.
 *
 * Static-markup verification (no DOM runtime in this suite): empty-queue
 * null render, row contents, trigger badges, boundary-disabled reorder
 * controls, and the inline editing surface.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageQueue } from '../../src/renderer/components/MessageQueue';
import type { QueuedMessage, QueueTrigger } from '../../src/renderer/hooks/useMessageQueue';

const noop = () => {};

function queued(partial: Partial<QueuedMessage> & { id: string }): QueuedMessage {
  return {
    text: 'queued text',
    trigger: 'next-request',
    createdAt: 0,
    ...partial,
  };
}

function renderQueue(
  queue: readonly QueuedMessage[],
  overrides: { editingId?: string | null } = {},
): string {
  return renderToStaticMarkup(
    <MessageQueue
      queue={queue}
      editingId={overrides.editingId ?? null}
      onRemove={noop}
      onReorder={noop}
      onStartEditing={noop}
      onUpdateEditingText={noop}
      onFinishEditing={noop}
      onCancelEditing={noop}
      onChangeTrigger={noop}
    />,
  );
}

function buttonTags(html: string, label: string): string[] {
  const tags = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`, 'g')) ?? [];
  return tags;
}

describe('MessageQueue', () => {
  it('renders nothing when the queue is empty', () => {
    expect(renderQueue([])).toBe('');
  });

  it('renders each message with its trigger badge and row controls', () => {
    const html = renderQueue([
      queued({ id: 'a', text: 'first message' }),
      queued({ id: 'b', text: 'second message', trigger: 'chain-end' }),
    ]);

    expect(html).toContain('first message');
    expect(html).toContain('second message');
    expect(html).toContain('next req');
    expect(html).toContain('chain end');
    expect(buttonTags(html, 'Edit message')).toHaveLength(2);
    expect(buttonTags(html, 'Remove from queue')).toHaveLength(2);
    expect(buttonTags(html, 'Move up')).toHaveLength(2);
    expect(buttonTags(html, 'Move down')).toHaveLength(2);
    expect(html).toContain('role="list"');
  });

  it('disables reorder controls at the queue boundaries', () => {
    const html = renderQueue([
      queued({ id: 'a', text: 'one' }),
      queued({ id: 'b', text: 'two' }),
      queued({ id: 'c', text: 'three' }),
    ]);

    const up = buttonTags(html, 'Move up');
    const down = buttonTags(html, 'Move down');
    expect(up).toHaveLength(3);
    expect(down).toHaveLength(3);

    expect(up[0]).toContain('disabled');
    expect(up[1]).not.toContain('disabled');
    expect(up[2]).not.toContain('disabled');

    expect(down[0]).not.toContain('disabled');
    expect(down[1]).not.toContain('disabled');
    expect(down[2]).toContain('disabled');
  });

  it('shows the trigger badge label for each trigger type', () => {
    const nextReq = renderQueue([queued({ id: 'a', trigger: 'next-request' })]);
    const chainEnd = renderQueue([queued({ id: 'a', trigger: 'chain-end' })]);

    expect(nextReq).toContain('Trigger: next req. Toggle to chain end.');
    expect(nextReq).not.toContain('chain end<');
    expect(chainEnd).toContain('Trigger: chain end. Toggle to next req.');
    expect(chainEnd).not.toContain('next req<');
  });

  it('replaces the row with a textarea and save/cancel controls while editing', () => {
    const html = renderQueue(
      [queued({ id: 'a', text: 'line one\nline two' }), queued({ id: 'b', text: 'other' })],
      { editingId: 'a' },
    );

    expect(html).toContain('<textarea');
    expect(html).toContain('line one\nline two');
    expect(buttonTags(html, 'Save message')).toHaveLength(1);
    expect(buttonTags(html, 'Cancel editing')).toHaveLength(1);
    // Only the non-editing row keeps the display-mode controls.
    expect(buttonTags(html, 'Edit message')).toHaveLength(1);
    expect(buttonTags(html, 'Remove from queue')).toHaveLength(1);
    // The editing row keeps its trigger badge toggle.
    expect(html).toContain('next req');
  });
});
