/**
 * useTrustPrompt — shared controller for the project trust dialog.
 *
 * Every mount point (ChatView, OnboardingScreen) drives the same dialog from
 * one place: `openFor(cwd)` fetches the trust state and opens the dialog when
 * the project is not trusted; `grant()` persists trust and hands control back
 * through `onGranted` so the mount point can refresh its workspace state.
 *
 * Deliberately event-quiet: no auto-open on mount or on workspace/trust
 * events. An untrusted sticky default at startup badges only; the dialog opens
 * through explicit interaction (bind result, send failure, badge click).
 */
import { useCallback, useRef, useState } from 'react';
import type { ProjectTrustInfo } from '../../shared/types/ipc';

export interface TrustPromptPending {
  cwd: string;
  info: ProjectTrustInfo;
}

export interface UseTrustPromptOptions {
  /**
   * Called after trust was granted (with the granted directory). Mount points
   * use it to refresh workspace/session state.
   */
  onGranted?: (cwd: string) => void;
}

export interface UseTrustPromptReturn {
  /** Open dialog state, or null when no prompt is showing. */
  pending: TrustPromptPending | null;
  /** True while a grant round-trip is in flight. */
  busy: boolean;
  /** Resolve trust for a directory and open the dialog when not trusted. */
  openFor: (cwd: string) => void;
  /** Persist trust for the pending directory, close, then run onGranted. */
  grant: () => Promise<void>;
  /** Close without granting; the workspace stays bound-untrusted. */
  decline: () => void;
}

/**
 * Shared trust-prompt controller. Presentational mount points render
 * `TrustProjectDialog` from `pending` / `busy` and forward its callbacks.
 */
export function useTrustPrompt(options: UseTrustPromptOptions = {}): UseTrustPromptReturn {
  const [pending, setPending] = useState<TrustPromptPending | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<TrustPromptPending | null>(null);
  pendingRef.current = pending;
  /** Monotonic guard so out-of-order get() responses cannot clobber the dialog. */
  const openGenerationRef = useRef(0);
  const onGrantedRef = useRef(options.onGranted);
  onGrantedRef.current = options.onGranted;

  const openFor = useCallback((cwd: string) => {
    const trimmed = cwd.trim();
    if (!trimmed) return;
    if (!window.orchid?.projectTrust?.get) return;
    const generation = ++openGenerationRef.current;
    window.orchid.projectTrust
      .get({ cwd: trimmed })
      .then((info) => {
        // A newer request superseded this one, or trust is already granted.
        if (generation !== openGenerationRef.current) return;
        if (info.state === 'trusted') return;
        setPending({ cwd: trimmed, info });
      })
      .catch((err) => {
        console.error('Failed to resolve project trust:', err);
      });
  }, []);

  const decline = useCallback(() => {
    openGenerationRef.current += 1;
    setBusy(false);
    setPending(null);
  }, []);

  const grant = useCallback(async () => {
    const current = pendingRef.current;
    if (!current || !window.orchid?.projectTrust?.set) return;
    setBusy(true);
    try {
      await window.orchid.projectTrust.set({ cwd: current.cwd, trusted: true });
      openGenerationRef.current += 1;
      setPending(null);
      onGrantedRef.current?.(current.cwd);
    } catch (err) {
      console.error('Failed to grant project trust:', err);
    } finally {
      setBusy(false);
    }
  }, []);

  return { pending, busy, openFor, grant, decline };
}
