/**
 * Pool capacity over time: recorded history (solid) up to now, projection
 * (dashed) to the horizon, reset jumps labelled, and a day strip aligned to the
 * time axis that reads out each day's use.
 *
 * One band draws a line with a soft area; several bands stack (the all-providers
 * chart). Hover or arrow keys move a crosshair that reads values at that instant.
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
  recordedResets?: ResetMark[];
  projectedResets?: ResetMark[];
  days: DayUsage[];
  /** Accessible summary of the whole chart. */
  summary: string;
  height?: number;
}

const MARGIN = { top: 30, right: 14, bottom: 8, left: 50 };
const STACK_SAMPLES = 220;
const LABEL_MIN_GAP = 46;
/** Refills smaller than this (a five-hour window topping up) stay unlabelled. */
const LABEL_MIN_GAIN = 5;
/** Below this width a day column can't hold its figures. */
const MIN_DAY_PX = 56;

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
  const stacked = bands.length > 1;

  const yMax = useMemo(() => {
    let max = capacity;
    if (stacked) return Math.max(max, 1);
    bands.forEach((band) => {
      band.recorded.forEach((point) => (max = Math.max(max, point.v)));
      band.projected.forEach((point) => (max = Math.max(max, point.v)));
    });
    return Math.max(max, 1);
  }, [bands, capacity, stacked]);

  const x = (time: number) => MARGIN.left + ((time - span.from) / (span.to - span.from)) * plotW;
  const y = (value: number) => MARGIN.top + plotH - (Math.max(0, value) / yMax) * plotH;
  const timeAt = (px: number) =>
    span.from + ((px - MARGIN.left) / plotW) * (span.to - span.from);
  const nowX = x(span.now);

  /* ---------- 几何 ---------- */

  const geometry = useMemo(() => {
    if (!stacked) {
      return bands.map((band) => {
        const recorded = band.recorded.map((p) => [x(p.t), y(p.v)] as [number, number]);
        const projected = band.projected.map((p) => [x(p.t), y(p.v)] as [number, number]);
        const base = (pts: [number, number][]): [number, number][] =>
          pts.length ? [[pts[0][0], y(0)], [pts[pts.length - 1][0], y(0)]] : [];
        return {
          band,
          recordedLine: linePath(recorded),
          projectedLine: linePath(projected),
          recordedArea: areaPath(recorded, base(recorded)),
          projectedArea: areaPath(projected, base(projected)),
        };
      });
    }
    // Stack on a shared grid; a band with no reading at an instant adds nothing.
    const sample = (from: number, to: number) => {
      const n = Math.max(2, Math.round((STACK_SAMPLES * (to - from)) / (span.to - span.from)));
      return Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
    };
    const pastTimes = sample(span.from, span.now);
    const futureTimes = sample(span.now, span.to);
    const below = { past: pastTimes.map(() => 0), future: futureTimes.map(() => 0) };
    return bands.map((band) => {
      const pastLower = below.past.slice();
      const futureLower = below.future.slice();
      pastTimes.forEach((time, i) => (below.past[i] += valueAt(band.recorded, time) ?? 0));
      futureTimes.forEach((time, i) => (below.future[i] += valueAt(band.projected, time) ?? 0));
      const pastTop = pastTimes.map((time, i) => [x(time), y(below.past[i])] as [number, number]);
      const pastBottom = pastTimes.map((time, i) => [x(time), y(pastLower[i])] as [number, number]);
      const futureTop = futureTimes.map((time, i) => [x(time), y(below.future[i])] as [number, number]);
      const futureBottom = futureTimes.map(
        (time, i) => [x(time), y(futureLower[i])] as [number, number]
      );
      return {
        band,
        recordedLine: linePath(pastTop),
        projectedLine: linePath(futureTop),
        recordedArea: areaPath(pastTop, pastBottom),
        projectedArea: areaPath(futureTop, futureBottom),
      };
    });
    // x / y derive from span, width and yMax, all listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bands, stacked, span, plotW, plotH, yMax]);

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
    if (stacked || bands.length === 0) return [];
    const band = bands[0];
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
  }, [bands, recordedResets, projectedResets, stacked, span, plotW, plotH, yMax]);

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

  const readings =
    cursor === null
      ? []
      : bands.map((band) => {
          const source = cursor <= span.now ? band.recorded : band.projected;
          return { band, value: valueAt(source, cursor) };
        });
  const readingTotal = readings.reduce((sum, r) => sum + (r.value ?? 0), 0);
  const anyReading = readings.some((r) => r.value !== null);
  const cursorX = cursor === null ? 0 : x(cursor);
  const tooltipLeft = cursorX > width * 0.62;

  const nowValue = bands.reduce((sum, band) => sum + (valueAt(band.projected, span.now) ?? 0), 0);
  const ticks = [0, yMax / 2, yMax];
  const single = !stacked ? bands[0] : null;

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

        {/* 网格：容量顶线、半程、零线；每天零点一条细竖线 */}
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

        {geometry.map(({ band, recordedArea, projectedArea }) => (
          <g key={`area-${band.id}`}>
            <path
              d={recordedArea}
              fill={single ? `url(#${gradientId}-rec)` : band.color}
              fillOpacity={single ? 1 : 0.78}
            />
            <path
              d={projectedArea}
              fill={single ? `url(#${gradientId}-proj)` : band.color}
              fillOpacity={single ? 1 : 0.26}
            />
          </g>
        ))}
        {geometry.map(({ band, recordedLine, projectedLine }) => (
          <g key={`line-${band.id}`}>
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
        <circle
          className={styles.nowDot}
          cx={nowX}
          cy={y(nowValue)}
          r={5}
          fill={single ? single.color : 'var(--text-primary)'}
        />

        {cursor !== null && (
          <g className={styles.cursor}>
            <line x1={cursorX} x2={cursorX} y1={MARGIN.top} y2={MARGIN.top + plotH} />
            {single && readings[0]?.value !== null && readings[0]?.value !== undefined && (
              <circle
                cx={cursorX}
                cy={y(readings[0].value)}
                r={4.5}
                fill={single.color}
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
                  {stacked && <span>{band.label}</span>}
                  <b>{value === null ? '—' : pct(value)}</b>
                </div>
              ))}
              {stacked && (
                <div className={`${styles.tooltipRow} ${styles.tooltipTotal}`}>
                  <span>{t(`${NS}.total`)}</span>
                  <b>{pct(readingTotal)}</b>
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
        dayPx={(plotW * DAY) / (span.to - span.from)}
      />
    </div>
  );
}

/* ---------- 日带：每天用了多少，过去为记录，将来为预测 ---------- */

function DayStrip({
  cells,
  color,
  plotLeft,
  dayPx,
}: {
  cells: { start: number; end: number; x0: number; x1: number; usage: DayUsage | undefined }[];
  color: string;
  plotLeft: number;
  /** Width of one whole day on the axis. */
  dayPx: number;
}) {
  const { t, i18n } = useTranslation();
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { weekday: 'short', day: 'numeric' }),
    [i18n.language]
  );

  // Too narrow to align with the axis: show yesterday through the day after
  // tomorrow as equal columns instead.
  const compact = dayPx < MIN_DAY_PX;
  const todayIndex = cells.findIndex((cell) => cell.usage?.kind === 'today');
  const shown = compact
    ? cells.slice(Math.max(0, todayIndex - 1), todayIndex + 3)
    : cells.filter((cell) => cell.x1 - cell.x0 >= 48);

  return (
    <ol
      className={`${styles.days} ${compact ? styles.daysCompact : ''}`}
      style={{ marginLeft: plotLeft }}
    >
      {shown.map((cell) => {
        const usage = cell.usage;
        const widthPx = cell.x1 - cell.x0;
        if (!usage) return null;
        const roomy = compact || widthPx >= 68;
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
        return (
          <li
            key={cell.start}
            className={`${styles.day} ${styles[`day_${usage.kind}`]}`}
            style={
              compact
                ? { ['--series' as string]: color }
                : { left: cell.x0 - plotLeft, width: widthPx, ['--series' as string]: color }
            }
            aria-label={aria}
          >
            <span className={styles.dayName}>
              {usage.kind === 'today' && roomy ? t(`${NS}.day_today`) : dayLabel}
            </span>
            <span className={styles.dayUsed}>{usedText}</span>
            {roomy && detail && <span className={styles.dayDetail}>{detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}
