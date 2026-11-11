/**
 * Pool capacity over time: recorded history (solid) up to now, projection
 * (dashed) to the horizon, reset jumps labelled, and a day strip aligned to the
 * time axis that reads out each day's use.
 *
 * One band draws a line with a soft area. Several bands (the all-providers chart)
 * overlap, each measured from the real zero, with an optional total line above
 * them. Hover or arrow keys move a crosshair that reads values at that instant.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DAY, HOUR } from '../home/model';
import { useQuotaFormat } from '../home/useQuotaFormat';
import {
  axisTicks,
  dayBounds,
  valueAt,
  type ChartPoint,
  type DayUsage,
  type ForecastSpan,
  type ResetMark,
} from './model';
import styles from './QuotaForecast.module.scss';

const NS = 'quota_management.forecast';

export interface ChartBand {
  id: string;
  label: string;
  color: string;
  recorded: ChartPoint[];
  projected: ChartPoint[];
}

interface ForecastChartProps {
  span: ForecastSpan;
  capacity: number;
  bands: ChartBand[];
  /** Sum of every band, drawn as a neutral line over them. */
  total?: ChartBand;
  recordedResets?: ResetMark[];
  projectedResets?: ResetMark[];
  days: DayUsage[];
  /** Accessible summary of the whole chart. */
  summary: string;
  height?: number;
}

const MARGIN = { top: 30, right: 14, bottom: 8, left: 50 };
const LABEL_MIN_GAP = 46;
/** Refills smaller than this (a five-hour window topping up) stay unlabelled. */
const LABEL_MIN_GAIN = 5;
/** Day columns narrower than these drop their detail line, figure, or name. */
const DAY_FULL_PX = 68;
const DAY_FIGURE_PX = 40;
const DAY_NAME_PX = 20;

const pct = (value: number) => `${Math.round(value).toLocaleString()}%`;

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const linePath = (points: [number, number][]) =>
  points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

