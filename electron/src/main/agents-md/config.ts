/**
 * AGENTS.md config defaults and normalization helpers.
 *
 * The defaults mirror the `agents_md` block in the config schema; the resolver
 * derives its effective filename alias list from these settings.
 */
import type { AgentsMdConfig } from '../config/schema';

/** Lowest-precedence alias appended when `include_local` is enabled. */
export const AGENTS_LOCAL_FILENAME = 'AGENTS.local.md';

/** Default `agents_md` settings — must match `agentsMdConfigSchema`. */
export const AGENTS_MD_DEFAULTS: AgentsMdConfig = {
  enabled: true,
  filenames: ['AGENTS.md', 'CLAUDE.md'],
  max_file_bytes: 32768,
  max_chain_depth: 8,
  enforce_on_write: 'warn',
  inject_on_read: true,
  include_local: false,
};

/**
 * Ordered instruction-file alias list for discovery: the configured
 * `filenames`, with `AGENTS.local.md` appended when `include_local` is true.
 * Entries are trimmed, empties dropped, and de-duplicated case-insensitively
 * while preserving first-seen order.
 */
export function effectiveAgentsMdFilenames(config: {
  agents_md: AgentsMdConfig;
}): string[] {
  const { filenames, include_local } = config.agents_md;
  const source = include_local ? [...filenames, AGENTS_LOCAL_FILENAME] : [...filenames];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of source) {
    const name = raw.trim();
    if (name === '') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}
