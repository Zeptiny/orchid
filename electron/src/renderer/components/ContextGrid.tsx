/**
 * Context visualization — a horizontal stacked bar with category rows.
 *
 * The bar uses the latest provider context snapshot when available. During
 * session hydration the model window may still be resolving, so the used
 * categories remain visible and occupy the bar until the free-space segment
 * can be calculated.
 */
import { useMemo } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';
import { contextUsedTokens } from '../../shared/usage';

const COLOR_FREE = 'var(--context-free)';
const COLOR_SYSTEM = 'var(--context-system)';
const COLOR_TOOLS = 'var(--context-tool)';
const COLOR_TOOL_USE = 'color-mix(in srgb, var(--context-tool) 58%, var(--color-base-100))';
const COLOR_USER = 'var(--context-user)';
const COLOR_ASSISTANT = 'var(--context-assistant)';
const COLOR_ASSISTANT_REASONING =
  'color-mix(in srgb, var(--context-assistant) 58%, var(--color-base-100))';

export interface ContextBreakdown {
  free: number;
  system: number;
  tools: number;
  tool_use: number;
  messages: number;
  percentUsed?: number;
}

interface ContextGridProps {
  usage?: Usage | null;
  messages?: readonly Message[];
  maxContext?: number | null;
  streamingThinkingChars?: number;
}

interface TokenBreakdown {
  system: number;
  tools: number;
  toolUse: number;
  user: number;
  assistantResponse: number;
  assistantReasoning: number;
  free: number;
  total: number;
  maxContext: number;
}

interface LegendEntry {
  key: string;
  color: string;
  label: string;
  tokens: number;
  pct: number;
}

interface LegendSection {
  entries: LegendEntry[];
}

