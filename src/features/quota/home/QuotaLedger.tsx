/**
 * 额度账本：一行一个凭证，五列信息，按提供商 / 邮箱 / 套餐 / 状态分组，分组头可折叠。
 *
 * 每行右侧悬停时出现「刷新额度」，Codex 在有可用重置积分时多一个「重置」——
 * 保留旧额度卡片上的两个动作，只是不再占一整行。
 */

import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { IconChevronDown, IconPencil } from '@/components/ui/icons';
import {
  PROVIDER_LABEL,
  accountTitle,
  groupAccounts,
  redactEmailsIn,
  type QuotaAccount,
} from './model';
import { LimitBar, ProviderMark, StatusDot, type QuotaViewProps } from './shared';
import { useQuotaFormat } from './useQuotaFormat';
import styles from './QuotaLedger.module.scss';

const NS = 'quota_management.home';

export interface QuotaRowActions {
  /** 连接正常且列表已落定。 */
  canAct: boolean;
  /** 当前的自定义显示名（备注）；没有则为空串。 */
  noteFor: (id: string) => string;
  /** 保存自定义显示名；空串清除。失败时 reject（页面已提示）。 */
  onRename: (id: string, name: string) => Promise<void>;
}

type LedgerProps = QuotaViewProps & {
  actions: QuotaRowActions;
  /** 手动重置列：由页面渲染（需要凭证文件与额度状态）。 */
  renderResets: (account: QuotaAccount) => ReactNode;
};

/** 固定列宽（占表宽百分比，合计 100）：内容再长也不会挤占别的列。 */
const COLUMN_WIDTHS = [26, 18, 18, 18, 20] as const;

const COLUMNS = ['col_account', 'col_weekly', 'col_five_hour', 'col_fable', 'col_resets'] as const;

function LedgerRow({
  account,
  now,
  redact,
  theme,
  actions,
  renderResets,
}: { account: QuotaAccount } & Pick<
  LedgerProps,
  'now' | 'redact' | 'theme' | 'actions' | 'renderResets'
>) {
  const { t, absolute } = useQuotaFormat();
  const loaded = !account.pending && !account.error && !account.disabled;
  const placeholder = account.pending ? '…' : '—';
  const weeklyLabel =
    account.weekly?.periodHours === 168 &&
    account.weekly.label === t('codex_quota.secondary_window')
      ? `${t(`${NS}.period_week`)} • ${t('quota_management.windows_mode_weekly')}`
      : account.weekly?.label;
  const title = accountTitle(account, redact);
  const errorText = account.error && redact ? redactEmailsIn(account.error) : account.error;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setDraft(actions.noteFor(account.id));
    setEditing(true);
  };
  const cancelEditing = () => {
    if (!saving) setEditing(false);
  };
  const saveEditing = async () => {
    if (saving) return;
    if (draft.trim() === actions.noteFor(account.id)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await actions.onRename(account.id, draft);
      setEditing(false);
    } catch {
      // 页面已经提示失败；留在编辑态让用户重试。
    } finally {
      setSaving(false);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveEditing();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    }
  };

  return (
    <tr className={`${styles.row} ${account.disabled ? styles.rowDimmed : ''}`}>
      <td className={styles.identity} headers="quota-col-account">
        <div className={styles.identityInner}>
          <ProviderMark provider={account.provider} theme={theme} size={38} />
          <div className={styles.identityText}>
            <span className={styles.name}>
              <StatusDot account={account} now={now} />
              {editing ? (
                <input
                  className={styles.nameInput}
                  value={draft}
                  autoFocus
                  disabled={saving}
                  maxLength={80}
                  placeholder={redact ? redactEmailsIn(title.primary) : title.primary}
                  aria-label={t(`${NS}.rename_label`)}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={() => void saveEditing()}
                />
              ) : (
                <span className={styles.nameText} title={redact ? undefined : title.primary}>
                  {title.primary}
                </span>
              )}
            </span>
            <span className={styles.email}>
              {PROVIDER_LABEL[account.provider]}
              {title.secondary !== PROVIDER_LABEL[account.provider] && ` · ${title.secondary}`}
            </span>
            {account.error && (
              <span className={styles.errorText} title={errorText ?? undefined}>
                {errorText}
              </span>
            )}
            {account.lastRefreshAt !== null && (
              <span className={styles.lastRefresh}>
                {t(`${NS}.token_refreshed`)} {absolute(account.lastRefreshAt)}
              </span>
            )}
          </div>
          {!editing && (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.actionIcon}
                onClick={startEditing}
                disabled={!actions.canAct}
                aria-label={t(`${NS}.rename`)}
                title={t(`${NS}.rename`)}
              >
                <IconPencil size={14} />
              </button>
            </div>
          )}
        </div>
      </td>
      <td headers="quota-col-weekly">
        <LimitBar
          limit={account.weekly}
          label={weeklyLabel}
          now={now}
          showReset
          fullWidth
          emptyLabel={placeholder}
        />
      </td>
      <td headers="quota-col-five_hour">
        <LimitBar
          limit={account.fiveHour}
          label={account.fiveHour?.label}
          now={now}
          showReset
          fullWidth
          emptyLabel={placeholder}
        />
      </td>
      <td headers="quota-col-fable">
        <LimitBar
          limit={account.fable}
          label={account.fable?.label}
          now={now}
          showReset
          fullWidth
          emptyLabel={
            account.provider === 'claude' && loaded ? t(`${NS}.not_on_plan`) : placeholder
          }
        />
      </td>
      <td headers="quota-col-resets">{renderResets(account)}</td>
    </tr>
  );
}

export function QuotaLedger({
  accounts,
  now,
  redact,
  theme,
  groupBy,
  actions,
  renderResets,
}: LedgerProps) {
  const { t, groupTitle } = useQuotaFormat();
  const groups = useMemo(() => groupAccounts(accounts, groupBy, now), [accounts, groupBy, now]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggle = (key: string) => setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <colgroup>
          {COLUMN_WIDTHS.map((width, index) => (
            <col key={COLUMNS[index]} style={{ width: `${width}%` }} />
          ))}
        </colgroup>
        <thead className={styles.visuallyHiddenHeader}>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column} id={`quota-col-${column}`} scope="col">
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
                      <span className={styles.groupLabel}>
                        {groupTitle(group, groupBy, redact)}
                      </span>
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
                    renderResets={renderResets}
                  />
                ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
