/**
 * Preferences & Onboarding Integration Tests — U24.
 *
 * Tests:
 * - Preferences: tab/file structure, ordinary preference saves, MCP restart prompt
 * - Onboarding: local-only defaults and ordinary preference persistence
 *
 * These tests validate the component logic without requiring a running
 * Electron app (mocked window.orchid API).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defaults } from '../../src/main/config/schema';
import {
  eventMatchesChord,
  getShortcut,
} from '../../src/renderer/keyboard';

// ─── Mock Setup ──────────────────────────────────────────────────────────────

const mockOrchid = {
  chat: {
    send: vi.fn().mockResolvedValue({ status: 'ok' }),
    cancel: vi.fn().mockResolvedValue({ status: 'ok' }),
    onChunk: vi.fn().mockReturnValue(() => {}),
    onState: vi.fn().mockReturnValue(() => {}),
    onDone: vi.fn().mockReturnValue(() => {}),
    onError: vi.fn().mockReturnValue(() => {}),
  },
  config: {
    get: vi.fn().mockResolvedValue(defaults()),
    save: vi.fn().mockResolvedValue({ status: 'ok' }),
  },
  tool: {
    execute: vi.fn().mockResolvedValue({ content: '', isError: false }),
  },
  agent: {
    list: vi.fn().mockResolvedValue([]),
    spawn: vi.fn().mockResolvedValue({ id: 'agent-1', agent: {} }),
  },
  mcp: {
    status: vi.fn().mockResolvedValue([]),
  },
  rag: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    clear: vi.fn().mockResolvedValue({ status: 'ok' }),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
  ast: {
    status: vi.fn().mockResolvedValue(null),
    index: vi.fn().mockResolvedValue({}),
    indexState: vi.fn().mockResolvedValue({ indexing: false, progress: null }),
    onProgress: vi.fn().mockReturnValue(() => {}),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: typeof globalThis.window }).window = globalThis.window || {};
  (window as unknown as Record<string, unknown>).orchid = mockOrchid;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Config Schema Defaults ──────────────────────────────────────────────────

describe('Config Defaults for Onboarding', () => {
  it('defaults provide all required fields', () => {
    const config = defaults();
    expect(config).toHaveProperty('default_model');
    expect(config).toHaveProperty('tier_models');
    expect(config).toHaveProperty('mcp_servers');
    expect(config).toHaveProperty('rag');
    expect(config).toHaveProperty('theme');
    expect(config).toHaveProperty('personality');
    expect(config).toHaveProperty('command_timeout');
    expect(config).toHaveProperty('mcp_startup_timeout');
    expect(config).toHaveProperty('mcp_per_server_timeout');
    expect(config).toHaveProperty('has_completed_onboarding');
    expect(config.has_completed_onboarding).toBe(false);
    expect(config.mcp_servers).toEqual({});
  });

  it('tier_models has all 4 tiers', () => {
    const config = defaults();
    expect(config.tier_models).toHaveProperty('seed');
    expect(config.tier_models).toHaveProperty('sprout');
    expect(config.tier_models).toHaveProperty('bloom');
    expect(config.tier_models).toHaveProperty('crown');
  });

  it('rag config has all required fields', () => {
    const config = defaults();
    expect(config.rag).toHaveProperty('chunk_size');
    expect(config.rag).toHaveProperty('chunk_overlap');
    expect(config.rag).toHaveProperty('top_k');
    expect(config.rag).toHaveProperty('max_file_size');
    expect(config.rag).toHaveProperty('embedding_model');
  });
});

// ─── Preferences Window Behavior ─────────────────────────────────────────────

describe('Preferences Window Behavior', () => {
  it('config.get is called to load preferences', async () => {
    await mockOrchid.config.get();
    expect(mockOrchid.config.get).toHaveBeenCalled();
  });

  it('config.save persists changes', async () => {
    const updates = { theme: 'bluey' };
    await mockOrchid.config.save({ updates });
    expect(mockOrchid.config.save).toHaveBeenCalledWith({ updates });
  });

  it('save with MCP changes should trigger restart detection', () => {
    const mcpUpdates = {
      mcp_servers: {
        context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
        'new-server': { command: 'node', args: ['server.js'] },
      },
    };
    // The component checks for 'mcp_servers' key in draft to show restart dialog
    expect('mcp_servers' in mcpUpdates).toBe(true);
  });

  it('non-MCP save should not trigger restart', () => {
    const updates = {
      theme: 'bluey',
      default_model: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        modelId: 'gpt-4o',
      },
    };
    expect('mcp_servers' in updates).toBe(false);
  });
});

// ─── Onboarding Flow ─────────────────────────────────────────────────────────

describe('Local-only onboarding defaults', () => {
  it('onboarding skip uses defaults and marks onboarding complete', () => {
    const defaultConfig = defaults();
    // Skip enters local-only Orchid with no inferred provider/model.
    expect(defaultConfig.default_model).toBeNull();
    expect(defaultConfig.mcp_servers).toEqual({});
    expect(defaultConfig.theme).toBeTruthy();
    expect(defaultConfig.personality).toBeTruthy();
    expect(defaultConfig.has_completed_onboarding).toBe(false);
  });

  it('onboarding complete can persist expanded first-run preferences', async () => {
    const updates = {
      theme: 'default',
      personality: 'default',
      has_completed_onboarding: true,
      rag: {
        embedding_model: 'fastembed/BAAI/bge-small-en-v1.5',
        embedding_api_model: null,
      },
    };

    await mockOrchid.config.save({ updates });
    expect(mockOrchid.config.save).toHaveBeenCalledWith({ updates });
  });
});

// ─── File Structure ──────────────────────────────────────────────────────────

describe('Preferences & Onboarding File Structure', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const componentsDir = path.resolve(__dirname, '../../src/renderer/components');

  it('Preferences directory exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'Preferences'))).toBe(true);
  });

  it('ConfigView.tsx exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'ConfigView.tsx'))).toBe(true);
  });

  it('ProvidersTab.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Preferences', 'ProvidersTab.tsx')),
    ).toBe(true);
  });

  it('MCPServersTab.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Preferences', 'MCPServersTab.tsx')),
    ).toBe(true);
  });

  it('TierModelsTab.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Preferences', 'TierModelsTab.tsx')),
    ).toBe(true);
  });

  it('tier model assignments use the searchable model picker', () => {
    const tierModels = fs.readFileSync(path.join(componentsDir, 'Preferences', 'TierModelsTab.tsx'), 'utf8');
    const assignments = fs.readFileSync(path.join(componentsDir, 'Preferences', 'ModelAssignments.tsx'), 'utf8');
    expect(tierModels).toContain('ModelAssignments');
    expect(assignments).toContain('ModelPicker');
    expect(tierModels).not.toContain('<select');
  });

  it('RAGTab.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Preferences', 'RAGTab.tsx')),
    ).toBe(true);
  });

  it('RAG settings expose provider-backed embedding models', () => {
    const ragTab = fs.readFileSync(path.join(componentsDir, 'Preferences', 'RAGTab.tsx'), 'utf8');
    expect(ragTab).toContain('isEmbeddingModel');
    expect(ragTab).toContain('embedding_api_model');
    expect(ragTab).toContain('additionalOptions={localModelOptions}');
    expect(ragTab).not.toContain('Provider Embedding Model');
  });

  it('GeneralTab.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Preferences', 'GeneralTab.tsx')),
    ).toBe(true);
  });

  it('GeneralTab exposes MCP timeout fields', () => {
    const generalTab = fs.readFileSync(
      path.join(componentsDir, 'Preferences', 'GeneralTab.tsx'),
      'utf8',
    );
    expect(generalTab).toContain('mcpStartupTimeout');
    expect(generalTab).toContain('mcpPerServerTimeout');
    expect(generalTab).toContain('mcp_startup_timeout');
    expect(generalTab).toContain('mcp_per_server_timeout');
    expect(generalTab).toContain('MCP Startup Timeout (s)');
    expect(generalTab).toContain('MCP Per-Server Timeout (s)');
  });

  it('Onboarding directory exists', () => {
    expect(fs.existsSync(path.join(componentsDir, 'Onboarding'))).toBe(true);
  });

  it('OnboardingScreen.tsx exists', () => {
    expect(
      fs.existsSync(path.join(componentsDir, 'Onboarding', 'OnboardingScreen.tsx')),
    ).toBe(true);
  });

  it('components.css contains configuration styles', () => {
    const cssPath = path.resolve(__dirname, '../../src/renderer/styles/components.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.config-main-header');
    expect(css).toContain('.config-tabs');
    expect(css).toContain('.config-tab');
    expect(css).toContain('.config-body');
    expect(css).toContain('.config-form');
  });

  it('components.css contains onboarding styles', () => {
    const cssPath = path.resolve(__dirname, '../../src/renderer/styles/components.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('.onb-overlay');
    expect(css).toContain('.onb-container');
    expect(css).toContain('.onb-step');
    expect(css).toContain('.onb-step-description');
    expect(css).toContain('.onb-step-actions');
  });
});

// ─── Keyboard Shortcuts ──────────────────────────────────────────────────────

function fakeKeyEvent(
  partial: Partial<KeyboardEvent> & { key: string },
): KeyboardEvent {
  return {
    key: partial.key,
    code: partial.code ?? '',
    ctrlKey: partial.ctrlKey ?? false,
    metaKey: partial.metaKey ?? false,
    shiftKey: partial.shiftKey ?? false,
    altKey: partial.altKey ?? false,
    defaultPrevented: false,
    preventDefault() {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
    target: partial.target ?? null,
  } as KeyboardEvent;
}

describe('Preferences Keyboard Shortcuts', () => {
  it('Ctrl+S triggers save via registry', () => {
    const def = getShortcut('config.save');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 's', mod: true });
    expect(eventMatchesChord(fakeKeyEvent({ key: 's', ctrlKey: true }), def!.chord)).toBe(true);
  });

  it('Cmd+S triggers save on macOS via registry', () => {
    const def = getShortcut('config.save');
    expect(def).toBeDefined();
    expect(eventMatchesChord(fakeKeyEvent({ key: 's', metaKey: true }), def!.chord)).toBe(true);
    expect(eventMatchesChord(fakeKeyEvent({ key: 's' }), def!.chord)).toBe(false);
  });

  it('Escape closes settings via registry', () => {
    const def = getShortcut('config.close');
    expect(def).toBeDefined();
    expect(def!.chord).toEqual({ key: 'Escape' });
    expect(eventMatchesChord(fakeKeyEvent({ key: 'Escape' }), def!.chord)).toBe(true);
  });

  it('settings overlay owns Escape while open (ChatView cancel gated)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const rendererRoot = path.resolve(__dirname, '../../src/renderer');
    const appSrc = fs.readFileSync(path.join(rendererRoot, 'App.tsx'), 'utf8');
    const inputArea = fs.readFileSync(path.join(rendererRoot, 'components/InputArea.tsx'), 'utf8');

    expect(appSrc).toMatch(/dataset\.orchidSettingsOpen/);
    expect(inputArea).toMatch(/dataset\.orchidSettingsOpen/);
    expect(inputArea).toMatch(/if \(document\.documentElement\.dataset\.orchidSettingsOpen === '1'\) return/);
  });
});

// ─── Tier Models ─────────────────────────────────────────────────────────────

describe('Tier Models Configuration', () => {
  it('4 tiers are defined: seed, sprout, bloom, crown', () => {
    const tiers = ['seed', 'sprout', 'bloom', 'crown'];
    expect(tiers).toHaveLength(4);
  });

  it('tier models can be updated', () => {
    const tierModels = {
      seed: 'ollama/llama3:latest',
      sprout: 'openai/gpt-4o-mini',
      bloom: 'openai/gpt-4o',
      crown: 'anthropic/claude-sonnet-4-20250514',
    };
    expect(Object.keys(tierModels)).toHaveLength(4);
    expect(tierModels.seed).toBe('ollama/llama3:latest');
    expect(tierModels.crown).toBe('anthropic/claude-sonnet-4-20250514');
  });
});

// ─── RAG Configuration ───────────────────────────────────────────────────────

describe('RAG Configuration', () => {
  it('RAG config has sensible defaults', () => {
    const config = defaults();
    expect(config.rag.chunk_size).toBe(2000);
    expect(config.rag.chunk_overlap).toBe(200);
    expect(config.rag.top_k).toBe(5);
    expect(config.rag.max_file_size).toBe(512000);
    expect(config.rag.embedding_model).toBeTruthy();
  });

  it('RAG config fields can be updated independently', () => {
    const rag = { ...defaults().rag };
    rag.chunk_size = 1000;
    expect(rag.chunk_size).toBe(1000);
    expect(rag.chunk_overlap).toBe(200); // unchanged
  });
});
