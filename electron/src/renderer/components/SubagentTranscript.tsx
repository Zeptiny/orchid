import { useMemo } from 'react';
import type { Message } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import type {
  SubagentLiveProjection,
  SubagentLiveSegment,
  SubagentRecord,
  SubagentToolSnapshot,
} from '../../shared/types/subagent';
import type { ToolBlock } from '../hooks/useChat';
import { useSmartAutoScroll } from '../hooks/useSmartAutoScroll';
import { foldActivityRuns, isActiveToolStatus, isGroupableTool } from '../utils/tool-grouping';
import { MessageWidget } from './MessageWidget';
import type { ActivityChild } from '../utils/stream-building';
import { ToolActivityGroup } from './ToolActivityGroup';
import { ToolCallBlock } from './ToolCallBlock';
import { Button } from './ui/Button';

export type SubagentTranscriptItem =
  | { kind: 'message'; key: string; message: Message; isStreaming?: boolean }
  | { kind: 'tool'; key: string; block: ToolBlock }
  | { kind: 'tool-group'; key: string; children: ActivityChild[] };

export function isVisibleSubagentMessage(message: Message): boolean {
  return !message.hidden && message.role !== MessageRole.SYSTEM;
}

function snapshotToToolBlock(snapshot: SubagentToolSnapshot): ToolBlock {
  return {
    id: snapshot.toolCallId,
    toolName: snapshot.toolName,
    status: snapshot.status === 'error' ? 'failed' : snapshot.status,
    partialArgs: snapshot.partialArgs,
    args: snapshot.args,
    agentProjection: snapshot.content,
    toolResult: snapshot.toolResult,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
  };
}

function messageToToolBlock(message: Message, result: Message | null): ToolBlock {
  const call = message.tool_calls?.[0];
  const canonical = result?.tool_result ?? null;
  return {
    id: message.tool_call_id ?? call?.id ?? message.id,
    toolName: call?.function?.name ?? message.name ?? 'tool',
    // Match ChatStream's canonical persisted-message conversion: a call with
    // no paired result is a settled historical tool, not a live operation.
    status: canonical?.status === 'error' ? 'failed' : canonical?.status ?? 'completed',
    partialArgs: '',
    args: call?.function?.arguments ?? message.content,
    agentProjection: result?.content ?? null,
    toolResult: canonical,
    startedAt: message.timestamp,
    finishedAt: result?.timestamp ?? message.timestamp,
  };
}

function resultToToolBlock(message: Message): ToolBlock {
  const canonical = message.tool_result;
  return {
    id: message.tool_call_id ?? message.id,
    toolName: message.name ?? 'tool',
    status: canonical?.status === 'error' ? 'failed' : canonical?.status ?? 'completed',
    partialArgs: '', args: '',
    agentProjection: message.content,
    toolResult: canonical,
    startedAt: message.timestamp, finishedAt: message.timestamp,
  };
}

function textMessage(id: string, content: string, type: MessageType, isStreaming = false): Message {
  return {
    id, role: type === MessageType.THINKING ? MessageRole.ASSISTANT : MessageRole.ASSISTANT,
    content, type, tool_calls: null, tool_call_id: null, name: null, thinking: null,
    timestamp: new Date().toISOString(), usage: null, hidden: false,
    tool_result: null,
    ...(isStreaming ? {} : {}),
  };
}

function liveToolBlock(
  segment: Extract<SubagentLiveSegment, { kind: 'tool' }>,
  snapshots: ReadonlyMap<string, SubagentToolSnapshot>,
): ToolBlock | null {
  const snapshot = snapshots.get(segment.toolCallId);
  return snapshot ? snapshotToToolBlock(snapshot) : null;
}

