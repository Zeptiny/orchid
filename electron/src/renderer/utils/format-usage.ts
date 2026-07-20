import type { Usage } from '../../shared/types/message';

export function formatTokenCount(value: number | undefined): string {
  if (!value) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatUsageSummary(usage: Usage | null | undefined): string {
  return `in ${formatTokenCount(usage?.prompt_tokens)} cached ${formatTokenCount(usage?.cached_tokens)} out ${formatTokenCount(usage?.completion_tokens)}`;
}
