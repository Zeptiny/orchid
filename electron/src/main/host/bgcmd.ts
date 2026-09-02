/**
 * Background-command surface core — the bgcmd:* implementation behind both
 * the Electron IPC boundary (ipc/chat.ts) and the host protocol
 * (host/server.ts).
 *
 * Session-privileged visibility: every operation resolves the caller's active
 * session (explicit `sessionId` param wins) and only reaches commands owned
 * by that session, regardless of which agent scope spawned them.
 */
import { getSubagentManager } from '../tools';
import {
  getBackgroundStore,
} from '../tools/process/background-store';
import { getForegroundLiveRegistry } from '../tools/process/foreground-live';
import { getSessionManager } from '../session/singleton';

/**
 * Payload-then-active-session convention shared by every bgcmd op: an
 * explicit sessionId wins, else the calling client's active session.
 */
export function resolveBgCommandSessionId(
  requestedSessionId: string | undefined,
  clientId: string,
): string | null {
  return requestedSessionId
    ?? getSessionManager().getActive(clientId)?.id
    ?? null;
}

export interface BgCommandSnapshotParams {
  commandId?: number;
  toolCallId?: string;
  lastN?: number;
  sessionId?: string;
  includeTail?: boolean;
}

export function bgCommandSnapshot(
  params: BgCommandSnapshotParams,
  clientId: string,
) {
  const sessionId = resolveBgCommandSessionId(params.sessionId, clientId);
  if (!sessionId) return { found: false };
  const includeTailEffective = params.includeTail !== false;
  const lines = params.lastN ?? 50;
  if (params.commandId !== undefined) {
    // Session-privileged visibility: any agent scope within the session.
    const entry = getBackgroundStore().get(params.commandId);
    if (!entry || entry.sessionId !== sessionId) return { found: false };
    return {
      found: true,
      tail: includeTailEffective ? entry.buffer.getTail(lines) : '',
      exitCode: entry.exitCode,
      running: entry.exitCode === null,
      interactive: entry.interactive,
      owner: entry.owner,
      command: entry.command,
      description: entry.description || undefined,
      agentScopeId: entry.agentScopeId,
      createdAt: entry.createdAt,
    };
  }
  const liveEntry = getForegroundLiveRegistry().get(params.toolCallId!);
  if (!liveEntry || liveEntry.sessionId !== sessionId) return { found: false };
  const tail = includeTailEffective
    ? getForegroundLiveRegistry().snapshotForSession(params.toolCallId!, lines, sessionId)?.tail ?? ''
    : '';
  return {
    found: true,
    tail,
    exitCode: liveEntry.exitCode,
    running: liveEntry.exitCode === null,
    interactive: false,
    owner: 'AGENT',
    command: liveEntry.command,
    description: liveEntry.command,
    agentScopeId: liveEntry.agentScopeId,
    createdAt: liveEntry.startedAt,
  };
}

export function bgCommandList(
  params: { sessionId?: string },
  clientId: string,
) {
  const sessionId = resolveBgCommandSessionId(params.sessionId, clientId);
  if (!sessionId) return [];
  const scopeNames = new Map<string, string>();
  for (const state of getSubagentManager().getStates(sessionId)) {
    scopeNames.set(state.id, state.name);
  }
  const items = getBackgroundStore()
    .list()
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => ({
      id: entry.id,
      command: entry.command,
      description: entry.description,
      interactive: entry.interactive,
      owner: entry.owner,
      agentScopeId: entry.agentScopeId,
      scopeName: entry.agentScopeId === 'main'
        ? 'main'
        : scopeNames.get(entry.agentScopeId) ?? entry.agentScopeId,
      running: entry.exitCode === null,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
      lastOutputAt: entry.lastOutputAt,
    }));
  // Running commands first, newest first within each group.
  items.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  return items;
}

export async function bgCommandSendInput(
  params: { commandId: number; text: string; sessionId?: string },
  clientId: string,
) {
  const sessionId = resolveBgCommandSessionId(params.sessionId, clientId);
  if (!sessionId) return { ok: false, reason: 'not_found' };
  const store = getBackgroundStore();
  // Session-privileged: any agent scope within the session is reachable.
  const entry = store.get(params.commandId);
  if (!entry || entry.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
  if (!entry.interactive) return { ok: false, reason: 'not_interactive' };
  if (entry.exitCode !== null) return { ok: false, reason: 'exited' };
  // TOCTOU fix: take ownership before the async write so an agent send_input
  // cannot interleave between the write and the flip. Roll back on failure.
  const prevOwner = entry.owner;
  const prevLastUserInputAt = entry.lastUserInputAt;
  const took = store.takeOwnership(params.commandId);
  if (!took) return { ok: false, reason: 'not_found' };
  let sent: boolean;
  try {
    sent = await store.send(params.commandId, params.text);
  } catch {
    sent = false;
  }
  if (!sent) {
    const current = store.get(params.commandId);
    if (current) {
      current.owner = prevOwner;
      current.lastUserInputAt = prevLastUserInputAt;
    }
    return { ok: false, reason: 'write_failed' };
  }
  return { ok: true };
}

export function bgCommandTerminate(
  params: { commandId: number; sessionId?: string },
  clientId: string,
) {
  const sessionId = resolveBgCommandSessionId(params.sessionId, clientId);
  if (!sessionId) return { ok: false, reason: 'not_found' };
  const entry = getBackgroundStore().get(params.commandId);
  if (!entry || entry.sessionId !== sessionId) return { ok: false, reason: 'not_found' };
  getBackgroundStore().terminate(params.commandId);
  return { ok: true };
}

export function bgCommandReleaseInput(
  params: { commandId: number; sessionId?: string },
  clientId: string,
) {
  const sessionId = resolveBgCommandSessionId(params.sessionId, clientId);
  if (!sessionId) return { ok: false };
  const entry = getBackgroundStore().get(params.commandId);
  if (!entry || entry.sessionId !== sessionId) return { ok: false };
  return { ok: getBackgroundStore().releaseOwnership(params.commandId) };
}
