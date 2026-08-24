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
import {
  registerIndexAutoRefreshBroadcast,
  unregisterIndexAutoRefreshBroadcast,
} from './index-refresh';
import { registerProviderIPC, unregisterProviderIPC } from './providers';
import {
  registerProviderModelsIPC,
  unregisterProviderModelsIPC,
} from './provider-models';
import { registerSubagentIPC, unregisterSubagentIPC } from './subagents';
import { registerAskQuestionIPC, unregisterAskQuestionIPC } from './ask-question';
import { registerPermissionIPC, unregisterPermissionIPC } from './permission';
import { registerTrustIPC, unregisterTrustIPC } from './trust';
import { registerMachinesIPC, unregisterMachinesIPC } from './machines';
import { registerAnalyticsIPC, unregisterAnalyticsIPC } from './analytics';
import { registerDebugIPC, unregisterDebugIPC } from './debug';
import { wireLocalHostWindowBroadcast } from './host-broadcast';

/**
 * Register all IPC handlers.
 * Must finish before startup publishes ready and normal renderer consumers mount.
 */
export function registerAllIPC(): void {
  // Idempotent: the embedded local host may already be running (app startup)
  // or start lazily on the first machine-scoped request.
  wireLocalHostWindowBroadcast();
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
  registerIndexAutoRefreshBroadcast();
  registerSubagentIPC();
  registerAskQuestionIPC();
  registerPermissionIPC();
  registerTrustIPC();
  registerMachinesIPC();
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
  unregisterIndexAutoRefreshBroadcast();
  unregisterSubagentIPC();
  unregisterAskQuestionIPC();
  unregisterPermissionIPC();
  unregisterTrustIPC();
  unregisterMachinesIPC();
  unregisterAnalyticsIPC();
  unregisterDebugIPC();
}
