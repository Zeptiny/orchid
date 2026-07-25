import type { LanguageModelV4 } from '@ai-sdk/provider';
import type {
  DriverModelRequest,
  ProviderDriver,
  ProviderEmbeddingTarget,
} from './types';
import { createNativeProviderDrivers } from './native';
import { createCompatibleProviderDrivers, validateGenericEndpoint } from './compatible';
import { createOpenCodeGoProviderDriver } from './opencode-go';
import { createLilacProviderDriver } from './lilac';
import { createNeuralwattProviderDriver } from './neuralwatt';
import { ProviderResolutionError } from '../../llm/middleware/error-classification';

/** Trusted registry; only this code can introduce adapter or origin behavior. */
export class ProviderDriverRegistry {
  private readonly byId: ReadonlyMap<string, ProviderDriver>;

  constructor(drivers: readonly ProviderDriver[]) {
    const byId = new Map<string, ProviderDriver>();
    for (const driver of drivers) {
      if (byId.has(driver.id)) throw new Error(`Duplicate trusted provider driver '${driver.id}'`);
      byId.set(driver.id, driver);
    }
    this.byId = byId;
  }

  get(id: string): ProviderDriver | undefined {
    return this.byId.get(id);
  }

  require(id: string): ProviderDriver {
    const driver = this.get(id);
    if (!driver) throw new ProviderResolutionError(`No trusted driver is installed for provider '${id}'`);
    return driver;
  }

  async createLanguageModel(request: DriverModelRequest): Promise<LanguageModelV4> {
    const { driver, endpoint } = this.prepareRequest(request);
    return driver.createLanguageModel({ ...request, endpoint });
  }

  /** Resolve a typed API embedding target without reviving alias/URL inference. */
  async createEmbeddingTarget(request: DriverModelRequest): Promise<ProviderEmbeddingTarget> {
    const { driver, endpoint } = this.prepareRequest(request);
    if (!driver.createEmbeddingTarget) {
      throw new ProviderResolutionError(
        `Provider '${request.provider.id}' does not support API embeddings through its trusted driver`,
      );
    }
    return driver.createEmbeddingTarget({ ...request, endpoint });
  }

  private prepareRequest(request: DriverModelRequest): {
    readonly driver: ProviderDriver;
    readonly endpoint: string | undefined;
  } {
    const driver = this.require(request.provider.id);
    const { connection, model, provider } = request;
    if (connection.providerId !== provider.id) {
      throw new ProviderResolutionError('Provider connection does not match the resolved provider definition');
    }
    if (!driver.supportedAuthMethods.includes(connection.authMethod)
      || !provider.supportedAuthMethods.includes(connection.authMethod)) {
      throw new ProviderResolutionError(`Provider '${provider.id}' does not support auth method '${connection.authMethod}'`);
    }
    if (!driver.supportedProtocols.includes(connection.protocol)
      || !provider.supportedProtocols.includes(connection.protocol)
      || connection.protocol !== model.protocol) {
      throw new ProviderResolutionError(`Provider '${provider.id}' does not support protocol '${connection.protocol}' for '${model.id}'`);
    }

    let endpoint: string | undefined;
    if (driver.allowsCustomEndpoint) {
      if (!connection.endpoint) {
        throw new ProviderResolutionError(`Generic provider '${provider.id}' requires a user-defined endpoint`);
      }
      endpoint = validateGenericEndpoint(connection.endpoint, {
        allowInsecureNonLoopbackHttp: connection.allowInsecureHttp === true,
      }).endpoint;
    } else if (connection.endpoint) {
      throw new ProviderResolutionError(
        `Built-in provider '${provider.id}' uses its code-owned API origin and cannot be redirected by connection or catalog data`,
      );
    }
    return { driver, endpoint };
  }
}

export function createDefaultProviderDriverRegistry(): ProviderDriverRegistry {
  return new ProviderDriverRegistry([
    ...createNativeProviderDrivers(),
    ...createCompatibleProviderDrivers(),
    createOpenCodeGoProviderDriver(),
    createLilacProviderDriver(),
    createNeuralwattProviderDriver(),
  ]);
}
