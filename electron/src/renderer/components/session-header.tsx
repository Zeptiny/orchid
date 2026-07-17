import type { Session } from '../../shared/types/session';
import type { WorkspaceInfo } from '../../shared/types/ipc';
import { Icon } from './Icon';

interface SessionHeaderProps {
  session: Session | null;
  workspace: WorkspaceInfo | null;
}

function projectName(cwd: string | null): string {
  if (!cwd) return 'New chat';
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/** Persistent identity chrome for the session currently shown in the center pane. */
export function SessionHeader({ session, workspace }: SessionHeaderProps) {
  const cwd = session?.cwd ?? workspace?.cwd ?? null;
  const title = session?.name ?? 'New chat';

  return (
    <header
      className="session-header border-b border-base-300 bg-base-100"
      title={cwd ?? undefined}
    >
      <div className="session-header-title truncate text-sm font-semibold">
        <span className="session-header-project text-base-content/70">{projectName(cwd)}</span>
        <span className="session-header-separator text-base-content/40">/</span>
        <span className="truncate">{title}</span>
      </div>
      <div className="session-header-path mono truncate text-xs text-base-content/60">
        <Icon name="folder" size={11} />
        <span>{cwd ?? 'Choose a project folder to begin'}</span>
      </div>
    </header>
  );
}
