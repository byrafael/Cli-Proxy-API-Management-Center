/**
 * 手动重置列：这个账号还存着哪几类重置（整个账号 / 单个模型）、各自多少次、
 * 最近一次什么时候过期，并能按类型直接使用。
 *
 * Codex 的重置积分已经在额度状态里；Claude 的重置授权（grants）要单独读取，
 * 复用旧卡片的 useClaudeResetGrants（含二次确认、重试窗口等保护），不重新实现。
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconRefreshCw, IconTimer, IconZap } from '@/components/ui/icons';
import type { AnthropicResetGrantKind } from '@/services/api/claudeResetGrants';
import { parseIsoToMs } from '@/utils/quota';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import { DAY, type Tone } from './model';
import { toneClassFor } from './tone';
import { useQuotaFormat } from './useQuotaFormat';
import styles from './QuotaResetsCell.module.scss';

const NS = 'quota_management.home';
const HOUR = 3_600_000;
const KIND_ORDER: readonly AnthropicResetGrantKind[] = ['account', 'model'];

/** 重置快过期才升温：存着不用就白白浪费了。 */
const expiryTone = (deltaMs: number): Tone => {
  if (deltaMs <= DAY) return 'low';
  return deltaMs <= 3 * DAY ? 'medium' : 'none';
};

interface ResetItem {
  kind: AnthropicResetGrantKind;
  label: string;
  model: string | null;
  left: number;
  expiresAt: number | null;
}

interface ResetGroup {
  kind: AnthropicResetGrantKind;
  count: number;
  nextExpiry: number | null;
  items: ResetItem[];
}

/** Resets of one type that run out at the same minute. */
interface ExpiryBucket {
  expiresAt: number | null;
  count: number;
}

/** Same-minute expiries are one date to a reader; undated resets sort last. */
const expiryBuckets = (items: ResetItem[]): ExpiryBucket[] => {
  const buckets = new Map<number | null, number>();
  for (const item of items) {
    const key = item.expiresAt === null ? null : Math.floor(item.expiresAt / 60_000) * 60_000;
    buckets.set(key, (buckets.get(key) ?? 0) + item.left);
  }
  return [...buckets]
    .map(([expiresAt, count]) => ({ expiresAt, count }))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
};

