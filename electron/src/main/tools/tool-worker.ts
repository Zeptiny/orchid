import { parentPort } from 'node:worker_threads';
import { ConfigManager } from '../config/loader';
import { EMPTY_SHARED_PROMPTS } from '../prompts/registry';
import { createToolWorkerRegistry } from './worker-registry';
import type {
  ToolExecutionContext,
  ToolHandlerOutcome,
  WorkerToolContext,
} from './types';
import type { ProjectRuntime } from '../project/runtime';
import type { JsonValue } from '../../shared/types/tool-result';

interface ToolWorkerExecuteMessage {
  type: 'execute';
  taskId: number;
  toolName: string;
  args: unknown;
  context: WorkerToolContext;
}

type ToolWorkerOutbound =
  | { type: 'ready' }
  | { type: 'result'; taskId: number; result: ToolHandlerOutcome<JsonValue> }
  | { type: 'error'; taskId: number; error: string };

function post(msg: ToolWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

ConfigManager.reset();
ConfigManager.load();

const registry = createToolWorkerRegistry();

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
    const projectRuntime: ProjectRuntime = {
      projectDir: context.cwd,
      config: context.config,
      agents: new Map(),
      skills: new Map(),
      personalities: new Map(),
      sharedPrompts: EMPTY_SHARED_PROMPTS,
    };
    const toolCtx: ToolExecutionContext = { cwd: context.cwd, projectRuntime };
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
