// @vitest-environment jsdom
/**
 * ReasoningConfigEditor — numeric token budgets are disabled with a visible
 * notice when the model's driver does not support them (OpenAI), and a
 * numeric default left configured surfaces a warning and blocks saving.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ReasoningConfigEditor,
  ReasoningFields,
} from '../../src/renderer/components/Providers/ReasoningConfigEditor';

afterEach(() => cleanup());

function renderFields(overrides: Partial<Parameters<typeof ReasoningFields>[0]> = {}) {
  const props: Parameters<typeof ReasoningFields>[0] = {
    modelId: 'o3',
    displayName: 'o3',
    levels: ['low', 'medium', 'high'],
    default: null,
    onChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ReasoningFields {...props} />) };
}

function numericOption(): HTMLOptionElement | undefined {
  const select = screen.getByLabelText('Default effort') as HTMLSelectElement;
  return Array.from(select.options).find((option) => option.value === '__numeric__');
}

describe('ReasoningFields numeric budget guard', () => {
  it('offers the numeric option when driver support is unknown', () => {
    renderFields();
    expect(numericOption()?.disabled).toBe(false);
    expect(screen.queryByText(/text effort levels only/)).toBeNull();
  });

  it('disables the numeric option with a visible notice when unsupported', () => {
    renderFields({ numericBudgetSupported: false });
    expect(numericOption()?.disabled).toBe(true);
    expect(screen.getByText(/text effort levels only/)).toBeTruthy();
  });

  it('warns when a numeric default is configured for an unsupported driver', () => {
    renderFields({ numericBudgetSupported: false, default: 8192 });
    expect(numericOption()?.disabled).toBe(true);
    expect(screen.getByText(/will not be sent for this model/)).toBeTruthy();
  });

  it('does not warn about numeric defaults when the driver supports them', () => {
    renderFields({ numericBudgetSupported: true, default: 8192 });
    expect(numericOption()?.disabled).toBe(false);
    expect(screen.queryByText(/will not be sent for this model/)).toBeNull();
  });

  it('still commits numeric budgets for supported drivers', () => {
    const onChange = vi.fn();
    renderFields({ onChange });
    fireEvent.change(screen.getByLabelText('Default effort'), {
      target: { value: '__numeric__' },
    });
    fireEvent.change(screen.getByLabelText('Numeric default for o3'), {
      target: { value: '4096' },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      ['low', 'medium', 'high'],
      4096,
    );
  });
});

describe('ReasoningConfigEditor save guard', () => {
  const models = [
    { modelId: 'o3', displayName: 'o3', numericBudgetSupported: false },
    { modelId: 'claude', displayName: 'Claude' },
  ];

  function renderEditor(
    reasoningConfig: Record<string, { levels: string[]; default: string | number | null }>,
    onChange = vi.fn(),
  ) {
    return {
      onChange,
      ...render(
        <ReasoningConfigEditor models={models} reasoningConfig={reasoningConfig} onChange={onChange} />,
      ),
    };
  }

  it('blocks saving a numeric default for an unsupported model', () => {
    const { onChange } = renderEditor({
      o3: { levels: ['low', 'medium', 'high'], default: 8192 },
      claude: { levels: ['low', 'medium'], default: 'high' },
    });
    fireEvent.click(screen.getByText('Save reasoning config'));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/"o3" does not support numeric token budgets/)).toBeTruthy();
  });

  it('saves numeric defaults for models whose driver supports them', () => {
    const { onChange } = renderEditor({
      o3: { levels: ['low', 'medium', 'high'], default: 'high' },
      claude: { levels: ['low', 'medium'], default: 4096 },
    });
    fireEvent.click(screen.getByText('Save reasoning config'));

    expect(onChange).toHaveBeenCalledWith({
      o3: { levels: ['low', 'medium', 'high'], default: 'high' },
      claude: { levels: ['low', 'medium'], default: 4096 },
    });
  });
});
