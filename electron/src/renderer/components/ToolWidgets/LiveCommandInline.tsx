/**
 * LiveCommandInline — compact collapsible terminal widget for inline display.
 *
 * Renders a live command's output directly in the chat message stream (not in
 * the ToolRail). Background targets (`commandId`) are process-liveness
 * widgets with session-bound user controls: single-line stdin for running
 * interactive (PTY) commands, Stop, and input-ownership release. Foreground
 * targets (`toolCallId`) render output only. Display output is ANSI-stripped;
 * agent-visible buffers stay untouched.
 *
 * Features:
 * - Collapsible with command name + status in header
 * - Shows last N lines of output in a terminal-like pre block
 * - Exit code displayed when finished
 * - 200ms throttle on updates
 * - Compact inline mode (no xterm.js — simple <pre> to avoid heavyweight deps)
 */
import { useCallback, useId, useMemo, useState, type FormEvent } from 'react';
import {
  useLiveCommandOutput,
  type LiveCommandTarget,
} from '../../hooks/useLiveCommandOutput';
import { stripAnsi } from '../../utils/ansi-strip';
import type { BgCommandSendInputResult } from '../../../shared/types/ipc';
import { CollapsibleRegion } from '../ui/CollapsibleRegion';
import { Spinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import { Button } from '../ui/Button';

// ── Props ────────────────────────────────────────────────────────────────────

interface LiveCommandInlineProps {
  /** Live command to render: background `commandId` or foreground `toolCallId`. */
  target: LiveCommandTarget;
  /** Owning session the command's visibility and controls resolve against. */
  sessionId: string | null;
  /** The command text (from the parsed attributes). */
  commandText: string;
  /** Optional description (from the parsed attributes). */
  description?: string;
  /**
   * Persisted spawn time (epoch ms) for replayed background commands. Guards
   * against commandId reuse after an app restart aliasing this widget onto an
   * unrelated live process.
   */
  expectedCreatedAt?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const INPUT_FAILURE_HINTS: Record<
  Extract<BgCommandSendInputResult, { ok: false }>['reason'],
  string
> = {
  not_found: 'command unavailable',
  not_interactive: 'command is not interactive',
  exited: 'command already exited',
  write_failed: 'input write failed',
};

// ── Component ────────────────────────────────────────────────────────────────

export function LiveCommandInline({
  target,
  sessionId,
  commandText,
  description,
  expectedCreatedAt,
}: LiveCommandInlineProps) {
  const [expanded, setExpanded] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [inputHint, setInputHint] = useState<string | null>(null);
  const panelId = useId();

  const isBackground = 'commandId' in target;
  const commandId = isBackground ? target.commandId : null;

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Keep lifecycle status current while collapsed, but refresh the output tail
  // only while the command body is visible.
  const { output, exitCode, isRunning, isAvailable, interactive, owner, refresh } =
    useLiveCommandOutput(target, sessionId, true, expanded, expectedCreatedAt);

  // Build title: matches Python's _build_title()
  const title = useMemo(() => {
    const cmdDisplay = commandText
      ? `$ ${commandText}`
      : description || (commandId !== null ? `Command #${commandId}` : 'Command');

    if (!isAvailable) {
      return `${cmdDisplay} (unavailable)`;
    }
    if (!isRunning) {
      const status =
        exitCode !== null ? `exit ${exitCode}` : 'exited';
      return `${cmdDisplay} (${status})`;
    }
    return `${cmdDisplay} (running)`;
  }, [commandId, commandText, description, isRunning, isAvailable, exitCode]);

  // Compute visible output (last N lines), ANSI-stripped for display
  const displayOutput = useMemo(() => {
    if (!output) return '';
    const lines = stripAnsi(output).split('\n');
    return lines.slice(-30).join('\n');
  }, [output]);

  // Controls are background-only: foreground mirrors have no stdin and no
  // user terminate.
  const showInput = isBackground && interactive && isRunning && isAvailable;
  const showStop = isBackground && isRunning && isAvailable;
  const showRelease = isBackground && owner === 'USER';

  const handleSendInput = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (commandId === null || !window.orchid?.bgCmd) return;
      try {
        const result = await window.orchid.bgCmd.sendInput({
          commandId,
          text: `${inputValue}\n`,
          ...(sessionId ? { sessionId } : {}),
        });
        if (result.ok) {
          setInputValue('');
          setInputHint(null);
        } else {
          setInputHint(INPUT_FAILURE_HINTS[result.reason] ?? 'input rejected');
        }
      } catch {
        setInputHint('input failed');
      }
      refresh();
    },
    [commandId, sessionId, inputValue, refresh],
  );

  const handleStop = useCallback(async () => {
    if (commandId === null || !window.orchid?.bgCmd) return;
    try {
      await window.orchid.bgCmd.terminate({
        commandId,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch {
      // Non-fatal — the next poll reflects current state
    }
    refresh();
  }, [commandId, sessionId, refresh]);

  const handleRelease = useCallback(async () => {
    if (commandId === null || !window.orchid?.bgCmd) return;
    try {
      await window.orchid.bgCmd.releaseInput({
        commandId,
        ...(sessionId ? { sessionId } : {}),
      });
    } catch {
      // Non-fatal — the next poll reflects current state
    }
    refresh();
  }, [commandId, sessionId, refresh]);

  return (
    <div className="orchid-live-command">
      <button
        type="button"
        className="orchid-live-command-title"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="font-mono text-xs min-w-0 truncate">{title}</span>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          {owner === 'USER' && (
            <span className="orchid-live-command-owner">input: you</span>
          )}
          <span key={isRunning ? 'running' : `exit-${exitCode ?? 'unknown'}`} className="orchid-tool-lifecycle-icon">
            {isRunning && isAvailable && <Spinner size="xs" variant="dots" />}
            {!isRunning && exitCode === 0 && <StatusBadge tone="success" size="xs">ok</StatusBadge>}
            {!isRunning && exitCode !== null && exitCode !== 0 && <StatusBadge tone="error" size="xs">fail</StatusBadge>}
          </span>
        </span>
      </button>
      <CollapsibleRegion open={expanded} id={panelId}>
        <div className="orchid-live-command-body">
          <pre className="orchid-live-command-pre">
            {displayOutput || (!isAvailable
              ? isBackground
                ? '(background command is no longer available)'
                : '(command output is no longer available)'
              : isRunning ? '(waiting for output...)' : '(no output)')}
          </pre>
          {!isRunning && exitCode !== null && (
            <div className="orchid-live-command-exit">
              Process exited with code {exitCode}
            </div>
          )}
          {isBackground && (showInput || showStop || showRelease) && (
            <div className="orchid-live-command-controls">
              {showInput ? (
                <form
                  className="orchid-live-command-input-row"
                  onSubmit={(event) => void handleSendInput(event)}
                >
                  <input
                    type="text"
                    className="orchid-live-command-input"
                    value={inputValue}
                    placeholder="Send a line of input"
                    aria-label={`Send input to ${commandText || 'command'}`}
                    onChange={(event) => setInputValue(event.target.value)}
                  />
                  <Button type="submit" size="xs" variant="primary">
                    Send
                  </Button>
                </form>
              ) : (
                <span className="flex-1" aria-hidden="true" />
              )}
              {showRelease && (
                <Button size="xs" variant="ghost" onClick={() => void handleRelease()}>
                  Release
                </Button>
              )}
              {showStop && (
                <Button size="xs" variant="error" onClick={() => void handleStop()}>
                  Stop
                </Button>
              )}
            </div>
          )}
          {inputHint && (
            <div className="orchid-live-command-hint">{inputHint}</div>
          )}
        </div>
      </CollapsibleRegion>
    </div>
  );
}
