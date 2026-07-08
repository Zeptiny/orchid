/**
 * Agent IPC handlers — agent:list, agent:spawn.
 *
 * Wraps agent registry and SubagentManager from U10.
 */
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { listAgents, getAgent } from '../agents/registry';
import { getConfig } from '../config/loader';

// ── Zod validation schemas ───────────────────────────────────────────────────

const agentSpawnSchema = z.object({
  name: z.string().min(1),
  task: z.string().min(1),
  tier: z.string().optional(),
});

// ── IPC registration ─────────────────────────────────────────────────────────

export function registerAgentIPC(): void {
  // agent:list — return all loaded agents
  ipcMain.handle(IPC_CHANNELS.AGENT_LIST, async () => {
    return listAgents();
  });

  // agent:spawn — spawn a new subagent
  ipcMain.handle(IPC_CHANNELS.AGENT_SPAWN, async (_event, payload: unknown) => {
    const parsed = agentSpawnSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid agent:spawn payload: ${parsed.error.message}`);
    }

    const { name, task, tier } = parsed.data;

    // Look up the agent by name
    const agent = getAgent(name);
    if (!agent) {
      throw new Error(`Agent '${name}' not found`);
    }

    // Generate a unique ID for this subagent
    const id = `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Note: Full subagent lifecycle management (XState actors, streaming)
    // is handled by the session machine and SubagentManager.
    // This IPC handler returns the spawn request info; the actual actor
    // creation happens in the session context.

    return {
      id,
      agent: {
        ...agent,
        // Apply tier override if specified
        tier: tier ?? agent.tier,
      },
    };
  });
}

/**
 * Unregister agent IPC handlers (for cleanup/testing).
 */
export function unregisterAgentIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.AGENT_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.AGENT_SPAWN);
}
