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

/**
 * Register all IPC handlers.
 * Must be called before creating the BrowserWindow.
 */
export function registerAllIPC(): void {
  registerChatIPC();
  registerConfigIPC();
  registerProviderIPC();
  registerSessionIPC();
  registerSessionActivityIPC();
  registerToolIPC();
  registerDefinitionsIPC();
  registerMCPIPC();
  registerRAGIPC();
  registerASTIPC();
}

/**
 * Unregister all IPC handlers.
 * Called during graceful shutdown.
 */
export function unregisterAllIPC(): void {
  unregisterChatIPC();
  unregisterConfigIPC();
  unregisterProviderIPC();
  unregisterSessionIPC();
  unregisterSessionActivityIPC();
  unregisterToolIPC();
  unregisterDefinitionsIPC();
  unregisterMCPIPC();
  unregisterRAGIPC();
  unregisterASTIPC();
}
