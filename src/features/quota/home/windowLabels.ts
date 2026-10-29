import type { TFunction } from 'i18next';
import type { QuotaLimit, QuotaAccount } from './model';

export function ledgerWindowLabel(
  provider: QuotaAccount['provider'],
  limit: QuotaLimit | null,
  kind: 'weekly' | 'session' | 'fable',
  t: TFunction
): string | undefined {
  if (!limit) return undefined;
  const hours = limit.periodHours;
  if (
    !['claude', 'codex'].includes(provider) ||
    (kind === 'weekly' && hours !== 168) ||
    !hours ||
    !Number.isFinite(hours) ||
    hours <= 0
  ) {
    return limit.label;
  }
  const period =
    hours % 24 === 0
      ? t('quota_management.home.period_days', { count: hours / 24 })
      : t('quota_management.home.period_hours', { count: hours });
  const scope =
    kind === 'fable' && limit.scopeLabel
      ? limit.scopeLabel
      : t(`quota_management.home.window_${kind}`);
  return `${period} • ${scope}`;
}
