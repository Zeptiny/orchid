/** Window-scoped draft override store — set/get/clear/take per window id. */
export function createDraftOverrideStore<Value>() {
  const overrides = new Map<string, Value | null>();

  return {
    set(windowId: string, value: Value | null): void {
      overrides.set(windowId, value);
    },
    get(windowId: string): Value | null {
      return overrides.get(windowId) ?? null;
    },
    clear(): void {
      overrides.clear();
    },
    /** Consume the override when a draft is promoted into a session. */
    take(windowId: string): Value | null | undefined {
      if (!overrides.has(windowId)) return undefined;
      const value = overrides.get(windowId) ?? null;
      overrides.delete(windowId);
      return value;
    },
  };
}
