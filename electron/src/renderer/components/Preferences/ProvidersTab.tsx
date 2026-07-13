/**
 * Temporary disconnected-provider panel.
 *
 * U1 removes the legacy alias/API-key editor so renderer state cannot retain
 * reusable credentials. U8 replaces this with the connection wizard backed by
 * dedicated provider IPC.
 */
import { Icon } from '../Icon';

export function ProvidersTab() {
  return (
    <div role="alert" className="alert alert-info">
      <Icon name="alert" size={16} />
      <span>
        Provider connections are not available in this build yet. You can continue using local workspace, history, and settings features.
      </span>
    </div>
  );
}
