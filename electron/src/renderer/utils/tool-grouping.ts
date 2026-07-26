/**
 * Pure helpers for compact activity groups in the chat stream.
 *
 * Only **settled** explore work folds together (scheme B families):
 * - search: grep, glob, rag_search
 * - read:   read, read_directory
 * - fetch:  web_fetch
 * - ast:    find_symbol_references, get_function, get_file_skeleton, plan_symbol_rename
 * - skill:  skill
 *
 * Mutations (edit, write, replace_symbol, rename_symbol, rag_index, exec, …)
 * never enter a group.
 *
 * Title is tool-family only — thoughts appear only when expanded.
 */

/** Groupable explore tools (lowercase). Mutations are intentionally absent. */
export const GROUPABLE_TOOLS = new Set([
  // search
  'grep',
  'glob',
  'rag_search',
  // read
  'read',
  'read_directory',
  // fetch
  'web_fetch',
  // ast (read-only)
  'find_symbol_references',
  'get_function',
  'get_file_skeleton',
  'plan_symbol_rename',
  // skill
  'skill',
  // todo
  'todo_create',
  'todo_update',
  'todo_delete',
  'todo_list',
]);

export type ToolGroupFamily = 'search' | 'read' | 'fetch' | 'ast' | 'skill' | 'todo' | 'other';

export interface ToolGroupMember {
  id: string;
  toolName: string;
  status: string;
}

export interface ToolGroupSummary {
  /** Joined title, e.g. "Searched 2 patterns · Read 1 file · Fetched 1 URL". */
  title: string;
  searchCount: number;
  readCount: number;
  fetchCount: number;
  astCount: number;
  skillCount: number;
  todoCount: number;
  failedCount: number;
  hasActive: boolean;
  /** True when any child tool failed. */
  hasFailed: boolean;
}

export function isGroupableTool(toolName: string): boolean {
  return GROUPABLE_TOOLS.has(toolName.toLowerCase());
}

export function toolFamily(toolName: string): ToolGroupFamily {
  const lower = toolName.toLowerCase();
  if (lower === 'grep' || lower === 'glob' || lower === 'rag_search') {
    return 'search';
  }
  if (lower === 'read' || lower === 'read_directory') {
    return 'read';
  }
  if (lower === 'web_fetch') {
    return 'fetch';
  }
  if (
    lower === 'find_symbol_references' ||
    lower === 'get_function' ||
    lower === 'get_file_skeleton'
    || lower === 'plan_symbol_rename'
  ) {
    return 'ast';
  }
  if (lower === 'skill') {
    return 'skill';
  }
  if (
    lower === 'todo_create' ||
    lower === 'todo_update' ||
    lower === 'todo_delete' ||
    lower === 'todo_list'
  ) {
    return 'todo';
  }
  return 'other';
}

/** Tool still in flight — must stay visible, never enter a group. */
export function isActiveToolStatus(status: string): boolean {
  return (
    status === 'generating' ||
    status === 'running' ||
    status === 'pending'
  );
}

/**
 * Build human summary for tool invocations in a group.
 * Counts are invocation counts (not unique patterns/paths).
 * Groups only contain settled tools, so titles are past-tense.
 *
 * Family order in the title: search · read · fetch · ast.
 */
export function summarizeToolGroup(
  blocks: readonly ToolGroupMember[],
): ToolGroupSummary {
  let searchCount = 0;
  let readCount = 0;
  let fetchCount = 0;
  let astCount = 0;
  let skillCount = 0;
  let todoCount = 0;
  let failedCount = 0;
  let hasActive = false;

  for (const block of blocks) {
    const family = toolFamily(block.toolName);
    if (isActiveToolStatus(block.status)) hasActive = true;
    if (block.status === 'failed' || block.status === 'error') failedCount += 1;

    if (family === 'search') searchCount += 1;
    else if (family === 'read') readCount += 1;
    else if (family === 'fetch') fetchCount += 1;
    else if (family === 'ast') astCount += 1;
    else if (family === 'skill') skillCount += 1;
    else if (family === 'todo') todoCount += 1;
  }

  const parts: string[] = [];

  if (searchCount > 0) {
    parts.push(
      searchCount === 1
        ? 'Searched 1 pattern'
        : `Searched ${searchCount} patterns`,
    );
  }

  if (readCount > 0) {
    parts.push(readCount === 1 ? 'Read 1 file' : `Read ${readCount} files`);
  }

  if (fetchCount > 0) {
    parts.push(fetchCount === 1 ? 'Fetched 1 URL' : `Fetched ${fetchCount} URLs`);
  }

  if (astCount > 0) {
    parts.push(
      astCount === 1 ? 'Inspected 1 symbol' : `Inspected ${astCount} symbols`,
    );
  }

  if (skillCount > 0) {
    parts.push(
      skillCount === 1 ? 'Loaded 1 skill' : `Loaded ${skillCount} skills`,
    );
  }

  if (todoCount > 0) {
    parts.push(
      todoCount === 1 ? 'Updated 1 task' : `Updated ${todoCount} tasks`,
    );
  }

  // Fallback if only "other" somehow landed in a group
  if (parts.length === 0 && blocks.length > 0) {
    parts.push(
      blocks.length === 1 ? '1 tool call' : `${blocks.length} tool calls`,
    );
  }

  if (failedCount > 0) {
    parts.push(failedCount === 1 ? '1 failed' : `${failedCount} failed`);
  }

  return {
    title: parts.join(' · '),
    searchCount,
    readCount,
    fetchCount,
    astCount,
    skillCount,
    todoCount,
    failedCount,
    hasActive,
    hasFailed: failedCount > 0,
  };
}

/**
 * Classification for activity folding.
 *
 * - settled-tool / settled-thought → may enter a finished group
 * - active → always solo (streaming thought, generating/running tool)
 * - break → flush buffer; emit item (mutations, assistant text, …)
 */
export type ActivityClassify =
  | 'settled-tool'
  | 'settled-thought'
  | 'active'
  | 'break';

/**
 * Fold consecutive **settled** thinking + groupable tools into one group.
 *
 * Group when (among settled buffer only):
 * - ≥2 settled groupable tools (with or without thoughts), or
 * - ≥1 settled groupable tool and ≥1 settled thought
 *
 * Active items always flush the buffer first, then pass through solo.
 * Thought-only settled runs stay ungrouped. Single settled tool alone stays solo.
 */
export function foldActivityRuns<T>(
  items: readonly T[],
  options: {
    classify: (item: T) => ActivityClassify;
    /** Build an activity-group stream item from ordered settled sources. */
    makeGroup: (sources: T[]) => T;
  },
): T[] {
  const { classify, makeGroup } = options;
  const out: T[] = [];
  let buf: T[] = [];
  let toolCount = 0;
  let thoughtCount = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const shouldGroup =
      toolCount >= 2 || (toolCount >= 1 && thoughtCount >= 1);
    if (shouldGroup) {
      out.push(makeGroup(buf));
    } else {
      out.push(...buf);
    }
    buf = [];
    toolCount = 0;
    thoughtCount = 0;
  };

  for (const item of items) {
    const kind = classify(item);
    if (kind === 'settled-tool') {
      buf.push(item);
      toolCount += 1;
      continue;
    }
    if (kind === 'settled-thought') {
      buf.push(item);
      thoughtCount += 1;
      continue;
    }
    // Active work or hard break: compact finished run, then show this item solo.
    flush();
    out.push(item);
  }
  flush();
  return out;
}
