import { randomUUID } from 'node:crypto';
import type { ProjectRuntime } from '../project/runtime';

/** Frozen parent-turn affinity required only while a run can execute. */
export interface SubagentExecutionSeed {
  readonly windowId: string | null;
  readonly cwd: string | null;
  readonly projectRuntime?: ProjectRuntime;
}

/** One generation of a subagent's runtime-only execution ownership. */
export interface SubagentRun {
  readonly subagentId: string;
  readonly generation: number;
  readonly runId: string;
  readonly abortController: AbortController | null;
  readonly promise: Promise<void> | null;
}

interface MutableSubagentRun {
  readonly subagentId: string;
  readonly generation: number;
  readonly runId: string;
  abortController: AbortController | null;
  promise: Promise<void> | null;
  seed: SubagentExecutionSeed;
}

/**
 * Owns one current execution generation per durable subagent record.
 *
 * A generation remains addressable after it settles so follow-up runs can
 * allocate the next monotonically increasing number. Every mutating method
 * accepts the captured generation and refuses stale callers.
 */
export class SubagentRunRegistry {
  private readonly runs = new Map<string, MutableSubagentRun>();

  register(subagentId: string, generation: number = 1, seed: SubagentExecutionSeed = emptySeed()): SubagentRun {
    const existing = this.runs.get(subagentId);
    if (existing) return existing;
    const run = this.createRun(subagentId, generation, seed);
    this.runs.set(subagentId, run);
    return run;
  }

  reset(subagentId: string, generation: number = 1, seed: SubagentExecutionSeed = emptySeed()): SubagentRun {
    const run = this.createRun(subagentId, generation, seed);
    this.runs.set(subagentId, run);
    return run;
  }

  beginNext(subagentId: string): SubagentRun {
    const current = this.runs.get(subagentId);
    const run = this.createRun(subagentId, (current?.generation ?? 0) + 1, current?.seed ?? emptySeed());
    this.runs.set(subagentId, run);
    return run;
  }

  start(subagentId: string): SubagentRun {
    const run = this.runs.get(subagentId) ?? this.createRun(subagentId, 1, emptySeed());
    this.runs.set(subagentId, run);
    run.abortController ??= new AbortController();
    return run;
  }

  attachPromise(run: SubagentRun, promise: Promise<void>): boolean {
    if (!this.isCurrent(run)) return false;
    this.runs.get(run.subagentId)!.promise = promise;
    return true;
  }

  abortCurrent(subagentId: string): boolean {
    const run = this.runs.get(subagentId);
    return run ? this.abort(run) : false;
  }

  abort(run: SubagentRun): boolean {
    if (!this.isCurrent(run)) return false;
    const current = this.runs.get(run.subagentId)!;
    if (!current.abortController) return false;
    current.abortController.abort();
    return true;
  }

  settle(run: SubagentRun): boolean {
    if (!this.isCurrent(run)) return false;
    const current = this.runs.get(run.subagentId)!;
    current.abortController = null;
    current.promise = null;
    return true;
  }

  isCurrent(run: SubagentRun): boolean {
    const current = this.runs.get(run.subagentId);
    return current?.generation === run.generation && current.runId === run.runId;
  }

  isSettling(subagentId: string): boolean {
    return this.runs.get(subagentId)?.promise !== null;
  }

  getPromise(subagentId: string): Promise<void> | null {
    return this.runs.get(subagentId)?.promise ?? null;
  }

  getGeneration(subagentId: string): number | undefined {
    return this.runs.get(subagentId)?.generation;
  }

  getRunId(subagentId: string): string | undefined {
    return this.runs.get(subagentId)?.runId;
  }

  getSeed(subagentId: string): SubagentExecutionSeed | undefined {
    return this.runs.get(subagentId)?.seed;
  }

  /** Drop heavyweight execution affinity while retaining generation ownership. */
  releaseSeed(subagentId: string): void {
    const run = this.runs.get(subagentId);
    if (run) run.seed = emptySeed();
  }

  remove(subagentId: string): void {
    this.runs.delete(subagentId);
  }

  private createRun(
    subagentId: string,
    generation: number,
    seed: SubagentExecutionSeed,
  ): MutableSubagentRun {
    return {
      subagentId,
      generation,
      runId: randomUUID(),
      abortController: null,
      promise: null,
      seed,
    };
  }
}

function emptySeed(): SubagentExecutionSeed {
  return { windowId: null, cwd: null };
}
