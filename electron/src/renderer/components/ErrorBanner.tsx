import type { AlertTone } from './ui/Alert';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { Icon, type IconName } from './Icon';

type ErrorKind = 'stream' | 'rate-limit' | 'auth' | 'generic' | 'tool';

interface ErrorVariant {
  kind: ErrorKind;
  title: string;
  icon: IconName;
  tone: AlertTone;
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
      tone: 'warning',
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
      tone: 'error',
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
      tone: 'error',
    };
  }
  return {
    kind: 'generic',
    title: 'Agent error',
    icon: 'alertCircle',
    tone: 'error',
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
    <Alert
      tone={variant.tone}
      icon={variant.icon}
      className="orchid-error-banner"
    >
      <div className="orchid-error-body">
        <div className="orchid-error-title">{variant.title}</div>
        <div className="orchid-error-message">{message}</div>
        <div className="orchid-error-actions">
          {(variant.kind === 'stream' || variant.kind === 'rate-limit' || variant.kind === 'generic') &&
            onRetry && (
              <Button variant="primary" size="xs" className="gap-1" onClick={onRetry}>
                <Icon name="refresh" size={12} />
                {variant.kind === 'rate-limit' && retrySeconds
                  ? `Retry in ${retrySeconds}s`
                  : 'Retry'}
              </Button>
            )}
          {variant.kind === 'rate-limit' && onOpenSettings && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                onOpenSettings();
                onDismiss();
              }}
            >
              Switch Model
            </Button>
          )}
          {variant.kind === 'auth' && onOpenSettings && (
            <Button variant="primary" size="xs" className="gap-1" onClick={onOpenSettings}>
              <Icon name="settings" size={12} />
              Open Settings
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </div>
    </Alert>
  );
}
