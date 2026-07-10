/**
 * ContextGrid — 8×3 colored block grid + category token rows.
 *
 * Category colors are CSS variables so the grid updates immediately when the
 * active theme changes without requiring a React rerender.
 *
 * Color swatches sit in front of each category row (no separate legend footer).
 * Uses real usage / maxContext only — no placeholder mock token counts.
 */
import { useMemo } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';

const GRID_COLS = 8;
const GRID_ROWS = 3;
const GRID_TOTAL = GRID_COLS * GRID_ROWS;

const COLOR_FREE = 'var(--context-free)';
const COLOR_SYSTEM = 'var(--context-system)';
const COLOR_TOOL = 'var(--context-tool)';
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
  breakdown?: ContextBreakdown | null;
}

interface TokenBreakdown {
  system: number;
  tool: number;
  user: number;
  assistant: number;
  free: number;
  total: number;
  maxContext: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function computeBreakdown(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
): TokenBreakdown {
  const mc = maxContext && maxContext > 0 ? maxContext : 0;

  if (!usage || usage.prompt_tokens <= 0) {
    // Zero state — all free when we know the window, else zeros.
    return {
      system: 0,
      tool: 0,
      user: 0,
      assistant: 0,
      free: mc,
      total: mc,
      maxContext: mc,
    };
  }

  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens ?? 0;

  let toolTokens = 0;
  let userTokens = 0;

  const toolChars = messages
    .filter((m) => m.type === MessageType.TOOL_CALL || m.type === MessageType.TOOL_RESULT)
    .reduce((sum, m) => sum + m.content.length, 0);
  const userChars = messages
    .filter((m) => m.role === MessageRole.USER && !m.hidden)
    .reduce((sum, m) => sum + m.content.length, 0);
  const asstChars = messages
    .filter((m) => m.role === MessageRole.ASSISTANT && !m.hidden)
    .reduce((sum, m) => sum + m.content.length, 0);

  const totalChars = toolChars + userChars + asstChars;
  if (totalChars > 0) {
    toolTokens = Math.round((toolChars / totalChars) * promptTokens);
    userTokens = Math.round((userChars / totalChars) * promptTokens);
  }

  const systemTokens = Math.max(0, promptTokens - toolTokens - userTokens);
  const assistantTokens = completionTokens;
  const freeTokens = mc > 0 ? Math.max(0, mc - promptTokens - assistantTokens) : 0;

  return {
    system: systemTokens,
    tool: toolTokens,
    user: userTokens,
    assistant: assistantTokens,
    free: freeTokens,
    total: mc > 0 ? mc : promptTokens + assistantTokens,
    maxContext: mc,
  };
}

function buildBlockList(b: TokenBreakdown): string[] {
  const { free, system, tool, user, assistant } = b;
  const total = free + system + tool + user + assistant;
  if (total === 0 || (system === 0 && tool === 0 && user === 0 && assistant === 0)) {
    return Array(GRID_TOTAL).fill(COLOR_FREE);
  }

  const perBlock = total / GRID_TOTAL;
  const sBlocks = Math.round(system / perBlock);
  const tBlocks = Math.round(tool / perBlock);
  const uBlocks = Math.round(user / perBlock);
  const aBlocks = Math.round(assistant / perBlock);
  let fBlocks = GRID_TOTAL - sBlocks - tBlocks - uBlocks - aBlocks;

  const totalBlocks = sBlocks + tBlocks + uBlocks + aBlocks + fBlocks;
  if (totalBlocks !== GRID_TOTAL) {
    fBlocks += GRID_TOTAL - totalBlocks;
    if (fBlocks < 0) fBlocks = 0;
  }

  const blocks: string[] = [];
  for (let i = 0; i < sBlocks; i++) blocks.push(COLOR_SYSTEM);
  for (let i = 0; i < tBlocks; i++) blocks.push(COLOR_TOOL);
  for (let i = 0; i < uBlocks; i++) blocks.push(COLOR_USER);
  for (let i = 0; i < aBlocks; i++) blocks.push(COLOR_ASSISTANT);
  for (let i = 0; i < fBlocks; i++) blocks.push(COLOR_FREE);
  while (blocks.length < GRID_TOTAL) blocks.push(COLOR_FREE);
  return blocks.slice(0, GRID_TOTAL);
}

interface LegendEntry {
  color: string;
  label: string;
  tokens: number;
  pct: number;
}

function buildLegend(b: TokenBreakdown): LegendEntry[] {
  const mc = b.maxContext > 0 ? b.maxContext : Math.max(b.total, 1);
  const pct = (v: number) => (b.maxContext > 0 || b.total > 0 ? Math.round((v / mc) * 100) : 0);
  return [
    { color: COLOR_SYSTEM, label: 'System', tokens: b.system, pct: pct(b.system) },
    { color: COLOR_TOOL, label: 'Tools', tokens: b.tool, pct: pct(b.tool) },
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

interface ContextLegendProps extends ContextGridProps {
  /**
   * `inspector` — compact sidebar rows.
   * `panel` — styled dropup rows (footer context viewer).
   */
  variant?: 'inspector' | 'panel';
}

/** Category rows only — used by the context dropup (no table/grid). */
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
            <span
              className="context-panel-bar"
              aria-hidden
            >
              <span
                className="context-panel-bar-fill"
                style={{
                  width: `${Math.min(100, Math.max(0, entry.pct))}%`,
                  backgroundColor: entry.color,
                }}
              />
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
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
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

export function ContextGrid({ usage, messages, maxContext }: ContextGridProps) {
  const breakdown = useMemo(
    () => computeBreakdown(messages ?? [], usage ?? null, maxContext),
    [messages, usage, maxContext],
  );

  const blocks = useMemo(() => buildBlockList(breakdown), [breakdown]);

  return (
    <div>
      <div
        className="grid"
        style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`, gap: '2px', margin: '4px 0 8px' }}
      >
        {blocks.map((color, i) => (
          <div key={i} className="aspect-square rounded-[2px]" style={{ backgroundColor: color }} />
        ))}
      </div>

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
  const promptTokens = usage?.prompt_tokens ?? 0;
  const percentUsed =
    mb.maxContext > 0 ? Math.min(100, Math.round((promptTokens / mb.maxContext) * 100)) : undefined;
  return {
    free: mb.free,
    system: mb.system,
    tools: 0,
    tool_use: mb.tool,
    messages: mb.user + mb.assistant,
    percentUsed,
  };
}
