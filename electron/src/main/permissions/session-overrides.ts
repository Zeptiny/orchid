import type { PermissionMode } from '../../shared/types/permission';

/** Per-session permission-mode overrides set by the footer selector (highest tier). */
export const sessionPermissionOverrides = new Map<string, PermissionMode>();

/**
 * Per-window draft permission-mode overrides, used before a session file exists.
 * Transferred to the session (and the in-memory map above) when one is created.
 */
const draftPermissionOverrides = new Map<string, PermissionMode | null>();

/** Store or clear the draft permission mode for a window (pre-session). */
export function setDraftPermissionOverride(
  windowId: string,
  mode: PermissionMode | null,
): void {
  draftPermissionOverrides.set(windowId, mode);
}

/** Read the draft permission mode for a window (pre-session). */
export function getDraftPermissionOverride(
  windowId: string,
): PermissionMode | null | undefined {
  if (!draftPermissionOverrides.has(windowId)) return undefined;
  return draftPermissionOverrides.get(windowId) ?? null;
}

/**
 * Consume the stored draft permission override for a window, if any.
 * Called when a draft promotes into a session so the choice survives.
 */
export function takeDraftPermissionOverride(
  windowId: string,
): PermissionMode | null | undefined {
  if (!draftPermissionOverrides.has(windowId)) return undefined;
  const value = draftPermissionOverrides.get(windowId) ?? null;
  draftPermissionOverrides.delete(windowId);
  return value;
}

/**
 * Sync the in-memory override map from a session's persisted permission mode.
 * Called when a session is loaded/switched to so the gate (which reads the
 * in-memory map) honors the persisted choice after a restart.
 */
export function hydrateSessionPermissionOverride(
  sessionId: string,
  mode: PermissionMode | null,
): void {
  if (mode == null) {
    sessionPermissionOverrides.delete(sessionId);
  } else {
    sessionPermissionOverrides.set(sessionId, mode);
  }
}

/** Clear all draft permission overrides (e.g. on IPC teardown). */
export function clearDraftPermissionOverrides(): void {
  draftPermissionOverrides.clear();
}
