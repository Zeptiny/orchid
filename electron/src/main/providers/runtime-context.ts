/**
 * Provider main-process runtime handles — catalog, vault, connections, status.
 *
 * Lives outside main/index so IPC and other main modules can resolve services
 * without importing the app entry (which would create a circular dependency).
 * main/index is responsible for initialize + reset.
 */
import type { ProviderCatalogStore } from './catalog/store';
import type { ConnectionStore } from './connection-store';
import type { CredentialVault } from './credentials/vault';
import type { ProviderStatusService } from './status/service';
import {
  createDefaultProviderDriverRegistry,
  type ProviderDriverRegistry,
} from './drivers/registry';

let providerCatalogStore: ProviderCatalogStore | null = null;
let providerCredentialVault: CredentialVault | null = null;
let providerConnectionStore: ConnectionStore | null = null;
let providerStatusService: ProviderStatusService | null = null;
let providerDriverRegistry: ProviderDriverRegistry | null = null;

export function setProviderCatalogStore(store: ProviderCatalogStore | null): void {
  providerCatalogStore = store;
}

/** Main-process access for provider IPC and driver registry work. */
export function getProviderCatalogStore(): ProviderCatalogStore {
  if (!providerCatalogStore) {
    throw new Error('Provider catalog has not been initialized');
  }
  return providerCatalogStore;
}

export function setProviderCredentialVault(vault: CredentialVault | null): void {
  providerCredentialVault = vault;
}

/** Main-process credential access for trusted drivers only. */
export function getProviderCredentialVault(): CredentialVault {
  if (!providerCredentialVault) {
    throw new Error('Provider credential vault has not been initialized');
  }
  return providerCredentialVault;
}

export function setProviderConnectionStore(store: ConnectionStore | null): void {
  providerConnectionStore = store;
}

/** Main-process connection metadata storage. Credentials remain in the vault. */
export function getProviderConnectionStore(): ConnectionStore {
  if (!providerConnectionStore) {
    throw new Error('Provider connections have not been initialized');
  }
  return providerConnectionStore;
}

export function setProviderStatusService(service: ProviderStatusService | null): void {
  providerStatusService = service;
}

/** Main-process access to informational, redacted provider status only. */
export function getProviderStatusService(): ProviderStatusService {
  if (!providerStatusService) {
    throw new Error('Provider status service has not been initialized');
  }
  return providerStatusService;
}

/** Trusted driver registry for read-only facet metadata (tiers, cache). */
export function getProviderDriverRegistry(): ProviderDriverRegistry {
  if (!providerDriverRegistry) {
    providerDriverRegistry = createDefaultProviderDriverRegistry();
  }
  return providerDriverRegistry;
}

/** Clear all provider runtime handles (shutdown / test teardown). */
export function resetProviderRuntimeContext(): void {
  providerCatalogStore = null;
  providerCredentialVault = null;
  providerConnectionStore = null;
  providerStatusService = null;
  providerDriverRegistry = null;
}
