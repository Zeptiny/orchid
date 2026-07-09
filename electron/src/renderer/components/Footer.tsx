/**
 * Footer — chat footer at the bottom of the center pane.
 *
 * Idle: keyboard shortcuts. Streaming / interrupt: agent status + Esc hints.
 */
import type { InterruptState } from '../hooks/useChat';
import { Icon } from './Icon';

interface FooterProps {
  elapsedSeconds: number;
  isStreaming: boolean;
  /** Current interrupt confirmation phase (from staged Esc flow). */
  interruptState?: InterruptState;
}

export function Footer({ elapsedSeconds, isStreaming, interruptState }: FooterProps) {
  const confirming = interruptState && interruptState !== 'idle';

  if (isStreaming || confirming) {
    return (
      <div className="chat-footer">
        {confirming ? (
          <span className="interrupt-hint inline-flex items-center gap-1 font-medium text-warning">
            <Icon name="alert" size={12} />
            {interruptState === 'confirmSubagents'
              ? 'Esc again: cancel subagents'
              : 'Esc again: cancel agent'}
          </span>
        ) : (
          <span className="agent-status inline-flex items-center gap-1 text-success">
            <Icon name="loader" size={12} className="animate-spin" />
            Running
          </span>
        )}
        <span>-</span>
        <span>elapsed {formatElapsed(elapsedSeconds)}</span>
        <span>-</span>
        <span>
          <kbd className="kbd">Esc</kbd> to {confirming ? 'confirm' : 'interrupt'}
        </span>
      </div>
    );
  }

  return (
    <div className="chat-footer">
      <span>
        <kbd className="kbd">Ctrl K</kbd> commands
      </span>
      <span>-</span>
      <span>
        <kbd className="kbd">Ctrl B</kbd> inspector
      </span>
      <span>-</span>
      <span>
        <kbd className="kbd">Ctrl N</kbd> new session
      </span>
    </div>
  );
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}
