/**
 * useToolRail — manages tool-call events for the side rail.
 *
 * Features:
 * - Accumulates tool call events from IPC streams
 * - Manages rail open/close state
 * - Provides navigation callback for grep results
 * - Persists events for session replay
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import type { ToolCallEvent } from '../components/ToolWidgets/types';

// ── Types ────────────────────────────────────────────────────────────────────

export interface UseToolRailReturn {
  /** All tool call events in the current chain. */
  events: ToolCallEvent[];
  /** Whether the tool rail is open. */
  isOpen: boolean;
  /** Open the tool rail. */
  open: () => void;
  /** Close the tool rail. */
  close: () => void;
  /** Toggle the tool rail. */
  toggle: () => void;
  /** Add a new tool call event (called when a tool call starts). */
  addEvent: (event: ToolCallEvent) => void;
  /** Update an existing event's status/result. */
  updateEvent: (id: string, update: Partial<ToolCallEvent>) => void;
  /** Clear all events (on session switch). */
  clearEvents: () => void;
  /** Set events from a restored session. */
  setEvents: (events: ToolCallEvent[]) => void;
  /** Navigate to file:line (for grep results). */
  onNavigate: (file: string, line: number) => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useToolRail(): UseToolRailReturn {
  const [events, setEventsState] = useState<ToolCallEvent[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const eventsRef = useRef(events);

  // Keep ref in sync
  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);

  const addEvent = useCallback((event: ToolCallEvent) => {
    setEventsState((prev) => [...prev, event]);
    // Auto-open rail when a new tool call arrives
    setIsOpen(true);
  }, []);

  const updateEvent = useCallback(
    (id: string, update: Partial<ToolCallEvent>) => {
      setEventsState((prev) =>
        prev.map((e) => (e.id === id ? { ...e, ...update } : e)),
      );
    },
    [],
  );

  const clearEvents = useCallback(() => {
    setEventsState([]);
    setIsOpen(false);
  }, []);

  const setEvents = useCallback((newEvents: ToolCallEvent[]) => {
    setEventsState(newEvents);
    if (newEvents.length > 0) {
      setIsOpen(true);
    }
  }, []);

  // Navigation callback for grep results
  const onNavigate = useCallback((file: string, line: number) => {
    // Dispatch a custom event that the app can listen to for file navigation
    window.dispatchEvent(
      new CustomEvent('orchid:navigate-file', {
        detail: { file, line },
      }),
    );
  }, []);

  return {
    events,
    isOpen,
    open,
    close,
    toggle,
    addEvent,
    updateEvent,
    clearEvents,
    setEvents,
    onNavigate,
  };
}
