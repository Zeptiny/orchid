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
import { hostRequest } from './host-request';
import { assertPathUnderOrchidRoots } from '../defs/paths';
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

const sharedPromptSaveSchema = z.object({
  scope: scopeSchema,
  slot: z.enum(['all-agents', 'subagents']),
  content: z.string(),
});

const sharedPromptDeleteSchema = z.object({
  scope: scopeSchema,
  slot: z.enum(['all-agents', 'subagents']),
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
 * Validate the payload and forward to the host method with the same name; the
 * server binding resolves the caller's project dir, performs the mutation and
 * reloads the registries.
 */
function withDefinitionMutation<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  channel: string,
  channelLabel: string,
): (event: Electron.IpcMainInvokeEvent, payload: unknown) => Promise<unknown> {
  return (event, payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid ${channelLabel} payload: ${parsed.error.message}`);
    }
    return hostRequest(String(event.sender.id), channel, parsed.data);
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDefinitionsIPC(): void {
  ipcMain.handle(IPC_CHANNELS.DEFINITIONS_LIST, async (event) => {
    return hostRequest(String(event.sender.id), IPC_CHANNELS.DEFINITIONS_LIST);
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILL_SAVE,
    withDefinitionMutation(skillSaveSchema, IPC_CHANNELS.SKILL_SAVE, 'skill:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_DELETE,
    withDefinitionMutation(deleteSchema, IPC_CHANNELS.SKILL_DELETE, 'skill:delete'),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SAVE,
    withDefinitionMutation(agentSaveSchema, IPC_CHANNELS.AGENT_SAVE, 'agent:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DELETE,
    withDefinitionMutation(deleteSchema, IPC_CHANNELS.AGENT_DELETE, 'agent:delete'),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SAVE,
    withDefinitionMutation(personalitySaveSchema, IPC_CHANNELS.PERSONALITY_SAVE, 'personality:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_DELETE,
    withDefinitionMutation(deleteSchema, IPC_CHANNELS.PERSONALITY_DELETE, 'personality:delete'),
  );

  ipcMain.handle(
    IPC_CHANNELS.SHARED_PROMPT_SAVE,
    withDefinitionMutation(sharedPromptSaveSchema, IPC_CHANNELS.SHARED_PROMPT_SAVE, 'shared-prompt:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.SHARED_PROMPT_DELETE,
    withDefinitionMutation(sharedPromptDeleteSchema, IPC_CHANNELS.SHARED_PROMPT_DELETE, 'shared-prompt:delete'),
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
  ipcMain.removeHandler(IPC_CHANNELS.SHARED_PROMPT_SAVE);
  ipcMain.removeHandler(IPC_CHANNELS.SHARED_PROMPT_DELETE);
  ipcMain.removeHandler(IPC_CHANNELS.DEFINITION_REVEAL);
}
