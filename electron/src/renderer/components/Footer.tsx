/**
 * Footer — status bar at the bottom of the chat.
 *
 * Displays:
 * - Model label
 * - Token usage (prompt/cached/completion)
 * - Elapsed time
 * - Keyboard shortcuts hint
 */
import type { Usage } from '../../shared/types/message';

// ── Props ────────────────────────────────────────────────────────────────────

interface FooterProps {
  model: string;
  usage: Usage | null;
  elapsedSeconds: number;
  isStreaming: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export function Footer({ model, usage, elapsedSeconds, isStreaming }: FooterProps) {
  return (
    <div className="footer">
      <div className="footer-left">
        <div className="footer-item">
          <span className="footer-label">Model:</span>
          <span className="footer-value">{model || '—'}</span>
        </div>
        {usage && (
          <>
            <span className="footer-separator">|</span>
            <div className="footer-item">
              <span className="footer-label">Prompt:</span>
              <span className="footer-value">{formatTokens(usage.prompt_tokens)}</span>
            </div>
            <div className="footer-item">
              <span className="footer-label">Cached:</span>
              <span className="footer-value">{formatTokens(usage.cached_tokens)}</span>
            </div>
            <div className="footer-item">
              <span className="footer-label">Completion:</span>
              <span className="footer-value">{formatTokens(usage.completion_tokens)}</span>
            </div>
          </>
        )}
        {isStreaming && (
          <>
            <span className="footer-separator">|</span>
            <div className="footer-item">
              <span className="footer-label">Elapsed:</span>
              <span className="footer-value">{formatElapsed(elapsedSeconds)}</span>
            </div>
          </>
        )}
      </div>
      <div className="footer-right">
        <div className="footer-item">
          Ctrl+K: Command Palette &middot; Ctrl+B: Sidebar &middot; Esc: Cancel
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
