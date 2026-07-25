// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../src/renderer/components/InputArea';
import type { CommandContext } from '../../src/shared/types/ipc-boundary';

function createCommandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  return {
    onCreateSession: vi.fn(async () => {}),
    onLoadSession: vi.fn(async () => {}),
    onDeleteSession: vi.fn(async () => {}),
    onRenameSession: vi.fn(async () => {}),
    getActiveSessionId: vi.fn(() => null),
    getActiveSessionName: vi.fn(() => null),
    onSetTheme: vi.fn(async () => {}),
    onSetPersonality: vi.fn(async () => {}),
    onSetModel: vi.fn(async () => {}),
    getAvailableModels: vi.fn(() => []),
    getCurrentModel: vi.fn(() => ''),
    onOpenSettings: vi.fn(),
    onPickProjectDir: vi.fn(async () => {}),
    onIndexRAG: vi.fn(async () => {}),
    onIndexAST: vi.fn(async () => {}),
    onClearRAG: vi.fn(async () => {}),
    onNotify: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('InputArea slash commands', () => {
  it('runs a slash command instead of queueing it while streaming', async () => {
    const onOpenSettings = vi.fn();
    const onQueue = vi.fn();
    const onSend = vi.fn(async () => {});

    render(
      <InputArea
        sessionId={null}
        status="streaming"
        model=""
        onSend={onSend}
        onCancel={vi.fn(async () => {})}
        onQueue={onQueue}
        commandContext={createCommandContext({ onOpenSettings })}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '/settings' },
    });

    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run command' }));

    await waitFor(() => expect(onOpenSettings).toHaveBeenCalledOnce());
    expect(onQueue).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
