/**
 * 额度账本：一行一个凭证，十列信息，按提供商 / 邮箱 / 套餐 / 状态分组，分组头可折叠。
 *
 * 每行右侧悬停时出现「刷新额度」，Codex 在有可用重置积分时多一个「重置」——
 * 保留旧额度卡片上的两个动作，只是不再占一整行。
 */

import { useMemo, useState } from 'react';
import { IconChevronDown, IconRefreshCw } from '@/components/ui/icons';
import {
  PROVIDER_LABEL,
  displayEmail,
  groupAccounts,
  windowEndsAt,
  type QuotaAccount,
} from './model';
import {
  LimitBar,
  PlanChip,
  ProviderMark,
  RefreshedText,
  StatusDot,
  TimeText,
  type QuotaViewProps,
} from './shared';
import { useQuotaFormat } from './useQuotaFormat';
import styles from './QuotaLedger.module.scss';

const NS = 'quota_management.home';

export interface QuotaRowActions {
  /** 连接正常且列表已落定。 */
  canAct: boolean;
  /** 正在被重置的凭证 id。 */
  resettingId: string | null;
  onRefresh: (id: string) => void;
  canReset: (id: string) => boolean;
  onReset: (id: string) => void;
}

type LedgerProps = QuotaViewProps & { actions: QuotaRowActions };

const COLUMNS = [
  'col_account',
  'col_plan',
  'col_subscription',
  'col_auth',
  'col_window',
  'col_five_hour',
  'col_weekly',
  'col_fable',
] as const;

function LedgerRow({
  account,
  now,
  redact,
  theme,
  actions,
}: { account: QuotaAccount } & Pick<LedgerProps, 'now' | 'redact' | 'theme' | 'actions'>) {
  const { t } = useQuotaFormat();
  const loaded = !account.pending && !account.error && !account.disabled;
  const windowEnds = loaded ? windowEndsAt(account) : null;
  const placeholder = account.pending ? '…' : '—';
  const busy = actions.resettingId === account.id;

  return (
    <tr className={`${styles.row} ${account.disabled ? styles.rowDimmed : ''}`}>
      <td className={styles.identity}>
        <div className={styles.identityInner}>
          <ProviderMark provider={account.provider} theme={theme} size={38} />
          <div className={styles.identityText}>
            <span className={styles.name}>
              <StatusDot account={account} now={now} />
              <span className={styles.nameText} title={account.name}>
                {account.name}
              </span>
            </span>
            <span className={styles.email}>{displayEmail(account.email, redact)}</span>
          </div>
          {!account.disabled && (
            <div className={styles.actions}>
              {actions.canReset(account.id) && (
                <button
                  type="button"
                  className={styles.actionText}
                  onClick={() => actions.onReset(account.id)}
                  disabled={!actions.canAct || account.pending || busy}
                >
                  {t('codex_quota.reset_button')}
                </button>
              )}
              <button
                type="button"
                className={styles.actionIcon}
                onClick={() => actions.onRefresh(account.id)}
                disabled={!actions.canAct || busy}
                aria-label={t('auth_files.quota_refresh_single')}
                title={t('auth_files.quota_refresh_hint')}
              >
                <IconRefreshCw size={14} className={account.pending ? styles.spinning : undefined} />
              </button>
            </div>
          )}
        </div>
      </td>
      <td>
        <PlanChip plan={account.plan} />
      </td>
      <td>
        <TimeText
          ts={account.subscriptionEndsAt}
          now={now}
          kind="subscription"
          unavailableHint={
            account.provider === 'claude' ? t(`${NS}.claude_no_subscription_end`) : undefined
          }
        />
      </td>
      <td>
        {account.error ? (
          <span className={styles.errorText}>{account.error}</span>
        ) : account.authExpiresAt !== null ? (
          <TimeText ts={account.authExpiresAt} now={now} kind="auth" />
        ) : account.lastRefreshAt !== null ? (
          <RefreshedText ts={account.lastRefreshAt} now={now} />
        ) : (
          <TimeText ts={null} now={now} kind="auth" />
        )}
      </td>
      <td>
        <TimeText ts={windowEnds} now={now} kind="window" />
      </td>
      <td>
        <LimitBar limit={account.fiveHour} now={now} width={104} emptyLabel={placeholder} />
      </td>
      <td>
        <LimitBar
          limit={account.weekly}
          now={now}
          showReset
          width={124}
          emptyLabel={placeholder}
        />
      </td>
      <td>
        <LimitBar
          limit={account.fable}
          now={now}
          showReset
          width={124}
          emptyLabel={
            account.provider === 'claude' && loaded ? t(`${NS}.not_on_plan`) : placeholder
          }
        />
      </td>
    </tr>
  );
}

export function QuotaLedger({ accounts, now, redact, theme, groupBy, actions }: LedgerProps) {
  const { t, groupTitle } = useQuotaFormat();
  const groups = useMemo(() => groupAccounts(accounts, groupBy, now), [accounts, groupBy, now]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column} scope="col">
                {t(`${NS}.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => {
          const isCollapsed = collapsed[group.key] === true;
          return (
            <tbody key={group.key}>
              {groupBy !== 'none' && (
                <tr className={styles.groupRow}>
                  <td colSpan={COLUMNS.length}>
                    <button
                      type="button"
                      className={styles.groupButton}
                      aria-expanded={!isCollapsed}
                      onClick={() => toggle(group.key)}
                    >
                      <IconChevronDown
                        size={16}
                        className={`${styles.chevron} ${isCollapsed ? styles.chevronClosed : ''}`}
                      />
                      {group.provider && (
                        <ProviderMark provider={group.provider} theme={theme} size={24} />
                      )}
                      <span className={styles.groupLabel}>{groupTitle(group, groupBy, redact)}</span>
                      <span className={styles.groupMeta}>
                        {t(`${NS}.group_accounts`, { count: group.accounts.length })}
                        <span className={styles.groupDivider} aria-hidden="true" />
                        {t(`${NS}.group_ready`, { count: group.readyCount })}
                        {groupBy === 'email' && (
                          <>
                            <span className={styles.groupDivider} aria-hidden="true" />
                            {Array.from(new Set(group.accounts.map((a) => a.provider)))
                              .map((provider) => PROVIDER_LABEL[provider])
                              .join(' · ')}
                          </>
                        )}
                      </span>
                    </button>
                  </td>
                </tr>
              )}
              {!isCollapsed &&
                group.accounts.map((account) => (
                  <LedgerRow
                    key={account.id}
                    account={account}
                    now={now}
                    redact={redact}
                    theme={theme}
                    actions={actions}
                  />
                ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
