/**
 * Token usage helpers — sum / empty checks for agent + subagent footers.
 */
import type { Message, Usage } from './types/message';

export const EMPTY_USAGE: Usage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cached_tokens: 0,
};

/** True when any token counter is non-zero. */
export function hasUsage(usage: Usage | null | undefined): boolean {
  if (!usage) return false;
  return (
    usage.prompt_tokens > 0 ||
    usage.completion_tokens > 0 ||
    usage.total_tokens > 0 ||
    usage.cached_tokens > 0
  );
}

/** Add two usage records (null treated as zero). */
export function addUsage(a: Usage | null | undefined, b: Usage | null | undefined): Usage {
  return {
    prompt_tokens: (a?.prompt_tokens ?? 0) + (b?.prompt_tokens ?? 0),
    completion_tokens: (a?.completion_tokens ?? 0) + (b?.completion_tokens ?? 0),
    total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
    cached_tokens: (a?.cached_tokens ?? 0) + (b?.cached_tokens ?? 0),
  };
}

/** Sum usage across many records. Returns null if nothing non-zero. */
export function sumUsages(usages: ReadonlyArray<Usage | null | undefined>): Usage | null {
  let acc = EMPTY_USAGE;
  let any = false;
  for (const u of usages) {
    if (!u) continue;
    if (!hasUsage(u)) continue;
    acc = addUsage(acc, u);
    any = true;
  }
  return any ? acc : null;
}

/** Sum `message.usage` over a message list. */
export function sumMessageUsages(messages: readonly Message[]): Usage | null {
  return sumUsages(messages.map((m) => m.usage));
}

/**
 * Minimal shape needed to aggregate subagent token usage from persisted chains.
 * Compatible with renderer SubagentRecord and raw session payloads.
 */
export interface SubagentUsageSource {
  readonly parentChainIndex?: number | null;
  readonly chain?: { readonly messages?: readonly Message[] } | null;
}

/** Sum usage from one subagent's chain messages. */
export function sumSubagentUsage(subagent: SubagentUsageSource): Usage | null {
  const messages = subagent.chain?.messages;
  if (!messages || messages.length === 0) return null;
  return sumMessageUsages(messages);
}

/** Sum usage across many subagents (optionally filtered). */
export function sumSubagentsUsage(
  subagents: readonly SubagentUsageSource[],
  filter?: (s: SubagentUsageSource) => boolean,
): Usage | null {
  const usages: Array<Usage | null> = [];
  for (const s of subagents) {
    if (filter && !filter(s)) continue;
    usages.push(sumSubagentUsage(s));
  }
  return sumUsages(usages);
}

/**
 * Build a map of parent_chain_index → aggregated subagent usage.
 * Subagents without a parent index are collected under key -1.
 */
export function subUsageByParentChain(
  subagents: readonly SubagentUsageSource[],
): Map<number, Usage> {
  const map = new Map<number, Usage>();
  for (const s of subagents) {
    const usage = sumSubagentUsage(s);
    if (!usage) continue;
    const key =
      typeof s.parentChainIndex === 'number' && Number.isFinite(s.parentChainIndex)
        ? s.parentChainIndex
        : -1;
    map.set(key, addUsage(map.get(key) ?? EMPTY_USAGE, usage));
  }
  return map;
}
