/**
 * RAG index progress plumbing — the callback contract, the zeroed payloads,
 * and the run-clock emitter shared by the pipeline stages and the worker.
 */
import type { RAGIndexProgress } from '../../shared/types/ipc-boundary';

export type RAGIndexProgressCallback = (progress: RAGIndexProgress) => void;

/** A progress update whose elapsed field is filled in by the emitter. */
export type RAGIndexProgressUpdate = Omit<RAGIndexProgress, 'elapsedSeconds'> & {
  elapsedSeconds?: number;
};

/** Reports one progress update to the run's sink. */
export type EmitIndexProgress = (update: RAGIndexProgressUpdate) => void;

/** The counter fields of a progress payload. */
export type ProgressCounters = Pick<
  RAGIndexProgress,
  'filesIndexed' | 'filesSkipped' | 'chunksCreated' | 'filesDeleted'
>;

/** Progress snapshot recorded before a run reports anything of its own. */
export function initialIndexProgress(): RAGIndexProgress {
  return {
    phase: 'discovering',
    done: 0,
    total: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
    elapsedSeconds: 0,
  };
}

/** Counter fields zeroed — phases where nothing has been processed yet. */
export function zeroedCounters(): ProgressCounters {
  return { filesIndexed: 0, filesSkipped: 0, chunksCreated: 0, filesDeleted: 0 };
}

/**
 * Bind a progress callback to a run clock. A missing callback makes every
 * emit a no-op (the clock is never read); a throwing callback never breaks
 * the run.
 */
export function createProgressEmitter(
  callback: RAGIndexProgressCallback | undefined,
  elapsedSeconds: () => number,
): EmitIndexProgress {
  return (update) => {
    if (!callback) return;
    try {
      callback({ ...update, elapsedSeconds: update.elapsedSeconds ?? elapsedSeconds() });
    } catch {
      // ignore callback errors
    }
  };
}

/** Start a run clock; the returned reader is wall time in seconds. */
export function startRunClock(): () => number {
  const startedAt = Date.now();
  return () => (Date.now() - startedAt) / 1000;
}
