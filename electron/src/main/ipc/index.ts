/**
 * IPC handlers — centralized registration and cleanup.
 *
 * All IPC payloads are validated with zod at the main-process boundary.
 */
import { registerChatIPC, unregisterChatIPC } from './chat';
import { registerConfigIPC, unregisterConfigIPC } from './config';
import { registerSessionIPC, unregisterSessionIPC } from './session';
import {
  registerSessionActivityIPC,
  unregisterSessionActivityIPC,
} from './session-activity';
import {
  registerSessionWorkingSetIPC,
  unregisterSessionWorkingSetIPC,
} from './session-working-set';
import { registerToolIPC, unregisterToolIPC } from './tool';
import {
  registerDefinitionsIPC,
  unregisterDefinitionsIPC,
} from './definitions';
import {
  registerMCPIPC,
  unregisterMCPIPC,
} from './mcp';
import { registerRAGIPC, unregisterRAGIPC } from './rag';
import { registerASTIPC, unregisterASTIPC } from './ast';
import { registerProviderIPC, unregisterProviderIPC } from './providers';
import {
  registerProviderModelsIPC,
  unregisterProviderModelsIPC,
} from './provider-models';
import { registerSubagentIPC, unregisterSubagentIPC } from './subagents';
import { registerAskQuestionIPC, unregisterAskQuestionIPC } from './ask-question';
import { registerPermissionIPC, unregisterPermissionIPC } from './permission';
import { registerTrustIPC, unregisterTrustIPC } from './trust';
import { registerAnalyticsIPC, unregisterAnalyticsIPC } from './analytics';
import { registerDebugIPC, unregisterDebugIPC } from './debug';

/**
 * Register all IPC handlers.
 * Must finish before startup publishes ready and normal renderer consumers mount.
 */
export function registerAllIPC(): void {
  registerChatIPC();
  registerConfigIPC();
  registerProviderIPC();
  registerProviderModelsIPC();
  registerSessionIPC();
  registerSessionActivityIPC();
  registerSessionWorkingSetIPC();
  registerToolIPC();
  registerDefinitionsIPC();
  registerMCPIPC();
  registerRAGIPC();
  registerASTIPC();
  registerSubagentIPC();
  registerAskQuestionIPC();
  registerPermissionIPC();
  registerTrustIPC();
  registerAnalyticsIPC();
  registerDebugIPC();
}

/**
 * Unregister all IPC handlers.
 * Called during graceful shutdown.
 */
export function unregisterAllIPC(): void {
  unregisterChatIPC();
  unregisterConfigIPC();
  unregisterProviderIPC();
  unregisterProviderModelsIPC();
  unregisterSessionIPC();
  unregisterSessionActivityIPC();
  unregisterSessionWorkingSetIPC();
  unregisterToolIPC();
  unregisterDefinitionsIPC();
  unregisterMCPIPC();
  unregisterRAGIPC();
  unregisterASTIPC();
  unregisterSubagentIPC();
  unregisterAskQuestionIPC();
  unregisterPermissionIPC();
  unregisterTrustIPC();
  unregisterAnalyticsIPC();
  unregisterDebugIPC();
}
