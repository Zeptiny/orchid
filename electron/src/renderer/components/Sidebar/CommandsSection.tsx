/**
 * CommandsSection — session-wide background command fleet (inspector).
 *
 * Mirrors the Subagents section organization: running commands stay visible
 * with live output widgets, while terminal commands hide behind an
 * "Other commands" dropdown menu. Every row carries an explicit status badge.
 */
import type { BgCommandListItem } from '../../../shared/types/ipc';
import type { BackgroundCommandsState } from '../../hooks/useBackgroundCommands';
import { Icon } from '../Icon';
import { LiveCommandInline } from '../ToolWidgets/LiveCommandInline';
import { Button } from '../ui/Button';
import { DropdownMenu } from '../ui/DropdownMenu';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';

// ── Status partition ─────────────────────────────────────────────────────────

export interface CommandStatusGroups {
  running: readonly BgCommandListItem[];
  ended: readonly BgCommandListItem[];
}

/** Keep active work visible while putting terminal commands behind a menu. */
export function partitionCommandsByStatus(
  commands: readonly BgCommandListItem[],
): CommandStatusGroups {
  return {
    running: commands.filter((item) => item.running),
    ended: commands.filter((item) => !item.running),
  };
}

export function countRunningCommands(commands: readonly BgCommandListItem[]): number {
  return commands.filter((item) => item.running).length;
}

function CommandStateBadge({ item }: { item: BgCommandListItem }) {
  if (item.running) {
    return <StatusBadge tone="warning" size="xs">running</StatusBadge>;
  }
  if (item.exitCode === 0) {
    return <StatusBadge tone="success" size="xs">done</StatusBadge>;
  }
  if (item.exitCode !== null) {
    return <StatusBadge tone="error" size="xs">exit {item.exitCode}</StatusBadge>;
  }
  return <StatusBadge tone="neutral" size="xs">ended</StatusBadge>;
}

// ── Section ──────────────────────────────────────────────────────────────────

interface CommandsSectionProps {
  state: BackgroundCommandsState;
  onRefresh: () => void;
  sessionId: string | null;
}

export function CommandsSection({ state, onRefresh, sessionId }: CommandsSectionProps) {
  if (state.status === 'loading') {
    return <StateMessage kind="loading" className="inspector-empty py-4" title="Loading commands…" />;
  }

  if (state.status === 'error') {
    return (
      <StateMessage
        kind="error"
        className="inspector-empty py-4"
        title={state.error}
        action={
          <Button variant="ghost" size="xs" onClick={onRefresh}>
            Retry
          </Button>
        }
      />
    );
  }

  if (state.status === 'empty') {
    return (
      <StateMessage
        kind="empty"
        className="inspector-empty py-4"
        title="No background commands"
      />
    );
  }

  const { running, ended } = partitionCommandsByStatus(state.commands);

  return (
    <div className="inspector-stack">
      {running.map((item) => (
        <CommandRow key={item.id} item={item} sessionId={sessionId} />
      ))}
      {ended.length > 0 && (
        <DropdownMenu
          label={`Show ${ended.length} other ${ended.length === 1 ? 'command' : 'commands'}`}
          placement="bottom-start"
          className="w-full orchid-command-dropdown-flow"
          triggerClassName="btn btn-ghost btn-xs h-7 min-h-7 w-full justify-between px-1.5 font-normal text-left"
          menuClassName="w-full max-h-64 overflow-y-auto rounded-box border border-base-300 bg-base-200 p-1 shadow-lg"
          trigger={
            <span className="inline-flex w-full items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Icon name="chevronDown" size={12} className="shrink-0 opacity-60" />
                <span className="truncate">Other commands</span>
              </span>
              <StatusBadge tone="neutral" size="xs" outline>
                {ended.length}
              </StatusBadge>
            </span>
          }
        >
          <div className="inspector-stack gap-0" role="presentation">
            {ended.map((item) => (
              <CommandRow key={item.id} item={item} sessionId={sessionId} />
            ))}
          </div>
        </DropdownMenu>
      )}
    </div>
  );
}

// ── Row ──────────────────────────────────────────────────────────────────────

interface CommandRowProps {
  item: BgCommandListItem;
  sessionId: string | null;
}

function CommandRow({ item, sessionId }: CommandRowProps) {
  return (
    <div className="inspector-stack gap-0">
      <div className="flex items-center gap-1">
        {item.scopeName !== 'main' && (
          <StatusBadge tone="info" size="xs">
            {item.scopeName}
          </StatusBadge>
        )}
        <CommandStateBadge item={item} />
      </div>
      <LiveCommandInline
        target={{ commandId: item.id }}
        sessionId={sessionId}
        commandText={item.command}
        description={item.description}
        expectedCreatedAt={item.createdAt}
      />
    </div>
  );
}
