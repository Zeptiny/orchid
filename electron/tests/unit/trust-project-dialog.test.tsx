// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrustProjectDialog } from '../../src/renderer/components/TrustProjectDialog';
import { LeftSidebar } from '../../src/renderer/components/LeftSidebar';
import { OnboardingScreen } from '../../src/renderer/components/Onboarding/OnboardingScreen';
import { __providersCacheTest } from '../../src/renderer/hooks/useProviders';
import type {
  ProjectTrustInfo,
  ProjectTrustReport,
  WorkspaceInfo,
} from '../../src/shared/types/ipc';

function fullReport(): ProjectTrustReport {
  return {
    projectDir: '/home/user/proj',
    hasSurface: true,
    mcpServers: [
      {
        name: 'context7',
        kind: 'added',
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp'],
        envKeys: ['CONTEXT7_API_KEY'],
      },
      {
        name: 'github',
        kind: 'override',
        url: 'https://mcp.example/github',
      },
    ],
    permissions: [
      { tool: 'execute_command', rule: 'allow', autoAllow: true },
      { tool: 'edit', rule: 'ask', autoAllow: false },
    ],
    agentsMdOverrides: [
      { key: 'agents_md.enforce_on_write', projectValue: 'off', homeValue: 'warn' },
    ],
    modelOverrides: [
      { key: 'default_model', connectionId: 'conn-1', modelId: 'gpt-5' },
    ],
    otherConfigOverrides: [
      { key: 'command_timeout', projectValue: '60', homeValue: '30' },
    ],
    definitions: [
      { kind: 'agent', name: 'reviewer', overridesHome: true },
      { kind: 'skill', name: 'deploy', overridesHome: false },
    ],
    instructionFiles: ['AGENTS.md'],
  };
}

function renderDialog(overrides: Partial<ComponentProps<typeof TrustProjectDialog>> = {}) {
  const onGrant = vi.fn();
  const onDecline = vi.fn();
  const view = render(
    <TrustProjectDialog
      open
      cwd="/home/user/proj"
      trustState="untrusted"
      report={fullReport()}
      busy={false}
      onGrant={onGrant}
      onDecline={onDecline}
      {...overrides}
    />,
  );
  return { view, onGrant, onDecline };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TrustProjectDialog report sections', () => {
  it('renders title, path, and every non-empty report area', () => {
    renderDialog();

    expect(screen.getByText('Do you trust this project folder?')).toBeTruthy();
    expect(screen.getByText('/home/user/proj')).toBeTruthy();

    // Section headers
    expect(screen.getByText('MCP servers')).toBeTruthy();
    expect(screen.getByText('Tool permissions')).toBeTruthy();
    expect(screen.getByText('Instruction-file policy overrides')).toBeTruthy();
    expect(screen.getByText('Model overrides')).toBeTruthy();
    expect(screen.getByText('Config overrides')).toBeTruthy();
    expect(screen.getByText('Project definitions')).toBeTruthy();
    expect(screen.getByText('Instruction files')).toBeTruthy();

    // MCP rows: command/url + args
    expect(screen.getByText('context7')).toBeTruthy();
    expect(screen.getByText('npx')).toBeTruthy();
    expect(screen.getByText('-y @upstash/context7-mcp')).toBeTruthy();
    expect(screen.getByText('https://mcp.example/github')).toBeTruthy();

    // Permission rules
    expect(screen.getByText('execute_command')).toBeTruthy();
    expect(screen.getByText('allow (auto-allow)')).toBeTruthy();
    expect(screen.getByText('ask')).toBeTruthy();

    // Overrides: home → project
    expect(screen.getByText('agents_md.enforce_on_write')).toBeTruthy();
    expect(screen.getByText('warn → off')).toBeTruthy();
    expect(screen.getByText('conn-1/gpt-5')).toBeTruthy();
    expect(screen.getByText('30 → 60')).toBeTruthy();

    // Definitions and instruction files
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('deploy')).toBeTruthy();
    expect(screen.getByText('AGENTS.md')).toBeTruthy();
  });

  it('marks added vs overriding MCP servers and lists env var names only', () => {
    const { view } = renderDialog();
    const html = view.container.parentElement?.innerHTML ?? document.body.innerHTML;

    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('override')).toBeTruthy();
    // Env names are surfaced; the report never carries values and the dialog
    // renders only the names.
    expect(html).toContain('CONTEXT7_API_KEY');
    expect(html).not.toContain('CONTEXT7_API_KEY=');
  });

  it('highlights auto-allow permission rules with the error tone', () => {
    renderDialog();
    const autoAllow = screen.getByText('allow (auto-allow)');
    expect(autoAllow.className).toContain('text-error');
    const ask = screen.getByText('ask');
    expect(ask.className).not.toContain('text-error');
  });

  it('marks definitions that shadow home definitions', () => {
    renderDialog();
    expect(screen.getByText('overrides home')).toBeTruthy();
  });

  it('shows the changed banner only for the changed state', () => {
    const banner = 'This project changed since you trusted it. Review the updated surface before continuing.';

    renderDialog({ trustState: 'changed' });
    expect(screen.getByText(banner)).toBeTruthy();
    cleanup();

    renderDialog({ trustState: 'untrusted' });
    expect(screen.queryByText(banner)).toBeNull();
  });

  it('shows a short state message when the report is empty or null', () => {
    renderDialog({ report: null });
    expect(screen.getByText('No project-specific configuration found.')).toBeTruthy();
    cleanup();

    renderDialog({
      report: {
        projectDir: '/home/user/proj',
        hasSurface: false,
        mcpServers: [],
        permissions: [],
        agentsMdOverrides: [],
        modelOverrides: [],
        otherConfigOverrides: [],
        definitions: [],
        instructionFiles: [],
      },
    });
    expect(screen.getByText('No project-specific configuration found.')).toBeTruthy();
  });
});

