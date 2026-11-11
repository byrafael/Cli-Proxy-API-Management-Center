/**
 * Usage forecast section at the top of the quota page: one chart for every
 * provider together (each line from zero, plus their total), then one card per
 * provider.
 */

import { useMemo } from 'react';
import type { ResolvedTheme } from '@/types';
import { PROVIDER_LABEL } from '../home/model';
import { ProviderMark } from '../home/shared';
import { useQuotaFormat } from '../home/useQuotaFormat';
import type { QuotaProviderType } from '../providers/types';
import { ForecastChart, type ChartBand } from './ForecastChart';
import type { PoolForecast, QuotaForecast as Forecast } from './model';
import styles from './QuotaForecast.module.scss';

const NS = 'quota_management.forecast';

/** Fixed per-provider hue (validated for colour-blind separation in both themes). */
const seriesColor = (provider: QuotaProviderType) => `var(--forecast-${provider})`;

const pct = (value: number) => `${Math.round(value).toLocaleString()}%`;

function PoolFacts({
  pool,
  now,
  showRunway = true,
}: {
  pool: PoolForecast;
  now: number;
  /** The all-providers pool has no single run-out moment; providers show their own. */
  showRunway?: boolean;
}) {
  const { t, countdown, absolute } = useQuotaFormat();
  const empty = showRunway && pool.remaining <= 0.5;
  return (
    <p className={styles.facts}>
      {pool.nextReset && !empty && (
        <span title={absolute(pool.nextReset.t)}>
          {t(`${NS}.next_reset`, {
            gain: pct(pool.nextReset.gain),
            time: countdown(pool.nextReset.t - now),
          })}
        </span>
      )}
      {!showRunway ? null : empty ? (
        <span className={styles.factWarn}>
          {pool.refillAt !== null || pool.nextReset
            ? t(`${NS}.empty_refill`, {
                refill: countdown((pool.refillAt ?? pool.nextReset?.t ?? now) - now),
              })
            : t(`${NS}.empty`)}
        </span>
      ) : pool.runsOutAt !== null ? (
        <span className={styles.factWarn} title={absolute(pool.runsOutAt)}>
          {pool.refillAt !== null
            ? t(`${NS}.runs_out_refill`, {
                time: countdown(pool.runsOutAt - now),
                refill: countdown(pool.refillAt - now),
              })
            : t(`${NS}.runs_out`, { time: countdown(pool.runsOutAt - now) })}
        </span>
      ) : (
        pool.paceBasis !== 'none' && <span>{t(`${NS}.lasts`)}</span>
      )}
    </p>
  );
}

function PaceNote({ pool }: { pool: PoolForecast }) {
  const { t } = useQuotaFormat();
  if (pool.paceBasis === 'none') return null;
  return (
    <span className={styles.pace}>
      {t(`${NS}.pace`, { value: pct(pool.pacePerDay) })}
      <span className={styles.paceBasis}>{t(`${NS}.pace_basis_${pool.paceBasis}`)}</span>
    </span>
  );
}

function Legend({ withTotal = false }: { withTotal?: boolean }) {
  const { t } = useQuotaFormat();
  return (
    <span className={styles.lineLegend}>
      {withTotal && (
        <span>
          <i className={styles.keyTotal} aria-hidden="true" />
          {t(`${NS}.total`)}
        </span>
      )}
      <span>
        <i className={styles.keySolid} aria-hidden="true" />
        {t(`${NS}.legend_recorded`)}
      </span>
      <span>
        <i className={styles.keyDashed} aria-hidden="true" />
        {t(`${NS}.legend_projected`)}
      </span>
    </span>
  );
}

