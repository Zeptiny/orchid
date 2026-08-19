import type { ReasoningProviderOptions } from '../../providers/drivers/types';
import { streamChat, type StreamEvent } from '../../llm/orchestrator';
import type { ThinkingReplayContext } from '../../llm/history';
import { buildSystemPromptContext } from '../../llm/build-prompt-context';
import type { Agent } from '../../../shared/types/agent';
import type { Message } from '../../../shared/types/message';
import type { ChatErrorKind } from '../../../shared/types/ipc';
import type { getBuiltinToolRegistryForRuntime } from '../../tools';
import type { acquireProjectMCPManager } from '../../mcp/project-registry';
import type { ProjectRuntime } from '../../project/runtime';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';
import type { CacheFacet } from '../../../shared/types/provider-facets';
import { shouldStopEarlyForSession } from '../next-request-stop';
import { isContextLengthExceededMessage } from '../../llm/middleware/error-classification';

export function classifyErrorKind(title: string | null | undefined, detail: string): ChatErrorKind {
  const haystack = `${title ?? ''} ${detail}`;
  // Shared overflow predicate — stays aligned with the middleware's
  // isContextLengthExceededError (which drives the compaction-retry decision).
  if (isContextLengthExceededMessage(haystack)) {
    return 'context_length_exceeded';
  }
  const lower = haystack.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('usage limit')) {
    return 'rate-limit';
  }
  if (
    lower.includes('auth') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('api key')
  ) {
    return 'auth';
  }
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('connection')
  ) {
    return 'stream';
  }
  return 'generic';
}

/**
 * Bind a turn's already-resolved adapter to the orchestrator. The typed
 * selection, project runtime, message history, and model instance are all
 * frozen before the actor starts, so a later settings change cannot redirect
 * credentials, tools, or a retry to another connection.
 */
export function createProviderStreamFn(input: {
  readonly messages: Message[];
  readonly runtime: ProjectRuntime;
  readonly sessionId: string;
  readonly windowId: string;
  readonly modelInstance: LanguageModelV4;
  readonly accounting: ProviderAttemptAccountingContext;
  readonly registry: ReturnType<typeof getBuiltinToolRegistryForRuntime>;
  readonly mcpManager: ReturnType<typeof acquireProjectMCPManager>;
  readonly providerOptions?: ReasoningProviderOptions;
  readonly thinkingReplay?: ThinkingReplayContext;
  /** Driver-owned prompt-cache placement inputs; absent = no markers (R12). */
  readonly cachePlacement?: {
    readonly facet: CacheFacet;
    readonly ttl?: string;
    readonly sessionKey?: string;
  };
}) {
  return async function* ({
    agent,
    systemPrompt,
    abortSignal,
  }: {
    message: string;
    agent: Agent;
    systemPrompt: string;
    abortSignal: AbortSignal;
  }): AsyncGenerator<StreamEvent> {
    const context = await buildSystemPromptContext({
      cwd: input.runtime.projectDir,
      config: input.runtime.config,
      sessionId: input.sessionId,
      agentScopeId: 'main',
    });
    yield* streamChat({
      messages: input.messages,
      agent,
      systemPrompt,
      context,
      config: input.runtime.config,
      registry: input.registry,
      mcpManager: input.mcpManager,
      sessionId: input.sessionId,
      windowId: input.windowId,
      projectRuntime: input.runtime,
      agentScopeId: 'main',
      abortSignal,
      shouldStopEarly: () => shouldStopEarlyForSession(input.sessionId),
      modelInstance: input.modelInstance,
      accounting: input.accounting,
      providerOptions: input.providerOptions,
      thinkingReplay: input.thinkingReplay,
      cachePlacement: input.cachePlacement,
    });
  };
}
