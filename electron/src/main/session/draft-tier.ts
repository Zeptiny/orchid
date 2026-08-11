/** Window-scoped service tier overrides chosen before a session exists (R21). */
const draftTierOverrides = new Map<string, string | null>();

export function setDraftTierOverride(windowId: string, tier: string | null): void {
  draftTierOverrides.set(windowId, tier);
}

export function getDraftTierOverride(windowId: string): string | null {
  return draftTierOverrides.get(windowId) ?? null;
}

export function clearDraftTierOverrides(): void {
  draftTierOverrides.clear();
}

/** Consume the override when a draft is promoted into a session. */
export function takeDraftTierOverride(windowId: string): string | null | undefined {
  if (!draftTierOverrides.has(windowId)) return undefined;
  const value = draftTierOverrides.get(windowId) ?? null;
  draftTierOverrides.delete(windowId);
  return value;
}
