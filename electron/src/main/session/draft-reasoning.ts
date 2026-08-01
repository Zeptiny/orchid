/** Window-scoped reasoning overrides chosen before a session exists. */
const draftReasoningOverrides = new Map<string, string | number | null>();

export function setDraftReasoningOverride(
  windowId: string,
  effort: string | number | null,
): void {
  draftReasoningOverrides.set(windowId, effort);
}

export function getDraftReasoningOverride(windowId: string): string | number | null {
  return draftReasoningOverrides.get(windowId) ?? null;
}

export function clearDraftReasoningOverrides(): void {
  draftReasoningOverrides.clear();
}

/** Consume the override when a draft is promoted into a session. */
export function takeDraftReasoningOverride(
  windowId: string,
): string | number | null | undefined {
  if (!draftReasoningOverrides.has(windowId)) return undefined;
  const value = draftReasoningOverrides.get(windowId) ?? null;
  draftReasoningOverrides.delete(windowId);
  return value;
}
