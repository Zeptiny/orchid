/**
 * Canonical result validation and agent projection.
 *
 * Every handler returns a typed terminal outcome. Failure is represented by
 * canonical status/error facts and is never inferred from display text.
 */
import type { z } from 'zod';
import {
  agentProjectionSchema,
  canonicalToolResultSchema,
  createCanonicalToolResultSchema,
  emitToolResultFallbackDiagnostic,
  genericToolResultDataSchema,
  jsonValueSchema,
  serializeJsonDeterministically,
  serializeCanonicalResultForCopy,
  toolExecutionResultSchema,
  type AgentProjection,
  type AgentProjector,
  type CanonicalToolResult,
  type ToolExecutionResult,
  type ToolResultFallbackLogger,
  type ToolResultFamily,
  type ToolResultRetrieval,
  type GenericToolResultData,
  type JsonValue,
  type TerminalToolResultStatus,
  type ToolHandlerOutcome,
} from '../../shared/types/tool-result';
import {
  directoryEntriesDataSchema,
  fileChangeDataSchema,
  fileContentDataSchema,
  fileWriteDataSchema,
  searchResultsDataSchema,
} from '../../shared/types/tool-result-filesystem';

export type GenericBuiltInToolOutcome = ToolHandlerOutcome<GenericToolResultData>;

type XmlAttributeValue = string | number | boolean | null | undefined;

