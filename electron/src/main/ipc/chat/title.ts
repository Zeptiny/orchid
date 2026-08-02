import { createMiddlewareStack } from '../../llm/middleware';
import { AgentType } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Message } from '../../../shared/types/message';
import type { GenerateTitleCallback } from '../../session/manager';
import { getProviderRuntime } from '../../providers';
import { importESM } from '../../utils/esm-import';
import { getTierModelSelection } from '../../config/loader';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';

const SESSION_NAMER_AGENT_NAME = 'session-namer';

/**
 * Creates a GenerateTitleCallback that uses the bundled internal session-namer
 * agent to produce a short title from the first user/assistant exchange.
 *
 * Non-fatal on failure — returns null so the session keeps its default name.
 */
export function createGenerateTitleCallback(input: {
  runtime: ProjectRuntime;
  messages: readonly Message[];
  fallbackSelection: ModelSelection;
  accounting: Omit<ProviderAttemptAccountingContext, 'snapshot'>;
}): GenerateTitleCallback {
  return async () => {
    const userMessage = input.messages.find(
      (message) => message.role === MessageRole.USER && message.type === MessageType.TEXT,
    );
    const assistantMessage = input.messages.find(
      (message) => message.role === MessageRole.ASSISTANT && message.type === MessageType.TEXT,
    );
    if (!userMessage || !assistantMessage) {
      console.warn(
        '[auto-name] Completed exchange has no user/assistant text; keeping the default session name.',
      );
      return null;
    }

    try {
      const titleAgent = input.runtime.agents.get(SESSION_NAMER_AGENT_NAME);
      if (!titleAgent || titleAgent.type !== AgentType.INTERNAL) {
        console.warn(
          `[auto-name] Internal agent "${SESSION_NAMER_AGENT_NAME}" is unavailable; ` +
          'keeping the default session name.',
        );
        return null;
      }
      const titleSelection =
        getTierModelSelection(input.runtime.config, titleAgent.tier) ??
        input.fallbackSelection;
      const execution = await getProviderRuntime().resolveExecution(titleSelection);
      const { generateText, wrapLanguageModel } = await importESM<typeof import('ai')>('ai');
      const model = wrapLanguageModel({
        model: execution.modelInstance,
        middleware: createMiddlewareStack({
          retry: { maxRetries: input.runtime.config.llm_stream_retries },
          accounting: {
            ...input.accounting,
            agentScope: 'main',
            agentName: titleAgent.name,
            agentType: titleAgent.type,
            agentTier: titleAgent.tier,
            snapshot: execution.snapshot,
          },
        }),
      });
      const result = await generateText({
        model,
        instructions: titleAgent.system_prompt,
        abortSignal: AbortSignal.timeout(
          Math.max(1, input.runtime.config.llm_stream_idle_timeout * 1000),
        ),
        messages: [
          {
            role: 'user',
            content:
              `User: ${userMessage.content.slice(0, 500)}\n\n` +
              `Assistant: ${assistantMessage.content.slice(0, 500)}`,
          },
        ],
        // Orchid's accounting-aware retry middleware owns every retry attempt.
        maxRetries: 0,
      });
      return result.text.trim().split('\n')[0]?.trim() || null;
    } catch (error) {
      console.warn(
        '[auto-name] Title generation failed; keeping the default session name:',
        error,
      );
      return null;
    }
  };
}
