/**
 * web_fetch tool — fetch a URL and extract information.
 *
 * Key behaviors:
 * - Only allow http/https schemes
 * - Maximum response body size cap
 * - Fetch via fetch() with 30s timeout
 * - Summarize mode: HTML to markdown, sends to web-fetch agent
 * - Raw mode: markdown; >10K chars → cache file
 * - Title extraction via HTML parsing
 */
import TurndownService from 'turndown';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeFsync } from '../../utils/safe-fsync';
import { URL } from 'node:url';
import type { ToolDefinition, ToolExecutionContext, ToolHandler } from '../types';
import { RiskClass } from '../../../shared/types/permission';
import { genericToolResultMetadata } from '../types';
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';
import { HOME_CONFIG_DIR } from '../../config/loader';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fetch timeout in milliseconds (30 seconds). */
const FETCH_TIMEOUT_MS = 30_000;

/** Maximum response body size in bytes (10 MiB). */
const MAX_BODY_SIZE = 10 * 1024 * 1024;

/** Threshold for writing raw content to cache file (10K chars). */
const RAW_CONTENT_THRESHOLD = 10_000;

/** User-Agent header for fetch requests. */
const USER_AGENT = 'Orchid/1.0 web-fetch (Electron)';

/** Turndown instance configured for markdown output. */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback for summarizing content via the web-fetch agent. */
export type SummarizeCallback = (
  url: string,
  title: string,
  contentType: string,
  content: string,
  query: string,
  context: ToolExecutionContext,
) => Promise<string>;

/** Options for building the web_fetch tool. */
export interface WebFetchOptions {
  /** Optional session ID for cache file storage. */
  sessionId?: string;
  /** Optional callback for summarize mode (uses LLM agent). */
  summarize?: SummarizeCallback;
  /** Override the application data root for isolated callers/tests. */
  cacheRoot?: string;
}

/**
 * Result returned by the web_fetch handler.
 */
export type WebFetchResult = GenericBuiltInToolOutcome;

// ---------------------------------------------------------------------------
// URL validation — security-critical
// ---------------------------------------------------------------------------

/**
 * Validate a URL.
 *
 * Returns an error message if invalid, or null if valid.
 */
function validateUrl(url: string): string | null {
  if (!url || !url.trim()) {
    return 'url is required and cannot be empty.';
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return 'url is not a valid URL.';
  }

  // Only allow http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'url must use http or https.';
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTML processing
// ---------------------------------------------------------------------------

/**
 * Extract the <title> content from HTML.
 *
 * Uses a simple regex approach (matching Python's HTMLParser-based approach).
 */
function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return '';
  // Collapse whitespace (matching Python's " ".join(" ".join(parts).split()))
  return match[1].replace(/\s+/g, ' ').trim();
}

/**
 * Convert HTML to markdown using turndown.
 *
 * Uses the turndown library for production-quality HTML-to-markdown conversion
 * with ATX-style headings and fenced code blocks.
 */
function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

// ---------------------------------------------------------------------------
// Cache file management
// ---------------------------------------------------------------------------

/**
 * Generate a safe slug from a URL for use as a cache filename.
 */
function slugFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'page.md';
  }

  let raw = `${parsed.hostname}${parsed.pathname || ''}`;
  if (parsed.search) {
    raw = `${raw}_${parsed.search}`;
  }
  raw = raw.replace(/^\//, '').replace(/\/$/, '') || parsed.hostname || 'page';
  raw = raw.replace(/\.\./g, '');

  // Sanitize: only allow alphanumeric, dots, hyphens, underscores
  let slug = raw.replace(/[^A-Za-z0-9._-]+/g, '_');
  slug = slug.replace(/_+/g, '_');
  slug = slug.replace(/^[._-]+|[._-]+$/g, '');

  // Truncate to 80 chars
  const name = (slug || 'page').slice(0, 80).replace(/^[._-]+|[._-]+$/g, '') || 'page';
  return `${name}.md`;
}

/**
 * Write content to a cache file.
 *
 * @param sessionId - Current session ID for directory scoping
 * @param url - The fetched URL (used for filename)
 * @param content - The content to cache
 * @returns The path to the cache file
 */
function writeCacheFile(
  cacheRoot: string,
  sessionId: string,
  url: string,
  content: string,
): string {
  const cacheDir = path.join(cacheRoot, 'cache', 'web-fetch', sessionId);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const filename = slugFromUrl(url);
  const filePath = path.join(cacheDir, filename);

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeSync(fd, content, undefined, 'utf-8');
      safeFsync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  return filePath;
}

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

/**
 * Build the web_fetch tool.
 *
 * @param options - Optional configuration (sessionId, summarize callback)
 */
