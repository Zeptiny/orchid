import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkerPool } from '../utils/worker-pool';
import type { Config } from '../config/schema';
import type { ToolWorkerPoolStartupResult } from '../startup-lifecycle';

let pool: WorkerPool | null = null;
let initializingPool: WorkerPool | null = null;
let initialization: Promise<ToolWorkerPoolStartupResult> | null = null;
const disposals = new WeakMap<WorkerPool, Promise<void>>();

function disposeOnce(candidate: WorkerPool): Promise<void> {
  const existing = disposals.get(candidate);
  if (existing) return existing;
  const disposal = candidate.dispose();
  disposals.set(candidate, disposal);
  return disposal;
}

/**
 * Resolve the main-agent reservation from config. A configured 0 floors to 1:
 * the visible main agent always keeps a dispatch lane so queued subagent work
 * cannot starve it (review F-06). Positive reservations pass through (the
 * WorkerPool clamps them to `[0, size - 1]`).
 */
export function resolveMainAgentReserved(configured: number): number {
  return Math.max(1, configured);
}

export async function initToolWorkerPool(
  config: Config,
  poolSize?: number,
): Promise<ToolWorkerPoolStartupResult> {
  const size = poolSize ?? config.tool_worker_pool_size;
  if (size <= 0) return { status: 'disabled' };
  if (pool) return { status: 'ready' };
  if (initialization) return initialization;

  const scriptPath = path.join(__dirname, '..', 'tools', 'tool-worker.js');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[tool-pool] Worker script not found, falling back to inline execution', { scriptPath });
    return { status: 'unavailable' };
  }
  const candidate = new WorkerPool(scriptPath, size, { config }, {
    mainAgentReserved: resolveMainAgentReserved(config.tool_worker_pool_main_agent_reserved),
  });
  initializingPool = candidate;
  const attempt = (async (): Promise<ToolWorkerPoolStartupResult> => {
    try {
      await candidate.init();
      // Shutdown may have disposed the candidate while initialization settled.
      if (initializingPool !== candidate) {
        await disposeOnce(candidate);
        return { status: 'unavailable' };
      }
      pool = candidate;
      return { status: 'ready' };
    } catch (err) {
      console.warn('[tool-pool] Worker pool init failed, falling back to inline execution', {
        error: err instanceof Error ? err.message : String(err),
      });
      await disposeOnce(candidate);
      return { status: 'unavailable' };
    } finally {
      if (initializingPool === candidate) initializingPool = null;
      initialization = null;
    }
  })();
  initialization = attempt;
  return attempt;
}

export function getToolWorkerPool(): WorkerPool | null {
  return pool;
}

export async function disposeToolWorkerPool(): Promise<void> {
  const candidates = new Set<WorkerPool>();
  if (pool) candidates.add(pool);
  if (initializingPool) candidates.add(initializingPool);
  pool = null;
  initializingPool = null;
  await Promise.all([...candidates].map(disposeOnce));
}
