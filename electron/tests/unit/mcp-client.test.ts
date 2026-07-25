/**
 * Tests for the MCP Client — U12.
 *
 * Covers:
 * - Start stdio server → tools registered → tool call works → shutdown clean
 * - SSE transport → tools registered → tool call works
 * - Per-server timeout → marked "failed" → others continue
 * - Overall timeout → remaining marked "unavailable"
 * - Tool `read-docs` from `context7` → registered as `mcp::context7::read-docs`
 * - Graceful degradation: one server fails → app works with rest
 * - Shutdown: all transports torn down cleanly
 *
 * Mock strategy: a queue of "instance configs" is consumed by the
 * mock Client factory. Each entry pre-configures what that instance's
 * methods will return. Tests push configs before calling startAll().
 *
 * IMPORTANT: We use vi.clearAllMocks() (not vi.restoreAllMocks()) in
 * afterEach because restoreAllMocks() would reset the vi.mock() factory
 * implementations, breaking all subsequent tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../../src/main/mcp/manager';

// ---------------------------------------------------------------------------
// Mock MCP SDK — queue-based instance configuration
// ---------------------------------------------------------------------------

interface MockInstanceConfig {
  listToolsResult?: unknown;
  listResourcesResult?: unknown;
  connectError?: Error;
  connectDelayMs?: number;
  callToolResult?: unknown;
  readResourceResult?: unknown;
}

const instanceConfigs: MockInstanceConfig[] = [];
const mockInstances: Array<Record<string, ReturnType<typeof vi.fn>>> = [];

function enqueueMock(config: MockInstanceConfig): void {
  instanceConfigs.push(config);
}

function createMockClientInstance() {
  const config = instanceConfigs.shift() ?? {};

  let connectImpl: () => Promise<void>;
  if (config.connectError) {
    const err = config.connectError;
    connectImpl = () => Promise.reject(err);
  } else if (config.connectDelayMs) {
    const ms = config.connectDelayMs;
    connectImpl = () => new Promise((resolve) => setTimeout(resolve, ms));
  } else {
    connectImpl = () => Promise.resolve();
  }

  const instance = {
    connect: vi.fn().mockImplementation(connectImpl),
    listTools: vi.fn().mockResolvedValue(
      config.listToolsResult && typeof config.listToolsResult === 'object' && 'tools' in config.listToolsResult
        ? config.listToolsResult
        : { tools: [] },
    ),
    listResources: vi.fn().mockResolvedValue(
      config.listResourcesResult && typeof config.listResourcesResult === 'object' && 'resources' in config.listResourcesResult
        ? config.listResourcesResult
        : { resources: [] },
    ),
    callTool: vi.fn().mockResolvedValue(
      config.callToolResult ?? { content: [{ type: 'text', text: 'default-result' }] },
    ),
    readResource: vi.fn().mockResolvedValue(
      config.readResourceResult ?? { contents: [{ text: 'default-content', uri: 'default://uri' }] },
    ),
    close: vi.fn().mockResolvedValue(undefined),
  };
  mockInstances.push(instance);
  return instance;
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () { return createMockClientInstance(); }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return { start: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function () {
    return { start: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

// Import mocked modules for assertions
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeStdioConfig(command = 'npx', args = ['-y', '@upstash/context7-mcp']) {
  return { command, args };
}

function makeSSEConfig(
  url = 'https://example.com/mcp/sse',
  headers?: Record<string, string>,
) {
  return { url, headers };
}

function toolsResult(tools: Array<{ name: string; description?: string }>) {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: { type: 'object', properties: {} },
    })),
  };
}

function resourcesResult(resources: Array<{ uri: string; name: string }>) {
  return { resources };
}

function callToolResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPManager', () => {
  let manager: MCPManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    instanceConfigs.length = 0;
    mockInstances.length = 0;
    manager = new MCPManager();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(async () => {
    try {
      await manager.shutdown();
    } catch {
      // Ignore
    }
    // Restore only the console spies — NOT the vi.mock() factories
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Basic lifecycle: stdio
  // ---------------------------------------------------------------------------

  describe('startAll + shutdown lifecycle (stdio)', () => {
    it('should start a stdio server, register tools, call a tool, and shut down cleanly', async () => {
      enqueueMock({
        listToolsResult: toolsResult([
          { name: 'resolve-library-id', description: 'Resolve a library name to an ID' },
          { name: 'query-docs', description: 'Query documentation' },
        ]),
        listResourcesResult: resourcesResult([{ uri: 'docs://readme', name: 'readme' }]),
      });

      await manager.startAll({ context7: makeStdioConfig() });

      // Tools registered with correct namespacing
      const tools = manager.getTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].definition.name).toBe('mcp::context7::resolve-library-id');
      expect(tools[1].definition.name).toBe('mcp::context7::query-docs');
      expect(tools[0].definition.category).toBe('mcp');

      // Statuses
      const statuses = manager.getStatus();
      expect(statuses).toHaveLength(1);
      expect(statuses[0].name).toBe('context7');
      expect(statuses[0].status).toBe('connected');
      expect(statuses[0].toolCount).toBe(2);
      expect(statuses[0].tools).toEqual(['query-docs', 'resolve-library-id']);
      expect(statuses[0].error).toBeNull();

      // StdioClientTransport was created with correct params
      expect(StdioClientTransport).toHaveBeenCalledWith({
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        env: undefined,
        cwd: undefined,
      });

      // Call a tool
      mockInstances[0].callTool.mockResolvedValueOnce(callToolResult('library-id-123'));
      const result = await manager.callTool('mcp::context7::resolve-library-id', {
        libraryName: 'react',
        query: 'hooks',
      });
      expect(mockInstances[0].callTool).toHaveBeenCalledWith(
        {
          name: 'resolve-library-id',
          arguments: { libraryName: 'react', query: 'hooks' },
        },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(result).toEqual(callToolResult('library-id-123'));

      // Shutdown clears all state
      await manager.shutdown();
      expect(mockInstances[0].close).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
      expect(manager.getStatus()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // SSE transport
  // ---------------------------------------------------------------------------

  describe('SSE transport', () => {
    it('should connect via SSE with headers, register tools, and call a tool', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'search', description: 'Search the web' }]),
        listResourcesResult: [],
      });

      await manager.startAll({
        tavily: makeSSEConfig('https://example.com/mcp/sse', { Authorization: 'Bearer token123' }),
      });

      expect(SSEClientTransport).toHaveBeenCalledWith(
        new URL('https://example.com/mcp/sse'),
        { requestInit: { headers: { Authorization: 'Bearer token123' } } },
      );

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('mcp::tavily::search');

      mockInstances[0].callTool.mockResolvedValueOnce(callToolResult('search results here'));
      const result = await manager.callTool('mcp::tavily::search', { query: 'MCP protocol' });
      expect(result).toEqual(callToolResult('search results here'));

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Tool namespacing
  // ---------------------------------------------------------------------------

  describe('tool namespacing', () => {
    it('should register `read-docs` from `context7` as `mcp::context7::read-docs`', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'read-docs', description: 'Read documentation' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ context7: makeStdioConfig() });

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('mcp::context7::read-docs');
      expect(tools[0].definition.description).toBe('Read documentation');
      expect(tools[0].definition.category).toBe('mcp');

      await manager.shutdown();
    });

    it('should handle tool names with hyphens and dots', async () => {
      enqueueMock({
        listToolsResult: toolsResult([
          { name: 'resolve-library-id', description: 'Resolve' },
          { name: 'query.docs', description: 'Query' },
        ]),
        listResourcesResult: [],
      });

      await manager.startAll({ 'my-server': makeStdioConfig() });

      const names = manager.getTools().map((t) => t.definition.name);
      expect(names).toContain('mcp::my-server::resolve-library-id');
      expect(names).toContain('mcp::my-server::query.docs');

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-server timeout → failed
  // ---------------------------------------------------------------------------

  describe('per-server timeout', () => {
    it('should mark a server as "failed" when per-server timeout fires, while others continue', async () => {
      // First server: slow connect (will timeout)
      enqueueMock({ connectDelayMs: 5000 });
      // Second server: normal
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'fast-tool', description: 'Fast tool' }]),
        listResourcesResult: [],
      });

      await manager.startAll(
        { slow: makeStdioConfig(), fast: makeStdioConfig() },
        { perServerTimeout: 100, startupTimeout: 10000 },
      );

      const statuses = manager.getStatus();
      const slowStatus = statuses.find((s) => s.name === 'slow');
      const fastStatus = statuses.find((s) => s.name === 'fast');

      expect(slowStatus?.status).toBe('failed');
      expect(slowStatus?.error).toContain('timed out');

      expect(fastStatus?.status).toBe('connected');
      expect(fastStatus?.toolCount).toBe(1);
      expect(fastStatus?.tools).toEqual(['fast-tool']);
      expect(slowStatus?.tools).toEqual([]);

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('mcp::fast::fast-tool');

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Overall timeout → unavailable
  // ---------------------------------------------------------------------------

  describe('overall timeout', () => {
    it('should mark remaining servers as "unavailable" when overall startup budget is exhausted', async () => {
      enqueueMock({ connectDelayMs: 5000 });
      enqueueMock({ connectDelayMs: 5000 });

      await manager.startAll(
        { server1: makeStdioConfig(), server2: makeStdioConfig() },
        { perServerTimeout: 10000, startupTimeout: 200 },
      );

      const statuses = manager.getStatus();
      const unavailable = statuses.filter((s) => s.status === 'unavailable');
      expect(unavailable.length).toBeGreaterThanOrEqual(1);

      for (const s of unavailable) {
        expect(s.error).toContain('timed out');
      }

      expect(manager.getTools()).toHaveLength(0);
      await manager.shutdown();
    });

    it('should clear all clients/tools and not leave connected ghosts after overall timeout', async () => {
      // Fast server connects and registers tools, then overall budget expires
      // while a second server is still connecting — must not leave tools on closed clients.
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'early-tool', description: 'Early' }]),
        listResourcesResult: { resources: [{ uri: 'res://early', name: 'early' }] },
      });
      enqueueMock({ connectDelayMs: 5000 });

      await manager.startAll(
        { early: makeStdioConfig(), late: makeStdioConfig() },
        { perServerTimeout: 10000, startupTimeout: 150 },
      );

      const statuses = manager.getStatus();
      expect(statuses.every((s) => s.status === 'failed' || s.status === 'unavailable')).toBe(true);
      expect(statuses.every((s) => s.status !== 'connected')).toBe(true);
      expect(statuses.every((s) => s.toolCount === 0)).toBe(true);

      expect(manager.getTools()).toHaveLength(0);
      const callResult = await manager.callTool('mcp::early::early-tool', {});
      expect(String(callResult)).toContain('not connected');

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Graceful degradation
  // ---------------------------------------------------------------------------

  describe('graceful degradation', () => {
    it('should allow the app to work with remaining servers when one fails', async () => {
      // First server fails to connect
      enqueueMock({ connectError: new Error('ENOENT: no such file or directory') });
      // Second server succeeds
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'search', description: 'Search' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ broken: makeStdioConfig('/nonexistent'), working: makeStdioConfig() });

      const statuses = manager.getStatus();
      const broken = statuses.find((s) => s.name === 'broken');
      const working = statuses.find((s) => s.name === 'working');

      expect(broken?.status).toBe('failed');
      expect(broken?.error).toContain('ENOENT');

      expect(working?.status).toBe('connected');

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].definition.name).toBe('mcp::working::search');

      await manager.shutdown();
    });

    it('should handle callTool on a failed server gracefully', async () => {
      enqueueMock({ connectError: new Error('Connection refused') });

      await manager.startAll({ broken: makeStdioConfig() });

      const result = await manager.callTool('mcp::broken::some-tool', {});
      expect(result).toBe("Error: MCP server 'broken' is not connected.");

      await manager.shutdown();
    });

    it('should handle readResource on a failed server gracefully', async () => {
      enqueueMock({ connectError: new Error('Connection refused') });

      await manager.startAll({ broken: makeStdioConfig() });

      const result = await manager.readResource('broken', 'test://uri');
      expect(result).toBe("Error: MCP server 'broken' is not connected.");

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Resource reading
  // ---------------------------------------------------------------------------

  describe('readResource', () => {
    it('should read text resources from a connected server', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'noop', description: 'No-op' }]),
        listResourcesResult: resourcesResult([{ uri: 'docs://api/reference', name: 'API Reference' }]),
        readResourceResult: {
          contents: [{ text: '# API Reference\n\nThis is the API reference.', uri: 'docs://api/reference' }],
        },
      });

      await manager.startAll({ 'docs-server': makeStdioConfig() });

      const content = await manager.readResource('docs-server', 'docs://api/reference');
      expect(content).toBe('# API Reference\n\nThis is the API reference.');
      expect(mockInstances[0].readResource).toHaveBeenCalledWith(
        { uri: 'docs://api/reference' },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      const listed = manager.listResources();
      expect(listed).toEqual([
        expect.objectContaining({
          uri: 'docs://api/reference',
          server: 'docs-server',
          name: 'API Reference',
        }),
      ]);
      expect(manager.getResourceServer('docs://api/reference')).toBe('docs-server');

      await manager.shutdown();
    });

    it('should handle binary resources with placeholder text', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'noop', description: 'No-op' }]),
        listResourcesResult: [],
        readResourceResult: {
          contents: [{ blob: 'base64encodeddata', mimeType: 'image/png', uri: 'img://logo' }],
        },
      });

      await manager.startAll({ 'img-server': makeStdioConfig() });

      const content = await manager.readResource('img-server', 'img://logo');
      expect(content).toContain('[binary resource: image/png');
      expect(content).toContain('base64 chars]');

      await manager.shutdown();
    });

    it('should concatenate multiple text content items', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'noop', description: 'No-op' }]),
        listResourcesResult: [],
        readResourceResult: {
          contents: [
            { text: 'Part 1', uri: 'multi://doc' },
            { text: 'Part 2', uri: 'multi://doc' },
          ],
        },
      });

      await manager.startAll({ server: makeStdioConfig() });

      const content = await manager.readResource('server', 'multi://doc');
      expect(content).toBe('Part 1\nPart 2');

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // callTool content handling
  // ---------------------------------------------------------------------------

  describe('callTool content handling', () => {
    it('should pass abort signal into the MCP SDK callTool options', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'slow', description: 'Slow tool' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });

      mockInstances[0].callTool.mockResolvedValueOnce(callToolResult('ok'));
      const ac = new AbortController();
      await manager.callTool('mcp::server::slow', { q: 1 }, { signal: ac.signal });

      expect(mockInstances[0].callTool).toHaveBeenCalledWith(
        { name: 'slow', arguments: { q: 1 } },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      // Outer abort is combined into the SDK signal
      const sdkSignal = mockInstances[0].callTool.mock.calls[0][2].signal as AbortSignal;
      expect(sdkSignal.aborted).toBe(false);
      ac.abort();
      expect(sdkSignal.aborted).toBe(true);

      await manager.shutdown();
    });

    it('should return cancelled when already aborted before call', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'slow', description: 'Slow tool' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });

      const ac = new AbortController();
      ac.abort();
      const result = await manager.callTool('mcp::server::slow', {}, { signal: ac.signal });
      expect(result).toBe("Error: MCP tool 'slow' was cancelled.");
      expect(mockInstances[0].callTool).not.toHaveBeenCalled();

      await manager.shutdown();
    });

    it('should preserve multiple text content blocks exactly', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'multi-text', description: 'Multi text' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });

      const rawResult = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
      };
      mockInstances[0].callTool.mockResolvedValueOnce(rawResult);

      const result = await manager.callTool('mcp::server::multi-text', {});
      expect(result).toEqual(rawResult);

      await manager.shutdown();
    });

    it('should preserve mixed content blocks exactly', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'mixed', description: 'Mixed content' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });

      const rawResult = {
        content: [
          { type: 'text', text: 'Here is the result:' },
          { type: 'image', mimeType: 'image/png', data: 'base64...' },
        ],
      };
      mockInstances[0].callTool.mockResolvedValueOnce(rawResult);

      const result = await manager.callTool('mcp::server::mixed', {});
      expect(result).toEqual(rawResult);

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw when startAll is called while already running', async () => {
      enqueueMock({ listToolsResult: [], listResourcesResult: [] });

      const firstStart = manager.startAll({ server: makeStdioConfig() });

      await expect(
        manager.startAll({ server2: makeStdioConfig() }),
      ).rejects.toThrow('MCPManager.startAll already in progress');

      await firstStart;
      await manager.shutdown();
    });

    it('should throw for invalid MCP tool name format in callTool', async () => {
      await expect(manager.callTool('not-a-valid-name', {})).rejects.toThrow('Invalid MCP tool name');
    });

    it('should throw for tool name without server component', async () => {
      await expect(manager.callTool('mcp::noseparator', {})).rejects.toThrow(
        "expected 'mcp::server::tool' format",
      );
    });

    it('should skip servers with invalid names', async () => {
      // Only the valid server gets a mock
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'tool', description: 'A tool' }]),
        listResourcesResult: [],
      });

      await manager.startAll({
        'INVALID_NAME!': makeStdioConfig(),
        valid: makeStdioConfig(),
      });

      const statuses = manager.getStatus();
      const invalid = statuses.find((s) => s.name === 'INVALID_NAME!');
      const valid = statuses.find((s) => s.name === 'valid');

      expect(invalid?.status).toBe('failed');
      expect(invalid?.error).toContain('invalid server name');

      expect(valid?.status).toBe('connected');

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  describe('shutdown', () => {
    it('should tear down all transports cleanly', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'tool1', description: 'Tool 1' }]),
        listResourcesResult: [],
      });
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'tool2', description: 'Tool 2' }]),
        listResourcesResult: [],
      });

      await manager.startAll({
        server1: makeStdioConfig(),
        server2: makeSSEConfig(),
      });

      expect(manager.getTools()).toHaveLength(2);

      await manager.shutdown();

      expect(mockInstances[0].close).toHaveBeenCalled();
      expect(mockInstances[1].close).toHaveBeenCalled();
      expect(manager.getTools()).toHaveLength(0);
      expect(manager.getStatus()).toHaveLength(0);
    });

    it('should handle close errors gracefully during shutdown', async () => {
      enqueueMock({ listToolsResult: [], listResourcesResult: [] });

      await manager.startAll({ server: makeStdioConfig() });
      mockInstances[0].close.mockRejectedValueOnce(new Error('close failed'));

      await expect(manager.shutdown()).resolves.toBeUndefined();
    });

    it('should be safe to call shutdown multiple times', async () => {
      enqueueMock({ listToolsResult: [], listResourcesResult: [] });

      await manager.startAll({ server: makeStdioConfig() });
      await manager.shutdown();
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple servers
  // ---------------------------------------------------------------------------

  describe('multiple servers', () => {
    it('should manage tools from multiple servers with correct namespacing', async () => {
      enqueueMock({
        listToolsResult: toolsResult([
          { name: 'resolve-library-id', description: 'Resolve library' },
          { name: 'query-docs', description: 'Query docs' },
        ]),
        listResourcesResult: [],
      });
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'search', description: 'Web search' }]),
        listResourcesResult: [],
      });

      await manager.startAll({
        context7: makeStdioConfig(),
        tavily: makeSSEConfig(),
      });

      const tools = manager.getTools();
      expect(tools).toHaveLength(3);

      const names = tools.map((t) => t.definition.name);
      expect(names).toContain('mcp::context7::resolve-library-id');
      expect(names).toContain('mcp::context7::query-docs');
      expect(names).toContain('mcp::tavily::search');

      // Each tool routes to the correct server
      mockInstances[0].callTool.mockResolvedValueOnce(callToolResult('library-123'));
      await manager.callTool('mcp::context7::resolve-library-id', { libraryName: 'react' });
      expect(mockInstances[0].callTool).toHaveBeenCalledWith(
        {
          name: 'resolve-library-id',
          arguments: { libraryName: 'react' },
        },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      mockInstances[1].callTool.mockResolvedValueOnce(callToolResult('search results'));
      await manager.callTool('mcp::tavily::search', { query: 'MCP' });
      expect(mockInstances[1].callTool).toHaveBeenCalledWith(
        {
          name: 'search',
          arguments: { query: 'MCP' },
        },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Tool handler integration
  // ---------------------------------------------------------------------------

  describe('tool handler', () => {
    it('should call the MCP tool when the handler is invoked', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'echo', description: 'Echo tool' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });

      const tools = manager.getTools();
      expect(tools).toHaveLength(1);

      mockInstances[0].callTool.mockResolvedValueOnce(callToolResult('echoed: hello'));

      const rawResult = callToolResult('echoed: hello');
      const result = await tools[0].handler({ message: 'hello' });
      expect(result).toEqual({
        status: 'complete',
        data: {
          value: rawResult,
          origin: { kind: 'mcp', name: 'mcp::server::echo' },
        },
      });

      expect(mockInstances[0].callTool).toHaveBeenCalledWith(
        {
          name: 'echo',
          arguments: { message: 'hello' },
        },
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      await manager.shutdown();
    });
  });

  // ---------------------------------------------------------------------------
  // Restart after shutdown
  // ---------------------------------------------------------------------------

  describe('restart after shutdown', () => {
    it('should allow starting again after shutdown', async () => {
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'tool1', description: 'Tool 1' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server: makeStdioConfig() });
      expect(manager.getTools()).toHaveLength(1);
      await manager.shutdown();

      // Second start with a fresh enqueue
      enqueueMock({
        listToolsResult: toolsResult([{ name: 'tool2', description: 'Tool 2' }]),
        listResourcesResult: [],
      });

      await manager.startAll({ server2: makeSSEConfig() });
      expect(manager.getTools()).toHaveLength(1);
      expect(manager.getTools()[0].definition.name).toBe('mcp::server2::tool2');

      await manager.shutdown();
    });
  });
});
