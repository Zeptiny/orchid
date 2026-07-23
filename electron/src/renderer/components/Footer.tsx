/**
 * Footer — chat footer at the bottom of the center pane.
 *
 * Left: keyboard shortcuts (idle) or agent / interrupt status (streaming).
 * Right: model picker + context radial with dropup breakdown.
 * Wording mirrors the multi-stage cancel button on the composer.
 */
import { useCallback, useEffect, useId, useState, type CSSProperties } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import type { CommandContext } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption, SessionReasoningConfigResult } from '../../shared/types/ipc';
import type { PermissionMode } from '../../shared/types/permission';
import { useElapsedSeconds, type InterruptState } from '../hooks/useChat';
import { FOOTER_SHORTCUT_IDS, getShortcut } from '../keyboard';
import { resolveModelNotifyLabel } from '../utils/provider-selection';
import { ContextLegend, ContextStackedBar, contextPercent as getContextPercent } from './ContextGrid';
import { contextUsedTokens } from '../../shared/usage';
import { Icon } from './Icon';
import { Keycaps } from './Keycaps';
import { ModelPicker } from './ModelPicker';
import { PermissionSelector } from './PermissionSelector';
import { ReasoningSelector, shouldShowReasoningSelector } from './ReasoningSelector';
import { Button } from './ui/Button';
import { Spinner } from './ui/Spinner';
import { StatusBadge } from './ui/StatusBadge';

interface PermissionBridge {
  setSessionMode?: (message: {
    sessionId: string | null;
    mode: PermissionMode | null;
  }) => Promise<unknown>;
}

interface FooterProps {
  /** Stream start (ms epoch); footer ticks elapsed locally at 1s while streaming. */
  streamStartTime?: number | null;
  isStreaming: boolean;
  /** Current interrupt confirmation phase (from staged Esc / cancel flow). */
  interruptState?: InterruptState;
  usage?: Usage | null;
  maxContext?: number | null;
  messages?: readonly Message[];
  streamingThinkingChars?: number;
  model?: string;
  modelLabels?: Readonly<Record<string, string>>;
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
  commandContext?: CommandContext;
  sessionId?: string | null;
}