describe('TrustProjectDialog decisions', () => {
  it('grant click invokes onGrant; decline click invokes onDecline', () => {
    const { onGrant, onDecline } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: /Trust & Continue/ }));
    expect(onGrant).toHaveBeenCalledTimes(1);
    expect(onDecline).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Don't Trust/ }));
    expect(onDecline).toHaveBeenCalledTimes(1);
  });

  it('Escape and backdrop clicks map to decline', () => {
    const { onDecline } = renderDialog();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onDecline).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('presentation'));
    expect(onDecline).toHaveBeenCalledTimes(2);
  });

  it('disables both decision buttons while busy and shows the spinner', () => {
    renderDialog({ busy: true });
    const grant = screen.getByRole('button', { name: /Trust & Continue/ });
    const decline = screen.getByRole('button', { name: /Don't Trust/ });
    expect((grant as HTMLButtonElement).disabled).toBe(true);
    expect((decline as HTMLButtonElement).disabled).toBe(true);
    expect(grant.getAttribute('aria-busy')).toBe('true');
  });
});

describe('TrustProjectDialog error surfacing', () => {
  it('renders the error message in an alert above the footer when error is set', () => {
    renderDialog({ error: 'Trusting this project failed. Try again.' });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Trusting this project failed. Try again.');

    // The alert sits above the footer buttons (they follow it in the document).
    const grantButton = screen.getByRole('button', { name: /Trust & Continue/ });
    expect(
      (alert.compareDocumentPosition(grantButton) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it('renders no alert when no error is set', () => {
    renderDialog();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LeftSidebar workspace trust badge', () => {
  function renderSidebar(workspace: WorkspaceInfo | null) {
    const onTrustBadgeClick = vi.fn();
    render(
      <LeftSidebar
        isCollapsed={false}
        onToggle={() => {}}
        sessionListState={{ status: 'empty' }}
        activeSessionId={null}
        onSessionSelect={() => {}}
        onSessionCreate={() => {}}
        onSessionDelete={() => {}}
        onRefreshSessions={() => {}}
        onOpenSettings={() => {}}
        workspace={workspace}
        onTrustBadgeClick={onTrustBadgeClick}
      />,
    );
    return { onTrustBadgeClick };
  }

  function workspace(trust: WorkspaceInfo['trust']): WorkspaceInfo {
    return { cwd: '/home/user/proj', source: 'default', status: 'valid', trust };
  }

  it('renders a clickable "Not trusted" badge for untrusted workspaces', () => {
    const { onTrustBadgeClick } = renderSidebar(workspace('untrusted'));
    const badge = screen.getByText('Not trusted');
    expect(badge).toBeTruthy();
    const button = badge.closest('button');
    expect(button).not.toBeNull();
    fireEvent.click(button as HTMLButtonElement);
    expect(onTrustBadgeClick).toHaveBeenCalledTimes(1);
  });

  it('renders a "Changed" badge for changed workspaces', () => {
    renderSidebar(workspace('changed'));
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(screen.queryByText('Not trusted')).toBeNull();
  });

  it('renders no badge for trusted workspaces', () => {
    renderSidebar(workspace('trusted'));
    expect(screen.queryByText('Not trusted')).toBeNull();
    expect(screen.queryByText('Changed')).toBeNull();
  });

  it('renders no badge when the workspace is unbound', () => {
    renderSidebar({ cwd: null, source: 'unbound', status: 'unbound', trust: 'untrusted' });
    expect(screen.queryByText('Not trusted')).toBeNull();
  });

  it('surfaces the trust state in the chip title', () => {
    renderSidebar(workspace('untrusted'));
    const chip = screen.getByTitle(
      '/home/user/proj — not trusted; review the project surface to continue',
    );
    expect(chip).toBeTruthy();
  });
});

describe('LeftSidebar session deletion feedback', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('renders the deleting row as busy and prevents another delete click', () => {
    const onSessionDelete = vi.fn();
    render(
      <LeftSidebar
        isCollapsed={false}
        onToggle={() => {}}
        sessionListState={{
          status: 'ready',
          sessions: [{
            id: 'session-1',
            name: 'Pending deletion',
            modelLabel: null,
            cwd: '/home/user/proj',
            chainCount: 1,
            updatedAt: 1,
          }],
        }}
        activeSessionId="session-1"
        onSessionSelect={() => {}}
        onSessionCreate={() => {}}
        onSessionDelete={onSessionDelete}
        deletingSessionIds={new Set(['session-1'])}
        onRefreshSessions={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    const button = screen.getByRole('button', { name: 'Deleting session' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button);
    expect(onSessionDelete).not.toHaveBeenCalled();
  });

  it('routes a rejected delete to the visible error callback', async () => {
    const error = new Error('disk unavailable');
    const onSessionDelete = vi.fn().mockRejectedValue(error);
    const onSessionDeleteError = vi.fn();
    render(
      <LeftSidebar
        isCollapsed={false}
        onToggle={() => {}}
        sessionListState={{
          status: 'ready',
          sessions: [{
            id: 'session-1',
            name: 'Delete me',
            modelLabel: null,
            cwd: '/home/user/proj',
            chainCount: 1,
            updatedAt: 1,
          }],
        }}
        activeSessionId={null}
        onSessionSelect={() => {}}
        onSessionCreate={() => {}}
        onSessionDelete={onSessionDelete}
        onSessionDeleteError={onSessionDeleteError}
        onRefreshSessions={() => {}}
        onOpenSettings={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));

    await waitFor(() => expect(onSessionDeleteError).toHaveBeenCalledWith(error));
  });
});

// ── OnboardingScreen trust gating ────────────────────────────────────────────

function onboardingReport(): ProjectTrustReport {
  return {
    projectDir: '/proj',
    hasSurface: true,
    mcpServers: [{ name: 'context7', kind: 'added', command: 'npx' }],
    permissions: [],
    agentsMdOverrides: [],
    modelOverrides: [],
    otherConfigOverrides: [],
    definitions: [],
    instructionFiles: [],
  };
}

function installOnboardingBridge(trust: ProjectTrustInfo['state']) {
  const pickProjectDir = vi.fn(() => Promise.resolve({
    cwd: '/proj',
    source: 'default',
    status: 'valid',
    trust,
  } satisfies WorkspaceInfo));
  const trustSet = vi.fn(() => Promise.resolve({
    projectDir: '/proj',
    state: 'trusted',
    report: null,
  } satisfies ProjectTrustInfo));
  Object.defineProperty(window, 'orchid', {
    configurable: true,
    value: {
      providers: {
        list: vi.fn(() => Promise.resolve({
          definitions: [],
          connections: [{
            id: 'conn-1',
            providerId: 'openai',
            providerDisplayName: 'OpenAI',
            name: 'OpenAI',
            protocol: 'openai-responses',
            authMethod: 'api_key',
            credentialKind: 'stored',
            environmentVariable: null,
            modelIds: ['gpt-5'],
            customModels: [],
            health: 'ready',
            activeTurnCount: 0,
            endpoint: null,
            allowInsecureHttp: false,
          }],
          statuses: [],
          secureStorage: { available: true, backend: 'libsecret', reason: null },
        })),
        modelList: vi.fn(() => Promise.resolve([{
          selection: { connectionId: 'conn-1', modelId: 'gpt-5' },
          connectionName: 'OpenAI',
          providerId: 'openai',
          providerDisplayName: 'OpenAI',
          model: {
            id: 'gpt-5',
            displayName: 'GPT-5',
            protocol: 'openai-responses',
            lifecycle: 'active',
            source: 'catalog',
            capabilities: null,
            limits: null,
          },
          available: true,
          unavailableReason: null,
        }])),
      },
      config: {
        get: vi.fn(() => Promise.resolve({})),
        listPersonalities: vi.fn(() => Promise.resolve(['default'])),
        save: vi.fn(() => Promise.resolve({ status: 'ok' })),
      },
      session: { pickProjectDir },
      projectTrust: {
        get: vi.fn(() => Promise.resolve({
          projectDir: '/proj',
          state: trust,
          report: trust === 'trusted' ? null : onboardingReport(),
        } satisfies ProjectTrustInfo)),
        set: trustSet,
        list: vi.fn(() => Promise.resolve([])),
        onChanged: vi.fn(() => () => {}),
      },
    } as never,
  });
  return { pickProjectDir, trustSet };
}

/** Click through providers → models → appearance → project. */
async function advanceToProjectStep() {
  await waitFor(() => {
    expect((screen.getByRole('button', { name: 'Next: models' }) as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next: models' }));

  await waitFor(() => {
    expect((screen.getByRole('button', { name: 'Next: appearance' }) as HTMLButtonElement).disabled).toBe(false);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Next: appearance' }));

  fireEvent.click(screen.getByRole('button', { name: 'Next: project' }));
  await screen.findByRole('button', { name: /Choose folder|Change folder/ });
}

describe('OnboardingScreen trust gating', () => {
  beforeEach(() => {
    __providersCacheTest.reset();
  });

  it('untrusted pick opens the dialog without setting projectPath; grant sets it', async () => {
    const { trustSet } = installOnboardingBridge('untrusted');
    render(<OnboardingScreen isOpen onComplete={vi.fn()} onSkip={vi.fn()} />);

    await advanceToProjectStep();
    expect(screen.getByText('No project folder selected yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }));

    // Dialog opens; the wizard's project selection has not advanced.
    await screen.findByText('Do you trust this project folder?');
    expect(screen.getByText('context7')).toBeTruthy();
    expect(screen.getByText('No project folder selected yet.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Trust & Continue/ }));

    await waitFor(() => expect(trustSet).toHaveBeenCalledWith({ cwd: '/proj', trusted: true }));
    await waitFor(() => expect(screen.queryByText('Do you trust this project folder?')).toBeNull());
    // projectPath advanced to the granted directory.
    await screen.findByText('/proj');
    expect(screen.queryByText('No project folder selected yet.')).toBeNull();
  });

  it('declining keeps the previous projectPath and shows inline guidance', async () => {
    const { trustSet } = installOnboardingBridge('untrusted');
    render(<OnboardingScreen isOpen onComplete={vi.fn()} onSkip={vi.fn()} />);

    await advanceToProjectStep();
    fireEvent.click(screen.getByRole('button', { name: /Choose folder/ }));
    await screen.findByText('Do you trust this project folder?');

    fireEvent.click(screen.getByRole('button', { name: /Don't Trust/ }));

    await waitFor(() => expect(screen.queryByText('Do you trust this project folder?')).toBeNull());
    expect(trustSet).not.toHaveBeenCalled();
    expect(screen.getByText(/That folder was not trusted/)).toBeTruthy();
    expect(screen.getByText('No project folder selected yet.')).toBeTruthy();
  });
});
