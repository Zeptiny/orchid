import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkerPool } from '../utils/worker-pool';
import type { Config } from '../config/schema';

let pool: WorkerPool | null = null;

export async function initToolWorkerPool(config: Config, poolSize?: number): Promise<void> {
  const scriptPath = path.join(__dirname, '..', 'tools', 'tool-worker.js');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[tool-pool] Worker script not found, falling back to inline execution', { scriptPath });
    return;
  }
  const candidate = new WorkerPool(scriptPath, poolSize ?? 2, { config });
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
