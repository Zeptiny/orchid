/**
 * Deterministic, disposable recovery artifacts for bounded agent projections.
 *
 * These files contain a complete serialization derived from the canonical
 * result. They are deliberately distinct from model-context output offloads:
 * the canonical result remains authoritative and persisted inline.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFsync } from '../utils/safe-fsync';
import { TOOL_OUTPUT_CACHE_DIR } from '../session/storage';
import {
  serializeCanonicalResultForRetrieval,
  type CanonicalToolResult,
  type ToolResultFamily,
  type ToolResultRetrieval,
} from '../../shared/types/tool-result';

export class ResultRetrievalCacheError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResultRetrievalCacheError';
  }
}

/** Test-only override so focused tests never write the real user cache. */
let resultRetrievalCacheRootOverride: string | null = null;

/** @internal Test-only cache-root override. */
export function _setResultRetrievalCacheRootForTests(root: string | null): void {
  resultRetrievalCacheRootOverride = root;
}

function assertSafeSessionSegment(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId === '.' ||
    sessionId === '..' ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('\0')
  ) {
    throw new ResultRetrievalCacheError('Cannot materialize recovery for an unsafe session id');
  }
}

function retrievalFileName(
  toolCallId: string,
  family: ToolResultFamily,
): string {
  const callHash = createHash('sha256').update(toolCallId).digest('hex');
  return `${family}-${callHash}.canonical.json`;
}

function fsyncDirectory(directory: string): void {
  const directoryFd = fs.openSync(directory, 'r');
  try {
    safeFsync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function atomicWriteAndVerify(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;

  try {
    const fileDescriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeFileSync(fileDescriptor, content, 'utf-8');
      safeFsync(fileDescriptor);
    } finally {
      fs.closeSync(fileDescriptor);
    }
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(directory);

    if (fs.readFileSync(filePath, 'utf-8') !== content) {
      throw new ResultRetrievalCacheError('Recovery cache verification failed');
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename may already have consumed the temporary file.
    }
    if (error instanceof ResultRetrievalCacheError) throw error;
    throw new ResultRetrievalCacheError('Could not materialize recovery cache', {
      cause: error,
    });
  }
}

export interface MaterializeResultRetrievalOptions {
  sessionId: string;
  toolCallId: string;
  canonical: CanonicalToolResult;
}

/**
 * Atomically write and verify the canonical-derived recovery serialization.
 * The final path is stable for a session, tool call, and result family.
 */
export function materializeCanonicalResultRetrieval(
  options: MaterializeResultRetrievalOptions,
): Extract<ToolResultRetrieval, { kind: 'cache' }> {
  assertSafeSessionSegment(options.sessionId);
  if (!options.toolCallId) {
    throw new ResultRetrievalCacheError('Cannot materialize recovery without a tool call id');
  }

  const root = resultRetrievalCacheRootOverride ?? TOOL_OUTPUT_CACHE_DIR;
  const directory = path.join(root, options.sessionId);
  const filePath = path.join(
    directory,
    retrievalFileName(options.toolCallId, options.canonical.family),
  );
  const serialization = serializeCanonicalResultForRetrieval(options.canonical);
  atomicWriteAndVerify(filePath, serialization);

  return {
    kind: 'cache',
    path: filePath,
    instructions: [
      `Use read with file_path=${JSON.stringify(filePath)} to inspect the complete result.`,
      `Use grep against ${JSON.stringify(filePath)} to search the complete result.`,
    ],
  };
}
