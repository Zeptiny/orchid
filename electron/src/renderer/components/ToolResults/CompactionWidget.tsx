import { useEffect, useId, useMemo, useState } from 'react';
import type { Message } from '../../../shared/types/message';
import { MarkdownContent } from '../MarkdownContent';
import { Icon } from '../Icon';
import { StatusBadge } from '../ui/StatusBadge';
import { CollapsibleRegion } from '../ui/CollapsibleRegion';
import { Spinner } from '../ui/Spinner';

export interface CompactionWidgetProps {
  message: Message;
}

export interface CompactionRunningWidgetProps {
  status: 'running' | 'generating';
  phase?: string;
  mode?: string;
  /** Live compactor output tail — summary text (simple) or raw ops JSON (selective). */
  streamText?: string | null;
  /** Calibrated token estimate of `streamText`; null when no calibration exists. */
  estimatedTokens?: number | null;
}

const STREAM_TAIL_LINES = 4;

function streamTail(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-STREAM_TAIL_LINES).join('\n');
}

export function CompactionRunningWidget({ status, phase, mode, streamText, estimatedTokens }: CompactionRunningWidgetProps) {
  const label = phase === 'reclaiming' ? 'Reclaiming duplicate outputs…' : 'Compacting context…';
  const detail = phase === 'summarizing' ? 'Summarizing history' : phase === 'reclaiming' ? 'Removing duplicates' : 'Preparing compaction';
  const hasStream = typeof streamText === 'string' && streamText.length > 0;
  const sizeLabel = !hasStream
    ? ''
    : typeof estimatedTokens === 'number' && estimatedTokens >= 0
      ? `~${estimatedTokens.toLocaleString()} tokens`
      : `${streamText!.length.toLocaleString()} chars`;
  return (
    <div className="orchid-tool-block orchid-compaction-block is-running" data-compaction="running" data-tool-result-status="running" aria-live="polite" aria-busy="true">
      <div className="orchid-tool-block-title min-w-0">
        <span className="orchid-tool-block-title-left min-w-0">
          <span className="orchid-tool-lifecycle-icon shrink-0">
            <Spinner size="xs" />
          </span>
          <span className="orchid-tool-block-title-text min-w-0 truncate">{label}</span>
        </span>
        <span className="orchid-tool-block-title-right shrink-0">
          {mode && <StatusBadge tone="info" size="xs">{mode}</StatusBadge>}
          <StatusBadge tone="warning" size="xs">{status}</StatusBadge>
        </span>
      </div>
      {hasStream ? (
        <div className="orchid-tool-block-content orchid-compaction-content min-w-0" data-compaction-stream="tail">
          <div className="mb-1 flex items-center gap-2 text-xs text-base-content/60">
            <span>{detail} — streaming</span>
            <span className="text-base-content/40">{sizeLabel}</span>
          </div>
          <pre className="orchid-compaction-stream-tail m-0 max-h-28 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-base-content/55">
            {streamTail(streamText!)}
          </pre>
        </div>
      ) : (
        <div className="orchid-tool-block-content orchid-compaction-content min-w-0 text-xs text-base-content/60">
          {detail} — the summary will appear when ready.
        </div>
      )}
    </div>
  );
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
 * Collapsed state matches the tool call widget: a single disclosure row
 * (icon + title + badges + chevron). Expanding reveals the full handoff
 * markdown — no duplicated preview slice. Reclaim-only renders as a
 * lighter note.
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
  const [hasExpanded, setHasExpanded] = useState(false);
  const panelId = useId();
  const announcementId = useId();
  const summarizedCount = marker.summarizedCount;
  const mode = marker.mode;

  useEffect(() => {
    if (expanded) setHasExpanded(true);
  }, [expanded]);

  const tokensFreed = marker.tokensFreed != null && marker.tokensFreed > 0
    ? `~${marker.tokensFreed.toLocaleString()} tokens freed`
    : null;
  const compactorTokens = marker.compactorTokens
    ? `compactor ${marker.compactorTokens.inputTokens.toLocaleString()} in / ${marker.compactorTokens.outputTokens.toLocaleString()} out`
    : null;

  const body = useMemo(() => {
    if (!expanded && !hasExpanded) return null;
    if (!content.trim()) return <span className="text-xs text-base-content/50">No summary text</span>;
    return <MarkdownContent content={content} />;
  }, [expanded, hasExpanded, content]);

  const toggle = () => setExpanded((v) => !v);
  const collapse = () => setExpanded(false);

  return (
    <div className="orchid-tool-block orchid-compaction-block" data-compaction="summary" data-tool-result-status="complete">
      <button
        type="button"
        className="orchid-tool-block-title min-w-0"
        onClick={toggle}
        aria-expanded={expanded}
        aria-controls={panelId}
      >
        <span className="orchid-tool-block-title-left min-w-0">
          <span className="orchid-tool-lifecycle-icon shrink-0">
            <Icon name="layers" size={12} />
          </span>
          <span className="orchid-tool-block-title-text min-w-0 truncate">Compaction summary</span>
        </span>
        <span className="orchid-tool-block-title-right shrink-0">
          <StatusBadge tone="info" size="xs">{mode}</StatusBadge>
          {summarizedCount != null && (
            <StatusBadge tone="neutral" size="xs" outline>
              {summarizedCount} messages
            </StatusBadge>
          )}
          {tokensFreed && <span className="hidden text-xs text-base-content/60 sm:inline">{tokensFreed}</span>}
          <Icon name="chevronDown" size={12} className={`orchid-disclosure-chevron ${expanded ? 'is-open' : ''}`} />
        </span>
      </button>
      <CollapsibleRegion open={expanded} id={panelId} lazyMount>
        <div
          className="orchid-tool-block-content orchid-compaction-content min-w-0"
          aria-describedby={announcementId}
          onClick={collapse}
          title="Click to collapse"
        >
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/60">
            <span className="inline-flex items-center gap-1">
              <Icon name="gitBranch" size={10} className="opacity-60" />
              range {formatRange(marker)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="cpu" size={10} className="opacity-60" />
              agent compactor
            </span>
            {compactorTokens && (
              <span className="inline-flex items-center gap-1">
                <Icon name="cpu" size={10} className="opacity-60" />
                {compactorTokens}
              </span>
            )}
            {tokensFreed && <span className="sm:hidden">{tokensFreed}</span>}
          </div>
          {body}
          <span id={announcementId} className="sr-only" role="status" aria-live="polite">
            {expanded ? 'expanded compaction summary' : 'collapsed compaction summary'}
          </span>
        </div>
      </CollapsibleRegion>
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
      aria-label={`Expand compacted ${count} ${count === 1 ? 'message' : 'messages'}`}
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
