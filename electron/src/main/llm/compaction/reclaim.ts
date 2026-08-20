/**
 * Mechanical reclaim pass — deterministic exact-duplicate tool output deduplication.
 *
 * Pure function over the U3 compactable range only (preserve floor and budget
 * extension untouched). Caller supplies the range slice [start,end) that U3
 * selected. We hash each TOOL_RESULT inside that slice by
 * (tool name, normalized args, output hash) and flag earlier duplicates,
 * keeping the newest occurrence. v1 ships this single conservative rule only.
 *
 * A reclaim-only apply (flags, no summary head) rides the U7 atomic
 * persistence path. The trigger engine decides to skip the summarizer when
 * estimated usage drops below the re-arm line; we provide helpers for that.
 */

import { createHash } from 'node:crypto';
import type { Message } from '../../../shared/types/message';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { ToolCall } from '../../../shared/types/tool';
import { estimateMessageChars } from './message-chars';
import type { CompactableRange } from './select';

// ── Public types ────────────────────────────────────────────────────────────

export type { CompactableRange } from './select';

export interface MechanicalReclaimResult {
  /** Message ids within the range that should be flagged excludeFromModel. Sorted ascending by original index. */
  readonly flaggedIds: string[];
  /** The Message objects that correspond to flaggedIds (in range order). */
  readonly reclaimedMessages: Message[];
  /** Group count (distinct hash buckets that had duplicates). Useful for diagnostics. */
  readonly duplicateGroups: number;
}

