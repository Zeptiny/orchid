import { useMemo, type ReactNode } from 'react';
import type { ToolBlock } from '../hooks/useChat';
import {
  buildToolTitle,
  toolTitleRunningText,
  type SubagentTitleRecord,
  type ToolTitle,
} from '../utils/tool-title';
import type { IconName } from './Icon';
import { ToolResultShell } from './ToolResults/ToolResultShell';
import { Spinner } from './ui/Spinner';
import { StatusBadge } from './ui/StatusBadge';

export interface ToolCallBlockProps {
  block: ToolBlock;
  subagents?: readonly SubagentTitleRecord[];
}

function iconForTool(name: string): IconName {
  const lower = name.toLowerCase();
  if (lower.includes('grep') || lower.includes('search') || lower.includes('glob')) return 'search';
  if (lower.includes('read') || lower.includes('file') || lower.includes('preview')) return 'eye';
  if (lower.includes('exec') || lower.includes('run') || lower.includes('command') || lower.includes('shell') || lower.includes('terminal') || lower.includes('bash')) return 'zap';
  if (lower.includes('edit') || lower.includes('write') || lower.includes('diff') || lower.includes('patch')) return 'edit';
  if (lower.includes('list')) return 'fileText';
  return 'terminal';
}

function canonicalSummary(block: ToolBlock): string | null {
  const data = block.toolResult?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.path === 'string') return record.path;
  if (typeof record.pattern === 'string') {
    const count = typeof record.totalMatches === 'number' ? record.totalMatches : Array.isArray(record.matches) ? record.matches.length : null;
    return count === null ? record.pattern : `${count} match${count === 1 ? '' : 'es'} · ${record.pattern}`;
  }
  if (typeof record.value === 'string') return record.value.split('\n')[0] || null;
  return null;
}

function titleStatus(status: ToolBlock['status']): 'generating' | 'running' | 'completed' | 'failed' {
  if (status === 'generating' || status === 'running') return status;
  return status === 'failed' || status === 'error' ? 'failed' : 'completed';
}

export function ToolCallBlock({ block, subagents = [] }: ToolCallBlockProps) {
  const argsText = block.args || block.partialArgs;
  const summary = useMemo(() => canonicalSummary(block), [block]);
  const title = useMemo(
    () => buildToolTitle({
      toolName: block.toolName,
      status: titleStatus(block.status),
      args: block.args,
      partialArgs: block.partialArgs,
      summary,
      result: null,
      subagents,
    }),
    [block.toolName, block.status, block.args, block.partialArgs, summary, subagents],
  );

  const runningDetailText = toolTitleRunningText(title);
  const loadingIndicator = block.status === 'generating' || block.status === 'running'
    ? <Spinner size="xs" aria-hidden className="shrink-0" />
    : undefined;
  const statusBadge = block.status === 'failed' || block.status === 'error'
    ? <StatusBadge tone="error" size="xs">error</StatusBadge>
    : undefined;

  // Keep args/running copy in the shared shell; this fallback string is only
  // an invocation hint and never used to reconstruct a terminal result.
  void argsText;
  void runningDetailText;
  return (
    <ToolResultShell
      block={block}
      title={renderToolTitle(title)}
      iconName={iconForTool(block.toolName)}
      loadingIndicator={loadingIndicator}
      statusBadge={statusBadge}
    />
  );
}

function renderToolTitle(title: ToolTitle): ReactNode {
  return title.segments.map((segment, index) => {
    if (segment.kind === 'strong') return <span key={index} className="font-semibold">{segment.value}</span>;
    if (segment.kind === 'code') return <span key={index} className="orchid-code-token">{segment.value}</span>;
    return <span key={index}>{segment.value}</span>;
  });
}
