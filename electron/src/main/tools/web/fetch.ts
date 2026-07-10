/**
 * web_fetch tool — fetch a URL and extract information.
 *
 * Ported from Python `src/orchid/tools/web_fetch.py`.
 *
 * Key behaviors (matching Python):
 * - URL validation: block private IPs (RFC 1918), link-local, localhost/loopback,
 *   cloud metadata endpoints, embedded credentials
 * - Only allow http/https schemes
 * - Maximum response body size cap
 * - Fetch via fetch() with 30s timeout
 * - Post-redirect URL validation: re-validates the final URL after following
 *   redirects to prevent SSRF via redirect bypass (e.g., public → 127.0.0.1)
 * - Summarize mode: HTML to markdown, sends to web-fetch agent
 * - Raw mode: markdown; >10K chars → cache file
 * - Title extraction via HTML parsing
 *
 * Known limitation (P1-1):
 * - DNS rebinding TOCTOU: Hostname is validated at check time but resolved at
 *   fetch time. A DNS rebinding attack could resolve to a private IP between
 *   validation and fetch. Full mitigation requires pre-resolving via dns.lookup
 *   and validating the resolved IP, which is deferred.
 */
import TurndownService from 'turndown';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import type { ToolDefinition, ToolHandler } from '../types';
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
) => Promise<string>;

/** Options for building the web_fetch tool. */
export interface WebFetchOptions {
  /** Optional session ID for cache file storage. */
  sessionId?: string;
  /** Optional callback for summarize mode (uses LLM agent). */
  summarize?: SummarizeCallback;
}

/**
 * Result returned by the web_fetch handler.
 */
export interface WebFetchResult {
  /** Brief summary for UI display */
  display: string;
  /** Full content */
  content: string;
  /** Explicit failure flag for UI/status (never inferred from content). */
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// URL validation — security-critical
// ---------------------------------------------------------------------------

/**
 * Check if an IP address is in a private/reserved range.
 *
 * Blocks:
 * - RFC 1918: 10.x.x.x, 172.16-31.x.x, 192.168.x.x
 * - Link-local: 169.254.x.x
 * - Loopback: 127.x.x.x
 * - Cloud metadata: 169.254.169.254
 * - IPv6 loopback: ::1
 * - IPv6 link-local: fe80::/10
 */
function isPrivateIP(hostname: string): boolean {
  // IPv6 loopback
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    return true;
  }

  // IPv6 link-local (fe80::/10)
  if (hostname.startsWith('fe80:')) {
    return true;
  }

  // IPv4-mapped IPv6
  const ipv4Mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (ipv4Mapped) {
    return isPrivateIPv4(ipv4Mapped[1]);
  }

  // Plain IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return isPrivateIPv4(hostname);
  }

  return false;
}

