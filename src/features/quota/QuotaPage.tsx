/**
 * 额度页：账本（一行一个凭证）+ 时间轴（最近的事件在前）。
 *
 * 保留的行为契约（重设计不改）：
 * - cacheGeneration 会话隔离 + request-id 去重（见 useQuotaBatchLoader）；
 * - 文件列表变化后按 provider 剪枝额度缓存（已删文件不残留）；
 * - useHeaderRefresh 单槽位：本页唯一注册者，全局刷新 = 重取文件列表。
 *
 * 有意的行为变化：
 * - 进入页面后自动加载一次尚无缓存的凭证额度（按 QUOTA_PAGE_SIZE 分批，限制上游并发），
 *   不再需要逐张卡片点击；失败的不会自动重试，避免循环打上游；
 * - 提供商 tabs / 排序 / 分页由「分组」控件和时间轴顺序取代。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconEye, IconEyeOff, IconSearch, IconX } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { useRevealGroup } from '@/hooks/motion';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { QuotaHeader } from './components/QuotaHeader';
import { QUOTA_PAGE_SIZE, QUOTA_TAB_ORDER } from './constants';
import { buildQuotaAccount } from './home/fromQuota';
import {
  GROUP_BY_OPTIONS,
  accountStatus,
  filterAccounts,
  nextEventAt,
  summarize,
  type GroupBy,
} from './home/model';
import { QuotaLedger, type QuotaRowActions } from './home/QuotaLedger';
import { QuotaRunway } from './home/QuotaRunway';
import { useQuotaFormat } from './home/useQuotaFormat';
import { canRefreshQuotaAfterList, classifyQuotaFiles, type QuotaFileEntry } from './logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from './providers';
import type { QuotaProviderType } from './providers/types';
import { useQuotaActions } from './hooks/useQuotaActions';
import { useQuotaBatchLoader } from './hooks/useQuotaBatchLoader';
import { readQuotaUiState, writeQuotaUiState } from './uiState';
import styles from './QuotaPage.module.scss';

const NS = 'quota_management.home';
const SKELETON_ROWS = 6;

export function QuotaPage() {
  const { t } = useTranslation();
  const format = useQuotaFormat();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>(() => readQuotaUiState()?.groupBy ?? 'provider');
  const [redact, setRedact] = useState<boolean>(() => readQuotaUiState()?.redactEmails ?? false);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [search, setSearch] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  // 页头入场级联（标题 → meta → 动作，级差 70ms）
  const revealRef = useRevealGroup<HTMLDivElement>();

  const disableControls = connectionStatus !== 'connected';
  const now = useNow();

  /* ---------- 文件列表 ---------- */

  const sessionGeneration = useQuotaStore((state) => state.cacheGeneration);
  const [filesGeneration, setFilesGeneration] = useState<number | null>(null);
  const listRequestRef = useRef(0);
  const loadFiles = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    if (connectionStatus !== 'connected') {
      setFiles([]);
      setFilesGeneration(null);
      setLoading(false);
      return;
    }
    const isCurrent = () =>
      requestId === listRequestRef.current &&
      sessionGeneration === useQuotaStore.getState().cacheGeneration;
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      if (!isCurrent()) return;
      setFiles(data?.files || []);
      setFilesGeneration(sessionGeneration);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [connectionStatus, sessionGeneration, t]);

  useHeaderRefresh(loadFiles);

  useEffect(() => {
    void loadFiles();
    return () => {
      listRequestRef.current += 1;
    };
  }, [loadFiles]);

  /* ---------- 额度缓存 ---------- */

  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);

  const quotaByType = useMemo<Record<QuotaProviderType, Record<string, QuotaCardState>>>(
    () =>
      ({
        antigravity: antigravityQuota,
        claude: claudeQuota,
        codex: codexQuota,
        devin: devinQuota,
        kimi: kimiQuota,
        meta: metaQuota,
        plugin: pluginQuota,
        xai: xaiQuota,
      }) as unknown as Record<QuotaProviderType, Record<string, QuotaCardState>>,
    [
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    ]
  );

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [getQuotaCacheKey(entry.file), entry])),
    [entries]
  );

  const describeError = useCallback(
    (status: number | undefined, message: string) =>
      resolveQuotaErrorMessage(t, status, message || t('common.unknown_error')),
    [t]
  );

  const allAccounts = useMemo(
    () =>
      entries.map((entry) => {
        const key = getQuotaCacheKey(entry.file);
        return buildQuotaAccount(entry, key, quotaByType[entry.type][key], { describeError });
      }),
    [entries, quotaByType, describeError]
  );

  const { loadedCount, attentionCount } = useMemo(() => {
    let loaded = 0;
    let attention = 0;
    allAccounts.forEach((account) => {
      if (!account.pending && !account.error) loaded += 1;
      else if (account.error) attention += 1;
    });
    return { loadedCount: loaded, attentionCount: attention };
  }, [allAccounts]);

  const accounts = useMemo(() => {
    const searched = filterAccounts(allAccounts, search, redact);
    if (!attentionOnly) return searched;
    return searched.filter((account) => {
      const status = accountStatus(account, now);
      return status === 'limited' || status === 'expiring' || status === 'error';
    });
  }, [allAccounts, search, redact, attentionOnly, now]);

  const byNextEvent = useMemo(
    () => [...accounts].sort((a, b) => nextEventAt(a, now) - nextEventAt(b, now)),
    [accounts, now]
  );

  const summary = useMemo(() => summarize(allAccounts, now), [allAccounts, now]);

  // 剪枝：文件列表落定后，各 provider 缓存只保留仍存在的凭证
  useEffect(() => {
    if (loading || error || filesGeneration !== sessionGeneration) return;
    const survivorsByType = new Map<QuotaProviderType, Set<string>>(
      QUOTA_TAB_ORDER.map((type) => [type, new Set<string>()])
    );
    entries.forEach((entry) => survivorsByType.get(entry.type)?.add(getQuotaCacheKey(entry.file)));

    QUOTA_TAB_ORDER.forEach((type) => {
      const survivors = survivorsByType.get(type) ?? new Set<string>();
      const setQuota = getQuotaSetter(QUOTA_ADAPTERS[type]);
      setQuota((prev) => {
        const staleKeys = Object.keys(prev).filter((name) => !survivors.has(name));
        if (staleKeys.length === 0) return prev;
        const next = { ...prev };
        staleKeys.forEach((name) => delete next[name]);
        return next;
      });
    });
  }, [entries, error, filesGeneration, loading, sessionGeneration]);

  /* ---------- 加载与动作 ---------- */

  const { batchLoading, loadQuota } = useQuotaBatchLoader();
  const { resettingQuotaName, refreshQuota, resetQuota } = useQuotaActions(disableControls);

  /** 分批加载：每批最多 QUOTA_PAGE_SIZE 个，批与批之间串行，限制对上游的并发。 */
  const loadInBatches = useCallback(
    async (targets: QuotaFileEntry[], isCancelled: () => boolean = () => false) => {
      for (let start = 0; start < targets.length; start += QUOTA_PAGE_SIZE) {
        if (isCancelled()) return;
        await loadQuota(targets.slice(start, start + QUOTA_PAGE_SIZE));
      }
    },
    [loadQuota]
  );

  const filesSettled =
    !disableControls && !loading && !error && filesGeneration === sessionGeneration;

  // 进入页面后自动加载一次尚无缓存的凭证；同一会话代只触发一次。
  const autoLoadedGenerationRef = useRef<number | null>(null);
  useEffect(() => {
    if (!filesSettled || autoLoadedGenerationRef.current === sessionGeneration) return;
    autoLoadedGenerationRef.current = sessionGeneration;
    const pending = entries.filter((entry) => {
      const status = quotaByType[entry.type][getQuotaCacheKey(entry.file)]?.status;
      return status === undefined || status === 'idle';
    });
    if (pending.length === 0) return;
    let cancelled = false;
    void loadInBatches(pending, () => cancelled);
    return () => {
      cancelled = true;
    };
    // quotaByType 只在触发瞬间读取一次；把它放进依赖会让每次额度落地都重跑本 effect。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesSettled, sessionGeneration, entries, loadInBatches]);

  const pendingRefreshRef = useRef<number | null>(null);
  const prevLoadingRef = useRef(loading);

  // 刷新全部：先重取文件列表，待其落定（loading 下降沿）再分批拉全部凭证额度
  const handleRefreshAll = useCallback(() => {
    if (disableControls) return;
    pendingRefreshRef.current = sessionGeneration;
    void loadFiles();
  }, [disableControls, loadFiles, sessionGeneration]);

  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = loading;

    const requestedSession = pendingRefreshRef.current;
    if (requestedSession === null) return;
    if (requestedSession !== sessionGeneration) {
      pendingRefreshRef.current = null;
      return;
    }
    if (loading || !wasLoading) return;

    pendingRefreshRef.current = null;
    if (
      canRefreshQuotaAfterList(
        requestedSession,
        sessionGeneration,
        filesGeneration,
        Boolean(error),
        disableControls
      )
    ) {
      void loadInBatches(entries);
    }
  }, [disableControls, entries, error, filesGeneration, loading, loadInBatches, sessionGeneration]);

  const rowActions = useMemo<QuotaRowActions>(
    () => ({
      canAct: filesSettled,
      resettingId: resettingQuotaName,
      onRefresh: (id) => {
        const entry = entryById.get(id);
        if (entry) void refreshQuota(entry.file, QUOTA_ADAPTERS[entry.type]);
      },
      canReset: (id) => {
        const entry = entryById.get(id);
        if (!entry) return false;
        const adapter = QUOTA_ADAPTERS[entry.type];
        const quota = quotaByType[entry.type][id];
        return (
          quota?.status === 'success' &&
          Boolean(adapter.resetQuota) &&
          Boolean(adapter.canResetQuota?.(quota))
        );
      },
      onReset: (id) => {
        const entry = entryById.get(id);
        if (entry) resetQuota(entry.file, QUOTA_ADAPTERS[entry.type]);
      },
      noteFor: (id) => entryById.get(id)?.file.note?.trim() ?? '',
      onRename: async (id, name) => {
        const entry = entryById.get(id);
        if (!entry) return;
        const note = name.trim();
        try {
          // 显示名就是凭证的备注（note）；清空备注即回到后端 label / 文件名。
          await authFilesApi.patchFields(entry.file.name, { note });
          setFiles((prev) =>
            prev.map((file) =>
              file.name === entry.file.name ? { ...file, note: note || undefined } : file
            )
          );
          showNotification(t(`${NS}.rename_saved`), 'success');
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : '';
          showNotification(
            message ? `${t(`${NS}.rename_failed`)}: ${message}` : t(`${NS}.rename_failed`),
            'error'
          );
          throw err;
        }
      },
    }),
    [
      entryById,
      filesSettled,
      quotaByType,
      refreshQuota,
      resetQuota,
      resettingQuotaName,
      showNotification,
      t,
    ]
  );

  /* ---------- 控件 ---------- */

  const handleGroupBy = useCallback((next: GroupBy) => {
    setGroupBy(next);
    writeQuotaUiState({ groupBy: next });
  }, []);

  const handleRedact = useCallback(() => {
    setRedact((prev) => {
      writeQuotaUiState({ redactEmails: !prev });
      return !prev;
    });
  }, []);

  const handleSearchChange = useCallback((value: string) => setSearch(value), []);

  /* ---------- 渲染 ---------- */

  const isEmpty = !loading && entries.length === 0;
  const noMatches = !loading && entries.length > 0 && accounts.length === 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <QuotaHeader
        totalCount={entries.length}
        loadedCount={loadedCount}
        attentionCount={attentionCount}
        refreshing={loading || batchLoading}
        disableControls={disableControls}
        onRefreshAll={handleRefreshAll}
      />

      <section className={styles.workbench}>
        <div className={styles.toolbar}>
          <div className={styles.search}>
            <IconSearch size={16} className={styles.searchIcon} aria-hidden="true" />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="search"
              value={search}
              onChange={(event) => handleSearchChange(event.target.value)}
              placeholder={t('quota_management.search_placeholder')}
              aria-label={t('quota_management.search_label')}
            />
            {search && (
              <button
                type="button"
                className={styles.clearSearch}
                aria-label={t('quota_management.search_clear')}
                title={t('quota_management.search_clear')}
                onClick={() => {
                  handleSearchChange('');
                  searchInputRef.current?.focus();
                }}
              >
                <IconX size={14} aria-hidden="true" />
              </button>
            )}
          </div>

          <label className={styles.check}>
            <input
              type="checkbox"
              checked={attentionOnly}
              onChange={(event) => setAttentionOnly(event.target.checked)}
            />
            {t(`${NS}.attention_only`)}
          </label>

          <button
            type="button"
            className={styles.redact}
            aria-pressed={redact}
            onClick={handleRedact}
            title={redact ? t(`${NS}.show_emails`) : t(`${NS}.hide_emails`)}
          >
            {redact ? (
              <IconEyeOff size={15} aria-hidden="true" />
            ) : (
              <IconEye size={15} aria-hidden="true" />
            )}
            {redact ? t(`${NS}.emails_hidden`) : t(`${NS}.emails_shown`)}
          </button>

          <div className={styles.groupBy}>
            <span className={styles.groupByLabel}>{t(`${NS}.group_by`)}</span>
            <div className={styles.segment} role="group" aria-label={t(`${NS}.group_by`)}>
              {GROUP_BY_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={groupBy === option}
                  onClick={() => handleGroupBy(option)}
                >
                  {t(`${NS}.group_${option}`)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {!loading && entries.length > 0 && (
          <p className={styles.pulse}>
            <strong>{summary.ready}</strong> {t(`${NS}.pulse_ready`, { total: summary.total })}
            <span className={styles.pulseSep} aria-hidden="true" />
            <strong>{summary.limited}</strong> {t(`${NS}.pulse_limited`)}
            <span className={styles.pulseSep} aria-hidden="true" />
            <strong>{summary.needsAttention}</strong> {t(`${NS}.pulse_attention`)}
            {summary.nextRecoveryAt !== null && (
              <>
                <span className={styles.pulseSep} aria-hidden="true" />
                {t(`${NS}.pulse_next_recovery`)}{' '}
                <strong>{format.countdown(summary.nextRecoveryAt - now)}</strong>
              </>
            )}
          </p>
        )}

        {error && (
          <div className={styles.errorBanner} role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className={styles.skeletonList} aria-hidden="true">
            {Array.from({ length: SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} height={76} rounded={14} />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            title={t('quota_management.empty_title')}
            description={t('quota_management.empty_desc')}
          />
        ) : noMatches ? (
          <EmptyState
            title={t('quota_management.search_empty_title')}
            description={t('quota_management.search_empty_desc')}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  handleSearchChange('');
                  setAttentionOnly(false);
                }}
              >
                {t('quota_management.search_clear')}
              </Button>
            }
          />
        ) : (
          <>
            <QuotaLedger
              accounts={accounts}
              now={now}
              redact={redact}
              theme={resolvedTheme}
              groupBy={groupBy}
              actions={rowActions}
            />

            <section className={styles.runway} aria-labelledby="quota-runway-title">
              <header className={styles.runwayHead}>
                <h2 id="quota-runway-title">{t(`${NS}.runway_title`)}</h2>
                <p>{t(`${NS}.runway_hint`)}</p>
              </header>
              <QuotaRunway accounts={byNextEvent} now={now} redact={redact} theme={resolvedTheme} />
            </section>
          </>
        )}
      </section>
    </div>
  );
}
