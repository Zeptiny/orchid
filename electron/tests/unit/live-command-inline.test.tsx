// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveCommandInline } from '../../src/renderer/components/ToolWidgets/LiveCommandInline';
import type { BgCommandSnapshotFound } from '../../src/shared/types/ipc';

function snapshotWith(overrides: Partial<BgCommandSnapshotFound> = {}): BgCommandSnapshotFound {
  return {
    found: true,
    tail: 'hello\n',
    exitCode: null,
    running: true,
    interactive: false,
    owner: 'AGENT',
    command: 'demo',
    agentScopeId: 'main',
    ...overrides,
  };
}

function installBgCmd(overrides: Partial<BgCommandSnapshotFound> = {}) {
  const api = {
    snapshot: vi.fn().mockResolvedValue(snapshotWith(overrides)),
    sendInput: vi.fn().mockResolvedValue({ ok: true }),
    terminate: vi.fn().mockResolvedValue({ ok: true }),
    releaseInput: vi.fn().mockResolvedValue({ ok: true }),
  };
  window.orchid = { bgCmd: api } as never;
  return api;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function expand(titlePattern: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: titlePattern }));
}

describe('LiveCommandInline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hides input for non-interactive commands and shows Stop while running', async () => {
    const api = installBgCmd({ interactive: false });

    render(
      <LiveCommandInline
        target={{ commandId: 3 }}
        sessionId="sess-1"
        commandText="npm run dev"
      />,
    );
    await flush();

    expect(api.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 3,
      lastN: 50,
      sessionId: 'sess-1',
    }));

    expand(/\$ npm run dev \(running\)/);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
  });

  it('shows input for interactive running commands and submits text with a newline', async () => {
    const api = installBgCmd({ interactive: true, command: 'python -i' });

    render(
      <LiveCommandInline
        target={{ commandId: 4 }}
        sessionId="sess-1"
        commandText="python -i"
      />,
    );
    await flush();
    expand(/\$ python -i \(running\)/);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'print(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();

    expect(api.sendInput).toHaveBeenCalledWith({
      commandId: 4,
      text: 'print(1)\n',
      sessionId: 'sess-1',
    });
    expect(input.value).toBe('');
  });

  it('shows a hint and keeps the text when sendInput fails', async () => {
    const api = installBgCmd({ interactive: true });
    api.sendInput.mockResolvedValue({ ok: false, reason: 'exited' });

    render(
      <LiveCommandInline
        target={{ commandId: 4 }}
        sessionId="sess-1"
        commandText="python -i"
      />,
    );
    await flush();
    expand(/\$ python -i \(running\)/);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await flush();

    expect(screen.getByText('command already exited')).toBeTruthy();
    expect(input.value).toBe('hello');
  });

  it('hides Stop and shows the exit code once the command exits', async () => {
    installBgCmd({ exitCode: 2, running: false, tail: 'boom\n' });

    render(
      <LiveCommandInline
        target={{ commandId: 5 }}
        sessionId="sess-1"
        commandText="make test"
      />,
    );
    await flush();
    expand(/\$ make test \(exit 2\)/);

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Process exited with code 2')).toBeTruthy();
  });

  it('shows Release and an owner badge while the user owns input', async () => {
    const api = installBgCmd({ interactive: true, owner: 'USER' });

    render(
      <LiveCommandInline
        target={{ commandId: 6 }}
        sessionId="sess-1"
        commandText="python -i"
      />,
    );
    await flush();
    expand(/\$ python -i \(running\)/);

    expect(screen.getByText('input: you')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    await flush();

    expect(api.releaseInput).toHaveBeenCalledWith({
      commandId: 6,
      sessionId: 'sess-1',
    });
  });

  it('terminates through the owning session when Stop is clicked', async () => {
    const api = installBgCmd({ interactive: false });

    render(
      <LiveCommandInline
        target={{ commandId: 7 }}
        sessionId="sess-2"
        commandText="sleep 100"
      />,
    );
    await flush();
    expand(/\$ sleep 100 \(running\)/);

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await flush();

    expect(api.terminate).toHaveBeenCalledWith({
      commandId: 7,
      sessionId: 'sess-2',
    });
  });

  it('renders foreground targets output-only, without controls', async () => {
    const api = installBgCmd({ interactive: true });

    render(
      <LiveCommandInline
        target={{ toolCallId: 'call-9' }}
        sessionId="sess-1"
        commandText="sleep 5"
      />,
    );
    await flush();

    expect(api.snapshot).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'call-9',
      lastN: 50,
      sessionId: 'sess-1',
    }));

    expand(/\$ sleep 5 \(running\)/);

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('strips ANSI escape sequences from the displayed tail', async () => {
    installBgCmd({ tail: '\x1b[31mred\x1b[0m\n\x1b]0;t\x07plain\n' });

    const { container } = render(
      <LiveCommandInline
        target={{ commandId: 8 }}
        sessionId="sess-1"
        commandText="colors"
      />,
    );
    await flush();
    expand(/\$ colors \(running\)/);
    // Expanding enables tail refresh; flush the catch-up poll.
    await flush();

    const pre = container.querySelector('.orchid-live-command-pre');
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toBe('red\nplain\n');
  });
});
