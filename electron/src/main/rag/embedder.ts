/**
 * Embedder — generates embeddings using onnxruntime-node (local ONNX models).
 *
 * Ported from Python `src/orchid/rag/embedder.py`.
 *
 * - Uses onnxruntime-node for local ONNX inference
 * - CPU/memory limited via SessionOptions (threads) + batch size from config
 * - Retries 3 (skipped for permanent feed/model errors)
 * - Warmup on first call (throwaway run)
 * - ONNX + tokenizer auto-downloaded from Hugging Face on first use
 * - Supports `fastembed/<hub-id>` config ids and bare hub ids
 * - Graceful failure if native module unavailable
 */

import type { ModelSelection } from '../../shared/types/provider';
import type { RAGConfig } from '../../shared/types/ipc-boundary';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Progress callback for model downloads. */
export type DownloadProgressCallback = (info: {
  file: string;
  bytesDownloaded: number;
  totalBytes: number | undefined;
}) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback if config is unavailable (tests / early boot). */
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_THREADS = 2;
const MAX_RETRIES = 3;

/** Test-only override so embedding tests never write a real home directory. */
let embeddingModelsHomeOverride: string | null = null;

/** @internal Test-only embedding-model home override. */
export function _setEmbeddingModelsHomeForTests(home: string | null): void {
  embeddingModelsHomeOverride = home;
}

async function embeddingModelsHome(): Promise<string> {
  if (embeddingModelsHomeOverride) return embeddingModelsHomeOverride;
  const os = await import('node:os');
  return os.homedir();
}

/** Errors that will not recover by retrying (bad feeds, missing model, etc.). */
function isPermanentEmbeddingError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("missing in 'feeds'") ||
    msg.includes('missing in feeds') ||
    msg.includes('invalid rank') ||
    msg.includes('invalid dimensions') ||
    msg.includes('not found at') ||
    msg.includes('is not available') ||
    msg.includes('place the model manually')
  );
}

/** Default ONNX model for local embeddings (BGE-small) */
const DEFAULT_ONNX_MODEL = 'BAAI/bge-small-en-v1.5';

/**
 * Models shown in Preferences and guaranteed to use the standard HF layout:
 *   onnx/model.onnx + tokenizer.json (+ optional config files).
 *
 * Any other `org/name` (or `fastembed/org/name`) is attempted with the same
 * generic layout so future models can work without a code change.
 */
export const BUILTIN_LOCAL_EMBEDDING_MODELS = [
  'fastembed/BAAI/bge-small-en-v1.5',
  'fastembed/BAAI/bge-base-en-v1.5',
  'fastembed/BAAI/bge-large-en-v1.5',
  'fastembed/sentence-transformers/all-MiniLM-L6-v2',
] as const;

/** Max sequence length for current local embedding models (BGE / MiniLM). */
const DEFAULT_MAX_SEQ_LENGTH = 512;

interface ModelFileSpec {
  /** Path under ~/.orchid/models/<storageId>/ */
  relativePath: string;
  /** Path under the Hugging Face repo (after /resolve/main/). */
  hubPath: string;
  required: boolean;
}

/** Standard HF ONNX export layout used by BGE and MiniLM repos. */
const STANDARD_ONNX_FILES: ModelFileSpec[] = [
  { relativePath: 'model.onnx', hubPath: 'onnx/model.onnx', required: true },
  { relativePath: 'tokenizer.json', hubPath: 'tokenizer.json', required: false },
  {
    relativePath: 'tokenizer_config.json',
    hubPath: 'tokenizer_config.json',
    required: false,
  },
  { relativePath: 'config.json', hubPath: 'config.json', required: false },
];

/**
 * Normalize a config embedding id to storage + Hugging Face hub ids.
 *
 * - `fastembed/BAAI/bge-small-en-v1.5` → hub `BAAI/bge-small-en-v1.5`, storage keeps full id
 * - `BAAI/bge-small-en-v1.5` → same hub, storage is the bare id
 */
