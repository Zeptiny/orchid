/**
 * TrustedProjectsTab — review and revoke per-project trust decisions.
 *
 * Self-contained like ProvidersTab: owns its own data loading through
 * window.orchid.projectTrust and never touches the config-draft flow. The list
 * refreshes on mount and whenever main broadcasts project:trust_changed.
 * Reviewing a row opens the U6 trust dialog in read-only "surface" mode.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ProjectTrustInfo, TrustedProjectEntry } from '../../../shared/types/ipc';
import type { Notify } from '../../utils/notify';
import { TrustProjectDialog } from '../TrustProjectDialog';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';

function formatTrustedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function TrustedProjectsTab({ onNotify }: { readonly onNotify: Notify }) {
  const [entries, setEntries] = useState<TrustedProjectEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokingDir, setRevokingDir] = useState<string | null>(null);
  const [reviewingDir, setReviewingDir] = useState<string | null>(null);
  const [review, setReview] = useState<ProjectTrustInfo | null>(null);

  const load = useCallback(async () => {
    if (!window.orchid?.projectTrust?.list) {
      setError('Project trust is not available in this build.');
      return;
    }
    try {
      const list = await window.orchid.projectTrust.list();
      setEntries(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trusted projects.');
    }
  }, []);

  useEffect(() => {
    void load();
    // Refresh live when any trust decision or fingerprint change broadcasts.
    const unsubscribe = window.orchid?.projectTrust?.onChanged?.(() => {
      void load();
    });
    return () => {
      unsubscribe?.();
    };
  }, [load]);

  const handleRevoke = useCallback(
    async (entry: TrustedProjectEntry) => {
      if (!window.orchid?.projectTrust?.set) return;
      setRevokingDir(entry.projectDir);
      try {
        await window.orchid.projectTrust.set({ cwd: entry.projectDir, trusted: false });
        await load();
        onNotify(`Trust revoked for ${entry.projectDir}.`, 'info');
      } catch (err) {
        onNotify(
          err instanceof Error ? err.message : 'Failed to revoke project trust.',
          'error',
        );
      } finally {
        setRevokingDir(null);
      }
    },
    [load, onNotify],
  );

  const handleReview = useCallback(
    async (entry: TrustedProjectEntry) => {
      if (!window.orchid?.projectTrust?.get) return;
      setReviewingDir(entry.projectDir);
      try {
        const info = await window.orchid.projectTrust.get({ cwd: entry.projectDir });
        setReview(info);
      } catch (err) {
        onNotify(
          err instanceof Error ? err.message : 'Failed to load the project trust report.',
          'error',
        );
      } finally {
        setReviewingDir(null);
      }
    },
    [onNotify],
  );

  return (
    <div className="config-form flex flex-col gap-4">
      {error && entries != null && (
        <Alert tone="error" icon="alert" action={
          <Button variant="ghost" size="sm" type="button" onClick={() => setError(null)}>Dismiss</Button>
        }>
          {error}
        </Alert>
      )}

      <Panel
        as="section"
        aria-labelledby="trusted-projects-title"
        className="config-fieldset flex flex-col gap-3"
      >
        <SectionHeader
          title={<h2 id="trusted-projects-title" className="text-sm font-semibold">Trusted projects</h2>}
          description="Projects you have trusted to run project-supplied configuration. Revoke trust to require approval again."
        />

        {entries == null ? (
          <StateMessage
            kind={error ? 'warning' : 'loading'}
            title={error ?? 'Loading trusted projects…'}
          />
        ) : entries.length === 0 ? (
          <StateMessage kind="info" icon="shield" title="No trusted projects yet" className="py-4">
            When you open a project with project-supplied configuration and trust it, it appears
            here so you can review or revoke that trust.
          </StateMessage>
        ) : (
          <ul className="m-0 flex flex-col gap-2 p-0">
            {entries.map((entry) => (
              <li
                key={entry.projectDir}
                className="flex min-w-0 items-center gap-3 rounded-md border border-base-300 bg-base-100/60 px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="mono truncate text-sm font-medium" title={entry.projectDir}>
                      {entry.projectDir}
                    </span>
                    {entry.state === 'changed' && (
                      <StatusBadge tone="warning" size="xs" className="shrink-0">
                        Changed since trusted
                      </StatusBadge>
                    )}
                  </div>
                  <span className="text-xs text-base-content/60">
                    Trusted {formatTrustedAt(entry.trustedAt)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => void handleReview(entry)}
                    disabled={revokingDir === entry.projectDir || reviewingDir === entry.projectDir}
                    loading={reviewingDir === entry.projectDir}
                  >
                    Review
                  </Button>
                  <Button
                    variant="error"
                    size="sm"
                    type="button"
                    onClick={() => void handleRevoke(entry)}
                    disabled={revokingDir === entry.projectDir || reviewingDir === entry.projectDir}
                    loading={revokingDir === entry.projectDir}
                  >
                    Revoke
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <TrustProjectDialog
        open={review != null}
        cwd={review?.projectDir ?? ''}
        trustState={review?.state ?? 'trusted'}
        report={review?.report ?? null}
        busy={false}
        onGrant={() => setReview(null)}
        onDecline={() => setReview(null)}
        readOnly
      />
    </div>
  );
}
