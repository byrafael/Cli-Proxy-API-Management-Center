/**
 * 时间轴：一条泳道一个凭证，上方标记窗口重置（◆ 5h / ◇ 周），下方标记登录到期（●）。
 * 轴是分段缩放的：近处（分钟 / 小时）有分辨率，远处（天）被压缩。
 * 泳道顺序由页面决定（最近的事件在前），这里不分组。
 */

import { DAY, HOUR, accountStatus, accountTitle, timeTone, toneFor, type Tone } from './model';
import { PlanChip, ProviderMark, type QuotaViewProps } from './shared';
import { toneClassFor } from './tone';
import { useQuotaFormat } from './useQuotaFormat';
import type { QuotaAccount, QuotaLimit } from './model';
import styles from './QuotaRunway.module.scss';

const NS = 'quota_management.home';

/** [距离现在的毫秒数, 轴上的百分比位置] */
const STOPS: readonly [number, number][] = [
  [0, 0],
  [HOUR, 12],
  [6 * HOUR, 32],
  [DAY, 52],
  [3 * DAY, 70],
  [7 * DAY, 87],
  [30 * DAY, 100],
];

const TICKS: readonly { at: number; label: string | null }[] = [
  { at: 0, label: null },
  { at: HOUR, label: '1h' },
  { at: 6 * HOUR, label: '6h' },
  { at: DAY, label: '1d' },
  { at: 3 * DAY, label: '3d' },
  { at: 7 * DAY, label: '7d' },
  { at: 30 * DAY, label: '30d' },
];

const runwayX = (deltaMs: number): number => {
  if (deltaMs <= STOPS[0][0]) return STOPS[0][1];
  for (let index = 1; index < STOPS.length; index += 1) {
    const [toMs, toPct] = STOPS[index];
    const [fromMs, fromPct] = STOPS[index - 1];
    if (deltaMs <= toMs) return fromPct + ((deltaMs - fromMs) / (toMs - fromMs)) * (toPct - fromPct);
  }
  return STOPS[STOPS.length - 1][1];
};

type MarkerShape = 'diamond' | 'diamondHollow' | 'circle';

function Marker({
  ts,
  now,
  shape,
  tone,
  labelKey,
  side,
}: {
  ts: number;
  now: number;
  shape: MarkerShape;
  tone: Tone;
  labelKey: string;
  side: 'top' | 'bottom';
}) {
  const format = useQuotaFormat();
  const delta = ts - now;
  const left = runwayX(Math.max(0, delta));
  const label = format.t(`${NS}.${labelKey}`);
  const text =
    delta <= 0
      ? format.t(`${NS}.marker_expired`, { label })
      : `${label} ${format.countdown(delta)}`;
  const classes = [
    styles.marker,
    styles[shape],
    toneClassFor(tone),
    side === 'top' ? styles.top : styles.bottom,
    left > 82 ? styles.flip : '',
    left < 8 ? styles.edge : '',
    tone === 'medium' || tone === 'low' ? styles.markerTone : '',
  ];
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      style={{ left: `${left}%` }}
      title={`${label}: ${format.absolute(ts)}`}
    >
      <i className={styles.glyph} />
      <span className={styles.markerLabel}>{text}</span>
    </span>
  );
}

function Pct({ limit }: { limit: QuotaLimit | null }) {
  if (limit === null) return <span className={styles.pctEmpty}>—</span>;
  return (
    <span className={`${styles.pct} ${toneClassFor(toneFor(limit.remainingPct))}`}>
      {Math.round(limit.remainingPct)}
    </span>
  );
}

function Lane({
  account,
  now,
  redact,
  theme,
}: { account: QuotaAccount } & Pick<QuotaViewProps, 'now' | 'redact' | 'theme'>) {
  const { t } = useQuotaFormat();
  const status = accountStatus(account, now);
  const title = accountTitle(account, redact);
  const showWindows = !account.disabled && !account.error && !account.pending;
  return (
    <div className={`${styles.lane} ${account.disabled ? styles.laneDisabled : ''}`}>
      <div className={styles.identity}>
        <ProviderMark provider={account.provider} theme={theme} size={36} />
        <span className={styles.identityText}>
          <span className={styles.name} title={redact ? undefined : title.primary}>
            {title.primary}
          </span>
          <span className={styles.email}>{title.secondary}</span>
        </span>
        <PlanChip plan={account.plan} />
      </div>

      <div className={styles.trackArea} data-status={status}>
        <span className={styles.rail} aria-hidden="true" />
        {showWindows && account.fiveHour && (
          <Marker
            ts={account.fiveHour.resetsAt}
            now={now}
            shape="diamond"
            tone={toneFor(account.fiveHour.remainingPct)}
            labelKey="marker_five_hour"
            side="top"
          />
        )}
        {showWindows && account.weekly && (
          <Marker
            ts={account.weekly.resetsAt}
            now={now}
            shape="diamondHollow"
            tone={toneFor(account.weekly.remainingPct)}
            labelKey="marker_week"
            side="top"
          />
        )}
        {account.authExpiresAt !== null && (
          <Marker
            ts={account.authExpiresAt}
            now={now}
            shape="circle"
            tone={timeTone('auth', account.authExpiresAt - now)}
            labelKey="marker_login"
            side="bottom"
          />
        )}
      </div>

      <div className={styles.pcts}>
        {account.error ? (
          <span className={styles.pctError}>{t(`${NS}.lane_sign_in`)}</span>
        ) : (
          <>
            <Pct limit={account.fiveHour} />
            <Pct limit={account.weekly} />
            <Pct limit={account.fable} />
          </>
        )}
      </div>
    </div>
  );
}

export function QuotaRunway({ accounts, now, redact, theme }: Omit<QuotaViewProps, 'groupBy'>) {
  const { t } = useQuotaFormat();

  return (
    <div className={styles.wrap}>
      <div className={styles.legend} aria-label={t(`${NS}.runway_legend`)}>
        <span>
          <i className={`${styles.glyph} ${styles.diamond}`} /> {t(`${NS}.legend_five_hour`)}
        </span>
        <span>
          <i className={`${styles.glyph} ${styles.diamondHollow}`} /> {t(`${NS}.legend_weekly`)}
        </span>
        <span>
          <i className={`${styles.glyph} ${styles.circle}`} /> {t(`${NS}.legend_login`)}
        </span>
      </div>

      <div className={styles.board}>
        <div className={`${styles.lane} ${styles.axisRow}`}>
          <span />
          <div className={styles.axis} aria-hidden="true">
            {TICKS.map((tick) => (
              <span
                key={tick.at}
                className={styles.tick}
                style={{ left: `${runwayX(tick.at)}%` }}
              >
                {tick.label ?? t(`${NS}.axis_now`)}
              </span>
            ))}
          </div>
          <div className={styles.pcts}>
            <span>{t(`${NS}.lane_five_hour`)}</span>
            <span>{t(`${NS}.lane_week`)}</span>
            <span>{t(`${NS}.lane_fable`)}</span>
          </div>
        </div>

        <div className={styles.lanes}>
          <div className={styles.gridlines} aria-hidden="true">
            {TICKS.map((tick) => (
              <span key={tick.at} style={{ left: `${runwayX(tick.at)}%` }} />
            ))}
          </div>
          {accounts.map((account) => (
            <Lane key={account.id} account={account} now={now} redact={redact} theme={theme} />
          ))}
        </div>
      </div>
    </div>
  );
}
