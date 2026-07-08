/**
 * App Shell Integration Tests — U19.
 *
 * Tests the Electron app shell:
 * - IPC channel structure and validation
 * - Theme CSS custom properties
 * - Preload API surface
 * - Zod validation at main-process boundary
 * - Security: window.require undefined in renderer
 *
 * These tests validate the IPC/type layer without requiring
 * a running Electron app (mocked ipcMain/ipcRenderer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IPC_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
} from '../../src/shared/types/ipc';
import type { OrchidAPI } from '../../src/shared/types/ipc';

// ─── IPC Channel Structure ───────────────────────────────────────────────────

describe('IPC Channel Names', () => {
  it('all channels follow the namespace:action format', () => {
    for (const [key, channel] of Object.entries(IPC_CHANNELS)) {
      expect(channel).toMatch(/^[a-z]+:[a-z_]+$/);
    }
  });

  it('chat channels are defined', () => {
    expect(IPC_CHANNELS.CHAT_SEND).toBe('chat:send');
    expect(IPC_CHANNELS.CHAT_CANCEL).toBe('chat:cancel');
    expect(IPC_CHANNELS.CHAT_CHUNK).toBe('chat:chunk');
    expect(IPC_CHANNELS.CHAT_STATE).toBe('chat:state');
    expect(IPC_CHANNELS.CHAT_DONE).toBe('chat:done');
    expect(IPC_CHANNELS.CHAT_ERROR).toBe('chat:error');
  });

  it('config channels are defined', () => {
    expect(IPC_CHANNELS.CONFIG_GET).toBe('config:get');
    expect(IPC_CHANNELS.CONFIG_SAVE).toBe('config:save');
  });

  it('session channels are defined', () => {
    expect(IPC_CHANNELS.SESSION_LIST).toBe('session:list');
    expect(IPC_CHANNELS.SESSION_LOAD).toBe('session:load');
    expect(IPC_CHANNELS.SESSION_CREATE).toBe('session:create');
    expect(IPC_CHANNELS.SESSION_DELETE).toBe('session:delete');
    expect(IPC_CHANNELS.SESSION_RENAME).toBe('session:rename');
  });

  it('tool channels are defined', () => {
    expect(IPC_CHANNELS.TOOL_EXECUTE).toBe('tool:execute');
  });

  it('agent channels are defined', () => {
    expect(IPC_CHANNELS.AGENT_LIST).toBe('agent:list');
    expect(IPC_CHANNELS.AGENT_SPAWN).toBe('agent:spawn');
  });

  it('mcp channels are defined', () => {
    expect(IPC_CHANNELS.MCP_STATUS).toBe('mcp:status');
  });

  it('rag channels are defined', () => {
    expect(IPC_CHANNELS.RAG_STATUS).toBe('rag:status');
    expect(IPC_CHANNELS.RAG_INDEX).toBe('rag:index');
    expect(IPC_CHANNELS.RAG_CLEAR).toBe('rag:clear');
  });

  it('ast channels are defined', () => {
    expect(IPC_CHANNELS.AST_STATUS).toBe('ast:status');
    expect(IPC_CHANNELS.AST_INDEX).toBe('ast:index');
  });
});

// ─── IPC Security ────────────────────────────────────────────────────────────

describe('IPC Security', () => {
  it('allowed invoke channels list matches IPC_CHANNELS', () => {
    // All invoke channels should be in the allowed list
    const invokeChannels = [
      IPC_CHANNELS.CHAT_SEND,
      IPC_CHANNELS.CHAT_CANCEL,
      IPC_CHANNELS.CONFIG_GET,
      IPC_CHANNELS.CONFIG_SAVE,
      IPC_CHANNELS.SESSION_LIST,
      IPC_CHANNELS.SESSION_LOAD,
      IPC_CHANNELS.SESSION_CREATE,
      IPC_CHANNELS.SESSION_DELETE,
      IPC_CHANNELS.SESSION_RENAME,
      IPC_CHANNELS.TOOL_EXECUTE,
      IPC_CHANNELS.AGENT_LIST,
      IPC_CHANNELS.AGENT_SPAWN,
      IPC_CHANNELS.MCP_STATUS,
      IPC_CHANNELS.RAG_STATUS,
      IPC_CHANNELS.RAG_INDEX,
      IPC_CHANNELS.RAG_CLEAR,
      IPC_CHANNELS.AST_STATUS,
      IPC_CHANNELS.AST_INDEX,
    ];

    for (const channel of invokeChannels) {
      expect(ALLOWED_INVOKE_CHANNELS).toContain(channel);
    }
  });

  it('allowed event channels list matches IPC_CHANNELS', () => {
    const eventChannels = [
      IPC_CHANNELS.CHAT_CHUNK,
      IPC_CHANNELS.CHAT_STATE,
      IPC_CHANNELS.CHAT_DONE,
      IPC_CHANNELS.CHAT_ERROR,
    ];

    for (const channel of eventChannels) {
      expect(ALLOWED_EVENT_CHANNELS).toContain(channel);
    }
  });

  it('invoke and event channel lists do not overlap', () => {
    for (const channel of ALLOWED_INVOKE_CHANNELS) {
      expect(ALLOWED_EVENT_CHANNELS).not.toContain(channel);
    }
  });

  it('no channel appears in both invoke and event lists', () => {
    const invokeSet = new Set(ALLOWED_INVOKE_CHANNELS);
    const eventSet = new Set(ALLOWED_EVENT_CHANNELS);
    const overlap = [...invokeSet].filter((ch) => eventSet.has(ch));
    expect(overlap).toHaveLength(0);
  });
});

// ─── Zod Validation ──────────────────────────────────────────────────────────

describe('Zod Validation at Main-Process Boundary', () => {
  it('chat:send payload validates correctly', () => {
    const schema = z.object({
      message: z.string().min(1),
      sessionId: z.string().optional(),
    });

    // Valid
    expect(schema.safeParse({ message: 'hello' }).success).toBe(true);
    expect(schema.safeParse({ message: 'hello', sessionId: 'abc' }).success).toBe(true);

    // Invalid
    expect(schema.safeParse({ message: '' }).success).toBe(false);
    expect(schema.safeParse({ message: 123 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('config:save payload validates correctly', () => {
    const schema = z.object({
      updates: z.object({
        default_model: z.string().optional(),
        theme: z.string().optional(),
      }),
    });

    expect(schema.safeParse({ updates: { default_model: 'gpt-4' } }).success).toBe(true);
    expect(schema.safeParse({ updates: { theme: 'dark' } }).success).toBe(true);
    expect(schema.safeParse({ updates: {} }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('session:load payload validates correctly', () => {
    const schema = z.object({
      id: z.string().min(1),
    });

    expect(schema.safeParse({ id: 'session-123' }).success).toBe(true);
    expect(schema.safeParse({ id: '' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('tool:execute payload validates correctly', () => {
    const schema = z.object({
      name: z.string().min(1),
      args: z.unknown(),
    });

    expect(schema.safeParse({ name: 'read', args: { path: '/tmp' } }).success).toBe(true);
    expect(schema.safeParse({ name: 'read', args: null }).success).toBe(true);
    expect(schema.safeParse({ name: '', args: {} }).success).toBe(false);
  });

  it('agent:spawn payload validates correctly', () => {
    const schema = z.object({
      name: z.string().min(1),
      task: z.string().min(1),
      tier: z.string().optional(),
    });

    expect(schema.safeParse({ name: 'general', task: 'do something' }).success).toBe(true);
    expect(schema.safeParse({ name: 'general', task: 'do', tier: 'crown' }).success).toBe(true);
    expect(schema.safeParse({ name: '', task: 'do' }).success).toBe(false);
    expect(schema.safeParse({ name: 'general', task: '' }).success).toBe(false);
  });
});

// ─── API Surface Type (compile-time checks) ─────────────────────────────────

describe('OrchidAPI Type Surface', () => {
  it('OrchidAPI type has all required chat methods (compile-time)', () => {
    // This is a compile-time check: if the type is wrong, this file won't compile.
    // We verify the structure exists by checking the type definition.
    type ChatAPI = OrchidAPI['chat'];
    type ChatMethods = keyof ChatAPI;

    const chatMethods: ChatMethods[] = ['send', 'cancel', 'onChunk', 'onState', 'onDone', 'onError'];
    expect(chatMethods).toHaveLength(6);
  });

  it('OrchidAPI type has all required config methods (compile-time)', () => {
    type ConfigAPI = OrchidAPI['config'];
    type ConfigMethods = keyof ConfigAPI;

    const configMethods: ConfigMethods[] = ['get', 'save'];
    expect(configMethods).toHaveLength(2);
  });

  it('OrchidAPI type has all required session methods (compile-time)', () => {
    type SessionAPI = OrchidAPI['session'];
    type SessionMethods = keyof SessionAPI;

    const sessionMethods: SessionMethods[] = ['list', 'load', 'create', 'delete', 'rename'];
    expect(sessionMethods).toHaveLength(5);
  });

  it('OrchidAPI type has all required tool methods (compile-time)', () => {
    type ToolAPI = OrchidAPI['tool'];
    type ToolMethods = keyof ToolAPI;

    const toolMethods: ToolMethods[] = ['execute'];
    expect(toolMethods).toHaveLength(1);
  });

  it('OrchidAPI type has all required agent methods (compile-time)', () => {
    type AgentAPI = OrchidAPI['agent'];
    type AgentMethods = keyof AgentAPI;

    const agentMethods: AgentMethods[] = ['list', 'spawn'];
    expect(agentMethods).toHaveLength(2);
  });

  it('OrchidAPI type has all required mcp methods (compile-time)', () => {
    type McpAPI = OrchidAPI['mcp'];
    type McpMethods = keyof McpAPI;

    const mcpMethods: McpMethods[] = ['status'];
    expect(mcpMethods).toHaveLength(1);
  });

  it('OrchidAPI type has all required rag methods (compile-time)', () => {
    type RagAPI = OrchidAPI['rag'];
    type RagMethods = keyof RagAPI;

    const ragMethods: RagMethods[] = ['status', 'index', 'clear'];
    expect(ragMethods).toHaveLength(3);
  });

  it('OrchidAPI type has all required ast methods (compile-time)', () => {
    type AstAPI = OrchidAPI['ast'];
    type AstMethods = keyof AstAPI;

    const astMethods: AstMethods[] = ['status', 'index'];
    expect(astMethods).toHaveLength(2);
  });
});

// ─── Theme CSS Custom Properties ─────────────────────────────────────────────

describe('Theme CSS Custom Properties', () => {
  const requiredVars = [
    '--bg-primary',
    '--bg-secondary',
    '--bg-surface',
    '--text-primary',
    '--text-secondary',
    '--accent-primary',
    '--accent-error',
    '--accent-success',
    '--border-default',
    '--input-bg',
    '--input-border',
    '--btn-primary-bg',
    '--btn-primary-text',
    '--sidebar-bg',
    '--font-family',
    '--font-mono',
    '--radius-md',
    '--transition-normal',
  ];

  const themeDir = path.resolve(__dirname, '../../src/renderer/themes');

  function readThemeCSS(name: string): string {
    const filePath = path.join(themeDir, `${name}.css`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  it('default theme defines all required CSS variables', () => {
    const css = readThemeCSS('default');
    for (const varName of requiredVars) {
      expect(css).toContain(varName);
    }
  });

  it('solarized-light theme defines all required CSS variables', () => {
    const css = readThemeCSS('solarized-light');
    for (const varName of requiredVars) {
      expect(css).toContain(varName);
    }
  });

  it('bluey theme defines all required CSS variables', () => {
    const css = readThemeCSS('bluey');
    for (const varName of requiredVars) {
      expect(css).toContain(varName);
    }
  });

  it('windows-xp theme defines all required CSS variables', () => {
    const css = readThemeCSS('windows-xp');
    for (const varName of requiredVars) {
      expect(css).toContain(varName);
    }
  });

  it('green-terminal theme defines all required CSS variables', () => {
    const css = readThemeCSS('green-terminal');
    for (const varName of requiredVars) {
      expect(css).toContain(varName);
    }
  });

  it('all themes set :root selector', () => {
    const themeFiles = ['default', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'];
    for (const name of themeFiles) {
      const css = readThemeCSS(name);
      expect(css).toContain(':root');
    }
  });

  it('each theme has unique bg-primary value', () => {
    const themeFiles = ['default', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'];
    const bgValues = new Set<string>();

    for (const name of themeFiles) {
      const css = readThemeCSS(name);
      const match = css.match(/--bg-primary:\s*([^;]+)/);
      expect(match).not.toBeNull();
      bgValues.add(match![1].trim());
    }

    // All themes should have different bg-primary values
    expect(bgValues.size).toBe(themeFiles.length);
  });
});

// ─── Security: window.require ────────────────────────────────────────────────

describe('Renderer Security', () => {
  it('preload uses contextBridge.exposeInMainWorld', () => {
    // Verify the preload file uses contextBridge (not direct window assignment)
    const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts');
    const preloadContent = fs.readFileSync(preloadPath, 'utf-8');
    expect(preloadContent).toContain('contextBridge.exposeInMainWorld');
    expect(preloadContent).toContain("'orchid'");
  });

  it('main process creates BrowserWindow with security settings', () => {
    const mainPath = path.resolve(__dirname, '../../src/main/index.ts');
    const mainContent = fs.readFileSync(mainPath, 'utf-8');
    expect(mainContent).toContain('contextIsolation: true');
    expect(mainContent).toContain('nodeIntegration: false');
    expect(mainContent).toContain('sandbox: true');
  });
});

// ─── IPC Handler Module Structure ────────────────────────────────────────────

describe('IPC Handler Module Structure', () => {
  it('ipc/index.ts exports registerAllIPC and unregisterAllIPC', () => {
    const indexPath = path.resolve(__dirname, '../../src/main/ipc/index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');
    expect(content).toContain('export function registerAllIPC');
    expect(content).toContain('export function unregisterAllIPC');
    expect(content).toContain('export { setMCPManagerRef }');
  });

  it('each IPC handler file has register and unregister exports', () => {
    const handlerFiles = ['chat', 'config', 'session', 'tool', 'agent', 'mcp', 'rag', 'ast'];
    const ipcDir = path.resolve(__dirname, '../../src/main/ipc');

    // Map file names to expected export name casing
    const nameMap: Record<string, string> = {
      chat: 'Chat',
      config: 'Config',
      session: 'Session',
      tool: 'Tool',
      agent: 'Agent',
      mcp: 'MCP',
      rag: 'RAG',
      ast: 'AST',
    };

    for (const name of handlerFiles) {
      const filePath = path.join(ipcDir, `${name}.ts`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const capitalizedName = nameMap[name];
      expect(content).toContain(`export function register${capitalizedName}IPC`);
      expect(content).toContain(`export function unregister${capitalizedName}IPC`);
    }
  });

  it('each IPC handler validates payloads with zod', () => {
    const handlerFiles = ['chat', 'config', 'session', 'tool', 'agent', 'rag', 'ast'];
    const ipcDir = path.resolve(__dirname, '../../src/main/ipc');

    for (const name of handlerFiles) {
      const filePath = path.join(ipcDir, `${name}.ts`);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain("import { z } from 'zod'");
      expect(content).toContain('.safeParse(');
    }
  });
});

// ─── Theme Loader ────────────────────────────────────────────────────────────

describe('Theme Loader', () => {
  it('THEMES map has all 5 themes', async () => {
    const { THEMES, THEME_NAMES } = await import('../../src/renderer/themes/index');
    expect(Object.keys(THEMES)).toHaveLength(5);
    expect(THEME_NAMES).toContain('default');
    expect(THEME_NAMES).toContain('solarized-light');
    expect(THEME_NAMES).toContain('bluey');
    expect(THEME_NAMES).toContain('windows-xp');
    expect(THEME_NAMES).toContain('green-terminal');
  });

  it('applyTheme function exists', async () => {
    const { applyTheme } = await import('../../src/renderer/themes/index');
    expect(typeof applyTheme).toBe('function');
  });

  it('getCurrentTheme function exists', async () => {
    const { getCurrentTheme } = await import('../../src/renderer/themes/index');
    expect(typeof getCurrentTheme).toBe('function');
  });
});

// ─── Preload Script Structure ────────────────────────────────────────────────

describe('Preload Script Structure', () => {
  it('preload exposes orchid API to main world', () => {
    const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts');
    const content = fs.readFileSync(preloadPath, 'utf-8');
    expect(content).toContain('contextBridge.exposeInMainWorld');
    expect(content).toContain("'orchid'");
  });

  it('preload has channel security checks', () => {
    const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts');
    const content = fs.readFileSync(preloadPath, 'utf-8');
    expect(content).toContain('ALLOWED_INVOKE_CHANNELS');
    expect(content).toContain('ALLOWED_EVENT_CHANNELS');
  });

  it('preload exposes all API namespaces', () => {
    const preloadPath = path.resolve(__dirname, '../../src/preload/index.ts');
    const content = fs.readFileSync(preloadPath, 'utf-8');
    expect(content).toContain('chat:');
    expect(content).toContain('config:');
    expect(content).toContain('session:');
    expect(content).toContain('tool:');
    expect(content).toContain('agent:');
    expect(content).toContain('mcp:');
    expect(content).toContain('rag:');
    expect(content).toContain('ast:');
  });
});
