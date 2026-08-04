/**
 * TrustProjectDialog — trust decision surface for bound project directories.
 *
 * Presentational only: shows the project surface diff (MCP servers, permission
 * rules, config/model overrides, definitions, instruction files) and reports
 * the decision through onGrant / onDecline. Escape and backdrop clicks map to
 * decline. No IPC inside — the useTrustPrompt hook owns the trust round-trips.
 */
import { useRef } from 'react';
import type {
  ProjectTrustReport,
  TrustReportConfigOverride,
  TrustReportDefinition,
  TrustReportMcpServer,
  TrustReportModelOverride,
  TrustReportPermission,
  TrustState,
} from '../../shared/types/ipc';
import { Icon } from './Icon';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { DialogSurface } from './ui/DialogSurface';
import { SectionHeader } from './ui/SectionHeader';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge } from './ui/StatusBadge';

export interface TrustProjectDialogProps {
  open: boolean;
  /** Canonical absolute project directory under review. */
  cwd: string;
  trustState: TrustState;
  /** Surface diff; null or empty sections fall back to a short state message. */
  report: ProjectTrustReport | null;
  /** True while a trust grant round-trip is in flight. */
  busy: boolean;
  onGrant: () => void;
  onDecline: () => void;
  /**
   * Read-only review mode (settings trusted-projects panel): hides the
   * Trust/Don't-Trust footer and renders a single Close button mapped to
   * onDecline. Default mode is unchanged.
   */
  readOnly?: boolean;
}

function McpServerRow({ server }: { server: TrustReportMcpServer }) {
  const target = server.command ?? server.url ?? null;
  return (
    <li className="flex flex-col gap-1 rounded-md border border-base-300 bg-base-100/60 px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="mono truncate text-sm font-medium">{server.name}</span>
        <StatusBadge tone={server.kind === 'added' ? 'info' : 'warning'} size="xs">
          {server.kind === 'added' ? 'added' : 'override'}
        </StatusBadge>
      </div>
      {target && <span className="mono truncate text-xs text-base-content/70">{target}</span>}
      {server.args && server.args.length > 0 && (
        <span className="mono truncate text-xs text-base-content/60">{server.args.join(' ')}</span>
      )}
      {server.envKeys && server.envKeys.length > 0 && (
        <span className="text-xs text-base-content/60">
          env: <span className="mono">{server.envKeys.join(', ')}</span>
        </span>
      )}
    </li>
  );
}

function PermissionRow({ entry }: { entry: TrustReportPermission }) {
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-3 px-1 py-0.5">
      <span className="mono truncate text-sm">{entry.tool}</span>
      <span
        className={
          entry.autoAllow
            ? 'mono shrink-0 text-sm font-semibold text-error'
            : 'mono shrink-0 text-sm text-base-content/70'
        }
      >
        {entry.rule}
        {entry.autoAllow ? ' (auto-allow)' : ''}
      </span>
    </li>
  );
}

function ConfigOverrideRow({ entry }: { entry: TrustReportConfigOverride }) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 px-1 py-0.5">
      <span className="mono truncate text-sm">{entry.key}</span>
      <span className="mono truncate text-xs text-base-content/70">
        {entry.homeValue} → {entry.projectValue}
      </span>
    </li>
  );
}

function ModelOverrideRow({ entry }: { entry: TrustReportModelOverride }) {
  return (
    <li className="flex min-w-0 items-baseline justify-between gap-3 px-1 py-0.5">
      <span className="mono truncate text-sm">{entry.key}</span>
      <span className="mono shrink-0 truncate text-xs text-base-content/70">
        {entry.connectionId}/{entry.modelId}
      </span>
    </li>
  );
}

function DefinitionRow({ entry }: { entry: TrustReportDefinition }) {
  return (
    <li className="flex min-w-0 items-center gap-2 px-1 py-0.5">
      <span className="shrink-0 text-xs uppercase tracking-wide text-base-content/60">
        {entry.kind}
      </span>
      <span className="mono truncate text-sm">{entry.name}</span>
      {entry.overridesHome && (
        <StatusBadge tone="warning" size="xs">
          overrides home
        </StatusBadge>
      )}
    </li>
  );
}

function hasReportContent(report: ProjectTrustReport | null): boolean {
  if (!report) return false;
  return (
    report.mcpServers.length > 0
    || report.permissions.length > 0
    || report.agentsMdOverrides.length > 0
    || report.modelOverrides.length > 0
    || report.otherConfigOverrides.length > 0
    || report.definitions.length > 0
    || report.instructionFiles.length > 0
  );
}

