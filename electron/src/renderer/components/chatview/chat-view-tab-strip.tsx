/**
 * Main-pane header: the durable session tab strip plus the active session's
 * header row. Presentation only — every action belongs to the shell.
 */
import { SessionHeader } from '../session-header';
import { SessionTabBar } from '../SessionTabBar';
import { workspaceProjectName } from './chat-view-selectors';
import type { SessionActivity, SessionSummary } from '../../../shared/types/ipc-boundary';
import type { Session } from '../../../shared/types/session';
import type { WorkspaceInfo } from '../../../shared/types/ipc';
import type { UseSessionTabsReturn } from '../../hooks/useSessionTabs';

export interface ChatViewTabStripProps {
  tabs: UseSessionTabsReturn['snapshot'];
  sessions: readonly SessionSummary[];
  activities: readonly SessionActivity[];
  /** Draft placeholder shows only while no session is open. */
  showDraft: boolean;
  session: Session | null;
  workspace: WorkspaceInfo | null;
  onSelect: (sessionId: string) => void;
  onSelectDraft: () => void;
  onClose: (sessionId: string) => void;
  onCloseDraft: () => void;
  onRename: (sessionId: string, name: string) => Promise<void>;
}

export function ChatViewTabStrip({
  tabs,
  sessions,
  activities,
  showDraft,
  session,
  workspace,
  onSelect,
  onSelectDraft,
  onClose,
  onCloseDraft,
  onRename,
}: ChatViewTabStripProps) {
  return (
    <>
      <SessionTabBar
        openSessionIds={tabs.openSessionIds}
        focusedSessionId={tabs.focusedSessionId}
        sessions={sessions}
        activities={activities}
        showDraft={showDraft}
        draftLabel="New chat"
        draftProjectName={workspaceProjectName(workspace?.cwd)}
        onSelect={onSelect}
        onSelectDraft={onSelectDraft}
        onClose={onClose}
        onCloseDraft={onCloseDraft}
        onRename={onRename}
      />
      <SessionHeader
        session={session}
        workspace={workspace}
      />
    </>
  );
}
