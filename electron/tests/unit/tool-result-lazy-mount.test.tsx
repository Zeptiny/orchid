// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';
import type { ToolBlock } from '../../src/renderer/hooks/useChat';
import { ToolActivityGroup } from '../../src/renderer/components/ToolActivityGroup';
import {
  resetToolResultExpansionState,
  ToolResultShell,
} from '../../src/renderer/components/ToolResults/ToolResultShell';
import { registerToolResultRenderer } from '../../src/renderer/components/ToolResults/registry';
import { CollapsibleRegion } from '../../src/renderer/components/ui/CollapsibleRegion';

afterEach(() => {
  cleanup();
  resetToolResultExpansionState();
});

const result: CanonicalToolResult = {
  schemaVersion: 1,
  family: 'generic',
  status: 'complete',
  completeness: 'complete',
  data: { value: 'result' },
};

function block(id: string): ToolBlock {
  return {
    id,
    toolName: 'lazy_probe',
    status: 'complete',
    partialArgs: '',
    args: '{}',
    agentProjection: '',
    toolResult: result,
    startedAt: '2026-07-27T00:00:00.000Z',
    finishedAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('lazy tool disclosure mounting', () => {
  it('mounts a lazy region immediately when initially open', () => {
    render(
      <CollapsibleRegion open lazyMount>
        <div data-testid="initially-open-probe">details</div>
      </CollapsibleRegion>,
    );

    expect(screen.getByTestId('initially-open-probe')).toBeTruthy();
  });

  it('does not render a closed lazy region until first expansion, then retains it after collapse', () => {
    let renders = 0;
    function Probe() {
      renders += 1;
      return <div data-testid="region-probe">details</div>;
    }

    const { rerender } = render(
      <CollapsibleRegion open={false} lazyMount>
        <Probe />
      </CollapsibleRegion>,
    );
    expect(renders).toBe(0);
    expect(screen.queryByTestId('region-probe')).toBeNull();

    rerender(
      <CollapsibleRegion open lazyMount>
        <Probe />
      </CollapsibleRegion>,
    );
    expect(renders).toBe(1);
    expect(screen.getByTestId('region-probe')).toBeTruthy();

    rerender(
      <CollapsibleRegion open={false} lazyMount>
        <Probe />
      </CollapsibleRegion>,
    );
    expect(renders).toBe(2);
    expect(screen.getByTestId('region-probe')).toBeTruthy();
  });

  it('defers tool result renderers and tool activity children while their disclosures are closed', () => {
    let resultRendererRenders = 0;
    const restore = registerToolResultRenderer('lazy_probe', () => {
      resultRendererRenders += 1;
      return <div data-testid="tool-result-probe">result body</div>;
    });
    try {
      const shell = render(<ToolResultShell block={block('shell')} />);
      expect(resultRendererRenders).toBe(0);
      expect(screen.queryByTestId('tool-result-probe')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /lazy_probe/i }));
      expect(resultRendererRenders).toBeGreaterThan(0);
      expect(screen.getByTestId('tool-result-probe')).toBeTruthy();

      fireEvent.click(screen.getByTitle('Click to collapse'));
      expect(screen.getByTestId('tool-result-probe')).toBeTruthy();
      shell.unmount();
      const rendersAfterShellExpansion = resultRendererRenders;

      render(
        <ToolActivityGroup
          items={[{
            kind: 'thought',
            message: {
              id: 'deferred-thought',
              role: 'assistant',
              content: 'deferred group thought',
              type: 'thinking',
              tool_calls: null,
              tool_call_id: null,
              name: null,
              thinking: null,
              timestamp: '2026-07-27T00:00:00.000Z',
              usage: null,
              hidden: false,
              tool_result: null,
            },
          }]}
        />,
      );
      expect(resultRendererRenders).toBe(rendersAfterShellExpansion);
      expect(screen.queryByText('deferred group thought')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /activity/i }));
      expect(screen.getByText('deferred group thought')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /activity/i }));
      expect(screen.getByText('deferred group thought')).toBeTruthy();
      expect(resultRendererRenders).toBe(rendersAfterShellExpansion);
    } finally {
      restore();
    }
  });

  it('bounds retained expansion choices', () => {
    const { unmount } = render(
      <>
        {Array.from({ length: 101 }, (_, index) => (
          <ToolResultShell key={index} block={block(`choice-${index}`)} />
        ))}
      </>,
    );
    for (const button of screen.getAllByRole('button')) fireEvent.click(button);
    unmount();

    render(<ToolResultShell block={block('choice-0')} />);
    expect(screen.getByRole('button', { name: /lazy_probe/i }).getAttribute('aria-expanded')).toBe('false');
  });
});
