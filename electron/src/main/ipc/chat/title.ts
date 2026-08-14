import type { WebContents } from 'electron';
import { createMiddlewareStack } from '../../llm/middleware';
import { AgentType } from '../../../shared/types/agent';
import type { ModelSelection } from '../../../shared/types/provider';
import { MessageRole, MessageType } from '../../../shared/types/message';
import type { Message } from '../../../shared/types/message';
import { IPC_CHANNELS } from '../../../shared/types/ipc';
import type { GenerateTitleCallback } from '../../session/manager';
import { getSessionManager } from '../../session/singleton';
import { getProviderRuntime } from '../../providers';
import { getProviderAccountingStore } from '../../providers/accounting/store';
import { importESM } from '../../utils/esm-import';
import { getTierModelSelection } from '../../config/loader';
import type { ProjectRuntime } from '../../project/runtime';
import type { ProviderAttemptAccountingContext } from '../../providers/accounting/middleware';
import { sendSessionEvent, webContentsForWindowId } from './events';
import { namingInFlight, type ActiveAgent } from './state';

const SESSION_NAMER_AGENT_NAME = 'session-namer';

function isTextMessage(message: Message, role: MessageRole): boolean {
  return message.role === role && message.type === MessageType.TEXT && !message.hidden;
}

/**
 * Creates a GenerateTitleCallback that uses the bundled internal session-namer
 * agent to produce a short title from the first user/assistant exchange.
 *
 * Only the user message is required: a deadline or interruption trigger can
 * fire before the assistant has produced any text, and the user's request is
 * enough to name the session. Non-fatal on failure — returns null so the
 * session keeps its default name.
 */
export function createGenerateTitleCallback(input: {
  runtime: ProjectRuntime;
  messages: readonly Message[];
  fallbackSelection: ModelSelection;
  accounting: Omit<ProviderAttemptAccountingContext, 'snapshot'>;
}): GenerateTitleCallback {
  return async () => {
    const userMessage = input.messages.find((message) =>
      isTextMessage(message, MessageRole.USER),
    );
    if (!userMessage) {
      console.warn(
        '[auto-name] Exchange has no user text; keeping the default session name.',
      );
      return null;
    }
    const assistantMessage = input.messages.find((message) =>
      isTextMessage(message, MessageRole.ASSISTANT),
    );

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
            pricingFacet: execution.pricingFacet,
           attemptIdHolder: { value: null },
          },
        }),
      });
      const transcript = assistantMessage
        ? `User: ${userMessage.content.slice(0, 500)}\n\n` +
          `Assistant: ${assistantMessage.content.slice(0, 500)}`
        : `User: ${userMessage.content.slice(0, 500)}`;
      const result = await generateText({
        model,
        instructions: titleAgent.system_prompt,
        abortSignal: AbortSignal.timeout(
          Math.max(1, input.runtime.config.llm_stream_idle_timeout * 1000),
        ),
        messages: [{ role: 'user', content: transcript }],
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

export interface AutoNameTriggerInput {
  sessionId: string;
  runtime: ProjectRuntime;
  messages: readonly Message[];
  fallbackSelection: ModelSelection;
  accounting: Omit<ProviderAttemptAccountingContext, 'snapshot'>;
  /** Turn-originating window; the event also fans out to other viewers. */
  webContents: WebContents | null;
}

/**
 * Run one auto-naming attempt for a session.
 *
 * Shared by the three trigger points (mid-turn deadline, turn completion,
 * turn interruption). Skips sessions that no longer carry the default
 * "Session …" name and dedupes concurrent attempts per session, so racing
 * triggers never start more than one title LLM call. Emits SESSION_RENAMED
 * to every window still viewing the session when the attempt resolves.
 */
export function triggerSessionAutoName(input: AutoNameTriggerInput): void {
  if (namingInFlight.has(input.sessionId)) return;
  const session = getSessionManager().getSession(input.sessionId);
  if (!session || !session.name.startsWith('Session ')) return;

  namingInFlight.add(input.sessionId);
  const generateTitle = createGenerateTitleCallback(input);
  getSessionManager()
    .autoName(input.sessionId, generateTitle)
    .then((updated) => {
      if (updated) {
        sendSessionEvent(input.webContents, input.sessionId, IPC_CHANNELS.SESSION_RENAMED, {
          id: updated.id, name: updated.name,
        });
      }
    })
    .catch((error) => console.warn('Auto-naming failed (non-fatal):', error))
    .finally(() => namingInFlight.delete(input.sessionId));
}

/**
 * Auto-name a turn that ended by interruption/cancel/stop instead of normal
 * completion. Uses the persisted history snapshot the caller already built.
 */
export function triggerInterruptedTurnAutoName(
  agent: ActiveAgent,
  messages: readonly Message[],
): void {
  triggerSessionAutoName({
    sessionId: agent.sessionId,
    runtime: agent.runtime,
    messages,
    fallbackSelection: agent.selection,
    accounting: {
      store: getProviderAccountingStore(),
      sessionId: agent.sessionId,
      chainId: agent.chainId,
      turnId: agent.turnId,
    },
    webContents: webContentsForWindowId(agent.windowId),
  });
}
