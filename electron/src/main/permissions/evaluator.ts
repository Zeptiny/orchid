import type { RiskClass } from '../../shared/types/permission';

/** Context describing a single tool call the evaluator is asked to judge. */
export interface EvaluatorContext {
  toolName: string;
  riskClass: RiskClass;
  args: unknown;
  cwd: string;
  triggeringMessage: string;
  recentToolCalls: Array<{ name: string; argsSummary: string }>;
}

/** Outcome of an evaluator judgment for a tool call. */
export interface EvaluatorResult {
  decision: 'approved' | 'denied' | 'fallback-to-ask' | 'cancelled';
  reason?: string;
}

/** Injectable LLM text-generation function used to run the evaluator. */
export type GenerateTextFn = (params: {
  systemPrompt: string;
  userMessage: string;
}) => Promise<string>;

const MAX_ARGS_LENGTH = 2000;
const MAX_ARGS_SUMMARY_LENGTH = 200;

/** Whether the evaluator can see the complete serialized argument payload. */
export function canEvaluateToolCallArgs(args: unknown): boolean {
  try {
    const serialized = JSON.stringify(args);
    return serialized !== undefined && serialized.length <= MAX_ARGS_LENGTH;
  } catch {
    return false;
  }
}

/** Build the complete-context user prompt the evaluator model receives. */
export function buildEvaluatorPrompt(
  context: EvaluatorContext,
  config: { permission_history_size: number },
): string {
  const argsJson = JSON.stringify(context.args);
  if (argsJson === undefined || argsJson.length > MAX_ARGS_LENGTH) {
    throw new Error('Evaluator arguments exceed the complete-context budget.');
  }

  const recentCalls = (config.permission_history_size <= 0
    ? []
    : context.recentToolCalls.slice(-config.permission_history_size))
    .map(
      (call) =>
        `- ${call.name}: ${call.argsSummary.slice(0, MAX_ARGS_SUMMARY_LENGTH)}`,
    )
    .join('\n');

  const lines = [
    `Tool: ${context.toolName}`,
    `Risk class: ${context.riskClass}`,
    `Arguments: ${argsJson}`,
    `Working directory: ${context.cwd}`,
    '',
    `User's request: ${context.triggeringMessage}`,
    '',
    'Recent tool calls:',
  ];

  if (recentCalls.length > 0) {
    lines.push(recentCalls);
  } else {
    lines.push('- (none)');
  }

  return lines.join('\n');
}

/** Parse a raw evaluator model response into a structured result. */
export function parseEvaluatorResponse(raw: string): EvaluatorResult {
  try {
    const parsed = JSON.parse(raw.trim()) as {
      decision?: string;
      reason?: string;
    };
    if (parsed.decision === 'approve') {
      return { decision: 'approved' };
    }
    if (parsed.decision === 'deny') {
      return {
        decision: 'denied',
        reason: parsed.reason ?? 'denied by evaluator',
      };
    }
    return { decision: 'fallback-to-ask', reason: 'evaluator response unparseable' };
  } catch {
    return { decision: 'fallback-to-ask', reason: 'evaluator response unparseable' };
  }
}

/** Evaluate a tool call end-to-end, falling back to ask on any failure. */
export async function evaluateToolCall(
  context: EvaluatorContext,
  config: { permission_history_size: number },
  generateText: GenerateTextFn,
  systemPrompt: string,
): Promise<EvaluatorResult> {
  if (!canEvaluateToolCallArgs(context.args)) {
    return {
      decision: 'fallback-to-ask',
      reason: 'evaluator arguments exceed the complete-context budget',
    };
  }
  const userMessage = buildEvaluatorPrompt(context, config);
  try {
    const response = await generateText({ systemPrompt, userMessage });
    return parseEvaluatorResponse(response);
  } catch {
    return { decision: 'fallback-to-ask', reason: 'evaluator invocation failed' };
  }
}
