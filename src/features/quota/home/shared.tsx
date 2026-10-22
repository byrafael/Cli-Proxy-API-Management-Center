/**
 * 额度首页共享积木：图标、水位条、时间文字、状态点、套餐徽标。
 * Ledger 与 Runway 共用，保证两张图里同一个账号的颜色与措辞一致。
 */

import type { CSSProperties } from 'react';
import type { ResolvedTheme } from '@/types';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import type { QuotaProviderType } from '../providers/types';
import {
  PROVIDER_LABEL,
  accountStatus,
  clampPct,
  timeTone,
  toneFor,
  type AccountStatus,
  type GroupBy,
  type QuotaAccount,
  type QuotaLimit,
  type Tone,
  type TimeKind,
} from './model';
import { toneClassFor } from './tone';
import { useQuotaFormat } from './useQuotaFormat';
import styles from './shared.module.scss';

export interface QuotaViewProps {
  accounts: QuotaAccount[];
  now: number;
  redact: boolean;
  theme: ResolvedTheme;
  groupBy: GroupBy;
}

/* ---------- 提供商图标 ---------- */

export function ProviderMark({
  provider,
  theme,
  size = 36,
}: {
  provider: QuotaProviderType;
  theme: ResolvedTheme;
  size?: number;
}) {
  const src = getAuthFileIcon(provider, theme);
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.3),
    background: isThemeSurfaceIconProvider(provider)
      ? getThemeSurfaceIconBackground(theme)
      : undefined,
  };
  return (
    <span className={styles.mark} style={style} title={PROVIDER_LABEL[provider]}>
      {src ? (
        <img src={src} alt="" width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} />
      ) : (
        <span className={styles.markFallback}>{PROVIDER_LABEL[provider][0]}</span>
      )}
    </span>
  );
}

/* ---------- 水位条 ---------- */

export function LimitBar({
  limit,
  label,
  now,
  showReset = false,
  width,
  fullWidth = false,
  emptyLabel = '—',
}: {
  limit: QuotaLimit | null;
  label?: string;
  now: number;
  showReset?: boolean;
  width?: number | string;
  fullWidth?: boolean;
  emptyLabel?: string;
}) {
  const format = useQuotaFormat();
  if (limit === null) {
    return (
      <span className={`${styles.limit} ${fullWidth ? styles.limitWide : ''}`} style={{ width }}>
        <span className={styles.empty}>{emptyLabel}</span>
      </span>
    );
  }
  const pct = clampPct(limit.remainingPct);
  const tone = toneFor(pct);
  const displayLabel = label ?? limit.label;
  return (
    <span
      className={`${styles.limit} ${fullWidth ? styles.limitWide : ''} ${toneClassFor(tone)}`}
      style={{ width }}
    >
      <span className={styles.limitHeading}>
        {displayLabel && <span className={styles.limitLabel}>{displayLabel}</span>}
        <span className={styles.limitPct}>{pct}%</span>
      </span>
      <span className={styles.track} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${pct}%` }} />
      </span>
      {showReset && (
        <span className={styles.limitReset}>
          {format.t('quota_management.home.resets_in', {
            time: format.countdown(limit.resetsAt - now),
          })}
          {' · '}
          {format.absolute(limit.resetsAt)}
        </span>
      )}
    </span>
  );
}

/* ---------- 时间文字 ---------- */

export function TimeText({ ts, now, kind }: { ts: number | null; now: number; kind: TimeKind }) {
  const format = useQuotaFormat();
  if (ts === null) {
    return (
      <span className={styles.empty} title={format.t('quota_management.home.not_provided')}>
        —
      </span>
    );
  }
  const delta = ts - now;
  const tone = timeTone(kind, delta);
  const primary =
    kind === 'window'
      ? format.countdown(delta)
      : delta <= 0
        ? format.t('quota_management.home.expired_ago', { time: format.countdown(-delta) })
        : format.relative(ts, now);
  return (
    <span
      className={`${styles.time} ${styles.timeStacked} ${toneClassFor(tone)}`}
      title={format.absolute(ts)}
    >
      <span className={styles.timePrimary}>{primary}</span>
      <span className={styles.timeSecondary}>{format.absolute(ts)}</span>
    </span>
  );
}

/** token 到期未知时，退而展示最近一次刷新——它至少说明凭证还在被续期。 */
export function RefreshedText({ ts, now }: { ts: number; now: number }) {
  const format = useQuotaFormat();
  return (
    <span className={`${styles.time} ${styles.timeStacked}`} title={format.absolute(ts)}>
      <span className={styles.timePrimary}>
        {format.t('quota_management.home.refreshed', {
          time: format.countdown(Math.max(0, now - ts)),
        })}
      </span>
      <span className={styles.timeSecondary}>
        {format.t('quota_management.home.expiry_not_reported')}
      </span>
    </span>
  );
}

/* ---------- 状态 / 套餐 ---------- */

const statusTone: Record<AccountStatus, Tone> = {
  ready: 'high',
  limited: 'low',
  expiring: 'medium',
  error: 'low',
  disabled: 'none',
  pending: 'none',
};

export function StatusDot({ account, now }: { account: QuotaAccount; now: number }) {
  const format = useQuotaFormat();
  const status = accountStatus(account, now);
  const label = format.statusLabel(status);
  return (
    <span
      className={`${styles.dot} ${toneClassFor(statusTone[status])}`}
      title={label}
      role="img"
      aria-label={label}
    />
  );
}

export function PlanChip({ plan }: { plan: string | null }) {
  if (!plan) return <span className={styles.empty}>—</span>;
  return (
    <span className={styles.plan} title={plan}>
      {plan}
    </span>
  );
}
