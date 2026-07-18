/**
 * MCPManager — manages MCP client sessions, transports, and tool lifecycle.
 *
 * Ported from src/orchid/mcp/__init__.py (MCPManager).
 *
 * Key design decisions (matching Python):
 *
 * 1. **Single-task lifecycle**: Transports are entered AND exited in one
 *    dedicated async context (the runner task). This avoids lifecycle issues
 *    analogous to anyio's cross-task cancel-scope error in Python.
 *
 * 2. **Graceful degradation**: Individual server failures are caught and
 *    marked "failed" — the loop continues. Overall startup timeout marks
 *    remaining servers "unavailable" and returns so the app stays usable
 *    without MCP.
 *
 * 3. **Per-server timeout**: Each server's connect+initialize+enumerate
 *    sequence is wrapped in a timeout budget (default 10s from config).
 *
 * 4. **Overall timeout**: The entire startup sequence has a budget
 *    (default 60s from config). If exhausted, the runner is torn down
 *    and non-terminal servers are marked "unavailable".
 *
 * 5. **Tool namespacing**: MCP tools are registered as
 *    `mcp::{server_name}::{tool_name}` to avoid collisions with built-in tools.
 *
 * Security note: MCP servers are external processes that register tools
 * dynamically and execute arbitrary code on the user's machine. No sandboxing,
 * tool-output validation, or capability restriction is implemented. MCP servers
 * are considered trusted (user-installed).
 */
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition, ToolHandler, RegisteredTool } from '../tools/types';
import type { MCPServerConfig, MCPServerStatus, MCPServerStatusValue } from './schema';
import { isValidServerName } from './schema';
import { createTransport } from './transport';
import {
  createDynamicToolOutcome,
  genericToolResultDataSchema,
} from '../../shared/types/tool-result';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface InternalServerStatus {
  status: MCPServerStatusValue;
  toolCount: number;
  error: string | null;
}

/** MCP resource metadata discovered at connect time. */
export interface MCPResourceInfo {
  uri: string;
  server: string;
  name?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// MCPManager
// ---------------------------------------------------------------------------

export class MCPManager {
  // Per-server MCP SDK clients
  private _clients = new Map<string, Client>();

  // Tools discovered from all servers: namespaced name → { definition, handler }
  private _tools = new Map<string, RegisteredTool>();

  // URI → resource metadata for listing/reading
  private _uriMap = new Map<string, MCPResourceInfo>();

  // Per-server status tracking
  private _serverStatus = new Map<string, InternalServerStatus>();

  // Lifecycle state
  private _runner: Promise<void> | null = null;
  private _readyResolve: (() => void) | null = null;
  private _readyPromise: Promise<void> | null = null;
  private _stopResolve: (() => void) | null = null;
  private _stopPromise: Promise<void> | null = null;
  private _startError: Error | null = null;

  // Timeout configuration (overridden by startAll from config)
  private _perServerTimeout = 10_000; // 10s default
  private _startupTimeout = 60_000;   // 60s default