function ProviderCard({
  pool,
  forecast,
  theme,
}: {
  pool: PoolForecast;
  forecast: Forecast;
  theme: ResolvedTheme;
}) {
  const { t } = useQuotaFormat();
  const provider = pool.id as QuotaProviderType;
  const name = PROVIDER_LABEL[provider];
  const bands = useMemo<ChartBand[]>(
    () => [
      {
        id: provider,
        label: name,
        color: seriesColor(provider),
        recorded: pool.recorded,
        projected: pool.projected,
      },
    ],
    [name, pool.projected, pool.recorded, provider]
  );
  return (
    <article className={styles.card} aria-labelledby={`forecast-${provider}`}>
      <header className={styles.cardHead}>
        <ProviderMark provider={provider} theme={theme} size={26} />
        <h3 id={`forecast-${provider}`}>{name}</h3>
        <span className={styles.count}>
          {t('quota_management.home.group_accounts', { count: pool.accountCount })}
        </span>
        <PaceNote pool={pool} />
      </header>
      <p className={styles.figure}>
        <span className={styles.figureValue}>{pct(pool.remaining)}</span>
        <span className={styles.figureOf}>{t(`${NS}.of_capacity`, { value: pct(pool.capacity) })}</span>
      </p>
      <PoolFacts pool={pool} now={forecast.span.now} />
      <ForecastChart
        span={forecast.span}
        capacity={pool.capacity}
        bands={bands}
        recordedResets={pool.recordedResets}
        projectedResets={pool.projectedResets}
        days={pool.days}
        summary={t(`${NS}.chart_summary`, {
          name,
          value: pct(pool.remaining),
          capacity: pct(pool.capacity),
        })}
      />
      <footer className={styles.cardFoot}>
        <Legend />
      </footer>
    </article>
  );
}

export function QuotaForecast({ forecast, theme }: { forecast: Forecast; theme: ResolvedTheme }) {
  const { t, absolute } = useQuotaFormat();
  const { total, providers, span } = forecast;

  const bands = useMemo<ChartBand[]>(
    () =>
      providers.map((pool) => {
        const provider = pool.id as QuotaProviderType;
        return {
          id: provider,
          label: PROVIDER_LABEL[provider],
          color: seriesColor(provider),
          recorded: pool.recorded,
          projected: pool.projected,
        };
      }),
    [providers]
  );
  const totalBand = useMemo<ChartBand>(
    () => ({
      id: 'total',
      label: t(`${NS}.total`),
      color: 'var(--forecast-total)',
      recorded: total.recorded,
      projected: total.projected,
    }),
    [t, total.recorded, total.projected]
  );

  if (providers.length === 0) return null;

  return (
    <section className={styles.forecast} aria-labelledby="quota-forecast-title">
      <header className={styles.head}>
        <h2 id="quota-forecast-title">{t(`${NS}.title`)}</h2>
        <p>
          {total.recordingSince !== null
            ? t(`${NS}.hint_since`, { date: absolute(total.recordingSince) })
            : t(`${NS}.hint_new`)}
        </p>
      </header>

      <article className={`${styles.card} ${styles.totalCard}`} aria-labelledby="forecast-all">
        <div className={styles.totalSide}>
          <header className={styles.cardHead}>
            <h3 id="forecast-all">{t(`${NS}.all_providers`)}</h3>
            <span className={styles.count}>
              {t('quota_management.home.group_accounts', { count: total.accountCount })}
            </span>
          </header>
          <p className={styles.figure}>
            <span className={styles.figureValue}>{pct(total.remaining)}</span>
            <span className={styles.figureOf}>
              {t(`${NS}.of_capacity`, { value: pct(total.capacity) })}
            </span>
          </p>
          <PaceNote pool={total} />
          <ul className={styles.providerKey}>
            {providers.map((pool) => {
              const provider = pool.id as QuotaProviderType;
              return (
                <li key={provider}>
                  <i style={{ background: seriesColor(provider) }} aria-hidden="true" />
                  <span>{PROVIDER_LABEL[provider]}</span>
                  <b>{pct(pool.remaining)}</b>
                  <span className={styles.providerKeyOf}>/ {pct(pool.capacity)}</span>
                </li>
              );
            })}
          </ul>
          <PoolFacts pool={total} now={span.now} showRunway={false} />
        </div>
        <div className={styles.totalChart}>
          <ForecastChart
            span={span}
            capacity={total.capacity}
            bands={bands}
            total={totalBand}
            days={total.days}
            height={250}
            summary={t(`${NS}.chart_summary`, {
              name: t(`${NS}.all_providers`),
              value: pct(total.remaining),
              capacity: pct(total.capacity),
            })}
          />
          <footer className={styles.cardFoot}>
            <Legend withTotal />
          </footer>
        </div>
      </article>

      <div className={styles.grid}>
        {providers.map((pool) => (
          <ProviderCard key={pool.id} pool={pool} forecast={forecast} theme={theme} />
        ))}
      </div>
    </section>
  );
}
