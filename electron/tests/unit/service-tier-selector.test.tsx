// @vitest-environment jsdom
/** ServiceTierSelector — tier menu, streaming precondition flag, reset affordance. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ServiceTierSelector,
  shouldShowServiceTierSelector,
} from '../../src/renderer/components/ServiceTierSelector';
import type { SessionServiceTierConfigResult } from '../../src/shared/types/ipc';

function config(overrides: Partial<SessionServiceTierConfigResult> = {}): SessionServiceTierConfigResult {
  return {
    mechanism: 'model-name-variants',
    tiers: [
      { id: 'fast', displayName: 'Fast', description: null },
      { id: 'flex', displayName: 'Flex', description: null, requiresStreaming: true },
    ],
    selected: null,
    override: null,
    effective: null,
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('shouldShowServiceTierSelector', () => {
  it('shows only when the driver declares tiers', () => {
    expect(shouldShowServiceTierSelector(config())).toBe(true);
    expect(shouldShowServiceTierSelector(config({ mechanism: null, tiers: [] }))).toBe(false);
    expect(shouldShowServiceTierSelector(config({ mechanism: 'request-parameter', tiers: [] }))).toBe(false);
    expect(shouldShowServiceTierSelector(null)).toBe(false);
  });
});

describe('ServiceTierSelector', () => {
  it('lists tiers and flags streaming-required variants', () => {
    render(<ServiceTierSelector config={config()} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Service tier' }));

    expect(screen.getByText('Fast')).toBeTruthy();
    const flex = screen.getByText('Flex');
    expect(flex).toBeTruthy();
    expect(screen.getByText('Requires streaming')).toBeTruthy();
    expect(flex.closest('button')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('commits a tier selection through onChange', () => {
    const onChange = vi.fn();
    render(<ServiceTierSelector config={config()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Service tier' }));
    fireEvent.click(screen.getByText('Fast'));

    expect(onChange).toHaveBeenCalledWith('fast');
  });

  it('shows the effective tier and a reset affordance when overridden', () => {
    const onChange = vi.fn();
    render(
      <ServiceTierSelector
        config={config({ override: 'flex', effective: 'flex' })}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Service tier' }));

    expect(screen.getByText('Reset to connection selection')).toBeTruthy();
    fireEvent.click(screen.getByText('Reset to connection selection'));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('honors the disabled prop on the trigger', () => {
    render(<ServiceTierSelector config={config()} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Service tier' }).getAttribute('disabled')).not.toBeNull();
  });
});
