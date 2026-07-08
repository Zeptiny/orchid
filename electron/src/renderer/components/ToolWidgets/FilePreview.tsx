/**
 * FilePreview — rendered preview for the read tool.
 *
 * Features:
 * - Line numbers
 * - Syntax highlighting (via CSS classes)
 * - Scrollable content
 *
 * Supported tools: read.
 */
import { useMemo } from 'react';
import type { ToolCallEvent, FilePreviewData } from './types';
import { detectLanguage } from './types';

// ── Props ────────────────────────────────────────────────────────────────────

interface FilePreviewProps {
  /** The tool call event. */
  event: ToolCallEvent;
}

// ── Extract preview data ─────────────────────────────────────────────────────

function extractPreviewData(event: ToolCallEvent): FilePreviewData {
  const args = event.args;
  const filePath = (args.file_path as string) ?? '';
  const offset = typeof args.offset === 'number' ? args.offset : 1;

  // Content comes from the result, not the args
  const content = event.result ?? '';

  return {
    filePath,
    content,
    language: detectLanguage(filePath),
    startLine: offset,
  };
}

// ── Simple syntax highlighting via CSS classes ───────────────────────────────

function highlightLine(line: string, language: string): React.ReactNode {
  // Basic keyword highlighting for common languages
  if (['typescript', 'javascript', 'python', 'ruby', 'java', 'go', 'rust', 'c', 'cpp'].includes(language)) {
    // Highlight comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('#')) {
      return <span className="syntax-comment">{line}</span>;
    }

    // Highlight strings (simple double-quote detection)
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    while (remaining.length > 0) {
      const dqStart = remaining.indexOf('"');
      const sqStart = remaining.indexOf("'");
      const commentStart = remaining.indexOf('//');

      if (commentStart !== -1 && (dqStart === -1 || commentStart < dqStart) && (sqStart === -1 || commentStart < sqStart)) {
        if (commentStart > 0) parts.push(<span key={key++}>{remaining.slice(0, commentStart)}</span>);
        parts.push(<span key={key++} className="syntax-comment">{remaining.slice(commentStart)}</span>);
        remaining = '';
        break;
      }

      const firstQuote = dqStart !== -1 && (sqStart === -1 || dqStart < sqStart) ? dqStart : sqStart;
      if (firstQuote === -1) {
        parts.push(<span key={key++}>{remaining}</span>);
        remaining = '';
        break;
      }

      const quoteChar = remaining[firstQuote];
      const closeQuote = remaining.indexOf(quoteChar, firstQuote + 1);
      if (closeQuote === -1) {
        // Unclosed string — rest of line is string
        parts.push(<span key={key++}>{remaining.slice(0, firstQuote)}</span>);
        parts.push(<span key={key++} className="syntax-string">{remaining.slice(firstQuote)}</span>);
        remaining = '';
        break;
      }

      parts.push(<span key={key++}>{remaining.slice(0, firstQuote)}</span>);
      parts.push(<span key={key++} className="syntax-string">{remaining.slice(firstQuote, closeQuote + 1)}</span>);
      remaining = remaining.slice(closeQuote + 1);
    }

    return <>{parts}</>;
  }

  return line;
}

// ── Component ────────────────────────────────────────────────────────────────

export function FilePreview({ event }: FilePreviewProps) {
  const previewData = useMemo(() => extractPreviewData(event), [event]);

  const lines = useMemo(() => {
    if (!previewData.content) return [];
    return previewData.content.split('\n');
  }, [previewData.content]);

  return (
    <div className="tool-widget-file-preview">
      <div className="tool-widget-file-preview-header">
        <span className="tool-widget-file-preview-label">File Preview</span>
        {previewData.filePath && (
          <span className="tool-widget-file-preview-path">{previewData.filePath}</span>
        )}
        <span className="tool-widget-file-preview-lang">{previewData.language}</span>
      </div>
      <div className="tool-widget-file-preview-body">
        <div className="tool-widget-file-preview-gutter">
          {lines.map((_, i) => (
            <div key={i} className="tool-widget-file-preview-line-number">
              {previewData.startLine + i}
            </div>
          ))}
        </div>
        <div className="tool-widget-file-preview-content">
          {lines.map((line, i) => (
            <div key={i} className="tool-widget-file-preview-line">
              {highlightLine(line, previewData.language)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
