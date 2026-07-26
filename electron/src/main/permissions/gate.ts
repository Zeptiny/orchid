/**
 * Permission gate — decide whether a tool call may run, needs human approval,
 * or is denied. Fail-closed: an unclassified tool is denied, and any unexpected
 * error is surfaced as a denial by the caller.
 */
import { genericTerminalExecution } from '../llm/terminal-result';
import { resolvePermission, passesRiskClassFloor } from './resolver';
import { approvalStore } from './approval-store';
import { createDefaultEngine, DetectionEngine } from './detection';
import { sessionPermissionOverrides } from './session-overrides';
import {
  canEvaluateToolCallArgs,
  evaluateToolCall,
  type EvaluatorContext,
  type EvaluatorResult,
} from './evaluator';
import { getRecentToolCallHistory } from './history';
import { getProviderRuntime } from '../providers';
import { createMiddlewareStack } from '../llm/middleware';
import { getTierModelSelection } from '../config/loader';
import { importESM } from '../utils/esm-import';
import { AgentType } from '../../shared/types/agent';
import type { PermissionMode, RiskClass, ToolScope, ResolvedToolScope } from '../../shared/types/permission';
import type { Config } from '../../shared/types/ipc-boundary';
import type { ProjectRuntime } from '../project/runtime';
import type { ToolExecutionResult } from '../../shared/types/tool-result';

let detectionEngine: DetectionEngine | null = null;

async function requestApproval(
  toolCallId: string,
  sessionId: string | undefined,
  toolName: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  scope: ToolScope | undefined,
  abortSignal?: AbortSignal,
  ownerWindowId?: string,
): Promise<ToolExecutionResult | null> {
  const result = await approvalStore.create(
    toolCallId,
    sessionId ?? '',
    toolName,
    riskClass,
    args,
    cwd,
    scope,
    abortSignal,
    ownerWindowId,
  );
  if (result.decision === 'approved') return null;
  const reason = result.reason ? ` (${result.reason})` : '';
  return genericTerminalExecution(
    toolCallId,
    toolName,
    'error',
    `Permission denied for tool '${toolName}'${reason}.`,
    'permission_denied',
  );
}

async function runEvaluator(
  name: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  config: Config,
  projectRuntime: ProjectRuntime | undefined,
  triggeringMessage: string,
  sessionId: string,
  agentScopeId: string | undefined,
  abortSignal?: AbortSignal,
): Promise<EvaluatorResult> {
  if (abortSignal?.aborted) {
    return { decision: 'cancelled', reason: 'parent turn cancelled' };
  }
  if (!canEvaluateToolCallArgs(args)) {
    return {
      decision: 'fallback-to-ask',
      reason: 'evaluator arguments exceed the complete-context budget',
    };
  }
  if (!projectRuntime) {
    return { decision: 'fallback-to-ask', reason: 'evaluator runtime unavailable' };
  }
  const evaluatorAgent = projectRuntime.agents.get('permission-evaluator');
  if (!evaluatorAgent || evaluatorAgent.type !== AgentType.INTERNAL) {
    return { decision: 'fallback-to-ask', reason: 'permission evaluator unavailable' };
  }

  const selection = getTierModelSelection(config, evaluatorAgent.tier);
  if (!selection) {
    return { decision: 'fallback-to-ask', reason: 'permission evaluator model unavailable' };
  }

  try {
    const execution = await getProviderRuntime().resolveExecution(selection);
    if (abortSignal?.aborted) {
      return { decision: 'cancelled', reason: 'parent turn cancelled' };
    }
    const { generateText, wrapLanguageModel } = await importESM<typeof import('ai')>('ai');
    const model = wrapLanguageModel({
      model: execution.modelInstance,
      middleware: createMiddlewareStack({
        retry: { maxRetries: config.llm_stream_retries },
      }),
    });

    const context: EvaluatorContext = {
      toolName: name,
      riskClass,
      args,
      cwd,
      triggeringMessage,
      recentToolCalls: getRecentToolCallHistory(
        sessionId,
        agentScopeId,
        config.permission_history_size,
      ),
    };
    if (abortSignal?.aborted) {
      return { decision: 'cancelled', reason: 'parent turn cancelled' };
    }

    const result = await evaluateToolCall(
      context,
      config,
      async ({ systemPrompt, userMessage }) => {
        const timeoutSignal = AbortSignal.timeout(30_000);
        const evaluatorSignal = abortSignal == null
          ? timeoutSignal
          : AbortSignal.any([abortSignal, timeoutSignal]);
        const response = await generateText({
          model,
          instructions: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
          abortSignal: evaluatorSignal,
          maxRetries: 0,
        });
        return response.text;
      },
      evaluatorAgent.system_prompt,
    );
    if (abortSignal?.aborted) {
      return { decision: 'cancelled', reason: 'parent turn cancelled' };
    }
    return result;
  } catch (error) {
    if (abortSignal?.aborted) {
      return { decision: 'cancelled', reason: 'parent turn cancelled' };
    }
    return {
      decision: 'fallback-to-ask',
      reason: error instanceof Error
        ? `evaluator unavailable: ${error.message}`
        : 'evaluator unavailable',
    };
  }
}

