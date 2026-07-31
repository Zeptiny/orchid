import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { StartupSnapshot, StartupStepState } from '../../shared/types/ipc-boundary';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { StateMessage } from './ui/StateMessage';
import { StatusBadge, type StatusBadgeTone } from './ui/StatusBadge';

export interface StartupScreenProps {
  /** Called only after main publishes the terminal ready snapshot. */
  onReady: () => void;
}

const STEP_STATE_LABEL: Record<StartupStepState, string> = {
  pending: 'Pending',
  active: 'In progress',
  complete: 'Complete',
  skipped: 'Skipped',
  warning: 'Needs attention',
  failed: 'Failed',
};

const STEP_STATE_TONE: Record<StartupStepState, StatusBadgeTone> = {
  pending: 'ghost',
  active: 'info',
  complete: 'success',
  skipped: 'ghost',
  warning: 'warning',
  failed: 'error',
};

interface StartupViewState {
  snapshot: StartupSnapshot | null;
  revision: number;
}

/** Snapshot and event delivery races always reduce to the highest revision. */
function revisionMaxReducer(state: StartupViewState, next: StartupSnapshot): StartupViewState {
  return next.revision > state.revision
    ? { snapshot: next, revision: next.revision }
    : state;
}

function statusText(snapshot: StartupSnapshot | null): string {
  if (!snapshot) return 'Starting Orchid…';
  if (snapshot.phase === 'degraded') return 'Tool workers need your attention';
  if (snapshot.phase === 'failed') return 'Orchid could not finish starting';

  const activeStep = snapshot.steps.find((step) => step.state === 'active');
  return activeStep ? `${activeStep.label}…` : 'Preparing Orchid…';
}

/**
 * The renderer-side half of startup. It observes main's revisioned snapshots
 * and deliberately owns no startup state beyond the newest snapshot received.
 */
export function StartupScreen({ onReady }: StartupScreenProps) {
  const [{ snapshot }, dispatchSnapshot] = useReducer(revisionMaxReducer, {
    snapshot: null,
    revision: -1,
  });
  const [continuing, setContinuing] = useState(false);
  const revisionRef = useRef(-1);
  const readyRevisionRef = useRef<number | null>(null);
  const continuingRef = useRef(false);

  const applySnapshot = useCallback((next: StartupSnapshot) => {
    if (next.revision <= revisionRef.current) return;

    revisionRef.current = next.revision;
    dispatchSnapshot(next);
    if (next.phase === 'ready' && readyRevisionRef.current !== next.revision) {
      readyRevisionRef.current = next.revision;
      onReady();
    }
  }, [onReady]);

  useEffect(() => {
    const bridge = window.orchid?.startup;
    if (!bridge) return undefined;

    let disposed = false;
    // Subscribe first: a newer event that lands while snapshot() is pending
    // wins through the monotonic revision floor below.
    const unsubscribe = bridge.onChanged((next) => {
      if (!disposed) applySnapshot(next);
    });

    void bridge.snapshot().then(
      (next) => {
        if (!disposed) applySnapshot(next);
      },
      () => {
        // The static shell remains meaningful if startup IPC cannot hydrate.
      },
    );

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [applySnapshot]);

  const continueWithInlineTools = useCallback(() => {
    const bridge = window.orchid?.startup;
    if (!bridge || continuingRef.current || snapshot?.phase !== 'degraded') return;

    continuingRef.current = true;
    setContinuing(true);
    void bridge.continueDegraded().then(
      (result) => {
        applySnapshot(result.snapshot);
        if (result.snapshot.phase !== 'ready') {
          continuingRef.current = false;
          setContinuing(false);
        }
      },
      () => {
        continuingRef.current = false;
        setContinuing(false);
      },
    );
  }, [applySnapshot, snapshot?.phase]);

  if (!snapshot) {
    return (
      <main className="flex h-screen items-center justify-center bg-base-100 text-base-content" aria-label="Starting Orchid">
        <StateMessage kind="loading" title="Starting Orchid…" role="status" aria-live="polite" />
      </main>
    );
  }

  const failed = snapshot.phase === 'failed';
  const degraded = snapshot.phase === 'degraded';

  return (
    <main className="flex h-screen items-center justify-center bg-base-100 px-5 text-base-content" aria-labelledby="startup-title">
      <section className="w-full max-w-xl space-y-6" aria-describedby="startup-status">
        <header className="flex items-center gap-3">
          <img src="./assets/orchid-icon.svg" width="36" height="36" alt="" aria-hidden />
          <div>
            <h1 id="startup-title" className="font-display text-xl font-semibold tracking-tight">Orchid</h1>
            <p id="startup-status" className="mt-1 text-sm text-base-content/65" role="status" aria-live="polite" aria-atomic="true">
              {statusText(snapshot)}
            </p>
          </div>
        </header>

        {failed ? (
          <Alert tone="error" variant="soft" icon="alertCircle" title="Orchid could not finish starting">
            <p className="text-sm">Quit Orchid and start it again. If this keeps happening, check for an app update.</p>
          </Alert>
        ) : degraded ? (
          <Alert
            tone="warning"
            variant="soft"
            icon="alert"
            title="Tool workers are unavailable"
            action={(
              <Button variant="warning" size="sm" loading={continuing} onClick={continueWithInlineTools}>
                Continue with inline tools
              </Button>
            )}
          >
            <p className="text-sm">Orchid can continue with inline tools, which may be less responsive for local work.</p>
          </Alert>
        ) : null}

        <ol className="space-y-2" aria-label="Startup steps">
          {snapshot.steps.map((step) => (
            <li key={step.id} className="flex items-center justify-between gap-4 rounded-box border border-base-content/10 bg-base-200/40 px-4 py-3">
              <span className="min-w-0 text-sm font-medium">{step.label}</span>
              <StatusBadge tone={STEP_STATE_TONE[step.state]} size="sm" withDot className="shrink-0">
                {STEP_STATE_LABEL[step.state]}
              </StatusBadge>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
