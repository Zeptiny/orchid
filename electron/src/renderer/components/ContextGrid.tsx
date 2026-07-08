/**
 * ContextGrid — 8×8 colored block grid representing context token distribution.
 *
 * Ported from Python's sidebar.py:410-591.
 * Categories:
 *   - free      (#3f7f57 green)  — unused context window capacity
 *   - system    (#4c6f91 blue)   — system prompt + tools JSON overhead
 *   - tools     (#9a5f87 purple) — (reserved, merged with system in renderer)
 *   - tool_use  (#a98232 amber)  — tool_call + tool_result messages
 *   - messages  (#6f5f9a violet) — user + assistant text messages
 *
 * When system prompt and tools JSON sizes aren't available (renderer-side),
 * we estimate them as the residual: prompt_tokens minus what we can account
 * for from message character ratios.
 */
import { useMemo } from 'react';
import type { Message, Usage } from '../../shared/types/message';
import { MessageRole, MessageType } from '../../shared/types/message';

// ── Constants ────────────────────────────────────────────────────────────────

const GRID_ROWS = 8;
const GRID_COLS = 8;
const GRID_TOTAL = GRID_ROWS * GRID_COLS; // 64 blocks

const COLOR_FREE = '#3f7f57';
const COLOR_SYSTEM = '#4c6f91';
const COLOR_TOOLS = '#9a5f87';
const COLOR_TOOL_USE = '#a98232';
const COLOR_MESSAGES = '#6f5f9a';
const COLOR_EMPTY = '#2a2a2e'; // gray for no-data

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContextBreakdown {
  free: number;
  system: number;
  tools: number;
  tool_use: number;
  messages: number;
}

