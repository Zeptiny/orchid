import type { Usage } from '../../shared/types/message';
import { hasUsage } from '../../shared/usage';
import { Icon } from './Icon';

interface ChainFooterProps {
  usage: Usage | null;
  /** Subagent token usage for this turn; omitted from the footer when empty/zero. */
  subUsage?: Usage | null;
  elapsedSeconds?: number;
  interrupted?: boolean;
}

export function ChainFooter({
  usage,
  subUsage,
  elapsedSeconds,
  interrupted,
}: ChainFooterProps) {
  const agentIn = fmt(usage?.prompt_tokens);
  const agentCached = fmt(usage?.cached_tokens);
  const agentOut = fmt(usage?.completion_tokens);
  const showSub = hasUsage(subUsage);

  return (
    <div className="chain-footer">
      {interrupted && (
        <span className="chain-footer-interrupted">
          <Icon name="square" size={12} />
          Interrupted
        </span>
      )}
      <span>
        agent: in {agentIn} cached {agentCached} out {agentOut}
      </span>
      {showSub && subUsage && (
        <span>
          sub: in {fmt(subUsage.prompt_tokens)} cached {fmt(subUsage.cached_tokens)} out{' '}
          {fmt(subUsage.completion_tokens)}
        </span>
      )}
      {elapsedSeconds != null && elapsedSeconds > 0 && <span>{fmtElapsed(elapsedSeconds)}</span>}
    </div>
  );
}

function fmt(n: number | undefined): string {
  if (!n) return '0';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}
