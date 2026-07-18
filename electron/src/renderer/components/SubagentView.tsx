import { useEffect, useMemo, useRef, useState } from 'react';
import type { SubagentRecord } from '../../shared/types/subagent';
import type { UseSubagentsReturn } from '../hooks/useSubagents';
import { SubagentTranscript } from './SubagentTranscript';
import { Button } from './ui/Button';
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

function newest(records: readonly SubagentRecord[]): SubagentRecord | null {
  return [...records].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time))[0] ?? null;
}

export function resolveSubagentOpenRequest(
  request: SubagentOpenRequest,
  records: readonly SubagentRecord[],
): { selectedId: string | null; narrowDetail: boolean } {
  return {
    selectedId: request.id ?? chooseNewestSubagent(records),
    narrowDetail: request.id !== null,
  };
}

export function keepSubagentRowSelected(currentId: string | null, rowId: string): string {
  return currentId === rowId ? currentId : rowId;
}

function usageLabel(record: SubagentRecord, detail: ReturnType<UseSubagentsReturn['getDetail']>): string {
  if (!detail?.usage) return `${detail?.tier ?? record.agent_tier} · no usage yet`;
  return `${detail.tier} · ${detail.usage.prompt_tokens + detail.usage.completion_tokens} tokens`;
}

function statusTone(status: SubagentRecord['status']): 'neutral' | 'warning' | 'success' | 'error' | 'info' {
  if (status === 'running') return 'warning';
  if (status === 'pending') return 'neutral';
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'error';
  return 'info';
}

function statusLabel(status: SubagentRecord['status']): string {
  return status === 'completed' ? 'completed' : status;
}

function SubagentRow({
  record,
  selected,
  detail,
  onSelect,
}: {
  record: SubagentRecord;
  selected: boolean;
  detail: ReturnType<UseSubagentsReturn['getDetail']>;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`orchid-subagent-view-row ${selected ? 'orchid-subagent-view-row-selected' : ''}`}
      aria-label={`Open ${record.agent_name || 'Subagent'} (${statusLabel(record.status)})`}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate font-medium">{record.agent_name || 'Subagent'}</span>
        <span className="block truncate text-xs text-base-content/65">{record.task || 'No task label'}</span>
      </span>
      <StatusBadge tone={statusTone(record.status)} size="xs">{statusLabel(record.status)}</StatusBadge>
      <span className="sr-only">{detail?.elapsed ?? 'elapsed unavailable'}</span>
    </button>
  );
}

export function SubagentView({ subagents, onBackToChat, openRequest }: SubagentViewProps) {
  const initialOpen = resolveSubagentOpenRequest(openRequest, subagents.subagents);
  const [narrowDetail, setNarrowDetail] = useState(initialOpen.narrowDetail);
  const appliedOpenGeneration = useRef<number | null>(null);
  const records = subagents.subagents;
  const selected = records.find((record) => record.id === subagents.selectedId) ?? null;
  const running = useMemo(() => [...subagents.groups.running].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)), [subagents.groups.running]);
  const ended = useMemo(() => [...subagents.groups.ended].sort((a, b) => Date.parse(b.start_time) - Date.parse(a.start_time)), [subagents.groups.ended]);

  useEffect(() => {
    if (!subagents.selectedId) setNarrowDetail(false);
  }, [subagents.selectedId]);

  useEffect(() => {
    if (appliedOpenGeneration.current === openRequest.generation) return;
    appliedOpenGeneration.current = openRequest.generation;
    const next = resolveSubagentOpenRequest(openRequest, subagents.subagents);
    setNarrowDetail(next.narrowDetail);
    if (next.selectedId && next.selectedId !== subagents.selectedId) {
      subagents.select(next.selectedId);
    }
  }, [openRequest.generation, openRequest.id, subagents.subagents, subagents.select, subagents.selectedId]);

  const select = (id: string) => {
    const nextId = keepSubagentRowSelected(subagents.selectedId, id);
    if (nextId !== subagents.selectedId) subagents.select(nextId);
    setNarrowDetail(true);
  };

  const renderGroup = (title: string, group: readonly SubagentRecord[]) => (
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
              selected={record.id === subagents.selectedId}
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
      <div className="orchid-subagent-view-list-header">
        <SectionHeader title="Subagents" description="Active-session output" />
      </div>
      {subagents.state.status === 'error' ? (
        <StateMessage kind="error" title={subagents.state.error} action={<Button size="sm" variant="ghost" onClick={() => void subagents.retry()} disabled={retryDisabled} loading={subagents.isRetrying}>Retry</Button>} />
      ) : subagents.state.status === 'loading' ? (
        <StateMessage kind="loading" title="Loading subagents…" />
      ) : subagents.state.status === 'empty' ? (
        <StateMessage kind="empty" title="No subagents in this session" />
      ) : (
        <div className="orchid-subagent-view-groups">{renderGroup('Running', running)}{renderGroup('Ended', ended)}</div>
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
            description={selected.task || 'No task label'}
            actions={<StatusBadge tone={statusTone(selected.status)}>{statusLabel(selected.status)}</StatusBadge>}
          />
        ) : null}
      </div>
      {!selected ? (
        <StateMessage kind="info" title="Select a subagent">Choose a row to inspect its live output.</StateMessage>
      ) : detail ? (
        <>
          <div className="orchid-subagent-view-metadata" aria-label="Subagent metadata">
            <span>Elapsed {detail.elapsed}</span><span>{usageLabel(selected, detail)}</span><span>{detail.type}</span>
          </div>
          <div className="orchid-subagent-view-transcript">
            <SubagentTranscript record={selected} live={subagents.getLive(selected.id)} selectedId={selected.id} />
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
        description="Inspect live and completed output for this session."
        actions={<Button size="sm" variant="ghost" icon="chevronLeft" onClick={onBackToChat}>Back to chat</Button>}
      />
      <div className="orchid-subagent-view-container">
        <div className={narrowDetail ? 'orchid-subagent-view-narrow-hidden' : ''}>{list}</div>
        <div className={!narrowDetail ? 'orchid-subagent-view-narrow-hidden' : ''}>{detailRegion}</div>
      </div>
    </section>
  );
}

export function chooseNewestSubagent(records: readonly SubagentRecord[]): string | null {
  const active = records.filter((record) => record.status === 'running' || record.status === 'pending');
  return (newest(active.length > 0 ? active : records))?.id ?? null;
}
