/**
 * ToolWidgets — native tool-call widgets for the side rail.
 *
 * Each tool type has a dedicated widget:
 * - DiffWidget: Monaco diff for edits (edit, write, replace_symbol, rename_symbol)
 * - TerminalWidget: xterm.js for commands (execute_command)
 * - FilePreview: rendered preview for reads (read)
 * - ResultsTable: tabular display for grep results (grep)
 *
 * ToolWidgetContainer routes to the correct widget and handles
 * loading/error/collapsed states.
 */

export { DiffWidget } from './DiffWidget';
export { TerminalWidget } from './TerminalWidget';
export { FilePreview } from './FilePreview';
export { ResultsTable } from './ResultsTable';
export { ToolWidgetContainer } from './ToolWidgetContainer';
export { ToolRail } from './ToolRail';
export { LiveCommandInline } from './LiveCommandInline';

export type {
  ToolCallEvent,
  ToolCallStatus,
  DiffData,
  GrepResultRow,
  FilePreviewData,
} from './types';

export {
  DIFF_TOOLS,
  TERMINAL_TOOLS,
  FILE_PREVIEW_TOOLS,
  RESULTS_TABLE_TOOLS,
  detectLanguage,
} from './types';
