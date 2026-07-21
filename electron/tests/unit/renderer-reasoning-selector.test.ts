/**
 * ReasoningSelector — footer reasoning-effort combo (U6).
 *
 * Uses ReactDOMServer static markup so Vitest stays on Node (no jsdom), matching
 * the renderer-ui-primitives convention. Interactive commit semantics are covered
 * through the exported pure helpers the component calls on commit
 * (`parseReasoningInput` / `commitReasoningText`); the footer wires `onChange`
 * straight into `window.orchid.session.setReasoningEffort`.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ReasoningSelector,
  commitReasoningText,
  effectiveReasoningValue,
  formatReasoningValue,
  isOutOfRangeNumeric,
  isReasoningOverridden,
  parseReasoningInput,
  shouldShowReasoningSelector,
  type ReasoningEffortValue,
} from '../../src/renderer/components/ReasoningSelector';

const LEVELS = ['low', 'medium', 'high'] as const;

interface RenderOptions {
  levels?: readonly string[];
  value?: ReasoningEffortValue;
  defaultValue?: ReasoningEffortValue;
  onChange?: (value: ReasoningEffortValue) => void;
  open?: boolean;
  disabled?: boolean;
}

function renderSelector(options: RenderOptions = {}): string {
  const {
    levels = LEVELS,
    value = null,
    defaultValue = null,
    onChange = () => {},
    open,
    disabled,
  } = options;
  const node: ReactElement = createElement(ReasoningSelector, {
    levels,
    value,
    defaultValue,
    onChange,
    ...(open === undefined ? {} : { open }),
    ...(disabled === undefined ? {} : { disabled }),
  });
  return renderToStaticMarkup(node);
}

// ── Free-text parsing (commit contract) ──────────────────────────────────────

describe('parseReasoningInput', () => {
  it('treats an all-digit entry as a numeric token budget', () => {
    expect(parseReasoningInput('8192')).toBe(8192);
    expect(typeof parseReasoningInput('8192')).toBe('number');
  });

  it('covers AE2: typing "4096" yields the numeric override 4096', () => {
    expect(parseReasoningInput('4096')).toBe(4096);
  });

  it('treats a named entry as a text effort level', () => {
    expect(parseReasoningInput('high')).toBe('high');
  });

  it('trims surrounding whitespace from text levels', () => {
    expect(parseReasoningInput('  high  ')).toBe('high');
  });

  it('keeps mixed alphanumeric input as text (not a budget)', () => {
    expect(parseReasoningInput('12abc')).toBe('12abc');
  });

  it('clearing the input resets to null (falls back to default)', () => {
    expect(parseReasoningInput('')).toBeNull();
    expect(parseReasoningInput('   ')).toBeNull();
  });

  it('preserves an out-of-range digit string instead of nulling it', () => {
    expect(parseReasoningInput('99999999')).toBe('99999999');
    expect(parseReasoningInput('0')).toBe('0');
  });
});

describe('isOutOfRangeNumeric', () => {
  it('flags all-digit entries outside the valid token-budget range', () => {
    expect(isOutOfRangeNumeric('99999999')).toBe(true);
    expect(isOutOfRangeNumeric('0')).toBe(true);
  });

  it('is false for valid budgets, text levels, and empty input', () => {
    expect(isOutOfRangeNumeric('8192')).toBe(false);
    expect(isOutOfRangeNumeric('high')).toBe(false);
    expect(isOutOfRangeNumeric('12abc')).toBe(false);
    expect(isOutOfRangeNumeric('')).toBe(false);
  });
});

describe('commitReasoningText', () => {
  it('selecting/typing "high" commits the text level through onChange', () => {
    const onChange = vi.fn();
    commitReasoningText('high', onChange);
    expect(onChange).toHaveBeenCalledWith('high');
  });

  it('typing "8192" commits the numeric token budget through onChange', () => {
    const onChange = vi.fn();
    commitReasoningText('8192', onChange);
    expect(onChange).toHaveBeenCalledWith(8192);
  });

  it('covers AE2: typing "4096" commits the session override 4096', () => {
    const onChange = vi.fn();
    commitReasoningText('4096', onChange);
    expect(onChange).toHaveBeenCalledWith(4096);
  });

  it('clearing the input commits null (reset to default)', () => {
    const onChange = vi.fn();
    commitReasoningText('', onChange);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

// ── Effective value / override resolution ────────────────────────────────────

describe('effectiveReasoningValue', () => {
  it('prefers the session override over the connection default', () => {
    expect(effectiveReasoningValue('high', 'medium')).toBe('high');
  });

  it('falls back to the default when no override is set', () => {
    expect(effectiveReasoningValue(null, 'medium')).toBe('medium');
  });

  it('passes a numeric override through unchanged', () => {
    expect(effectiveReasoningValue(8192, 'medium')).toBe(8192);
  });

  it('returns null when neither override nor default exists', () => {
    expect(effectiveReasoningValue(null, null)).toBeNull();
  });
});

describe('isReasoningOverridden', () => {
  it('is true for a text override', () => {
    expect(isReasoningOverridden('high')).toBe(true);
  });

  it('is true for a numeric override', () => {
    expect(isReasoningOverridden(8192)).toBe(true);
  });

  it('is false when no override is set', () => {
    expect(isReasoningOverridden(null)).toBe(false);
  });
});

describe('formatReasoningValue', () => {
  it('labels a null value as the provider default', () => {
    expect(formatReasoningValue(null)).toBe('Default');
  });

  it('shows text levels verbatim', () => {
    expect(formatReasoningValue('high')).toBe('high');
  });

  it('shows numeric budgets as plain digits', () => {
    expect(formatReasoningValue(8192)).toBe('8192');
  });
});

// ── Footer gating (AE1) ──────────────────────────────────────────────────────

describe('shouldShowReasoningSelector', () => {
  it('covers AE1: hides the selector when the model lacks reasoning', () => {
    expect(shouldShowReasoningSelector({ supportsReasoning: false })).toBe(false);
  });

  it('hides the selector before config loads', () => {
    expect(shouldShowReasoningSelector(null)).toBe(false);
    expect(shouldShowReasoningSelector(undefined)).toBe(false);
  });

  it('shows the selector for a reasoning-capable model', () => {
    expect(shouldShowReasoningSelector({ supportsReasoning: true })).toBe(true);
  });
});

// ── Rendered markup ──────────────────────────────────────────────────────────

describe('ReasoningSelector markup', () => {
  it('shows the connection default when no override is set', () => {
    const html = renderSelector({ value: null, defaultValue: 'medium' });
    expect(html).toContain('medium');
    expect(html).toContain('aria-expanded="false"');
  });

  it('shows the override value without an indicator dot when overridden', () => {
    const html = renderSelector({ value: 'high', defaultValue: 'medium' });
    expect(html).toContain('high');
    expect(html).toContain('(session override)');
    expect(html).not.toContain('orchid-reasoning-dot');
    expect(html).not.toContain('text-info');
  });

  it('omits the override marker when inheriting the default', () => {
    const html = renderSelector({ value: null, defaultValue: 'medium' });
    expect(html).not.toContain('orchid-reasoning-dot');
    expect(html).not.toContain('(session override)');
  });

  it('shows a numeric override in the trigger', () => {
    const html = renderSelector({ value: 8192, defaultValue: 'medium' });
    expect(html).toContain('8192');
    expect(html).not.toContain('orchid-reasoning-dot');
  });

  it('renders the configured levels when open', () => {
    const html = renderSelector({ open: true, value: null, defaultValue: 'medium' });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('low');
    expect(html).toContain('medium');
    expect(html).toContain('high');
  });

  it('marks the active level as pressed', () => {
    const html = renderSelector({ open: true, value: 'high' });
    expect(html).toContain('aria-pressed="true"');
  });

  it('renders the free-text combo input without a Set action when open', () => {
    const html = renderSelector({ open: true });
    expect(html).toContain('placeholder="Level or token budget"');
    expect(html).not.toContain('>Set<');
    expect(html).toContain('Reset to default');
  });

  it('does not render the popover while closed', () => {
    const html = renderSelector({ value: 'high' });
    expect(html).not.toContain('Reset to default');
    expect(html).not.toContain('placeholder="Level or token budget"');
  });

  it('disables the trigger when the footer is busy', () => {
    const html = renderSelector({ disabled: true });
    expect(html).toContain('disabled');
  });
});
