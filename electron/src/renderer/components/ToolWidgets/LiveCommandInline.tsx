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
import { useState, useCallback, useMemo } from 'react';
import { useLiveCommandOutput } from '../../hooks/useLiveCommandOutput';

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
    <div
      className="collapse collapse-arrow bg-base-200 my-1"
      style={{ fontSize: '13px' }}
    >
      <input type="checkbox" checked={expanded} onChange={toggle} />
      <div className="collapse-title text-sm font-medium flex items-center gap-2">
        <span
          className="text-xs"
          style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
        >
          {title}
        </span>
        {isRunning && (
          <span className="loading loading-dots loading-xs" />
        )}
        {!isRunning && exitCode === 0 && (
          <span className="text-success text-xs">✓</span>
        )}
        {!isRunning && exitCode !== null && exitCode !== 0 && (
          <span className="text-error text-xs">✗</span>
        )}
      </div>
      <div className="collapse-content p-0">
        <pre
          className="text-xs overflow-x-auto p-3 bg-base-300 rounded-b-lg whitespace-pre-wrap"
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            maxHeight: '300px',
            overflowY: 'auto',
          }}
        >
          {displayOutput || (isRunning ? '(waiting for output...)' : '(no output)')}
        </pre>
        {!isRunning && exitCode !== null && (
          <div className="px-3 py-1 text-xs opacity-60 border-t border-base-content/10">
            Process exited with code {exitCode}
          </div>
        )}
      </div>
    </div>
  );
}
