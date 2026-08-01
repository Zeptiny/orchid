import type { StreamEvent } from '../llm/orchestrator';
import { addStepUsage } from '../../shared/usage';
import type { Message, Usage } from '../../shared/types/message';
import type { CanonicalToolResult, TerminalToolResultStatus } from '../../shared/types/tool-result';
import {
  makeAssistantMessage,
  makeThinkingMessage,
  makeToolCallMessage,
  makeToolResultMessage,
} from '../llm/message-factories';

export type SubagentRunProjectionEffect =
  | {
      readonly type: 'append_text';
      readonly kind: 'text' | 'thinking';
      readonly segmentId: string;
      readonly append: string;
    }
  | {
      readonly type: 'usage';
      readonly usage: Usage;
    }
  | {
      readonly type: 'tool_start';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly segmentId: string;
      readonly startedAt: string;
    }
  | {
      readonly type: 'tool_args_delta';
      readonly toolCallId: string;
      readonly append: string;
    }
  | {
      readonly type: 'tool_call';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: string;
      readonly segmentId: string | undefined;
      readonly startedAt: string | undefined;
      readonly messages: readonly Message[];
      readonly committedSegmentCount: number;
    }
  | {
      readonly type: 'tool_result';
      readonly toolCallId: string;
      readonly content: string;
      readonly status: TerminalToolResultStatus;
      readonly toolResult: CanonicalToolResult;
      readonly finishedAt: string;
      readonly messages: readonly Message[];
      readonly committedSegmentCount: number;
    };

export interface SubagentRunFinalization {
  readonly state: 'completed' | 'interrupted' | 'failed';
  readonly messages: readonly Message[];
  readonly usage: Usage | null;
  readonly result: string | null;
  readonly error: string | null;
}

export interface SubagentRunAssemblerOptions {
  readonly newId?: () => string;
  readonly now?: () => string;
}

type AssemblySegment =
  | { kind: 'text'; id: string; content: string }
  | { kind: 'thinking'; id: string; content: string }
  | { kind: 'tool'; id: string; toolCallId: string };

interface AssemblyTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly segmentId: string;
  readonly startedAt: string;
}

/**
 * Folds one subagent stream into its durable transcript and live-projection
 * effects. The manager remains responsible for applying those effects to a
 * record, emitting deltas, and advancing the run lifecycle.
 */
export class SubagentRunAssembler {
  private readonly messages: Message[];
  private readonly segments: AssemblySegment[] = [];
  private readonly tools = new Map<string, AssemblyTool>();
  private readonly toolNames = new Map<string, string>();
  private readonly newId: () => string;
  private readonly now: () => string;
  private committedSegmentCount = 0;
  private responseText = '';
  private resultText = '';
  private stepText = '';
  private lastStepResult = '';
  private accumulatedUsage: Usage | null = null;

