/**
 * Definitions IPC — list / save / delete / reveal for skills, agents, personalities.
 *
 * Disk layout:
 *   global:  ~/.orchid/{skills,agents,personalities}/
 *   project: <workspace>/.orchid/{skills,agents,personalities}/
 */
import { ipcMain, shell } from 'electron';
import { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { AgentTier, AgentType } from '../../shared/types/agent';
import {
  deleteAgent,
  deletePersonality,
  deleteSkill,
  listManagedAgents,
  listManagedPersonalities,
  listManagedSkills,
  saveAgent,
  savePersonality,
  saveSkill,
} from '../defs/manage';
import { assertPathUnderOrchidRoots } from '../defs/paths';
import { reloadDefinitionRegistries } from '../defs/reload';
import { getProjectMCPManager } from '../mcp/project-registry';
import { getProjectRuntimeRegistry } from '../project/runtime';
import { getProjectTrustState } from '../project/trust';
import { toolRegistry } from '../tools';
import { resolveBoundProjectPath } from './session';

// ── Schemas ──────────────────────────────────────────────────────────────────

const scopeSchema = z.enum(['global', 'project']);
const nameSchema = z.string().min(1).max(128);

const skillSaveSchema = z.object({
  scope: scopeSchema,
  name: nameSchema,
  description: z.string().min(1),
  requires: z.array(z.string()).optional(),
  content: z.string(),
  previousName: z.string().optional(),
});

const agentSaveSchema = z.object({
  scope: scopeSchema,
  name: nameSchema,
  type: z.enum([AgentType.INTERNAL, AgentType.SUBAGENT]),
  tier: z.enum([
    AgentTier.SEED,
    AgentTier.SPROUT,
    AgentTier.BLOOM,
    AgentTier.CROWN,
  ]),
  description: z.string().min(1),
  system_prompt: z.string(),
  allowed_tools: z.array(z.string()).min(1),
  allowed_skills: z.array(z.string()),
  previousName: z.string().optional(),
});

const personalitySaveSchema = z.object({
  scope: scopeSchema,
  name: nameSchema,
  content: z.string().min(1),
  previousName: z.string().optional(),
});

const deleteSchema = z.object({
  scope: scopeSchema,
  name: nameSchema,
});

const revealSchema = z.object({
  path: z.string().min(1),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function projectDirFromEvent(event: Electron.IpcMainInvokeEvent): string | null {
  return resolveBoundProjectPath(String(event.sender.id));
}

/**
 * Validate payload, resolve project dir, run mutation, reload registries.
 * Shared by skill/agent/personality save and delete handlers.
 */
function withDefinitionMutation<TSchema extends z.ZodTypeAny, TResult>(
  schema: TSchema,
  channelLabel: string,
  mutate: (data: z.infer<TSchema>, projectDir: string | null) => TResult,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => TResult {
  return (event, payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid ${channelLabel} payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    const result = mutate(parsed.data, projectDir);
    reloadDefinitionRegistries(projectDir);
    return result;
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDefinitionsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.DEFINITIONS_LIST, async (event) => {
    const projectDir = projectDirFromEvent(event);
    // Untrusted projects list home-only definitions (no project overlay).
    const listProjectDir =
      projectDir != null && getProjectTrustState(projectDir) === 'trusted'
        ? projectDir
        : null;
    const skills = listManagedSkills(listProjectDir);
    const builtinTools = toolRegistry
      .listAll()
      .map((t) => t.definition.name);

    // MCP tools are not registered in the process-global singleton — they
    // belong to per-project managers. Resolve the sender's project so the
    // agent allowed-tools picker can list mcp::server::tool entries.
    const mcpToolNames: string[] = [];
    if (projectDir != null) {
      try {
        const runtime = getProjectRuntimeRegistry().get(projectDir);
        const mcpStatus = getProjectMCPManager(runtime).getStatus();
        for (const server of mcpStatus) {
          for (const toolName of server.tools) {
            mcpToolNames.push(`mcp::${server.name}::${toolName}`);
          }
        }
      } catch {
        // Project not trusted or MCP not started — no MCP tools to list.
      }
    }

    const availableTools = [...builtinTools, ...mcpToolNames].sort((a, b) =>
      a.localeCompare(b),
    );
    // Unique skill names across scopes (prefer name as listed)
    const skillNames = new Set(skills.map((s) => s.name));
    return {
      projectDir,
      skills,
      agents: listManagedAgents(listProjectDir),
      personalities: listManagedPersonalities(listProjectDir),
      availableTools,
      availableSkills: Array.from(skillNames).sort((a, b) => a.localeCompare(b)),
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILL_SAVE,
    withDefinitionMutation(skillSaveSchema, 'skill:save', (data, projectDir) =>
      saveSkill(data, projectDir),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_DELETE,
    withDefinitionMutation(deleteSchema, 'skill:delete', (data, projectDir) => {
      deleteSkill(data.scope, data.name, projectDir);
      return { status: 'deleted' as const };
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SAVE,
    withDefinitionMutation(agentSaveSchema, 'agent:save', (data, projectDir) =>
      saveAgent(data, projectDir),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DELETE,
    withDefinitionMutation(deleteSchema, 'agent:delete', (data, projectDir) => {
      deleteAgent(data.scope, data.name, projectDir);
      return { status: 'deleted' as const };
    }),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SAVE,
    withDefinitionMutation(
      personalitySaveSchema,
      'personality:save',
      (data, projectDir) => savePersonality(data, projectDir),
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_DELETE,
    withDefinitionMutation(
      deleteSchema,
      'personality:delete',
      (data, projectDir) => {
        deletePersonality(data.scope, data.name, projectDir);
        return { status: 'deleted' as const };
      },
    ),
  );

  ipcMain.handle(IPC_CHANNELS.DEFINITION_REVEAL, async (event, payload: unknown) => {
    const parsed = revealSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid definition:reveal payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    const safePath = assertPathUnderOrchidRoots(parsed.data.path, projectDir);
    shell.showItemInFolder(safePath);
    return { status: 'ok' as const };
  });
}

export function unregisterDefinitionsIPC(): void {
  ipcMain.removeHandler(IPC_CHANNELS.DEFINITIONS_LIST);
  ipcMain.removeHandler(IPC_CHANNELS.SKILL_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.SKILL_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.AGENT_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.AGENT_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.PERSONALITY_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.PERSONALITY_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.DEFINITION_REVEAL);
}