  // Abort controller for the runner lifecycle
  private _runnerAbort: AbortController | null = null;

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start all configured MCP servers.
   *
   * Launches a dedicated runner task that connects to each server,
   * initializes sessions, and enumerates tools. Returns once all servers
   * have been processed or the overall startup budget is exhausted.
   *
   * @param servers - Map of server name → server config.
   * @param options - Optional timeout overrides.
   */
  async startAll(
    servers: Record<string, MCPServerConfig>,
    options?: { perServerTimeout?: number; startupTimeout?: number },
  ): Promise<void> {
    if (this._runner !== null) {
      throw new Error('MCPManager.startAll already in progress');
    }

    // Apply timeout configuration
    this._perServerTimeout = options?.perServerTimeout ?? this._perServerTimeout;
    this._startupTimeout = options?.startupTimeout ?? this._startupTimeout;

    // Reinitialize lifecycle state (supports restart after shutdown)
    this._readyPromise = new Promise<void>((resolve) => {
      this._readyResolve = resolve;
    });
    this._stopPromise = new Promise<void>((resolve) => {
      this._stopResolve = resolve;
    });
    this._startError = null;

    // Clean stale server entries not in the new config
    for (const [name] of this._serverStatus) {
      if (!(name in servers)) {
        this._serverStatus.delete(name);
      }
    }

    // Initialize all servers to "starting"
    for (const serverName of Object.keys(servers)) {
      this._serverStatus.set(serverName, {
        status: 'starting',
        toolCount: 0,
        error: null,
      });
    }

    // Launch the runner — owns transport lifecycle
    this._runnerAbort = new AbortController();
    this._runner = this._run(servers, this._runnerAbort.signal);

    // Wait for ready or overall timeout
    const overallTimeout = AbortSignal.timeout(this._startupTimeout);
    const combined = AbortSignal.any([this._runnerAbort.signal, overallTimeout]);

    try {
      await Promise.race([
        this._readyPromise,
        new Promise<void>((_, reject) => {
          if (combined.aborted) {
            reject(new Error('MCP startup aborted'));
            return;
          }
          combined.addEventListener('abort', () => {
            reject(new Error('MCP startup timed out'));
          }, { once: true });
        }),
      ]);
    } catch {
      // Overall budget exhausted — full teardown so no connected ghosts remain
      console.warn(
        `MCP startup timed out after ${this._startupTimeout / 1000}s; continuing with reduced MCP availability`,
      );
      await this._awaitRunner();

      const timeoutErr = `startup timed out after ${Math.round(this._startupTimeout / 1000)}s`;
      for (const [, status] of this._serverStatus) {
        if (status.status === 'failed') {
          continue;
        }
        // Runner already closed clients — any prior "connected" is a ghost
        status.status = status.status === 'connected' ? 'failed' : 'unavailable';
        status.error = timeoutErr;
        status.toolCount = 0;
      }

      // Drop all clients/tools/URIs — tools must not stay registered against closed clients
      this._clients.clear();
      this._tools.clear();
      this._uriMap.clear();
      return;
    }

    if (this._startError !== null) {
      await this._awaitRunner();
      throw this._startError;
    }
  }

  /**
   * Shut down all MCP transports and clear state.
   *
   * Signals the runner to stop, waits for it to close all transports,
   * then clears sessions and tools.
   */
  async shutdown(): Promise<void> {
    await this._awaitRunner();
    this._clients.clear();
    this._tools.clear();
    this._uriMap.clear();
    this._serverStatus.clear();
  }

  /**
   * Get all registered MCP tools.
   *
   * Returns tools with namespaced names (`mcp::{server}::{tool}`),
   * suitable for registration into the global ToolRegistry.
   */
  getTools(): RegisteredTool[] {
    return Array.from(this._tools.values());
  }

