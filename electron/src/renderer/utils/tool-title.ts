/**
 * Human-readable titles for tool widgets.
 *
 * Titles deliberately use invocation arguments instead of tool registry
 * names. This keeps the live UI useful while arguments are still streaming,
 * and avoids exposing raw JSON fragments in the title.
 */

import type { CanonicalToolResult } from '../../shared/types/tool-result';

export type ToolTitleStatus = 'generating' | 'running' | 'completed' | 'failed';

export interface SubagentTitleRecord {
  id: string;
  agent_name: string;
  agent_type: string;
}

export interface ToolTitleInput {
  toolName: string;
  status: ToolTitleStatus;
  args: string;
  partialArgs: string;
  toolResult?: CanonicalToolResult | null;
  result?: string | null;
  subagents?: readonly SubagentTitleRecord[];
}

export interface ToolTitleSegment {
  kind: 'text' | 'strong' | 'code';
  value: string;
}

export interface ToolTitle {
  segments: ToolTitleSegment[];
  /** Optional unabridged text for the expanded running detail. */
  expandedRunningSegments?: ToolTitleSegment[];
}

interface ParsedArgs {
  [key: string]: unknown;
}

function text(value: string): ToolTitleSegment {
  return { kind: 'text', value };
}

function strong(value: string): ToolTitleSegment {
  return { kind: 'strong', value };
}

function code(value: string): ToolTitleSegment {
  return { kind: 'code', value };
}

function compose(...segments: ToolTitleSegment[]): ToolTitle {
  return { segments: segments.filter((segment) => segment.value.length > 0) };
}

function plain(value: string): ToolTitle {
  return compose(text(value));
}

function labeled(label: string, subject?: string, subjectSuffix = ''): ToolTitle {
  if (!subject) return compose(strong(label));
  return compose(strong(label), text(' '), code(subject), text(subjectSuffix));
}

function truncate(value: string, max = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function quoted(value: string): string {
  return `“${truncate(value)}”`;
}

function parseJsonObject(raw: string): ParsedArgs | null {
  if (!raw.trim()) return null;

  let current: unknown;
  try {
    current = JSON.parse(raw);
  } catch {
    return null;
  }

  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }

  return current && typeof current === 'object' && !Array.isArray(current)
    ? current as ParsedArgs
    : null;
}

function decodePartialString(value: string): string {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function partialString(raw: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){0,240})`).exec(raw);
  return match?.[1] ? decodePartialString(match[1]) : null;
}

function valueForKey(raw: string, args: ParsedArgs | null, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const key of keys) {
    const value = partialString(raw, key);
    if (value?.trim()) return value.trim();
  }
  return null;
}

function numberForKey(raw: string, args: ParsedArgs | null, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  for (const key of keys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`"${escapedKey}"\\s*:\\s*(-?\\d+)`).exec(raw);
    if (match) return Number(match[1]);
  }
  return null;
}

function stringListForKey(raw: string, args: ParsedArgs | null, key: string): string[] {
  const value = args?.[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  }

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*\\[([^\\]]*)`).exec(raw);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)).map((entry) => decodePartialString(entry[1]));
}

function humanizeToolName(toolName: string): string {
  const parts = toolName.split('::').filter(Boolean);
  const last = (parts[parts.length - 1] || toolName).replace(/[_-]+/g, ' ');
  return parts.length > 1 ? `MCP ${last}` : last;
}

function formatList(values: readonly string[], fallback: string, limit = 3): string {
  const unique = Array.from(new Set(values.filter(Boolean)));
  if (unique.length === 0) return fallback;
  if (unique.length <= limit) return joinList(unique.map(quoted));
  const visibleCount = Math.max(1, limit - 1);
  return `${unique.slice(0, visibleCount).map(quoted).join(', ')}, and ${unique.length - visibleCount} more`;
}

function joinList(values: readonly string[]): string {
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}

function withExpandedRunning(title: ToolTitle, expanded: ToolTitle): ToolTitle {
  return { ...title, expandedRunningSegments: expanded.segments };
}

function subagentLabels(
  ids: readonly string[],
  records: readonly SubagentTitleRecord[] | undefined,
  result: string | null | undefined,
): string[] {
  const byId = new Map((records ?? []).map((record) => [record.id, record.agent_name || record.agent_type]));
  const resolved = ids.map((id) => byId.get(id) || id);
  if (resolved.length > 0) return resolved;

  const fromResult = Array.from(
    (result ?? '').matchAll(/<subagent\b[^>]*\bname="([^"]+)"/g),
  ).map((match) => match[1]);
  return fromResult;
}

