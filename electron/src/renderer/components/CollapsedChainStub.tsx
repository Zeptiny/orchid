/**
 * Clickable placeholder for an older chain (Python CollapsedChainStub).
 * Bounds DOM size for long multi-chain sessions.
 */
import type { Chain } from '../../shared/types/chain';
import { MessageRole, MessageType } from '../../shared/types/message';
import { Icon } from './Icon';

interface CollapsedChainStubProps {
  chain: Chain;
  chainIndex: number;
  onExpand: (chainIndex: number) => void;
  mode?: 'chain' | 'history';
  loading?: boolean;
}

export function CollapsedChainStub({
  chain,
  chainIndex,
  onExpand,
  mode = 'chain',
  loading = false,
}: CollapsedChainStubProps) {
  const preview = chainPreview(chain);
  const label = mode === 'history'
    ? historyLabel(loading)
    : `Chain ${chainIndex + 1}: ${preview}`;
  return (
    <button
      type="button"
      className="orchid-collapsed-chain"
      onClick={() => onExpand(chainIndex)}
      aria-label={mode === 'history' ? label : `Expand chain ${chainIndex + 1}: ${preview}`}
      disabled={loading}
    >
      <Icon name="chevronRight" size={14} />
      <span>
        {label}
      </span>
    </button>
  );
}

function historyLabel(loading: boolean): string {
  return loading ? 'Loading earlier messages…' : 'Load earlier messages';
}

function chainPreview(chain: Chain): string {
  const user = chain.messages.find(
    (m) => m.role === MessageRole.USER && m.type === MessageType.TEXT,
  );
  if (user?.content) {
    const text = user.content.trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  if (chain.preview) return chain.preview;
  const n = chain.messageCount ?? chain.messages.length;
  return n === 1 ? '1 message' : `${n} messages`;
}