  /**
   * Call an MCP tool by its fully-qualified namespaced name.
   *
   * Parses `mcp::{server_name}::{tool_name}` to route to the correct server.
   *
   * @param name - Fully-qualified tool name (e.g. "mcp::context7::read-docs").
   * @param args - Tool arguments (validated by the MCP server's input schema).
   * @param options - Optional abort signal from tool-dispatch / parent cancel.
   * @returns The exact MCP result object. Canonical adapters validate JSON
   * safety and keep content blocks inert.
   */
  async callTool(
    name: string,
    args: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown> {
    const { serverName, toolName } = this._parseToolName(name);
    const client = this._clients.get(serverName);

    if (client === undefined) {
      return `Error: MCP server '${serverName}' is not connected.`;
    }

    if (options?.signal?.aborted) {
      return `Error: MCP tool '${toolName}' was cancelled.`;
    }

    const timeoutAbort = new AbortController();
    const combinedSignal =
      options?.signal !== undefined
        ? AbortSignal.any([options.signal, timeoutAbort.signal])
        : timeoutAbort.signal;
    const timeoutMessage = `MCP tool '${toolName}' on server '${serverName}' timed out after ${Math.round(this._perServerTimeout / 1000)}s`;

    let result: Awaited<ReturnType<typeof client.callTool>>;
    try {
      result = await this._withTimeout(
        client.callTool(
          { name: toolName, arguments: args as Record<string, unknown> },
          undefined,
          { signal: combinedSignal },
        ),
        this._perServerTimeout,
        timeoutMessage,
        timeoutAbort,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name_ = err instanceof Error ? err.name : '';
      if (options?.signal?.aborted && !timeoutAbort.signal.aborted) {
        return `Error: MCP tool '${toolName}' was cancelled.`;
      }
      if (
        message.toLowerCase().includes('timed out') ||
        name_ === 'AbortError' ||
        message.toLowerCase().includes('abort')
      ) {
        return `Error: ${timeoutMessage}`;
      }
      return `Error: MCP tool '${toolName}' failed: ${message}`;
    }

    return result;
  }

  /**
   * Read an MCP resource from the specified server.
   *
   * @param serverName - Name of the MCP server.
   * @param uri - Resource URI to read.
   * @param options - Optional abort signal from tool-dispatch / parent cancel.
   * @returns Resource content as string.
   */
  async readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<string> {
    const client = this._clients.get(serverName);

    if (client === undefined) {
      return `Error: MCP server '${serverName}' is not connected.`;
    }

    if (options?.signal?.aborted) {
      return `Error: MCP readResource '${uri}' was cancelled.`;
    }

    const timeoutAbort = new AbortController();
    const combinedSignal =
      options?.signal !== undefined
        ? AbortSignal.any([options.signal, timeoutAbort.signal])
        : timeoutAbort.signal;
    const timeoutMessage = `MCP readResource '${uri}' on server '${serverName}' timed out after ${Math.round(this._perServerTimeout / 1000)}s`;

    let result: Awaited<ReturnType<typeof client.readResource>>;
    try {
      result = await this._withTimeout(
        client.readResource({ uri }, { signal: combinedSignal }),
        this._perServerTimeout,
        timeoutMessage,
        timeoutAbort,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const name_ = err instanceof Error ? err.name : '';
      if (options?.signal?.aborted && !timeoutAbort.signal.aborted) {
        return `Error: MCP readResource '${uri}' was cancelled.`;
      }
      if (
        message.toLowerCase().includes('timed out') ||
        name_ === 'AbortError' ||
        message.toLowerCase().includes('abort')
      ) {
        return `Error: ${timeoutMessage}`;
      }
      return `Error: MCP readResource '${uri}' failed: ${message}`;
    }
    const parts: string[] = [];

    for (const item of result.contents) {
      if ('text' in item) {
        parts.push(item.text);
      } else if ('blob' in item) {
        const mime = item.mimeType ?? 'application/octet-stream';
        parts.push(`[binary resource: ${mime}, ${item.blob.length} base64 chars]`);
        console.debug(
          `MCP read_resource returned binary blob for '${uri}' (${mime}, ${item.blob.length} base64 chars)`,
        );
      }
    }

    return parts.join('\n');
  }

  /**
   * Look up which MCP server owns a given resource URI.
   *
   * @param uri - The resource URI to look up.
   * @returns The server name, or undefined if no server owns this URI.
   */
  getResourceServer(uri: string): string | undefined {
    return this._uriMap.get(uri)?.server;
  }

  /**
   * List all MCP resources discovered at connect time.
   *
   * @returns Resource entries with uri, server, and optional name/description.
   */
  listResources(): MCPResourceInfo[] {
    return Array.from(this._uriMap.values()).map((info) => ({ ...info }));
  }

  /**
   * Get the status of all configured MCP servers.
   */
  getStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    for (const [name, status] of this._serverStatus) {
      statuses.push({
        name,
        status: status.status,
        toolCount: status.toolCount,
        error: status.error,
      });
    }
    return statuses;
  }

  // ---------------------------------------------------------------------------
  // Runner lifecycle (private)
  // ---------------------------------------------------------------------------

  /**
   * Dedicated runner that owns the lifecycle of all transports.
   *
   * Connects to each server sequentially. If a server fails, it's marked
   * "failed" and the loop continues. The runner then idles until shutdown
   * is requested, at which point it closes all transports in reverse order.
   */
  private async _run(
    servers: Record<string, MCPServerConfig>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      // Connect to each server sequentially
      for (const [serverName, config] of Object.entries(servers)) {
        // If the overall abort signal fired, skip remaining servers.
        // They stay in "starting" status so startAll can mark them "unavailable".
        if (signal.aborted) break;

        try {
          await this._connectServer(serverName, config, signal);
          // Count tools for this server
          let toolCount = 0;
          for (const key of this._tools.keys()) {
            if (key.startsWith(`mcp::${serverName}::`)) {
              toolCount++;
            }
          }
          const status = this._serverStatus.get(serverName);
          if (status && status.status !== 'failed') {
            status.status = 'connected';
            status.toolCount = toolCount;
            status.error = null;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this._serverStatus.set(serverName, {
            status: 'failed',
            toolCount: 0,
            error: `${error.name}: ${error.message.slice(0, 80)}`,
          });
          console.warn(`Failed to start MCP server '${serverName}':`, error.message);
        }
      }
    } catch (err) {
      // Captured so startAll can re-raise after the runner unwinds
      this._startError = err instanceof Error ? err : new Error(String(err));
    } finally {
      // Signal that startup phase is complete
      this._readyResolve?.();

      // Idle until shutdown is requested
      try {
        await this._stopPromise;
      } catch {
        // Cancelled — continue to cleanup
      }

      // Close all clients (in reverse order for clean teardown)
      const clientEntries = Array.from(this._clients.entries()).reverse();
      for (const [name, client] of clientEntries) {
        try {
          await client.close();
        } catch {
          console.warn(`Error closing MCP client '${name}'`);
        }
      }
    }
  }

  /**
   * Connect to a single MCP server: create transport, connect client,
   * initialize, enumerate tools and resources.
   *
   * Wrapped in per-server timeout via AbortSignal.
   */
  private async _connectServer(
    serverName: string,
    config: MCPServerConfig,
    outerSignal: AbortSignal,
  ): Promise<void> {
    if (!isValidServerName(serverName)) {
      this._serverStatus.set(serverName, {
        status: 'failed',
        toolCount: 0,
        error: 'invalid server name (must match [a-z0-9-]+)',
      });
      return;
    }

    // Per-server timeout — one budget for connect+enumerate sequence
    const serverTimeout = AbortSignal.timeout(this._perServerTimeout);
    const combined = AbortSignal.any([outerSignal, serverTimeout]);
    const timeoutMessage = `MCP server '${serverName}' startup timed out after ${this._perServerTimeout / 1000}s`;

    // Create transport and client
    const transport = createTransport(config);
    const client = new Client(
      { name: 'orchid-electron', version: '0.1.0' },
      { capabilities: {} },
    );

    try {
      // Connect with timeout — combined covers per-server budget and overall abort
      await this._raceWithSignal(client.connect(transport), combined, timeoutMessage);

      this._clients.set(serverName, client);

      // Enumerate tools — also bounded by same per-server budget
      const toolsResult = await this._raceWithSignal(client.listTools(), combined, timeoutMessage);
      for (const tool of toolsResult.tools) {
        const registryName = `mcp::${serverName}::${tool.name}`;
        if (this._tools.has(registryName)) {
          console.warn(
            `MCP tool '${registryName}' from server '${serverName}' shadows existing registration`,
          );
        }

        const definition: ToolDefinition = {
          name: registryName,
          description: tool.description ?? '',
          inputSchema: this._jsonSchemaToZod(tool.inputSchema),
          resultFamily: 'generic',
          outputDataSchema: genericToolResultDataSchema,
          category: 'mcp',
        };

        const handler: ToolHandler = async (input: unknown, ctx) => {
          const raw = await this.callTool(registryName, input, {
            signal: ctx?.abortSignal,
          });
          if (typeof raw === 'string' && raw.startsWith('Error:')) {
            return createDynamicToolOutcome(registryName, raw, 'mcp', {
              status: ctx.abortSignal?.aborted || /cancelled/i.test(raw)
                ? 'cancelled'
                : 'error',
              errorCode: 'mcp_tool_error',
              errorMessage: raw,
            });
          }
          const serverReportedError = raw != null && typeof raw === 'object'
            && (raw as { isError?: unknown }).isError === true;
          return createDynamicToolOutcome(registryName, raw, 'mcp', {
            status: serverReportedError ? 'error' : 'complete',
            errorCode: 'mcp_tool_error',
            errorMessage: serverReportedError ? 'MCP tool reported an error.' : undefined,
          });
        };

        this._tools.set(registryName, { definition, handler });
      }

      // Enumerate resources — also bounded by same per-server budget
      const resourcesResult = await this._raceWithSignal(client.listResources(), combined, timeoutMessage);
      for (const resource of resourcesResult.resources) {
        this._uriMap.set(resource.uri, {
          uri: resource.uri,
          server: serverName,
          name: resource.name || undefined,
          description: resource.description || undefined,
        });
      }
    } catch (err) {
      try {
        await transport.close();
      } catch {
        // cleanup best-effort
      }
      try {
        await client.close();
      } catch {
        // cleanup best-effort
      }
      throw err;
    }
  }

  /**
   * Signal the runner to stop and wait for it to complete.
   *
   * If the runner doesn't stop within 3 seconds, it's cancelled.
   */
  private async _awaitRunner(timeout = 3_000): Promise<void> {
    this._stopResolve?.();
    this._runnerAbort?.abort();

    const runner = this._runner;
    if (runner !== null) {
      try {
        await Promise.race([
          runner,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('MCP shutdown timed out')), timeout),
          ),
        ]);
      } catch {
        console.warn('MCP shutdown timed out or runner ended with error');
      }
    }
    this._runner = null;
  }

