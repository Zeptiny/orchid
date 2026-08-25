import { memo, type ReactNode } from 'react';
import type { Session } from '../../shared/types/session';
import type { WorkspaceInfo } from '../../shared/types/ipc';
import { Icon } from './Icon';

interface SessionHeaderProps {
  session: Session | null;
  workspace: WorkspaceInfo | null;
  /** Right-aligned chrome rendered beside the identity. */
  actions?: ReactNode;
}

function projectName(cwd: string | null): string {
  if (!cwd) return 'New chat';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/** Persistent identity chrome for the session currently shown in the center pane. */
export const SessionHeader = memo(function SessionHeader({ session, workspace, actions }: SessionHeaderProps) {
  const cwd = session?.cwd ?? workspace?.cwd ?? null;
  const title = session?.name ?? 'New chat';

  return (
    <header className="session-header flex items-start justify-between gap-2" title={cwd ?? undefined}>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="session-header-title truncate">
          <span className="session-header-project">{projectName(cwd)}</span>
          <span className="session-header-separator">/</span>
          <span className="truncate">{title}</span>
        </div>
        <div className="session-header-path mono truncate">
          <Icon name="folder" size={11} />
          <span>{cwd ?? 'Choose a project folder to begin'}</span>
        </div>
      </div>
      {actions != null && <div className="flex shrink-0 items-start pt-0.5">{actions}</div>}
    </header>
  );
});