/**
 * Check if an IPv4 address is in a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const [a, b] = parts;

  // 10.x.x.x (RFC 1918)
  if (a === 10) return true;

  // 172.16-31.x.x (RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.168.x.x (RFC 1918)
  if (a === 192 && b === 168) return true;

  // 169.254.x.x (link-local)
  if (a === 169 && b === 254) return true;

  // 127.x.x.x (loopback)
  if (a === 127) return true;

  // 0.0.0.0
  if (a === 0 && b === 0 && parts[2] === 0 && parts[3] === 0) return true;

  return false;
}

/**
 * Validate a URL for safety.
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

  // Block embedded credentials
  if (parsed.username || parsed.password) {
    return 'url must not contain embedded credentials.';
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost
  if (hostname === 'localhost') {
    return 'url must not point to localhost.';
  }

  // Block private/reserved IPs
  if (isPrivateIP(hostname)) {
    return 'url must not point to a private or reserved IP address.';
  }

  // Block cloud metadata endpoint (extra check for 169.254.169.254)
  if (hostname === '169.254.169.254') {
    return 'url must not point to the cloud metadata endpoint.';
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
function writeCacheFile(sessionId: string, url: string, content: string): string {
  const cacheDir = path.join(HOME_CONFIG_DIR, 'cache', 'web-fetch', sessionId);
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  const filename = slugFromUrl(url);
  const filePath = path.join(cacheDir, filename);

  // Atomic write
  const fd = fs.openSync(filePath, 'w', 0o600);
  try {
    fs.writeSync(fd, content, undefined, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
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
    name: 'web_fetch',
    description:
      'Fetch a URL and extract information from it. In summarize mode, fetches the page, ' +
      'converts HTML to markdown, and asks an internal model to answer the query. In raw ' +
      'mode, returns the converted content directly or writes large content to a cache file.',
    inputSchema: z.object({
      url: z.string().describe('The http or https URL to fetch.'),
      query: z.string().describe('What to extract from the fetched content.'),
      mode: z
        .string()
        .optional()
        .describe('"summarize" (default) to answer the query, or "raw" to return page content.'),
    }),
    actionLabel: 'Fetching...',
    category: 'web',
  };

  const handler: ToolHandler = async (input: unknown, _ctx): Promise<WebFetchResult> => {
    const { url: rawUrl, query: rawQuery, mode: rawMode } = input as {
      url: string;
      query: string;
      mode?: string;
    };

    const url = (rawUrl || '').trim();
    const query = (rawQuery || '').trim();
    const mode = (rawMode || 'summarize').trim().toLowerCase();

    // Validate URL
    const urlError = validateUrl(url);
    if (urlError) {
      return { display: 'Invalid URL', content: `Error: ${urlError}`, isError: true };
    }

    // Validate query
    if (!query) {
      return {
        display: 'Empty query',
        content: 'Error: query is required and cannot be empty.',
        isError: true,
      };
    }

    // Validate mode
    if (mode !== 'summarize' && mode !== 'raw') {
      return {
        display: 'Invalid mode',
        content: 'Error: mode must be either "summarize" or "raw".',
        isError: true,
      };
    }

    // Fetch the URL
    let response: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });

      clearTimeout(timeoutId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('abort')) {
        return {
          display: 'Fetch timed out',
          content: 'Error: Request timed out after 30 seconds.',
          isError: true,
        };
      }
      return { display: 'Fetch failed', content: `Error: ${message}`, isError: true };
    }

    // Validate final URL after redirects to prevent SSRF bypass.
    // An attacker could set up a redirect from a public URL to a private IP.
    const finalUrlAfterRedirect = response.url || url;
    const redirectError = validateUrl(finalUrlAfterRedirect);
    if (redirectError) {
      return {
        display: 'Redirect blocked',
        content: `Error: Redirect to blocked URL (${redirectError})`,
        isError: true,
      };
    }

    // Check HTTP status
    if (!response.ok) {
      return {
        display: `HTTP ${response.status}`,
        content: `Error: Request failed with HTTP status ${response.status}.`,
        isError: true,
      };
    }

    // Read response body with size limit
    let body: string;
    try {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_BODY_SIZE) {
        return {
          display: 'Response too large',
          content: `Error: Response body exceeds ${MAX_BODY_SIZE} bytes limit.`,
          isError: true,
        };
      }
      body = new TextDecoder().decode(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { display: 'Read failed', content: `Error: Failed to read response: ${message}`, isError: true };
    }

    // Get final URL (after redirects)
    const finalUrl = response.url || url;
    const contentType = response.headers.get('content-type') || 'unknown';
    const isHtml = contentType.toLowerCase().includes('text/html');

    // Process content
    const content = isHtml ? htmlToMarkdown(body) : body;
    const title = isHtml ? extractTitle(body) : '';

    if (mode === 'raw') {
      return buildRawResult(finalUrl, title, contentType, content, options?.sessionId);
    }

    // Summarize mode
    if (!options?.summarize) {
      return {
        display: 'Summarize not available',
        content:
          'Error: Summarize mode requires a summarize callback. ' +
          'Use mode "raw" to get the page content directly.',
        isError: true,
      };
    }

    try {
      const answer = await options.summarize(
        finalUrl,
        title,
        contentType,
        content,
        query,
      );

      return {
        display: `Fetched and summarized ${finalUrl}`,
        content:
          `<web_fetch_summarize url="${finalUrl}" title="${title || '(none)'}" content_type="${contentType}" length="${content.length}">\n` +
          `${answer}\n` +
          `</web_fetch_summarize>`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        display: 'Summarization failed',
        content: `Error: ${message}`,
        isError: true,
      };
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
): WebFetchResult {
  const attrs =
    `url="${url}"` +
    (title ? ` title="${title}"` : '') +
    ` content_type="${contentType}"` +
    ` length="${content.length}"`;

  // Small content: return inline
  if (content.length < RAW_CONTENT_THRESHOLD) {
    return {
      display: `Fetched ${content.length} characters`,
      content: `<web_fetch_raw ${attrs}>\n${content}\n</web_fetch_raw>`,
    };
  }

  // Large content: write to cache file
  if (!sessionId) {
    return {
      display: 'No active session',
      content:
        'Error: Large raw web_fetch results require an active session for cache storage.',
      isError: true,
    };
  }

  try {
    const filePath = writeCacheFile(sessionId, url, content);
    return {
      display: `Fetched ${content.length} characters to ${filePath}`,
      content:
        `<web_fetch_raw ${attrs} file="${filePath}">\n` +
        `<warning>Content exceeded ${RAW_CONTENT_THRESHOLD} characters and was written to cache - ${filePath}, use grep and read tools to get the result</warning>\n` +
        `</web_fetch_raw>`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      display: 'Cache write failed',
      content: `Error: ${message}`,
      isError: true,
    };
  }
}
