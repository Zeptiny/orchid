/**
 * RAG index worker — runs discovery + embed + SQLite off the Electron main thread.
 *
 * Loaded via `worker_threads.Worker`. Receives start params on `workerData`
 * and streams progress / result back via `parentPort`.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ConfigManager } from '../config/loader';
import {
  runIndexProjectImpl,
  type RagWorkerOutbound,
  type RagWorkerStartData,
} from './indexer';

function post(msg: RagWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

async function run(): Promise<void> {
  const data = (workerData ?? {}) as RagWorkerStartData;
  const projectPath = data.projectPath;
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('RAG worker: projectPath is required');
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
      chunksCreated: 0,
      filesDeleted: 0,
      elapsedSeconds: 0,
    },
  });

  const result = await runIndexProjectImpl(
    projectPath,
    data.paths,
    data.force === true,
    undefined,
    (progress) => {
      post({ type: 'progress', progress });
    },
  );

  post({
    type: 'progress',
    progress: {
      phase: 'done',
      done: result.filesScanned,
      total: result.filesScanned,
      filesIndexed: result.filesIndexed,
      filesSkipped: result.filesSkipped,
      chunksCreated: result.chunksCreated,
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