  constructor(initialMessages: readonly Message[], options: SubagentRunAssemblerOptions = {}) {
    this.messages = [...initialMessages];
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  accept(event: StreamEvent): readonly SubagentRunProjectionEffect[] {
    switch (event.type) {
      case 'content': {
        this.responseText += event.text;
        this.resultText += event.text;
        this.stepText += event.text;
        return [this.appendText('text', event.text)];
      }
      case 'thinking':
        return [this.appendText('thinking', event.text)];
      case 'usage': {
        this.accumulatedUsage = addStepUsage(this.accumulatedUsage, event.usage);
        return this.accumulatedUsage ? [{ type: 'usage', usage: this.accumulatedUsage }] : [];
      }
      case 'tool_call_start':
        return this.ensureTool(event.toolCallId, event.toolName);
      case 'tool_call_delta': {
        const effects = this.ensureTool(event.toolCallId, 'unknown');
        effects.push({ type: 'tool_args_delta', toolCallId: event.toolCallId, append: event.argsDelta });
        return effects;
      }
      case 'tool_call':
        return this.handleToolCall(event.toolCallId, event.toolName, event.args);
      case 'tool_result':
        return [this.handleToolResult(event)];
      case 'step_finish':
        if (this.stepText.trim()) this.lastStepResult = this.stepText;
        this.stepText = '';
        return [];
      case 'error':
        throw new Error(event.detail || event.title || 'Subagent stream error');
      case 'finish':
        return [];
      default:
        return [];
    }
  }

  complete(): SubagentRunFinalization {
    this.commitThrough(this.segments.length, this.accumulatedUsage);
    const finalStepText = this.stepText.trim() ? this.stepText : this.lastStepResult;
    return this.finalization(
      'completed',
      finalStepText || this.resultText || this.responseText || null,
      null,
    );
  }

  interrupt(): SubagentRunFinalization {
    this.commitThrough(this.segments.length, this.accumulatedUsage);
    return this.finalization('interrupted', this.resultText || this.responseText || null, null);
  }

  fail(error: string): SubagentRunFinalization {
    this.commitThrough(this.segments.length, this.accumulatedUsage);
    return this.finalization('failed', null, error);
  }

  private appendText(kind: 'text' | 'thinking', append: string): SubagentRunProjectionEffect {
    const last = this.segments.at(-1);
    if (last?.kind === kind) {
      last.content += append;
      return { type: 'append_text', kind, segmentId: last.id, append };
    }

    const segmentId = this.newId();
    this.segments.push({ kind, id: segmentId, content: append });
    return { type: 'append_text', kind, segmentId, append };
  }

  private ensureTool(toolCallId: string, toolName: string): SubagentRunProjectionEffect[] {
    if (this.tools.has(toolCallId)) return [];
    const segmentId = this.newId();
    const startedAt = this.now();
    this.tools.set(toolCallId, { toolCallId, toolName, segmentId, startedAt });
    this.toolNames.set(toolCallId, toolName);
    this.segments.push({ kind: 'tool', id: segmentId, toolCallId });
    return [{ type: 'tool_start', toolCallId, toolName, segmentId, startedAt }];
  }

  private handleToolCall(
    toolCallId: string,
    toolName: string,
    args: string,
  ): SubagentRunProjectionEffect[] {
    const effects = this.ensureTool(toolCallId, toolName);
    this.toolNames.set(toolCallId, toolName);
    const tool = this.tools.get(toolCallId);
    const toolIndex = tool
      ? this.segments.findIndex((segment) => segment.kind === 'tool' && segment.toolCallId === toolCallId)
      : this.segments.length;
    this.commitThrough(toolIndex);
    this.messages.push(makeToolCallMessage(toolCallId, toolName, args, tool?.segmentId));
    // A tool segment is represented by its durable tool-call message, not by
    // `commitThrough`, so advance past it after adding that message.
    this.committedSegmentCount = this.segments.length;
    effects.push({
      type: 'tool_call',
      toolCallId,
      toolName,
      args,
      segmentId: tool?.segmentId,
      startedAt: tool?.startedAt,
      messages: [...this.messages],
      committedSegmentCount: this.committedSegmentCount,
    });
    return effects;
  }

  private handleToolResult(
    event: Extract<StreamEvent, { type: 'tool_result' }>,
  ): SubagentRunProjectionEffect {
    const toolName = this.toolNames.get(event.toolCallId) ?? 'unknown';
    const tool = this.tools.get(event.toolCallId);
    if (!this.messages.some(
      (message) => message.type === 'tool_call' && message.tool_call_id === event.toolCallId,
    )) {
      this.messages.push(makeToolCallMessage(event.toolCallId, toolName, '{}', tool?.segmentId));
    }
    this.messages.push(makeToolResultMessage(
      event.toolCallId,
      toolName,
      event.content,
      event.execution.canonical,
      `${event.toolCallId}:result`,
    ));
    this.committedSegmentCount = this.segments.length;
    return {
      type: 'tool_result',
      toolCallId: event.toolCallId,
      content: event.content,
      status: event.execution.canonical.status,
      toolResult: event.execution.canonical,
      finishedAt: this.now(),
      messages: [...this.messages],
      committedSegmentCount: this.committedSegmentCount,
    };
  }

  private commitThrough(endIndex: number, usage: Usage | null = null): void {
    const lastTextIndex = this.segments
      .slice(this.committedSegmentCount, endIndex)
      .map((segment, index) => ({ segment, index: this.committedSegmentCount + index }))
      .filter(({ segment }) => segment.kind === 'text')
      .at(-1)?.index;
    for (let index = this.committedSegmentCount; index < endIndex; index += 1) {
      const segment = this.segments[index];
      if (segment.kind === 'text' && segment.content.trim()) {
        this.messages.push(makeAssistantMessage(
          segment.content,
          usage && index === lastTextIndex ? usage : null,
          segment.id,
        ));
      } else if (segment.kind === 'thinking' && segment.content.trim()) {
        this.messages.push(makeThinkingMessage(segment.content, segment.id));
      }
    }
    this.committedSegmentCount = Math.max(this.committedSegmentCount, endIndex);
  }

  private finalization(
    state: SubagentRunFinalization['state'],
    result: string | null,
    error: string | null,
  ): SubagentRunFinalization {
    return {
      state,
      messages: [...this.messages],
      usage: this.accumulatedUsage,
      result,
      error,
    };
  }
}
