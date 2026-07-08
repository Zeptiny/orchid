/**
 * Footer — status bar at the bottom of the chat.
 *
 * Uses DaisyUI components for styling.
 */
import type { Usage } from '../../shared/types/message';

interface FooterProps {
  model: string;
  usage: Usage | null;
  elapsedSeconds: number;
  isStreaming: boolean;
}

export function Footer({ model, usage, elapsedSeconds, isStreaming }: FooterProps) {
  return (
    <div className="btm-nav btm-nav-sm bg-base-200 border-t border-base-300 h-8">
      <div className="flex items-center gap-2 px-4 text-xs">
        <span className="font-medium">Model:</span>
        <span className="opacity-70">{model || '—'}</span>
        {usage && (
          <>
            <span className="opacity-30">|</span>
            <span className="font-medium">Prompt:</span>
            <span className="opacity-70">{formatTokens(usage.prompt_tokens)}</span>
            <span className="opacity-30">|</span>
            <span className="font-medium">Cached:</span>
            <span className="opacity-70">{formatTokens(usage.cached_tokens)}</span>
            <span className="opacity-30">|</span>
            <span className="font-medium">Completion:</span>
            <span className="opacity-70">{formatTokens(usage.completion_tokens)}</span>
          </>
        )}
        {isStreaming && (
          <>
            <span className="opacity-30">|</span>
            <span className="font-medium">Elapsed:</span>
            <span className="opacity-70">{formatElapsed(elapsedSeconds)}</span>
          </>
        )}
      </div>
      <div className="flex items-center justify-end px-4 text-xs opacity-50">
        Ctrl+K: Command Palette · Ctrl+B: Sidebar · Esc: Cancel
      </div>
    </div>
  );
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
