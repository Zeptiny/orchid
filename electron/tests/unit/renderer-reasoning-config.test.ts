import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ReasoningConfigEditor,
  type ReasoningConfigEditorProps,
  type ReasoningModelEntry,
} from '../../src/renderer/components/Providers/ReasoningConfigEditor';
import type { ReasoningModelConfig } from '../../src/shared/types/provider';

function markup(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

function editor(props: Partial<ReasoningConfigEditorProps> = {}): ReactElement {
  const models: ReasoningModelEntry[] = props.models ?? [
    { modelId: 'o3', displayName: 'OpenAI o3' },
  ];
  return createElement(ReasoningConfigEditor, {
    models,
    reasoningConfig: props.reasoningConfig ?? {},
    disabled: props.disabled ?? false,
    onChange: props.onChange ?? (() => {}),
  });
}

describe('ReasoningConfigEditor', () => {
  describe('rendering', () => {
    it('renders nothing when no reasoning-capable models are provided', () => {
      const html = markup(editor({ models: [] }));
      expect(html).toBe('');
    });

    it('renders a section for each reasoning-capable model', () => {
      const models: ReasoningModelEntry[] = [
        { modelId: 'o3', displayName: 'OpenAI o3' },
        { modelId: 'claude-sonnet-4-20250514', displayName: 'Claude Sonnet 4' },
      ];
      const html = markup(editor({ models }));
      expect(html).toContain('OpenAI o3');
      expect(html).toContain('Claude Sonnet 4');
      expect(html).toContain('data-testid="reasoning-config-o3"');
      expect(html).toContain('data-testid="reasoning-config-claude-sonnet-4-20250514"');
    });

    it('shows the reasoning effort section header', () => {
      const html = markup(editor());
      expect(html).toContain('Reasoning effort');
    });

    it('renders existing levels from reasoningConfig', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toContain('low');
      expect(html).toContain('medium');
      expect(html).toContain('high');
    });

    it('renders default selector with configured levels as options', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toContain('<option value="low"');
      expect(html).toContain('<option value="medium"');
      expect(html).toContain('<option value="high"');
      expect(html).toContain('<option value="__numeric__"');
      expect(html).toContain('<option value="__none__"');
    });

    it('shows numeric input when default is numeric', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'high'], default: 8192 },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toContain('8192');
      expect(html).toContain('inputMode="numeric"');
    });

    it('does not render reasoning section for models without reasoning capability', () => {
      const html = markup(editor({ models: [] }));
      expect(html).not.toContain('Reasoning effort');
    });
  });

  describe('levels management', () => {
    it('renders add-level input and button', () => {
      const html = markup(editor());
      expect(html).toContain('Add level');
      expect(html).toContain('aria-label="Add level to OpenAI o3"');
    });

    it('renders remove buttons for each existing level', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'medium', 'high'], default: 'medium' },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toContain('aria-label="Remove level low"');
      expect(html).toContain('aria-label="Remove level medium"');
      expect(html).toContain('aria-label="Remove level high"');
    });
  });

  describe('default effort selector', () => {
    it('renders a select with None option when no default is set', () => {
      const html = markup(editor());
      expect(html).toContain('<option value="__none__"');
      expect(html).toContain('Default effort');
    });

    it('selects the configured text default', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'medium', 'high'], default: 'high' },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toMatch(/<option[^>]*value="high"[^>]*selected/);
    });

    it('selects numeric option when default is a number', () => {
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'high'], default: 4096 },
      };
      const html = markup(editor({ reasoningConfig }));
      expect(html).toMatch(/<option[^>]*value="__numeric__"[^>]*selected/);
      expect(html).toContain('4096');
    });
  });

  describe('save button', () => {
    it('renders a save button', () => {
      const html = markup(editor());
      expect(html).toContain('Save reasoning config');
    });

    it('disables save when disabled prop is true', () => {
      const html = markup(editor({ disabled: true }));
      expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Save reasoning config/s);
    });
  });

  describe('multiple models', () => {
    it('renders independent config sections per model', () => {
      const models: ReasoningModelEntry[] = [
        { modelId: 'o3', displayName: 'OpenAI o3' },
        { modelId: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
      ];
      const reasoningConfig: Record<string, ReasoningModelConfig> = {
        o3: { levels: ['low', 'high'], default: 'low' },
        'gemini-2.5-pro': { levels: ['minimal', 'full'], default: null },
      };
      const html = markup(editor({ models, reasoningConfig }));
      expect(html).toContain('data-testid="reasoning-config-o3"');
      expect(html).toContain('data-testid="reasoning-config-gemini-2.5-pro"');
      expect(html).toContain('minimal');
      expect(html).toContain('full');
    });
  });
});
