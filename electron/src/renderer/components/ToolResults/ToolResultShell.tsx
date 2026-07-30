import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import type { CanonicalToolResult, TerminalToolResultStatus } from '../../../shared/types/tool-result';
import type { ToolBlock } from '../../hooks/useChat';
import { Icon, type IconName } from '../Icon';
import { CollapsibleRegion } from '../ui/CollapsibleRegion';
import { Spinner } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import { GenericToolResult } from './GenericToolResult';
import { resolveToolResultRenderer } from './registry';

export interface ToolResultShellProps {
  block: ToolBlock;
  title?: ReactNode;
  iconName?: IconName;
  subagents?: readonly unknown[];
  loadingIndicator?: ReactNode;
  statusBadge?: ReactNode;
}

const expansionChoices = new Map<string, boolean>();
const MAX_EXPANSION_CHOICES = 100;

function rememberExpansionChoice(choiceKey: string, expanded: boolean): void {
  expansionChoices.delete(choiceKey);
  if (expansionChoices.size >= MAX_EXPANSION_CHOICES) {
    const oldestKey = expansionChoices.keys().next().value;
    if (oldestKey) expansionChoices.delete(oldestKey);
  }
  expansionChoices.set(choiceKey, expanded);
}

export function terminalStatusForBlock(block: ToolBlock): TerminalToolResultStatus | null {
  if (block.status === 'generating' || block.status === 'running') return null;
  if (block.toolResult) return block.toolResult.status;
  if (block.status === 'failed' || block.status === 'error') return 'error';
  if (block.status === 'partial') return 'partial';
  if (block.status === 'empty') return 'empty';
  if (block.status === 'cancelled') return 'cancelled';
  return 'complete';
}

export function toolStatusLabel(status: ToolBlock['status'], canonical?: CanonicalToolResult | null): string {
  if (status === 'generating') return 'generating';
  if (status === 'running') return 'running';
  const terminal = canonical?.status ?? (
    status === 'failed' || status === 'error' ? 'error' :
      status === 'partial' ? 'partial' :
        status === 'empty' ? 'empty' :
          status === 'cancelled' ? 'cancelled' : 'complete'
  );
  if (terminal === 'partial') return 'partial';
  if (terminal === 'empty') return 'empty';
  if (terminal === 'error') return 'error';
  if (terminal === 'cancelled') return 'cancelled';
  return 'complete';
}

function ResultBody({ block, canonical }: { block: ToolBlock; canonical: CanonicalToolResult }) {

  try {
    const Renderer = resolveToolResultRenderer(block.toolName, canonical.family);
    return <Renderer canonical={canonical} toolName={block.toolName} isLive={block.status === 'running'} />;
  } catch {
    return <GenericToolResult canonical={canonical} />;
  }
}

function lifecycleBadge(block: ToolBlock, canonical: CanonicalToolResult | null, custom?: ReactNode) {
  if (custom) return custom;
  const status = toolStatusLabel(block.status, canonical);
  if (status === 'partial' || status === 'complete') return null;
  if (status === 'generating') return <StatusBadge tone="info" size="xs">generating</StatusBadge>;
  if (status === 'running') return <StatusBadge tone="warning" size="xs">running</StatusBadge>;
  if (status === 'error') return null;
  if (status === 'partial') return <StatusBadge tone="warning" size="xs">partial</StatusBadge>;
  if (status === 'cancelled') return <StatusBadge tone="ghost" size="xs">cancelled</StatusBadge>;
  if (status === 'empty') return <StatusBadge tone="ghost" size="xs">empty</StatusBadge>;
  return <StatusBadge tone="success" size="xs">complete</StatusBadge>;
}

/** Shared disclosure/lifecycle/copy boundary for every tool result surface. */
export function ToolResultShell({
  block,
  title,
  iconName = 'terminal',
  loadingIndicator,
  statusBadge,
}: ToolResultShellProps) {
  const panelId = useId();
  const announcementId = useId();
  const canonical = block.toolResult;
  const status = toolStatusLabel(block.status, canonical);
  const choiceKey = block.id || `${block.toolName}:${block.startedAt}`;
  // Result widgets begin closed. Once the user opens or closes a call, that
  // explicit choice is retained through live-to-terminal replacement and
  // hydration; lifecycle updates never change it implicitly.
  const [expanded, setExpanded] = useState(() => expansionChoices.get(choiceKey) ?? false);
  const [hasExpanded, setHasExpanded] = useState(expanded);
  const [announcement, setAnnouncement] = useState('');
  const active = block.status === 'generating' || block.status === 'running';

  useEffect(() => {
    setAnnouncement(`${status} tool result`);
  }, [status]);

  useEffect(() => {
    if (expanded) setHasExpanded(true);
  }, [expanded]);

  const displayTitle = title ?? block.toolName;
  const body = useMemo(() => {
    if (!expanded && !hasExpanded) return null;
    if (block.status === 'generating') return <div className="orchid-tool-args-stream">streaming args: {block.partialArgs || '{'}</div>;
    if (block.status === 'running') {
      const value = canonical?.data && typeof canonical.data === 'object' && !Array.isArray(canonical.data)
        ? (canonical.data as { value?: unknown }).value
        : null;
      const facts = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
      const hasStructuredCommand = block.toolName === 'execute_command' && facts && (typeof facts.commandId === 'number' || typeof facts.command_id === 'number');
      return hasStructuredCommand && canonical
        ? <ResultBody block={block} canonical={canonical} />
        : <div className="orchid-tool-running-hint">Running…</div>;
    }
    return canonical ? <ResultBody block={block} canonical={canonical} /> : null;
  }, [block, canonical, expanded, hasExpanded]);

  const toggle = () => {
    const next = !expanded;
    rememberExpansionChoice(choiceKey, next);
    setExpanded(next);
  };
  const collapse = () => {
    rememberExpansionChoice(choiceKey, false);
    setExpanded(false);
  };

  return (
    <div className={`orchid-tool-block ${status === 'complete' ? '' : status}`} data-tool-result-status={status}>
      <button
        type="button"
        className="orchid-tool-block-title min-w-0"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="orchid-tool-block-title-left min-w-0">
          <span key={status} className="orchid-tool-lifecycle-icon shrink-0">
            {active ? (loadingIndicator ?? <Spinner size="xs" aria-hidden />) : <Icon name={iconName} size={12} />}
          </span>
          <span className="orchid-tool-block-title-text min-w-0 truncate">{displayTitle}</span>
        </span>
        <span className="orchid-tool-block-title-right shrink-0">
          {lifecycleBadge(block, canonical, statusBadge)}
          <Icon
            name="chevronDown"
            size={12}
            className={`orchid-disclosure-chevron ${expanded ? 'is-open' : ''}`}
          />
        </span>
      </button>
      <CollapsibleRegion open={expanded} id={panelId} lazyMount>
        <div
          className="orchid-tool-block-content min-w-0"
          aria-describedby={announcementId}
          onClick={collapse}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              collapse();
            }
          }}
          role="button"
          tabIndex={0}
          title="Click to collapse"
        >
          {body}
          <span className="sr-only">{status} tool result</span>
          <span id={announcementId} className="sr-only" role="status" aria-live="polite">{announcement}</span>
        </div>
      </CollapsibleRegion>
    </div>
  );
}

export function resetToolResultExpansionState(): void {
  expansionChoices.clear();
}
