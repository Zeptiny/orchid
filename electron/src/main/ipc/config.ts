/**
 * Config IPC handlers — config:get, config:save.
 *
 * Wraps ConfigManager with zod-validated payloads.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
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
import { isPlainObject, mergeConfigUpdates } from '../config/merge';
import { configSchema } from '../config/schema';
import {
  listPersonalityNames,
  loadPersonalities,
} from '../personality/registry';
import { canonicalizeProjectDirectory } from '../project/path';
import { clearProjectRuntimeRegistry } from '../project/runtime';
import { invalidateAllProjectMCPManagers } from '../mcp/project-registry';
import {
  configSaveSchema,
  configSaveProjectSchema,
  configReadProjectSchema,
} from './payload-schemas';
import { resolveWindowWorkspace } from './session';

// ── Config save lock ────────────────────────────────────────────────────────

/**
 * Promise chain that serializes config:save operations.
 *
 * Without this, concurrent IPC calls each read the same `getConfig()` snapshot,
 * merge different updates, and the last writer overwrites earlier providers/
 * settings — a classic read-modify-write race (P1-3).
 *
 * The chain ensures each save reads → merges → writes atomically before the
 * next save begins. Errors from prior operations do not block subsequent ones.
 */
let configSaveChain: Promise<void> = Promise.resolve();

/**
 * Run `fn` exclusively after any prior config save completes.
 * Errors from previous operations do not block subsequent ones.
 *
 * Exported so sticky `default_project_dir` patches share the same lock and
 * cannot race with config:save read-modify-write cycles.
 */
export function withConfigSaveLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = configSaveChain;
  const run = previous.catch(() => undefined).then(fn);
  // Update the chain — swallow both success and error so the chain never blocks
  configSaveChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Reset the config-save chain. For test isolation only.
 * @internal
 */
export function _resetConfigSaveChainForTests(): void {
  configSaveChain = Promise.resolve();
}

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
  'background_command_idle_timeout',
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
  'rag',
  'ignored_dirs',
  'always_expand_tool_groups',
  'theme',
  'personality',
]);

function selectedProjectDir(senderId: number): string | null {
  const workspace = resolveWindowWorkspace(String(senderId));
  return workspace.status === 'valid' ? workspace.cwd : null;
}

function verifyProjectWorkspace(senderId: number, projectDir: string): string {
  const selected = selectedProjectDir(senderId);
  const expected = canonicalizeProjectDirectory(projectDir);
  if (selected == null || expected == null) {
    throw new Error('Cannot access project config without a bound project.');
  }
  if (selected !== expected) {
    throw new Error('Project config target no longer matches the selected workspace.');
  }
  return expected;
}

// ── IPC registration ─────────────────────────────────────────────────────────

function loadJsonSafe(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

export function registerConfigIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => {
    return getConfig();
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_GET_HOME, async () => {
    return loadConfig({ projectDir: HOME_CONFIG_DIR });
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_DIAGNOSTICS, async () => {
    return [];
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
    const verifiedProjectDir = verifyProjectWorkspace(event.sender.id, parsed.data);
    const configPath = path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
    const raw = loadJsonSafe(configPath);
    return { projectDir: verifiedProjectDir, overrides: isPlainObject(raw) ? raw : {} };
  });

  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE_PROJECT, async (event, payload: unknown) => {
    const parsed = configSaveProjectSchema.parse(payload);
    const { projectDir, updates } = parsed;

    const verifiedProjectDir = verifyProjectWorkspace(event.sender.id, projectDir);

    const filteredUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (PROJECT_CONFIG_ALLOWED_KEYS.has(key)) {
        filteredUpdates[key] = value;
      }
    }

    return withConfigSaveLock(async () => {
      const configPath = path.join(verifiedProjectDir, PROJECT_CONFIG_NAME);
      const current = loadJsonSafe(configPath);
      const merged = mergeConfigUpdates(
        isPlainObject(current) ? current : {},
        filteredUpdates,
      );
      const filtered = Object.fromEntries(
        Object.entries(merged).filter(([k]) => PROJECT_CONFIG_ALLOWED_KEYS.has(k) || k === 'rag'),
      );
      const validated = configSchema.safeParse(filtered);
      if (!validated.success) {
        throw new Error(`Invalid project config: ${validated.error.message}`);
      }
      atomicWriteJson(configPath, filtered, { hardenDirectory: false });
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
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_DIAGNOSTICS);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_LIST_PERSONALITIES);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_READ_PROJECT);
  ipcMain.removeHandler(IPC_CHANNELS.CONFIG_SAVE_PROJECT);
}
