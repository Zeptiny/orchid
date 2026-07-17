import type { Config } from '../../shared/types/ipc-boundary';
import type { ConfigPatch, ConfigPatchMap } from '../../shared/types/ipc';
import type { ModelSelection } from '../../shared/types/provider';

/**
 * Apply a ConfigPatch onto a loaded Config for the settings draft boundary.
 * Avoids a broad `as Config` cast: nested maps honor null tombstones, rag deep-merges.
 */
export function applyConfigDraft(base: Config, draft: ConfigPatch): Config {
  const next: Config = { ...base };

  if (draft.default_model !== undefined) next.default_model = draft.default_model;
  if (draft.ignored_dirs !== undefined) next.ignored_dirs = draft.ignored_dirs;
  if (draft.command_timeout !== undefined) next.command_timeout = draft.command_timeout;
  if (draft.read_line_limit !== undefined) next.read_line_limit = draft.read_line_limit;
  if (draft.grep_max_results !== undefined) next.grep_max_results = draft.grep_max_results;
  if (draft.directory_tree_depth !== undefined) {
    next.directory_tree_depth = draft.directory_tree_depth;
  }
  if (draft.theme !== undefined) next.theme = draft.theme;
  if (draft.personality !== undefined) next.personality = draft.personality;
  if (draft.ast_max_file_size !== undefined) next.ast_max_file_size = draft.ast_max_file_size;
  if (draft.mcp_startup_timeout !== undefined) {
    next.mcp_startup_timeout = draft.mcp_startup_timeout;
  }
  if (draft.mcp_per_server_timeout !== undefined) {
    next.mcp_per_server_timeout = draft.mcp_per_server_timeout;
  }
  if (draft.llm_stream_idle_timeout !== undefined) {
    next.llm_stream_idle_timeout = draft.llm_stream_idle_timeout;
  }
  if (draft.llm_stream_retries !== undefined) next.llm_stream_retries = draft.llm_stream_retries;
  if (draft.background_command_idle_timeout !== undefined) {
    next.background_command_idle_timeout = draft.background_command_idle_timeout;
  }
  if (draft.max_tool_steps !== undefined) next.max_tool_steps = draft.max_tool_steps;
  if (draft.default_project_dir !== undefined) {
    next.default_project_dir = draft.default_project_dir;
  }
  if (draft.always_expand_tool_groups !== undefined) {
    next.always_expand_tool_groups = draft.always_expand_tool_groups;
  }
  if (draft.has_completed_onboarding !== undefined) {
    next.has_completed_onboarding = draft.has_completed_onboarding;
  }

  if (draft.rag !== undefined) {
    next.rag = {
      ...base.rag,
      ...draft.rag,
      embedding_api_model:
        draft.rag.embedding_api_model !== undefined
          ? draft.rag.embedding_api_model
          : base.rag.embedding_api_model,
    };
  }

  if (draft.tier_models !== undefined) {
    next.tier_models = applySelectionMap(base.tier_models, draft.tier_models);
  }

  if (draft.mcp_servers !== undefined) {
    next.mcp_servers = applyRecordMap(base.mcp_servers, draft.mcp_servers);
  }

  if (draft.providers !== undefined) {
    next.providers = applyRecordMap(base.providers, draft.providers);
  }

  return next;
}

function applySelectionMap(
  base: Record<string, ModelSelection | null>,
  patch: ConfigPatchMap<ModelSelection | null>,
): Record<string, ModelSelection | null> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      next[key] = null;
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

function applyRecordMap(
  base: Record<string, Record<string, unknown>>,
  patch: ConfigPatchMap<Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const next = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else if (value !== undefined) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Parse a number input for config forms.
 * Accepts valid zero when `min` is 0 (e.g. llm_stream_retries, chunk_overlap).
 */
export function parseConfigNumber(
  value: string,
  min: number,
  options?: { integer?: boolean },
): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (options?.integer) {
    // Reject non-integer tokens (e.g. "12.5") even though parseInt would truncate.
    if (!/^-?\d+$/.test(trimmed)) return null;
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < min) return null;
    return num;
  }
  const num = Number.parseFloat(trimmed);
  if (Number.isNaN(num) || num < min) return null;
  return num;
}