export function Footer({
  streamStartTime = null,
  isStreaming,
  interruptState,
  usage,
  maxContext,
  messages = [],
  streamingThinkingChars,
  model = '',
  modelLabels,
  modelDetails,
  commandContext,
  sessionId,
}: FooterProps) {
  const confirming = interruptState && interruptState !== 'idle';
  const elapsedSeconds = useElapsedSeconds(streamStartTime, isStreaming || Boolean(confirming));
  const [contextOpen, setContextOpen] = useState(false);
  const contextMenuId = useId();
  const [reasoningConfig, setReasoningConfig] = useState<SessionReasoningConfigResult | null>(null);
  const [sessionPermissionMode, setSessionPermissionMode] = useState<PermissionMode | null>(null);

  const usedContextTokens = contextUsedTokens(usage);
  const contextPercent = getContextPercent(usage, maxContext);

  const contextTone =
    contextPercent == null
      ? usedContextTokens > 0 ? 'text-info' : 'text-base-content/25'
      : contextPercent >= 85
        ? 'text-error'
        : contextPercent >= 60
          ? 'text-warning'
          : contextPercent > 0
            ? 'text-info'
            : 'text-base-content/25';

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

  useEffect(() => {
    let cancelled = false;
    const session = window.orchid?.session;
    if (!session?.getReasoningConfig) {
      setReasoningConfig(null);
      return;
    }
    session
      .getReasoningConfig()
      .then((config) => {
        if (!cancelled) setReasoningConfig(config);
      })
      .catch(() => {
        if (!cancelled) setReasoningConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [model, sessionId]);

  const badgeTone =
    contextPercent != null && contextPercent >= 85
      ? 'error'
      : contextPercent != null && contextPercent >= 60
        ? 'warning'
        : contextPercent != null && contextPercent > 0
          ? 'info'
          : 'neutral';

  const availableModels = commandContext?.getAvailableModels() ?? [];

  const handleSelectModel = useCallback(
    async (next: string) => {
      if (!commandContext || next === model) return;
      try {
        await commandContext.onSetModel(next);
        commandContext.onNotify(
          `Model changed to ${resolveModelNotifyLabel(next, modelDetails, modelLabels)}`,
          'info',
        );
      } catch {
        // Non-fatal — parent may already toast
      }
    },
    [commandContext, model, modelDetails, modelLabels],
  );

  const handleReasoningChange = useCallback(
    async (next: string | number | null) => {
      try {
        await window.orchid?.session?.setReasoningEffort({ effort: next });
        setReasoningConfig((prev) => (prev ? { ...prev, override: next } : prev));
      } catch {
        // Non-fatal — selector keeps the last good value
      }
    },
    [],
  );

  const handlePermissionModeChange = useCallback(
    (next: PermissionMode | null) => {
      setSessionPermissionMode(next);
      const permission = (window.orchid as { permission?: PermissionBridge }).permission;
      permission?.setSessionMode?.({ sessionId: sessionId ?? null, mode: next })?.catch(() => {});
    },
    [sessionId],
  );

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
                <Spinner size="xs" aria-hidden />
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

      <div className="orchid-chat-footer-end shrink-0 flex items-center gap-1.5">
        <PermissionSelector
          value={sessionPermissionMode}
          defaultValue="ask-when-flagged"
          onChange={handlePermissionModeChange}
        />
        {reasoningConfig && shouldShowReasoningSelector(reasoningConfig) && (
          <ReasoningSelector
            levels={reasoningConfig.levels}
            value={reasoningConfig.override}
            defaultValue={reasoningConfig.default}
            onChange={(next) => void handleReasoningChange(next)}
            disabled={isStreaming || interruptState === 'confirmAgent'}
          />
        )}
        {commandContext && (
          <ModelPicker
            value={model}
            options={availableModels}
            optionLabels={modelLabels}
            optionDetails={modelDetails}
            onChange={(next) => void handleSelectModel(next)}
            placement="top"
            align="end"
            label="Select model"
            showSelectedContext={false}
            disabled={isStreaming || interruptState === 'confirmAgent'}
            className="orchid-footer-model-picker"
          />
        )}

      <div
        className={`dropdown dropdown-top dropdown-end shrink-0 ${contextOpen ? 'dropdown-open' : ''}`}
        data-footer-context-dropup
      >
        <Button
          variant="ghost"
          shape="circle"
          size="xs"
          className="orchid-footer-context-btn"
          aria-haspopup="dialog"
          aria-expanded={contextOpen}
          aria-controls={contextMenuId}
          title={contextPercent == null
            ? usedContextTokens > 0
              ? `${formatTokens(usedContextTokens)} context tokens used`
              : 'Context usage unavailable'
            : `${contextPercent}% context`}
          onClick={() => setContextOpen((o) => !o)}
        >
          <div
            className={`radial-progress orchid-footer-context-radial ${contextTone}`}
            style={
              {
                '--value': contextPercent ?? 0,
                '--size': '1.4rem',
                '--thickness': '2px',
              } as CSSProperties
            }
            aria-valuenow={contextPercent ?? 0}
            role="progressbar"
            aria-label={contextPercent == null
              ? usedContextTokens > 0
                ? `${formatTokens(usedContextTokens)} context tokens used; context window loading`
                : 'Context usage unavailable'
              : `${contextPercent}% context used`}
          >
            <span className="footer-context-value">
              {contextPercent == null ? '—' : contextPercent}
            </span>
          </div>
        </Button>
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
                  {contextPercent == null
                    ? usedContextTokens > 0
                      ? `${formatTokens(usedContextTokens)} used`
                      : 'window loading'
                    : `${contextPercent}% used`}
                </StatusBadge>
                {maxContext && maxContext > 0 ? (
                  <span className="footer-context-panel-window">
                    {formatTokens(maxContext)} window
                  </span>
                ) : null}
              </div>
            </div>
            <div className="footer-context-panel-body">
              <ContextStackedBar
                usage={usage}
                messages={messages}
                maxContext={maxContext}
                streamingThinkingChars={streamingThinkingChars}
              />
              <ContextLegend
                usage={usage}
                messages={messages}
                maxContext={maxContext}
                streamingThinkingChars={streamingThinkingChars}
                variant="panel"
              />
            </div>
          </div>
        )}
      </div>
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
