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
const COLOR_USER = 'var(--context-user)';
const COLOR_ASSISTANT = 'var(--context-assistant)';

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
}

interface TokenBreakdown {
  system: number;
  tools: number;
  toolUse: number;
  user: number;
  assistant: number;
  free: number;
  total: number;
  maxContext: number;
}

interface LegendEntry {
  color: string;
  label: string;
  tokens: number;
  pct: number;
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

function computeBreakdown(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
): TokenBreakdown {
  const mc = maxContext && maxContext > 0 ? maxContext : 0;

  if (usage?.context) {
    const context = usage.context;
    return {
      system: context.system_tokens,
      tools: context.tools_tokens,
      toolUse: context.tool_use_tokens,
      user: context.user_tokens,
      assistant: context.assistant_tokens,
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
      assistant: 0,
      free: mc,
      total: mc,
      maxContext: mc,
    };
  }

  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens ?? 0;

  const toolChars = messages
    .filter((m) => m.type === MessageType.TOOL_CALL || m.type === MessageType.TOOL_RESULT)
    .reduce((sum, m) => sum + m.content.length, 0);
  const userChars = messages
    .filter((m) => m.role === MessageRole.USER && !m.hidden)
    .reduce((sum, m) => sum + m.content.length, 0);
  const assistantChars = messages
    .filter((m) => m.role === MessageRole.ASSISTANT && !m.hidden)
    .reduce((sum, m) => sum + m.content.length, 0);

  const totalChars = toolChars + userChars + assistantChars;
  const toolUseTokens = totalChars > 0 ? Math.round((toolChars / totalChars) * promptTokens) : 0;
  const userTokens = totalChars > 0 ? Math.round((userChars / totalChars) * promptTokens) : 0;
  const assistantTokens = completionTokens;
  const systemTokens = Math.max(0, promptTokens - toolUseTokens - userTokens);
  const freeTokens = mc > 0 ? Math.max(0, mc - promptTokens - assistantTokens) : 0;

  return {
    system: systemTokens,
    tools: 0,
    toolUse: toolUseTokens,
    user: userTokens,
    assistant: assistantTokens,
    free: freeTokens,
    total: mc > 0 ? mc : promptTokens + assistantTokens,
    maxContext: mc,
  };
}

function buildLegend(b: TokenBreakdown): LegendEntry[] {
  const tools = b.tools + b.toolUse;
  const denominator = b.maxContext > 0
    ? Math.max(b.maxContext, b.total - b.free)
    : b.total;
  const pct = (value: number) => denominator > 0 ? Math.round((value / denominator) * 100) : 0;

  return [
    { color: COLOR_SYSTEM, label: 'System', tokens: b.system, pct: pct(b.system) },
    { color: COLOR_TOOLS, label: 'Tools', tokens: tools, pct: pct(tools) },
    { color: COLOR_USER, label: 'User', tokens: b.user, pct: pct(b.user) },
    { color: COLOR_ASSISTANT, label: 'Assistant', tokens: b.assistant, pct: pct(b.assistant) },
    {
      color: COLOR_FREE,
      label: 'Free',
      tokens: b.free,
      pct: b.maxContext > 0 ? pct(b.free) : b.total === 0 ? 100 : 0,
    },
  ];
}

interface ContextStackedBarProps extends ContextGridProps {
  compact?: boolean;
}

/** Render one contiguous bar; category rows deliberately do not duplicate it. */
export function ContextStackedBar({
  usage,
  messages,
  maxContext,
  compact = false,
}: ContextStackedBarProps) {
  const breakdown = useMemo(
    () => computeBreakdown(messages ?? [], usage ?? null, maxContext),
    [messages, usage, maxContext],
  );
  const legend = useMemo(() => buildLegend(breakdown), [breakdown]);
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
            key={entry.label}
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
  /** `inspector` uses compact rows; `panel` uses the footer dropup styling. */
  variant?: 'inspector' | 'panel';
}

/** Category rows only — the stacked bar is rendered once above these rows. */
export function ContextLegend({
  usage,
  messages,
  maxContext,
  variant = 'inspector',
}: ContextLegendProps) {
  const breakdown = useMemo(
    () => computeBreakdown(messages ?? [], usage ?? null, maxContext),
    [messages, usage, maxContext],
  );
  const legend = useMemo(() => buildLegend(breakdown), [breakdown]);

  if (variant === 'panel') {
    return (
      <div className="context-panel-list">
        {legend.map((entry) => (
          <div key={entry.label} className="context-panel-row">
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
        ))}
      </div>
    );
  }

  return (
    <div className="inspector-stack">
      {legend.map((entry) => (
        <div key={entry.label} className="inspector-row">
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
      ))}
    </div>
  );
}

/** Sidebar context block: one stacked bar followed by its category values. */
export function ContextGrid({ usage, messages, maxContext }: ContextGridProps) {
  return (
    <div>
      <ContextStackedBar usage={usage} messages={messages} maxContext={maxContext} />
      <ContextLegend usage={usage} messages={messages} maxContext={maxContext} />
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
    messages: mb.user + mb.assistant,
    percentUsed,
  };
}