export function resolveEmbeddingModelIds(modelName: string): {
  /** Directory name under ~/.orchid/models/ (preserves config id). */
  storageId: string;
  /** Hugging Face repo id used for downloads. */
  hubId: string;
} {
  const trimmed = modelName.trim();
  if (!trimmed) {
    return { storageId: DEFAULT_ONNX_MODEL, hubId: DEFAULT_ONNX_MODEL };
  }
  // Strip known local-provider prefix used in config / Python parity.
  const hubId = trimmed.startsWith('fastembed/')
    ? trimmed.slice('fastembed/'.length)
    : trimmed;
  return { storageId: trimmed, hubId: hubId || DEFAULT_ONNX_MODEL };
}

function hfUrl(hubId: string, hubPath: string): string {
  return `https://huggingface.co/${hubId}/resolve/main/${hubPath}`;
}

function modelFilesForHub(hubId: string): Array<{
  relativePath: string;
  url: string;
  required: boolean;
}> {
  return STANDARD_ONNX_FILES.map((f) => ({
    relativePath: f.relativePath,
    url: hfUrl(hubId, f.hubPath),
    required: f.required,
  }));
}

// ---------------------------------------------------------------------------
// Shared embedder interface
// ---------------------------------------------------------------------------

/** Common interface for both local ONNX and API-based embedders. */
export interface IEmbedder {
  embed(texts: string[]): Promise<Float32Array[]>;
  embedSingle(text: string): Promise<Float32Array>;
}

// ---------------------------------------------------------------------------
// API-based embedding (provider /embeddings endpoint)
// ---------------------------------------------------------------------------

const DEFAULT_API_MAX_RETRIES = 3;
const DEFAULT_API_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS = 900_000;

/** Errors that will not recover by retrying (auth, bad model, bad request). */
function isPermanentApiError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('http 401') ||
    msg.includes('http 403') ||
    msg.includes('http 404') ||
    msg.includes('http 400') ||
    msg.includes('returned no data')
  );
}

/**
 * Embedder that calls a provider's `/embeddings` API endpoint.
 *
 * This class is retained for the typed provider driver integration in U4.
 * Returns Float32Array[] matching the local Embedder interface.
 */
export class ApiEmbedder implements IEmbedder {
  private baseUrl: string;
  private apiKey: string | undefined;
  private modelId: string;
  private batchSize: number;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(
    baseUrl: string,
    apiKey: string | undefined,
    modelId: string,
    batchSize?: number,
    timeoutMs?: number,
    maxRetries?: number,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.batchSize = Math.max(1, Math.min(256, batchSize ?? 64));
    this.timeoutMs = timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.maxRetries = maxRetries ?? DEFAULT_API_MAX_RETRIES;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const all: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this._embedBatchWithRetry(batch);
      all.push(...vectors);
      if (i + this.batchSize < texts.length) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    return all;
  }

  async embedSingle(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    if (results.length === 0) {
      throw new EmbeddingError('API embedding returned no vectors');
    }
    return results[0]!;
  }

