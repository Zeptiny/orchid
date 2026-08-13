// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Footer } from '../../src/renderer/components/Footer';

describe('Footer session-open seeds', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('reuses same-model configuration and adopts per-session overrides without reads', async () => {
    const getReasoningConfig = vi.fn(async () => ({
      levels: ['low', 'high'],
      default: 'low',
      override: null,
      supportsReasoning: true,
    }));
    const getServiceTierConfig = vi.fn(async () => ({
      mechanism: 'request-parameter' as const,
      tiers: [{ id: 'priority', displayName: 'Priority', description: null }],
      selected: null,
      override: null,
      effective: null,
    }));
    const getSessionMode = vi.fn();
    window.orchid = {
      session: { getReasoningConfig, getServiceTierConfig },
      permission: { getSessionMode, setSessionMode: vi.fn() },
    } as never;

    const { rerender } = render(
      <Footer
        isStreaming={false}
        sessionId="session-a"
        reasoningEffortOverride="high"
        serviceTierOverride="priority"
        permissionMode="ask"
      />,
    );

    await waitFor(() => expect(getReasoningConfig).toHaveBeenCalledOnce());
    expect(getServiceTierConfig).toHaveBeenCalledOnce();
    expect(getSessionMode).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Session permissions' }).textContent)
      .toContain('Always ask');

    rerender(
      <Footer
        isStreaming={false}
        sessionId="session-b"
        reasoningEffortOverride="low"
        serviceTierOverride={null}
        permissionMode="allow"
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Session permissions' }).textContent)
        .toContain('Allow all');
    });
    expect(getReasoningConfig).toHaveBeenCalledOnce();
    expect(getServiceTierConfig).toHaveBeenCalledOnce();
    expect(getSessionMode).not.toHaveBeenCalled();
  });
});