function actionForIndex(action: string | null, subject: string): {
  preparing: string;
  running: string;
  completed: string;
  failed: string;
} {
  switch (action) {
    case 'status':
      return {
        preparing: `Preparing to check ${subject}`,
        running: `Checking ${subject}`,
        completed: `Checked ${subject}`,
        failed: `check ${subject}`,
      };
    case 'clear':
      return {
        preparing: `Preparing to clear ${subject}`,
        running: `Clearing ${subject}`,
        completed: `Cleared ${subject}`,
        failed: `clear ${subject}`,
      };
    case 'index':
    default:
      return {
        preparing: `Preparing to index ${subject}`,
        running: `Indexing ${subject}`,
        completed: `Indexed ${subject}`,
        failed: `index ${subject}`,
      };
  }
}

function withLifecycle(
  status: ToolTitleStatus,
  lifecycle: { preparing: string; running: string; completed: string; failed: string },
  subject?: string,
  subjectSuffix = '',
): ToolTitle {
  if (status === 'generating') return labeled(lifecycle.preparing, subject, subjectSuffix);
  if (status === 'running') return labeled(lifecycle.running, subject, subjectSuffix);
  if (status === 'failed') return labeled(`Couldn’t ${lifecycle.failed}`, subject, subjectSuffix);
  return labeled(lifecycle.completed, subject, subjectSuffix);
}

function todoResultTitle(result: CanonicalToolResult | null | undefined): string | null {
  if (!result || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    return null;
  }
  const value = (result.data as { value?: unknown }).value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' && title.length > 0 ? title : null;
}

function readReturnedRange(result: CanonicalToolResult | null | undefined): string | null {
  if (result?.family !== 'file-content' || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    return null;
  }

  const returnedRange = (result.data as { returnedRange?: unknown }).returnedRange;
  if (typeof returnedRange !== 'object' || returnedRange === null || Array.isArray(returnedRange)) return null;

  const range = returnedRange as { start?: unknown; end?: unknown };
  return typeof range.start === 'number' && Number.isInteger(range.start) &&
    typeof range.end === 'number' && Number.isInteger(range.end)
    ? `${range.start}-${range.end}`
    : null;
}

function commandTitle(
  status: ToolTitleStatus,
  description: string | null,
  command: string | null,
): ToolTitle {
  const display = description || (command ? `$ ${command}` : null);
  const commandDetail = command && description && description !== command ? `$ ${command}` : null;

  if (status === 'generating' || status === 'running') {
    const verb = status === 'generating' ? 'Preparing to run' : 'Running';
    if (!display) return compose(strong(`${verb} command`));
    return commandDetail
      ? compose(strong(`${verb} ${display}`), text(' · '), code(commandDetail))
      : labeled(verb, display);
  }

  if (status === 'failed') {
    return labeled('Command failed', display ?? undefined);
  }
  return display ? labeled('Ran', display) : plain('Ran command');
}

