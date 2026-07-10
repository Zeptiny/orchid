/**
 * Register window-level shortcut handlers from the central registry.
 */
import { useEffect, useRef } from 'react';
import { eventMatchesChord, isEditableTarget } from './match';
import { getShortcut } from './registry';
import type { ShortcutDef } from './types';

export type ShortcutHandlerMap = Partial<Record<string, (event: KeyboardEvent) => void>>;

export interface UseGlobalShortcutsOptions {
  /** Map of shortcut id → handler. Missing ids are ignored. */
  handlers: ShortcutHandlerMap;
  /** When false, no listeners are attached. Default true. */
  enabled?: boolean;
  /**
   * Extra predicate; return false to skip handling (e.g. overlay open).
   * Called after chord match, before handler.
   */
  isEnabled?: (id: string, def: ShortcutDef, event: KeyboardEvent) => boolean;
}

/**
 * Attaches a single keydown listener that dispatches to handlers by registry id.
 * First matching registered id wins (iteration order of `handlers` keys).
 */
export function useGlobalShortcuts({
  handlers,
  enabled = true,
  isEnabled,
}: UseGlobalShortcutsOptions): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const isEnabledRef = useRef(isEnabled);
  isEnabledRef.current = isEnabled;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      const map = handlersRef.current;
      const ids = Object.keys(map).filter((id) => typeof map[id] === 'function');

      for (const id of ids) {
        const def = getShortcut(id);
        if (!def) continue;

        const chords = [def.chord, ...(def.aliases ?? [])];
        const matched = chords.some((c) => eventMatchesChord(event, c));
        if (!matched) continue;

        if (!def.allowInEditable && isEditableTarget(event.target)) {
          continue;
        }

        const gate = isEnabledRef.current;
        if (gate && !gate(id, def, event)) {
          continue;
        }

        const handler = map[id];
        if (!handler) continue;

        event.preventDefault();
        handler(event);
        return;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