export function buildWebFetchTool(
  options?: WebFetchOptions,
): { definition: ToolDefinition; handler: ToolHandler } {
  const definition: ToolDefinition = {
    ...genericToolResultMetadata,
    name: 'web_fetch',
    description:
      'Fetch a URL and extract information from it. Without a query, returns the converted page ' +
      'content directly. With a query, converts HTML to markdown and asks an internal model to ' +
      'answer the query.',
    inputSchema: z.object({
      url: z.string().describe('The http or https URL to fetch.'),
      query: z
        .string()
        .optional()
        .describe(
          'Optional question or extraction request. Omit or leave blank to return the raw page content.',
        ),
    }),
    category: 'web',
    riskClass: RiskClass.NETWORK,
  };

  const handler: ToolHandler = async (input: unknown, ctx): Promise<WebFetchResult> => {
    const { url: rawUrl, query: rawQuery } = input as {
      url: string;
      query?: string;
    };

    const url = (rawUrl || '').trim();
    const query = (rawQuery || '').trim();

    // Validate URL
    const urlError = validateUrl(url);
    if (urlError) {
      return genericBuiltInToolOutcome('web_fetch', `Error: ${urlError}`, 'error');
    }

    // Fetch the URL — combine outer tool-dispatch abort with the 30s HTTP budget
    let response: Response;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
    if (typeof timeoutId === 'object' && timeoutId && 'unref' in timeoutId) {
      (timeoutId as NodeJS.Timeout).unref();
    }
    const parentAbort = ctx?.abortSignal;
    const fetchSignal =
      parentAbort !== undefined
        ? AbortSignal.any([parentAbort, timeoutController.signal])
        : timeoutController.signal;

    try {
      response = await fetch(url, {
        signal: fetchSignal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : '';
      const aborted =
        name === 'AbortError' ||
        message.toLowerCase().includes('abort') ||
        fetchSignal.aborted;
      if (aborted) {
        // Prefer outer cancel over the local 30s budget when both could apply.
        if (parentAbort?.aborted && !timeoutController.signal.aborted) {
          return genericBuiltInToolOutcome('web_fetch', 'Request was cancelled.', 'cancelled');
        }
        return genericBuiltInToolOutcome('web_fetch', 'Error: Request timed out after 30 seconds.', 'error');
      }
      return genericBuiltInToolOutcome('web_fetch', `Error: ${message}`, 'error');
    } finally {
      clearTimeout(timeoutId);
    }

    if (parentAbort?.aborted) {
      return genericBuiltInToolOutcome('web_fetch', 'Request was cancelled.', 'cancelled');
    }

    // Check HTTP status
    if (!response.ok) {
      return genericBuiltInToolOutcome('web_fetch', `Error: Request failed with HTTP status ${response.status}.`, 'error');
    }

    // Read response body with size limit
    let body: string;
    try {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_SIZE) {
        return genericBuiltInToolOutcome('web_fetch', `Error: Response body exceeds ${MAX_BODY_SIZE} bytes limit.`, 'error');
      }
      body = new TextDecoder().decode(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return genericBuiltInToolOutcome('web_fetch', `Error: Failed to read response: ${message}`, 'error');
    }

    // Get final URL (after redirects)
    const finalUrl = response.url || url;
    const contentType = response.headers.get('content-type') || 'unknown';
    const isHtml = contentType.toLowerCase().includes('text/html');

    // Process content
    const content = isHtml ? htmlToMarkdown(body) : body;
    const title = isHtml ? extractTitle(body) : '';

    if (!query) {
      return buildRawResult(
        finalUrl,
        title,
        contentType,
        content,
        ctx?.sessionId ?? options?.sessionId,
        options?.cacheRoot,
      );
    }

    // Summarize mode
    if (!options?.summarize) {
      return genericBuiltInToolOutcome('web_fetch', 'Error: Summarize mode requires a summarize callback. ' +
          'Omit query to get the page content directly.', 'error');
    }

    if (parentAbort?.aborted) {
      return genericBuiltInToolOutcome('web_fetch', 'Request was cancelled.', 'cancelled');
    }

    try {
      const answer = await options.summarize(
        finalUrl,
        title,
        contentType,
        content,
        query,
        ctx,
      );

      return genericBuiltInToolOutcome('web_fetch', {
        url: finalUrl,
        title: title || '(none)',
        contentType,
        content: answer,
        length: content.length,
      }, 'complete');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (parentAbort?.aborted) {
        return genericBuiltInToolOutcome('web_fetch', 'Request was cancelled.', 'cancelled');
      }
      return genericBuiltInToolOutcome('web_fetch', `Error: ${message}`, 'error');
    }
  };

  return { definition, handler };
}

// ---------------------------------------------------------------------------
// Raw result builder
// ---------------------------------------------------------------------------

/**
 * Build the raw mode result. If content exceeds threshold and a session ID
 * is available, writes to a cache file.
 */
function buildRawResult(
  url: string,
  title: string,
  contentType: string,
  content: string,
  sessionId?: string,
  cacheRoot: string = HOME_CONFIG_DIR,
): WebFetchResult {
  if (content.length < RAW_CONTENT_THRESHOLD) {
    return genericBuiltInToolOutcome('web_fetch', {
      url, title, contentType, content, length: content.length,
    }, 'complete');
  }

  if (!sessionId) {
    return genericBuiltInToolOutcome('web_fetch', 'Error: Large raw web_fetch results require an active session for cache storage.', 'error');
  }

  try {
    const filePath = writeCacheFile(cacheRoot, sessionId, url, content);
    return genericBuiltInToolOutcome('web_fetch', {
      url, title, contentType, content: '', length: content.length,
      cachePath: filePath,
      warning: 'Content exceeded ' + RAW_CONTENT_THRESHOLD +
        ' characters and was written to cache - ' + filePath +
        ', use grep and read tools to get the result',
    }, 'complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return genericBuiltInToolOutcome('web_fetch', `Error: ${message}`, 'error');
  }
}