const groupByKind = (items: ResetItem[], now: number): ResetGroup[] =>
  KIND_ORDER.map((kind) => {
    const own = items.filter((item) => item.kind === kind);
    const upcoming = own
      .map((item) => item.expiresAt)
      .filter((value): value is number => value !== null && value > now);
    return {
      kind,
      count: own.reduce((sum, item) => sum + item.left, 0),
      nextExpiry: upcoming.length > 0 ? Math.min(...upcoming) : null,
      items: own,
    };
  }).filter((group) => group.count > 0);

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
  const tipId = useId();
  const [openTip, setOpenTip] = useState<{
    kind: AnthropicResetGrantKind;
    rect: DOMRect;
  } | null>(null);
  // The card is fixed to the viewport, so any scroll would detach it from its row.
  useEffect(() => {
    if (!openTip) return;
    const close = () => setOpenTip(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openTip]);
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
      // A Codex credit clears the account's rate limits; there is no model-scoped credit.
      return (credits ?? []).map((credit, index) => ({
        kind: 'account' as const,
        label: t('codex_quota.reset_credit_number', { index: index + 1 }),
        model: null,
        left: 1,
        expiresAt: parseIsoToMs(credit.expiresAt),
      }));
    }
    if (entry.type === 'claude' && loaded) {
      return claude.grants
        .filter((grant) => grant.resetsLeft > 0)
        .map((grant, index) => ({
          kind: grant.kind,
          label: grant.label || t('claude_reset.grant_number', { index: index + 1 }),
          model: grant.model,
          left: grant.resetsLeft,
          expiresAt: parseIsoToMs(grant.endsAt),
        }));
    }
    return [];
  }, [claude.grants, entry.type, loaded, quota, t]);

  /** "118d" / "19h" / "40m": the stack row has room for one unit only. */
  const shortCountdown = (ms: number) => {
    if (ms >= DAY) return `${Math.floor(ms / DAY)}${t(`${NS}.unit_d`)}`;
    if (ms >= HOUR) return `${Math.floor(ms / HOUR)}${t(`${NS}.unit_h`)}`;
    return format.countdown(ms);
  };
  const bucketLine = (bucket: ExpiryBucket) =>
    bucket.expiresAt === null
      ? t(`${NS}.resets_tip_no_expiry`, { count: bucket.count })
      : t(`${NS}.resets_tip_line`, {
          count: bucket.count,
          date: format.absolute(bucket.expiresAt),
          time: format.countdown(bucket.expiresAt - now),
        });
  /** Hover/focus card: does every reset of this type expire together, or is the timer the earliest? */
  const tipBody = (group: ResetGroup, blockedReason: string | null) => {
    const buckets = expiryBuckets(group.items);
    const models = [...new Set(group.items.map((item) => item.model).filter(Boolean))];
    const kind = t(`${NS}.resets_kind_${group.kind}`);
    const single = buckets.length === 1 && buckets[0].expiresAt !== null;
    return (
      <>
        <span className={styles.tipTitle}>
          {t(`${NS}.resets_tip_title`, { count: group.count, kind })}
          {models.length > 0 && <span className={styles.tipModel}> · {models.join(', ')}</span>}
        </span>
        {single ? (
          <span className={styles.tipLine}>
            {t(`${NS}.resets_tip_all_same`, {
              count: group.count,
              date: format.absolute(buckets[0].expiresAt!),
              time: format.countdown(buckets[0].expiresAt! - now),
            })}
          </span>
        ) : (
          <>
            {buckets.length > 1 && (
              <span className={styles.tipNote}>{t(`${NS}.resets_tip_earliest`)}</span>
            )}
            {buckets.map((bucket, index) => (
              <span
                key={bucket.expiresAt ?? 'none'}
                className={`${styles.tipLine} ${index === 0 && buckets.length > 1 ? styles.tipFirst : ''}`}
              >
                {bucketLine(bucket)}
              </span>
            ))}
          </>
        )}
        {blockedReason && <span className={styles.tipNote}>{blockedReason}</span>}
      </>
    );
  };
  const groupTone = (group: ResetGroup): Tone =>
    group.nextExpiry !== null ? expiryTone(group.nextExpiry - now) : 'none';

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
  const renderTop = (value: ReactNode, action?: ReactNode) => (
    <div className={styles.top}>
      <span className={styles.label}>{t(`${NS}.col_resets`)}</span>
      <div className={styles.valueActions}>
        {value}
        {action}
        {refreshAction}
      </div>
    </div>
  );
  if (!loaded) {
    return (
      <div className={styles.cell}>
        {renderTop(<span className={styles.empty}>{loading ? '…' : '—'}</span>)}
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
    return <div className={styles.cell}>{renderTop(<span className={styles.empty}>—</span>)}</div>;
  }

  if (entry.type === 'claude' && !claudeLoaded && !claude.message) {
    return <div className={styles.cell}>{renderTop(<span className={styles.empty}>…</span>)}</div>;
  }
  if (count === null) {
    return (
      <div className={styles.cell}>
        {renderTop(
          <span className={styles.message} role="status">
            {claude.message ? t(`claude_reset.${claude.message}`) : '—'}
          </span>
        )}
      </div>
    );
  }

  let groups = groupByKind(items, now);
  // The backend summary can report Codex credits whose details failed to load.
  if (entry.type === 'codex' && count > 0 && groups.length === 0) {
    groups = [{ kind: 'account', count, nextExpiry: null, items: [] }];
  }

  const retrying = entry.type === 'claude' && claude.buttonLabel === 'retry';
  const busy = entry.type === 'claude' ? claude.busy : resetting;
  const usable = (kind?: AnthropicResetGrantKind) =>
    entry.file.disabled !== true &&
    (entry.type === 'codex' ? canAct && !resetting : claude.canUse(kind));
  const use = (kind?: AnthropicResetGrantKind) =>
    entry.type === 'claude' ? claude.confirm(kind) : onUseCodex();
  const useTitle =
    entry.type === 'claude'
      ? claude.blocked && !claude.busy
        ? t(`${NS}.resets_when_limited`)
        : t(`claude_reset.${claude.buttonLabel}`)
      : t('codex_quota.reset_button');
  /** Why this type's use button is disabled, specific to the type when Claude can say. */
  const blockedReasonFor = (kind: AnthropicResetGrantKind) => {
    const key = entry.type === 'claude' ? claude.blockReason(kind) : null;
    return key ? t(key) : useTitle;
  };
  const kindLabel = (group: ResetGroup) => t(`${NS}.resets_kind_${group.kind}`);
  const message = claude.message && (
    <span className={styles.message} role="status">
      {t(`claude_reset.${claude.message}`)}
    </span>
  );
  const retryButton = retrying && (
    <button
      type="button"
      className={styles.use}
      disabled={!usable()}
      onClick={() => use()}
      title={useTitle}
      aria-busy={busy}
    >
      {busy ? '…' : t(`${NS}.resets_retry`)}
    </button>
  );

  if (count === 0 || groups.length === 0) {
    return (
      <div className={styles.cell}>
        {renderTop(
          <span className={`${styles.count} ${styles.none}`}>{t(`${NS}.resets_none`)}</span>,
          retryButton
        )}
        {message}
      </div>
    );
  }

  // One line per reset type, each with its own use action and expiry breakdown on hover.
  return (
    <div className={styles.cell}>
      <span className={styles.label}>{t(`${NS}.col_resets`)}</span>
      <div className={styles.stack}>
        <ul className={styles.kindList}>
          {groups.map((group) => {
            const tone = groupTone(group);
            const kindUsable = usable(group.kind);
            return (
              <li
                key={group.kind}
                className={`${styles.kindRow} ${toneClassFor(tone)} ${tone === 'none' ? '' : styles.warm}`}
                // Rows without a usable button still need a tab stop to reach their expiry card.
                tabIndex={retrying || !kindUsable ? 0 : undefined}
                aria-describedby={`${tipId}-${group.kind}`}
                onMouseEnter={(event) =>
                  setOpenTip({
                    kind: group.kind,
                    rect: event.currentTarget.getBoundingClientRect(),
                  })
                }
                onMouseLeave={() => setOpenTip(null)}
                onFocus={(event) =>
                  setOpenTip({
                    kind: group.kind,
                    rect: event.currentTarget.getBoundingClientRect(),
                  })
                }
                onBlur={() => setOpenTip(null)}
              >
                <span className={styles.kindCount}>{group.count}</span>
                <span className={styles.kindName}>{kindLabel(group)}</span>
                {group.nextExpiry !== null && (
                  <span
                    className={styles.kindExpiry}
                    aria-label={t(`${NS}.resets_next`, {
                      time: format.countdown(group.nextExpiry - now),
                    })}
                  >
                    <IconTimer size={13} aria-hidden="true" />
                    {shortCountdown(group.nextExpiry - now)}
                  </span>
                )}
                {!retrying && (
                  <button
                    type="button"
                    className={styles.zap}
                    disabled={!kindUsable}
                    onClick={() => use(group.kind)}
                    aria-label={t(`${NS}.resets_use_kind`, { kind: kindLabel(group) })}
                    aria-busy={busy}
                    aria-describedby={`${tipId}-${group.kind}`}
                  >
                    {busy ? '…' : <IconZap size={14} />}
                  </button>
                )}
                <span id={`${tipId}-${group.kind}`} className={styles.srOnly}>
                  {tipBody(group, !retrying && !kindUsable ? blockedReasonFor(group.kind) : null)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className={styles.stackActions}>
          {retryButton}
          {refreshAction}
        </div>
      </div>
      {message}
      {openTip &&
        (() => {
          const group = groups.find((candidate) => candidate.kind === openTip.kind);
          if (!group) return null;
          const { rect } = openTip;
          // Open below the row; flip above when the row sits near the bottom of the screen.
          const above = rect.bottom + 180 > window.innerHeight;
          return createPortal(
            <div
              className={`${styles.tip} ${toneClassFor(groupTone(group))}`}
              aria-hidden="true"
              style={{
                right: Math.max(8, window.innerWidth - rect.right),
                ...(above
                  ? { bottom: window.innerHeight - rect.top + 6 }
                  : { top: rect.bottom + 6 }),
              }}
            >
              {tipBody(
                group,
                !retrying && !usable(group.kind) ? blockedReasonFor(group.kind) : null
              )}
            </div>,
            document.body
          );
        })()}
    </div>
  );
}
