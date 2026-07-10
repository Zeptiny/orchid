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
}

export function CollapsedChainStub({
  chain,
  chainIndex,
  onExpand,
}: CollapsedChainStubProps) {
  const preview = chainPreview(chain);
  return (
    <button
      type="button"
      className="collapsed-chain-stub"
      onClick={() => onExpand(chainIndex)}
      aria-label={`Expand chain ${chainIndex + 1}: ${preview}`}
    >
      <Icon name="chevronRight" size={14} />
      <span>
        Chain {chainIndex + 1}: {preview}
      </span>
    </button>
  );
}

function chainPreview(chain: Chain): string {
  const user = chain.messages.find(
    (m) => m.role === MessageRole.USER && m.type === MessageType.TEXT,
  );
  if (user?.content) {
    const text = user.content.trim();
    return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  }
  const n = chain.messages.length;
  return n === 1 ? '1 message' : `${n} messages`;
}
