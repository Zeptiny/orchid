/**
 * LiveCommandInline — compact collapsible terminal widget for inline display.
 *
 * Renders a background command's live output directly in the chat message
 * stream (not in the ToolRail). Matches Python's LiveCommandOutputWidget
 * styling: Collapsible matching ToolResultMessageWidget style.
 *
 * Features:
 * - Collapsible with command name + status in header
 * - Shows last N lines of output in a terminal-like pre block
 * - Exit code displayed when finished
 * - 200ms throttle on updates (matching Python)
 * - Compact inline mode (no xterm.js — simple <pre> to avoid heavyweight deps)
 */
import { useState, useCallback, useMemo, useId } from 'react';
import { useLiveCommandOutput } from '../../hooks/useLiveCommandOutput';
import { Spinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';

// ── Props ────────────────────────────────────────────────────────────────────

interface LiveCommandInlineProps {
  /** The background command ID parsed from tool result content. */
  commandId: number;
  /** The command text (from the parsed attributes). */
  commandText: string;
  /** Optional description (from the parsed attributes). */
  description?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

export function LiveCommandInline({
  commandId,
  commandText,
  description,
}: LiveCommandInlineProps) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // Poll for live output
  const { output, exitCode, isRunning } = useLiveCommandOutput(
    commandId,
    true, // always enabled when component mounts
  );

  // Build title: matches Python's _build_title()
  const title = useMemo(() => {
    const cmdDisplay =
      commandText
        ? `$ ${commandText}`
        : description || `Command #${commandId}`;

    if (!isRunning) {
      const status =
        exitCode !== null ? `exit ${exitCode}` : 'exited';
      return `${cmdDisplay} (${status})`;
    }
    return `${cmdDisplay} (running)`;
  }, [commandId, commandText, description, isRunning, exitCode]);

  // Compute visible output (last N lines)
  const displayOutput = useMemo(() => {
    if (!output) return '';
    const lines = output.split('\n');
    // Show last 30 lines when collapsed hint, all when expanded
    return lines.slice(-30).join('\n');
  }, [output]);

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
          {isRunning && (
            <Spinner size="xs" variant="dots" />
          )}
          {!isRunning && exitCode === 0 && (
            <StatusBadge tone="success" size="xs">ok</StatusBadge>
          )}
          {!isRunning && exitCode !== null && exitCode !== 0 && (
            <StatusBadge tone="error" size="xs">fail</StatusBadge>
          )}
        </span>
      </button>
      {expanded && (
        <div id={panelId} className="orchid-live-command-body">
          <pre className="orchid-live-command-pre">
            {displayOutput || (isRunning ? '(waiting for output...)' : '(no output)')}
          </pre>
          {!isRunning && exitCode !== null && (
            <div className="orchid-live-command-exit">
              Process exited with code {exitCode}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
