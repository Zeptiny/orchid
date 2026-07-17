import { Icon, type IconName } from './Icon';

type ErrorKind = 'stream' | 'rate-limit' | 'auth' | 'generic' | 'tool';

interface ErrorVariant {
  kind: ErrorKind;
  title: string;
  icon: IconName;
  alertClass: string;
}

interface ErrorBannerProps {
  message: string;
  onDismiss: () => void;
  onOpenSettings?: () => void;
  onRetry?: () => void;
}

function classifyError(message: string): ErrorVariant {
  const lower = message.toLowerCase();

  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('usage limit')) {
    return {
      kind: 'rate-limit',
      title: 'Rate limited',
      icon: 'alert',
      alertClass: 'alert-warning',
    };
  }
  if (
    lower.includes('auth') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('api key') ||
    lower.includes('invalid key')
  ) {
    return {
      kind: 'auth',
      title: 'Authentication failed',
      icon: 'lock',
      alertClass: 'alert-error',
    };
  }
  if (
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('connection')
  ) {
    return {
      kind: 'stream',
      title: 'Stream failed',
      icon: 'alertCircle',
      alertClass: 'alert-error',
    };
  }
  return {
    kind: 'generic',
    title: 'Agent error',
    icon: 'alertCircle',
    alertClass: 'alert-error',
  };
}

function extractRetrySeconds(message: string): number | null {
  const match = /(\d+)\s*s/.exec(message);
  if (match) return parseInt(match[1], 10);
  return null;
}

export function ErrorBanner({ message, onDismiss, onOpenSettings, onRetry }: ErrorBannerProps) {
  const variant = classifyError(message);
  const retrySeconds = variant.kind === 'rate-limit' ? extractRetrySeconds(message) : null;

  return (
    <div
      className={`error-banner-inline orchid-error-banner alert ${variant.alertClass}`}
      role="alert"
    >
      <Icon name={variant.icon} size={16} className="shrink-0" />
      <div className="error-banner-body orchid-error-body">
        <div className="error-banner-title orchid-error-title">{variant.title}</div>
        <div className="error-banner-message orchid-error-message">{message}</div>
        <div className="error-banner-actions orchid-error-actions">
          {(variant.kind === 'stream' || variant.kind === 'rate-limit' || variant.kind === 'generic') &&
            onRetry && (
              <button className="btn btn-primary btn-xs gap-1" onClick={onRetry} type="button">
                <Icon name="refresh" size={12} />
                {variant.kind === 'rate-limit' && retrySeconds
                  ? `Retry in ${retrySeconds}s`
                  : 'Retry'}
              </button>
            )}
          {variant.kind === 'rate-limit' && onOpenSettings && (
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => {
                onOpenSettings();
                onDismiss();
              }}
              type="button"
            >
              Switch Model
            </button>
          )}
          {variant.kind === 'auth' && onOpenSettings && (
            <button className="btn btn-primary btn-xs gap-1" onClick={onOpenSettings} type="button">
              <Icon name="settings" size={12} />
              Open Settings
            </button>
          )}
          <button className="btn btn-ghost btn-xs" onClick={onDismiss} type="button">
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
