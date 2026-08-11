import { useEffect, useRef, useState } from 'react';
import type { SubagentSummary } from '../../shared/types/subagent';
import type { UseSubagentsReturn } from '../hooks/useSubagents';
import { formatUsageSummary } from '../utils/format-usage';
import { SubagentTranscript } from './SubagentTranscript';
import { Button } from './ui/Button';
import { Disclosure } from './ui/Disclosure';
import { IconButton } from './ui/IconButton';
import { Panel } from './ui/Panel';
import { SectionHeader } from './ui/SectionHeader';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';

interface SubagentViewProps {
  subagents: UseSubagentsReturn;
  onBackToChat: () => void;
  openRequest: SubagentOpenRequest;
}

export interface SubagentOpenRequest {
  generation: number;
  id: string | null;
}

export function resolveSubagentOpenRequest(
  request: SubagentOpenRequest,
): { selectedId: string | null; narrowDetail: boolean } {
  return {
    selectedId: request.id,
    narrowDetail: request.id !== null,
  };
}

export function keepSubagentRowSelected(currentId: string | null, rowId: string): string {
  return currentId === rowId ? currentId : rowId;
}

export const formatSubagentUsage = formatUsageSummary;

function statusTone(status: SubagentSummary['status']): 'neutral' | 'warning' | 'success' | 'error' | 'info' {
  if (status === 'running') return 'warning';
  if (status === 'pending' || status === 'queued') return 'neutral';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'info';
}

function statusLabel(status: SubagentSummary['status']): string {
  return status === 'completed' ? 'completed' : status;
}