  /**
   * Clear state for disconnected servers (after timeout or failure).
   */
  private _clearDisconnectedState(): void {
    for (const [name, status] of this._serverStatus) {
      if (status.status !== 'connected') {
        this._clients.delete(name);
      }
    }

    // Remove tools belonging to non-connected servers
    for (const [key] of Array.from(this._tools)) {
      const match = key.match(/^mcp::([^:]+)::/);
      if (match) {
        const serverName = match[1];
        const status = this._serverStatus.get(serverName);
        if (!status || status.status !== 'connected') {
          this._tools.delete(key);
        }
      }
    }

    // Remove URIs belonging to non-connected servers
    for (const [uri, info] of Array.from(this._uriMap)) {
      const status = this._serverStatus.get(info.server);
      if (!status || status.status !== 'connected') {
        this._uriMap.delete(uri);
      }
    }
  }

  /**
   * Parse a namespaced tool name into server and tool components.
   *
   * Format: `mcp::{server_name}::{tool_name}`
   * The tool name itself may contain `::` (though uncommon).
   */
  private _parseToolName(name: string): { serverName: string; toolName: string } {
    const prefix = 'mcp::';
    if (!name.startsWith(prefix)) {
      throw new Error(`Invalid MCP tool name '${name}': must start with 'mcp::'`);
    }

    const rest = name.slice(prefix.length);
    const separatorIdx = rest.indexOf('::');
    if (separatorIdx === -1) {
      throw new Error(`Invalid MCP tool name '${name}': expected 'mcp::server::tool' format`);
    }

    return {
      serverName: rest.slice(0, separatorIdx),
      toolName: rest.slice(separatorIdx + 2),
    };
  }

