import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkerPool } from '../utils/worker-pool';
import type { Config } from '../config/schema';

let pool: WorkerPool | null = null;

/**
 * Resolve the main-agent reservation from config. A configured 0 floors to 1:
 * the visible main agent always keeps a dispatch lane so queued subagent work
 * cannot starve it (review F-06). Positive reservations pass through (the
 * WorkerPool clamps them to `[0, size - 1]`).
 */
export function resolveMainAgentReserved(configured: number): number {
  return Math.max(1, configured);
}

export async function initToolWorkerPool(config: Config, poolSize?: number): Promise<void> {
  const scriptPath = path.join(__dirname, '..', 'tools', 'tool-worker.js');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[tool-pool] Worker script not found, falling back to inline execution', { scriptPath });
    return;
  }
  const candidate = new WorkerPool(scriptPath, poolSize ?? 2, { config }, {
    mainAgentReserved: resolveMainAgentReserved(config.tool_worker_pool_main_agent_reserved),
  });
  try {
    await candidate.init();
  } catch (err) {
    console.warn('[tool-pool] Worker pool init failed, falling back to inline execution', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  pool = candidate;
}

export function getToolWorkerPool(): WorkerPool | null {
  return pool;
}

export async function disposeToolWorkerPool(): Promise<void> {
  if (pool) {
    await pool.dispose();
    pool = null;
  }
}
