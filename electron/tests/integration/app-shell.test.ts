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
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IPC_CHANNELS,
  ALLOWED_INVOKE_CHANNELS,
  ALLOWED_EVENT_CHANNELS,
} from '../../src/shared/types/ipc';
import type { OrchidAPI } from '../../src/shared/types/ipc';
import {
  chatSendSchema,
  configSaveSchema,
  sessionLoadSchema,
  toolExecuteSchema,
} from '../../src/main/ipc/payload-schemas';

// ─── IPC Channel Structure ───────────────────────────────────────────────────

describe('IPC Channel Names', () => {
  it('all channels follow the namespace:action format', () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      expect(channel).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
  });

  it('chat channels are defined', () => {
    expect(IPC_CHANNELS.CHAT_SEND).toBe('chat:send');
    expect(IPC_CHANNELS.CHAT_CANCEL).toBe('chat:cancel');
    expect(IPC_CHANNELS.CHAT_CHUNK).toBe('chat:chunk');
    expect(IPC_CHANNELS.CHAT_STATE).toBe('chat:state');
    expect(IPC_CHANNELS.CHAT_DONE).toBe('chat:done');
    expect(IPC_CHANNELS.SUBAGENTS_SNAPSHOT).toBe('subagents:snapshot');
    expect(IPC_CHANNELS.SUBAGENTS_EVENT).toBe('subagents:event');
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
    expect(IPC_CHANNELS.SESSION_CLEAR_ACTIVE).toBe('session:clear_active');
    expect(IPC_CHANNELS.SESSION_CREATED).toBe('session:created');
    expect(IPC_CHANNELS.SESSION_DELETE).toBe('session:delete');
    expect(IPC_CHANNELS.SESSION_RENAME).toBe('session:rename');
  });

  it('tool channels are defined', () => {
    expect(IPC_CHANNELS.TOOL_EXECUTE).toBe('tool:execute');
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

describe('progressive startup shell', () => {
  it('seeds a local, accessible startup shell before the renderer module', () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
    const shellIndex = indexHtml.indexOf('class="startup-shell"');
    const moduleIndex = indexHtml.indexOf('<script type="module" src="./main.tsx"></script>');

    expect(shellIndex).toBeGreaterThan(-1);
    expect(shellIndex).toBeLessThan(moduleIndex);
    expect(indexHtml).toContain('./assets/orchid-icon.svg');
    expect(indexHtml).toContain('role="status"');
    expect(indexHtml).toContain('aria-live="polite"');
    expect(indexHtml).toContain('background: #09090b');
    expect(indexHtml).toContain('prefers-reduced-motion: reduce');
  });

  it('loads Google Fonts as a non-blocking enhancement', () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/index.html'), 'utf8');

    expect(indexHtml).toContain('fonts.googleapis.com');
    expect(indexHtml).toMatch(/media="print"[\s\S]*onload="this\.media='all'"/);
  });
});

// ─── IPC Security ────────────────────────────────────────────────────────────

describe('IPC Security', () => {
  it('allowed invoke channels list matches IPC_CHANNELS', () => {
    // All invoke channels should be in the allowed list
    const invokeChannels = [
      IPC_CHANNELS.CHAT_SEND,
      IPC_CHANNELS.SUBAGENTS_SNAPSHOT,
      IPC_CHANNELS.CHAT_CANCEL,
      IPC_CHANNELS.CONFIG_GET,
      IPC_CHANNELS.CONFIG_SAVE,
      IPC_CHANNELS.PROVIDERS_DELETE,
      IPC_CHANNELS.SESSION_LIST,
      IPC_CHANNELS.SESSION_LOAD,
      IPC_CHANNELS.SESSION_CREATE,
      IPC_CHANNELS.SESSION_CLEAR_ACTIVE,
      IPC_CHANNELS.SESSION_DELETE,
      IPC_CHANNELS.SESSION_RENAME,
      IPC_CHANNELS.TOOL_EXECUTE,
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
      IPC_CHANNELS.CHAT_THINKING,
      IPC_CHANNELS.CHAT_STATE,
      IPC_CHANNELS.CHAT_DONE,
      IPC_CHANNELS.CHAT_ERROR,
      IPC_CHANNELS.CHAT_USAGE,
      IPC_CHANNELS.CHAT_TOOL_CALL_START,
      IPC_CHANNELS.CHAT_TOOL_CALL_DELTA,
      IPC_CHANNELS.CHAT_TOOL_CALL_UPDATE,
      IPC_CHANNELS.SUBAGENTS_EVENT,
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

// ─── Zod Validation (production schemas) ─────────────────────────────────────

const SESSION_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('Zod Validation at Main-Process Boundary', () => {
  it('chat:send uses production schema (uuid sessionId, non-empty message)', () => {
    expect(chatSendSchema.safeParse({ message: 'hello' }).success).toBe(true);
    expect(
      chatSendSchema.safeParse({ message: 'hello', sessionId: SESSION_UUID }).success,
    ).toBe(true);

    // Non-uuid sessionId rejected (weaker local schemas used to accept 'abc')
    expect(
      chatSendSchema.safeParse({ message: 'hello', sessionId: 'abc' }).success,
    ).toBe(false);
    expect(chatSendSchema.safeParse({ message: '' }).success).toBe(false);
    expect(chatSendSchema.safeParse({ message: 123 }).success).toBe(false);
    expect(chatSendSchema.safeParse({}).success).toBe(false);
  });

  it('config:save uses production schema (known keys, rejects providers)', () => {
    expect(configSaveSchema.safeParse({ updates: { theme: 'dark' } }).success).toBe(true);
    expect(configSaveSchema.safeParse({ updates: {} }).success).toBe(true);

    // Unknown keys rejected
    expect(
      configSaveSchema.safeParse({ updates: { not_a_real_key: true } }).success,
    ).toBe(false);
    // Legacy providers rejected at boundary
    expect(
      configSaveSchema.safeParse({ updates: { providers: { x: {} } } }).success,
    ).toBe(false);
    // Strict: extra top-level keys rejected
    expect(
      configSaveSchema.safeParse({
        updates: { theme: 'dark' },
        providerRenames: [],
      }).success,
    ).toBe(false);
    expect(configSaveSchema.safeParse({}).success).toBe(false);
  });

  it('session:load uses production schema (uuid id)', () => {
    expect(sessionLoadSchema.safeParse({ id: SESSION_UUID }).success).toBe(true);
    expect(sessionLoadSchema.safeParse({ id: 'session-123' }).success).toBe(false);
    expect(sessionLoadSchema.safeParse({ id: '' }).success).toBe(false);
    expect(sessionLoadSchema.safeParse({}).success).toBe(false);
  });

  it('tool:execute uses production schema', () => {
    expect(toolExecuteSchema.safeParse({ name: 'read', args: { path: '/tmp' } }).success).toBe(true);
    expect(toolExecuteSchema.safeParse({ name: 'read', args: null }).success).toBe(true);
    expect(toolExecuteSchema.safeParse({ name: '', args: {} }).success).toBe(false);
    expect(toolExecuteSchema.safeParse({ args: {} }).success).toBe(false);
  });
});

// ─── API Surface Type (compile-time checks) ─────────────────────────────────

describe('OrchidAPI Type Surface', () => {
  it('OrchidAPI type has all required chat methods (compile-time)', () => {
    // This is a compile-time check: if the type is wrong, this file won't compile.
    // We verify the structure exists by checking the type definition.
    type ChatAPI = OrchidAPI['chat'];
    type ChatMethods = keyof ChatAPI;

    const chatMethods: ChatMethods[] = [
      'send',
      'cancel',
      'onChunk',
      'onThinking',
      'onState',
      'onDone',
      'onError',
      'onUsage',
      'onToolCallStart',
      'onToolCallDelta',
      'onToolCallUpdate',
    ];
    expect(chatMethods).toHaveLength(11);
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

    const agentMethods: AgentMethods[] = ['save', 'delete'];
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

    const ragMethods: RagMethods[] = ['status', 'index', 'clear', 'indexState', 'onProgress'];
    expect(ragMethods).toHaveLength(5);
  });

  it('OrchidAPI type has all required ast methods (compile-time)', () => {
    type AstAPI = OrchidAPI['ast'];
    type AstMethods = keyof AstAPI;

    const astMethods: AstMethods[] = ['status', 'index', 'indexState', 'onProgress'];
    expect(astMethods).toHaveLength(4);
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
    '--color-primary',
    '--color-primary-content',
    '--color-secondary',
    '--color-secondary-content',
    '--color-accent',
    '--color-accent-content',
    '--color-neutral',
    '--color-neutral-content',
    '--color-base-100',
    '--color-base-200',
    '--color-base-300',
    '--color-base-content',
    '--color-info',
    '--color-info-content',
    '--color-success',
    '--color-success-content',
    '--color-warning',
    '--color-warning-content',
    '--color-error',
    '--color-error-content',
    '--radius-selector',
    '--radius-field',
    '--radius-box',
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

  it('light theme defines all required CSS variables', () => {
    const css = readThemeCSS('light');
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
    const themeFiles = ['default', 'light', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'];
    for (const name of themeFiles) {
      const css = readThemeCSS(name);
      expect(css).toContain(':root');
    }
  });

  it('each theme has unique bg-primary value', () => {
    const themeFiles = ['default', 'light', 'solarized-light', 'bluey', 'windows-xp', 'green-terminal'];
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

  it('active renderer rules do not hard-code a palette', () => {
    const stylesDir = path.resolve(__dirname, '../../src/renderer/styles');
    const activeCss = [
      fs.readFileSync(path.join(stylesDir, 'components.css'), 'utf-8'),
      fs.readFileSync(path.join(stylesDir, 'markdown.css'), 'utf-8'),
      fs.readFileSync(path.join(stylesDir, 'exceptions.css'), 'utf-8'),
    ].join('\n');
    expect(activeCss).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(activeCss).not.toMatch(/rgba?\(/);
    expect(activeCss).toContain('var(--bg-primary)');
    expect(activeCss).toContain('var(--accent-primary)');
  });

  it('loads styles through the canonical index.css entry', () => {
    const mainTsx = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/main.tsx'), 'utf-8');
    const appTsx = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/App.tsx'), 'utf-8');
    const indexCss = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/styles/index.css'), 'utf-8');
    expect(mainTsx).toContain("./styles/index.css");
    expect(appTsx).not.toMatch(/import\s+['"]\.\/styles\/chat\.css['"]/);
    expect(indexCss).toMatch(/@import\s+["']\.\/components\.css["']/);
    expect(indexCss).toMatch(/@import\s+["']\.\/markdown\.css["']/);
    expect(indexCss).toMatch(/@import\s+["']\.\/exceptions\.css["']/);
    expect(indexCss).toMatch(/@import\s+["']\.\/primitives\.css["']/);
    expect(indexCss.toLowerCase()).not.toContain('daisyui');
  });

  it('CSS surface splits exist on disk and are imported by index.css', () => {
    const stylesDir = path.resolve(__dirname, '../../src/renderer/styles');
    expect(fs.existsSync(path.join(stylesDir, 'components-chat.css'))).toBe(true);
    expect(fs.existsSync(path.join(stylesDir, 'components-session.css'))).toBe(true);
    expect(fs.existsSync(path.join(stylesDir, 'components-config.css'))).toBe(true);

    const indexCss = fs.readFileSync(path.join(stylesDir, 'index.css'), 'utf-8');
    expect(indexCss).toMatch(/@import\s+["']\.\/components-chat\.css["']/);
    expect(indexCss).toMatch(/@import\s+["']\.\/components-session\.css["']/);
    expect(indexCss).toMatch(/@import\s+["']\.\/components-config\.css["']/);
  });

  it('chat.css is deleted and not imported', () => {
    const stylesDir = path.resolve(__dirname, '../../src/renderer/styles');
    expect(fs.existsSync(path.join(stylesDir, 'chat.css'))).toBe(false);

    const indexCss = fs.readFileSync(path.join(stylesDir, 'index.css'), 'utf-8');
    expect(indexCss).not.toMatch(/@import\s+["']\.\/chat\.css["']/);
  });

  it('preserves existing shell topology entry points', () => {
    const chatView = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/components/ChatView.tsx'),
      'utf-8',
    );
    expect(chatView).toContain('app-frame');
    expect(chatView).toContain('main-pane');
    expect(chatView).toMatch(/LeftSidebar|left-panel/);
    expect(chatView).toMatch(/Sidebar|right-panel/);
    expect(chatView).not.toMatch(/Focused Workspace/i);
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
  });

  it('each IPC handler file has register and unregister exports', () => {
    const handlerFiles = ['chat', 'config', 'session', 'tool', 'mcp', 'rag', 'ast', 'subagents'];
    const ipcDir = path.resolve(__dirname, '../../src/main/ipc');

    // Map file names to expected export name casing
    const nameMap: Record<string, string> = {
      chat: 'Chat',
      config: 'Config',
      session: 'Session',
      tool: 'Tool',
      mcp: 'MCP',
      rag: 'RAG',
      ast: 'AST',
      subagents: 'Subagent',
    };

    for (const name of handlerFiles) {
      const filePath = path.join(ipcDir, `${name}.ts`);
      const content = fs.readFileSync(filePath, 'utf-8');
      const capitalizedName = nameMap[name];
      expect(content).toContain(`export function register${capitalizedName}IPC`);
      expect(content).toContain(`export function unregister${capitalizedName}IPC`);
    }
  });

  it('each IPC handler validates payloads with production schemas', () => {
    const handlerFiles = ['chat', 'config', 'session', 'tool', 'rag', 'ast'];
    const ipcDir = path.resolve(__dirname, '../../src/main/ipc');

    // Schemas live in payload-schemas.ts (single source of truth for tests + handlers)
    const schemasPath = path.join(ipcDir, 'payload-schemas.ts');
    expect(fs.existsSync(schemasPath)).toBe(true);
    const schemasContent = fs.readFileSync(schemasPath, 'utf-8');
    expect(schemasContent).toContain("import { z } from 'zod'");

    for (const name of handlerFiles) {
      const filePath = path.join(ipcDir, `${name}.ts`);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain("from './payload-schemas'");
      expect(content).toContain('.safeParse(');
    }
  });
});

// ─── Theme Loader ────────────────────────────────────────────────────────────

describe('Theme Loader', () => {
  it('THEMES map has all 6 themes', async () => {
    const { THEMES, THEME_NAMES } = await import('../../src/renderer/themes/index');
    expect(Object.keys(THEMES)).toHaveLength(6);
    expect(THEME_NAMES).toContain('default');
    expect(THEME_NAMES).toContain('light');
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

  it('applies the theme at document scope and emits theme assets in production', () => {
    const loader = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/themes/index.ts'), 'utf-8');
    const viteConfig = fs.readFileSync(path.resolve(__dirname, '../../vite.config.ts'), 'utf-8');
    expect(loader).toContain('document.documentElement.dataset.theme');
    expect(loader).not.toContain('orchid:theme-applied');
    expect(viteConfig).toContain('orchid-theme-assets');
    expect(viteConfig).toContain('themes/${fileName}');
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
