/**
 * ToolWidgetContainer — routes to correct widget based on tool name.
 *
 * Features:
 * - Routes to DiffWidget, TerminalWidget, FilePreview, or ResultsTable
 * - Shows loading state while tool is executing
 * - Shows error state if tool fails
 * - Shows collapsed summary when rail is minimized
 *
 * Falls back to a generic JSON view for unknown tools.
 */
import type { ToolCallEvent } from './types';
import {
  DIFF_TOOLS,
  TERMINAL_TOOLS,
  FILE_PREVIEW_TOOLS,
  RESULTS_TABLE_TOOLS,
} from './types';
import { DiffWidget } from './DiffWidget';
import { TerminalWidget } from './TerminalWidget';
import { FilePreview } from './FilePreview';
import { ResultsTable } from './ResultsTable';

// ── Props ────────────────────────────────────────────────────────────────────

interface ToolWidgetContainerProps {
  /** The tool call event to render. */
  event: ToolCallEvent;
  /** Whether the widget is collapsed. */
  isCollapsed: boolean;
  /** Callback to toggle collapse state. */
  onToggleCollapse: () => void;
  /** Optional callback for navigating to file:line (grep results). */
  onNavigate?: (file: string, line: number) => void;
}

// ── Generic JSON view for unknown tools ──────────────────────────────────────

function GenericToolWidget({ event }: { event: ToolCallEvent }) {
  return (
    <div className="tool-widget-generic">
      <div className="tool-widget-generic-header">
        <span className="tool-widget-generic-label">{event.toolName}</span>
        <span className={`tool-widget-status tool-widget-status-${event.status}`}>
          {event.status}
        </span>
      </div>
      <div className="tool-widget-generic-body">
        <div className="tool-widget-generic-section">
          <div className="tool-widget-generic-section-title">Arguments</div>
          <pre className="tool-widget-generic-json">
            {JSON.stringify(event.args, null, 2)}
          </pre>
        </div>
        {(event.result || event.error) && (
          <div className="tool-widget-generic-section">
            <div className="tool-widget-generic-section-title">
              {event.error ? 'Error' : 'Result'}
            </div>
            <pre className="tool-widget-generic-json">
              {event.error ?? event.result}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export function ToolWidgetContainer({
  event,
  isCollapsed,
  onToggleCollapse,
  onNavigate,
}: ToolWidgetContainerProps) {
  // Determine which widget to show
  const getWidget = () => {
    if (DIFF_TOOLS.has(event.toolName)) {
      return <DiffWidget event={event} />;
    }
    if (TERMINAL_TOOLS.has(event.toolName)) {
      return <TerminalWidget event={event} />;
    }
    if (FILE_PREVIEW_TOOLS.has(event.toolName)) {
      return <FilePreview event={event} />;
    }
    if (RESULTS_TABLE_TOOLS.has(event.toolName)) {
      return <ResultsTable event={event} onNavigate={onNavigate} />;
    }
    return <GenericToolWidget event={event} />;
  };

  // Generate a summary for collapsed view
  const getSummary = (): string => {
    const args = event.args;
    switch (event.toolName) {
      case 'edit':
      case 'replace_symbol':
        return (args.file_path as string) ?? '';
      case 'write':
        return (args.file_path as string) ?? '';
      case 'rename_symbol':
        return `${args.old_name ?? ''} → ${args.new_name ?? ''}`;
      case 'execute_command':
        return (args.command as string) ?? '';
      case 'read':
        return (args.file_path as string) ?? '';
      case 'grep':
        return (args.pattern as string) ?? '';
      default:
        return JSON.stringify(args).slice(0, 80);
    }
  };

  return (
    <div className={`tool-widget-container ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Header — always visible */}
      <div className="tool-widget-header" onClick={onToggleCollapse}>
        <span className="tool-widget-header-icon">&#9881;</span>
        <span className="tool-widget-header-name">{event.toolName}</span>
        {isCollapsed && (
          <span className="tool-widget-header-summary">{getSummary()}</span>
        )}
        <span className={`tool-widget-status-badge tool-widget-status-${event.status}`}>
          {event.status === 'running' && <span className="spinner" />}
          {event.status}
        </span>
        <span className={`tool-widget-toggle ${isCollapsed ? '' : 'expanded'}`}>
          &#9654;
        </span>
      </div>

      {/* Body — only visible when not collapsed */}
      {!isCollapsed && (
        <div className="tool-widget-body">
          {/* Loading state */}
          {event.status === 'running' && !event.result && (
            <div className="state-loading">
              <span className="spinner" />
              <span>Executing {event.toolName}...</span>
            </div>
          )}

          {/* Error state */}
          {event.status === 'error' && (
            <div className="state-error">
              <span className="state-error-message">{event.error ?? 'Unknown error'}</span>
            </div>
          )}

          {/* Widget content */}
          {(event.status === 'completed' || event.result) && getWidget()}

          {/* Pending state */}
          {event.status === 'pending' && (
            <div className="state-loading">
              <span>Waiting to execute...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