// ── Hash + normalization helpers ──────────────────────────────────────────

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortJson(obj[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  try {
    return JSON.stringify(sortJson(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Normalize a tool argument JSON string deterministically.
 * - Parses as JSON when possible, then re-serializes with sorted keys.
 * - Falls back to trimmed raw string on parse failure (conservative: only
 *   exact raw equality counts then).
 */
export function normalizeArgs(argsRaw: string): string {
  const trimmed = argsRaw.trim();
  if (trimmed.length === 0) return '';
  try {
    const parsed = JSON.parse(trimmed);
    // Primitive JSON (string/number/boolean/null) normalizes to its JSON form.
    // Objects/arrays get key-sorted stable stringify.
    if (parsed !== null && typeof parsed === 'object') {
      return stableStringify(parsed);
    }
    return JSON.stringify(parsed);
  } catch {
    return trimmed;
  }
}


// ── Core: mechanical reclaim ──────────────────────────────────────────────

/**
 * Pure function: scan only messages[start,end) and flag exact duplicates.
 *
 * Triple = (tool name, normalized args, output hash).
 * - tool name comes from the TOOL_RESULT's `name` or its paired TOOL_CALL entry.
 * - normalized args come from the paired TOOL_CALL's `function.arguments`.
 * - output hash is SHA-256 of `content + '\0' + stable(tool_result)`.
 *
 * Newest occurrence (largest index) is kept; earlier ones are flagged.
 * Messages already hidden/excludeFromModel, non-tool results, or missing ids
 * are ignored. Range is clamped to [0, messages.length].
 */
export function mechanicalReclaim(
  messages: readonly Message[],
  range: CompactableRange,
): MechanicalReclaimResult {
  const total = messages.length;
  const start = Math.max(0, Math.min(range.start, total));
  const end = Math.max(start, Math.min(range.end, total));

  if (start >= end) {
    return { flaggedIds: [], reclaimedMessages: [], duplicateGroups: 0 };
  }

  // Build tool_call_id -> { name, args } map from entire history (so a result
  // can find its call even if the call is outside the compactable slice).
  const callMap = new Map<string, { name: string; args: string | undefined }>();
  for (const msg of messages) {
    if (msg.type === MessageType.TOOL_CALL && msg.tool_calls) {
      for (const tc of msg.tool_calls as readonly ToolCall[]) {
        if (tc.id) {
          callMap.set(tc.id, {
            name: tc.function.name,
            args: tc.function.arguments,
          });
        }
      }
    }
    // Also support the single-tool-call shape via tool_call_id+name on TOOL_CALL messages
    // (some factories put it there as well). If not in tool_calls list, fall back.
    if (
      msg.type === MessageType.TOOL_CALL &&
      msg.tool_call_id &&
      msg.name &&
      !callMap.has(msg.tool_call_id)
    ) {
      // No args available on that path — leave args undefined so dedup is skipped (avoid false merges).
      callMap.set(msg.tool_call_id, { name: msg.name, args: undefined });
    }
  }

  // Group indices by hash inside the range
  const groups = new Map<string, number[]>();

  for (let i = start; i < end; i += 1) {
    const msg = messages[i]!;
    // Only TOOL_RESULT / role tool messages are reclaim candidates
    const isToolResult =
      msg.role === MessageRole.TOOL || msg.type === MessageType.TOOL_RESULT;
    if (!isToolResult) continue;
    if (msg.hidden || msg.excludeFromModel) continue;
    if (!msg.tool_call_id) continue;

    const entry = callMap.get(msg.tool_call_id);
    // Skip dedup when args are unavailable — distinct calls with same output would otherwise share key.
    if (!entry || entry.args === undefined) continue;
    const toolName = msg.name ?? entry?.name ?? '';
    // Without a tool name we cannot meaningfully group (avoid false merges)
    // but still allow empty-name grouping if all empties match exactly.
    const rawArgs = entry.args;
    const normalizedArgs = normalizeArgs(rawArgs);

    // Output basis: content + canonical tool_result payload
    const outputBasis = `${msg.content ?? ''}\u0000${msg.tool_result ? stableStringify(msg.tool_result) : ''}`;
    const outputHash = hashString(outputBasis);

    // Hash the triple. We hash outputBasis already; combine with tool+args via a second hash
    // so the map key never carries unbounded output content.
    const tripleHash = hashString(`${toolName}\u0000${normalizedArgs}\u0000${outputHash}`);

    const bucket = groups.get(tripleHash);
    if (bucket) bucket.push(i);
    else groups.set(tripleHash, [i]);
  }

  const flaggedIndices: number[] = [];
  let duplicateGroups = 0;
  for (const indices of groups.values()) {
    if (indices.length <= 1) continue;
    duplicateGroups += 1;
    // Keep newest (largest index); flag earlier ones
    indices.sort((a, b) => a - b);
    const newest = indices[indices.length - 1]!;
    for (const idx of indices) {
      if (idx !== newest) flaggedIndices.push(idx);
    }
  }

  flaggedIndices.sort((a, b) => a - b);

  const flaggedIds: string[] = [];
  const reclaimedMessages: Message[] = [];
  for (const idx of flaggedIndices) {
    const msg = messages[idx]!;
    flaggedIds.push(msg.id);
    reclaimedMessages.push(msg);
  }

  return { flaggedIds, reclaimedMessages, duplicateGroups };
}

// ── Apply helper (reclaim-only, no summary head) ──────────────────────────

/**
 * Pure flag apply: return a new Message[] where every id in flaggedIds is
 * set to excludeFromModel:true. No summary head is inserted; this rides the
 * U7 atomic persistence path for reclaim-only compactions.
 */
export function applyReclaim(
  messages: readonly Message[],
  flaggedIds: readonly string[],
): Message[] {
  if (flaggedIds.length === 0) return [...messages];
  const flagSet = new Set(flaggedIds);
  return messages.map((msg) =>
    flagSet.has(msg.id) ? { ...msg, excludeFromModel: true } : msg,
  );
}

// ── Usage / re-arm helpers ────────────────────────────────────────────────

/**
 * Proportional estimate of how many input_tokens the flagged messages account for,
 * using char-weight allocation (same spirit as context-snapshot allocateInputTokens
 * but without needing system/tools lengths).
 *
 * Reclaimed estimate = floor(inputTokens * reclaimedChars / totalChars).
 * totalChars is computed over all replayable (non-hidden, non-excluded) messages
 * plus the flagged ones (since before reclaim they are still replayable).
 */
export function estimateReclaimedTokens(
  inputTokens: number,
  messages: readonly Message[],
  flaggedIds: readonly string[],
): number {
  if (flaggedIds.length === 0 || inputTokens <= 0) return 0;
  const flagSet = new Set(flaggedIds);

  // Total chars over messages that currently count toward inputTokens:
  // non-hidden, non-excluded, plus those flagged (they are not yet excluded)
  // hidden/excluded are already out of the replay, so they do not contribute to inputTokens.
  let totalChars = 0;
  let reclaimedChars = 0;
  for (const msg of messages) {
    const isFlagged = flagSet.has(msg.id);
    // If message is flagged it is by definition not yet excluded; count it in total
    if (isFlagged) {
      const c = estimateMessageChars(msg);
      totalChars += c;
      reclaimedChars += c;
      continue;
    }
    if (msg.hidden || msg.excludeFromModel) continue;
    // Skip non-replayable empties that history.ts would drop — they don't affect inputTokens materially
    // but for estimation we still give them minimal weight (they were counted as 1 above)
    // to keep denominator stable. Count everything non-excluded as weight.
    totalChars += estimateMessageChars(msg);
  }

  if (totalChars <= 0) return 0;
  return Math.floor((reclaimedChars / totalChars) * inputTokens);
}

export function estimatePostReclaimInputTokens(
  inputTokens: number,
  messages: readonly Message[],
  flaggedIds: readonly string[],
): number {
  const reclaimed = estimateReclaimedTokens(inputTokens, messages, flaggedIds);
  return Math.max(0, inputTokens - reclaimed);
}

/**
 * Whether the estimated post-reclaim usage falls below the re-arm line.
 * Default hysteresis delta is 0.1 (matches compaction config re-arm).
 */
export function shouldSkipSummarizerAfterReclaim(params: {
  readonly inputTokens: number;
  readonly contextTokens: number;
  readonly threshold: number;
  readonly hysteresisDelta?: number;
  readonly messages: readonly Message[];
  readonly flaggedIds: readonly string[];
}): boolean {
  const { inputTokens, contextTokens, threshold, messages, flaggedIds } = params;
  const delta = params.hysteresisDelta ?? 0.1;
  if (contextTokens <= 0) return false;
  const post = estimatePostReclaimInputTokens(inputTokens, messages, flaggedIds);
  const rearmTokens = (threshold - delta) * contextTokens;
  return post + 1e-9 < rearmTokens;
}

/** Direct ratio helper — no message inspection. Epsilon guards 0.8-0.1 binary error. */
export function isBelowRearmLine(
  inputTokens: number,
  contextTokens: number,
  threshold: number,
  hysteresisDelta = 0.1,
): boolean {
  if (contextTokens <= 0) return false;
  const rearmTokens = (threshold - hysteresisDelta) * contextTokens;
  return inputTokens + 1e-9 < rearmTokens;
}
