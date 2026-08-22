import type { ModelMessage, Tool } from 'ai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ContextSnapshot } from '../../shared/types/message';
import { compactedMarkerFromUnknown } from '../../shared/types/message';
import type { ReasoningChars } from './reasoning-tokens';

interface ContextSnapshotInput {
  systemPrompt: string;
  tools: Record<string, Tool>;
  messages: readonly ModelMessage[];
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  /** Provider-reported reasoning tokens, already included in `outputTokens`. */
  reasoningTokens?: number | undefined;
  /**
   * Observed output character mix for the step being snapshotted (visible
   * text / reasoning / tool-call input). When present, tool-call generation
   * tokens are bucketed into tool use instead of the assistant bucket —
   * output tokens cover everything the model generated, including the
   * tool-call name + arguments JSON of tool-only steps.
   */
  outputChars?: ReasoningChars | undefined;
}

type DynamicContextSnapshotInput = Pick<
  ContextSnapshotInput,
  'messages' | 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'outputChars'
>;

interface ContextChars {
  system: number;
  tools: number;
  toolUse: number;
  user: number;
  assistant: number;
  summary: number;
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

/**
 * Structural marker validation via the shared parser (compactedMarkerFromUnknown):
 * a malformed `compacted` value (boolean, string, partial object) is NOT a
 * summary head. Must stay identical to the check in compaction/select.ts —
 * both modules validate through the same shared helper.
 */
function hasCompactedMarker(message: Record<string, unknown>): boolean {
  return 'compacted' in message && compactedMarkerFromUnknown(message.compacted) !== undefined;
}

function messageChars(
  messages: readonly (ModelMessage & { compacted?: unknown })[],
): Omit<ContextChars, 'system' | 'tools'> {
  const chars = { toolUse: 0, user: 0, assistant: 0, summary: 0 };

  for (const message of messages) {
    // Summary-head messages (R23) carry the compacted marker and must be
    // bucketed into `summary` instead of `assistant` so the snapshot
    // exposes `summary_tokens` (R19) without inflating assistant counts.
    if (hasCompactedMarker(message as unknown as Record<string, unknown>)) {
      if (typeof message.content === 'string') {
        chars.summary += message.content.length;
      } else if (Array.isArray(message.content)) {
        for (const part of message.content) {
          chars.summary += serializedLength(part);
        }
      } else {
        chars.summary += serializedLength(message.content);
      }
      continue;
    }

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
    return { system: inputTokens, tools: 0, toolUse: 0, user: 0, assistant: 0, summary: 0 };
  }

  const allocated: ContextChars = {
    system: 0,
    tools: 0,
    toolUse: 0,
    user: 0,
    assistant: 0,
    summary: 0,
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

/**
 * Split the provider's output total by the observed output characters.
 * Tool-call generation (name + arguments JSON) is tool use, not an assistant
 * response; without this every tool-only step lands entirely in the assistant
 * bucket, which the renderer labels "Response". Chars absent or zero → no
 * split, preserving the legacy whole-output attribution.
 */
function splitOutputTokens(
  output: number,
  chars: ReasoningChars | undefined,
): { assistant: number; toolUse: number } {
  if (output <= 0 || !chars || chars.tool <= 0) {
    return { assistant: output, toolUse: 0 };
  }
  const totalChars = chars.reasoning + chars.text + chars.tool;
  if (totalChars <= 0) {
    return { assistant: output, toolUse: 0 };
  }
  const toolUse = Math.min(output, Math.round((output * chars.tool) / totalChars));
  return { assistant: output - toolUse, toolUse };
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
    outputChars,
  }: DynamicContextSnapshotInput): ContextSnapshot => {
    const input = Math.max(0, inputTokens ?? 0);
    const output = Math.max(0, outputTokens ?? 0);
    // Allow Message-shaped objects (with `compacted`) to flow through the
    // ModelMessage-typed input without a cast at every call-site.
    const messageCounts = messageChars(
      messages as unknown as (ModelMessage & { compacted?: unknown })[],
    );
    const allocated = allocateInputTokens(
      {
        system: systemChars,
        tools: toolsChars,
        ...messageCounts,
      },
      input,
    );

    const outputSplit = splitOutputTokens(output, outputChars);
    const assistantTokens = allocated.assistant + outputSplit.assistant;
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
      tool_use_tokens: allocated.toolUse + outputSplit.toolUse,
      user_tokens: allocated.user,
      assistant_tokens: assistantTokens,
      summary_tokens: allocated.summary,
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
  outputChars,
}: ContextSnapshotInput): ContextSnapshot {
  return createContextSnapshotBuilder(systemPrompt, tools)({
    messages,
    inputTokens,
    outputTokens,
    reasoningTokens,
    outputChars,
  });
}
