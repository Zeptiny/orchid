/**
 * RAG index worker — runs discovery + embed + SQLite off the Electron main thread.
 *
 * Loaded via `worker_threads.Worker`. Receives start params on `workerData`
 * and streams progress / result back via `parentPort`. Besides the plain
 * index pass (`op` absent), it executes the incremental upsert/delete ops so
 * the synchronous vectors.npy read/rewrite behind every incremental flush
 * never runs on the main thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ConfigManager } from '../config/loader';
import type { RAGIndexProgress, RAGIndexResult } from '../../shared/types/ipc-boundary';
import {
  runDeleteFilesImpl,
  runIndexProjectImpl,
  runUpsertFilesImpl,
  type RagWorkerOutbound,
  type RagWorkerStartData,
} from './indexer';

function post(msg: RagWorkerOutbound): void {
  parentPort?.postMessage(msg);
}

function report(progress: RAGIndexProgress): void {
  post({ type: 'progress', progress });
}

async function run(): Promise<void> {
  const data = (workerData ?? {}) as RagWorkerStartData;
  const projectPath = data.projectPath;
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('RAG worker: projectPath is required');
  }
  const op = data.op ?? 'index';

  // Legacy callers may omit a frozen runtime config. Preserve the previous
  // project-layer load in that compatibility path only. Deletes touch only
  // the vector store and never read config, so they skip the load entirely.
  if (op !== 'delete' && !data.config) {
    ConfigManager.reset();
    ConfigManager.load({ projectDir: projectPath });
  }

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

  let result: RAGIndexResult;
  if (op === 'delete') {
    result = await runDeleteFilesImpl(projectPath, data.rels ?? []);
  } else if (op === 'upsert') {
    result = await runUpsertFilesImpl({
      projectPath,
      rels: data.rels ?? [],
      progressCallback: report,
      config: data.config,
    });
  } else {
    result = await runIndexProjectImpl({
      projectPath,
      paths: data.paths,
      force: data.force === true,
      progressCallback: report,
      config: data.config,
    });
  }

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
