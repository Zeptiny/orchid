/**
 * ToolRail — collapsible side rail for tool-call widgets.
 *
 * Sits between ChatStream and Sidebar in the layout.
 * Auto-opens when a tool call occurs.
 * Width: 40% of window width (min 300px, max 600px).
 * Resizable via drag handle.
 * Multiple tool calls: show tabs in the rail.
 * Collapse button minimizes to tool name + summary.
 *
 * Each tool call is a structured persisted event — sessions replay
 * exact widget state on restore.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import type { ToolCallEvent } from './types';
import { ToolWidgetContainer } from './ToolWidgetContainer';

// ── Props ────────────────────────────────────────────────────────────────────

interface ToolRailProps {
  /** List of tool call events to display. */
  events: ToolCallEvent[];
  /** Whether the rail is open. */
  isOpen: boolean;
  /** Callback to open the rail. */
  onOpen: () => void;
  /** Callback to close the rail. */
  onClose: () => void;
  /** Optional callback for navigating to file:line (grep results). */
  onNavigate?: (file: string, line: number) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ToolRail({
  events,
  isOpen,
  onOpen,
  onClose,
  onNavigate,
}: ToolRailProps) {
  const [width, setWidth] = useState(400);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const isDraggingRef = useRef(false);
  const railRef = useRef<HTMLDivElement>(null);

  // Auto-open when new events arrive
  useEffect(() => {
    if (events.length > 0 && !isOpen) {
      onOpen();
    }
  }, [events.length, isOpen, onOpen]);

  // Auto-select the latest event
  useEffect(() => {
    if (events.length > 0) {
      setActiveIndex(events.length - 1);
    }
  }, [events.length]);

  // Clamp width to min/max
  const clampedWidth = useMemo(() => {
    return Math.max(300, Math.min(600, width));
  }, [width]);

  // Drag resize
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      // Rail is on the right side of chat, so we measure from right edge
      const windowWidth = window.innerWidth;
      const newWidth = windowWidth - moveEvent.clientX;
      setWidth(Math.max(300, Math.min(600, newWidth)));
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Toggle collapse for a specific event
  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // If no events, don't render
  if (events.length === 0) return null;

  const activeEvent = events[activeIndex];

  return (
    <div
      ref={railRef}
      className={`tool-rail ${isOpen ? 'open' : 'closed'}`}
      style={{ width: isOpen ? clampedWidth : 0 }}
    >
      {/* Drag handle (left edge) */}
      <div
        className="tool-rail-drag-handle"
        onMouseDown={handleDragStart}
        role="separator"
        aria-orientation="vertical"
        tabIndex={0}
      />

      {/* Rail content */}
      {isOpen && (
        <div className="tool-rail-content">
          {/* Header with tabs */}
          <div className="tool-rail-header">
            <div className="tool-rail-tabs">
              {events.map((event, i) => (
                <button
                  key={event.id}
                  className={`tool-rail-tab ${i === activeIndex ? 'active' : ''}`}
                  onClick={() => setActiveIndex(i)}
                  title={event.toolName}
                >
                  <span className="tool-rail-tab-icon">&#9881;</span>
                  <span className="tool-rail-tab-name">{event.toolName}</span>
                  {event.status === 'running' && (
                    <span className="spinner tool-rail-tab-spinner" />
                  )}
                </button>
              ))}
            </div>
            <button
              className="btn btn-ghost btn-sm tool-rail-close"
              onClick={onClose}
              title="Close tool rail"
            >
              &#10005;
            </button>
          </div>

          {/* Active widget */}
          {activeEvent && (
            <div className="tool-rail-widget">
              <ToolWidgetContainer
                event={activeEvent}
                isCollapsed={collapsedIds.has(activeEvent.id)}
                onToggleCollapse={() => toggleCollapse(activeEvent.id)}
                onNavigate={onNavigate}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