  private async _embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
    let lastError: Error | undefined;
    const totalAttempts = Math.max(1, this.maxRetries + 1);

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      try {
        return await this._embedBatch(texts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isPermanentApiError(lastError)) break;
        if (attempt < totalAttempts - 1) {
          const wait = 2 ** attempt * 1000;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }

    throw new EmbeddingError(
      `API embedding failed after ${totalAttempts} attempts: ${lastError?.message}`,
    );
  }
  private async _embedBatch(texts: string[]): Promise<Float32Array[]> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.modelId, input: texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new EmbeddingError(
          `API embeddings failed (HTTP ${response.status}): ${body.slice(0, 200)}`,
        );
      }

      const data = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };

      if (!data.data || data.data.length === 0) {
        throw new EmbeddingError('API embeddings returned no data');
      }

      return data.data.map((d) => {
        const arr = d.embedding ?? [];
        return Float32Array.from(arr);
      });
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `API embeddings request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // A fetch promise resolves once headers arrive. Keep the deadline armed
      // while response.text()/json() consume a potentially stalled body.
      clearTimeout(timeout);
    }
  }
}

/**
 * Create an embedder based on config.
 *
 * A null API selection preserves local ONNX behavior. When a typed selection
 * is configured, the main-process provider runtime owns its connection,
 * credential, and code-owned endpoint resolution; legacy alias strings never
 * reach this function as executable providers.
 */
export async function createEmbedderFromConfig(rag?: RAGConfig): Promise<IEmbedder> {
  let cfgThreads = DEFAULT_THREADS;
  let cfgBatch = DEFAULT_BATCH_SIZE;
  let cfgModel: string | undefined;
  let cfgApiSelection: ModelSelection | null = null;
  let cfgApiTimeout: number | undefined;
  let cfgApiRetries: number | undefined;
  let cfgDownloadTimeouts: ModelDownloadOptions | undefined;
  try {
    const conf = rag ?? (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('../config/loader') as typeof import('../config/loader');
      return getConfig().rag;
    })();
    cfgModel = conf.embedding_model;
    cfgApiSelection = conf.embedding_api_model;
    if (typeof conf.embedding_threads === 'number' && conf.embedding_threads > 0) {
      cfgThreads = conf.embedding_threads;
    }
    if (typeof conf.embedding_batch_size === 'number' && conf.embedding_batch_size > 0) {
      cfgBatch = conf.embedding_batch_size;
    }
    if (typeof conf.embedding_api_timeout === 'number' && conf.embedding_api_timeout > 0) {
      cfgApiTimeout = conf.embedding_api_timeout * 1000;
    }
    if (typeof conf.embedding_api_retries === 'number' && conf.embedding_api_retries >= 0) {
      cfgApiRetries = conf.embedding_api_retries;
    }
    cfgDownloadTimeouts = modelDownloadOptionsFromConfig(conf);
  } catch {
    // config unavailable — use hard defaults
  }

  if (cfgApiSelection) {
    // Lazy main-process lookup avoids initializing providers when local ONNX
    // is selected and keeps the credential-bearing target out of renderer code.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getProviderRuntime } = require('../providers') as typeof import('../providers');
    const target = await getProviderRuntime().resolveApiEmbeddingTarget(cfgApiSelection);
    return new ApiEmbedder(
      target.baseURL,
      target.apiKey,
      cfgApiSelection.modelId,
      cfgBatch,
      cfgApiTimeout,
      cfgApiRetries,
    );
  }

  return new Embedder({
    model: cfgModel ?? DEFAULT_ONNX_MODEL,
    threads: cfgThreads,
    batchSize: cfgBatch,
    modelDownloadTimeouts: cfgDownloadTimeouts,
  });
}

// ---------------------------------------------------------------------------
// ONNX Embedder
// ---------------------------------------------------------------------------

/**
 * Generate embeddings for text using ONNX runtime.
 *
 * The first call triggers a warmup (throwaway inference) to avoid slow
 * first-real-request latency from ONNX runtime initialization.
 */
export interface EmbedderOptions {
  /** Override model id (else config / DEFAULT_ONNX_MODEL). */
  model?: string;
  /** ONNX intra/inter-op threads (default from config, else 2). */
  threads?: number;
  /** Texts per ONNX forward pass (default from config, else 16). */
  batchSize?: number;
  /** Model-download deadlines from the caller-supplied RAGConfig (ms); unset fields keep the default resolution. */
  modelDownloadTimeouts?: ModelDownloadOptions;
}

/** Optional controls for a single model-file download. */
export interface ModelDownloadOptions {
  /** Abort the in-flight request when the caller cancels indexing. */
  signal?: AbortSignal;
  /** Maximum interval without response or body progress. */
  inactivityTimeoutMs?: number;
  /** Absolute duration limit for one model-file request. */
  totalTimeoutMs?: number;
}

export class Embedder implements IEmbedder {
  private warmedUp = false;
  private modelName: string;
  private threads: number;
  private batchSize: number;
  private modelDownloadTimeouts?: ModelDownloadOptions;

  constructor(modelOrOptions?: string | EmbedderOptions) {
    const opts: EmbedderOptions =
      typeof modelOrOptions === 'string'
        ? { model: modelOrOptions }
        : (modelOrOptions ?? {});

    let cfgThreads = DEFAULT_THREADS;
    let cfgBatch = DEFAULT_BATCH_SIZE;
    let cfgModel: string | undefined;
    try {
      // Lazy require avoids circular init with config loader in tests
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getConfig } = require('../config/loader') as typeof import('../config/loader');
      const rag = getConfig().rag;
      cfgModel = rag.embedding_model;
      if (typeof rag.embedding_threads === 'number' && rag.embedding_threads > 0) {
        cfgThreads = rag.embedding_threads;
      }
      if (typeof rag.embedding_batch_size === 'number' && rag.embedding_batch_size > 0) {
        cfgBatch = rag.embedding_batch_size;
      }
    } catch {
      // config unavailable — use hard defaults
    }

    this.modelName = opts.model ?? cfgModel ?? DEFAULT_ONNX_MODEL;
    this.threads = Math.max(1, Math.min(64, opts.threads ?? cfgThreads));
    this.batchSize = Math.max(1, Math.min(256, opts.batchSize ?? cfgBatch));
    this.modelDownloadTimeouts = opts.modelDownloadTimeouts;
  }

  /**
   * Generate embeddings for a list of texts.
   *
   * Splits into batches of `batchSize` and retries each batch up to MAX_RETRIES.
   *
   * @returns Array of Float32Arrays, one per input text
   * @throws EmbeddingError if inference fails after retries
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Warmup on first call
    if (!this.warmedUp) {
      await this._warmup();
      this.warmedUp = true;
    }

    const allEmbeddings: Float32Array[] = [];
    const batchSize = this.batchSize;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await this._embedBatchWithRetry(batch);
      allEmbeddings.push(...embeddings);
      // Yield between batches so the Electron main process stays responsive
      // and we don't pin a full core continuously across huge files.
      if (i + batchSize < texts.length) {
        await yieldEventLoop();
      }
    }

    return allEmbeddings;
  }

  /**
   * Generate embedding for a single text.
   */
  async embedSingle(text: string): Promise<Float32Array> {
    const results = await this.embed([text]);
    if (results.length === 0) {
      throw new EmbeddingError('Embedding returned no vectors for input text');
    }
    return results[0]!;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async _warmup(): Promise<void> {
    try {
      await this._embedBatch(['warmup']);
    } catch {
      // Warmup failure is non-fatal — real calls will still try
    }
  }

  private async _embedBatchWithRetry(texts: string[]): Promise<Float32Array[]> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this._embedBatch(texts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Permanent config / input-shape errors will never succeed on retry —
        // fail immediately instead of sleeping (looks like a hung, idle index).
        if (isPermanentEmbeddingError(lastError)) {
          break;
        }
        if (attempt < MAX_RETRIES - 1) {
          const wait = 2 ** attempt * 1000;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }

    throw new EmbeddingError(
      `Embedding failed after ${MAX_RETRIES} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Run a single embedding batch. Delegates to the ONNX worker.
   */
  private async _embedBatch(texts: string[]): Promise<Float32Array[]> {
    try {
      return await runOnnxEmbedding(texts, this.modelName, this.threads, this.modelDownloadTimeouts);
    } catch (err) {
      if (err instanceof EmbeddingError) throw err;
      throw new EmbeddingError(
        `ONNX embedding failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Cooperative yield so long indexing doesn't starve IPC / UI. */
function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Model download
// ---------------------------------------------------------------------------

/**
 * Download all model files for the given model name.
 *
 * Downloads to ~/.orchid/models/<storageId>/ (config id, including optional
 * `fastembed/` prefix), writing to a temp file first then renaming atomically.
 * Skips files that already exist.
 *
 * @param modelName - Config or HF id (e.g. "fastembed/BAAI/bge-base-en-v1.5")
 * @param onProgress - Optional callback for download progress
 * @throws EmbeddingError if a required download fails
 */
export async function downloadModel(
  modelName: string = DEFAULT_ONNX_MODEL,
  onProgress?: DownloadProgressCallback,
  options?: ModelDownloadOptions,
): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const { hubId } = resolveEmbeddingModelIds(modelName);
  const modelDir = await getModelDir(modelName);
  const files = modelFilesForHub(hubId);

  // Ensure parent directories exist
  await fs.promises.mkdir(modelDir, { recursive: true });

  for (const file of files) {
    const destPath = path.join(modelDir, file.relativePath);

    // Skip if already downloaded
    if (fs.existsSync(destPath)) continue;

    try {
      await downloadFile(file.url, destPath, file.required, onProgress, options);
    } catch (err) {
      if (file.required) {
        throw new EmbeddingError(
          `RAG embedding model '${hubId}' download failed: ${err instanceof Error ? err.message : String(err)}. ` +
            `Place model.onnx (and tokenizer.json if available) manually at ${modelDir}/`,
        );
      }
      // Non-required files: log but don't fail
      console.warn(`Optional model file download failed (${file.relativePath}): ${err}`);
    }
  }
}

/**
 * Download a single file with streaming, atomic write, and progress reporting.
 */
async function downloadFile(
  url: string,
  destPath: string,
  required: boolean,
  onProgress?: DownloadProgressCallback,
  options?: ModelDownloadOptions,
): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const stream = await import('node:stream');
  const { pipeline } = stream.promises;

  const fileName = path.basename(destPath);
  const tmpPath = `${destPath}.tmp.${Date.now()}`;
  const controller = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let abortReason: Error | undefined;

  const abort = (reason: Error) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const inactivityTimeoutMs = Math.max(
    1,
    options?.inactivityTimeoutMs ?? modelDownloadTimeouts().inactivityTimeoutMs,
  );
  const totalTimeoutMs = Math.max(
    1,
    options?.totalTimeoutMs ?? modelDownloadTimeouts().totalTimeoutMs,
  );
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      abort(new Error(`Model download timed out after ${inactivityTimeoutMs}ms without progress`));
    }, inactivityTimeoutMs);
  };
  const onExternalAbort = () => {
    const reason = options?.signal?.reason;
    abort(reason instanceof Error ? reason : new Error('Model download cancelled'));
  };
  if (options?.signal?.aborted) onExternalAbort();
  else options?.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const totalTimer = setTimeout(() => {
    abort(new Error(`Model download exceeded its ${totalTimeoutMs}ms duration limit`));
  }, totalTimeoutMs);
  resetInactivityTimer();

  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw abortReason ?? err;
      throw new Error(`Network error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    resetInactivityTimer();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : undefined;

    // Stream the response body to a temp file. Each chunk renews the
    // inactivity deadline; the total deadline remains active throughout.
    let bytesDownloaded = 0;
    const reader = response.body.getReader();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancelReader = () => {
      streamController?.error(controller.signal.reason ?? new Error('Model download cancelled'));
      void reader.cancel(controller.signal.reason).catch(() => undefined);
    };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    const readable = new ReadableStream({
      async pull(nextController) {
        streamController = nextController;
        try {
          const { done, value } = await reader.read();
          if (done) {
            nextController.close();
            return;
          }
          bytesDownloaded += value.byteLength;
          resetInactivityTimer();
          if (onProgress) {
            try {
              onProgress({ file: fileName, bytesDownloaded, totalBytes });
            } catch {
              // ignore callback errors
            }
          }
          nextController.enqueue(value);
        } catch (err) {
          nextController.error(err);
        }
      }
    });

    const nodeReadable = stream.Readable.fromWeb(
      readable as unknown as import('node:stream/web').ReadableStream,
    );
    const writeStream = fs.createWriteStream(tmpPath);
    await pipeline(nodeReadable, writeStream);
    controller.signal.removeEventListener('abort', cancelReader);

    if (controller.signal.aborted) {
      throw abortReason ?? new Error('Model download cancelled');
    }

    // Verify file size if expected size is known
    if (totalBytes !== undefined) {
      const stat = await fs.promises.stat(tmpPath);
      if (stat.size !== totalBytes) {
        throw new Error(
          `File size mismatch: expected ${totalBytes} bytes but got ${stat.size} bytes`,
        );
      }
    }

    // Atomic rename
    await fs.promises.rename(tmpPath, destPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch {
      // ignore cleanup errors
    }
    throw controller.signal.aborted ? (abortReason ?? err) : err;
  } finally {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (totalTimer) clearTimeout(totalTimer);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

function modelDownloadTimeouts(): {
  inactivityTimeoutMs: number;
  totalTimeoutMs: number;
} {
  try {
    // Keep direct downloadModel() callers compatible with early boot/tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../config/loader') as typeof import('../config/loader');
    const rag = getConfig().rag;
    return {
      inactivityTimeoutMs: typeof rag.model_download_inactivity_timeout === 'number'
        ? rag.model_download_inactivity_timeout * 1000
        : DEFAULT_MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS,
      totalTimeoutMs: typeof rag.model_download_total_timeout === 'number'
        ? rag.model_download_total_timeout * 1000
        : DEFAULT_MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
    };
  } catch {
    return {
      inactivityTimeoutMs: DEFAULT_MODEL_DOWNLOAD_INACTIVITY_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_MODEL_DOWNLOAD_TOTAL_TIMEOUT_MS,
    };
  }
}

/**
 * Map the caller-supplied RAGConfig's model-download timeouts (seconds) to
 * download options (ms). Absent or non-positive fields stay unset so the
 * default resolution (`modelDownloadTimeouts`) still applies.
 */
export function modelDownloadOptionsFromConfig(
  rag?: Partial<RAGConfig>,
): ModelDownloadOptions {
  const inactivity = rag?.model_download_inactivity_timeout;
  const total = rag?.model_download_total_timeout;
  return {
    ...(typeof inactivity === 'number' && inactivity > 0
      ? { inactivityTimeoutMs: inactivity * 1000 }
      : {}),
    ...(typeof total === 'number' && total > 0
      ? { totalTimeoutMs: total * 1000 }
      : {}),
  };
}

/** Remove incomplete model downloads after an interrupted index worker exits. */
export async function removeModelDownloadTemps(modelName: string): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const modelDir = await getModelDir(modelName);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(modelDir);
  } catch {
    return;
  }
  const tempPrefixes = modelFilesForHub(resolveEmbeddingModelIds(modelName).hubId)
    .map((file) => `${path.basename(file.relativePath)}.tmp.`);
  await Promise.all(entries
    .filter((entry) => tempPrefixes.some((prefix) => entry.startsWith(prefix)))
    .map(async (entry) => {
      try {
        await fs.promises.unlink(path.join(modelDir, entry));
      } catch {
        // A racing successful download may already have renamed the file.
      }
    }));
}

/**
 * Get the local directory where model files are stored.
 */
export async function getModelDir(modelName: string = DEFAULT_ONNX_MODEL): Promise<string> {
  const path = await import('node:path');
  const { storageId } = resolveEmbeddingModelIds(modelName);
  return path.join(await embeddingModelsHome(), '.orchid', 'models', storageId);
}

// ---------------------------------------------------------------------------
// ONNX worker interface
// ---------------------------------------------------------------------------

/**
 * Run ONNX embedding inference via worker_threads.
 *
 * This function dynamically imports onnxruntime-node and runs inference
 * in the current thread (worker_threads are used at a higher level when
 * needed). If onnxruntime-node is not available, throws EmbeddingError.
 */
async function runOnnxEmbedding(
  texts: string[],
  modelName: string,
  threads: number,
  downloadOptions?: ModelDownloadOptions,
): Promise<Float32Array[]> {
  // Dynamic import — onnxruntime-node is an optional native dependency
  let ort: typeof import('onnxruntime-node');
  try {
    ort = await import('onnxruntime-node');
  } catch {
    throw new EmbeddingError(
      'onnxruntime-node is not available. Install it with: npm install onnxruntime-node',
    );
  }

  // Inference runs inline with a hard-capped thread pool (see SessionOptions).
  const session = await getOrCreateSession(ort, modelName, threads, downloadOptions);

  // Tokenize using proper BPE tokenizer, falling back to simpleTokenize.
  // Current local models (BGE / MiniLM) all use a 512-token window.
  const maxLength = DEFAULT_MAX_SEQ_LENGTH;
  const inputIds: number[][] = [];
  const attentionMask: number[][] = [];

  const tokenizer = await getTokenizer(modelName);
  for (const text of texts) {
    if (tokenizer) {
      const encoded = tokenizer.encode(text, { add_special_tokens: true });
      // @huggingface/tokenizers JS version returns plain object with .ids, .attention_mask
      const ids: number[] = encoded.ids;
      const mask: number[] = encoded.attention_mask;
      // Truncate or pad to maxLength
      const truncatedIds = ids.slice(0, maxLength);
      const truncatedMask = mask.slice(0, maxLength);
      while (truncatedIds.length < maxLength) {
        truncatedIds.push(0);
        truncatedMask.push(0);
      }
      inputIds.push(truncatedIds);
      attentionMask.push(truncatedMask);
    } else {
      const tokens = simpleTokenize(text, maxLength);
      inputIds.push(tokens);
      attentionMask.push(tokens.map((t) => (t === 0 ? 0 : 1)));
    }
  }

  const batchSize = texts.length;
  const seqLen = maxLength;
  const shape: number[] = [batchSize, seqLen];

  // Build feeds from the session's declared inputs. BGE / BERT-style ONNX
  // models typically require token_type_ids (all zeros for single-segment
  // text); omitting it fails every batch and the retry backoff looks idle.
  const flatIds = inputIds.flat();
  const flatMask = attentionMask.flat();
  const feeds: Record<string, InstanceType<typeof ort.Tensor>> = {};
  const requiredInputs = session.inputNames.length > 0
    ? session.inputNames
    : ['input_ids', 'attention_mask', 'token_type_ids'];

  for (const name of requiredInputs) {
    if (name === 'input_ids') {
      feeds[name] = new ort.Tensor(
        'int64',
        new BigInt64Array(flatIds.map(BigInt)),
        shape,
      );
    } else if (name === 'attention_mask') {
      feeds[name] = new ort.Tensor(
        'int64',
        new BigInt64Array(flatMask.map(BigInt)),
        shape,
      );
    } else if (name === 'token_type_ids') {
      // Single-segment encoding — segment id 0 for every token
      feeds[name] = new ort.Tensor(
        'int64',
        new BigInt64Array(batchSize * seqLen),
        shape,
      );
    } else {
      // Unknown optional input: zeros of the common [batch, seq] shape
      feeds[name] = new ort.Tensor(
        'int64',
        new BigInt64Array(batchSize * seqLen),
        shape,
      );
    }
  }

  const results = await session.run(feeds);

  // Extract embeddings — output key varies by model, try common ones
  const outputTensor =
    results['last_hidden_state'] ??
    results['token_embeddings'] ??
    Object.values(results)[0];

  if (!outputTensor) {
    throw new EmbeddingError('ONNX model returned no output tensor');
  }

  const data = outputTensor.data as Float32Array;
  const hiddenSize = outputTensor.dims![outputTensor.dims!.length - 1]!;

  // Mean pooling over non-padded tokens
  const embeddings: Float32Array[] = [];
  for (let b = 0; b < batchSize; b++) {
    const pooled = new Float32Array(hiddenSize);
    let tokenCount = 0;

    for (let t = 0; t < seqLen; t++) {
      if (attentionMask[b]![t] === 0) continue;
      tokenCount++;
      const offset = b * seqLen * hiddenSize + t * hiddenSize;
      for (let d = 0; d < hiddenSize; d++) {
        pooled[d]! += data[offset + d]!;
      }
    }

    if (tokenCount > 0) {
      for (let d = 0; d < hiddenSize; d++) {
        pooled[d]! /= tokenCount;
      }
    }

    // L2 normalize
    let norm = 0;
    for (let d = 0; d < hiddenSize; d++) {
      norm += pooled[d]! * pooled[d]!;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let d = 0; d < hiddenSize; d++) {
        pooled[d]! /= norm;
      }
    }

    embeddings.push(pooled);
  }

  return embeddings;
}

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, import('onnxruntime-node').InferenceSession>();

async function getOrCreateSession(
  ort: typeof import('onnxruntime-node'),
  modelName: string,
  threads: number,
  downloadOptions?: ModelDownloadOptions,
): Promise<import('onnxruntime-node').InferenceSession> {
  // Cache key includes thread count so changing config takes effect after restart
  // (or after the cache entry is recreated on next process boot).
  const cacheKey = `${modelName}::t${threads}`;
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey)!;
  }

  const modelPath = await resolveModelPath(modelName, downloadOptions);
  // Limit CPU: ORT defaults to "all physical cores" when threads are unset.
  // sequential executionMode avoids extra inter-op fan-out across graph nodes.
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    enableCpuMemArena: true,
    graphOptimizationLevel: 'all',
  });
  sessionCache.set(cacheKey, session);
  return session;
}