/** Trust decision dialog for a bound project with a project surface. */
export function TrustProjectDialog({
  open,
  cwd,
  trustState,
  report,
  busy,
  onGrant,
  onDecline,
  readOnly = false,
}: TrustProjectDialogProps) {
  const primaryActionRef = useRef<HTMLButtonElement>(null);

  return (
    <DialogSurface
      isOpen={open}
      onClose={onDecline}
      labelledBy="trust-project-dialog-title"
      describedBy="trust-project-dialog-desc"
      initialFocusRef={primaryActionRef}
      variant="modal"
      closeOnBackdrop
      closeOnEscape
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary"
            aria-hidden
          >
            <Icon name="shield" size={16} />
          </span>
          <div className="min-w-0">
            <h2 id="trust-project-dialog-title" className="m-0 text-base font-semibold leading-snug">
              {readOnly ? 'Project trust surface' : 'Do you trust this project folder?'}
            </h2>
            <p id="trust-project-dialog-desc" className="mono mt-1 break-all text-xs text-base-content/70">
              {cwd}
            </p>
          </div>
        </div>

        {trustState === 'changed' && (
          <Alert tone="warning" icon="alert">
            This project changed since you trusted it. Review the updated surface before continuing.
          </Alert>
        )}

        {report && hasReportContent(report) ? (
          <div className="flex max-h-96 flex-col gap-3 overflow-y-auto pr-1">
            <p className="m-0 text-xs text-base-content/70">
              Project files can change how Orchid behaves in this folder. Review what this project
              adds or overrides before trusting it.
            </p>

            {report.mcpServers.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="MCP servers"
                  description="Processes this project can start."
                />
                <ul className="m-0 flex flex-col gap-1.5 p-0">
                  {report.mcpServers.map((server) => (
                    <McpServerRow key={server.name} server={server} />
                  ))}
                </ul>
              </section>
            )}

            {report.permissions.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Tool permissions"
                  description="Rules this project sets for tool execution."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.permissions.map((entry) => (
                    <PermissionRow
                      key={`${entry.tool}:${entry.rule}`}
                      entry={entry}
                    />
                  ))}
                </ul>
              </section>
            )}

            {report.agentsMdOverrides.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Instruction-file policy overrides"
                  description="AGENTS.md handling this project changes."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.agentsMdOverrides.map((entry) => (
                    <ConfigOverrideRow key={entry.key} entry={entry} />
                  ))}
                </ul>
              </section>
            )}

            {report.modelOverrides.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Model overrides"
                  description="Model selections this project changes."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.modelOverrides.map((entry) => (
                    <ModelOverrideRow key={entry.key} entry={entry} />
                  ))}
                </ul>
              </section>
            )}

            {report.otherConfigOverrides.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Config overrides"
                  description="Other settings this project changes."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.otherConfigOverrides.map((entry) => (
                    <ConfigOverrideRow key={entry.key} entry={entry} />
                  ))}
                </ul>
              </section>
            )}

            {report.definitions.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Project definitions"
                  description="Agents, skills, and personalities this folder provides."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.definitions.map((entry) => (
                    <DefinitionRow key={`${entry.kind}:${entry.name}`} entry={entry} />
                  ))}
                </ul>
              </section>
            )}

            {report.instructionFiles.length > 0 && (
              <section className="flex flex-col gap-1.5">
                <SectionHeader
                  as="div"
                  title="Instruction files"
                  description="Root instruction files injected into agent context."
                />
                <ul className="m-0 flex flex-col gap-0.5 p-0">
                  {report.instructionFiles.map((file) => (
                    <li key={file} className="mono truncate px-1 py-0.5 text-sm">
                      {file}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <StateMessage kind="empty" title="No project-specific configuration found." />
        )}

        <div className="flex items-center justify-end gap-2 border-t border-base-300 pt-3">
          {readOnly ? (
            <Button ref={primaryActionRef} variant="primary" onClick={onDecline} disabled={busy}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onDecline} disabled={busy}>
                Don&apos;t Trust
              </Button>
              <Button
                ref={primaryActionRef}
                variant="primary"
                onClick={onGrant}
                disabled={busy}
                loading={busy}
              >
                Trust &amp; Continue
              </Button>
            </>
          )}
        </div>
      </div>
    </DialogSurface>
  );
}
