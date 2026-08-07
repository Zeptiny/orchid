/**
 * useTrustPrompt — shared controller for the project trust dialog.
 *
 * Every mount point (ChatView, OnboardingScreen) drives the same dialog from
 * one place: `openFor(cwd)` fetches the trust state and opens the dialog when
 * the project is not trusted; `grant()` persists trust and hands control back
 * through `onGranted` so the mount point can refresh its workspace state.
 *
 * Failures are never swallowed silently: the hook exposes a short `error`
 * message. While the dialog is open (grant failure) the dialog renders it;
 * when no dialog is open (lookup failure) the caller surfaces `error` and
 * clears it via `clearError()` once read.
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
  /** Short user-facing message for the latest trust failure; null when none. */
  error: string | null;
  /** Resolve trust for a directory and open the dialog when not trusted. */
  openFor: (cwd: string) => void;
  /** Persist trust for the pending directory, close, then run onGranted. */
  grant: () => Promise<void>;
  /** Close without granting; the workspace stays bound-untrusted. */
  decline: () => void;
  /** Clear a surfaced error after the caller has consumed it. */
  clearError: () => void;
}

/** Shown when persisting a trust grant fails (dialog stays open for retry). */
const GRANT_ERROR_MESSAGE = 'Trusting this project failed. Try again.';
/** Shown when the trust lookup itself fails (no dialog; caller surfaces it). */
const LOOKUP_ERROR_MESSAGE = "Could not check this project's trust state. Try again.";

/**
 * Shared trust-prompt controller. Presentational mount points render
 * `TrustProjectDialog` from `pending` / `busy` / `error` and forward its
 * callbacks.
 */
export function useTrustPrompt(options: UseTrustPromptOptions = {}): UseTrustPromptReturn {
  const [pending, setPending] = useState<TrustPromptPending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<TrustPromptPending | null>(null);
  pendingRef.current = pending;
  /** Monotonic guard so out-of-order get() responses cannot clobber the dialog. */
  const openGenerationRef = useRef(0);
  const onGrantedRef = useRef(options.onGranted);
  onGrantedRef.current = options.onGranted;

  const openFor = useCallback((cwd: string) => {
    setError(null);
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
        // A newer request superseded this one; its outcome owns the surface.
        if (generation !== openGenerationRef.current) return;
        setError(LOOKUP_ERROR_MESSAGE);
      });
  }, []);

  const decline = useCallback(() => {
    openGenerationRef.current += 1;
    setBusy(false);
    setPending(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const grant = useCallback(async () => {
    setError(null);
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
      // Keep the dialog open so the user sees the failure and can retry.
      setError(GRANT_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }, []);

  return { pending, busy, error, openFor, grant, decline, clearError };
}
