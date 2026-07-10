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
import { toolRegistry } from '../tools';
import { resolveWindowWorkspace } from './session';
import { isWorkspaceBound } from '../project/workspace';

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
  const windowId = String(event.sender.id);
  const workspace = resolveWindowWorkspace(windowId);
  if (isWorkspaceBound(workspace) && workspace.cwd) {
    return workspace.cwd;
  }
  return null;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDefinitionsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.DEFINITIONS_LIST, async (event) => {
    const projectDir = projectDirFromEvent(event);
    const skills = listManagedSkills(projectDir);
    const availableTools = toolRegistry
      .listAll()
      .map((t) => t.definition.name)
      .sort((a, b) => a.localeCompare(b));
    // Unique skill names across scopes (prefer name as listed)
    const skillNames = new Set(skills.map((s) => s.name));
    return {
      projectDir,
      skills,
      agents: listManagedAgents(projectDir),
      personalities: listManagedPersonalities(projectDir),
      availableTools,
      availableSkills: Array.from(skillNames).sort((a, b) => a.localeCompare(b)),
    };
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_SAVE, async (event, payload: unknown) => {
    const parsed = skillSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid skill:save payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    const saved = saveSkill(parsed.data, projectDir);
    reloadDefinitionRegistries(projectDir);
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_DELETE, async (event, payload: unknown) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid skill:delete payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    deleteSkill(parsed.data.scope, parsed.data.name, projectDir);
    reloadDefinitionRegistries(projectDir);
    return { status: 'deleted' as const };
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SAVE, async (event, payload: unknown) => {
    const parsed = agentSaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid agent:save payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    const saved = saveAgent(parsed.data, projectDir);
    reloadDefinitionRegistries(projectDir);
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_DELETE, async (event, payload: unknown) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid agent:delete payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    deleteAgent(parsed.data.scope, parsed.data.name, projectDir);
    reloadDefinitionRegistries(projectDir);
    return { status: 'deleted' as const };
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_SAVE, async (event, payload: unknown) => {
    const parsed = personalitySaveSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid personality:save payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    const saved = savePersonality(parsed.data, projectDir);
    reloadDefinitionRegistries(projectDir);
    return saved;
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_DELETE, async (event, payload: unknown) => {
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid personality:delete payload: ${parsed.error.message}`);
    }
    const projectDir = projectDirFromEvent(event);
    deletePersonality(parsed.data.scope, parsed.data.name, projectDir);
    reloadDefinitionRegistries(projectDir);
    return { status: 'deleted' as const };
  });

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
