import { useId, useMemo, useState, type ReactNode } from 'react';
import type { ToolBlock } from '../hooks/useChat';
import {
  buildToolTitle,
  toolTitleRunningText,
  type SubagentTitleRecord,
  type ToolTitle,
} from '../utils/tool-title';
import { Icon, type IconName } from './Icon';
import { Spinner } from './ui/Spinner';
import { StatusBadge } from './ui/StatusBadge';

export interface ToolCallBlockProps {
  block: ToolBlock;
  subagents?: readonly SubagentTitleRecord[];
}

/** Prefer these arg keys for compact titles (mock-style code tokens). */
const PRIMARY_ARG_KEYS = [
  'pattern',
  'query',
  'glob',
  'path',
  'file_path',
  'file',
  'filename',
  'directory_path',
  'directory',
  'command',
  'cmd',
  'url',
  'name',
  'symbol',
  'target',
  'expression',
];

function iconForTool(name: string): IconName {
  const lower = name.toLowerCase();
  if (lower.includes('grep') || lower.includes('search') || lower.includes('glob')) return 'search';
  if (lower.includes('read') || lower.includes('file') || lower.includes('preview')) return 'eye';
  if (
    lower.includes('exec') ||
    lower.includes('run') ||
    lower.includes('command') ||
    lower.includes('shell') ||
    lower.includes('terminal') ||
    lower.includes('bash')
  ) {
    return 'zap';
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('diff') || lower.includes('patch')) {
    return 'edit';
  }
  if (lower.includes('list')) return 'fileText';
  return 'terminal';
}

function tryParseJson(text: string): unknown | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Sometimes content is truncated; try a shallow display extract
    return null;
  }
}

/** Unwrap double-encoded JSON strings up to 2 levels. */
function deepParse(text: string): unknown | null {
  let cur: unknown = tryParseJson(text);
  if (cur == null) return null;
  for (let i = 0; i < 2 && typeof cur === 'string'; i++) {
    const next = tryParseJson(cur);
    if (next == null) break;
    cur = next;
  }
  return cur;
}

