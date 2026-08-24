/**
 * U5 — the authoritative IPC channel routing table.
 *
 * Pins the mechanical rule (host = HOST_METHODS ∩ ALLOWED_INVOKE_CHANNELS,
 * minus the two local-only capability channels), the local families that must
 * never route to a host, and the per-window active-machine resolution the
 * remote-machine UI (U8) builds on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/host/local-host', () => ({
  getLocalHostClient: (windowId: string) => ({ clientId: windowId, local: true }),
}));

import { HOST_METHODS, channelToMethod, methodToChannel } from '../../src/shared/host/protocol';
import {
  ALLOWED_INVOKE_CHANNELS,
  IPC_CHANNELS,
} from '../../src/shared/types/ipc';
import {
  LOCAL_MACHINE_ID,
  LOCAL_ONLY_HOST_CAPABILITY_CHANNELS,
  HOST_ROUTED_CHANNELS,
  activeMachineFor,
  clearActiveMachine,
  clientForWindow,
  getHostClient,
  isHostRoutedChannel,
  localInvokeChannels,
  registerHostClient,
  registeredMachines,
  setActiveMachine,
  unregisterHostClient,
  verifyRoutingTable,
} from '../../src/main/host/routing';
import { HostProtocolError } from '../../src/shared/host/protocol';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('routing table invariants', () => {
  it('classifies exactly (HOST_METHODS ∩ ALLOWED_INVOKE_CHANNELS) as host-routed', () => {
    const invocable = new Set<string>(ALLOWED_INVOKE_CHANNELS);
    const expected = new Set(
      Object.keys(HOST_METHODS)
        .map((method) => methodToChannel(method))
        .filter((channel) => invocable.has(channel)),
    );
    // Every host method channel that is invocable is routed — except the two
    // local-only capability channels, asserted separately below.
    for (const channel of expected) {
      if (LOCAL_ONLY_HOST_CAPABILITY_CHANNELS.has(channel)) continue;
      expect(isHostRoutedChannel(channel)).toBe(true);
    }
    for (const channel of HOST_ROUTED_CHANNELS) {
      expect(expected.has(channel)).toBe(true);
    }
    expect(HOST_ROUTED_CHANNELS.size).toBe(expected.size - LOCAL_ONLY_HOST_CAPABILITY_CHANNELS.size);
  });

  it('host-routed channels map 1:1 back to HOST_METHODS entries', () => {
    for (const channel of HOST_ROUTED_CHANNELS) {
      expect(Object.hasOwn(HOST_METHODS, channelToMethod(channel))).toBe(true);
    }
  });

  it('verifies without drifting (guard for future channel additions)', () => {
    expect(() => verifyRoutingTable()).not.toThrow();
  });

  it('keeps the native-dialog and shell-reveal channels local', () => {
    expect(LOCAL_ONLY_HOST_CAPABILITY_CHANNELS).toEqual(
      new Set([IPC_CHANNELS.SESSION_PICK_PROJECT_DIR, IPC_CHANNELS.DEFINITION_REVEAL]),
    );
    for (const channel of LOCAL_ONLY_HOST_CAPABILITY_CHANNELS) {
      expect(isHostRoutedChannel(channel)).toBe(false);
      expect(localInvokeChannels()).toContain(channel);
    }
  });

  it('keeps machine/analytics/updater/startup families local', () => {
    const localFamilies = ['machines:', 'analytics:', 'updater:', 'startup:'];
    for (const channel of ALLOWED_INVOKE_CHANNELS) {
      if (localFamilies.some((family) => channel.startsWith(family))) {
        expect(isHostRoutedChannel(channel)).toBe(false);
      }
    }
  });

  it('keeps provider vault writes and draft discovery local', () => {
    const vaultWrites = [
      IPC_CHANNELS.PROVIDERS_CREATE,
      IPC_CHANNELS.PROVIDERS_UPDATE,
      IPC_CHANNELS.PROVIDERS_SUBMIT_API_KEY,
      IPC_CHANNELS.PROVIDERS_DISCOVER_DRAFT_MODELS,
    ];
    for (const channel of vaultWrites) {
      expect(isHostRoutedChannel(channel)).toBe(false);
      expect(localInvokeChannels()).toContain(channel);
    }
  });

  it('keeps config-scope and index-state reads that have no host method local', () => {
    const localByDesign = [
      IPC_CHANNELS.CONFIG_PERMISSION_SCOPES,
      IPC_CHANNELS.CONFIG_SAVE_PERMISSION_SCOPE,
      IPC_CHANNELS.CONFIG_LIST_PERSONALITIES,
      IPC_CHANNELS.SESSION_GET_REASONING_CONFIG,
      IPC_CHANNELS.SESSION_GET_SERVICE_TIER_CONFIG,
      IPC_CHANNELS.RAG_INDEX_STATE,
      IPC_CHANNELS.AST_INDEX_STATE,
    ];
    for (const channel of localByDesign) {
      expect(isHostRoutedChannel(channel)).toBe(false);
    }
  });

  it('routes the chat/session/subagent/permission families through the host', () => {
    const routed = [
      IPC_CHANNELS.CHAT_SEND,
      IPC_CHANNELS.CHAT_COMPACT,
      IPC_CHANNELS.BG_CMD_SNAPSHOT,
      IPC_CHANNELS.SUBAGENTS_SNAPSHOT,
      IPC_CHANNELS.SESSION_OPEN,
      IPC_CHANNELS.SESSION_WORKING_SET_GET,
      IPC_CHANNELS.SESSION_ACTIVITY_LIST,
      IPC_CHANNELS.PROJECT_TRUST_SET,
      IPC_CHANNELS.PERMISSION_SNAPSHOT,
      IPC_CHANNELS.ASK_QUESTION_ANSWER,
      IPC_CHANNELS.TOOL_EXECUTE,
      IPC_CHANNELS.MCP_STATUS,
      IPC_CHANNELS.RAG_INDEX,
      IPC_CHANNELS.AST_STATUS,
      IPC_CHANNELS.CONFIG_GET,
      IPC_CHANNELS.PROVIDERS_LIST,
      IPC_CHANNELS.PROVIDERS_MODEL_LIST,
    ];
    for (const channel of routed) {
      expect(isHostRoutedChannel(channel)).toBe(true);
    }
  });

  it('never routes push-event channels (they are not invocable)', () => {
    const pushChannels = [
      IPC_CHANNELS.CHAT_CHUNK,
      IPC_CHANNELS.SESSION_UPDATED,
      IPC_CHANNELS.BG_CMD_CHANGED,
      IPC_CHANNELS.PERMISSION_APPROVAL_REQUESTED,
      IPC_CHANNELS.INDEX_AUTO_REFRESH,
    ];
    for (const channel of pushChannels) {
      expect(isHostRoutedChannel(channel)).toBe(false);
    }
  });
});

describe('per-window active machine', () => {
  beforeEach(() => {
    for (const machine of registeredMachines()) unregisterHostClient(machine);
    clearActiveMachine('7');
    clearActiveMachine('8');
  });

  it('defaults every window to the local machine', () => {
    expect(activeMachineFor('7')).toBe(LOCAL_MACHINE_ID);
  });

  it('resolves the local machine to its per-window client', () => {
    const client = clientForWindow('7') as unknown as { clientId: string; local: boolean };
    expect(client.local).toBe(true);
    expect(client.clientId).toBe('7');
  });

  it('switches a window to a registered machine and back', () => {
    const remote = { clientId: 'remote-a' };
    registerHostClient('remote-a', remote as never);
    expect(setActiveMachine('8', 'remote-a')).toBe(LOCAL_MACHINE_ID);
    expect(activeMachineFor('8')).toBe('remote-a');
    expect(clientForWindow('8')).toBe(remote);
    expect(setActiveMachine('8', LOCAL_MACHINE_ID)).toBe('remote-a');
    expect(activeMachineFor('8')).toBe(LOCAL_MACHINE_ID);
  });

  it('errors on an unknown machine id', () => {
    expect(() => getHostClient('remote-missing')).toThrow(HostProtocolError);
    expect(() => getHostClient('remote-missing')).toThrow(
      /No host client is registered for machine 'remote-missing'/,
    );
    setActiveMachine('7', 'remote-missing');
    expect(() => clientForWindow('7')).toThrow(HostProtocolError);
    clearActiveMachine('7');
  });

  it('lists and drops registered machines', () => {
    registerHostClient('remote-b', { clientId: 'remote-b' } as never);
    expect(registeredMachines()).toContain('remote-b');
    unregisterHostClient('remote-b');
    expect(registeredMachines()).not.toContain('remote-b');
  });
});

describe('hostRequest facade', () => {
  it('refuses to send a local-only channel through the host', async () => {
    const { hostRequest } = await import('../../src/main/host/routing');
    await expect(
      hostRequest('7', IPC_CHANNELS.MACHINES_LIST),
    ).rejects.toThrow(/not host-routed/);
  });
});
