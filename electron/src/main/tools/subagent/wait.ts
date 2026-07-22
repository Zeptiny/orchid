/**
 * wait_for_subagent tool — blocks until specified subagents complete.
 *
 * Params: subagent_ids (string array).
 * Returns results for each subagent (completed, failed, or interrupted).
 * Times out after DEFAULT_WAIT_TIMEOUT_MS without cancelling subagents.
 *
 * Ported from Python `src/orchid/tools/subagent.py` (wait_for_subagent / execute_wait_for_subagent).
 */
import { z } from 'zod';
import type { ToolDefinition, ToolHandler } from '../types';
import { genericToolResultMetadata } from '../types';
import { escapeXmlAttribute, escapeXmlText, genericBuiltInToolOutcome } from '../result';
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  SubagentState,
  SubagentWaitTimeoutError,
  type SubagentManager,
  type SubagentRecord,
} from '../../agents/manager';
import type { SubagentToolResult } from './delegate';
import { persistSubagentChains } from '../../agents/persist-subagent-chains';

const TERMINAL_STATES = new Set<SubagentState>([
  SubagentState.COMPLETED,
  SubagentState.FAILED,
  SubagentState.INTERRUPTED,
]);

function formatElapsed(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/** Render a subagent's pending question as a compact XML block. */
function formatPendingQuestion(pending: {
  toolCallId: string;
  questions: Array<{
    type: string;
    title: string;
    description?: string;
    options: Array<{ label: string; description?: string }>;
  }>;
}): string {
  const questionBlocks = pending.questions
    .map((question) => {
      const optionBlocks = question.options
        .map((opt) =>
          '<option label="' + escapeXmlAttribute(opt.label) + '"' +
          (opt.description
            ? ' description="' + escapeXmlAttribute(opt.description) + '"'
            : '') +
          '/>')
        .join('');
      return '<question type="' + escapeXmlAttribute(question.type) +
        '" title="' + escapeXmlAttribute(question.title) + '"' +
        (question.description
          ? ' description="' + escapeXmlAttribute(question.description) + '"'
          : '') +
        '>' + optionBlocks + '</question>';
    })
    .join('');
  return '<pending_question tool_call_id="' + escapeXmlAttribute(pending.toolCallId) + '">' +
    questionBlocks + '</pending_question>';
}

function formatRecordXml(sid: string, record: SubagentRecord): string {
  const elapsed = record.endTime !== null
    ? record.endTime - record.startTime
    : record.startTime
      ? Date.now() - record.startTime
      : null;

  const status = record.pendingQuestion ? 'question_pending' : record.state;

  const attrs =
    'id="' + escapeXmlAttribute(sid) +
    '" name="' + escapeXmlAttribute(record.label) +
    '" type="' + escapeXmlAttribute(record.agent.type) +
    '" status="' + escapeXmlAttribute(status) + '"' +
    (elapsed !== null ? ' elapsed="' + escapeXmlAttribute(formatElapsed(elapsed)) + '"' : '');

  const taskBlock = record.task
    ? '<task>' + escapeXmlText(record.task) + '</task>'
    : '';

  if (record.pendingQuestion) {
    return '<subagent ' + attrs + '>' + taskBlock +
      formatPendingQuestion(record.pendingQuestion) + '</subagent>';
  }
  if (record.result) {
    return '<subagent ' + attrs + '>' + taskBlock +
      '<result>' + escapeXmlText(record.result) + '</result></subagent>';
  }
  if (record.error) {
    return '<subagent ' + attrs + '>' + taskBlock +
      '<error>' + escapeXmlText(record.error) + '</error></subagent>';
  }
  return '<subagent ' + attrs + '>' + taskBlock + '</subagent>';
}

function formatSubagentRecords(
  records: Map<string, SubagentRecord>,
  subagentIds: string[],
): string {
  const parts: string[] = [];
  for (const [sid, record] of records) {
    parts.push(formatRecordXml(sid, record));
  }
  const foundIds = new Set(records.keys());
  const missing = subagentIds.filter((id) => !foundIds.has(id));
  const missingBlock = missing.length > 0
    ? '<not_found>' + escapeXmlText(missing.join(', ')) + '</not_found>'
    : '';
  return '<subagents>' + parts.join('\n') + missingBlock + '</subagents>';
}

/**
 * Build the wait_for_subagent tool.
 *
 * @param manager - SubagentManager instance for waiting on subagents
 */
export function buildWaitTool(
  manager: SubagentManager,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'wait_for_subagent',
    description:
      'Wait for one or more subagents to complete and get their results. ' +
      "Returns the subagent's final output, status, and any errors. " +
      'Pending questions include a tool_call_id that must be passed to answer_subagent. ' +
      'Use after delegate_to_subagent to collect results. ' +
      'If the wait times out, subagents keep running — call again or interrupt_subagents.',
    inputSchema: z.object({
      subagent_ids: z
        .array(z.string())
        .describe('List of subagent IDs to wait for'),
    }),
    actionLabel: 'Waiting...',
    category: 'subagent',
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<SubagentToolResult> => {
    const { subagent_ids } = input as { subagent_ids: string[] };

    // Validate non-empty
    if (!subagent_ids || subagent_ids.length === 0) {
      return genericBuiltInToolOutcome('wait_for_subagent', 'Error: subagent_ids must be a non-empty list of IDs.', 'error');
    }

    // Explicit IDs are untrusted model input. Keep the same ownership boundary
    // as the empty-list interrupt path: a session may only observe its own
    // subagents. Legacy direct callers without a session can only observe
    // legacy unscoped records.
    const ownedIds = subagent_ids.filter(
      (id) => (manager.getRecord(id)?.sessionId ?? null) === (ctx?.sessionId ?? null),
    );

    // Wait only for records the caller owns. This must happen after filtering:
    // waiting for a peer record would otherwise block this turn and expose its
    // terminal state through timing even if its result were omitted.
    let records: Awaited<ReturnType<SubagentManager['wait']>>;
    try {
      records = await manager.wait(ownedIds, {
        timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
        signal: ctx?.abortSignal,
      });
    } catch (err) {
      if (err instanceof SubagentWaitTimeoutError) {
        const partialRecords = new Map<string, SubagentRecord>();
        for (const id of ownedIds) {
          const record = manager.getRecord(id);
          if (record) partialRecords.set(id, record);
        }
        const hasTerminal = [...partialRecords.values()].some(
          (r) => TERMINAL_STATES.has(r.state) || r.pendingQuestion !== null,
        );
        const xml = formatSubagentRecords(partialRecords, subagent_ids);
        const timeoutNotice =
          '\n<timeout>' + escapeXmlText(err.message) + '</timeout>';
        return genericBuiltInToolOutcome(
          'wait_for_subagent',
          xml + timeoutNotice,
          hasTerminal ? 'complete' : 'error',
        );
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        return genericBuiltInToolOutcome('wait_for_subagent', 'Wait aborted because the parent turn was cancelled. ' +
            'Subagents were not cancelled or interrupted by this wait; ' +
            'call interrupt_subagents to stop them if needed.', 'cancelled');
      }
      throw err;
    }

    // Persist latest subagent chains onto each owning session (not blindly active)
    try {
      persistSubagentChains(manager);
    } catch {
      // Non-fatal — UI can still read in-memory state on next refresh
    }

    // No records found at all
    if (records.size === 0) {
      return genericBuiltInToolOutcome('wait_for_subagent', `No subagents found for IDs: ${subagent_ids.join(', ')}`, 'empty');
    }

    const content = formatSubagentRecords(records, subagent_ids);
    return genericBuiltInToolOutcome('wait_for_subagent', content, 'complete');
  };

  return { definition, handler };
}