  private _withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
    abortController?: AbortController,
  ): Promise<T> {
    if (!Number.isFinite(ms) || ms <= 0) {
      abortController?.abort();
      promise.then(() => undefined, () => undefined);
      return Promise.reject(new Error(message));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController?.abort();
        reject(new Error(message));
      }, ms);
      if (typeof timer === 'object' && timer && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    });
    return Promise.race([
      promise.then(
        (v) => {
          if (timer !== undefined) clearTimeout(timer);
          return v;
        },
        (err: unknown) => {
          if (timer !== undefined) clearTimeout(timer);
          throw err;
        },
      ),
      timeoutPromise,
    ]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) promise.then(() => undefined, () => undefined);
    });
  }

  private _raceWithSignal<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    message: string,
  ): Promise<T> {
    if (signal.aborted) {
      promise.then(() => undefined, () => undefined);
      return Promise.reject(new Error(message));
    }
    let rejectOnAbort: (() => void) | undefined;
    const abortPromise = new Promise<T>((_, reject) => {
      rejectOnAbort = () => reject(new Error(message));
      signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    return Promise.race([
      promise.then(
        (v) => {
          if (rejectOnAbort !== undefined) signal.removeEventListener('abort', rejectOnAbort);
          return v;
        },
        (err: unknown) => {
          if (rejectOnAbort !== undefined) signal.removeEventListener('abort', rejectOnAbort);
          throw err;
        },
      ),
      abortPromise,
    ]).finally(() => {
      if (rejectOnAbort !== undefined) signal.removeEventListener('abort', rejectOnAbort);
      // If already aborted, swallow late rejection to avoid unhandled
      if (signal.aborted) {
        promise.then(() => undefined, () => undefined);
      }
    });
  }

  /**
   * Convert a JSON Schema object (from MCP tool) to a zod schema.
   *
   * MCP tools return their input schema as JSON Schema. We need a zod schema
   * for the ToolDefinition. For MCP tools, we store the raw JSON Schema
   * and use a passthrough z.object() as a lightweight wrapper — the real
   * validation happens server-side when the tool is called.
   *
   * This is a pragmatic approach: MCP tool schemas are opaque to us and
   * only the MCP server can fully validate them.
   */
  private _jsonSchemaToZod(_schema: Record<string, unknown>): z.ZodType {
    // Return a passthrough object schema — MCP tools validate their own inputs
    return z.object({}).passthrough();
  }
}
