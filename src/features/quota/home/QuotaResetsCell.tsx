/**
 * 手动重置列：这个账号还存着几次重置、最近一次什么时候过期，并能直接使用。
 *
 * Codex 的重置积分已经在额度状态里；Claude 的重置授权（grants）要单独读取，
 * 复用旧卡片的 useClaudeResetGrants（含二次确认、重试窗口等保护），不重新实现。
 */

import { useMemo } from 'react';
import { IconRefreshCw } from '@/components/ui/icons';
import { parseIsoToMs } from '@/utils/quota';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { DAY, type Tone } from './model';
import { toneClassFor } from './tone';
import { useQuotaFormat } from './useQuotaFormat';
import styles from './QuotaResetsCell.module.scss';

const NS = 'quota_management.home';

/** 重置快过期才升温：存着不用就白白浪费了。 */
const expiryTone = (deltaMs: number): Tone => {
  if (deltaMs <= DAY) return 'low';
  return deltaMs <= 3 * DAY ? 'medium' : 'none';
};

interface ResetItem {
  label: string;
  left: number;
  total: number | null;
  expiresAt: number | null;
}

export interface QuotaResetsCellProps {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  now: number;
  /** 连接正常且列表已落定。 */
  canAct: boolean;
  /** Codex：当前凭证正在重置。 */
  resetting: boolean;
  onRefresh: () => void;
  /** Codex：走页面已有的确认弹窗与重置流程。 */
  onUseCodex: () => void;
}

export function QuotaResetsCell({
  entry,
  quota,
  now,
  canAct,
  resetting,
  onRefresh,
  onUseCodex,
}: QuotaResetsCellProps) {
  const format = useQuotaFormat();
  const { t } = format;
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const loaded = status === 'success';

  // Hook 必须无条件调用；非 Claude 账号传 enabled=false，不会发任何请求。
  const claude = useClaudeResetGrants(
    entry.file,
    entry.type === 'claude' && status !== 'idle',
    !canAct || loading || resetting,
    quota,
    onRefresh
  );

  const items = useMemo<ResetItem[]>(() => {
    if (entry.type === 'codex' && loaded) {
      const credits = (quota as { rateLimitResetCredits?: { id: string; expiresAt: string }[] })
        .rateLimitResetCredits;
      return (credits ?? []).map((credit, index) => ({
        label: t('codex_quota.reset_credit_number', { index: index + 1 }),
        left: 1,
        total: null,
        expiresAt: parseIsoToMs(credit.expiresAt),
      }));
    }
    if (entry.type === 'claude' && loaded) {
      return claude.grants
        .filter((grant) => grant.resetsLeft > 0)
        .map((grant, index) => ({
          label: grant.label || t('claude_reset.grant_number', { index: index + 1 }),
          left: grant.resetsLeft,
          total: grant.resetsTotal,
          expiresAt: parseIsoToMs(grant.endsAt),
        }));
    }
    return [];
  }, [claude.grants, entry.type, loaded, quota, t]);

  const supported = entry.type === 'claude' || entry.type === 'codex';
  const refreshAction = (
    <button
      type="button"
      className={styles.refresh}
      disabled={!canAct || loading || resetting || entry.file.disabled === true}
      onClick={onRefresh}
      aria-label={t('auth_files.quota_refresh_single')}
      title={t('auth_files.quota_refresh_hint')}
    >
      <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />
    </button>
  );
  if (!loaded) {
    return (
      <div className={styles.cell}>
        <div className={styles.top}>
          <span className={styles.empty}>{loading ? '…' : '—'}</span>
          {refreshAction}
        </div>
      </div>
    );
  }

  // Codex 的数量优先取后端汇总（明细读取失败时仍有数字）。
  const codexCount =
    entry.type === 'codex'
      ? ((quota as { rateLimitResetCreditsAvailableCount?: number | null })
          .rateLimitResetCreditsAvailableCount ?? items.length)
      : null;
  const claudeLoaded = entry.type === 'claude' && claude.count !== null;
  const count = entry.type === 'codex' ? (codexCount ?? 0) : (claude.count ?? null);

  if (!supported) {
    return (
      <div className={styles.cell}>
        <div className={styles.top}>
          <span className={styles.empty}>—</span>
          {refreshAction}
        </div>
      </div>
    );
  }

  if (entry.type === 'claude' && !claudeLoaded && !claude.message) {
    return (
      <div className={styles.cell}>
        <div className={styles.top}>
          <span className={styles.empty}>…</span>
          {refreshAction}
        </div>
      </div>
    );
  }
  if (count === null) {
    return (
      <div className={styles.cell}>
        <div className={styles.top}>
          <span className={styles.message} role="status">
            {claude.message ? t(`claude_reset.${claude.message}`) : '—'}
          </span>
          {refreshAction}
        </div>
      </div>
    );
  }

  const upcoming = items
    .map((item) => item.expiresAt)
    .filter((value): value is number => value !== null && value > now);
  const nextExpiry = upcoming.length > 0 ? Math.min(...upcoming) : null;
  const detail = items
    .map((item) =>
      item.expiresAt === null
        ? item.label
        : t(`${NS}.resets_detail_item`, {
            label: item.label,
            date: format.absolute(item.expiresAt),
          })
    )
    .join('\n');
  const tone = count > 0 && nextExpiry !== null ? expiryTone(nextExpiry - now) : 'none';

  const canUse =
    entry.file.disabled !== true &&
    (entry.type === 'codex' ? canAct && !resetting : !claude.blocked);
  const showButton =
    entry.type === 'codex' ? count > 0 : count > 0 || claude.buttonLabel === 'retry';
  const retrying = entry.type === 'claude' && claude.buttonLabel === 'retry';
  const busy = entry.type === 'claude' ? claude.busy : resetting;

  return (
    <div className={styles.cell}>
      <div className={styles.top}>
        <span
          className={`${styles.count} ${count === 0 ? styles.none : ''} ${tone === 'none' ? '' : styles.warm} ${toneClassFor(tone)}`}
          title={detail || undefined}
        >
          {count === 0 ? t(`${NS}.resets_none`) : t(`${NS}.resets_count`, { count })}
        </span>
        {showButton && (
          <button
            type="button"
            className={styles.use}
            disabled={!canUse}
            onClick={entry.type === 'claude' ? claude.confirm : onUseCodex}
            title={
              entry.type === 'claude'
                ? claude.blocked && !claude.busy
                  ? t(`${NS}.resets_when_limited`)
                  : t(`claude_reset.${claude.buttonLabel}`)
                : t('codex_quota.reset_button')
            }
            aria-busy={busy}
          >
            {busy ? '…' : t(`${NS}.${retrying ? 'resets_retry' : 'resets_use'}`)}
          </button>
        )}
        {refreshAction}
      </div>
      {nextExpiry !== null && count > 0 && (
        <span className={styles.sub} title={format.absolute(nextExpiry)}>
          {t(`${NS}.resets_next`, { time: format.countdown(nextExpiry - now) })}
        </span>
      )}
      {claude.message && (
        <span className={styles.message} role="status">
          {t(`claude_reset.${claude.message}`)}
        </span>
      )}
    </div>
  );
}
