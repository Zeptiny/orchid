// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustedProjectsTab } from '../../src/renderer/components/Preferences/TrustedProjectsTab';
import { TrustProjectDialog } from '../../src/renderer/components/TrustProjectDialog';
import type {
  ProjectTrustChangedEvent,
  ProjectTrustInfo,
  ProjectTrustReport,
  TrustedProjectEntry,
} from '../../src/shared/types/ipc';

function makeReport(projectDir: string): ProjectTrustReport {
  return {
    projectDir,
    hasSurface: true,
    mcpServers: [{ name: 'context7', kind: 'added', command: 'npx' }],
    permissions: [{ tool: 'execute_command', rule: 'allow', autoAllow: true }],
    agentsMdOverrides: [],
    modelOverrides: [],
    otherConfigOverrides: [],
    definitions: [],
    instructionFiles: ['AGENTS.md'],
  };
}

function entry(
  projectDir: string,
  state: TrustedProjectEntry['state'] = 'trusted',
): TrustedProjectEntry {
  return { projectDir, trustedAt: '2026-08-03T12:00:00.000Z', state };
}

interface BridgeOptions {
  entries?: TrustedProjectEntry[];
  info?: ProjectTrustInfo;
}

function installBridge(options: BridgeOptions = {}) {
  const list = vi.fn(() => Promise.resolve(options.entries ?? []));
  const set = vi.fn((message: { cwd: string; trusted: boolean }) =>
    Promise.resolve({
      projectDir: message.cwd,
      state: message.trusted ? 'trusted' : 'untrusted',
      report: null,
    } satisfies ProjectTrustInfo),
  );
  const get = vi.fn((message: { cwd: string }) =>
    Promise.resolve(
      options.info ?? {
        projectDir: message.cwd,
        state: 'trusted',
        report: null,
      } satisfies ProjectTrustInfo,
    ),
  );
  const listeners: Array<(event: ProjectTrustChangedEvent) => void> = [];
  const unsubscribe = vi.fn();
  const onChanged = vi.fn((callback: (event: ProjectTrustChangedEvent) => void) => {
    listeners.push(callback);
    return unsubscribe;
  });

  (window as Record<string, unknown>).orchid = {
    projectTrust: { get, set, list, onChanged },
  };

  return {
    list,
    set,
    get,
    onChanged,
    unsubscribe,
    emitChanged: (event: ProjectTrustChangedEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function renderTab(onNotify = vi.fn()) {
  const view = render(<TrustedProjectsTab onNotify={onNotify} />);
  return { view, onNotify };
}

const LOCALE_DATE = '8/3/2026, 12:00:00 PM';

afterEach(() => {
  cleanup();
  delete (window as Record<string, unknown>).orchid;
  vi.restoreAllMocks();
});

describe('TrustedProjectsTab list', () => {
  it('renders entries with path, locale trusted-at, and changed badge only for changed rows', async () => {
    vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue(LOCALE_DATE);
    installBridge({ entries: [entry('/proj/alpha'), entry('/proj/beta', 'changed')] });
    renderTab();

    await screen.findByText('/proj/alpha');
    expect(screen.getByText('/proj/beta')).toBeTruthy();
    // One trusted-at line per row.
    expect(screen.getAllByText(`Trusted ${LOCALE_DATE}`)).toHaveLength(2);

    // Only the changed row carries the badge.
    const badges = screen.getAllByText('Changed since trusted');
    expect(badges).toHaveLength(1);
  });

  it('shows empty-state guidance when no trusted projects exist', async () => {
    installBridge({ entries: [] });
    renderTab();

    await screen.findByText('No trusted projects yet');
    expect(
      screen.getByText(/When you open a project with project-supplied configuration/),
    ).toBeTruthy();
    expect(screen.queryByText('Changed since trusted')).toBeNull();
  });

  it('refreshes the list when a project:trust_changed event fires', async () => {
    const bridge = installBridge({ entries: [entry('/proj/alpha')] });
    // Second fetch (event-driven) returns the changed state.
    bridge.list.mockResolvedValueOnce([entry('/proj/alpha')])
      .mockResolvedValueOnce([entry('/proj/alpha', 'changed')]);
    renderTab();

    await screen.findByText('/proj/alpha');
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(bridge.onChanged).toHaveBeenCalledTimes(1);

    bridge.emitChanged({ projectDir: '/proj/alpha', state: 'changed' });

    await screen.findByText('Changed since trusted');
    expect(bridge.list).toHaveBeenCalledTimes(2);
  });

  it('shows a warning state when the initial load fails', async () => {
    const bridge = installBridge({ entries: [] });
    bridge.list.mockRejectedValueOnce(new Error('trust store unavailable'));
    renderTab();

    await screen.findByText('trust store unavailable');
    expect(screen.queryByText('No trusted projects yet')).toBeNull();
  });

  it('unsubscribes from onChanged on unmount', async () => {
    const bridge = installBridge({ entries: [entry('/proj/alpha')] });
    const { view } = renderTab();
    await screen.findByText('/proj/alpha');

    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('TrustedProjectsTab revoke', () => {
  it('calls projectTrust.set with trusted:false for the row and refreshes the list', async () => {
    const bridge = installBridge({ entries: [entry('/proj/alpha'), entry('/proj/beta')] });
    // After revocation alpha disappears from the store listing.
    bridge.list.mockResolvedValueOnce([entry('/proj/alpha'), entry('/proj/beta')])
      .mockResolvedValueOnce([entry('/proj/beta')]);
    const { onNotify } = renderTab();

    await screen.findByText('/proj/alpha');
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' });
    fireEvent.click(revokeButtons[0]);

    await waitFor(() => {
      expect(bridge.set).toHaveBeenCalledWith({ cwd: '/proj/alpha', trusted: false });
    });
    // Initial load + post-revoke refresh.
    await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('/proj/alpha')).toBeNull());
    expect(screen.getByText('/proj/beta')).toBeTruthy();
    expect(onNotify).toHaveBeenCalledWith('Trust revoked for /proj/alpha.', 'info');
  });

  it('surfaces revoke failures via onNotify without refreshing', async () => {
    const bridge = installBridge({ entries: [entry('/proj/alpha')] });
    bridge.set.mockRejectedValueOnce(new Error('store locked'));
    const { onNotify } = renderTab();

    await screen.findByText('/proj/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(onNotify).toHaveBeenCalledWith('store locked', 'error'));
    // Only the initial mount load happened.
    expect(bridge.list).toHaveBeenCalledTimes(1);
  });
});

describe('TrustedProjectsTab review', () => {
  it('opens the read-only dialog with the fetched report and no grant button', async () => {
    installBridge({
      entries: [entry('/proj/alpha', 'changed')],
      info: {
        projectDir: '/proj/alpha',
        state: 'changed',
        report: makeReport('/proj/alpha'),
      },
    });
    renderTab();

    await screen.findByText('/proj/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));

    await screen.findByText('Project trust surface');
    // Report content is rendered.
    expect(screen.getByText('context7')).toBeTruthy();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
    // Read-only footer: Close only, no decision buttons.
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Trust & Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Don't Trust/ })).toBeNull();
  });

  it('closing the review dialog returns to the list', async () => {
    installBridge({
      entries: [entry('/proj/alpha', 'changed')],
      info: {
        projectDir: '/proj/alpha',
        state: 'changed',
        report: makeReport('/proj/alpha'),
      },
    });
    renderTab();

    await screen.findByText('/proj/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await screen.findByText('Project trust surface');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByText('Project trust surface')).toBeNull());
    expect(screen.getByText('/proj/alpha')).toBeTruthy();
  });
});

describe('TrustProjectDialog readOnly mode', () => {
  const onGrant = vi.fn();
  const onDecline = vi.fn();

  beforeEach(() => {
    onGrant.mockClear();
    onDecline.mockClear();
  });

  function renderDialog(readOnly: boolean) {
    return render(
      <TrustProjectDialog
        open
        cwd="/proj/alpha"
        trustState={readOnly ? 'trusted' : 'untrusted'}
        report={makeReport('/proj/alpha')}
        busy={false}
        onGrant={onGrant}
        onDecline={onDecline}
        readOnly={readOnly}
      />,
    );
  }

  it('readOnly renders a Close button mapped to onDecline and hides decision buttons', () => {
    renderDialog(true);

    expect(screen.getByText('Project trust surface')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Trust & Continue/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Don't Trust/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onGrant).not.toHaveBeenCalled();
  });

  it('default mode keeps the decision title and both buttons', () => {
    renderDialog(false);

    expect(screen.getByText('Do you trust this project folder?')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Trust & Continue/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Don't Trust/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
