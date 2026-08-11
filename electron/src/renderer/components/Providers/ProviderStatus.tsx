/** Informational provider status cards. Status never changes send eligibility. */
import { useEffect, useState } from 'react';
import type {
  ProviderConnectionIdMessage,
  ProviderConnectionView,
  ProviderDefinitionView,
  ProviderStatusRefreshMessage,
  ProviderStatusView,
} from '../../../shared/types/ipc';
import type { ProviderQuota } from '../../../shared/types/provider-facets';
import { Icon } from '../Icon';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StatusBadge } from '../ui/StatusBadge';

export interface ProviderStatusProps {
  readonly connection: ProviderConnectionView;
  readonly definition?: ProviderDefinitionView;
  readonly status?: ProviderStatusView;
  readonly onRefresh?: (
    message: ProviderStatusRefreshMessage,
  ) => Promise<ProviderStatusView | null>;
  readonly onRefreshQuota?: (
    message: ProviderConnectionIdMessage,
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

function availabilityTone(
  status: ProviderStatusView | undefined,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (!status) return 'neutral';
  if (status.stale) return 'warning';
  switch (status.availability) {
    case 'available':
      return 'success';
    case 'unavailable':
      return 'error';
    case 'unknown':
      return 'neutral';
  }
}

/**
 * Renders trusted, timestamped status observations without suggesting whether
 * a request should be sent. Lilac supply/discount and Neuralwatt quota fields
 * are intentionally shown as unavailable when their source omits them.
 */
export function ProviderStatus({
  connection,
  definition,
  status,
  onRefresh,
  onRefreshQuota,
}: ProviderStatusProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { providerId } = connection;
  const supportsKnownStatus = providerId === 'lilac' || providerId === 'neuralwatt';
  // A typed quota hook (R24) makes the typed surface authoritative for this card.
  const supportsQuota = definition?.supportsQuota === true;

  const refresh = async () => {
    if (!onRefresh) return;
    if (providerId === 'neuralwatt' && connection.health !== 'ready') {
      setError('Reconnect Neuralwatt before refreshing account quota and accounting status.');
      return;
    }
    setRefreshing(true);
    setError(null);
    try {
      await onRefresh({
        providerId,
        connectionId: connection.id,
      });
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : 'Status refresh could not be completed.',
      );
    } finally {
      setRefreshing(false);
    }
  };

  // Account quota is informational and independent from inference. While the
  // status view is open, refresh at the documented 60s UI cadence; the main
  // status service still coalesces calls and enforces its 30s manual minimum.
  useEffect(() => {
    if (providerId !== 'neuralwatt' || connection.health !== 'ready') return;
    const tick = () => {
      const request = supportsQuota && onRefreshQuota
        ? onRefreshQuota({ connectionId: connection.id })
        : onRefresh
          ? onRefresh({ providerId, connectionId: connection.id })
          : Promise.resolve(null);
      void request.catch(() => undefined);
    };
    if (!supportsQuota && !onRefresh) return;
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [connection.health, connection.id, onRefresh, onRefreshQuota, providerId, supportsQuota]);

  if (!supportsKnownStatus && !status) return null;

  const statusTitleId = `provider-status-${connection.id}`;

  return (
    <Panel
      as="section"
      tone="muted"
      aria-labelledby={statusTitleId}
      className="flex flex-col gap-3"
    >
      <SectionHeader
        title={<h4 id={statusTitleId} className="text-sm font-semibold">Provider status</h4>}
        description={`Informational only · Last observed: ${formatTimestamp(status?.observedAt)}`}
        actions={
          <StatusBadge tone={availabilityTone(status)} size="sm">
            {availabilityLabel(status)}
          </StatusBadge>
        }
      />

      {error && (
        <Alert tone="warning" icon="alert" aria-live="assertive">{error}</Alert>
      )}

      <div className="flex flex-col gap-3">
        {status?.providerUpdatedAt && (
          <p className="config-card-desc text-sm text-base-content/70">
            Provider updated: {formatTimestamp(status.providerUpdatedAt)}
          </p>
        )}
        {status?.error && (
          <Alert tone="warning" icon="alert">{status.error.message}</Alert>
        )}

        {providerId === 'lilac' && <LilacStatusDetails status={status} />}
        {providerId === 'neuralwatt' && <NeuralwattStatusDetails status={status} />}
        {!supportsKnownStatus && status && Object.keys(status.data).length === 0 && (
          <p className="text-sm text-base-content/70">
            No provider-specific status details were supplied.
          </p>
        )}

        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void refresh()}
            disabled={!onRefresh || refreshing || (providerId === 'neuralwatt' && connection.health !== 'ready')}
            aria-label={`Refresh ${definition?.displayName ?? providerId} status for ${connection.name}`}
          >
            <Icon name="refresh" size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Refreshing…' : 'Refresh status'}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function LilacStatusDetails({ status }: { readonly status: ProviderStatusView | undefined }) {
  const data = status ? asRecord(status.data) : null;
  const models = asRecordArray(data?.['models']);
  const supplyUpdatedAt = text(data?.['subscriptionSupplyUpdatedAt']);

  if (models.length === 0) {
    return (
      <Alert tone="info" role="status" icon="activity">
        Lilac performance and supply data are unavailable from the current observation.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {status?.quota && <TypedQuotaSection quota={status.quota} />}
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
              <StatusBadge tone={subscriptionAvailable ? 'success' : 'neutral'} size="sm">
                {subscriptionAvailable ? 'Supply data available' : 'Supply data unavailable'}
              </StatusBadge>
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
      <Alert tone="info" role="status" icon="activity">
        Neuralwatt quota and accounting data are unavailable from the current observation.
      </Alert>
    );
  }

  return (
    <div className="space-y-3">
      {status?.quota && <TypedQuotaSection quota={status.quota} />}
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
    </div>
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

function allowanceBadgeTone(state: string): 'success' | 'warning' | 'error' | 'neutral' {
  switch (state) {
    case 'available': return 'success';
    case 'limited': return 'warning';
    case 'blocked': return 'error';
    default: return 'neutral';
  }
}

/**
 * Typed quota/subscription/allowance surface (R24). Values render in
 * provider-native units and are informational only: a blocked allowance is
 * shown as data, never as a reason a send is prevented (R25/AE6).
 */
function TypedQuotaSection({ quota }: { readonly quota: ProviderQuota }) {
  return (
    <div className="rounded-box border border-base-300 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        Quota &amp; subscription
      </div>
      {quota.balances.length > 0 && (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {quota.balances.map((balance) => (
            <StatusField
              key={balance.label}
              label={balance.label}
              value={formatUnit(balance.amount, balance.unit, 4)}
            />
          ))}
        </dl>
      )}
      {quota.subscription && (
        <div className="mt-2 flex items-center gap-2 text-sm">
          <StatusBadge
            tone={quota.subscription.state === 'active' || quota.subscription.state === 'trialing'
              ? 'success'
              : quota.subscription.state === 'past-due'
                ? 'warning'
                : quota.subscription.state === 'cancelled' || quota.subscription.state === 'expired'
                  ? 'error'
                  : 'neutral'}
            size="sm"
          >
            {quota.subscription.state}
          </StatusBadge>
          <span className="text-base-content/70">
            {quota.subscription.displayName ?? 'Subscription'}
            {quota.subscription.renewsAt ? ` · renews ${formatTimestamp(quota.subscription.renewsAt)}` : ''}
          </span>
        </div>
      )}
      {quota.allowances.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {quota.allowances.map((allowance) => (
            <StatusBadge
              key={allowance.label}
              tone={allowanceBadgeTone(allowance.state)}
              size="sm"
            >
              {allowance.label}: {allowance.state}
            </StatusBadge>
          ))}
        </div>
      )}
    </div>
  );
}

function currency(value: unknown): string {
  const number = finiteNumber(value);
  return number === null
    ? 'Unavailable'
    : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(number);
}