function SubagentRow({
  record,
  selected,
  detail,
  onSelect,
}: {
  record: SubagentSummary;
  selected: boolean;
  detail: ReturnType<UseSubagentsReturn['getDetail']>;
  onSelect: () => void;
}) {
  const displayState = detail?.state ?? record.status;
  return (
    <button
      type="button"
      className={`orchid-subagent-view-row ${selected ? 'orchid-subagent-view-row-selected' : ''}`}
      aria-label={`Open ${record.agent_name || 'Subagent'} (${statusLabel(displayState)})`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-medium">{record.agent_name || 'Subagent'}</span>
        <span className="block truncate text-xs text-base-content/65">
          Elapsed {detail?.elapsed ?? '—'} · {formatSubagentUsage(detail?.usage ?? null)}{detail?.type ? ` · ${detail.type}` : ''}
        </span>
      </span>
      <StatusBadge tone={statusTone(displayState)} size="xs">{statusLabel(displayState)}</StatusBadge>
    </button>
  );
}

export function SubagentView({ subagents, onBackToChat, openRequest }: SubagentViewProps) {
  const initialOpen = resolveSubagentOpenRequest(openRequest);
  const [narrowDetail, setNarrowDetail] = useState(initialOpen.narrowDetail);
  const appliedOpenGeneration = useRef<number | null>(null);
  const records = subagents.subagents;
  const hasPendingOpenRequest = appliedOpenGeneration.current !== openRequest.generation;
  const effectiveSelectedId = hasPendingOpenRequest ? openRequest.id : subagents.selectedId;
  const selected = records.find((record) => record.id === effectiveSelectedId) ?? null;
  const missingSelected = effectiveSelectedId !== null && selected === null;
  const { queued, running, ended } = subagents.groups;

  useEffect(() => {
    if (!subagents.selectedId) setNarrowDetail(false);
  }, [subagents.selectedId]);

  useEffect(() => {
    if (appliedOpenGeneration.current === openRequest.generation) return;
    appliedOpenGeneration.current = openRequest.generation;
    const next = resolveSubagentOpenRequest(openRequest);
    setNarrowDetail(next.narrowDetail);
    if (next.selectedId !== subagents.selectedId) {
      subagents.select(next.selectedId);
    }
  }, [openRequest.generation, openRequest.id, subagents.select, subagents.selectedId]);

  const select = (id: string) => {
    const nextId = keepSubagentRowSelected(effectiveSelectedId, id);
    if (nextId !== effectiveSelectedId) subagents.select(nextId);
    setNarrowDetail(true);
  };

  const renderGroup = (title: string, group: readonly SubagentSummary[]) => (
    <section className="orchid-subagent-view-group" aria-labelledby={`subagent-${title.toLowerCase()}`}>
      <SectionHeader title={<span id={`subagent-${title.toLowerCase()}`}>{title}</span>} />
      {group.length === 0 ? (
        <p className="px-2 py-3 text-xs text-base-content/60">No {title.toLowerCase()} subagents.</p>
      ) : (
        <div className="orchid-subagent-view-rows">
          {group.map((record) => (
            <SubagentRow
              key={record.id}
              record={record}
              selected={record.id === effectiveSelectedId}
              detail={subagents.getDetail(record.id)}
              onSelect={() => select(record.id)}
            />
          ))}
        </div>
      )}
    </section>
  );

  const retryDisabled = subagents.isRetrying || subagents.state.status === 'loading';
  const list = (
    <Panel className="orchid-subagent-view-list" padded={false} aria-label="Subagent sessions">
      {subagents.state.status === 'error' ? (
        <StateMessage kind="error" title={subagents.state.error} action={<Button size="sm" variant="ghost" onClick={() => void subagents.retry()} disabled={retryDisabled} loading={subagents.isRetrying}>Retry</Button>} />
      ) : subagents.state.status === 'loading' ? (
        <StateMessage kind="loading" title="Loading subagents…" />
      ) : subagents.state.status === 'empty' ? (
        <StateMessage kind="empty" title="No subagents in this session" />
      ) : (
        <div className="orchid-subagent-view-groups">{renderGroup('Running', running)}{renderGroup('Queued', queued)}{renderGroup('Ended', ended)}</div>
      )}
    </Panel>
  );

  const detail = selected ? subagents.getDetail(selected.id) : null;
  const detailRegion = (
    <Panel className="orchid-subagent-view-detail" padded={false} aria-label="Subagent detail">
      <div className="orchid-subagent-view-detail-header">
        <IconButton label="Back to subagents" icon="chevronLeft" size="sm" className="orchid-subagent-view-narrow-back" onClick={() => setNarrowDetail(false)} />
        {selected ? (
          <SectionHeader
            title={selected.agent_name || 'Subagent'}
            actions={<StatusBadge tone={statusTone(detail?.state ?? selected.status)}>{statusLabel(detail?.state ?? selected.status)}</StatusBadge>}
          />
        ) : null}
      </div>
      {missingSelected ? (
        <StateMessage kind="warning" title="Selected subagent is no longer available" action={<Button size="sm" variant="ghost" onClick={() => { subagents.select(null); setNarrowDetail(false); }}>Back to list</Button>} />
      ) : !selected ? (
        <StateMessage kind="info" title="Select a subagent">Choose a row to inspect its live output.</StateMessage>
      ) : detail ? (
        <>
          <div className="orchid-subagent-view-metadata" aria-label="Subagent metadata">
            <span>Elapsed {detail.elapsed}</span>
            {detail.type ? <span>{detail.type}</span> : null}
            <span>{detail.tier}</span>
            <span>{formatSubagentUsage(detail.usage)}</span>
          </div>
          {selected.task ? (
            <Disclosure
              summary="Prompt"
              variant="section"
              className="shrink-0"
            >
              <div className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm text-base-content/80">
                {selected.task}
              </div>
            </Disclosure>
          ) : null}
          <div className="orchid-subagent-view-transcript">
            {subagents.transcript.status === 'ready' ? (
              <SubagentTranscript
                record={subagents.transcript.record}
                live={subagents.getLive(selected.id)}
                selectedId={selected.id}
              />
            ) : subagents.transcript.status === 'error' ? (
              <StateMessage
                kind="error"
                title={subagents.transcript.error}
                action={<Button size="sm" variant="ghost" onClick={() => void subagents.retryTranscript()}>Retry</Button>}
              />
            ) : subagents.transcript.status === 'unavailable' ? (
              <StateMessage kind="warning" title="Subagent transcript is no longer available" />
            ) : (
              <StateMessage kind="loading" title="Loading transcript…" />
            )}
          </div>
        </>
      ) : (
        <StateMessage kind="warning" title="Selected subagent is no longer available" action={<Button size="sm" variant="ghost" onClick={() => subagents.select(null)}>Back to list</Button>} />
      )}
    </Panel>
  );

  return (
    <section className="orchid-subagent-view" aria-labelledby="subagent-view-title">
      <SectionHeader
        title={<span id="subagent-view-title">Subagent View</span>}
        actions={<Button size="sm" variant="ghost" icon="chevronLeft" onClick={onBackToChat}>Back to chat</Button>}
      />
      <div className={`orchid-subagent-view-container ${selected || missingSelected ? '' : 'orchid-subagent-view-container-single'}`.trim()}>
        <div className={narrowDetail ? 'orchid-subagent-view-narrow-hidden' : ''}>{list}</div>
        {selected || missingSelected ? (
          <div className={!narrowDetail ? 'orchid-subagent-view-narrow-hidden' : ''}>{detailRegion}</div>
        ) : null}
      </div>
    </section>
  );
}
