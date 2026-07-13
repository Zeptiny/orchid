/** Informational provider status cards. Status never changes send eligibility. */
import { useEffect, useMemo, useState } from 'react';
import type {
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderStatusRefreshMessage,
  ProviderStatusView,
} from '../../../shared/types/ipc';
import { Icon } from '../Icon';

export interface ProviderStatusProps {
  readonly statuses: readonly ProviderStatusView[];
  readonly definitions?: readonly ProviderDefinitionView[];
  readonly connections?: readonly ProviderConnectionView[];
  readonly onRefresh?: (
    message: ProviderStatusRefreshMessage,
  ) => Promise<ProviderStatusView | null>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asRecordArray(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function formatNumber(value: unknown, maximumFractionDigits = 2): string {
  const number = finiteNumber(value);
  return number === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(number);
}

function formatPercent(value: unknown): string {
  const number = finiteNumber(value);
  return number === null ? 'Unavailable' : `${formatNumber(number)}%`;
}

function formatUnit(value: unknown, unit: string, maximumFractionDigits = 2): string {
  const number = finiteNumber(value);
  return number === null ? 'Unavailable' : `${formatNumber(number, maximumFractionDigits)} ${unit}`;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Unavailable';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

function availabilityLabel(status: ProviderStatusView | undefined): string {
  if (!status) return 'Unavailable';
  if (status.stale) return 'Stale';
  switch (status.availability) {
    case 'available':
      return 'Available';
    case 'unavailable':
      return 'Unavailable';
    case 'unknown':
      return 'Unknown';
  }
}

function availabilityBadge(status: ProviderStatusView | undefined): string {
  if (!status) return 'badge badge-neutral badge-soft';
  if (status.stale) return 'badge badge-warning badge-soft';
  switch (status.availability) {
    case 'available':
      return 'badge badge-success badge-soft';
    case 'unavailable':
      return 'badge badge-error badge-soft';
    case 'unknown':
      return 'badge badge-neutral badge-soft';
  }
}

/**
 * Renders trusted, timestamped status observations without suggesting whether
 * a request should be sent. Lilac supply/discount and Neuralwatt quota fields
 * are intentionally shown as unavailable when their source omits them.
 */
export function ProviderStatus({
  statuses,
  definitions = [],
  connections = [],
  onRefresh,
}: ProviderStatusProps) {
  const [refreshingProviderId, setRefreshingProviderId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const providerIds = useMemo(() => {
    const known = definitions
      .filter((definition) => definition.id === 'lilac' || definition.id === 'neuralwatt')
      .map((definition) => definition.id);
    return [...new Set([...known, ...statuses.map((status) => status.providerId)])];
  }, [definitions, statuses]);

  const refresh = async (providerId: string) => {
    if (!onRefresh) return;
    const connection =
      providerId === 'neuralwatt'
        ? (connections.find(
            (candidate) => candidate.providerId === providerId && candidate.health === 'ready',
          ) ?? connections.find((candidate) => candidate.providerId === providerId))
        : undefined;
    if (providerId === 'neuralwatt' && !connection) {
      setError('Connect Neuralwatt before refreshing account quota and accounting status.');
      return;
    }
    setRefreshingProviderId(providerId);
    setError(null);
    try {
      await onRefresh({
        providerId,
        ...(connection ? { connectionId: connection.id } : {}),
      });
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Status refresh could not be completed.',
      );
    } finally {
      setRefreshingProviderId(null);
    }
  };

  // Account quota is informational and independent from inference. While the
  // status view is open, refresh at the documented 60s UI cadence; the main
  // status service still coalesces calls and enforces its 30s manual minimum.
  useEffect(() => {
    if (!onRefresh) return;
    const connection = connections.find(
      (candidate) => candidate.providerId === 'neuralwatt' && candidate.health === 'ready',
    );
    if (!connection) return;
    const refreshQuota = () => {
      void onRefresh({ providerId: 'neuralwatt', connectionId: connection.id }).catch(() => undefined);
    };
    refreshQuota();
    const timer = window.setInterval(refreshQuota, 60_000);
    return () => window.clearInterval(timer);
  }, [connections, onRefresh]);

  if (providerIds.length === 0) {
    return (
      <div role="status" className="alert alert-info">
        <Icon name="activity" size={16} />
        <span>No provider status observations are available yet.</span>
      </div>
    );
  }

  return (
    <section aria-labelledby="provider-status-title" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="provider-status-title" className="text-lg font-semibold">
            Provider status
          </h2>
          <p className="text-sm text-base-content/70">
            Informational only — status and pricing observations never enable, disable, delay, or
            reroute a request.
          </p>
        </div>
      </div>
      {error && (
        <div role="alert" aria-live="assertive" className="alert alert-warning">
          <Icon name="alert" size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {providerIds.map((providerId) => {
          const status = statuses.find((candidate) => candidate.providerId === providerId);
          const definition = definitions.find((candidate) => candidate.id === providerId);
          const requiresConnection = providerId === 'neuralwatt';
          const hasConnection = connections.some(
            (connection) => connection.providerId === providerId,
          );
          const refreshing = refreshingProviderId === providerId;
          return (
            <article key={providerId} className="card card-border bg-base-100 shadow-sm">
              <div className="card-body gap-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="card-title text-base">
                      {definition?.displayName ?? providerId}
                    </h3>
                    <p className="text-sm text-base-content/70">
                      Last observed: {formatTimestamp(status?.observedAt)}
                    </p>
                  </div>
                  <span className={availabilityBadge(status)}>{availabilityLabel(status)}</span>
                </div>

                {status?.providerUpdatedAt && (
                  <p className="text-sm text-base-content/70">
                    Provider updated: {formatTimestamp(status.providerUpdatedAt)}
                  </p>
                )}
                {status?.error && (
                  <div role="alert" className="alert alert-warning">
                    <Icon name="alert" size={16} />
                    <span>{status.error.message}</span>
                  </div>
                )}

                {providerId === 'lilac' && <LilacStatusDetails status={status} />}
                {providerId === 'neuralwatt' && <NeuralwattStatusDetails status={status} />}
                {providerId !== 'lilac' && providerId !== 'neuralwatt' && !status && (
                  <p className="text-sm text-base-content/70">
                    No timestamped observation has been received.
                  </p>
                )}

                <div className="card-actions justify-end">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void refresh(providerId)}
                    disabled={!onRefresh || refreshing || (requiresConnection && !hasConnection)}
                    aria-label={`Refresh ${definition?.displayName ?? providerId} status`}
                  >
                    <Icon name="refresh" size={14} className={refreshing ? 'animate-spin' : ''} />
                    {refreshing ? 'Refreshing…' : 'Refresh status'}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LilacStatusDetails({ status }: { readonly status: ProviderStatusView | undefined }) {
  const data = status ? asRecord(status.data) : null;
  const models = asRecordArray(data?.['models']);
  const supplyUpdatedAt = text(data?.['subscriptionSupplyUpdatedAt']);

  if (models.length === 0) {
    return (
      <div role="status" className="alert alert-info">
        <Icon name="activity" size={16} />
        <span>Lilac performance and supply data are unavailable from the current observation.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {supplyUpdatedAt && (
        <p className="text-sm text-base-content/70">
          Supply source updated: {formatTimestamp(supplyUpdatedAt)}
        </p>
      )}
      {models.map((model, index) => {
        const subscription = asRecord(model['subscription']);
        const modelId = text(model['modelId']) ?? text(model['name']) ?? `Model ${index + 1}`;
        const supplyState = text(subscription?.['supplyState']);
        const subscriptionAvailable = subscription?.['availability'] === 'available';
        return (
          <div key={`${modelId}-${index}`} className="rounded-box border border-base-300 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium break-all">{modelId}</span>
              <span
                className={
                  subscriptionAvailable
                    ? 'badge badge-success badge-soft'
                    : 'badge badge-neutral badge-soft'
                }
              >
                {subscriptionAvailable ? 'Supply data available' : 'Supply data unavailable'}
              </span>
            </div>
            <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <StatusField
                label="Throughput"
                value={formatUnit(model['tokensPerSecond'], 'tokens/s')}
              />
              <StatusField
                label="Time to first token"
                value={formatUnit(model['timeToFirstTokenSeconds'], 's')}
              />
              <StatusField label="Uptime" value={formatPercent(model['uptimePercent'])} />
              <StatusField label="Supply" value={supplyState ?? 'Unavailable'} />
              <StatusField
                label="Subscription discount"
                value={
                  finiteNumber(subscription?.['discountPercent']) === null
                    ? 'Unavailable'
                    : formatPercent(subscription?.['discountPercent'])
                }
              />
              <StatusField
                label="Credit multiplier"
                value={formatNumber(subscription?.['creditMultiplier'])}
              />
            </dl>
          </div>
        );
      })}
    </div>
  );
}

function NeuralwattStatusDetails({ status }: { readonly status: ProviderStatusView | undefined }) {
  const data = status ? asRecord(status.data) : null;
  const currentMonth = asRecord(data?.['currentMonth']);
  const subscription = asRecord(data?.['subscription']);
  if (!data) {
    return (
      <div role="status" className="alert alert-info">
        <Icon name="activity" size={16} />
        <span>
          Neuralwatt quota and accounting data are unavailable from the current observation.
        </span>
      </div>
    );
  }

  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
      <StatusField
        label="Accounting method"
        value={text(data['accountingMethod']) ?? 'Unavailable'}
      />
      <StatusField label="Rate-limit tier" value={text(data['rateLimitTier']) ?? 'Unavailable'} />
      <StatusField label="Credits remaining" value={currency(data['creditsRemainingUsd'])} />
      <StatusField label="Credits used" value={currency(data['creditsUsedUsd'])} />
      <StatusField label="Monthly requests" value={formatNumber(currentMonth?.['requests'], 0)} />
      <StatusField label="Monthly tokens" value={formatNumber(currentMonth?.['tokens'], 0)} />
      <StatusField
        label="Monthly energy"
        value={formatUnit(currentMonth?.['energyKwh'], 'kWh', 4)}
      />
      <StatusField label="Monthly cost" value={currency(currentMonth?.['costUsd'])} />
      <StatusField
        label="Subscription plan"
        value={text(subscription?.['plan']) ?? 'Unavailable'}
      />
      <StatusField
        label="Subscription status"
        value={text(subscription?.['status']) ?? 'Unavailable'}
      />
      <StatusField
        label="Included energy"
        value={formatUnit(subscription?.['kwhIncluded'], 'kWh', 4)}
      />
      <StatusField
        label="Energy remaining"
        value={formatUnit(subscription?.['kwhRemaining'], 'kWh', 4)}
      />
    </dl>
  );
}

function StatusField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="font-medium text-base-content/70">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function currency(value: unknown): string {
  const number = finiteNumber(value);
  return number === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(number);
}
