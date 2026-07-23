import type { PermissionMode } from '../../shared/types/permission';

/** Per-session permission-mode overrides set by the footer selector (highest tier). */
export const sessionPermissionOverrides = new Map<string, PermissionMode>();
