/**
 * Context radial button — the ring + dropup breakdown shared by the chat
 * footer and the subagent view detail header (issue 168).
 *
 * The panel is fixed-positioned from the trigger rect and rendered through a
 * portal to document.body: ancestors like the subagent view's container-type
 * containment (or view-enter transform animations) would otherwise become the
 * containing block for fixed descendants and skew the coordinates off-screen.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import type { Message, Usage } from '../../shared/types/message';
import { contextUsedTokens } from '../../shared/usage';
import { ContextBreakdownView, contextPercent } from './ContextGrid';
import { Icon } from './Icon';
import { Button } from './ui/Button';
import { StatusBadge } from './ui/StatusBadge';

/** Panel gap above the trigger (mirrors the footer dropup's mb-1). */
const PANEL_GAP_PX = 4;
/** Floor for the clamped height so tiny viewports keep a usable sliver. */
const PANEL_MIN_HEIGHT_PX = 96;
/** Must stay in sync with `.orchid-footer-context-panel` width. */
const PANEL_MAX_WIDTH_PX = 300;
const PANEL_VIEWPORT_RATIO = 0.8;

/** Fixed-panel anchor derived from the trigger rect, with viewport clamps. */
interface PanelAnchor {
  right: number;
  /** Distance from the viewport top for a downward panel. */
  top?: number;
  /** Distance from the viewport bottom for an upward panel. */
  bottom?: number;
  maxHeight: number;
}

interface ContextRadialButtonProps {
  usage?: Usage | null;
  messages?: readonly Message[];
  maxContext?: number | null;
  streamingThinkingChars?: number;
  className?: string;
}

function contextToneClass(percent: number | null, usedTokens: number): string {
  if (percent == null) return usedTokens > 0 ? 'text-info' : 'text-base-content/25';
  if (percent >= 85) return 'text-error';
  if (percent >= 60) return 'text-warning';
  return percent > 0 ? 'text-info' : 'text-base-content/25';
}

function badgeTone(percent: number | null): 'error' | 'warning' | 'info' | 'neutral' {
  if (percent == null) return 'neutral';
  if (percent >= 85) return 'error';
  if (percent >= 60) return 'warning';
  return percent > 0 ? 'info' : 'neutral';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * Anchor the panel on the side of the trigger with more room: upward when the
 * trigger sits in the lower half of the viewport (the footer case), downward
 * otherwise (the subagent detail header). Both directions clamp height so the
 * panel scrolls internally instead of leaving the viewport.
 */
function anchorFromRect(rect: DOMRect): PanelAnchor {
  const viewportWidth = window.innerWidth || PANEL_MAX_WIDTH_PX;
  const viewportHeight = window.innerHeight || PANEL_MAX_WIDTH_PX;
  const panelWidth = Math.min(PANEL_MAX_WIDTH_PX, viewportWidth * PANEL_VIEWPORT_RATIO);
  const maxRight = Math.max(0, viewportWidth - panelWidth);
  const right = Math.max(0, Math.min(viewportWidth - rect.right, maxRight));
  return rect.top > viewportHeight / 2
    ? {
        right,
        bottom: Math.max(0, viewportHeight - rect.top + PANEL_GAP_PX),
        maxHeight: Math.max(PANEL_MIN_HEIGHT_PX, rect.top - 2 * PANEL_GAP_PX),
      }
    : {
        right,
        top: Math.max(0, rect.bottom + PANEL_GAP_PX),
        maxHeight: Math.max(PANEL_MIN_HEIGHT_PX, viewportHeight - rect.bottom - 2 * PANEL_GAP_PX),
      };
}

export function ContextRadialButton({
  usage,
  messages,
  maxContext,
  streamingThinkingChars,
  className = '',
}: ContextRadialButtonProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PanelAnchor | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const usedTokens = contextUsedTokens(usage);
  const percent = contextPercent(usage, maxContext);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor(anchorFromRect(rect));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The panel lives in a portal outside rootRef — check both subtrees.
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const reposition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setAnchor(anchorFromRect(rect));
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const label = percent == null
    ? usedTokens > 0
      ? `${formatTokens(usedTokens)} context tokens used; context window loading`
      : 'Context usage unavailable'
    : `${percent}% context used`;

  return (
    <div ref={rootRef} data-context-radial-dropup className={`shrink-0 ${className}`.trim()}>
      <Button
        ref={triggerRef}
        variant="ghost"
        shape="circle"
        size="xs"
        className="orchid-footer-context-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        title={percent == null
          ? usedTokens > 0
            ? `${formatTokens(usedTokens)} context tokens used`
            : 'Context usage unavailable'
          : `${percent}% context`}
        onClick={toggle}
      >
        <div
          className={`radial-progress orchid-footer-context-radial ${contextToneClass(percent, usedTokens)}`}
          style={
            {
              '--value': percent ?? 0,
              '--size': '1.4rem',
              '--thickness': '2px',
            } as CSSProperties
          }
          aria-valuenow={percent ?? 0}
          role="progressbar"
          aria-label={label}
        >
          <span className="footer-context-value">
            {percent == null ? '—' : percent}
          </span>
        </div>
      </Button>
      {open && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Context breakdown"
          className="orchid-footer-context-panel z-50"
          style={anchor
            ? {
                position: 'fixed',
                right: `${anchor.right}px`,
                maxHeight: `${anchor.maxHeight}px`,
                overflowY: 'auto',
                ...(anchor.bottom != null
                  ? { bottom: `${anchor.bottom}px` }
                  : { top: `${anchor.top}px` }),
              }
            : { position: 'fixed', visibility: 'hidden' }}
        >
          <div className="footer-context-panel-header">
            <div className="footer-context-panel-title">
              <Icon name="layers" size={12} className="opacity-70" />
              <span>Context</span>
            </div>
            <div className="footer-context-panel-meta mono">
              <StatusBadge tone={badgeTone(percent)} size="xs">
                {percent == null
                  ? usedTokens > 0
                    ? `${formatTokens(usedTokens)} used`
                    : 'window loading'
                  : `${percent}% used`}
              </StatusBadge>
              {maxContext && maxContext > 0 ? (
                <span className="footer-context-panel-window">
                  {formatTokens(maxContext)} window
                </span>
              ) : null}
            </div>
          </div>
          <div className="footer-context-panel-body">
            <ContextBreakdownView
              usage={usage}
              messages={messages}
              maxContext={maxContext}
              streamingThinkingChars={streamingThinkingChars}
              variant="panel"
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
