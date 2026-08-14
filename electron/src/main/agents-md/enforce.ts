/**
 * Write-path AGENTS.md enforcement (U5).
 *
 * The five file mutators are gated on whether the governing instruction files
 * are already in the session context. Given a tool call, resolve every target
 * path's governing chain (R2), aggregate them across all of an `apply_patch`'s
 * files (R8), drop targets outside the workspace (R9), and exempt any target
 * that is itself an instruction file (R10) — recording those separately so the
 * dispatcher can refresh their tracker entries after the mutation lands. The
 * result carries the configured policy plus the unseen set the dispatcher acts
 * on: `block` short-circuits before the handler; `warn`/`inject` augment the
 * result afterwards. Pure-ish and testable: it reads metadata and computes sets
 * but never mutates the tracker — the dispatcher marks entries seen.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentsMdEnforcePolicy, Config } from '../config/schema';
import { extractPathsFromArgs } from '../permissions/resolver';
import type { AgentsMdContextStore } from '../session/agents-md-context';
import { xmlText } from '../tools/result';
import { resolveToolPath } from '../tools/types';
import { effectiveAgentsMdFilenames } from './config';
import { renderAgentsMdBlock } from './inject';
import { resolveAgentsMdChain, type AgentsMdEntry, type InstructionHit } from './resolver';

/**
 * The five file mutators subject to write enforcement (R6). `execute_command`,
 * MCP tools, and non-file mutators (todo/rag/ast indexers) are deliberately
 * excluded — they are statically ungovernable or not file-content edits (R9).
 */
const ENFORCED_MUTATOR_TOOLS = new Set<string>([
  'edit',
  'write',
  'apply_patch',
  'rename_symbol',
  'replace_symbol',
]);

/** The enforcement verdict for a single mutating tool call. */
export interface AgentsMdEnforcement {
  /** The configured policy the dispatcher should apply. */
  policy: AgentsMdEnforcePolicy;
  /** Governing files not yet in context (R10-exempt, de-duped, order preserved). */
  unseen: AgentsMdEntry[];
  /** Target files that are themselves instruction files (R10 exemption set). */
  editedInstructionFiles: AgentsMdEntry[];
  /**
   * Raw arg paths that are themselves instruction files (basename matches a
   * configured alias). Computed from the ARGS, not the disk, so it includes
   * not-yet-created files. Phase B re-stats each post-write to refresh the
   * tracker with the fresh mtime/size (R10).
   */
  instructionFileTargets: string[];
}

/**
 * Canonicalize a mutation target for identity comparison against chain entries.
 * Mirrors the resolver's canonicalization for existing files; returns null when
 * the target does not exist yet (e.g. a `write` about to create it) — such a
 * target cannot equal any existing chain entry, so it needs no special handling.
 */
function canonicalizeTarget(rawPath: string, cwd: string): string | null {
  try {
    return fs.realpathSync.native(resolveToolPath(cwd, rawPath));
  } catch {
    return null;
  }
}

/**
 * Evaluate write enforcement for a mutating tool call, or null when enforcement
 * does not apply (feature disabled, policy `off`, or a non-mutator tool).
 *
 * Aggregates the governing chains of every target path (R8), so an `apply_patch`
 * touching several trees reports all unseen files at once. Targets outside the
 * workspace resolve to an empty chain and are never enforced (R9). A target that
 * is itself an instruction file is excluded from the unseen set and surfaced in
 * `editedInstructionFiles` instead (R10).
 */
export function evaluateAgentsMdEnforcement(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
  store: AgentsMdContextStore,
): AgentsMdEnforcement | null {
  if (!config.agents_md?.enabled) return null;
  const policy = config.agents_md.enforce_on_write;
  if (policy === 'off') return null;
  if (!ENFORCED_MUTATOR_TOOLS.has(toolName)) return null;

  const rawPaths = extractPathsFromArgs(toolName, args);

  // Case-insensitive instruction-file basenames for R10 detection.
  const instructionFilenames = new Set(
    effectiveAgentsMdFilenames(config).map((name) => name.toLowerCase()),
  );

  // Raw arg paths that are themselves instruction files (R10). Computed from the
  // ARGS (not the disk) so not-yet-created files are included; Phase B re-stats
  // each post-write to refresh the tracker with the fresh mtime/size.
  const instructionFileTargets = rawPaths.filter((rawPath) =>
    instructionFilenames.has(path.basename(rawPath).toLowerCase()),
  );

  // Aggregate governing chains across all targets, de-duped by canonical path.
  // The R10 exemption is scoped PER TARGET: an entry is exempt (routed to
  // `edited`) only when it IS the target currently being processed. The same
  // file governing a co-edited sibling stays in `governing` and is enforced, so
  // bundling a trivial instruction-file edit cannot suppress enforcement of the
  // sibling's governing file. The root tier lives in the static system prompt
  // and is never enforced by this mechanism (R4).
  const governing = new Map<string, AgentsMdEntry>();
  const edited = new Map<string, AgentsMdEntry>();
  const dirCache = new Map<string, InstructionHit | null>();
  for (const rawPath of rawPaths) {
    const canonicalTarget = canonicalizeTarget(rawPath, cwd);
    for (const entry of resolveAgentsMdChain(rawPath, cwd, config, dirCache)) {
      if (canonicalTarget !== null && entry.path === canonicalTarget) {
        edited.set(entry.path, entry);
      } else if (entry.tier !== 'root' && !governing.has(entry.path)) {
        governing.set(entry.path, entry);
      }
    }
  }

  return {
    policy,
    unseen: store.unseen([...governing.values()]),
    editedInstructionFiles: [...edited.values()],
    instructionFileTargets,
  };
}

/** Plain-text terminal-denial message for a `block` policy (R8: names all). */
export function buildAgentsMdBlockMessage(unseen: AgentsMdEntry[]): string {
  const names = unseen.map((entry) => entry.displayPath).join(', ');
  return (
    `Write blocked: the files you are modifying are governed by AGENTS.md ` +
    `instruction file(s) not yet in your context: ${names}. Read the listed ` +
    `file(s) first, then retry the modification.`
  );
}

/** Render the `<agents_md_warning>` block naming unseen governing files. */
export function buildAgentsMdWarningBlock(unseen: AgentsMdEntry[]): string {
  const names = unseen.map((entry) => entry.displayPath).join(', ');
  return (
    `<agents_md_warning>\n` +
    `You modified files governed by instruction file(s) not yet in your ` +
    `context: ${xmlText(names)}. Read them to follow project conventions.\n` +
    `</agents_md_warning>`
  );
}

/**
 * Render `<agents_md>` blocks for the unseen entries under the byte cap, reusing
 * the read-path renderer (R5). The caller marks these seen after appending.
 */
export function buildAgentsMdInjectBlock(
  unseen: AgentsMdEntry[],
  config: Config,
): string {
  const maxBytes = config.agents_md.max_file_bytes;
  return unseen.map((entry) => renderAgentsMdBlock(entry, maxBytes)).join('\n');
}
