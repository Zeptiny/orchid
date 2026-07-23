export interface EvaluatorContext {
  toolName: string;
  riskClass: string;
  args: unknown;
  cwd: string;
  triggeringMessage: string;
  recentToolCalls: Array<{ name: string; argsSummary: string }>;
}

export interface EvaluatorResult {
  decision: 'approved' | 'denied';
  reason?: string;
}

export type GenerateTextFn = (params: {
  systemPrompt: string;
  userMessage: string;
}) => Promise<string>;

const MAX_ARGS_LENGTH = 2000;
const MAX_ARGS_SUMMARY_LENGTH = 200;

export function buildEvaluatorPrompt(
  context: EvaluatorContext,
  config: { permission_history_size: number },
): string {
  const argsJson = JSON.stringify(context.args);
  const truncatedArgs =
    argsJson.length > MAX_ARGS_LENGTH
      ? argsJson.slice(0, MAX_ARGS_LENGTH)
      : argsJson;

  const recentCalls = context.recentToolCalls
    .slice(0, config.permission_history_size)
    .map(
      (call) =>
        `- ${call.name}: ${call.argsSummary.slice(0, MAX_ARGS_SUMMARY_LENGTH)}`,
    )
    .join('\n');

  const lines = [
    `Tool: ${context.toolName}`,
    `Risk class: ${context.riskClass}`,
    `Arguments: ${truncatedArgs}`,
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
    return { decision: 'denied', reason: 'evaluator response unparseable' };
  } catch {
    return { decision: 'denied', reason: 'evaluator response unparseable' };
  }
}

export async function evaluateToolCall(
  context: EvaluatorContext,
  config: { permission_history_size: number },
  generateText: GenerateTextFn,
  systemPrompt: string,
): Promise<EvaluatorResult> {
  const userMessage = buildEvaluatorPrompt(context, config);
  try {
    const response = await generateText({ systemPrompt, userMessage });
    return parseEvaluatorResponse(response);
  } catch {
    return { decision: 'denied', reason: 'evaluator invocation failed' };
  }
}
