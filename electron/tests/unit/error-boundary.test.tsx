// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../../src/renderer/components/ui/ErrorBoundary';

function BrokenView(): never {
  throw new Error('chunk failed');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a user-visible recovery action when a lazy surface throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onRetry = vi.fn();

    render(
      <ErrorBoundary title="Settings could not load" onRetry={onRetry}>
        <BrokenView />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert').textContent).toContain('Settings could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Reload Orchid' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('reloads the window when no retry handler is provided', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.fn();
    const testWindow = Object.create(window) as Window;
    Object.defineProperty(testWindow, 'location', { value: { reload } });

    render(
      <ErrorBoundary title="Orchid could not load">
        <BrokenView />
      </ErrorBoundary>,
    );

    vi.stubGlobal('window', testWindow);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Reload Orchid' }));
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
