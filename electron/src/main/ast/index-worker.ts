/**
 * AST index worker — runs discovery + tree-sitter + SQLite off the Electron main thread.
 *
 * Loaded via `worker_threads.Worker`. Receives start params on `workerData`
 * and streams progress / result back via `parentPort`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ConfigManager } from '../config/loader';
import {
  runIndexProjectImpl,
  type AstWorkerOutbound,
  type AstWorkerStartData,
} from './indexer';

function post(msg: AstWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

async function run(): Promise<void> {
  const data = (workerData ?? {}) as AstWorkerStartData;
  const projectPath = data.projectPath;
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('AST worker: projectPath is required');
  }

  // Fresh isolate — load config for this project (home + project layers).
  ConfigManager.reset();
  ConfigManager.load({ projectDir: projectPath });

  post({
    type: 'progress',
    progress: {
      phase: 'discovering',
      done: 0,
      total: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      symbolsExtracted: 0,
      filesDeleted: 0,
      elapsedSeconds: 0,
    },
  });

  const result = await runIndexProjectImpl({
    projectPath,
    force: data.force === true,
    progressCallback: (progress) => {
      post({ type: 'progress', progress });
    },
  });

  post({
    type: 'progress',
    progress: {
      phase: 'done',
      done: result.filesScanned,
      total: result.filesScanned,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      symbolsExtracted: result.symbolsExtracted,
      filesDeleted: result.filesDeleted,
      elapsedSeconds: result.durationSeconds,
    },
  });
  post({ type: 'result', result });
}

run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  post({ type: 'error', error: message });
  process.exitCode = 1;
});
