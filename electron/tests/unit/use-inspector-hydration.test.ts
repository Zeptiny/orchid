// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInspectorHydration } from '../../src/renderer/hooks/useInspectorHydration';

describe('useInspectorHydration', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('defers workspace status requests until the inspector opens', async () => {
    const refreshMCP = vi.fn(async () => undefined);
    const refreshIndex = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ enabled, workspaceKey }) => useInspectorHydration({
        enabled,
        workspaceKey,
        refreshMCP,
        refreshIndex,
      }),
      { initialProps: { enabled: false, workspaceKey: '/project-a' as string | null } },
    );

    await Promise.resolve();
    expect(refreshMCP).not.toHaveBeenCalled();
    expect(refreshIndex).not.toHaveBeenCalled();

    rerender({ enabled: true, workspaceKey: '/project-a' });
    await waitFor(() => expect(refreshMCP).toHaveBeenCalledOnce());
    expect(refreshIndex).toHaveBeenCalledOnce();
    expect(refreshMCP).toHaveBeenLastCalledWith('/project-a');
    expect(refreshIndex).toHaveBeenLastCalledWith('/project-a');

    rerender({ enabled: true, workspaceKey: '/project-b' });
    await waitFor(() => expect(refreshMCP).toHaveBeenCalledTimes(2));
    expect(refreshIndex).toHaveBeenCalledTimes(2);
    expect(refreshMCP).toHaveBeenLastCalledWith('/project-b');
    expect(refreshIndex).toHaveBeenLastCalledWith('/project-b');
  });
});
