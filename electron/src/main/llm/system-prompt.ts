/**
 * System prompt builder — static + dynamic prompts for LLM context.
 *
 * Replicates Python:
 * - `build_static_system_prompt` (static_system_prompt.py:6-19)
 * - `build_dynamic_system_prompt` (dynamic_system_prompt.py:25-124)
 *
 * Static: OS info + instructions.
 * Dynamic: time, cwd, directory tree, subagent states, todos, background commands.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/schema';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Context for building the dynamic system prompt.
 * Provided by the orchestrator (U9) or session actor (U10).
 */
export interface SystemPromptContext {
  /** Current working directory. */
  cwd: string;
  /** Directory tree string (pre-computed). */
  directoryTree?: string;
  /** Active subagent states. */
  subagents?: SubagentState[];
  /** Active todo items. */
  todos?: TodoItem[];
  /** Active background commands. */
  backgroundCommands?: BackgroundCommand[];
}

export interface ToolInfo {
  name: string;
  description?: string;
}

export interface SubagentState {
  id: string;
  name: string;
  type: string;
  state: string;
  elapsed: number;
  task?: string;
}

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  status: string;
  subagentId?: string;
}

export interface BackgroundCommand {
  id: string;
  command: string;
  runtime: number;
  lastOutputAge: number;
  owner: string;
  interactive: boolean;
  status: string;
  exitCode?: number;
  tail?: string;
}

// ---------------------------------------------------------------------------
// Static system prompt
// ---------------------------------------------------------------------------

/**
 * Build the static system prompt.
 * Matches Python `build_static_system_prompt` (static_system_prompt.py:6-19).
 *
 * @param instructions - The agent's instruction text
 * @returns Formatted system prompt string
 */
export function buildStaticSystemPrompt(instructions: string): string {
  return `<instructions>
${instructions}
</instructions>

<user_operating_system>${getOsInfo()}</user_operating_system>`;
}

/**
 * Get OS information string.
 * Matches Python `_get_os_info` (static_system_prompt.py:22-44).
 */
function getOsInfo(): string {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === 'win32') {
    const release = os.release();
    return `Windows ${release} (${arch})`;
  }

  if (platform === 'darwin') {
    const release = os.release();
    return `macOS ${release} (${arch})`;
  }

  if (platform === 'linux') {
    const release = os.release();
    return `Linux ${release} (${arch})`;
  }

  return `${platform} ${os.release()} (${arch})`;
}

// ---------------------------------------------------------------------------
// Dynamic system prompt
// ---------------------------------------------------------------------------

/**
 * Build the dynamic system prompt with runtime context.
 * Matches Python `build_dynamic_system_prompt` (dynamic_system_prompt.py:25-124).
 *
 * @param context - Runtime context (cwd, tree, subagents, todos, etc.)
 * @returns Formatted dynamic prompt string
 */
export function buildDynamicSystemPrompt(context: SystemPromptContext): string {
  const now = new Date();
  const timestamp = formatTimestamp(now);

  let content = `<current_time>${timestamp}</current_time>
<working_directory>${escapeXml(context.cwd)}</working_directory>`;

  // Directory tree
  if (context.directoryTree) {
    content += `
<directory_structure>
${escapeXml(context.directoryTree)}
</directory_structure>`;
  }

  // Subagents
  if (context.subagents && context.subagents.length > 0) {
    const parts = context.subagents.map((s) => {
      const attrs = formatSubagentAttrs(s);
      const taskBlock = s.task
        ? `\n  <task>\n  ${escapeXml(s.task)}\n  </task>`
        : '';
      return `  <subagent ${attrs}>${taskBlock}\n  </subagent>`;
    });
    content += `\n<subagents>\n${parts.join('\n')}\n</subagents>`;
  }

  // Todos
  if (context.todos && context.todos.length > 0) {
    const lines = context.todos.map((t) => {
      let line = `  <todo id="${escapeXml(t.id)}" status="${escapeXml(t.status)}">`;
      line += `\n    <title>${escapeXml(t.title)}</title>`;
      if (t.description) {
        line += `\n    <description>${escapeXml(t.description)}</description>`;
      }
      if (t.subagentId) {
        line += `\n    <subagent_id>${escapeXml(t.subagentId)}</subagent_id>`;
      }
      line += '\n  </todo>';
      return line;
    });
    content += `\n<todos>\n${lines.join('\n')}\n</todos>`;
  }

  // Background commands
  if (context.backgroundCommands && context.backgroundCommands.length > 0) {
    const lines = context.backgroundCommands.map((cmd) => {
      const status = cmd.exitCode !== undefined ? 'exited' : 'running';
      let attrs = `id="${escapeXml(cmd.id)}" command="${escapeXmlAttr(cmd.command)}" runtime="${cmd.runtime}" last_output_age="${cmd.lastOutputAge}" owner="${escapeXml(cmd.owner)}" interactive="${cmd.interactive}" status="${status}"`;
      if (cmd.exitCode !== undefined) {
        attrs += ` exit_code="${cmd.exitCode}"`;
      }

      const tail = cmd.tail
        ? `\n    <tail>\n      ${escapeXml(cmd.tail)}\n    </tail>`
        : '';

      return `  <command ${attrs}>${tail}\n  </command>`;
    });
    content += `\n<background_commands>\n${lines.join('\n')}\n</background_commands>`;
  }

  return content;
}

/**
 * Build the complete system prompt (static + dynamic).
 *
 * @param instructions - The agent's instruction text
 * @param context - Runtime context
 * @returns Complete system prompt string
 */
export function buildSystemPrompt(
  instructions: string,
  context: SystemPromptContext,
): string {
  const staticPrompt = buildStaticSystemPrompt(instructions);
  const dynamicPrompt = buildDynamicSystemPrompt(context);
  return `${staticPrompt}\n\n${dynamicPrompt}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function formatSubagentAttrs(s: SubagentState): string {
  return `id="${escapeXml(s.id)}" name="${escapeXml(s.name)}" type="${escapeXml(s.type)}" state="${escapeXml(s.state)}" elapsed="${s.elapsed}"`;
}

/**
 * Escape XML special characters.
 * Matches Python `xml.sax.saxutils.escape`.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape XML attribute value (also escapes quotes).
 */
function escapeXmlAttr(s: string): string {
  return escapeXml(s).replace(/"/g, '&quot;');
}