/** Pure chronological projection used by the component and renderer tests. */
export function buildSubagentTranscriptItems(
  record: SubagentRecord,
  live: SubagentLiveProjection | null,
): SubagentTranscriptItem[] {
  const messages = record.chain.messages.filter(isVisibleSubagentMessage);
  const results = new Map<string, Message>();
  for (const message of messages) {
    if (message.type === MessageType.TOOL_RESULT && message.tool_call_id) {
      results.set(message.tool_call_id, message);
    }
  }

  const items: SubagentTranscriptItem[] = [];
  const committedMessageIds = new Set(messages.map((message) => message.id));
  const committedToolIds = new Set<string>();
  const consumedResults = new Set<string>();
  const pushMessage = (message: Message) => {
    if (message.content.trim()) items.push({ kind: 'message', key: message.id, message });
  };

  for (const message of messages) {
    if (message.type === MessageType.TOOL_CALL) {
      const toolId = message.tool_call_id ?? message.tool_calls?.[0]?.id ?? message.id;
      const result = results.get(toolId) ?? null;
      consumedResults.add(toolId);
      committedToolIds.add(toolId);
      items.push({ kind: 'tool', key: toolId, block: messageToToolBlock(message, result) });
    } else if (message.type === MessageType.TOOL_RESULT) {
      const toolId = message.tool_call_id ?? message.id;
      if (!consumedResults.has(toolId)) {
        committedToolIds.add(toolId);
        items.push({ kind: 'tool', key: toolId, block: resultToToolBlock(message) });
      }
    } else if (message.type === MessageType.TEXT || message.type === MessageType.THINKING) {
      pushMessage(message);
    }
  }

  if (live) {
    const snapshots = new Map(live.toolCalls.map((snapshot) => [snapshot.toolCallId, snapshot]));
    for (const [index, segment] of live.segments.entries()) {
      if (segment.kind === 'tool') {
        if (committedToolIds.has(segment.toolCallId)) continue;
        const block = liveToolBlock(segment, snapshots);
        if (block) {
          committedToolIds.add(segment.toolCallId);
          items.push({ kind: 'tool', key: segment.toolCallId, block });
        }
      } else {
        if (committedMessageIds.has(segment.id)) continue;
        if (segment.content.trim()) {
          const type = segment.kind === 'thinking' ? MessageType.THINKING : MessageType.TEXT;
          items.push({ kind: 'message', key: segment.id || `live-${index}`, message: textMessage(segment.id || `live-${index}`, segment.content, type), isStreaming: live.state === 'running' && index === live.segments.length - 1 });
        }
      }
    }
  }

  return foldTranscriptActivityGroups(items);
}

function foldTranscriptActivityGroups(items: readonly SubagentTranscriptItem[]): SubagentTranscriptItem[] {
  return foldActivityRuns(items, {
    classify: (item) => {
      if (item.kind === 'tool' && isGroupableTool(item.block.toolName)) {
        return isActiveToolStatus(item.block.status) ? 'active' : 'settled-tool';
      }
      if (item.kind === 'message' && item.message.type === MessageType.THINKING) {
        return item.isStreaming ? 'active' : 'settled-thought';
      }
      return 'break';
    },
    makeGroup: (sources) => {
      const children: ActivityChild[] = sources.flatMap((source): ActivityChild[] => {
        if (source.kind === 'tool') return [{ kind: 'tool' as const, block: source.block }];
        if (source.kind === 'message' && source.message.type === MessageType.THINKING) {
          return [{ kind: 'thought' as const, message: source.message, isStreaming: source.isStreaming }];
        }
        return [];
      });
      const sourceIdentity = sources
        .map((source) => source.kind === 'tool'
          ? `tool:${source.block.id}`
          : source.kind === 'message'
            ? `message:${source.message.id}`
            : `group:${source.key}`)
        .join('|');
      return { kind: 'tool-group', key: `subagent-activity-${sourceIdentity}`, children };
    },
  });
}

export interface SubagentTranscriptProps {
  record: SubagentRecord;
  live?: SubagentLiveProjection | null;
  selectedId?: string | null;
}

export function SubagentTranscript({ record, live = null, selectedId = null }: SubagentTranscriptProps) {
  const items = useMemo(() => buildSubagentTranscriptItems(record, live), [record, live]);
  const contentKey = `${record.id}:${live?.sequence ?? 'durable'}:${items.length}`;
  const scroll = useSmartAutoScroll({ resetKey: selectedId ?? record.id, contentKey });
  // Subagent records carry their owning session on the persisted chain.
  const sessionId = record.chain.sessionId || live?.sessionId || null;

  return (
    <div className="relative flex min-h-0 min-w-0 w-full max-w-full flex-1 flex-col overflow-hidden">
      <div className="orchid-chat-scroll min-h-0 min-w-0 w-full max-w-full flex-1 px-6 py-5" ref={scroll.containerRef}>
        {items.map((item) => {
          if (item.kind === 'tool') return <ToolCallBlock key={item.key} block={item.block} sessionId={sessionId} />;
          if (item.kind === 'tool-group') return <ToolActivityGroup key={item.key} items={item.children} sessionId={sessionId} />;
          return <MessageWidget key={item.key} message={item.message} isStreaming={item.isStreaming} />;
        })}
        {record.error || record.status === 'interrupted' || record.status === 'failed' ? (
          <div role="status" aria-label="Subagent terminal status" className="text-error">
            {record.error ?? (record.status === 'failed' ? 'Subagent failed' : 'Subagent interrupted')}
          </div>
        ) : null}
      </div>
      {scroll.isUserScrolledUp ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="pointer-events-auto absolute bottom-4 right-6 z-10"
          onClick={scroll.jumpToLatest}
        >
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
