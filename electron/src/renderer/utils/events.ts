import type { ModelSelection } from '../../shared/types/provider';
import type { Config } from '../../shared/types/ipc-boundary';

export interface OrchidEventMap {
  'orchid:open-settings': { tab?: string } | undefined;
  'orchid:set-theme': { theme: string; persist?: boolean };
  'orchid:config-updated': Partial<Config>;
  'orchid:select-session': { id: string };
  'orchid:navigate': { section?: string };
  'orchid:providers-updated': undefined;
  'orchid:provider-selection-created': { selection: ModelSelection };
  'orchid:definitions-workspace-changed': undefined;
}

export function emitOrchidEvent<K extends keyof OrchidEventMap>(
  ...args: undefined extends OrchidEventMap[K]
    ? [name: K, detail?: OrchidEventMap[K]]
    : [name: K, detail: OrchidEventMap[K]]
): void {
  const [name, detail] = args;
  window.dispatchEvent(new CustomEvent(name, detail !== undefined ? { detail } : undefined));
}

export function onOrchidEvent<K extends keyof OrchidEventMap>(
  name: K,
  handler: (detail: OrchidEventMap[K]) => void,
): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<OrchidEventMap[K]>).detail);
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}