/** XML 1.0 illegal C0 controls (excludes TAB/LF/CR). Built from char codes to satisfy no-control-regex. */
const XML_ILLEGAL_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}${String.fromCharCode(12)}${String.fromCharCode(14)}-${String.fromCharCode(31)}]`,
  'g',
);

/** Escape text for an XML element. Strips XML 1.0 illegal control characters. */
export function escapeXmlText(value: unknown): string {
  return String(value ?? '')
    .replace(XML_ILLEGAL_CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape a value for an XML attribute. Strips XML 1.0 illegal control characters. */
export function escapeXmlAttribute(value: unknown): string {
  return String(value ?? '')
    .replace(XML_ILLEGAL_CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderXmlAttributes(attributes: Record<string, XmlAttributeValue>): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ' ' + key + '="' + escapeXmlAttribute(value) + '"')
    .join('');
}

export function renderXmlToolResult(
  toolName: string,
  canonical: CanonicalToolResult,
  body: string,
  attributes: Record<string, XmlAttributeValue> = {},
  statusOverride?: TerminalToolResultStatus,
  includeBodyOnError = false,
): string {
  const status = statusOverride ?? canonical.status;
  const error = canonical.status === 'error'
    ? '<error code="' + escapeXmlAttribute(canonical.error.code) + '">' +
      escapeXmlText(canonical.error.message) + '</error>'
    : '';
  const payload = canonical.status === 'error' && !includeBodyOnError
    ? error
    : [body, error].filter((part) => part.length > 0).join('\n');
  return [
    '<tool_result name="' + escapeXmlAttribute(toolName) + '" status="' + status + '"' +
      renderXmlAttributes(attributes) + '>',
    payload,
    '</tool_result>',
  ].filter((line, index, lines) =>
    line.length > 0 || index === 0 || index === lines.length - 1).join('\n');
}

export function xmlTextElement(name: string, value: string): string {
  return '<' + name + '>' + escapeXmlText(value) + '</' + name + '>';
}

export function renderRetrieval(retrieval: ToolResultRetrieval | undefined): string {
  if (!retrieval) return '';
  switch (retrieval.kind) {
    case 'read':
      return '<retrieve tool="read" path="' + escapeXmlAttribute(retrieval.path) + '"' +
        renderXmlAttributes({ offset: retrieval.offset, limit: retrieval.limit }) + ' />';
    case 'grep':
      return '<retrieve tool="grep" path="' + escapeXmlAttribute(retrieval.path) +
        '" pattern="' + escapeXmlAttribute(retrieval.pattern) + '" />';
    case 'rerun':
      return '<retrieve tool="' + escapeXmlAttribute(retrieval.toolName) +
        '" input="' + escapeXmlAttribute(serializeJsonDeterministically(retrieval.input)) + '" />';
    case 'cache':
      return [
        '<retrieve tool="read" path="' + escapeXmlAttribute(retrieval.path) + '" />',
        ...retrieval.instructions.map((instruction) => xmlTextElement('instruction', instruction)),
      ].join('\n');
  }
  return '';
}

/** Parse the raw object retained by AI SDK after a canonical tool execution. */
export function parseToolExecutionResult(raw: unknown): ToolExecutionResult {
  return toolExecutionResultSchema.parse(raw) as ToolExecutionResult;
}

export function projectionWithCanonicalCompleteness(
  canonical: CanonicalToolResult,
  content: string,
): AgentProjection {
  if (canonical.status === 'partial') {
    return {
      content,
      completeness: 'partial',
      retrieval: canonical.retrieval!,
    };
  }
  return { content, completeness: 'complete' };
}

function isBackgroundCommandFacts(value: JsonValue): value is {
  commandId: number;
  command: string;
  description: string;
  background: true;
  running: true;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, JsonValue>;
  return typeof candidate.commandId === 'number'
    && typeof candidate.command === 'string'
    && typeof candidate.description === 'string'
    && candidate.background === true
    && candidate.running === true;
}

type PayloadRenderer = (record: Record<string, JsonValue>) => string;

function renderExecuteCommandPayload(record: Record<string, JsonValue>): string {
  return [
    typeof record.stdout === 'string' ? xmlTextElement('stdout', record.stdout) : '',
    typeof record.stderr === 'string' ? xmlTextElement('stderr', record.stderr) : '',
    xmlTextElement('exit_code', String(record.exitCode)),
    record.truncated === true ? '<truncated />' : '',
  ].filter((part) => part.length > 0).join('\n');
}

function renderReadOutputPayload(record: Record<string, JsonValue>): string {
  return [
    '<output command_id="' + escapeXmlAttribute(record.commandId) + '">' +
      escapeXmlText(typeof record.output === 'string' ? record.output : '') +
      '</output>',
    typeof record.exitCode === 'number'
      ? xmlTextElement('exit_code', String(record.exitCode))
      : '',
  ].filter((part) => part.length > 0).join('\n');
}

function renderSendInputPayload(record: Record<string, JsonValue>): string {
  return '<input command_id="' + escapeXmlAttribute(record.commandId) + '">' +
    escapeXmlText(typeof record.input === 'string' ? record.input : '') +
    '</input>';
}

function renderTerminateCommandPayload(record: Record<string, JsonValue>): string {
  return [
    '<command id="' + escapeXmlAttribute(record.commandId) + '">' +
      (typeof record.command === 'string' ? xmlTextElement('command', record.command) : '') +
      '</command>',
    typeof record.exitCode === 'number'
      ? xmlTextElement('exit_code', String(record.exitCode))
      : '',
  ].filter((part) => part.length > 0).join('\n');
}

function renderInterruptSubagentsPayload(record: Record<string, JsonValue>): string {
  const renderIds = (name: string) => {
    const ids = Array.isArray(record[name])
      ? (record[name] as JsonValue[]).filter((id): id is string => typeof id === 'string')
      : [];
    return ids.length === 0
      ? '<' + name + ' />'
      : '<' + name + '>' +
        ids.map((id) => '<subagent id="' + escapeXmlAttribute(id) + '" />').join('\n') +
        '</' + name + '>';
  };
  return [renderIds('interrupted'), renderIds('already_finished'), renderIds('not_found')]
    .join('\n');
}

function renderTodoCreatePayload(record: Record<string, JsonValue>): string {
  return '<task id="' + escapeXmlAttribute(record.id) +
    '" status="' + escapeXmlAttribute(record.status) +
    '" owner="' + escapeXmlAttribute(record.owner) + '">' +
    xmlTextElement('title', typeof record.title === 'string' ? record.title : '') +
    '</task>';
}

function renderTodoUpdatePayload(record: Record<string, JsonValue>): string {
  const changes = record.changes && typeof record.changes === 'object' && !Array.isArray(record.changes)
    ? record.changes as Record<string, JsonValue>
    : {};
  return '<changes task_id="' + escapeXmlAttribute(record.taskId) + '">' +
    (typeof changes.title === 'string' ? xmlTextElement('title', changes.title) : '') +
    (typeof changes.status === 'string' ? xmlTextElement('status', changes.status) : '') +
    (typeof changes.owner === 'string' ? xmlTextElement('owner', changes.owner) : '') +
    '</changes>';
}

function renderTodoListPayload(record: Record<string, JsonValue>): string {
  const tasks = Array.isArray(record.tasks)
    ? record.tasks.filter((task): task is Record<string, JsonValue> =>
        task !== null && typeof task === 'object' && !Array.isArray(task))
    : [];
  if (tasks.length === 0) return '<tasks scope="' + escapeXmlAttribute(record.scope) + '" count="0" />';
  return '<tasks scope="' + escapeXmlAttribute(record.scope) + '" count="' + tasks.length + '">\n' +
    tasks.map((task) =>
      '<task id="' + escapeXmlAttribute(task.id) +
      '" status="' + escapeXmlAttribute(task.status) +
      '" owner="' + escapeXmlAttribute(task.owner) + '">' +
      xmlTextElement('title', typeof task.title === 'string' ? task.title : '') +
      '</task>',
    ).join('\n') +
    '\n</tasks>';
}

function renderTodoDeletePayload(record: Record<string, JsonValue>): string {
  return '<deleted task_id="' + escapeXmlAttribute(record.taskId) +
    '" title="' + escapeXmlAttribute(record.title) + '" />';
}

function renderIndexPayload(record: Record<string, JsonValue>): string {
  const attrs = Object.entries(record)
    .filter(([key, entry]) => key !== 'action' && entry !== undefined && entry !== null)
    .map(([key, entry]) => ' ' + key + '="' + escapeXmlAttribute(entry as XmlAttributeValue) + '"')
    .join('');
  return '<index action="' + escapeXmlAttribute(record.action) + '"' + attrs + ' />';
}

function renderRagSearchPayload(record: Record<string, JsonValue>): string {
  const results = Array.isArray(record.results)
    ? record.results.filter((entry): entry is Record<string, JsonValue> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  return '<results query="' + escapeXmlAttribute(record.query) + '" count="' + results.length + '">\n' +
    results.map((entry) =>
      '<result score="' + escapeXmlAttribute(entry.score) +
      '" file="' + escapeXmlAttribute(entry.file) +
      '" start_line="' + escapeXmlAttribute(entry.startLine) +
      '" end_line="' + escapeXmlAttribute(entry.endLine) + '">' +
      xmlTextElement('content', typeof entry.content === 'string' ? entry.content : '') +
      '</result>',
    ).join('\n') +
    '\n</results>';
}

function renderReadMcpResourcePayload(record: Record<string, JsonValue>): string {
  return '<content>' + escapeXmlText(record.content as string) + '</content>';
}

function renderListMcpResourcesPayload(record: Record<string, JsonValue>): string {
  const resources = Array.isArray(record.resources)
    ? record.resources.filter((entry): entry is Record<string, JsonValue> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  if (resources.length === 0) return '<resources />';
  return '<resources count="' + resources.length + '">\n' +
    resources.map((entry) =>
      '<resource uri="' + escapeXmlAttribute(entry.uri) +
      '" server="' + escapeXmlAttribute(entry.server) +
      (typeof entry.name === 'string' ? '" name="' + escapeXmlAttribute(entry.name) : '') +
      (typeof entry.description === 'string'
        ? '" description="' + escapeXmlAttribute(entry.description)
        : '') +
      '" />',
    ).join('\n') +
    '\n</resources>';
}

function renderFindSymbolReferencesPayload(record: Record<string, JsonValue>): string {
  if (typeof record.error === 'string') return '';
  const references = Array.isArray(record.references)
    ? record.references.filter((entry): entry is Record<string, JsonValue> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  if (references.length === 0) {
    return '<references symbol="' + escapeXmlAttribute(record.name) + '" count="0" />';
  }
  return '<references symbol="' + escapeXmlAttribute(record.name) + '" count="' + references.length + '">\n' +
    references.map((ref) =>
      '<reference kind="' + escapeXmlAttribute(ref.kind) +
      '" file="' + escapeXmlAttribute(ref.file) +
      '" start_line="' + escapeXmlAttribute(ref.startLine) +
      '" end_line="' + escapeXmlAttribute(ref.endLine) + '" />',
    ).join('\n') +
    '\n</references>';
}

function renderRenameSymbolPayload(record: Record<string, JsonValue>): string {
  if (typeof record.error === 'string') return '';
  const edits = Array.isArray(record.edits)
    ? record.edits.filter((entry): entry is Record<string, JsonValue> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  return '<rename_result old_name="' + escapeXmlAttribute(record.oldName) +
    '" new_name="' + escapeXmlAttribute(record.newName) +
    '" files="' + escapeXmlAttribute(record.files) +
    '" success="' + escapeXmlAttribute(record.success) + '">\n' +
    edits.map((edit) =>
      '<file path="' + escapeXmlAttribute(edit.path) +
      '" replacements="' + escapeXmlAttribute(edit.replacements) + '" />',
    ).join('\n') +
    '\n</rename_result>';
}

function renderGetFileSkeletonPayload(record: Record<string, JsonValue>): string {
  if (typeof record.error === 'string') return '';
  const definitions = Array.isArray(record.definitions)
    ? record.definitions.filter((entry): entry is Record<string, JsonValue> =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  if (definitions.length === 0) {
    return '<definitions file="' + escapeXmlAttribute(record.file) +
      '" count="0" format="line | name | line_count" />';
  }
  return '<definitions file="' + escapeXmlAttribute(record.file) +
    '" count="' + definitions.length +
    '" format="line | name | line_count">\n' +
    definitions.map((def) =>
      escapeXmlText(String(def.line) + ' | ' + String(def.name) + ' | ' + String(def.lineCount)),
    ).join('\n') +
    '\n</definitions>';
}

function renderWebFetchPayload(record: Record<string, JsonValue>): string {
  if (typeof record.error === 'string') return '';
  const attrs =
    'url="' + escapeXmlAttribute(record.url) + '"' +
    (typeof record.title === 'string' && record.title
      ? ' title="' + escapeXmlAttribute(record.title) + '"'
      : '') +
    ' content_type="' + escapeXmlAttribute(record.contentType) + '"' +
    ' length="' + escapeXmlAttribute(record.length) + '"' +
    (typeof record.cachePath === 'string'
      ? ' file="' + escapeXmlAttribute(record.cachePath) + '"'
      : '');
  const body = typeof record.warning === 'string'
    ? xmlTextElement('warning', record.warning)
    : xmlTextElement('content', typeof record.content === 'string' ? record.content : '');
  return '<page ' + attrs + '>\n' + body + '\n</page>';
}

function renderDelegateToSubagentPayload(record: Record<string, JsonValue>): string {
  if (typeof record.error === 'string') return '';
  // The task is intentionally omitted: it already lives in the delegate
  // tool-call args (message history) and is re-injected every turn via the
  // dynamic system prompt's <subagents> section. Re-sending it here would
  // duplicate it on every delegation.
  return '<subagent id="' + escapeXmlAttribute(record.id) +
    '" name="' + escapeXmlAttribute(record.name) +
    '" type="' + escapeXmlAttribute(record.type) +
    '" status="' + escapeXmlAttribute(record.status) +
    '" tier="' + escapeXmlAttribute(record.tier) + '"' +
    (typeof record.queue_position === 'number'
      ? ' queue_position="' + escapeXmlAttribute(String(record.queue_position)) + '"'
      : '') +
    ' />';
}

function renderReplaceSymbolPayload(record: Record<string, JsonValue>): string {
  const attrs = [
    'path="' + escapeXmlAttribute(record.file) + '"',
    'success="' + escapeXmlAttribute(record.success ?? true) + '"',
    'replacements="' + escapeXmlAttribute(record.replacements ?? 0) + '"',
    'replace_all="false"',
    'added="0"',
    'removed="0"',
  ];
  if (typeof record.error === 'string') {
    attrs.push('error="' + escapeXmlAttribute(record.error) + '"');
  }
  const parts: string[] = [];
  if (typeof record.message === 'string') {
    parts.push(xmlTextElement('message', record.message));
  }
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const entry = item as Record<string, JsonValue>;
        const itemAttrs: string[] = [];
        if (typeof entry.file === 'string') itemAttrs.push('file="' + escapeXmlAttribute(entry.file) + '"');
        if (typeof entry.symbol === 'string') itemAttrs.push('symbol="' + escapeXmlAttribute(entry.symbol) + '"');
        if (typeof entry.status === 'string') itemAttrs.push('status="' + escapeXmlAttribute(entry.status) + '"');
        if (typeof entry.line === 'number') itemAttrs.push('line="' + entry.line + '"');
        if (typeof entry.error === 'string') {
          parts.push('<item ' + itemAttrs.join(' ') + '>' + xmlTextElement('error', entry.error) + '</item>');
        } else if (itemAttrs.length > 0) {
          parts.push('<item ' + itemAttrs.join(' ') + ' />');
        }
      }
    }
  }
  if (parts.length === 0) {
    return '<edit_result ' + attrs.join(' ') + ' />';
  }
  return '<edit_result ' + attrs.join(' ') + '>\n' + parts.join('\n') + '\n</edit_result>';
}

export const payloadRenderers: ReadonlyMap<string, PayloadRenderer> = new Map([
  ['execute_command', renderExecuteCommandPayload],
  ['read_output', renderReadOutputPayload],
  ['send_input', renderSendInputPayload],
  ['terminate_command', renderTerminateCommandPayload],
  ['interrupt_subagents', renderInterruptSubagentsPayload],
  ['todo_create', renderTodoCreatePayload],
  ['todo_update', renderTodoUpdatePayload],
  ['todo_list', renderTodoListPayload],
  ['todo_delete', renderTodoDeletePayload],
  ['ast_index', renderIndexPayload],
  ['rag_index', renderIndexPayload],
  ['rag_search', renderRagSearchPayload],
  ['read_mcp_resource', renderReadMcpResourcePayload],
  ['list_mcp_resources', renderListMcpResourcesPayload],
  ['find_symbol_references', renderFindSymbolReferencesPayload],
  ['rename_symbol', renderRenameSymbolPayload],
  ['get_file_skeleton', renderGetFileSkeletonPayload],
  ['web_fetch', renderWebFetchPayload],
  ['delegate_to_subagent', renderDelegateToSubagentPayload],
  ['replace_symbol', renderReplaceSymbolPayload],
]);

function renderGenericPayload(
  value: JsonValue,
  originKind: 'built-in' | 'dynamic' | 'mcp' | undefined,
  toolName: string,
): string {
  if (typeof value === 'string') {
    if (
      originKind === 'built-in' &&
      value.startsWith('<') &&
      !value.startsWith('<tool_result')
    ) {
      return value;
    }
    return xmlTextElement('data', value);
  }
  if (isBackgroundCommandFacts(value)) {
    return '<command id="' + escapeXmlAttribute(value.commandId) + '" background="true" running="true">' +
      xmlTextElement('command_text', value.command) +
      xmlTextElement('description', value.description) +
      '</command>';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    const renderer = payloadRenderers.get(toolName);
    if (renderer) {
      return renderer(record);
    }
  }
  return xmlTextElement('data', serializeJsonDeterministically(value));
}

/** XML agent projection used by generic built-ins and dynamic/MCP tools. */
export const genericAgentProjector: AgentProjector = (canonical, toolName) => {
  const generic = genericToolResultDataSchema.safeParse(canonical.data);
  const origin = generic.success ? generic.data.origin : undefined;
  const resolvedName = toolName ?? origin?.name ?? 'unknown';
  const value = generic.success
    ? generic.data.value
    : serializeCanonicalResultForCopy(canonical);
  const resourceUri = resolvedName === 'read_mcp_resource' &&
    value !== null && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.uri === 'string'
    ? value.uri
    : undefined;
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(
      resolvedName,
      canonical,
      renderGenericPayload(value, origin?.kind, resolvedName),
      {
        ...(origin && origin.kind !== 'built-in' ? { origin: origin.kind } : {}),
        ...(resourceUri !== undefined ? { uri: resourceUri } : {}),
      },
      undefined,
      true,
    ),
  );
};

/** Build a typed generic-family outcome for a code-owned built-in tool. */
export function genericBuiltInToolOutcome(
  toolName: string,
  value: JsonValue,
  status: TerminalToolResultStatus = 'complete',
  errorCode = 'tool_error',
  errorMessage?: string,
): ToolHandlerOutcome<GenericToolResultData> {
  const data: GenericToolResultData = {
    value,
    origin: { kind: 'built-in', name: toolName },
  };
  if (status === 'error') {
    return {
      status,
      data,
      error: {
        code: errorCode,
        message: errorMessage ?? (typeof value === 'string' ? value : 'Tool execution failed.'),
      },
    };
  }
  if (status === 'partial') {
    throw new TypeError('Generic partial outcomes require explicit retrieval guidance.');
  }
  return { status, data };
}

const fileChangeAgentProjector: AgentProjector = (canonical, toolName = 'edit') => {
  const parsed = fileChangeDataSchema.parse(canonical.data);
  const fallbackReplacements = canonical.status === 'error'
    || canonical.status === 'cancelled'
    || canonical.status === 'empty'
    ? 0
    : Math.max(parsed.hunks.length, 1);
  const replacements = parsed.replacementCount ?? fallbackReplacements;
  const summary = `${parsed.path}: ${replacements} replacement${replacements === 1 ? '' : 's'}`;
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(toolName, canonical, summary, {
      path: parsed.path,
      replacements,
      ...(parsed.replaceAll ? { replace_all: true } : {}),
    }, undefined, true),
  );
};

const fileWriteAgentProjector: AgentProjector = (canonical, toolName = 'write') => {
  const parsed = fileWriteDataSchema.parse(canonical.data);
  const summary = `${parsed.path}: ${parsed.lineCount} line${parsed.lineCount === 1 ? '' : 's'}, ${parsed.byteCount} bytes`;
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(
      toolName,
      canonical,
      summary,
      {
        path: parsed.path,
        operation: parsed.operation,
        bytes: parsed.byteCount,
        lines: parsed.lineCount,
      },
    ),
  );
};

const fileContentAgentProjector: AgentProjector = (canonical, toolName = 'read') => {
  const parsed = fileContentDataSchema.parse(canonical.data);
  const requested = parsed.requestedRange.start + '-' +
    (parsed.requestedRange.end ?? parsed.requestedRange.start);
  const returned = parsed.returnedRange === null
    ? 'none'
    : parsed.returnedRange.start + '-' + parsed.returnedRange.end;
  const lines = parsed.lines
    .map((line) => escapeXmlText(line.number + ' | ' + line.content))
    .join('\n');
  const content = '<content format="line | content">' +
    (lines.length > 0 ? '\n' + lines + '\n' : '') +
    '</content>';
  const body = [
    content,
    canonical.status === 'partial' ? renderRetrieval(canonical.retrieval) : '',
  ].filter((part) => part.length > 0).join('\n');
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(toolName, canonical, body, {
      path: parsed.path,
      requested,
      returned,
      total_lines: parsed.totalLineCount,
      language: parsed.language,
    }),
  );
};

function renderDirectoryTree(entries: Array<{
  name: string;
  relativePath: string;
  kind: string;
  parentPath?: string;
}>): string {
  const childrenOf = (parentPath: string | undefined) =>
    entries.filter((entry) => entry.parentPath === parentPath);

  const renderChildren = (parentPath: string | undefined, prefix: string): string[] => {
    const children = childrenOf(parentPath);
    const lines: string[] = [];
    children.forEach((entry, index) => {
      const last = index === children.length - 1;
      const connector = last ? '└── ' : '├── ';
      const label = entry.kind === 'directory' ? entry.name + '/' : entry.name;
      lines.push(prefix + connector + label);
      if (entry.kind === 'directory') {
        lines.push(...renderChildren(
          entry.relativePath,
          prefix + (last ? '    ' : '│   '),
        ));
      }
    });
    return lines;
  };

  return renderChildren(undefined, '').join('\n');
}

const directoryEntriesAgentProjector: AgentProjector = (
  canonical,
  toolName = 'read_directory',
) => {
  const parsed = directoryEntriesDataSchema.parse(canonical.data);
  if (parsed.entries.length > 100) {
    const boundedEntries = parsed.entries.slice(0, 100);
    const retrieval = canonical.status === 'partial'
      ? canonical.retrieval
      : {
          kind: 'rerun' as const,
          toolName: 'read_directory',
          input: { directory_path: parsed.root, max_depth: parsed.depthLimit },
        };
    const tree = '<tree>\n' + renderDirectoryTree(boundedEntries) + '\n</tree>';
    return {
      content: renderXmlToolResult(
        toolName,
        canonical,
        tree + '\n' + renderRetrieval(retrieval),
        { path: parsed.root, entries: parsed.totalEntries },
        'partial',
      ),
      completeness: 'partial',
      retrieval,
    };
  }
  const tree = '<tree>\n' + renderDirectoryTree(parsed.entries) + '\n</tree>';
  const treeBody = [
    tree,
    canonical.status === 'partial' ? renderRetrieval(canonical.retrieval) : '',
  ].filter((part) => part.length > 0).join('\n');
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(toolName, canonical, treeBody, {
      path: parsed.root,
      entries: parsed.totalEntries,
      depth: parsed.depthLimit,
    }),
  );
};

const searchResultsAgentProjector: AgentProjector = (canonical, toolName) => {
  const parsed = searchResultsDataSchema.parse(canonical.data);
  const query = '<query directory="' + escapeXmlAttribute(parsed.root) +
    '" pattern="' + escapeXmlAttribute(parsed.pattern) + '" />';
  const isGlob = parsed.kind === 'glob';
  const rows = parsed.matches.map((match) => 'line' in match
    ? escapeXmlText(match.path + ' | ' + match.line + ' | ' + match.text)
    : escapeXmlText(match.path));
  const list = isGlob
    ? '<files format="path-per-line">' +
      (rows.length > 0 ? '\n' + rows.join('\n') + '\n' : '') +
      '</files>'
    : '<matches format="path | line | content">' +
      (rows.length > 0 ? '\n' + rows.join('\n') + '\n' : '') +
      '</matches>';
  const resolvedToolName = toolName ?? parsed.kind;
  if (parsed.matches.length > 100) {
    const boundedRows = parsed.matches.slice(0, 100).map((match) => 'line' in match
      ? escapeXmlText(match.path + ' | ' + match.line + ' | ' + match.text)
      : escapeXmlText(match.path));
    const boundedList = parsed.kind === 'glob'
      ? '<files format="path-per-line">\n' + boundedRows.join('\n') + '\n</files>'
      : '<matches format="path | line | content">\n' + boundedRows.join('\n') + '\n</matches>';
    const retrieval = canonical.status === 'partial'
      ? canonical.retrieval
      : {
          kind: 'rerun' as const,
          toolName: parsed.kind,
          input: { directory_path: parsed.root, pattern: parsed.pattern },
        };
    return {
      content: renderXmlToolResult(
        resolvedToolName,
        canonical,
        query + '\n' + boundedList + '\n' + renderRetrieval(retrieval),
        { total: parsed.totalMatches },
        'partial',
      ),
      completeness: 'partial',
      retrieval,
    };
  }
  return projectionWithCanonicalCompleteness(
    canonical,
    renderXmlToolResult(
      resolvedToolName,
      canonical,
      query + '\n' + list +
        (canonical.status === 'partial' ? '\n' + renderRetrieval(canonical.retrieval) : ''),
      {
      total: parsed.totalMatches,
      },
    ),
  );
};

/** Explicit family defaults; family is never inferred from a tool name. */
export const defaultFamilyAgentProjectors: ReadonlyMap<
  ToolResultFamily,
  AgentProjector
> = new Map([
  ['file-change', fileChangeAgentProjector],
  ['file-write', fileWriteAgentProjector],
  ['file-content', fileContentAgentProjector],
  ['directory-entries', directoryEntriesAgentProjector],
  ['search-results', searchResultsAgentProjector],
  ['generic', genericAgentProjector],
]);

export interface FinalizeToolExecutionResultOptions {
  canonical: CanonicalToolResult;
  toolName: string;
  toolCallId?: string;
  outputDataSchema?: z.ZodTypeAny;
  expectedFamily?: ToolResultFamily;
  projector?: AgentProjector;
  genericProjector?: AgentProjector;
  fallbackLogger?: ToolResultFallbackLogger;
  /** Test/debug escape hatch. Production finalization must leave this true. */
  fallbackOnProjectorError?: boolean;
}

/**
 * Single U1 finalization boundary: validate canonical facts, project them, and
 * fall back without mutating a successful canonical result.
 */
export function finalizeToolExecutionResult(
  options: FinalizeToolExecutionResultOptions,
): ToolExecutionResult {
  const {
    canonical,
    toolName,
    toolCallId,
    outputDataSchema,
    expectedFamily,
    fallbackLogger,
    fallbackOnProjectorError = true,
  } = options;
  const canonicalSchema = outputDataSchema === undefined && expectedFamily === undefined
    ? canonicalToolResultSchema
    : createCanonicalToolResultSchema(
        outputDataSchema ?? jsonValueSchema,
        expectedFamily,
      );
  const validatedCanonical = canonicalSchema.parse(canonical) as CanonicalToolResult;
  const projector = options.projector
    ?? defaultFamilyAgentProjectors.get(validatedCanonical.family)
    ?? genericAgentProjector;

  try {
    const agentProjection = agentProjectionSchema.parse(projector(validatedCanonical, toolName));
    return { canonical, agentProjection };
  } catch (error) {
    if (!fallbackOnProjectorError) {
      throw error;
    }
    if (fallbackLogger) {
      emitToolResultFallbackDiagnostic(fallbackLogger, {
        ...(toolCallId ? { toolCallId } : {}),
        toolName,
        family: validatedCanonical.family,
        status: validatedCanonical.status,
        stage: 'projection',
        exceptionClass: error instanceof Error ? error.constructor.name : 'Unknown',
      });
    }
    const fallback = options.genericProjector ?? genericAgentProjector;
    const agentProjection = agentProjectionSchema.parse(fallback(validatedCanonical, toolName));
    return { canonical, agentProjection };
  }
}
