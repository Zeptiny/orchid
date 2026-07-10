/**
 * IPC handlers — centralized registration and cleanup.
 *
 * All IPC payloads are validated with zod at the main-process boundary.
 */
import { registerChatIPC, unregisterChatIPC } from './chat';
import { registerConfigIPC, unregisterConfigIPC } from './config';
import { registerSessionIPC, unregisterSessionIPC } from './session';
import { registerToolIPC, unregisterToolIPC } from './tool';
import { registerAgentIPC, unregisterAgentIPC } from './agent';
import {
  registerDefinitionsIPC,
  unregisterDefinitionsIPC,
} from './definitions';
import {
  registerMCPIPC,
  unregisterMCPIPC,
  setMCPManagerRef,
  getMCPManagerRef,
} from './mcp';
import { registerRAGIPC, unregisterRAGIPC } from './rag';
import { registerASTIPC, unregisterASTIPC } from './ast';
import { registerUpdaterIPC, unregisterUpdaterIPC } from './updater';

/**
 * Register all IPC handlers.
 * Must be called before creating the BrowserWindow.
 */
export function registerAllIPC(): void {
  registerChatIPC();
  registerConfigIPC();
  registerSessionIPC();
  registerToolIPC();
  registerAgentIPC();
  registerDefinitionsIPC();
  registerMCPIPC();
  registerRAGIPC();
  registerASTIPC();
  registerUpdaterIPC();
}

/**
 * Unregister all IPC handlers.
 * Called during graceful shutdown.
 */
export function unregisterAllIPC(): void {
  unregisterChatIPC();
  unregisterConfigIPC();
  unregisterSessionIPC();
  unregisterToolIPC();
  unregisterAgentIPC();
  unregisterDefinitionsIPC();
  unregisterMCPIPC();
  unregisterRAGIPC();
  unregisterASTIPC();
  unregisterUpdaterIPC();
}

export { setMCPManagerRef };
export { getMCPManagerRef };
