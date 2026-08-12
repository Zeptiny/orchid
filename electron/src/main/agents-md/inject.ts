/**
 * Read-path AGENTS.md injection builder (U4).
 *
 * When a single-path read tool touches a path, resolve the governing
 * instruction-file chain for that path and render the byte-capped content of
 * every entry the session has not yet seen (root already seeded → excluded,
 * R4) as an `<agents_md>` XML block. Pure-ish and testable: it reads file
 * content and computes the unseen set but never mutates the tracker — the
 * dispatcher marks entries seen only after the block is appended, so a failed
 * append cannot poison the session state.
 */
import path from 'node:path';
import type { Config } from '../config/schema';
import { escapeXmlAttribute, xmlText } from '../tools/result';
import { resolveToolPath } from '../tools/types';
import type { AgentsMdContextStore } from '../session/agents-md-context';
import {
  readAgentsMdContent,
  resolveAgentsMdChain,
  type AgentsMdEntry,
} from './resolver';

/**
 * Single-path read tools that trigger injection, keyed by tool name. `grep`,
 * `glob`, and `rag_search` are deliberately excluded — they fan out across many
 * trees with no single governing path (soft discovery only). Write/mutation
 * tools are handled by the enforcement unit, not here.
 */
interface InjectableReadTool {
  /** Argument carrying the touched path. */
  argKey: string;
  /**
   * True when the arg is a directory. The resolver walks up from
   * `dirname(target)`, so a directory target must be resolved for a synthetic
   * child or its own instruction file would be missed (see project/agents-md.ts).
   */
  isDirectory: boolean;
}

const AGENTS_MD_INJECTABLE_TOOLS: Record<string, InjectableReadTool> = {
  read: { argKey: 'file_path', isDirectory: false },
  get_file_skeleton: { argKey: 'file_path', isDirectory: false },
  get_function: { argKey: 'file_path', isDirectory: false },
  find_symbol_references: { argKey: 'file_path', isDirectory: false },
  read_directory: { argKey: 'directory_path', isDirectory: true },
};

/** The rendered injection plus the entries the caller should mark seen. */
export interface AgentsMdInjection {
  /** The `<agents_md>...</agents_md>` block(s) to insert, nearest-first. */
  xml: string;
  /** Entries whose content was rendered (caller marks these seen). */
  injected: AgentsMdEntry[];
}

/**
 * Render one entry as an `<agents_md>` block, reading content under the byte
 * cap (R5). Over-cap files carry `truncated="true"` plus a short inline note
 * pointing at `read`. Content and attributes are XML-escaped.
 */
export function renderAgentsMdBlock(entry: AgentsMdEntry, maxBytes: number): string {
  const { content, truncated } = readAgentsMdContent(entry, maxBytes);
  const truncatedAttr = truncated ? ' truncated="true"' : '';
  const note = truncated
    ? `\n[truncated to ${maxBytes} bytes — use read with file_path=${xmlText(entry.displayPath)} for the full file]`
    : '';
  return (
    `<agents_md path="${escapeXmlAttribute(entry.displayPath)}" tier="${escapeXmlAttribute(entry.tier)}"${truncatedAttr}>\n` +
    `${xmlText(content)}${note}\n` +
    `</agents_md>`
  );
}

export interface AgentsMdInjectionOptions {
  /**
   * Overrides the static per-tool `isDirectory` flag for tools whose target
   * kind is only known after execution (e.g. `read` on a directory, detected
   * via its `directory-entries` result family).
   */
  isDirectory?: boolean;
}

/**
 * Build the AGENTS.md injection for a read-tool call, or null when nothing new
 * should be injected.
 *
 * Returns null when the feature or read-injection is disabled, the tool is not
 * an injectable read tool, the path arg is missing/empty/non-string, or every
 * governing entry is already in context (the dedupe guarantee). Otherwise
 * returns the concatenated blocks and the unseen entries that were rendered.
 * Does not touch the tracker — the caller marks `injected` seen after appending.
 */
export function buildAgentsMdInjection(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
  store: AgentsMdContextStore,
  options?: AgentsMdInjectionOptions,
): AgentsMdInjection | null {
  // A missing `agents_md` block (e.g. a partial config) degrades to disabled.
  if (!config.agents_md?.enabled || !config.agents_md?.inject_on_read) return null;

  const spec = AGENTS_MD_INJECTABLE_TOOLS[toolName];
  if (spec === undefined) return null;

  const rawPath = args[spec.argKey];
  if (typeof rawPath !== 'string' || rawPath.trim() === '') return null;

  // Directory targets resolve for a synthetic child so the walk starts at the
  // directory itself rather than its parent (mirrors project/agents-md.ts).
  const resolvedPath = resolveToolPath(cwd, rawPath);
  const isDirectory = options?.isDirectory ?? spec.isDirectory;
  const resolvedTarget = isDirectory
    ? path.join(resolvedPath, 'AGENTS.md')
    : resolvedPath;

  const chain = resolveAgentsMdChain(resolvedTarget, cwd, config);
  // The root tier lives in the static system prompt and is never re-injected by
  // the nested mechanism (R4), even if it changes on disk mid-turn; only nested
  // files re-inject on change (R16).
  const fresh = store.unseen(chain.filter((entry) => entry.tier !== 'root'));
  if (fresh.length === 0) return null;

  const maxBytes = config.agents_md.max_file_bytes;
  return {
    xml: fresh.map((entry) => renderAgentsMdBlock(entry, maxBytes)).join('\n'),
    injected: fresh,
  };
}