/**
 * Resolve the ONNX model path. Checks:
 * 1. ~/.orchid/models/<storageId>/model.onnx  (storageId = full config id)
 * 2. ~/.orchid/models/<hubId>/model.onnx      (legacy bare hub path)
 *
 * If not found, auto-downloads the model files from Hugging Face into storageId.
 */
async function resolveModelPath(
  modelName: string,
  downloadOptions?: ModelDownloadOptions,
): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const { storageId, hubId } = resolveEmbeddingModelIds(modelName);
  const candidates = [
    path.join(await embeddingModelsHome(), '.orchid', 'models', storageId, 'model.onnx'),
  ];
  // Prefer storageId path; also accept bare hub layout for older installs.
  if (storageId !== hubId) {
    candidates.push(path.join(await embeddingModelsHome(), '.orchid', 'models', hubId, 'model.onnx'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Auto-download on first use into the storageId directory
  await downloadModel(modelName, undefined, downloadOptions);

  const primary = candidates[0]!;
  if (fs.existsSync(primary)) {
    return primary;
  }

  throw new EmbeddingError(
    `ONNX model not found at ${primary} after download attempt. ` +
      `Place the model manually at ~/.orchid/models/${storageId}/model.onnx ` +
      `(Hugging Face hub id: ${hubId})`,
  );
}

// ---------------------------------------------------------------------------
// BPE Tokenizer
// ---------------------------------------------------------------------------

/** Cached tokenizer instances keyed by model name. Null means fallback to simpleTokenize. */
const tokenizerCache = new Map<string, InstanceType<typeof import('@huggingface/tokenizers').Tokenizer> | null>();

/**
 * Load the BPE tokenizer for the given model using @huggingface/tokenizers.
 *
 * Caches the tokenizer instance for reuse. Returns null if the tokenizer
 * file is not found or the library fails to load, signaling that the caller
 * should fall back to simpleTokenize().
 */
async function getTokenizer(
  modelName: string,
): Promise<InstanceType<typeof import('@huggingface/tokenizers').Tokenizer> | null> {
  if (tokenizerCache.has(modelName)) {
    return tokenizerCache.get(modelName)!;
  }

  try {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const { storageId, hubId } = resolveEmbeddingModelIds(modelName);
    const modelDirs = [
      path.join(await embeddingModelsHome(), '.orchid', 'models', storageId),
    ];
    if (storageId !== hubId) {
      modelDirs.push(path.join(await embeddingModelsHome(), '.orchid', 'models', hubId));
    }

    let modelDir: string | null = null;
    let tokenizerPath: string | null = null;
    for (const dir of modelDirs) {
      const candidate = path.join(dir, 'tokenizer.json');
      if (fs.existsSync(candidate)) {
        modelDir = dir;
        tokenizerPath = candidate;
        break;
      }
    }

    if (!modelDir || !tokenizerPath) {
      console.warn(
        `BPE tokenizer file not found for '${modelName}', falling back to simpleTokenize`,
      );
      tokenizerCache.set(modelName, null);
      return null;
    }

    const { Tokenizer } = await import('@huggingface/tokenizers');

    // Load tokenizer.json
    const tokenizerJson = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));

    // Load tokenizer_config.json if available, otherwise use empty config
    const configPath = path.join(modelDir, 'tokenizer_config.json');
    let tokenizerConfig: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      try {
        tokenizerConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch {
        console.warn('Failed to parse tokenizer_config.json, using empty config');
      }
    }

    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    tokenizerCache.set(modelName, tokenizer);
    return tokenizer;
  } catch (err) {
    // MODULE_NOT_FOUND or any other error — fall back gracefully
    console.warn(
      `Failed to load BPE tokenizer for ${modelName}, falling back to simpleTokenize: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    tokenizerCache.set(modelName, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Simple tokenizer (fallback)
// ---------------------------------------------------------------------------

/**
 * Simple whitespace tokenizer that mimics basic BPE-like behavior.
 *
 * For production, replace with a proper tokenizer (e.g., tokenizers library).
 * This approximation works well enough for BGE-small models.
 */
function simpleTokenize(text: string, maxLength: number): number[] {
  // BGE models use a vocab-based tokenizer. This is a simplified version
  // that maps characters to approximate token IDs. In production, use
  // the actual tokenizer from the model.
  const tokens: number[] = [101]; // [CLS] token
  const words = text.split(/\s+/);

  for (const word of words) {
    if (tokens.length >= maxLength - 1) break;
    // Simple hash-based token ID (not real BPE, but gives consistent vectors)
    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
    }
    tokens.push(Math.abs(hash) % 30000 + 1000);
  }

  tokens.push(102); // [SEP] token

  // Pad to maxLength
  while (tokens.length < maxLength) {
    tokens.push(0);
  }

  return tokens.slice(0, maxLength);
}
