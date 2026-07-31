import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { StateMessage } from './StateMessage';

export interface ErrorBoundaryProps {
  children: ReactNode;
  title: string;
  className?: string;
  onRetry?: () => void;
}

interface ErrorBoundaryState {
  failed: boolean;
}

/** React requires the class lifecycle API to catch descendant render errors. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] lazy surface failed', error, info);
  }

  private readonly retry = (): void => {
    this.setState({ failed: false });
    if (this.props.onRetry) this.props.onRetry();
    else window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className={this.props.className ?? 'flex h-screen min-h-0 items-center justify-center bg-base-100 text-base-content'}>
        <StateMessage
          kind="error"
          title={this.props.title}
          action={<Button variant="error" size="sm" onClick={this.retry}>Reload Orchid</Button>}
        >
          Reload Orchid and try again.
        </StateMessage>
      </div>
    );
  }
}
