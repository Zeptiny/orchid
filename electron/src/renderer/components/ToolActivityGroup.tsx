/**
 * ToolActivityGroup — compact explore activity for **finished** work only.
 *
 * Live thinking / generating / running tools stay outside this widget so the
 * user always sees current activity as normal stream rows.
 *
 * Level 0 title is tool-only: "Searched N patterns · Read M files"
 * Level 1 expand → finished thoughts + tool rows in chronological order
 * Level 2 → expand a tool row for details (existing ToolCallBlock)
 */
import { useEffect, useId, useMemo, useState } from 'react';
import type { Message } from '../../shared/types/message';
import type { ToolBlock } from '../hooks/useChat';
import { summarizeToolGroup } from '../utils/tool-grouping';
import type { SubagentTitleRecord } from '../utils/tool-title';
import { Icon } from './Icon';
import { MessageWidget } from './MessageWidget';
import { ToolCallBlock } from './ToolCallBlock';
import { CollapsibleRegion } from './ui/CollapsibleRegion';
import { Spinner } from './ui/Spinner';
import { StatusBadge } from './ui/StatusBadge';

export type ActivityChild =
  | { kind: 'tool'; block: ToolBlock }
  | { kind: 'thought'; message: Message; isStreaming?: boolean };

export interface ToolActivityGroupProps {
  /** Ordered entries (thoughts + tools) as they appeared in the stream. */
  items: readonly ActivityChild[];
  /** Active-session subagents used to turn wait/interrupt IDs into names. */
  subagents?: readonly SubagentTitleRecord[];
  /** When true, groups start expanded. */
  alwaysExpand?: boolean;
}

export function ToolActivityGroup({
  items,
  subagents = [],
  alwaysExpand = false,
}: ToolActivityGroupProps) {
  const panelId = useId();
  const tools = useMemo(
    () => items.filter((c): c is Extract<ActivityChild, { kind: 'tool' }> => c.kind === 'tool'),
    [items],
  );

  const anyThoughtStreaming = items.some(
    (c) => c.kind === 'thought' && Boolean(c.isStreaming),
  );

  const [expanded, setExpanded] = useState(alwaysExpand);

  useEffect(() => {
    if (alwaysExpand) setExpanded(true);
  }, [alwaysExpand]);

  const summary = useMemo(
    () =>
      summarizeToolGroup(
        tools.map((t) => ({
          id: t.block.id,
          toolName: t.block.toolName,
          status: t.block.status,
        })),
      ),
    [tools],
  );

  const hasActive = summary.hasActive || anyThoughtStreaming;
  const stateClass = summary.hasFailed
    ? 'failed'
    : hasActive
      ? 'running'
      : '';

  const showLoader = hasActive;
  // Prefer most specific family icon present in the group.
  const iconName =
    summary.searchCount > 0
      ? 'search'
      : summary.astCount > 0
        ? 'code'
        : summary.fetchCount > 0
          ? 'globe'
          : summary.readCount > 0
            ? 'eye'
            : summary.todoCount > 0
              ? 'check'
              : 'tool';

  // Badge = tool count (title already describes tools; thoughts stay hidden in chrome)
  const badgeCount = tools.length > 0 ? tools.length : items.length;

  return (
    <div className={`orchid-tool-activity ${stateClass}`}>
      <button
        type="button"
        className="orchid-tool-activity-title"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="orchid-tool-activity-title-left">
          {showLoader ? (
            <Spinner size="xs" aria-hidden className="shrink-0" />
          ) : (
            <Icon name={iconName} size={12} className="shrink-0" />
          )}
          <span className="orchid-tool-activity-title-text">
            {summary.title || 'Activity'}
          </span>
          <StatusBadge tone="ghost" size="xs" className="tool-activity-group-count">
            {badgeCount}
          </StatusBadge>
        </span>
        <span className="orchid-tool-activity-title-right">
          <Icon
            name="chevronDown"
            size={12}
            className={`orchid-disclosure-chevron ${expanded ? 'is-open' : ''}`}
          />
        </span>
      </button>

      <CollapsibleRegion open={expanded} id={panelId}>
        <div className="orchid-tool-activity-body">
          <div className="tool-activity-group-children orchid-tool-activity-children">
            {items.map((child, i) => {
              if (child.kind === 'tool') {
                return (
                  <ToolCallBlock
                    key={child.block.id}
                    block={child.block}
                    subagents={subagents}
                  />
                );
              }
              return (
                <MessageWidget
                  key={child.message.id || `thought-${i}`}
                  message={child.message}
                  isStreaming={child.isStreaming}
                />
              );
            })}
          </div>
        </div>
      </CollapsibleRegion>
    </div>
  );
}