const areaPath = (top: [number, number][], bottom: [number, number][]) =>
  top.length === 0
    ? ''
    : `${linePath(top)}${bottom
        .slice()
        .reverse()
        .map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`)
        .join('')}Z`;

export function ForecastChart({
  span,
  capacity,
  bands,
  total,
  recordedResets = [],
  projectedResets = [],
  days,
  summary,
  height = 210,
}: ForecastChartProps) {
  const { t } = useTranslation();
  const { absolute } = useQuotaFormat();
  const [wrapRef, width] = useWidth<HTMLDivElement>(560);
  const gradientId = useId();
  const [cursor, setCursor] = useState<number | null>(null);

  const plotW = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const single = bands.length === 1 ? bands[0] : null;
  const lineBands = useMemo(() => (total ? [...bands, total] : bands), [bands, total]);

  const ticks = useMemo(() => {
    let max = capacity;
    lineBands.forEach((band) => {
      band.recorded.forEach((point) => (max = Math.max(max, point.v)));
      band.projected.forEach((point) => (max = Math.max(max, point.v)));
    });
    return axisTicks(max);
  }, [lineBands, capacity]);
  const yMax = ticks[ticks.length - 1];

  const x = (time: number) => MARGIN.left + ((time - span.from) / (span.to - span.from)) * plotW;
  const y = (value: number) => MARGIN.top + plotH - (Math.max(0, value) / yMax) * plotH;
  const timeAt = (px: number) =>
    span.from + ((px - MARGIN.left) / plotW) * (span.to - span.from);
  const nowX = x(span.now);

  /* ---------- 几何：每条线都从真实的零点量起 ---------- */

  const geometry = useMemo(
    () =>
      lineBands.map((band) => {
        const recorded = band.recorded.map((p) => [x(p.t), y(p.v)] as [number, number]);
        const projected = band.projected.map((p) => [x(p.t), y(p.v)] as [number, number]);
        const base = (pts: [number, number][]): [number, number][] =>
          pts.length ? [[pts[0][0], y(0)], [pts[pts.length - 1][0], y(0)]] : [];
        return {
          band,
          isTotal: band === total,
          recordedLine: linePath(recorded),
          projectedLine: linePath(projected),
          recordedArea: areaPath(recorded, base(recorded)),
          projectedArea: areaPath(projected, base(projected)),
        };
      }),
    // x / y derive from span, width and yMax, all listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lineBands, total, span, plotW, plotH, yMax]
  );

  const dayCells = useMemo(
    () =>
      dayBounds(span.from, span.to).map((bounds, index) => {
        const start = Math.max(bounds.start, span.from);
        const end = Math.min(bounds.end, span.to);
        return { ...bounds, x0: x(start), x1: x(end), usage: days[index] };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [span, days, plotW]
  );

  /* ---------- 重置标注（避免互相压住） ---------- */

  const resetLabels = useMemo(() => {
    if (!single) return [];
    const band = single;
    const marks = [
      ...recordedResets.map((mark) => ({ ...mark, points: band.recorded })),
      ...projectedResets.map((mark) => ({ ...mark, points: band.projected })),
    ].filter((mark) => mark.gain >= LABEL_MIN_GAIN && mark.t >= span.from && mark.t <= span.to);
    const placed: { x: number; y: number; text: string }[] = [];
    marks
      .sort((a, b) => a.t - b.t)
      .forEach((mark) => {
        const px = x(mark.t);
        if (placed.some((label) => Math.abs(label.x - px) < LABEL_MIN_GAP)) return;
        const top = valueAt(mark.points, mark.t + 1) ?? valueAt(mark.points, mark.t) ?? 0;
        placed.push({ x: px, y: Math.max(MARGIN.top - 6, y(top) - 9), text: `+${pct(mark.gain)}` });
      });
    return placed.filter((label) => Math.abs(label.x - nowX) > 18);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single, recordedResets, projectedResets, span, plotW, plotH, yMax]);

  /* ---------- 悬停 / 键盘 ---------- */

  const handlePointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    if (px < MARGIN.left || px > MARGIN.left + plotW) {
      setCursor(null);
      return;
    }
    setCursor(timeAt(px));
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const stepMs = event.shiftKey ? DAY : HOUR;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const base = cursor ?? span.now;
      const next = base + (event.key === 'ArrowRight' ? stepMs : -stepMs);
      setCursor(Math.min(span.to, Math.max(span.from, next)));
    } else if (event.key === 'Escape') {
      setCursor(null);
    }
  };

  const readAt = (band: ChartBand, time: number) =>
    valueAt(time <= span.now ? band.recorded : band.projected, time);
  const readings = cursor === null ? [] : bands.map((band) => ({ band, value: readAt(band, cursor) }));
  const readingTotal = cursor !== null && total ? readAt(total, cursor) : null;
  const anyReading = readings.some((r) => r.value !== null);
  const cursorX = cursor === null ? 0 : x(cursor);
  const tooltipLeft = cursorX > width * 0.62;

  // The marker sits on the line it describes: the band itself, or the total.
  const markerBand = single ?? total ?? null;
  const nowValue = markerBand ? valueAt(markerBand.projected, span.now) : null;

  return (
    <div
      ref={wrapRef}
      className={styles.chart}
      tabIndex={0}
      role="group"
      aria-label={summary}
      aria-roledescription={t(`${NS}.chart_role`)}
      onKeyDown={handleKey}
      onBlur={() => setCursor(null)}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
        aria-hidden="true"
        onPointerMove={handlePointer}
        onPointerLeave={() => setCursor(null)}
      >
        {single && (
          <defs>
            <linearGradient id={`${gradientId}-rec`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={single.color} stopOpacity={0.26} />
              <stop offset="100%" stopColor={single.color} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id={`${gradientId}-proj`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={single.color} stopOpacity={0.1} />
              <stop offset="100%" stopColor={single.color} stopOpacity={0} />
            </linearGradient>
          </defs>
        )}

        {/* 网格：按刻度的横线与零线；每天零点一条细竖线 */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? styles.baseline : styles.gridline}
              x1={MARGIN.left}
              x2={MARGIN.left + plotW}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className={styles.tickLabel} x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end">
              {pct(tick)}
            </text>
          </g>
        ))}
        {dayCells.slice(1).map((cell) => (
          <line
            key={cell.start}
            className={styles.dayline}
            x1={x(cell.start)}
            x2={x(cell.start)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotH}
          />
        ))}

        {geometry.map(({ band, isTotal, recordedArea, projectedArea }) =>
          isTotal ? null : (
            <g key={`area-${band.id}`}>
              <path
                d={recordedArea}
                fill={single ? `url(#${gradientId}-rec)` : band.color}
                fillOpacity={single ? 1 : 0.12}
              />
              <path
                d={projectedArea}
                fill={single ? `url(#${gradientId}-proj)` : band.color}
                fillOpacity={single ? 1 : 0.05}
              />
            </g>
          )
        )}
        {geometry.map(({ band, isTotal, recordedLine, projectedLine }) => (
          <g key={`line-${band.id}`} className={isTotal ? styles.totalLine : undefined}>
            <path d={recordedLine} className={styles.recordedLine} stroke={band.color} />
            <path d={projectedLine} className={styles.projectedLine} stroke={band.color} />
          </g>
        ))}

        {resetLabels.map((label) => (
          <text key={label.x} className={styles.resetLabel} x={label.x} y={label.y} textAnchor="middle">
            {label.text}
          </text>
        ))}

        <line className={styles.nowLine} x1={nowX} x2={nowX} y1={MARGIN.top - 12} y2={height} />
        <text className={styles.nowLabel} x={nowX} y={MARGIN.top - 17} textAnchor="middle">
          {t('quota_management.home.axis_now')}
        </text>
        {markerBand && nowValue !== null && (
          <circle
            className={styles.nowDot}
            cx={nowX}
            cy={y(nowValue)}
            r={5}
            fill={markerBand.color}
          />
        )}

        {cursor !== null && (
          <g className={styles.cursor}>
            <line x1={cursorX} x2={cursorX} y1={MARGIN.top} y2={MARGIN.top + plotH} />
            {readings.map(({ band, value }) =>
              value === null ? null : (
                <circle
                  key={band.id}
                  cx={cursorX}
                  cy={y(value)}
                  r={single ? 4.5 : 3.5}
                  fill={band.color}
                  className={styles.nowDot}
                />
              )
            )}
            {total && readingTotal !== null && (
              <circle
                cx={cursorX}
                cy={y(readingTotal)}
                r={4.5}
                fill={total.color}
                className={styles.nowDot}
              />
            )}
          </g>
        )}
      </svg>

      {cursor !== null && (
        <div
          className={styles.tooltip}
          style={{
            left: tooltipLeft ? undefined : cursorX + 12,
            right: tooltipLeft ? width - cursorX + 12 : undefined,
            top: MARGIN.top,
          }}
          role="status"
        >
          <div className={styles.tooltipTime}>
            {absolute(cursor)}
            <span>
              {cursor <= span.now ? t(`${NS}.legend_recorded`) : t(`${NS}.legend_projected`)}
            </span>
          </div>
          {!anyReading ? (
            <div className={styles.tooltipEmpty}>{t(`${NS}.not_recorded`)}</div>
          ) : (
            <>
              {readings.map(({ band, value }) => (
                <div key={band.id} className={styles.tooltipRow}>
                  <i style={{ background: band.color }} aria-hidden="true" />
                  {!single && <span>{band.label}</span>}
                  <b>{value === null ? '—' : pct(value)}</b>
                </div>
              ))}
              {total && (
                <div className={`${styles.tooltipRow} ${styles.tooltipTotal}`}>
                  <span>{t(`${NS}.total`)}</span>
                  <b>{readingTotal === null ? '—' : pct(readingTotal)}</b>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <DayStrip
        cells={dayCells}
        color={single?.color ?? 'var(--text-secondary)'}
        plotLeft={MARGIN.left}
      />
    </div>
  );
}

/* ---------- 日带：每天用了多少，过去为记录，将来为预测 ---------- */

function DayStrip({
  cells,
  color,
  plotLeft,
}: {
  cells: { start: number; end: number; x0: number; x1: number; usage: DayUsage | undefined }[];
  color: string;
  plotLeft: number;
}) {
  const { t, i18n } = useTranslation();
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric' }),
    [i18n.language]
  );
  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { day: 'numeric' }),
    [i18n.language]
  );

  // Every column sits exactly under its day on the time axis. A narrow column
  // sheds its detail, then its figure, then its name, but never its position.
  return (
    <ol className={styles.days} style={{ marginLeft: plotLeft }}>
      {cells.map((cell) => {
        const usage = cell.usage;
        const widthPx = cell.x1 - cell.x0;
        if (!usage || widthPx <= 0) return null;
        const full = widthPx >= DAY_FULL_PX;
        const showFigure = widthPx >= DAY_FIGURE_PX;
        const showName = widthPx >= DAY_NAME_PX;
        const projected = usage.kind === 'future';
        const used = usage.used;
        const dayLabel = dayFormat.format(cell.start);
        const usedText = used === null ? '—' : `−${pct(used)}`;
        const leftText = usage.endValue === null ? null : t(`${NS}.day_left`, { value: pct(usage.endValue) });
        let detail: string | null;
        if (usage.kind === 'today' && usage.restOfDay !== null) {
          detail = t(`${NS}.day_more`, { value: pct(usage.restOfDay) });
        } else if (usage.kind === 'past' && used !== null && usage.coverage < 0.9) {
          detail = t(`${NS}.day_partial`);
        } else {
          detail = leftText;
        }
        const aria = [
          dayLabel,
          usage.kind === 'today' ? t(`${NS}.day_today`) : null,
          used === null
            ? t(`${NS}.not_recorded`)
            : t(projected ? `${NS}.day_aria_projected` : `${NS}.day_aria_used`, {
                value: pct(used),
              }),
          detail,
        ]
          .filter(Boolean)
          .join(', ');
        const name = full
          ? usage.kind === 'today'
            ? t(`${NS}.day_today`)
            : dayLabel
          : dateFormat.format(cell.start);
        return (
          <li
            key={cell.start}
            className={`${styles.day} ${styles[`day_${usage.kind}`]}`}
            style={{ left: cell.x0 - plotLeft, width: widthPx, ['--series' as string]: color }}
            aria-label={aria}
            title={aria}
          >
            {showName && <span className={styles.dayName}>{name}</span>}
            {showFigure && <span className={styles.dayUsed}>{usedText}</span>}
            {full && detail && <span className={styles.dayDetail}>{detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}
