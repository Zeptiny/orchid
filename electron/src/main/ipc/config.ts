/**
 * Config IPC handlers — config:get, config:save.
 *
 * Wraps ConfigManager with zod-validated payloads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import type { ZodError, ZodIssue } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import {
  getConfig,
  loadConfig,
  ConfigManager,
  atomicWriteJson,
  HOME_CONFIG_DIR,
  HOME_CONFIG_PATH,
  PROJECT_CONFIG_NAME,
} from '../config/loader';
import { isPlainObject, isUnsafeKey, mergeConfigUpdates } from '../config/merge';
import { configSchema } from '../config/schema';
import { withConfigSaveLock } from '../config/write-lock';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import { invalidateAllProjectMCPManagers } from '../mcp/project-registry';
import {
  configSaveSchema,
  configSaveProjectSchema,
  configReadProjectSchema,
} from './payload-schemas';
import { resolveAuthorizedProjectDir } from './project-target';

/**
 * Config keys a project `.orchid.json` may override. Kept aligned with what
 * the project runtime actually consumes from `ProjectRuntime.config` — keys
 * that are process-global by implementation (`subagents`, worker pool sizing,
 * onboarding state, …) stay out. `theme` is renderer-global and has no
 * per-project consumer, so it is not overridable either.
 */
const PROJECT_CONFIG_ALLOWED_KEYS = new Set([
  'command_timeout',
  'command_max_output_bytes',
  'read_line_limit',
  'grep_max_results',
  'grep_per_file_timeout',
  'directory_tree_depth',
  'ast_max_file_size',
  'tool_output_inline_threshold',
  'web_fetch_timeout',
  'web_fetch_max_body_bytes',
  'web_fetch_user_agent',
  'llm_stream_idle_timeout',
  'llm_stream_retries',
  'llm_retry_backoff_base',
  'llm_retry_max_delay',
  'max_tool_steps',
  'debug_capture_requests',
  'background_command_idle_timeout',
  'session_title_max_wait_seconds',
  'approval_timeout',
  'subagent_wait_timeout',
  'permission_history_size',
  'max_background_processes',
  'bg_prompt_max_entries',
  'bg_prompt_tail_lines',
  'bg_prompt_tail_chars',
  'bg_output_head_bytes',
  'bg_output_tail_bytes',
  'read_output_long_poll_max',
  'mcp_startup_timeout',
  'mcp_per_server_timeout',
  'mcp_result_max_bytes',
  'mcp_servers',
  'agents_md',
  'default_model',
  'tier_models',
  'tier_reasoning_effort',
  'rag',
  'compaction',
  'ignored_dirs',
  'always_expand_tool_groups',
  'personality',
]);

// ── IPC registration ─────────────────────────────────────────────────────────

