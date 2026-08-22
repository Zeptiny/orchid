/**
 * Pure shell navigation for command-palette `orchid:navigate` events.
 * ChatView applies the result; Sidebar maps inspector section aliases.
 */

export type ShellNavigateResult =
  | { kind: 'noop' }
  | { kind: 'sessions' }
  | { kind: 'inspector'; section: string };

/** Resolve CustomEvent detail.section into a ChatView shell action. */
export function resolveOrchidNavigate(
  section: string | undefined | null,
): ShellNavigateResult {
  const trimmed = section?.trim();
  if (!trimmed) return { kind: 'noop' };
  if (trimmed === 'sessions') return { kind: 'sessions' };
  return { kind: 'inspector', section: trimmed };
}

/** Map command-palette navigation values to inspector section ids. */
export const NAV_SECTION_MAP: Readonly<Record<string, string>> = {
  subagents: 'inspector-subagents',
  todos: 'inspector-todos',
  'mcp-servers': 'inspector-mcp',
  'index-status': 'inspector-index',
  context: 'inspector-context',
  usage: 'inspector-usage',
  requests: 'inspector-requests',
};

export function resolveInspectorSectionId(focusSection: string): string {
  return NAV_SECTION_MAP[focusSection] ?? focusSection;
}

/** CollapseBlock re-opens when palette supplies a positive force-open token. */
export function shouldOpenCollapseFromToken(forceOpenToken: number): boolean {
  return forceOpenToken > 0;
}

/** Each focusSection effect bumps the epoch so same-section re-nav re-opens. */
export function nextForceOpenEpoch(epoch: number): number {
  return epoch + 1;
}
