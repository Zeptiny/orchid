// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPServersTab } from '../../src/renderer/components/Preferences/MCPServersTab';

afterEach(() => {
  cleanup();
});

function inputValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

describe('MCPServersTab serialization', () => {
  it('omits headers entirely when an HTTP server is switched to stdio', () => {
    const onChange = vi.fn();
    render(
      <MCPServersTab
        mcpServers={{
          'remote-server': {
            url: 'http://localhost:3000',
            headers: { Authorization: 'Bearer tok', 'X-Custom': 'keep-me' },
          },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Command (stdio)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const saved = onChange.mock.calls[0][0] as Record<string, Record<string, unknown>>;
    expect(Object.keys(saved)).toEqual(['remote-server']);
    expect(saved['remote-server']).not.toHaveProperty('headers');
    expect(saved['remote-server']).not.toHaveProperty('url');
  });

  it('keeps headers for HTTP servers on save', () => {
    const onChange = vi.fn();
    render(
      <MCPServersTab
        mcpServers={{
          remote: {
            url: 'http://localhost:3000',
            headers: { Authorization: 'Bearer tok', 'X-Custom': 'keep-me' },
          },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onChange).toHaveBeenCalledWith({
      remote: {
        url: 'http://localhost:3000',
        headers: { Authorization: 'Bearer tok', 'X-Custom': 'keep-me' },
      },
    });
  });
});

describe('MCPServersTab auth header handling', () => {
  it('matches the Authorization header and Bearer scheme case-insensitively', () => {
    const onChange = vi.fn();
    render(
      <MCPServersTab
        mcpServers={{
          remote: {
            url: 'http://localhost:3000',
            headers: { authorization: 'bearer secret-token', 'x-api-key': 'k1' },
          },
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(inputValue('Auth Token')).toBe('secret-token');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onChange).toHaveBeenCalledWith({
      remote: {
        url: 'http://localhost:3000',
        headers: { 'x-api-key': 'k1', Authorization: 'Bearer secret-token' },
      },
    });
  });

  it('preserves non-Bearer authorization values and unrelated headers', () => {
    render(
      <MCPServersTab
        mcpServers={{
          remote: {
            url: 'http://localhost:3000',
            headers: { AUTHORIZATION: 'Basic abc123', 'X-Trace': 'on' },
          },
        }}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(inputValue('Auth Token')).toBe('Basic abc123');
  });
});
