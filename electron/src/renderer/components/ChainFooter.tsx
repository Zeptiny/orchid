import type { Usage } from '../../shared/types/message';
import { hasUsage } from '../../shared/usage';
import { formatTokenCount, formatUsageSummary } from '../utils/format-usage';
import { Icon } from './Icon';
import { StatusBadge } from './ui/StatusBadge';

interface ChainFooterProps {
  usage: Usage | null;
  /** Subagent token usage for this turn; omitted from the footer when empty/zero. */
  subUsage?: Usage | null;
  /** Model id for this chain (Python footer: `model · elapsed · usage`). */
  model?: string | null;
  elapsedSeconds?: number;
  interrupted?: boolean;
  failed?: boolean;
}

export function ChainFooter({
  usage,
  subUsage,
  model,
  elapsedSeconds,
  interrupted,
  failed,
}: ChainFooterProps) {
  const showSub = hasUsage(subUsage);
  const showUsage = hasUsage(usage);

  return (
    <div className="orchid-chain-footer">
      {interrupted && (
        <StatusBadge tone="warning" size="xs" className="gap-1">
          <Icon name="square" size={12} />
          Interrupted
        </StatusBadge>
      )}
      {failed && !interrupted && (
        <StatusBadge tone="error" size="xs" className="gap-1">
          <Icon name="alert" size={12} />
          Failed
        </StatusBadge>
      )}
      {model ? (
        <span className="orchid-chain-footer-model">{model}</span>
      ) : null}
      {showUsage && (
        <span>
          agent: {formatUsageSummary(usage)}
        </span>
      )}
      {showSub && subUsage && (
        <span>
          sub: {formatUsageSummary(subUsage)}
        </span>
      )}
      {elapsedSeconds != null && elapsedSeconds > 0 && <span>{fmtElapsed(elapsedSeconds)}</span>}
    </div>
  );
}

export function formatChainTokens(n: number | undefined): string {
  return formatTokenCount(n);
}

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs}s`;
}