interface ContextGridProps {
  /** Latest usage data (prompt_tokens drives the distribution). */
  usage?: Usage | null;
  /** All messages in the current session. */
  messages?: readonly Message[];
  /** Optional max context window size (from model metadata). */
  maxContext?: number | null;
  /** Pre-computed breakdown (skips recomputation). */
  breakdown?: ContextBreakdown | null;
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ── Computation ──────────────────────────────────────────────────────────────

/**
 * Estimate per-category token counts from message character ratios.
 *
 * Mirrors Python's `_compute_context_tokens()`. Since the renderer doesn't
 * have direct access to the system prompt or tools JSON, we:
 * 1. Compute character counts for tool_use and messages from the messages array.
 * 2. Allocate prompt_tokens to those categories proportionally.
 * 3. Assign the residual to the system/tools bucket (prompt overhead).
 */
export function computeContextBreakdown(
  messages: readonly Message[],
  usage: Usage | null,
  maxContext?: number | null,
): ContextBreakdown | null {
  if (!usage || usage.prompt_tokens <= 0) return null;

  const promptTokens = usage.prompt_tokens;

  // Character counts from messages
  const toolUseChars = messages
    .filter(
      (m) =>
        m.type === MessageType.TOOL_CALL ||
        m.type === MessageType.TOOL_RESULT ||
        m.role === MessageRole.TOOL,
    )
    .reduce((sum, m) => sum + m.content.length, 0);

  const messageChars = messages
    .filter(
      (m) =>
        (m.role === MessageRole.USER || m.role === MessageRole.ASSISTANT) &&
        !m.hidden &&
        m.type === MessageType.TEXT,
    )
    .reduce((sum, m) => sum + m.content.length, 0);

  const totalKnownChars = toolUseChars + messageChars;

  let toolUseTokens: number;
  let messageTokens: number;
  let systemTokens: number;

  if (totalKnownChars > 0) {
    // Allocate proportionally
    toolUseTokens = Math.round((toolUseChars / totalKnownChars) * promptTokens);
    messageTokens = Math.round((messageChars / totalKnownChars) * promptTokens);
    // Residual goes to system/tools overhead
    systemTokens = promptTokens - toolUseTokens - messageTokens;
  } else {
    // No message content — everything is system overhead
    toolUseTokens = 0;
    messageTokens = 0;
    systemTokens = promptTokens;
  }

  // Clamp negatives
  if (systemTokens < 0) {
    // Redistribute: bump the largest of tool_use / messages
    if (toolUseTokens >= messageTokens) {
      toolUseTokens += systemTokens;
    } else {
      messageTokens += systemTokens;
    }
    systemTokens = 0;
  }

  const freeTokens =
    maxContext && maxContext > 0
      ? Math.max(0, maxContext - promptTokens)
      : 0;

  return {
    free: freeTokens,
    system: systemTokens,
    tools: 0, // merged into system in renderer
    tool_use: toolUseTokens,
    messages: messageTokens,
  };
}

// ── Grid rendering ───────────────────────────────────────────────────────────

function buildBlockList(breakdown: ContextBreakdown): string[] {
  const { free, system, tools, tool_use, messages } = breakdown;
  const totalDisplayTokens = free + system + tools + tool_use + messages;
  if (totalDisplayTokens === 0) return Array(GRID_TOTAL).fill(COLOR_EMPTY);

  const tokensPerBlock = totalDisplayTokens / GRID_TOTAL;

  let systemBlocks = Math.round(system / tokensPerBlock);
  let toolsBlocks = Math.round(tools / tokensPerBlock);
  let toolUseBlocks = Math.round(tool_use / tokensPerBlock);
  let msgBlocks = Math.round(messages / tokensPerBlock);
  let freeBlocks = GRID_TOTAL - systemBlocks - toolsBlocks - toolUseBlocks - msgBlocks;

  // Normalize: ensure exactly 64 blocks
  const totalBlocks = systemBlocks + toolsBlocks + toolUseBlocks + msgBlocks + freeBlocks;
  if (totalBlocks !== GRID_TOTAL) {
    const diff = GRID_TOTAL - totalBlocks;
    const largest = Math.max(systemBlocks, toolsBlocks, toolUseBlocks, msgBlocks, freeBlocks);
    if (largest === systemBlocks) systemBlocks += diff;
    else if (largest === toolsBlocks) toolsBlocks += diff;
    else if (largest === toolUseBlocks) toolUseBlocks += diff;
    else if (largest === msgBlocks) msgBlocks += diff;
    else freeBlocks += diff;
  }

  // Build ordered block list (matching Python order)
  const blocks: string[] = [];
  for (let i = 0; i < systemBlocks; i++) blocks.push(COLOR_SYSTEM);
  for (let i = 0; i < toolsBlocks; i++) blocks.push(COLOR_TOOLS);
  for (let i = 0; i < toolUseBlocks; i++) blocks.push(COLOR_TOOL_USE);
  for (let i = 0; i < msgBlocks; i++) blocks.push(COLOR_MESSAGES);
  for (let i = 0; i < freeBlocks; i++) blocks.push(COLOR_FREE);

  // Pad if rounding left us short (shouldn't happen after normalization)
  while (blocks.length < GRID_TOTAL) blocks.push(COLOR_EMPTY);

  return blocks.slice(0, GRID_TOTAL);
}

// ── Legend entry ─────────────────────────────────────────────────────────────

interface LegendEntry {
  color: string;
  label: string;
  tokens: number;
  pct: number | null;
}

function buildLegendEntries(
  breakdown: ContextBreakdown,
  maxContext?: number | null,
): LegendEntry[] {
  const { free, system, tools, tool_use, messages } = breakdown;

  const entries: LegendEntry[] = [];

  if (maxContext && maxContext > 0) {
    entries.push({
      color: COLOR_FREE,
      label: 'Free',
      tokens: free,
      pct: (free / maxContext) * 100,
    });
  }

  entries.push({
    color: COLOR_SYSTEM,
    label: 'System',
    tokens: system,
    pct: maxContext && maxContext > 0 ? (system / maxContext) * 100 : null,
  });

  // Only show "Tools" row if there are separate tool tokens
  if (tools > 0) {
    entries.push({
      color: COLOR_TOOLS,
      label: 'Tools',
      tokens: tools,
      pct: maxContext && maxContext > 0 ? (tools / maxContext) * 100 : null,
    });
  }

  entries.push({
    color: COLOR_TOOL_USE,
    label: 'Tool use',
    tokens: tool_use,
    pct: maxContext && maxContext > 0 ? (tool_use / maxContext) * 100 : null,
  });

  entries.push({
    color: COLOR_MESSAGES,
    label: 'Messages',
    tokens: messages,
    pct: maxContext && maxContext > 0 ? (messages / maxContext) * 100 : null,
  });

  return entries;
}

// ── Component ────────────────────────────────────────────────────────────────

export function ContextGrid({ usage, messages, maxContext, breakdown: propBreakdown }: ContextGridProps) {
  const computedBreakdown = useMemo(
    () => (propBreakdown ? null : computeContextBreakdown(messages ?? [], usage ?? null, maxContext)),
    [messages, usage, maxContext, propBreakdown],
  );

  const breakdown = propBreakdown ?? computedBreakdown;

  const blocks = useMemo(() => (breakdown ? buildBlockList(breakdown) : []), [breakdown]);
  const legendEntries = useMemo(
    () => (breakdown ? buildLegendEntries(breakdown, maxContext) : []),
    [breakdown, maxContext],
  );

  // No data → show gray grid placeholder
  if (!breakdown) {
    return (
      <div className="flex gap-3 items-start">
        {/* Empty grid */}
        <div
          className="grid shrink-0"
          style={{
            gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
            gap: '2px',
            width: '64px',
          }}
        >
          {Array.from({ length: GRID_TOTAL }).map((_, i) => (
            <div
              key={i}
              className="rounded-[1px]"
              style={{
                backgroundColor: COLOR_EMPTY,
                aspectRatio: '1',
              }}
            />
          ))}
        </div>
        {/* Empty legend */}
        <div className="text-[10px] opacity-40 leading-relaxed self-center">
          No usage data
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start">
      {/* 8×8 grid */}
      <div
        className="grid shrink-0"
        style={{
          gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
          gap: '2px',
          width: '64px',
        }}
      >
        {blocks.map((color, i) => (
          <div
            key={i}
            className="rounded-[1px]"
            style={{
              backgroundColor: color,
              aspectRatio: '1',
            }}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="text-[10px] leading-relaxed space-y-0.5 min-w-0">
        {legendEntries.map((entry) => (
          <div key={entry.label} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-[1px] shrink-0"
              style={{ backgroundColor: entry.color }}
            />
            <span className="opacity-70">{entry.label}:</span>
            <span className="font-mono">{formatTokens(entry.tokens)}</span>
            {entry.pct !== null && (
              <span className="opacity-50">({entry.pct.toFixed(1)}%)</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