export function buildToolTitle(input: ToolTitleInput): ToolTitle {
  const rawArgs = input.status === 'generating'
    ? input.partialArgs
    : input.args || input.partialArgs;
  const args = parseJsonObject(rawArgs);
  const tool = input.toolName.toLowerCase();
  const pathValue = valueForKey(rawArgs, args, ['file_path', 'path', 'directory_path', 'directory']);
  const nameValue = valueForKey(rawArgs, args, ['name']);
  const pattern = valueForKey(rawArgs, args, ['pattern', 'glob']);
  const query = valueForKey(rawArgs, args, ['query']);
  const command = valueForKey(rawArgs, args, ['command', 'cmd']);
  const description = valueForKey(rawArgs, args, ['description']);
  const readRange = readReturnedRange(input.toolResult);

  if (tool === 'execute_command') {
    return commandTitle(input.status, description, command);
  }

  if (tool === 'delegate_to_subagent') {
    const subject = nameValue ? quoted(nameValue) : undefined;
    if (input.status === 'generating') return labeled('Preparing to delegate', subject);
    if (input.status === 'running') return compose(strong('Delegating'), text(' '), code(subject ?? 'subagent'), text(' to subagent'));
    if (input.status === 'failed') return compose(strong('Couldn’t delegate'), text(' '), code(subject ?? 'subagent'));
    return compose(strong('Delegated'), text(' '), code(subject ?? 'subagent'), text(' to subagent'));
  }

  if (tool === 'wait_for_subagent' || tool === 'interrupt_subagents') {
    const ids = stringListForKey(rawArgs, args, 'subagent_ids');
    const names = subagentLabels(ids, input.subagents, input.result);
    const subject = formatList(names, ids.length > 0 ? `${ids.length} subagent${ids.length === 1 ? '' : 's'}` : 'subagents');
    if (tool === 'wait_for_subagent') {
      if (input.status === 'generating') return labeled('Preparing to wait for', subject);
      if (input.status === 'running') {
        const expandedSubject = formatList(
          names,
          ids.length > 0 ? `${ids.length} subagent${ids.length === 1 ? '' : 's'}` : 'subagents',
          Number.POSITIVE_INFINITY,
        );
        return withExpandedRunning(
          labeled('Waiting for', subject),
          labeled('Waiting for', expandedSubject),
        );
      }
      if (input.status === 'failed') {
        return labeled('Couldn’t wait for', subject);
      }
      return labeled('Received results from', subject);
    }
    if (input.status === 'generating') return labeled('Preparing to stop', subject);
    if (input.status === 'running') return labeled('Stopping', subject);
    if (input.status === 'failed') return labeled('Couldn’t stop', subject);
    return labeled('Stopped', subject);
  }

  if (tool === 'read') return withLifecycle(input.status, {
    preparing: 'Preparing to read', running: 'Reading', completed: 'Read', failed: 'read',
  }, pathValue ?? undefined, readRange ? ` lines ${readRange}` : '');
  if (tool === 'write') return withLifecycle(input.status, {
    preparing: 'Preparing to write', running: 'Writing', completed: 'Wrote', failed: 'write',
  }, pathValue ?? undefined);
  if (tool === 'edit') return withLifecycle(input.status, {
    preparing: 'Preparing to edit', running: 'Editing', completed: 'Edited', failed: 'edit',
  }, pathValue ?? undefined);
  if (tool === 'glob') return withLifecycle(input.status, {
    preparing: 'Preparing to find files matching', running: 'Finding files matching', completed: 'Found files matching', failed: 'find files matching',
  }, pattern ?? undefined);
  if (tool === 'grep') return withLifecycle(input.status, {
    preparing: 'Preparing to search for', running: 'Searching for', completed: 'Found matches for', failed: 'search for',
  }, pattern ?? undefined);
  if (tool === 'read_directory') return withLifecycle(input.status, {
    preparing: 'Preparing to list', running: 'Listing', completed: 'Listed', failed: 'list',
  }, pathValue ?? undefined);

  if (tool === 'apply_patch') return withLifecycle(input.status, {
    preparing: 'Preparing to apply patch', running: 'Applying patch', completed: 'Applied patch', failed: 'apply patch',
  });

  if (tool === 'read_output' || tool === 'send_input' || tool === 'terminate_command') {
    const id = numberForKey(rawArgs, args, ['id']);
    const subject = id !== null ? `command #${id}` : 'background command';
    const lifecycle = tool === 'read_output'
      ? { preparing: 'Preparing to read output from', running: 'Reading output from', completed: 'Read output from', failed: 'read output from' }
      : tool === 'send_input'
        ? { preparing: 'Preparing to send input to', running: 'Sending input to', completed: 'Sent input to', failed: 'send input to' }
        : { preparing: 'Preparing to stop', running: 'Stopping', completed: 'Stopped', failed: 'stop' };
    return withLifecycle(input.status, lifecycle, subject);
  }

  if (tool === 'todo_create') return withLifecycle(input.status, {
    preparing: 'Preparing to create task', running: 'Creating task', completed: 'Created task', failed: 'create task',
  }, valueForKey(rawArgs, args, ['title']) ?? undefined);
  if (tool === 'todo_update') return withLifecycle(input.status, {
    preparing: 'Preparing to update task', running: 'Updating task', completed: 'Updated task', failed: 'update task',
  }, valueForKey(rawArgs, args, ['title']) ?? todoResultTitle(input.toolResult) ?? valueForKey(rawArgs, args, ['id']) ?? undefined);
  if (tool === 'todo_delete') return withLifecycle(input.status, {
    preparing: 'Preparing to delete task', running: 'Deleting task', completed: 'Deleted task', failed: 'delete task',
  }, valueForKey(rawArgs, args, ['title']) ?? todoResultTitle(input.toolResult) ?? valueForKey(rawArgs, args, ['id']) ?? undefined);
  if (tool === 'todo_list') return withLifecycle(input.status, {
    preparing: 'Preparing to list tasks', running: 'Listing tasks', completed: 'Listed tasks', failed: 'list tasks',
  });

  if (tool === 'web_fetch') return withLifecycle(input.status, {
    preparing: 'Preparing to fetch', running: 'Fetching', completed: 'Fetched', failed: 'fetch',
  }, valueForKey(rawArgs, args, ['url']) ?? undefined);
  if (tool === 'skill') return withLifecycle(input.status, {
    preparing: 'Preparing to load skill', running: 'Loading skill', completed: 'Loaded skill', failed: 'load skill',
  }, nameValue ?? undefined);
  if (tool === 'rag_search') return withLifecycle(input.status, {
    preparing: 'Preparing to search code for', running: 'Searching code for', completed: 'Searched code for', failed: 'search code for',
  }, query ?? undefined);
  if (tool === 'rag_index') {
    const lifecycle = actionForIndex(valueForKey(rawArgs, args, ['action']), 'semantic index');
    return withLifecycle(input.status, lifecycle);
  }
  if (tool === 'ast_index') {
    const lifecycle = actionForIndex(valueForKey(rawArgs, args, ['action']), 'code structure');
    return withLifecycle(input.status, lifecycle);
  }

  if (tool === 'find_symbol_references') return withLifecycle(input.status, {
    preparing: 'Preparing to find references to', running: 'Finding references to', completed: 'Found references to', failed: 'find references to',
  }, valueForKey(rawArgs, args, ['symbol_name', 'symbol']) ?? undefined);
  if (tool === 'get_file_skeleton') return withLifecycle(input.status, {
    preparing: 'Preparing to inspect', running: 'Inspecting structure of', completed: 'Inspected structure of', failed: 'inspect',
  }, pathValue ?? undefined);
  if (tool === 'get_function') {
    const functionName = valueForKey(rawArgs, args, ['function_name', 'name']);
    const file = valueForKey(rawArgs, args, ['file_path', 'path']);
    const subject = functionName && file ? `${quoted(functionName)} from ${file}` : functionName || file;
    return withLifecycle(input.status, {
      preparing: 'Preparing to read function', running: 'Reading function', completed: 'Read function', failed: 'read function',
    }, subject ?? undefined);
  }
  if (tool === 'rename_symbol') {
    const oldName = valueForKey(rawArgs, args, ['old_name']);
    const newName = valueForKey(rawArgs, args, ['new_name']);
    const subject = oldName && newName ? `${oldName} to ${newName}` : oldName || newName;
    return withLifecycle(input.status, {
      preparing: 'Preparing to rename', running: 'Renaming', completed: 'Renamed', failed: 'rename',
    }, subject ?? undefined);
  }
  if (tool === 'replace_symbol') return withLifecycle(input.status, {
    preparing: 'Preparing to replace', running: 'Replacing', completed: 'Replaced', failed: 'replace',
  }, valueForKey(rawArgs, args, ['symbol_name', 'symbol']) ?? undefined);
  if (tool === 'list_mcp_resources') return withLifecycle(input.status, {
    preparing: 'Preparing to list MCP resources', running: 'Listing MCP resources', completed: 'Listed MCP resources', failed: 'list MCP resources',
  });
  if (tool === 'read_mcp_resource') return withLifecycle(input.status, {
    preparing: 'Preparing to read MCP resource', running: 'Reading MCP resource', completed: 'Read MCP resource', failed: 'read MCP resource',
  }, valueForKey(rawArgs, args, ['uri']) ?? undefined);

  const displayName = humanizeToolName(input.toolName);
  const genericSubject = valueForKey(rawArgs, args, [
    'pattern', 'query', 'path', 'file_path', 'file', 'filename', 'directory_path',
    'directory', 'command', 'cmd', 'url', 'name', 'symbol', 'target', 'expression',
  ]);
  if (input.status === 'generating') return labeled('Preparing', genericSubject ?? displayName);
  if (input.status === 'running') return labeled('Running', genericSubject ?? displayName);
  if (input.status === 'failed') return labeled('Couldn’t run', genericSubject ?? displayName);
  return labeled('Ran', genericSubject ?? displayName);
}

export function toolTitleText(title: ToolTitle): string {
  return title.segments.map((segment) => segment.value).join('');
}

export function toolTitleRunningText(title: ToolTitle): string {
  return title.expandedRunningSegments
    ? title.expandedRunningSegments.map((segment) => segment.value).join('')
    : toolTitleText(title);
}
