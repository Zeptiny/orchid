/**
 * Definitions IPC — list / save / delete / reveal for skills, agents, personalities.
 *
 * Disk layout:
 *   global:  ~/.orchid/{skills,agents,personalities}/
 *   project: <workspace>/.orchid/{skills,agents,personalities}/
 */
import { ipcMain, shell } from 'electron';
import type { z } from 'zod';
import { IPC_CHANNELS } from '../../shared/types/ipc';
import { MACHINE_ID_LOCAL } from '../../shared/types/machine';
import {
  HOST_CAPABILITIES,
  HOST_ERROR_CODES,
  HostProtocolError,
} from '../../shared/host/protocol';
import { hostRequest } from './host-request';
import { activeMachineFor } from '../host/routing';
import {
  agentSaveSchema,
  definitionDeleteSchema,
  definitionRevealSchema,
  personalitySaveSchema,
  sharedPromptDeleteSchema,
  sharedPromptSaveSchema,
  skillSaveSchema,
} from '../../shared/types/ipc-schemas';
import { assertPathUnderOrchidRoots } from '../defs/paths';
import { resolveBoundProjectPath } from './session';

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
    withDefinitionMutation(definitionDeleteSchema, IPC_CHANNELS.SKILL_DELETE, 'skill:delete'),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_SAVE,
    withDefinitionMutation(agentSaveSchema, IPC_CHANNELS.AGENT_SAVE, 'agent:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.AGENT_DELETE,
    withDefinitionMutation(definitionDeleteSchema, IPC_CHANNELS.AGENT_DELETE, 'agent:delete'),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SAVE,
    withDefinitionMutation(personalitySaveSchema, IPC_CHANNELS.PERSONALITY_SAVE, 'personality:save'),
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_DELETE,
    withDefinitionMutation(definitionDeleteSchema, IPC_CHANNELS.PERSONALITY_DELETE, 'personality:delete'),
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
    const parsed = definitionRevealSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid definition:reveal payload: ${parsed.error.message}`);
    }
    // Fix #30: on a remote-active window the listed definition paths live on
    // another machine's filesystem; a local shell reveal would fail with a
    // misleading "path is outside Orchid definition directories" error.
    // Degrade with the same typed UNSUPPORTED_ON_HOST error the protocol's
    // capability gate produces for a host that never declares
    // 'definitions.reveal' (the daemon never does).
    if (activeMachineFor(String(event.sender.id)) !== MACHINE_ID_LOCAL) {
      throw new HostProtocolError(
        HOST_ERROR_CODES.UNSUPPORTED_ON_HOST,
        `Method 'definition.reveal' requires the '${HOST_CAPABILITIES.DEFINITIONS_REVEAL}' capability, which this host does not declare`,
      );
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
