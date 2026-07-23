/**
 * ProjectConfigView rendering contract.
 *
 * Static-markup verification (no DOM runtime in this suite): header chrome
 * (basename, full path, actions) and the initial loading surface before
 * project overrides resolve.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectConfigView } from '../../src/renderer/components/ProjectConfigView';

const noop = () => {};

function renderView(): string {
  return renderToStaticMarkup(
    <ProjectConfigView
      projectDir="/home/user/projects/orchid"
      onNewChat={noop}
      onClose={noop}
    />,
  );
}

describe('ProjectConfigView', () => {
  it('renders the project basename, full path, and header actions', () => {
    const html = renderView();
    expect(html).toContain('orchid');
    expect(html).toContain('/home/user/projects/orchid');
    expect(html).toContain('New Chat');
    expect(html).toContain('Reset All');
    expect(html).toContain('Back');
  });

  it('starts in a loading state before overrides resolve', () => {
    const html = renderView();
    expect(html).toContain('Loading project configuration');
    expect(html).not.toContain('Tool Limits');
  });
});
