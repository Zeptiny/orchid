/**
 * Build live SystemPromptContext for each LLM turn.
 *
 * Agent-scoped isolation (design):
 * - Todos: only tasks owned by this agent scope (main vs subagent id)
 * - Background commands: session + agentScopeId (Python list_visible parity)
 * - Subagents list: only the main agent sees peer/child subagent states;
 *   subagents do not see siblings
 *
 * Directory tree is still per-cwd with a short TTL cache.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '../config/schema';
import type {
  BackgroundCommand,
  SubagentState,
  SystemPromptContext,
  TodoItem,
} from './system-prompt';
import { getSubagentManager } from '../tools';
import { getBackgroundStore } from '../tools/process/background-store';
import {
  filterTodosForScope,
  isMainAgentScope,
  MAIN_AGENT_SCOPE_ID,
  normalizeAgentScopeId,
} from '../../shared/types/agent-scope';

// ── Directory tree cache (Python _TREE_CACHE / _TREE_TTL = 5s) ───────────────

const TREE_TTL_MS = 5_000;
let treeCache: { cwd: string; expiresAt: number; tree: string } | null = null;

const BG_MAX_ENTRIES = 5;
const BG_TAIL_LINES = 8;
const BG_TAIL_CHARS = 500;

/**
 * Build an ASCII directory tree asynchronously (does not block the main process
 * event loop — mirrors Python's executor-based tree walk).
 */
async function buildDirectoryTree(
  dirPath: string,
  maxDepth: number,
  ignoredDirs: Set<string>,
  depth = 0,
  prefix = '',
): Promise<string> {
  if (depth >= maxDepth) return '';

  let entries: string[];
  try {
    entries = (await fs.readdir(dirPath)).sort();
  } catch {
    return '';
  }

  entries = entries.filter((e) => !e.startsWith('.') && !ignoredDirs.has(e));

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const fullPath = path.join(dirPath, entry);
    const isLast = i === entries.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    try {
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) {
        lines.push(`${prefix}${connector}${entry}/`);
        const subtree = await buildDirectoryTree(
          fullPath,
          maxDepth,
          ignoredDirs,
          depth + 1,
          prefix + childPrefix,
        );
        if (subtree) lines.push(subtree);
      } else {
        lines.push(`${prefix}${connector}${entry}`);
      }
    } catch {
      // skip unreadable entries
    }
  }

  return lines.join('\n');
}

async function getDirectoryTree(cwd: string, config: Config): Promise<string> {
  const now = Date.now();
  if (treeCache && treeCache.cwd === cwd && treeCache.expiresAt > now) {
    return treeCache.tree;
  }

  const ignored = new Set(config.ignored_dirs);
  const tree = await buildDirectoryTree(cwd, config.directory_tree_depth, ignored);
  treeCache = { cwd, expiresAt: now + TREE_TTL_MS, tree };
  return tree;
}

/**
 * Subagent states for the prompt.
 * Main sees all running/recent subagents; subagents see none (no peer visibility).
 */
function mapSubagents(
  sessionId: string | null | undefined,
  agentScopeId: string,
): SubagentState[] {
  if (!isMainAgentScope(agentScopeId)) {
    return [];
  }
  try {
    return getSubagentManager().getStates(sessionId).map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      state: String(s.state),
      elapsed: s.elapsed ?? 0,
      task: s.task || undefined,
    }));
  } catch {
    return [];
  }
}

function mapBackgroundCommands(
  sessionId: string | null | undefined,
  agentScopeId: string,
): BackgroundCommand[] {
  try {
    const store = getBackgroundStore();
    const now = Date.now();
    const all = store.list();
    const scope = normalizeAgentScopeId(agentScopeId);
    const visible = all.filter((e) =>
      store.isVisible(e, sessionId ?? null, scope),
    );

    const userEntries = visible.filter((e) => e.owner === 'USER');
    const agentEntries = visible
      .filter((e) => e.owner !== 'USER')
      .slice(-BG_MAX_ENTRIES);
    const selected = [...agentEntries, ...userEntries];

    return selected.map((entry) => {
      const tailRaw = entry.buffer.getTail(BG_TAIL_LINES);
      let tail: string | undefined;
      if (tailRaw) {
        if (tailRaw.length > BG_TAIL_CHARS) {
          tail = '...' + tailRaw.slice(tailRaw.length - BG_TAIL_CHARS);
        } else {
          tail = tailRaw;
        }
      }

      return {
        id: String(entry.id),
        command: entry.command,
        runtime: Math.floor((now - entry.createdAt) / 1000),
        lastOutputAge: Math.floor((now - entry.lastOutputAt) / 1000),
        owner: entry.owner,
        interactive: entry.interactive,
        status: entry.exitCode === null ? 'running' : 'exited',
        exitCode: entry.exitCode ?? undefined,
        tail,
      };
    });
  } catch {
    return [];
  }
}

export interface BuildPromptContextOptions {
  /** Absolute workspace cwd for this turn. */
  cwd: string;
  /** Application config (tree depth, ignored dirs). */
  config: Config;
  /** Active session id for bg-command visibility filtering. */
  sessionId?: string | null;
  /**
   * Agent scope (`main` or subagent id). Defaults to main.
   * Controls todos, bg commands, and subagent list visibility.
   */
  agentScopeId?: string | null;
  /**
   * Todo snapshot provider. Defaults to session manager live store when
   * available; inject in tests.
   */
  getTodos?: () => TodoItem[];
}

/**
 * Build a fully populated SystemPromptContext for streamChat.
 * Async so the directory tree walk does not block the main process.
 */
export async function buildSystemPromptContext(
  options: BuildPromptContextOptions,
): Promise<SystemPromptContext> {
  const { cwd, config, sessionId } = options;
  const agentScopeId = normalizeAgentScopeId(options.agentScopeId);

  const getTodos =
    options.getTodos ??
    (() => {
      try {
        // Lazy require avoids circular init with session/tools.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { createRequire } = require('node:module') as typeof import('node:module');
        const req = createRequire(__filename);
        const session = req('../ipc/session') as typeof import('../ipc/session');
        const manager = session.getSessionManager();
        const store = sessionId
          ? manager.getTodoStore(sessionId)
          : manager.getActiveTodoStore();
        return store.list().map(
          (t): TodoItem => ({
            id: t.id,
            title: t.title,
            status: t.status,
            subagentId: t.subagent_id ?? undefined,
          }),
        );
      } catch {
        return [];
      }
    });

  // Map TodoItem (subagentId) → filter shape (subagent_id) → back
  const allTodos = getTodos();
  const scopedTodos = filterTodosForScope(
    allTodos.map((t) => ({
      ...t,
      subagent_id: t.subagentId ?? null,
    })),
    agentScopeId,
  ).map(
    (t): TodoItem => ({
      id: t.id,
      title: t.title,
      status: t.status,
      description: t.description,
      subagentId: t.subagent_id ?? undefined,
    }),
  );

  return {
    cwd,
    directoryTree: await getDirectoryTree(cwd, config),
    subagents: mapSubagents(sessionId, agentScopeId),
    todos: scopedTodos,
    backgroundCommands: mapBackgroundCommands(sessionId, agentScopeId),
  };
}

/** @internal — tests only */
export function __resetDirectoryTreeCacheForTests(): void {
  treeCache = null;
}

export { MAIN_AGENT_SCOPE_ID };