export interface ContextCategories {
  toolDefinition: number;
  toolUse: number;
  response: number;
  reasoning: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Return null when the model window is not known yet. */
export function contextPercent(
  usage: Usage | null | undefined,
  maxContext?: number | null,
): number | null {
  if (!maxContext || maxContext <= 0) return null;
  return Math.min(100, Math.round((contextUsedTokens(usage) / maxContext) * 100));
}

interface MessageChars {
  tools: number;
  user: number;
  response: number;
  reasoning: number;
}

function countMessageChars(messages: readonly Message[]): MessageChars {
  const counts: MessageChars = {
    tools: 0,
    user: 0,
    response: 0,
    reasoning: 0,
  };
  for (const message of messages) {
    if (message.type === MessageType.TOOL_CALL || message.type === MessageType.TOOL_RESULT) {
      counts.tools += message.content.length;
    }
    if (message.hidden) continue;
    if (message.role === MessageRole.USER) {
      counts.user += message.content.length;
    }
    if (message.role !== MessageRole.ASSISTANT) continue;
    counts.reasoning += message.type === MessageType.THINKING
      ? message.content.length
      : message.thinking?.length ?? 0;
    if (message.type !== MessageType.THINKING && message.type !== MessageType.TOOL_CALL) {
      counts.response += message.content.length;
    }
  }
  return counts;
}

function splitAssistantTokens(
  tokens: number,
  chars: { response: number; reasoning: number },
): { response: number; reasoning: number } {
  const totalChars = chars.response + chars.reasoning;
  if (tokens <= 0 || totalChars <= 0) {
    return { response: Math.max(0, tokens), reasoning: 0 };
  }

  const reasoning = Math.round((tokens * chars.reasoning) / totalChars);
  return { response: Math.max(0, tokens - reasoning), reasoning };
}

function computeBreakdown(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
  streamingThinkingChars?: number,
): TokenBreakdown {
  const mc = maxContext && maxContext > 0 ? maxContext : 0;

  if (usage?.context) {
    const context = usage.context;
    const chars = countMessageChars(messages);
    if (streamingThinkingChars && streamingThinkingChars > 0) {
      chars.reasoning += streamingThinkingChars;
    }
    const assistant = splitAssistantTokens(
      context.assistant_tokens,
      chars,
    );
    return {
      system: context.system_tokens,
      tools: context.tools_tokens,
      toolUse: context.tool_use_tokens,
      user: context.user_tokens,
      assistantResponse: assistant.response,
      assistantReasoning: assistant.reasoning,
      free: mc > 0 ? Math.max(0, mc - context.used_tokens) : 0,
      total: mc > 0 ? mc : context.used_tokens,
      maxContext: mc,
    };
  }

  if (!usage || usage.prompt_tokens <= 0) {
    return {
      system: 0,
      tools: 0,
      toolUse: 0,
      user: 0,
      assistantResponse: 0,
      assistantReasoning: 0,
      free: mc,
      total: mc,
      maxContext: mc,
    };
  }

  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens ?? 0;

  const chars = countMessageChars(messages);
  if (streamingThinkingChars && streamingThinkingChars > 0) {
    chars.reasoning += streamingThinkingChars;
  }

  const totalChars = chars.tools + chars.user + chars.response + chars.reasoning;
  const toolUseTokens = totalChars > 0 ? Math.round((chars.tools / totalChars) * promptTokens) : 0;
  const userTokens = totalChars > 0 ? Math.round((chars.user / totalChars) * promptTokens) : 0;
  const assistantTokens = splitAssistantTokens(completionTokens, chars);
  const systemTokens = Math.max(0, promptTokens - toolUseTokens - userTokens);
  const freeTokens = mc > 0
    ? Math.max(0, mc - promptTokens - completionTokens)
    : 0;

  return {
    system: systemTokens,
    tools: 0,
    toolUse: toolUseTokens,
    user: userTokens,
    assistantResponse: assistantTokens.response,
    assistantReasoning: assistantTokens.reasoning,
    free: freeTokens,
    total: mc > 0 ? mc : promptTokens + completionTokens,
    maxContext: mc,
  };
}

function buildLegendSections(b: TokenBreakdown): LegendSection[] {
  const denominator = b.maxContext > 0
    ? Math.max(b.maxContext, b.total - b.free)
    : b.total;
  const pct = (value: number) => denominator > 0 ? Math.round((value / denominator) * 100) : 0;
  const entry = (key: string, color: string, label: string, tokens: number): LegendEntry => ({
    key,
    color,
    label,
    tokens,
    pct: pct(tokens),
  });

  return [
    { entries: [entry('system', COLOR_SYSTEM, 'System', b.system)] },
    {
      entries: [
        entry('tool-definition', COLOR_TOOLS, 'Tool (Definition)', b.tools),
        entry('tool-use', COLOR_TOOL_USE, 'Tool use (Output)', b.toolUse),
      ],
    },
    { entries: [entry('user', COLOR_USER, 'User', b.user)] },
    {
      entries: [
        entry('response', COLOR_ASSISTANT, 'Response', b.assistantResponse),
        entry('reasoning', COLOR_ASSISTANT_REASONING, 'Reasoning', b.assistantReasoning),
      ],
    },
    {
      entries: [{
        ...entry('free', COLOR_FREE, 'Free', b.free),
        pct: b.maxContext > 0 ? pct(b.free) : b.total === 0 ? 100 : 0,
      }],
    },
  ];
}

function flattenLegend(sections: readonly LegendSection[]): LegendEntry[] {
  return sections.flatMap((section) => section.entries);
}

interface ContextStackedBarProps extends ContextGridProps {
  breakdown?: TokenBreakdown;
  compact?: boolean;
}

/** Render one contiguous bar; category rows deliberately do not duplicate it. */
export function ContextStackedBar({
  usage,
  messages,
  maxContext,
  streamingThinkingChars,
  breakdown: sharedBreakdown,
  compact = false,
}: ContextStackedBarProps) {
  const breakdown = useMemo(
    () => sharedBreakdown ??
      computeBreakdown(messages ?? [], usage ?? null, maxContext, streamingThinkingChars),
    [sharedBreakdown, messages, usage, maxContext, streamingThinkingChars],
  );
  const legend = useMemo(
    () => flattenLegend(buildLegendSections(breakdown)),
    [breakdown],
  );
  const usedTokens = contextUsedTokens(usage);
  const barTotal = breakdown.maxContext > 0
    ? Math.max(breakdown.maxContext, usedTokens)
    : usedTokens;
  const percent = contextPercent(usage, maxContext);
  const label = percent == null
    ? usedTokens > 0
      ? `${formatTokens(usedTokens)} context tokens used; context window loading`
      : 'Context usage unavailable'
    : `${percent}% of context window used`;

  return (
    <span
      className={`context-stacked-bar${compact ? ' context-stacked-bar-compact' : ''}`}
      role="img"
      aria-label={label}
      title={label}
    >
      {barTotal > 0 && legend.map((entry) => {
        if (entry.tokens <= 0) return null;
        return (
          <span
            key={entry.key}
            className="context-stacked-bar-segment"
            style={{
              width: `${Math.min(100, Math.max(0, (entry.tokens / barTotal) * 100))}%`,
              backgroundColor: entry.color,
            }}
            title={`${entry.label}: ${formatTokens(entry.tokens)} (${entry.pct}%)`}
          />
        );
      })}
    </span>
  );
}

interface ContextLegendProps extends ContextGridProps {
  breakdown?: TokenBreakdown;
  /** `inspector` uses compact rows; `panel` uses the footer dropup styling. */
  variant?: 'inspector' | 'panel';
}

function ContextLegendRow({
  entry,
  variant,
}: {
  entry: LegendEntry;
  variant: 'inspector' | 'panel';
}) {
  if (variant === 'panel') {
    return (
      <div className="context-panel-row">
        <span className="context-panel-row-left">
          <span
            className="context-panel-swatch"
            style={{ backgroundColor: entry.color }}
            aria-hidden
          />
          <span className="context-panel-label">{entry.label}</span>
        </span>
        <span className="context-panel-row-right mono">
          <span className="context-panel-tokens">{formatTokens(entry.tokens)}</span>
          <span className="context-panel-pct">{entry.pct}%</span>
        </span>
      </div>
    );
  }

  return (
    <div className="inspector-row">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-sm"
          style={{ backgroundColor: entry.color }}
          aria-hidden
        />
        <strong className="font-semibold">{entry.label}</strong>
      </span>
      <span className="subtle shrink-0">
        {formatTokens(entry.tokens)} ({entry.pct}%)
      </span>
    </div>
  );
}

/** Category rows only — the stacked bar is rendered once above these rows. */
export function ContextLegend({
  usage,
  messages,
  maxContext,
  streamingThinkingChars,
  breakdown: sharedBreakdown,
  variant = 'inspector',
}: ContextLegendProps) {
  const breakdown = useMemo(
    () => sharedBreakdown ??
      computeBreakdown(messages ?? [], usage ?? null, maxContext, streamingThinkingChars),
    [sharedBreakdown, messages, usage, maxContext, streamingThinkingChars],
  );
  const sections = useMemo(() => buildLegendSections(breakdown), [breakdown]);

  const rootClass = variant === 'panel' ? 'context-panel-list' : 'inspector-stack';
  const entries = sections.flatMap((section) => section.entries);
  return (
    <div className={rootClass}>
      {entries.map((entry) => (
        <ContextLegendRow key={entry.key} entry={entry} variant={variant} />
      ))}
    </div>
  );
}

interface ContextBreakdownViewProps extends ContextGridProps {
  variant?: 'inspector' | 'panel';
}

/** Paired context visualization computed once for its bar and legend. */
export function ContextBreakdownView({
  usage,
  messages,
  maxContext,
  streamingThinkingChars,
  variant = 'inspector',
}: ContextBreakdownViewProps) {
  const breakdown = useMemo(
    () => computeBreakdown(messages ?? [], usage ?? null, maxContext, streamingThinkingChars),
    [messages, usage, maxContext, streamingThinkingChars],
  );
  return (
    <>
      <ContextStackedBar
        usage={usage}
        maxContext={maxContext}
        breakdown={breakdown}
      />
      <ContextLegend
        variant={variant}
        breakdown={breakdown}
      />
    </>
  );
}

/** Sidebar context block: one stacked bar followed by its category values. */
export function ContextGrid({ usage, messages, maxContext, streamingThinkingChars }: ContextGridProps) {
  return (
    <div>
      <ContextBreakdownView
        usage={usage}
        messages={messages}
        maxContext={maxContext}
        streamingThinkingChars={streamingThinkingChars}
      />
    </div>
  );
}

export function computeContextBreakdown(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
): ContextBreakdown | null {
  const mb = computeBreakdown(messages, usage, maxContext);
  const percentUsed = contextPercent(usage, maxContext) ?? undefined;
  if (usage?.context) {
    return {
      free: mb.free,
      system: usage.context.system_tokens,
      tools: usage.context.tools_tokens,
      tool_use: usage.context.tool_use_tokens,
      messages: usage.context.user_tokens + usage.context.assistant_tokens,
      percentUsed,
    };
  }
  return {
    free: mb.free,
    system: mb.system,
    tools: mb.tools,
    tool_use: mb.toolUse,
    messages: mb.user + mb.assistantResponse + mb.assistantReasoning,
    percentUsed,
  };
}

export function computeContextCategories(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
): ContextCategories {
  const breakdown = computeBreakdown(messages, usage, maxContext);
  return {
    toolDefinition: breakdown.tools,
    toolUse: breakdown.toolUse,
    response: breakdown.assistantResponse,
    reasoning: breakdown.assistantReasoning,
  };
}
