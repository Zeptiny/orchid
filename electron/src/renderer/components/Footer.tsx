/**
 * Footer — status bar at the bottom of the chat.
 *
 * Uses DaisyUI components for styling.
 */
import type { Usage } from '../../shared/types/message';
import type { InterruptState } from '../hooks/useChat';

interface FooterProps {
  model: string;
  usage: Usage | null;
  elapsedSeconds: number;
  isStreaming: boolean;
  /** Current interrupt confirmation phase (from two-phase Esc flow). */
  interruptState?: InterruptState;
}

export function Footer({ model, usage, elapsedSeconds, isStreaming, interruptState }: FooterProps) {
  const showInterruptHint = interruptState && interruptState !== 'idle';

  return (
    <div className="btm-nav btm-nav-sm bg-base-200 border-t border-base-300 h-8">
      <div className="flex items-center gap-2 px-4 text-xs">
        <span className="font-medium">Model:</span>
        <span className="opacity-70">{model || '—'}</span>
        {isStreaming && (
          <>
            <span className="opacity-30">|</span>
            <span className="font-medium">Elapsed:</span>
            <span className="opacity-70">{formatElapsed(elapsedSeconds)}</span>
          </>
        )}
        {!isStreaming && usage && (
          <>
            <span className="opacity-30">|</span>
            <span className="opacity-70">{formatUsageCompact(usage)}</span>
          </>
        )}
        {showInterruptHint && (
          <>
            <span className="opacity-30">|</span>
            <span className="text-warning font-medium animate-pulse">
              {interruptState === 'confirmSubagents'
                ? 'Esc again: cancel subagents'
                : 'Esc again: cancel agent'}
            </span>
          </>
        )}
      </div>
      <div className="flex items-center justify-end px-4 text-xs opacity-50">
        Ctrl+K: Command Palette · Ctrl+B: Sidebar · Esc: Cancel
      </div>
    </div>
  );
}

/**
 * Compact usage format: ΣX · ↑Y (⟲Z) ↓W
 *
 * - ΣX = total tokens
 * - ↑Y = prompt tokens
 * - (⟲Z) = cached tokens (only shown if > 0)
 * - ↓W = completion tokens
 */
function formatUsageCompact(usage: Usage): string {
  const total = formatTokens(usage.total_tokens);
  const prompt = formatTokens(usage.prompt_tokens);
  const completion = formatTokens(usage.completion_tokens);

  let result = `Σ${total} · ↑${prompt}`;

  if (usage.cached_tokens > 0) {
    const cached = formatTokens(usage.cached_tokens);
    result += ` (⟲${cached})`;
  }

  result += ` ↓${completion}`;
  return result;
}

function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}