/** Copy a plain record map, dropping prototype-pollution aliases. */
function copyMapValues<T>(map: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(map)) {
    if (isUnsafeKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function loadJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function issuePathKey(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

function valueAtPath(source: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key as string];
  }
  return current;
}

function unchangedValue(before: unknown, after: unknown): boolean {
  return before === after || JSON.stringify(before) === JSON.stringify(after);
}

/**
 * Validation issues this update introduced: errors at paths the prior file did
 * not already fail, or a changed value at a previously-invalid path.
 */
function introducedIssues(
  mergedError: ZodError,
  priorError: ZodError,
  priorRaw: Record<string, unknown>,
  mergedRaw: Record<string, unknown>,
): ZodIssue[] {
  const priorPaths = new Set(priorError.issues.map((issue) => issuePathKey(issue.path)));
  return mergedError.issues.filter((issue) => {
    if (!priorPaths.has(issuePathKey(issue.path))) return true;
    return !unchangedValue(
      valueAtPath(priorRaw, issue.path),
      valueAtPath(mergedRaw, issue.path),
    );
  });
}

export function registerConfigIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_HOME, async () => {
    return loadConfig({ projectDir: HOME_CONFIG_DIR });
  });

  // config:list_personalities — home personalities only (~/.orchid/personalities).
  // Project personalities are applied at chat time via ProjectRuntime, not this list.
  ipcMain.handle(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES, async () => {
    // Reload so newly-added files appear without restarting the app.
    loadPersonalities();
    return listPersonalityNames();
  });

  // config:save — merge general preference updates into the home config.
  //
  // The entire read → merge → write cycle is serialized via withConfigSaveLock
  // so concurrent saves cannot read a stale snapshot and overwrite each other
  // (P1-3).  Zod validation happens outside the lock since it is pure and cheap.
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, payload: unknown) => {
    // Validate input with zod (pure, no shared state — safe outside the lock)
    const parsed = configSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid config:save payload: ${parsed.error.message}`);
    }

    const { updates } = parsed.data;

    // Serialize the read → merge → write cycle so concurrent saves don't race.
    // getConfig() is called *inside* the lock to avoid reading a stale snapshot
    // before the lock and then writing after another save has already persisted.
    return withConfigSaveLock(async () => {
      // Load current config and deep-merge updates so partial nested objects
      // (rag, tier_models, mcp_servers) preserve sibling fields/aliases
      // instead of replacing the entire nested map (P1-18 / P1-19).
      const current = getConfig();
      const merged = mergeConfigUpdates(
        current as unknown as Record<string, unknown>,
        updates,
      );

      // Validate the merged result
      const validated = configSchema.parse(merged);

      atomicWriteJson(HOME_CONFIG_PATH, validated);

      // Reset the cached config so next load picks up changes
      ConfigManager.reset();
      // Every project runtime inherits home configuration. Clear the immutable
      // snapshots so only already-running turns retain the previous config.
      clearProjectRuntimeRegistry();
      invalidateAllProjectMCPManagers();

      // Keep the process-wide compatibility cache home-only. Project overlays
      // are independently resolved for the session/turn that needs them.
      ConfigManager.load({ projectDir: HOME_CONFIG_DIR });

      return { status: 'saved' as const };
    });
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_READ_PROJECT, async (event, projectDir: unknown) => {
    const parsed = configReadProjectSchema.safeParse(projectDir);
    if (!parsed.success) {
      throw new Error('config:read_project requires a non-empty projectDir string');
    }
    const verifiedProjectDir = resolveAuthorizedProjectDir(event.sender.id, parsed.data);
    const configPath = path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
    const raw = loadJsonSafe(configPath);
    return { projectDir: verifiedProjectDir, overrides: isPlainObject(raw) ? raw : {} };
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE_PROJECT, async (event, payload: unknown) => {
    const parsed = configSaveProjectSchema.parse(payload);
    const { projectDir, updates } = parsed;

    const verifiedProjectDir = resolveAuthorizedProjectDir(event.sender.id, projectDir);

    // Fail loudly instead of silently dropping keys: a caller must learn that
    // a key cannot be configured per project, not believe it was saved.
    const rejectedKeys = Object.keys(updates).filter((key) => !PROJECT_CONFIG_ALLOWED_KEYS.has(key));
    if (rejectedKeys.length > 0) {
      throw new Error(
        `Not configurable per project: ${[...rejectedKeys].sort().join(', ')}. ` +
          'Use the global configuration for these settings.',
      );
    }

    const filteredUpdates: Record<string, unknown> = { ...updates };

    // Project-scope override semantics that differ from the global merge:
    // - `default_model: null` clears the override (inherit home) instead of
    //   masking the home selection with an explicit null.
    // - `tier_models` / `tier_reasoning_effort` are exact-map replacements so
    //   removing one tier's override deletes its key (per-tier merge cannot
    //   express deletion because null is a meaningful "use default" value).
    // A null/non-object tier map would fall back to whole-key merge semantics
    // that are silent no-ops here, so it is rejected with the same fail-loud
    // contract as the allow-list above.
    for (const mapKey of ['tier_models', 'tier_reasoning_effort'] as const) {
      if (mapKey in filteredUpdates && !isPlainObject(filteredUpdates[mapKey])) {
        throw new Error(
          `Not configurable per project: ${mapKey} must be an object map of tier assignments.`,
        );
      }
    }
    const clearDefaultModel = filteredUpdates['default_model'] === null;
    if (clearDefaultModel) delete filteredUpdates['default_model'];
    const tierModelsUpdate = isPlainObject(filteredUpdates['tier_models'])
      ? copyMapValues(filteredUpdates['tier_models'] as Record<string, unknown>)
      : undefined;
    if (tierModelsUpdate) delete filteredUpdates['tier_models'];
    const tierReasoningUpdate = isPlainObject(filteredUpdates['tier_reasoning_effort'])
      ? copyMapValues(filteredUpdates['tier_reasoning_effort'] as Record<string, unknown>)
      : undefined;
    if (tierReasoningUpdate) delete filteredUpdates['tier_reasoning_effort'];

    return withConfigSaveLock(async () => {
      const configPath = path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
      const current = loadJsonSafe(configPath);
      const merged = mergeConfigUpdates(
        isPlainObject(current) ? current : {},
        filteredUpdates,
      );
      if (clearDefaultModel) delete merged['default_model'];
      if (tierModelsUpdate !== undefined) merged['tier_models'] = tierModelsUpdate;
      if (tierReasoningUpdate !== undefined) {
        merged['tier_reasoning_effort'] = tierReasoningUpdate;
      }
      // Write `merged` as-is: every updated key passed the allow-list above,
      // and pre-existing file keys that are managed through other channels
      // (notably project `permissions` via config:savePermissionScope) must
      // survive a project-config save instead of being stripped.
      const validated = configSchema.safeParse(merged);
      if (!validated.success) {
        // A hand-edited project file can already violate the schema under a
        // key that is now allow-listed. Rejecting would block every unrelated
        // save behind that pre-existing damage, so only invalid values this
        // update leaves untouched are preserved with a warning (they are kept
        // as-is either way); violations this save introduces still reject.
        const prior = configSchema.safeParse(
          isPlainObject(current) ? current : {},
        );
        if (prior.success) {
          throw new Error(`Invalid project config: ${validated.error.message}`);
        }
        const introduced = introducedIssues(
          validated.error,
          prior.error,
          isPlainObject(current) ? current : {},
          merged,
        );
        if (introduced.length > 0) {
          const paths = introduced
            .map((issue) => issuePathKey(issue.path) || '<root>')
            .join(', ');
          throw new Error(
            `Invalid project config: this save introduces new violations ` +
              `(${paths}): ${validated.error.message}`,
          );
        }
        console.warn(
          `[config] project config of '${verifiedProjectDir}' was already invalid ` +
            `before this save; writing anyway: ${validated.error.message}`,
        );
      }
      atomicWriteJson(configPath, merged, { hardenDirectory: false });
      ConfigManager.reset();
      clearProjectRuntimeRegistry();
      invalidateAllProjectMCPManagers();
      ConfigManager.load({ projectDir: HOME_CONFIG_DIR });
    });
  });
}

/**
 * Unregister config IPC handlers (for cleanup/testing).
 */
export function unregisterConfigIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_GET_HOME);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_READ_PROJECT);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE_PROJECT);
}
