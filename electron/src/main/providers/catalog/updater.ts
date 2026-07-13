import { MAX_CATALOG_BYTES } from './trust';
import {
  ProviderCatalogStore,
  type CatalogPromotionInput,
  type ProviderCatalogSnapshot,
} from './store';

/** Code-owned origin used only after release engineering embeds a public key. */
export const ORCHID_CATALOG_URL = 'https://catalog.orchid.app/providers/catalog.json';

export type RemoteCatalogResponse = CatalogPromotionInput;

export interface CatalogTransport {
  fetchCatalog(): Promise<RemoteCatalogResponse>;
}

export type CatalogRefreshResult = {
  readonly kind: 'updated';
  readonly snapshot: ProviderCatalogSnapshot;
};

/** Coalesces concurrent background/manual refresh attempts into one promotion. */
export class ProviderCatalogUpdater {
  private inFlight: Promise<CatalogRefreshResult> | null = null;

  constructor(
    private readonly store: ProviderCatalogStore,
    private readonly transport: CatalogTransport,
  ) {}

  refresh(): Promise<CatalogRefreshResult> {
    if (this.inFlight) return this.inFlight;
    const task = Promise.resolve()
      .then(() => this.transport.fetchCatalog())
      .then((response) => ({
        kind: 'updated' as const,
        snapshot: this.store.promote(response),
      }));
    this.inFlight = task;
    task.then(
      () => {
        if (this.inFlight === task) this.inFlight = null;
      },
      () => {
        if (this.inFlight === task) this.inFlight = null;
      },
    );
    return task;
  }
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

type FetchLike = (url: string, init: { redirect: 'error'; cache: 'no-store'; headers: Record<string, string> }) => Promise<FetchResponse>;

function signatureUrlFor(catalogUrl: string): string {
  const url = new URL(catalogUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Catalog URL must be a code-owned credential-free HTTPS URL');
  }
  url.pathname += '.sig';
  return url.toString();
}

/**
 * Fetches detached signatures from the same immutable catalog origin. The key
 * ID is only a selector; the bundled keyring remains the authority.
 */
export function createHttpCatalogTransport(
  catalogUrl = ORCHID_CATALOG_URL,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): CatalogTransport {
  const signatureUrl = signatureUrlFor(catalogUrl);
  return {
    async fetchCatalog(): Promise<RemoteCatalogResponse> {
      const init = {
        redirect: 'error' as const,
        cache: 'no-store' as const,
        headers: { Accept: 'application/json' },
      };
      const [catalogResponse, signatureResponse] = await Promise.all([
        fetchImpl(catalogUrl, init),
        fetchImpl(signatureUrl, init),
      ]);
      if (!catalogResponse.ok) {
        throw new Error(`Catalog download failed with HTTP ${catalogResponse.status}`);
      }
      if (!signatureResponse.ok) {
        throw new Error(`Catalog signature download failed with HTTP ${signatureResponse.status}`);
      }
      const contentLength = catalogResponse.headers.get('content-length');
      if (contentLength && Number(contentLength) > MAX_CATALOG_BYTES) {
        throw new Error(`Catalog download exceeds ${MAX_CATALOG_BYTES} byte limit`);
      }
      const keyId = signatureResponse.headers.get('x-orchid-catalog-key-id')
        ?? catalogResponse.headers.get('x-orchid-catalog-key-id');
      if (!keyId) throw new Error('Catalog response did not declare a signing key id');
      const [catalogBytes, signatureText] = await Promise.all([
        catalogResponse.arrayBuffer(),
        signatureResponse.text(),
      ]);
      return {
        bytes: Buffer.from(catalogBytes),
        signature: Buffer.from(signatureText.trim(), 'base64'),
        keyId,
      };
    },
  };
}
