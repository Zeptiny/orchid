/**
 * DiffWidget — Monaco editor in diff mode for edit/write/replace tools.
 *
 * Shows before/after diff with syntax highlighting based on file extension.
 * Read-only (no editing in the widget).
 *
 * Supported tools: edit, write, replace_symbol, rename_symbol.
 */
import { useEffect, useMemo, useState } from 'react';
import { DiffEditor, loader } from '@monaco-editor/react';
import type { ToolCallEvent, DiffData } from './types';
import { detectLanguage } from './types';

// Configure Monaco to load from local node_modules instead of CDN
// This ensures the editor works in packaged Electron builds without internet
loader.config({
  paths: {
    vs: new URL('../../../../node_modules/monaco-editor/min/vs', import.meta.url).pathname,
  },
});

// ── Props ────────────────────────────────────────────────────────────────────

interface DiffWidgetProps {
  /** The tool call event. */
  event: ToolCallEvent;
}

function monacoTheme(): 'vs' | 'vs-dark' {
  const name = typeof document === 'undefined' ? 'default' : document.documentElement.dataset.theme;
  return name === 'solarized-light' || name === 'windows-xp' ? 'vs' : 'vs-dark';
}

// ── Extract diff data from tool call ─────────────────────────────────────────

function extractDiffData(event: ToolCallEvent): DiffData {
  const args = event.args;
  const filePath = (args.file_path as string) ?? '';

  // For edit/replace_symbol: old_string → new_string
  if (event.toolName === 'edit' || event.toolName === 'replace_symbol') {
    const original = (args.old_string as string) ?? '';
    const modified = (args.new_string as string) ?? '';
    return {
      original,
      modified,
      filePath,
      language: detectLanguage(filePath),
    };
  }

  // For write: empty → content
  if (event.toolName === 'write') {
    const content = (args.content as string) ?? '';
    return {
      original: '',
      modified: content,
      filePath,
      language: detectLanguage(filePath),
    };
  }

  // For rename_symbol: old name → new name (show as text diff)
  if (event.toolName === 'rename_symbol') {
    const oldName = (args.old_name as string) ?? '';
    const newName = (args.new_name as string) ?? '';
    return {
      original: oldName,
      modified: newName,
      filePath,
      language: 'plaintext',
    };
  }

  return {
    original: '',
    modified: '',
    filePath,
    language: 'plaintext',
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function DiffWidget({ event }: DiffWidgetProps) {
  const diffData = useMemo(() => extractDiffData(event), [event]);
  const [editorTheme, setEditorTheme] = useState<'vs' | 'vs-dark'>(monacoTheme);

  useEffect(() => {
    const handleThemeApplied = () => setEditorTheme(monacoTheme());
    window.addEventListener('orchid:theme-applied', handleThemeApplied);
    return () => window.removeEventListener('orchid:theme-applied', handleThemeApplied);
  }, []);

  return (
    <div className="tool-widget-diff">
      <div className="tool-widget-diff-header">
        <span className="tool-widget-diff-label">
          {event.toolName === 'write' ? 'New File' : 'Diff'}
        </span>
        {diffData.filePath && (
          <span className="tool-widget-diff-path">{diffData.filePath}</span>
        )}
      </div>
      <div className="tool-widget-diff-editor">
        <DiffEditor
          height="100%"
          language={diffData.language}
          original={diffData.original}
          modified={diffData.modified}
          theme={editorTheme}
          options={{
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            fontSize: 12,
            lineNumbers: 'on',
            folding: false,
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: {
              verticalScrollbarSize: 8,
              horizontalScrollbarSize: 8,
            },
          }}
        />
      </div>
    </div>
  );
}
