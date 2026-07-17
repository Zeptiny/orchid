/**
 * Footer — chat footer at the bottom of the center pane.
 *
 * Left: keyboard shortcuts (idle) or agent / interrupt status (streaming).
 * Right: context radial (always visible) with dropup breakdown.
 * Wording mirrors the multi-stage cancel button on the composer.
 */
import { useEffect, useId, useState, type CSSProperties } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import type { InterruptState } from '../hooks/useChat';
import { FOOTER_SHORTCUT_IDS, getShortcut } from '../keyboard';
import { ContextLegend } from './ContextGrid';
import { contextUsedTokens } from '../../shared/usage';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';
import { StatusBadge } from './ui/StatusBadge';

interface FooterProps {
  elapsedSeconds: number;
  isStreaming: boolean;
  /** Current interrupt confirmation phase (from staged Esc / cancel flow). */
  interruptState?: InterruptState;
  usage?: Usage | null;
  maxContext?: number | null;
  messages?: readonly Message[];
}

export function Footer({
  elapsedSeconds,
  isStreaming,
  interruptState,
  usage,
  maxContext,
  messages = [],
}: FooterProps) {
  const confirming = interruptState && interruptState !== 'idle';
  const [contextOpen, setContextOpen] = useState(false);
  const contextMenuId = useId();

  const contextPercent =
    usage && maxContext && maxContext > 0
      ? Math.min(100, Math.round((contextUsedTokens(usage) / maxContext) * 100))
      : 0;

  const radialTone =
    contextPercent >= 85
      ? 'text-error'
      : contextPercent >= 60
        ? 'text-warning'
        : contextPercent > 0
          ? 'text-info'
          : 'text-base-content/40';

  useEffect(() => {
    if (!contextOpen) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-footer-context-dropup]')) {
        setContextOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [contextOpen]);

  const badgeTone =
    contextPercent >= 85
      ? 'error'
      : contextPercent >= 60
        ? 'warning'
        : contextPercent > 0
          ? 'info'
          : 'neutral';

  return (
    <div className="orchid-chat-footer">
      <div className="orchid-chat-footer-main min-w-0 flex-1 flex items-center gap-2 overflow-hidden">
        {isStreaming || confirming ? (
          <>
            {confirming ? (
              <span className="interrupt-hint inline-flex items-center gap-1 font-medium text-warning shrink-0">
                <Icon name="alert" size={12} />
                {interruptState === 'confirmSubagents'
                  ? 'Esc / ■ again: cancel subagents'
                  : 'Esc / ■ again: cancel agent'}
              </span>
            ) : (
              <span className="agent-status inline-flex items-center gap-1 text-success shrink-0">
                <span className="loading loading-spinner loading-xs" aria-hidden />
                Running
              </span>
            )}
            <span className="opacity-40 shrink-0">-</span>
            <span className="shrink-0">elapsed {formatElapsed(elapsedSeconds)}</span>
            <span className="opacity-40 shrink-0">-</span>
            <span className="orchid-chat-footer-hint">
              <Keycaps chord="Esc" size="xs" />
              <span className="chat-footer-hint-sep">or</span>
              <Icon name="square" size={10} className="opacity-80 shrink-0" />
              <span className="chat-footer-hint-label">
                {interruptState === 'confirmSubagents'
                  ? 'to cancel subagents'
                  : interruptState === 'confirmAgent'
                    ? 'to confirm'
                    : 'to interrupt'}
              </span>
            </span>
          </>
        ) : (
          <>
            {FOOTER_SHORTCUT_IDS.map((id, index) => {
              const def = getShortcut(id);
              if (!def) return null;
              return (
                <span key={id} className="contents">
                  {index > 0 && (
                    <span className="chat-footer-divider" aria-hidden>
                      ·
                    </span>
                  )}
                  <span className="orchid-chat-footer-hint">
                    <Keycaps chord={def.chord} size="xs" />
                    <span className="chat-footer-hint-label">
                      {def.footerLabel ?? def.label}
                    </span>
                  </span>
                </span>
              );
            })}
          </>
        )}
      </div>

      <div
        className={`dropdown dropdown-top dropdown-end shrink-0 ${contextOpen ? 'dropdown-open' : ''}`}
        data-footer-context-dropup
      >
        <button
          type="button"
          className="orchid-footer-context-btn btn btn-ghost btn-circle btn-xs"
          aria-haspopup="dialog"
          aria-expanded={contextOpen}
          aria-controls={contextMenuId}
          title={`${contextPercent}% context`}
          onClick={() => setContextOpen((o) => !o)}
        >
          <div
            className={`radial-progress orchid-footer-context-radial ${radialTone}`}
            style={
              {
                '--value': contextPercent,
                '--size': '1.4rem',
                '--thickness': '2px',
              } as CSSProperties
            }
            aria-valuenow={contextPercent}
            role="progressbar"
            aria-label={`${contextPercent}% context used`}
          >
            <span className="footer-context-value">{contextPercent}</span>
          </div>
        </button>
        {contextOpen && (
          <div
            id={contextMenuId}
            role="dialog"
            aria-label="Context breakdown"
            className="dropdown-content orchid-footer-context-panel z-50 mb-1"
          >
            <div className="footer-context-panel-header">
              <div className="footer-context-panel-title">
                <Icon name="layers" size={12} className="opacity-70" />
                <span>Context</span>
              </div>
              <div className="footer-context-panel-meta mono">
                <StatusBadge tone={badgeTone} size="xs">
                  {contextPercent}% used
                </StatusBadge>
                {maxContext && maxContext > 0 ? (
                  <span className="footer-context-panel-window">
                    {formatTokens(maxContext)} window
                  </span>
                ) : null}
              </div>
            </div>
            <div className="footer-context-panel-body">
              <ContextLegend
                usage={usage}
                messages={messages}
                maxContext={maxContext}
                variant="panel"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
