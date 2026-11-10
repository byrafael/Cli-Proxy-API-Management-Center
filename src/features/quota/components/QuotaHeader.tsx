import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useCountUp } from '@/hooks/motion';
import { LIVE_REFRESH_OPTIONS, isLiveRefreshOption, type LiveRefreshOption } from '../liveRefresh';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
  liveRefresh: LiveRefreshOption;
  onLiveRefreshChange: (next: LiveRefreshOption) => void;
  /** When the last full read of every credential finished, epoch ms. */
  updatedAt: number | null;
};

/**
 * 额度页头部：标题领衔 + ▍mono 遥测 meta 行 + 墨色药丸「刷新全部」。
 * 与凭证库头部同语汇（无 eyebrow —— ▍游标挂在 meta 行开头）。
 *
 * 入场：三处 `data-reveal` 交给页面壳的 useRevealGroup 统一编排
 * （标题 0ms → meta 70ms → 动作 140ms → tabs 210ms）。
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const {
    totalCount,
    loadedCount,
    attentionCount,
    refreshing,
    disableControls,
    onRefreshAll,
    liveRefresh,
    onLiveRefreshChange,
    updatedAt,
  } = props;
  const { t, i18n } = useTranslation();
  const live = liveRefresh !== 'off';
  const liveOptions = LIVE_REFRESH_OPTIONS.map((option) => ({
    value: option,
    label: t(`quota_management.live_refresh_${option}`),
  }));
  // 批量结果陆续落地时，「已加载」是页面上唯一滚动的数字
  const displayLoadedCount = useCountUp(loadedCount);

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title} data-reveal>
          {t('quota_management.title')}
        </h1>
        <p className={styles.meta} data-reveal>
          <span className={styles.metaTotal}>
            {t('quota_management.meta_credentials', { count: totalCount })}
          </span>
          <span className={styles.metaDot} aria-hidden="true">
            ·
          </span>
          <span className={loadedCount > 0 ? styles.metaLoaded : styles.metaMuted}>
            {t('quota_management.meta_loaded', { count: displayLoadedCount })}
          </span>
          {attentionCount > 0 && (
            <>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.metaAttention}>
                {t('quota_management.meta_attention', { count: attentionCount })}
              </span>
            </>
          )}
          {updatedAt !== null && (
            <>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.metaMuted}>
                {t('quota_management.meta_updated', {
                  time: new Date(updatedAt).toLocaleTimeString(i18n.language, {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  }),
                })}
              </span>
            </>
          )}
        </p>
      </div>
      <div className={styles.actions} data-reveal>
        <div className={styles.live}>
          <span
            className={live ? styles.liveDotOn : styles.liveDot}
            data-live={live}
            aria-hidden="true"
          />
          <span className={styles.liveLabel} id="quota-live-refresh-label">
            {t('quota_management.live_refresh_label')}
          </span>
          <Select
            size="sm"
            value={liveRefresh}
            options={liveOptions}
            ariaLabelledBy="quota-live-refresh-label"
            disabled={disableControls}
            onChange={(value) => {
              if (isLiveRefreshOption(value)) onLiveRefreshChange(value);
            }}
          />
        </div>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onRefreshAll}
          disabled={disableControls || refreshing}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          {t('quota_management.refresh_all_credentials')}
        </button>
      </div>
    </header>
  );
}
