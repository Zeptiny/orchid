import { ConnectionStore } from '../connection-store';
import type { ProviderConnection } from '../../../shared/types/provider';
import {
  CredentialVault,
  normalizeCredentialBinding,
  type CredentialMetadata,
  type OAuthTokens,
} from './vault';

export interface OAuthTokenRefresherInput {
  readonly connection: ProviderConnection;
  /** Available only in the main process; callers must never serialize it. */
  readonly tokens: OAuthTokens;
}

export type OAuthTokenRefresher = (input: OAuthTokenRefresherInput) => Promise<OAuthTokens>;

export interface CredentialRefreshCoordinatorOptions {
  readonly vault: CredentialVault;
  readonly connections: ConnectionStore;
}

export interface CredentialRefreshResult {
  readonly handle: string;
  readonly metadata: CredentialMetadata;
}

export interface CredentialRefreshOptions {
  /** Trusted driver destination used for the same vault binding as execution. */
  readonly origin?: string | null;
}

export interface DisconnectResult {
  readonly deletedCredentialCount: number;
  /** U5 drivers add provider-specific revocation URLs/instructions. */
  readonly upstreamRevocationRequired: true;
}

/**
 * Connection-scoped OAuth refresh coordinator. It single-flights one refresh
 * per account and marks only that connection as needing attention on failure.
 */
export class CredentialRefreshCoordinator {
  private readonly vault: CredentialVault;
  private readonly connections: ConnectionStore;
  private readonly inFlight = new Map<string, Promise<CredentialRefreshResult>>();

  constructor(options: CredentialRefreshCoordinatorOptions) {
    this.vault = options.vault;
    this.connections = options.connections;
  }

  refreshConnection(
    connectionId: string,
    refreshTokens: OAuthTokenRefresher,
    options: CredentialRefreshOptions = {},
  ): Promise<CredentialRefreshResult> {
    const existing = this.inFlight.get(connectionId);
    if (existing) return existing;
    const task = this.performRefresh(connectionId, refreshTokens, options);
    this.inFlight.set(connectionId, task);
    task.then(
      () => {
        if (this.inFlight.get(connectionId) === task) this.inFlight.delete(connectionId);
      },
      () => {
        if (this.inFlight.get(connectionId) === task) this.inFlight.delete(connectionId);
      },
    );
    return task;
  }

  async disconnectConnection(connectionId: string): Promise<DisconnectResult> {
    const connection = await this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown provider connection '${connectionId}'`);
    const deletedCredentialCount = await this.vault.deleteConnectionCredentials(connectionId);
    await this.connections.update(connectionId, {
      credential: { kind: 'none' },
      health: 'disconnected',
    });
    return { deletedCredentialCount, upstreamRevocationRequired: true };
  }

  private async performRefresh(
    connectionId: string,
    refreshTokens: OAuthTokenRefresher,
    options: CredentialRefreshOptions,
  ): Promise<CredentialRefreshResult> {
    const connection = await this.connections.get(connectionId);
    if (!connection) throw new Error(`Unknown provider connection '${connectionId}'`);
    if (connection.authMethod !== 'oauth' || connection.credential.kind !== 'stored') {
      throw new Error(`Connection '${connectionId}' has no refreshable OAuth credential`);
    }
    const binding = normalizeCredentialBinding({
      connectionId: connection.id,
      driverId: connection.providerId,
      authMethod: 'oauth',
      origin: options.origin !== undefined
        ? options.origin
        : connection.endpoint ?? null,
    });
    try {
      const secret = await this.vault.readSecret(connection.credential.handle, binding);
      if (secret.kind !== 'oauth') throw new Error(`Connection '${connectionId}' credential is not OAuth`);
      const tokens = await refreshTokens({
        connection,
        tokens: {
          accessToken: secret.accessToken,
          refreshToken: secret.refreshToken,
          expiresAt: secret.expiresAt,
          tokenType: secret.tokenType,
        },
      });
      const metadata = await this.vault.rotateOAuthTokens(connection.credential.handle, binding, tokens);
      await this.connections.update(connectionId, { health: 'ready' });
      return { handle: connection.credential.handle, metadata };
    } catch (error) {
      // Refresh failure is isolated: sibling connections and their credentials
      // remain untouched, while U8 can render a reconnect action from health.
      await this.connections.update(connectionId, { health: 'needs_attention' });
      throw error;
    }
  }
}
