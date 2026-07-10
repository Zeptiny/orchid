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
import { useEffect, useMemo, useState } from 'react';
import type { Message } from '../../shared/types/message';
import type { ToolBlock } from '../hooks/useChat';
import { summarizeToolGroup } from '../utils/tool-grouping';
import { Icon } from './Icon';
import { MessageWidget } from './MessageWidget';
import { ToolCallBlock } from './ToolCallBlock';

export type ActivityChild =
  | { kind: 'tool'; block: ToolBlock }
  | { kind: 'thought'; message: Message; isStreaming?: boolean };

export interface ToolActivityGroupProps {
  /** Ordered entries (thoughts + tools) as they appeared in the stream. */
  items: readonly ActivityChild[];
  /** When true, groups start expanded. */
  alwaysExpand?: boolean;
}

const MAX_VISIBLE_CHILDREN = 12;

export function ToolActivityGroup({
  items,
  alwaysExpand = false,
}: ToolActivityGroupProps) {
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
  const overflow = items.length > MAX_VISIBLE_CHILDREN;
  const visible = overflow ? items.slice(0, MAX_VISIBLE_CHILDREN) : items;
  const hiddenCount = overflow ? items.length - MAX_VISIBLE_CHILDREN : 0;

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
            : 'tool';

  // Badge = tool count (title already describes tools; thoughts stay hidden in chrome)
  const badgeCount = tools.length > 0 ? tools.length : items.length;

  return (
    <div className={`tool-activity-group ${stateClass}`}>
      <button
        type="button"
        className="tool-activity-group-title"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className="tool-activity-group-title-left">
          {showLoader ? (
            <Icon name="loader" size={12} className="animate-spin shrink-0" />
          ) : (
            <Icon name={iconName} size={12} className="shrink-0" />
          )}
          <span className="tool-activity-group-title-text">
            {summary.title || 'Activity'}
          </span>
          <span className="tool-activity-group-count badge badge-ghost badge-xs">
            {badgeCount}
          </span>
        </span>
        <span className="tool-activity-group-title-right">
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} />
        </span>
      </button>

      {expanded && (
        <div className="tool-activity-group-body">
          <div
            className={
              overflow
                ? 'tool-activity-group-children tool-activity-group-children-scroll'
                : 'tool-activity-group-children'
            }
          >
            {visible.map((child, i) => {
              if (child.kind === 'tool') {
                return <ToolCallBlock key={child.block.id} block={child.block} />;
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
          {hiddenCount > 0 && (
            <div className="tool-activity-group-overflow">
              +{hiddenCount} more
            </div>
          )}
        </div>
      )}
    </div>
  );
}
