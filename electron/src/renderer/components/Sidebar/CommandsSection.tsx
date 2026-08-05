import type { BackgroundCommandsState } from '../../hooks/useBackgroundCommands';
import { LiveCommandInline } from '../ToolWidgets/LiveCommandInline';
import { Button } from '../ui/Button';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';

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

  return (
    <div className="inspector-stack">
      {state.commands.map((item) => (
        <div key={item.id} className="inspector-stack gap-0">
          {item.scopeName !== 'main' && (
            <StatusBadge tone="info" size="xs" className="self-start">
              {item.scopeName}
            </StatusBadge>
          )}
          <LiveCommandInline
            target={{ commandId: item.id }}
            sessionId={sessionId}
            commandText={item.command}
            description={item.description}
          />
        </div>
      ))}
    </div>
  );
}
