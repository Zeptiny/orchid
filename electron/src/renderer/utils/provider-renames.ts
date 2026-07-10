import type { ProviderRename } from '../../shared/types/ipc';

export type { ProviderRename } from '../../shared/types/ipc';

export function mergeProviderRename(
  renames: ProviderRename[],
  from: string,
  to: string,
): ProviderRename[] {
  const prior = renames.find((rename) => rename.to === from);
  if (!prior) return [...renames, { from, to }];
  const remaining = renames.filter((rename) => rename !== prior);
  return prior.from === to ? remaining : [...remaining, { from: prior.from, to }];
}

export function activeProviderRenames(
  renames: ProviderRename[],
  providersUpdate: unknown,
): ProviderRename[] {
  if (
    typeof providersUpdate !== 'object' ||
    providersUpdate === null ||
    Array.isArray(providersUpdate)
  ) {
    return [];
  }
  const providers = providersUpdate as Record<string, unknown>;
  return renames.filter((rename) => providers[rename.to] != null);
}
