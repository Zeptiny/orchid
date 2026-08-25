/**
 * Definitions family bindings — listing plus CRUD for skills, agents,
 * personalities, and shared prompts. Every mutation reloads the definition
 * registries for the client's bound project scope afterwards.
 */
import { HOST_CAPABILITIES } from '../../../shared/host/protocol';
import { resolveBoundProjectPath } from '../../session/singleton';
import {
  deleteAgent,
  deletePersonality,
  deleteSharedPrompt,
  deleteSkill,
  saveAgent,
  savePersonality,
  saveSharedPrompt,
  saveSkill,
} from '../../defs/manage';
import { listDefinitions } from '../../defs/listing';
import { reloadDefinitionRegistries } from '../../defs/reload';
import type {
  HostBinding,
  HostBindingEntries,
  HostRequestContext,
  HostServerSurface,
} from './types';

export function buildDefinitionBindings(surface: HostServerSurface): HostBindingEntries {
  const entries: Array<[string, HostBinding<never>]> = [];

  const bind = <P>(method: string, binding: HostBinding<P>): void => {
    entries.push([method, binding as HostBinding<never>]);
  };

  bind('definitions.list', (ctx) => listDefinitions(resolveBoundProjectPath(ctx.clientId)));

  const withDefinitionMutation = <T>(ctx: HostRequestContext, mutate: (projectDir: string | null) => T): T => {
    const projectDir = resolveBoundProjectPath(ctx.clientId);
    const result = mutate(projectDir);
    reloadDefinitionRegistries(projectDir);
    return result;
  };

  bind('skill.save', (ctx, params: Parameters<typeof saveSkill>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveSkill(params, projectDir)));
  bind('skill.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteSkill(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('agent.save', (ctx, params: Parameters<typeof saveAgent>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveAgent(params, projectDir)));
  bind('agent.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteAgent(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('personality.save', (ctx, params: Parameters<typeof savePersonality>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => savePersonality(params, projectDir)));
  bind('personality.delete', (ctx, params: { scope: 'global' | 'project'; name: string }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deletePersonality(params.scope, params.name, projectDir);
      return { status: 'deleted' as const };
    }));
  bind('shared_prompt.save', (ctx, params: Parameters<typeof saveSharedPrompt>[0]) =>
    withDefinitionMutation(ctx, (projectDir) => saveSharedPrompt(params, projectDir)));
  bind('shared_prompt.delete', (ctx, params: { scope: 'global' | 'project'; slot: 'all-agents' | 'subagents' }) =>
    withDefinitionMutation(ctx, (projectDir) => {
      deleteSharedPrompt(params.scope, params.slot, projectDir);
      return { status: 'deleted' as const };
    }));

  bind('definition.reveal', (_ctx) => {
    surface.requireCapability(HOST_CAPABILITIES.DEFINITIONS_REVEAL, 'definition.reveal');
    // Capability declared only by the Electron host (shell.showItemInFolder);
    // the headless daemon never declares it.
    throw new Error('definition.reveal requires a host-native shell transport.');
  });

  return entries;
}