type FlagPolicy = 'always-ask' | 'detect-command' | 'workspace-scope' | 'allow';

function askWhenFlaggedPolicy(
  name: string,
  riskClass: RiskClass,
  resolvedScope: ResolvedToolScope | undefined,
): FlagPolicy {
  if (name === 'send_input') return 'always-ask';
  if (name === 'execute_command') return 'detect-command';
  if (name.startsWith('mcp::')) return 'always-ask';
  if (resolvedScope !== undefined) return 'workspace-scope';
  // Default by risk class: execution/mutation are gated; read-only/network/delegation
  // auto-run (preserves web_fetch=network auto-running in ask-when-flagged).
  return riskClass === 'execution' || riskClass === 'mutation' ? 'always-ask' : 'allow';
}

/** Decide whether a tool call may run; returns a denial result or null to allow. */
export async function checkPermission(
  toolCallId: string,
  name: string,
  riskClass: RiskClass,
  args: Record<string, unknown>,
  cwd: string,
  sessionId: string | undefined,
  config: Config,
  projectRuntime: ProjectRuntime | undefined,
  triggeringMessage: string,
  abortSignal?: AbortSignal,
  agentScopeId?: string,
  ownerWindowId?: string,
  resolvedScope?: ResolvedToolScope,
): Promise<ToolExecutionResult | null> {
  if (!riskClass) {
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Tool '${name}' has no risk classification; denying by default.`,
      'permission_gate_error',
    );
  }

  const sessionOverride: PermissionMode | null = sessionId
    ? (sessionPermissionOverrides.get(sessionId) ?? null)
    : null;

  const resolution = resolvePermission(name, riskClass, config, sessionOverride, resolvedScope);
  const { mode, scope } = resolution;

  if (mode === 'allow') return null;

  if (mode === 'ask') {
    return requestApproval(
      toolCallId,
      sessionId,
      name,
      riskClass,
      args,
      cwd,
      scope,
      abortSignal,
      ownerWindowId,
    );
  }

  if (mode === 'decide-for-me') {
    if (!passesRiskClassFloor(name, riskClass, config, resolvedScope)) return null;
    const result = await runEvaluator(
      name,
      riskClass,
      args,
      cwd,
      config,
      projectRuntime,
      triggeringMessage,
      sessionId ?? '',
      agentScopeId,
      abortSignal,
    );
    if (result.decision === 'cancelled') {
      return genericTerminalExecution(
        toolCallId,
        name,
        'cancelled',
        `Tool '${name}' was cancelled.`,
        'parent_cancelled',
      );
    }
    if (result.decision === 'approved') return null;
    if (result.decision === 'fallback-to-ask') {
      return requestApproval(
        toolCallId,
        sessionId,
        name,
        riskClass,
        args,
        cwd,
        scope,
        abortSignal,
        ownerWindowId,
      );
    }
    const evaluatorReason = result.reason ? ` (${result.reason})` : '';
    return genericTerminalExecution(
      toolCallId,
      name,
      'error',
      `Permission denied for tool '${name}' by evaluator${evaluatorReason}.`,
      'permission_denied',
    );
  }

  if (name === 'send_input') {
    return requestApproval(
      toolCallId,
      sessionId,
      name,
      riskClass,
      args,
      cwd,
      scope,
      abortSignal,
      ownerWindowId,
    );
  }

  if (!passesRiskClassFloor(name, riskClass, config, resolvedScope)) return null;

  switch (askWhenFlaggedPolicy(name, riskClass, resolvedScope)) {
    case 'always-ask':
      return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal, ownerWindowId);
    case 'detect-command': {
      const command = typeof args['command'] === 'string' ? args['command'] : '';
      if (!detectionEngine) detectionEngine = createDefaultEngine();
      if (!detectionEngine.evaluate(command).flagged) return null;
      return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal, ownerWindowId);
    }
    case 'workspace-scope':
      if (scope === 'inside') return null;
      return requestApproval(toolCallId, sessionId, name, riskClass, args, cwd, scope, abortSignal, ownerWindowId);
    case 'allow':
      return null;
  }
}