function primaryArgValue(args: string): string | null {
  if (!args) return null;
  const parsed = deepParse(args);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    for (const key of PRIMARY_ARG_KEYS) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) return truncateToken(val);
    }
    for (const key of Object.keys(obj)) {
      if (key === 'display' || key === 'content' || key === 'error' || key === 'result') continue;
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0 && val.length < 120 && !val.startsWith('{')) {
        return truncateToken(val);
      }
    }
  }
  // Incomplete streaming JSON — grab a known key's quoted fragment
  const m =
    /"(?:pattern|query|path|file_path|command|glob|directory_path|filename)"\s*:\s*"((?:\\.|[^"\\]){1,100})/.exec(
      args,
    );
  if (m) return truncateToken(m[1].replace(/\\"/g, '"'));
  return null;
}

function truncateToken(s: string): string {
  return s.length > 72 ? s.slice(0, 69) + '…' : s;
}

/**
 * Tools often return `{ display, content }` — prefer human display text.
   * Also handles plain text results like "Found 60 file(s) matching ...".
 */
function parseToolPayload(raw: string | null): { display: string | null; body: string } {
  if (!raw) return { display: null, body: '' };

  const parsed = deepParse(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const display = typeof obj.display === 'string' ? obj.display : null;
    const content =
      typeof obj.content === 'string'
        ? obj.content
        : typeof obj.result === 'string'
          ? obj.result
          : null;
    if (display || content) {
      return { display, body: content ?? display ?? raw };
    }
  }

  // Truncated JSON still containing a display field
  const displayMatch = /"display"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(raw);
  if (displayMatch) {
    const display = displayMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
    return { display, body: display };
  }

  return { display: null, body: raw };
}

function resultSummary(
  result: string | null,
  toolName: string,
  primary: string | null,
): string | null {
  if (!result) return null;
  const { display, body } = parseToolPayload(result);

  if (display) {
    // "Found 1 matches for *.ts" — keep human phrasing; token may still show
    const text = display.replace(/\s+/g, ' ').trim();
    if (primary && text.includes(primary)) {
      // Leave as-is so mock-style "Found N matches for pattern" stays intact
    }
    return text.length > 90 ? text.slice(0, 87) + '…' : text;
  }

  const lines = body.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  // Don't dump raw JSON into the title
  const first = lines[0].trim();
  if (first.startsWith('{') || first.startsWith('[')) return null;

  const lower = toolName.toLowerCase();
  // "Found N file(s) matching '…'" style plain results
  const foundMatch = /^(Found\s+\d+[^\n]{0,80})/i.exec(first);
  if (foundMatch) return foundMatch[1].replace(/\s+/g, ' ').trim();

  if (lines.length > 1 && (lower.includes('glob') || lower.includes('grep') || lower.includes('search') || lower.includes('list'))) {
    return `Found ${lines.length} matches`;
  }

  return first.length > 80 ? first.slice(0, 77) + '…' : first;
}

function formatResultBody(result: string | null): string {
  if (!result) return '';
  const { body } = parseToolPayload(result);
  return truncateResult(body);
}

export function ToolCallBlock({ block, subagents = [] }: ToolCallBlockProps) {
  // Outputs always start collapsed; user expands on demand.
  // Title or expanded content both toggle (content click collapses).
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const iconName = iconForTool(block.toolName);
  const argsText = block.args || block.partialArgs;
  const primaryValue = useMemo(
    () =>
      block.status === 'generating'
        ? primaryArgValue(block.partialArgs)
        : primaryArgValue(block.args),
    [block.status, block.partialArgs, block.args],
  );
  const summary = useMemo(
    () =>
      block.status === 'completed' || block.status === 'failed'
        ? resultSummary(block.result ?? block.error, block.toolName, primaryValue)
        : null,
    [block.status, block.result, block.error, block.toolName, primaryValue],
  );
  const title = useMemo(
    () =>
      buildToolTitle({
        toolName: block.toolName,
        status: block.status,
        args: block.args,
        partialArgs: block.partialArgs,
        summary,
        result: block.result,
        subagents,
      }),
    [
      block.toolName,
      block.status,
      block.args,
      block.partialArgs,
      block.result,
      summary,
      subagents,
    ],
  );
  const runningDetailText = toolTitleRunningText(title);

  const showLoader = block.status === 'generating' || block.status === 'running';
  const stateClass = block.status === 'completed' ? '' : block.status;
  const toggle = () => setExpanded((prev) => !prev);
  const collapse = () => setExpanded(false);

  const badge =
    block.status === 'generating' ? (
      <StatusBadge tone="info" size="xs">generating</StatusBadge>
    ) : block.status === 'running' ? (
      <StatusBadge tone="warning" size="xs">running</StatusBadge>
    ) : block.status === 'failed' ? (
      <StatusBadge tone="error" size="xs">failed</StatusBadge>
    ) : null;

  return (
    <div className={`orchid-tool-block ${stateClass}`}>
      <button
        className="orchid-tool-block-title"
        onClick={toggle}
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="orchid-tool-block-title-left">
          {showLoader ? (
            <Spinner size="xs" aria-hidden className="shrink-0" />
          ) : (
            <Icon name={iconName} size={12} className="shrink-0" />
          )}
          <span className="orchid-tool-block-title-text">{renderToolTitle(title)}</span>
        </span>
        <span className="orchid-tool-block-title-right">
          {badge}
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
      </button>

      {expanded && (
        <div
          id={panelId}
          className="orchid-tool-block-content"
          onClick={collapse}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              collapse();
            }
          }}
          role="button"
          tabIndex={0}
          title="Click to collapse"
        >
          {block.status === 'generating' && (
            <div className="orchid-tool-args-stream">
              streaming args: {argsText || '{'}
            </div>
          )}
          {block.status === 'running' && (
            <div className="orchid-tool-running-hint">{runningDetailText}…</div>
          )}
          {block.status === 'completed' && block.result && (
            <pre className="orchid-tool-result-body">
              {formatResultBody(block.result)}
            </pre>
          )}
          {block.status === 'failed' && (
            <pre className="orchid-tool-result-body orchid-tool-result-error">
              {parseToolPayload(block.error).body || block.error || 'Tool failed'}
            </pre>
          )}
          {block.status === 'completed' && !block.result && (
            <div className="orchid-tool-running-hint">done</div>
          )}
        </div>
      )}
    </div>
  );
}

function renderToolTitle(title: ToolTitle): ReactNode {
  return title.segments.map((segment, index) => {
    if (segment.kind === 'strong') {
      return <span key={index} className="font-semibold">{segment.value}</span>;
    }
    if (segment.kind === 'code') {
      return <span key={index} className="orchid-code-token">{segment.value}</span>;
    }
    return <span key={index}>{segment.value}</span>;
  });
}

function truncateResult(result: string): string {
  const lines = result.split('\n');
  if (lines.length > 12) {
    return lines.slice(0, 11).join('\n') + `\n... ${lines.length - 11} more lines`;
  }
  return result.slice(0, 1200);
}
