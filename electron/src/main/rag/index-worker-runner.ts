/**
 * RAG index worker runner — the parent side of the index worker thread.
 *
 * Spawns `index-worker.js` with a serialized start payload, mirrors its
 * progress onto the caller's callback, arms the idle watchdog, and settles
 * exactly once (result, worker error, watchdog expiry, or cancellation).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import { removeModelDownloadTemps } from './embedder';
import {
  runDeleteFilesImpl,
  runIndexProjectImpl,
  runUpsertFilesImpl,
  type RagIndexRequest,
} from './index-pipeline';
import type { RAGIndexProgress, RAGIndexResult } from '../../shared/types/ipc-boundary';

/** Payload passed to the index worker via workerData. */
export interface RagWorkerStartData {
  projectPath: string;
  force?: boolean;
  paths?: string[];
  /** Frozen, secret-free project configuration captured by the caller. */
  config?: Config;
  /**
   * Operation selector. Absent (or `'index'`) runs the standard index pass
   * over `paths`/`force`. `'upsert'` probes vector-state consistency and runs
   * a scoped (or full, on mismatch) index over `rels`; `'delete'` removes the
   * stored chunks, file rows, and vectors for `rels`. Incremental ops exist
   * so the full vectors.npy read/rewrite never runs on the main thread.
   */
  op?: 'index' | 'upsert' | 'delete';
  /** Normalized targets for the `'upsert'` / `'delete'` ops. */
  rels?: string[];
}

/** Messages the index worker posts back to the parent. */
export type RagWorkerOutbound =
  | { type: 'progress'; progress: RAGIndexProgress }
  | { type: 'result'; result: RAGIndexResult }
  | { type: 'error'; error: string };

/** An index run dispatched onto the worker thread. */
export interface RagWorkerRequest extends Omit<RagIndexRequest, 'projectPath'> {
  projectPath: string;
  /** @internal Test-only worker entry override for deterministic watchdog tests. */
  workerPath?: string;
  /** Incremental op to dispatch instead of the plain index pass. */
  op?: 'upsert' | 'delete';
  /** Normalized targets for `op`. */
  rels?: string[];
  /** Receives the abort hook so a replacement run can cancel this one. */
  registerCancel?: (cancel: (reason: Error) => Promise<void>) => void;
}

/**
 * Run an index pass on the index worker thread, falling back to the current
 * thread when the compiled worker entry is missing (dev builds).
 */
export async function runIndexInWorker(request: RagWorkerRequest): Promise<RAGIndexResult> {
  const workerPath = request.workerPath ?? path.join(__dirname, 'index-worker.js');
  if (fs.existsSync(workerPath)) {
    return await awaitWorkerRun(request, workerPath);
  }
  // Dev fallback if worker bundle is missing — still produce a usable index.
  console.warn(
    `RAG worker not found at ${workerPath}; running index inline on the main thread`,
  );
  return await runInlineFallback(request);
}

async function runInlineFallback(request: RagWorkerRequest): Promise<RAGIndexResult> {
  const { projectPath, config, progressCallback } = request;
  if (request.op === 'delete') {
    return runDeleteFilesImpl(projectPath, request.rels ?? []);
  }
  if (request.op === 'upsert') {
    return runUpsertFilesImpl({
      projectPath,
      rels: request.rels ?? [],
      progressCallback,
      config,
    });
  }
  return runIndexProjectImpl(request);
}

/** True when a worker post carries one of this runner's typed messages. */
function isWorkerMessage(msg: unknown): msg is RagWorkerOutbound {
  return !!msg && typeof msg === 'object' && 'type' in msg;
}

function awaitWorkerRun(
  request: RagWorkerRequest,
  workerPath: string,
): Promise<RAGIndexResult> {
  const { projectPath, paths, force, config, progressCallback, registerCancel } = request;
  const startData: RagWorkerStartData = {
    projectPath,
    force: force === true,
    paths,
    config,
    ...(request.op ? { op: request.op, rels: request.rels ?? [] } : undefined),
  };

  return new Promise<RAGIndexResult>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const worker = new Worker(workerPath, {
      workerData: startData,
      // Inherit env so native module resolution matches the main process
      env: process.env,
    });

    const workerIdleTimeoutMs = Math.max(
      1,
      ((config as Partial<Config> | undefined)?.background_command_idle_timeout ?? 900) * 1000,
    );
    let completion: Promise<void> | undefined;
    const finish = (
      result: RAGIndexResult | undefined,
      error: Error | undefined,
      cleanupTempFiles: boolean,
    ): Promise<void> => {
      if (completion) return completion;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      completion = (async () => {
        try {
          await worker.terminate();
        } catch {
          // The worker may have already exited after posting its result.
        }
        if (cleanupTempFiles) await removeInterruptedDownloadTemps(config);
        if (error) reject(error);
        else resolve(result!);
      })();
      return completion;
    };
    const armWatchdog = () => {
      if (settled) return;
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        void finish(
          undefined,
          new Error(`RAG index worker made no progress for ${workerIdleTimeoutMs}ms`),
          true,
        );
      }, workerIdleTimeoutMs);
    };
    const handleProgress = (progress: RAGIndexProgress) => {
      try {
        progressCallback?.(progress);
      } catch {
        // ignore
      }
    };
    registerCancel?.((reason) => finish(undefined, reason, true));
    armWatchdog();

    worker.on('message', (msg: unknown) => {
      if (!isWorkerMessage(msg)) return;
      armWatchdog();
      if (msg.type === 'progress') {
        handleProgress(msg.progress);
        return;
      }
      if (msg.type === 'result') {
        void finish(msg.result, undefined, false);
        return;
      }
      if (msg.type === 'error') {
        void finish(undefined, new Error(msg.error), true);
      }
    });

    worker.on('error', (err) => {
      void finish(undefined, err instanceof Error ? err : new Error(String(err)), true);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      void finish(
        undefined,
        new Error(`RAG index worker exited unexpectedly with code ${code}`),
        true,
      );
    });
  });
}

/** Best-effort cleanup of a model download the interrupted worker left behind. */
async function removeInterruptedDownloadTemps(config?: Config): Promise<void> {
  let modelName = (config as Partial<Config> | undefined)?.rag?.embedding_model;
  if (!modelName) {
    try {
      modelName = getConfig().rag.embedding_model;
    } catch {
      // A worker can start during early boot before global config exists.
    }
  }
  if (!modelName) return;
  try {
    await removeModelDownloadTemps(modelName);
  } catch {
    // Cleanup is best-effort; the index error remains the primary signal.
  }
}
