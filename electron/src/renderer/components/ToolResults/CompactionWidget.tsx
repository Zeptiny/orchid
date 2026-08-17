import { useId, useState } from 'react';
import type { Message } from '../../../shared/types/message';
import { MarkdownContent } from '../MarkdownContent';
import { Icon } from '../Icon';
import { StatusBadge } from '../ui/StatusBadge';
import { CollapsibleRegion } from '../ui/CollapsibleRegion';

export interface CompactionWidgetProps {
  message: Message;
}

function formatRange(marker: NonNullable<Message['compacted']>): string {
  const start = marker.rangeStart ? marker.rangeStart.slice(0, 8) : '?';
  const end = marker.rangeEnd ? marker.rangeEnd.slice(0, 8) : '?';
  return `${start}…${end}`;
}

function isReclaimOnly(message: Message): boolean {
  const marker = message.compacted;
  if (!marker) return false;
  const content = message.content?.trim() ?? '';
  // Reclaim-only has no summary text or summarizedCount 0 with very short content
  if (content.length === 0) return true;
  if (marker.summarizedCount === 0 && content.length < 80) return true;
  // Heuristic: content that looks like reclaim note
  if (/reclaim/i.test(content) && content.length < 200) return true;
  return false;
}

/**
 * Compaction summary head — first-class message for the compacted window.
 * Shows what was summarized, tokens freed (estimated), agent+model, with
 * the full handoff expandable. Reclaim-only renders as a lighter note.
 */
export function CompactionWidget({ message }: CompactionWidgetProps) {
  const marker = message.compacted;
  if (!marker) return null;

  const reclaimOnly = isReclaimOnly(message);
  const content = message.content ?? '';
  const summarizedCount = marker.summarizedCount;
  const mode = marker.mode;

  if (reclaimOnly) {
    return (
      <div className="orchid-compaction-reclaim flex items-center gap-2 rounded-md border border-base-300/60 bg-base-200/40 px-3 py-2 text-xs text-base-content/70" data-compaction="reclaim">
        <Icon name="layers" size={12} className="shrink-0 opacity-60" />
        <span className="min-w-0">
          Reclaimed {summarizedCount != null ? `${summarizedCount} ` : ''}duplicate tool outputs
          {content ? ` — ${content.slice(0, 120)}` : ''}
        </span>
        <StatusBadge tone="neutral" size="xs" outline>
          {mode}
        </StatusBadge>
      </div>
    );
  }

  return <CompactionSummaryCard message={message} />;
}

function CompactionSummaryCard({ message }: { message: Message }) {
  const marker = message.compacted!;
  const content = message.content ?? '';
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const preview = content.length > 280 ? `${content.slice(0, 280).trimEnd()}…` : content;
  const summarizedCount = marker.summarizedCount;
  const mode = marker.mode;

  // Tokens freed: estimate from content length or usage if present
  const tokensFreed = (() => {
    if (message.usage?.prompt_tokens || message.usage?.completion_tokens) {
      const t = (message.usage.prompt_tokens ?? 0) + (message.usage.completion_tokens ?? 0);
      if (t > 0) return `~${t.toLocaleString()} tokens`;
    }
    // Fallback: chars/4 heuristic
    if (summarizedCount != null && summarizedCount > 0) {
      // Rough estimate: 80 chars per message average
      const est = Math.round((content.length / 4));
      return `~${est.toLocaleString()} tokens`;
    }
    return null;
  })();

  return (
    <div className="orchid-compaction-card overflow-hidden rounded-md border border-base-300/70 bg-base-200/60" data-compaction="summary">
      <div className="flex items-start gap-2 px-3 py-2.5">
        <span className="mt-0.5 shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-md border border-base-300 bg-base-100 text-primary">
          <Icon name="layers" size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-base-content">Compaction summary</span>
            <StatusBadge tone="info" size="xs">{mode}</StatusBadge>
            {summarizedCount != null && (
              <StatusBadge tone="neutral" size="xs" outline>
                {summarizedCount} messages
              </StatusBadge>
            )}
            {tokensFreed && (
              <span className="text-xs text-base-content/60">{tokensFreed} freed</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/60">
            <span className="inline-flex items-center gap-1">
              <Icon name="gitBranch" size={10} className="opacity-60" />
              range {formatRange(marker)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="cpu" size={10} className="opacity-60" />
              agent compactor
            </span>
          </div>
          {/* Preview of handoff */}
          <div className="mt-2 rounded border border-base-300/60 bg-base-100 px-2.5 py-2 text-sm leading-snug text-base-content/80">
            {preview ? (
              <div className="orchid-compaction-preview whitespace-pre-wrap break-words">
                <MarkdownContent content={preview} />
              </div>
            ) : (
              <span className="text-xs text-base-content/50">No summary text</span>
            )}
          </div>
          <button
            type="button"
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={panelId}
          >
            <Icon name="chevronDown" size={12} className={`orchid-disclosure-chevron ${expanded ? 'is-open' : ''}`} />
            {expanded ? 'Hide full handoff' : 'Show full handoff'}
          </button>
          <CollapsibleRegion open={expanded} id={panelId} lazyMount>
            <div className="mt-2 max-h-96 overflow-auto rounded border border-base-300/60 bg-base-100 px-3 py-2.5 text-sm leading-snug text-base-content/85">
              <MarkdownContent content={content} />
            </div>
          </CollapsibleRegion>
        </div>
      </div>
    </div>
  );
}

/**
 * Collapsed stub for the compacted range — display-only collapse state.
 * Reuses the collapsed-stub visual pattern but with compaction-specific copy.
 */
export function CompactedRangeStub({
  count,
  onExpand,
}: {
  count: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="orchid-collapsed-chain orchid-compaction-stub"
      onClick={onExpand}
      aria-label={`Expand compacted ${count} messages`}
    >
      <Icon name="layers" size={14} />
      <span>
        Compacted {count} {count === 1 ? 'message' : 'messages'} — hidden from model, visible here. Click to expand.
      </span>
      <Icon name="chevronDown" size={12} className="ml-auto shrink-0 opacity-60" />
    </button>
  );
}

/** Lightweight reclaim stub — same interaction, lighter copy */
export function ReclaimStub({
  count,
  onExpand,
}: {
  count: number;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="orchid-collapsed-chain orchid-compaction-stub orchid-compaction-reclaim-stub"
      onClick={onExpand}
      aria-label={`Expand ${count} reclaimed tool outputs`}
    >
      <Icon name="layers" size={14} />
      <span>
        Reclaimed {count} duplicate tool {count === 1 ? 'output' : 'outputs'} — click to expand.
      </span>
      <Icon name="chevronDown" size={12} className="ml-auto shrink-0 opacity-60" />
    </button>
  );
}
