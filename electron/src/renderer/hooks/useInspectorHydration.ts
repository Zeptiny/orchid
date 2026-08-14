import { useEffect } from 'react';

interface InspectorHydrationOptions {
  readonly enabled: boolean;
  readonly workspaceKey: string | null;
  readonly refreshMCP: (workspaceKey?: string | null) => void | Promise<void>;
  readonly refreshIndex: (workspaceKey?: string | null) => void | Promise<void>;
}

/** Load project-scoped inspector data only while the inspector is visible. */
export function useInspectorHydration({
  enabled,
  workspaceKey,
  refreshMCP,
  refreshIndex,
}: InspectorHydrationOptions): void {
  useEffect(() => {
    if (!enabled) return;
    void refreshMCP(workspaceKey);
    void refreshIndex(workspaceKey);
  }, [enabled, refreshIndex, refreshMCP, workspaceKey]);
}
