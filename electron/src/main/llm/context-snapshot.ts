import type { ModelMessage, Tool } from 'ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ContextSnapshot } from '../../shared/types/message';

interface ContextSnapshotInput {
  systemPrompt: string;
  tools: Record<string, Tool>;
  messages: readonly ModelMessage[];
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  /** Provider-reported reasoning tokens, already included in `outputTokens`. */
  reasoningTokens?: number | undefined;
}

type DynamicContextSnapshotInput = Pick<
  ContextSnapshotInput,
  'messages' | 'inputTokens' | 'outputTokens' | 'reasoningTokens'
>;

interface ContextChars {
  system: number;
  tools: number;
  toolUse: number;
  user: number;
  assistant: number;
}

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

function toolDefinitionsLength(tools: Record<string, Tool>): number {
  const definitions = Object.entries(tools).map(([name, tool]) => {
    const inputSchema = tool.inputSchema as unknown as {
      safeParse?: (value: unknown) => unknown;
    };
    return {
      name,
      description: tool.description,
      inputSchema:
        typeof inputSchema?.safeParse === 'function'
          ? zodToJsonSchema(tool.inputSchema as never)
          : inputSchema,
    };
  });
  return definitions.length > 0 ? serializedLength(definitions) : 0;
}

function messageChars(messages: readonly ModelMessage[]): Omit<ContextChars, 'system' | 'tools'> {
  const chars = { toolUse: 0, user: 0, assistant: 0 };

  for (const message of messages) {
    if (message.role === 'tool') {
      chars.toolUse += serializedLength(message.content);
      continue;
    }

    if (typeof message.content === 'string') {
      if (message.role === 'user') chars.user += message.content.length;
      else if (message.role === 'assistant') chars.assistant += message.content.length;
      continue;
    }

    for (const part of message.content) {
      if (message.role === 'assistant' && part.type === 'tool-call') {
        chars.toolUse += serializedLength(part);
      } else if (message.role === 'user') {
        chars.user += serializedLength(part);
      } else if (message.role === 'assistant') {
        chars.assistant += serializedLength(part);
      }
    }
  }

  return chars;
}

function allocateInputTokens(chars: ContextChars, inputTokens: number): ContextChars {
  const entries = Object.entries(chars) as Array<[keyof ContextChars, number]>;
  const totalChars = entries.reduce((sum, [, count]) => sum + count, 0);

  if (totalChars <= 0) {
    return { system: inputTokens, tools: 0, toolUse: 0, user: 0, assistant: 0 };
  }

  const allocated: ContextChars = {
    system: 0,
    tools: 0,
    toolUse: 0,
    user: 0,
    assistant: 0,
  };
  for (const [key, count] of entries) {
    allocated[key] = Math.floor((count / totalChars) * inputTokens);
  }
  const allocatedTotal = Object.values(allocated).reduce((sum, count) => sum + count, 0);
  const largestKey = entries.reduce((largest, entry) =>
    entry[1] > largest[1] ? entry : largest,
  )[0];
  allocated[largestKey] += inputTokens - allocatedTotal;
  return allocated;
}

/** Precompute fixed prompt/tool weights for repeated snapshots in one turn. */
export function createContextSnapshotBuilder(
  systemPrompt: string,
  tools: Record<string, Tool>,
): (input: DynamicContextSnapshotInput) => ContextSnapshot {
  const systemChars = systemPrompt.length;
  const toolsChars = toolDefinitionsLength(tools);
  return ({
    messages,
    inputTokens,
    outputTokens,
    reasoningTokens,
  }: DynamicContextSnapshotInput): ContextSnapshot => {
    const input = Math.max(0, inputTokens ?? 0);
    const output = Math.max(0, outputTokens ?? 0);
    const messageCounts = messageChars(messages);
    const allocated = allocateInputTokens(
      {
        system: systemChars,
        tools: toolsChars,
        ...messageCounts,
      },
      input,
    );

    const assistantTokens = allocated.assistant + output;
    // Provider-reported reasoning is authoritative: visible reasoning text
    // may be a summary, so character ratios can misattribute it. Omit the
    // field entirely when the provider did not report a count, so consumers
    // can distinguish "unknown" from an explicit zero.
    const reasoning = Math.min(
      Math.max(0, reasoningTokens ?? 0),
      assistantTokens,
    );

    return {
      input_tokens: input,
      output_tokens: output,
      used_tokens: input + output,
      system_tokens: allocated.system,
      tools_tokens: allocated.tools,
      tool_use_tokens: allocated.toolUse,
      user_tokens: allocated.user,
      assistant_tokens: assistantTokens,
      ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoning }),
    };
  };
}

/** Estimate category tokens from one request and provider-reported totals. */
export function buildContextSnapshot({
  systemPrompt,
  tools,
  messages,
  inputTokens,
  outputTokens,
  reasoningTokens,
}: ContextSnapshotInput): ContextSnapshot {
  return createContextSnapshotBuilder(systemPrompt, tools)({
    messages,
    inputTokens,
    outputTokens,
    reasoningTokens,
  });
}
