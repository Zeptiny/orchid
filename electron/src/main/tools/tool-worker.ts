import { parentPort, workerData } from 'node:worker_threads';
import { ConfigManager } from '../config/loader';
import { createBuiltinToolRegistry } from './index';
import type {
  ToolExecutionContext,
  ToolHandlerOutcome,
  WorkerToolContext,
} from './types';
import type { Config } from '../config/schema';
import type { JsonValue } from '../../shared/types/tool-result';

interface ToolWorkerStartData {
  config: Config;
}

interface ToolWorkerExecuteMessage {
  type: 'execute';
  taskId: string;
  toolName: string;
  args: unknown;
  context: WorkerToolContext;
}

type ToolWorkerOutbound =
  | { type: 'ready' }
  | { type: 'result'; taskId: string; result: ToolHandlerOutcome<JsonValue> }
  | { type: 'error'; taskId: string; error: string };

function post(msg: ToolWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

const _startData = (workerData ?? {}) as ToolWorkerStartData;

ConfigManager.reset();
ConfigManager.load();

const registry = createBuiltinToolRegistry();

post({ type: 'ready' });

async function handleExecute(message: ToolWorkerExecuteMessage): Promise<void> {
  if (message.type !== 'execute') return;
  const { taskId, toolName, args, context } = message;
  try {
    const registered = registry.get(toolName);
    if (!registered) {
      post({ type: 'error', taskId, error: `Tool not found: ${toolName}` });
      return;
    }
    const validation = registry.validate(toolName, args);
    if (!validation.ok) {
      post({ type: 'error', taskId, error: validation.error });
      return;
    }
    const toolCtx: ToolExecutionContext = { cwd: context.cwd };
    const result = await registered.handler(validation.data, toolCtx);
    post({ type: 'result', taskId, result });
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    post({ type: 'error', taskId, error: errorMessage });
  }
}

parentPort?.on('message', (message: ToolWorkerExecuteMessage) => {
  void handleExecute(message);
});
