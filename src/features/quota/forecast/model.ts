/**
 * Usage forecast: pools every account of a provider into one capacity figure
 * (six Claude accounts = 600%), replays the recorded history and projects it
 * forward to each window's reset.
 *
 * Pure: no React, no clock, no storage. `now` is always passed in.
 *
 * Projection model: the pool burns at one pace (percent of a single account per
 * hour). Load spreads evenly over accounts that still have room, which is how
 * the router behaves once one account runs dry. Each account refills to 100% at
 * its reset and then keeps resetting every period.
 */

import { QUOTA_TAB_ORDER } from '../constants';
import { DAY, HOUR, MINUTE, type QuotaAccount } from '../home/model';
import type { QuotaProviderType } from '../providers/types';
import {
  trackedAccounts,
  type ForecastWindow,
  type HistorySeries,
  type QuotaHistory,
} from './history';

export interface ChartPoint {
  t: number;
  v: number;
}

export interface ResetMark {
  t: number;
  /** Percentage points regained across the pool at this instant. */
  gain: number;
}

export type PaceBasis = 'history' | 'window' | 'none';

export type DayKind = 'past' | 'today' | 'future';

export interface DayUsage {
  start: number;
  end: number;
  kind: DayKind;
  /** Recorded use for past days and today so far; projected use for future days. */
  used: number | null;
  /** Projected use for the rest of today. */
  restOfDay: number | null;
  /** Pool remaining at the end of the day (recorded or projected). */
  endValue: number | null;
  /** Share of a past day the recording covers, 0..1. */
  coverage: number;
}

export interface PoolForecast {
  id: QuotaProviderType | 'all';
  accountCount: number;
  /** 100% per tracked account. */
  capacity: number;
  remaining: number;
  /** Percent of one account per day. */
  pacePerDay: number;
  paceBasis: PaceBasis;
  recorded: ChartPoint[];
  projected: ChartPoint[];
  recordedResets: ResetMark[];
  projectedResets: ResetMark[];
  days: DayUsage[];
  nextReset: ResetMark | null;
  /** First projected instant the pool is empty, if it happens inside the horizon. */
  runsOutAt: number | null;
  /** Pool refills after running out: the first reset after `runsOutAt`. */
  refillAt: number | null;
  recordingSince: number | null;
}

export interface ForecastSpan {
  from: number;
  now: number;
  to: number;
  /**
   * How far the projection runs. It reaches at least `to`, and past it when the view
   * is shorter than the horizon the run-out and refill readouts need, so a one-day
   * view never claims the pool "won't run out" when it does on day three.
   */
  horizon: number;
}

/** How much time the chart shows around now. */
export type ForecastRange = 'auto' | 'day' | 'week' | 'month';

export const FORECAST_RANGES: readonly ForecastRange[] = ['auto', 'day', 'week', 'month'];

export const isForecastRange = (value: unknown): value is ForecastRange =>
  typeof value === 'string' && (FORECAST_RANGES as readonly string[]).includes(value);

/** What the user chose to look at: which window to pool and how much time to show. */
export interface ForecastView {
  window: ForecastWindow;
  range: ForecastRange;
}

export const DEFAULT_FORECAST_VIEW: ForecastView = { window: 'auto', range: 'auto' };

export interface QuotaForecast {
  view: ForecastView;
  span: ForecastSpan;
  total: PoolForecast;
  providers: PoolForecast[];
}

const PAST_SPAN_MS = 4 * DAY;
const MIN_PAST_SPAN_MS = 12 * HOUR;
const MAX_FUTURE_MS = 7 * DAY;
/**
 * A chosen range is exact: it shows that much time even where nothing was recorded,
 * so the axis means what the button says. Projection stops a week out, as `auto` does,
 * because a constant pace says little beyond one more window.
 */
const RANGE_SPAN_MS: Record<Exclude<ForecastRange, 'auto'>, { past: number; future: number }> = {
  day: { past: DAY, future: DAY },
  week: { past: 7 * DAY, future: 7 * DAY },
  month: { past: 30 * DAY, future: MAX_FUTURE_MS },
};
/** The 24 hours behind `now` set the pace once the recording covers this much of them. */
const HISTORY_PACE_MIN_COVERAGE_MS = 12 * HOUR;
const SIM_STEP_MS = 15 * MINUTE;
/** A sample whose reset instant moved later than this started a new window. */
const ROLLED_THRESHOLD_MS = 30 * MINUTE;
const RESET_MERGE_MS = HOUR;
/** Below this the pool counts as empty. */
const EMPTY_EPSILON = 0.5;

const overlap = (a0: number, a1: number, b0: number, b1: number) =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

/* ---------- 记录的历史 ---------- */

interface PoolSeries {
  series: HistorySeries;
  /** The series stays defined after its last sample while the account is still live. */
  activeUntil: number;
}

const rolled = (a: { r: number }, b: { r: number }) => b.r - a.r > ROLLED_THRESHOLD_MS;

/** Remaining percent at `t`; null outside the recorded range. */
export function seriesValueAt({ series, activeUntil }: PoolSeries, t: number): number | null {
  const points = series.points;
  if (points.length === 0 || t < points[0].t) return null;
  const last = points[points.length - 1];
  if (t >= last.t) return t <= activeUntil ? last.v : null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (rolled(a, b)) {
    return t < clamp(a.r, a.t, b.t) ? a.v : b.v;
  }
  const span = b.t - a.t;
  return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
}

/** Percentage points used between t0 and t1, attributed by time overlap. */
export function seriesUsage(series: HistorySeries, t0: number, t1: number): number {
  let used = 0;
  const points = series.points;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (b.t <= t0 || a.t >= t1) continue;
    if (rolled(a, b)) {
      // Use before the reset is unknown; after it the window started at 100%.
      const resetAt = clamp(a.r, a.t, b.t);
      const after = 100 - b.v;
      if (after > 0 && b.t > resetAt) used += (after * overlap(resetAt, b.t, t0, t1)) / (b.t - resetAt);
      continue;
    }
    const drop = a.v - b.v;
    if (drop > 0 && b.t > a.t) used += (drop * overlap(a.t, b.t, t0, t1)) / (b.t - a.t);
  }
  return used;
}

function poolValueAt(pool: PoolSeries[], t: number): number | null {
  let sum = 0;
  let any = false;
  for (const entry of pool) {
    const value = seriesValueAt(entry, t);
    if (value === null) continue;
    sum += value;
    any = true;
  }
  return any ? sum : null;
}

function recordedPoints(pool: PoolSeries[], from: number, now: number): ChartPoint[] {
  const times = new Set<number>([from, now]);
  const steps = new Set<number>();
  for (const { series } of pool) {
    const points = series.points;
    points.forEach((point, index) => {
      if (point.t > from && point.t < now) times.add(point.t);
      const next = points[index + 1];
      if (next && rolled(point, next)) {
        const at = clamp(point.r, point.t, next.t);
        if (at > from && at < now) steps.add(at);
      }
    });
  }
  steps.forEach((at) => {
    times.add(at - 1);
    times.add(at);
  });
  const out: ChartPoint[] = [];
  Array.from(times)
    .sort((a, b) => a - b)
    .forEach((t) => {
      const v = poolValueAt(pool, t);
      if (v !== null) out.push({ t, v });
    });
  return out;
}

function mergeResets(marks: ResetMark[]): ResetMark[] {
  const sorted = [...marks].sort((a, b) => a.t - b.t);
  const out: ResetMark[] = [];
  for (const mark of sorted) {
    const last = out[out.length - 1];
    if (last && mark.t - last.t <= RESET_MERGE_MS) last.gain += mark.gain;
    else out.push({ ...mark });
  }
  return out.filter((mark) => mark.gain >= 1);
}

function recordedResets(pool: PoolSeries[], from: number, now: number): ResetMark[] {
  const marks: ResetMark[] = [];
  for (const { series } of pool) {
    const points = series.points;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!rolled(a, b)) continue;
      const at = clamp(a.r, a.t, b.t);
      if (at <= from || at > now) continue;
      marks.push({ t: at, gain: Math.max(0, 100 - a.v) });
    }
  }
  return mergeResets(marks);
}

/** [first sample, last observation] of the pool; null when nothing was recorded. */
function observedRange(pool: PoolSeries[]): [number, number] | null {
  let first = Infinity;
  let last = -Infinity;
  for (const { series, activeUntil } of pool) {
    if (series.points.length === 0) continue;
    first = Math.min(first, series.points[0].t);
    last = Math.max(last, activeUntil, series.points[series.points.length - 1].t);
  }
  return Number.isFinite(first) ? [first, last] : null;
}

const poolUsage = (pool: PoolSeries[], t0: number, t1: number) =>
  pool.reduce((sum, { series }) => sum + seriesUsage(series, t0, t1), 0);

/* ---------- 投影 ---------- */

export interface SimAccount {
  v: number;
  r: number;
  periodMs: number;
}

interface Simulation {
  points: (ChartPoint & { used: number })[];
  resets: ResetMark[];
}

/**
 * Burn `ratePerHour` across the accounts from `now` to `to`, refilling each
 * account at its reset. Returned points carry the cumulative use served so far,
 * which can fall short of the pace when every account is empty.
 */
export function simulate(
  accounts: SimAccount[],
  ratePerHour: number,
  now: number,
  to: number
): Simulation {
  const state = accounts.map((account) => {
    let r = account.r;
    let v = account.v;
    if (account.periodMs > 0 && r <= now) {
      // The provider's last reading predates a reset that has already happened.
      while (r <= now) r += account.periodMs;
      v = 100;
    }
    return { v, r, periodMs: account.periodMs };
  });
  const total = () => state.reduce((sum, account) => sum + account.v, 0);
  let used = 0;
  let t = now;
  const points: Simulation['points'] = [{ t, v: total(), used }];
  const resets: ResetMark[] = [];

  let guard = 0;
  while (t < to && guard < 20_000) {
    guard += 1;
    const nextReset = Math.min(
      ...state.map((account) => (account.periodMs > 0 ? account.r : Infinity))
    );
    const next = Math.min(t + SIM_STEP_MS, to, nextReset);
    let demand = Math.max(0, ratePerHour) * ((next - t) / HOUR);

    // Water-fill: spread the demand evenly; an account that can't take its
    // share passes the rest on.
    const open = state.filter((account) => account.v > 0).sort((a, b) => a.v - b.v);
    open.forEach((account, index) => {
      const share = demand / (open.length - index);
      const take = Math.min(account.v, share);
      account.v -= take;
      demand -= take;
      used += take;
    });
    t = next;
    points.push({ t, v: total(), used });

    let gain = 0;
    state.forEach((account) => {
      if (account.periodMs <= 0 || account.r > t) return;
      gain += 100 - account.v;
      account.v = 100;
      while (account.r <= t) account.r += account.periodMs;
    });
    if (gain > 0) {
      resets.push({ t, gain });
      points.push({ t, v: total(), used });
    }
  }

  return { points, resets: mergeResets(resets) };
}

/** Linear between points; two points at one instant draw a vertical step. */
export function valueAt(points: ChartPoint[], t: number): number | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (t >= b.t) return b.v;
  const span = b.t - a.t;
  return span <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / span;
}

/** `points` cut at `to`, ending on the interpolated value there. */
function clipSeries(points: ChartPoint[], to: number): ChartPoint[] {
  const kept = points.filter((point) => point.t <= to);
  const last = kept[kept.length - 1];
  if (last && last.t < to && kept.length < points.length) {
    const value = valueAt(points, to);
    if (value !== null) kept.push({ t: to, v: value });
  }
  return kept;
}

/**
 * Y-axis ticks from 0 to at least `max`: the smallest 1/2/2.5/5 step that needs
 * no more than `maxIntervals` gridlines, with the top rounded up to a step.
 */
export function axisTicks(max: number, maxIntervals = 6): number[] {
  const target = Math.max(max, 1);
  for (let magnitude = 1; ; magnitude *= 10) {
    for (const factor of [1, 2, 2.5, 5]) {
      const step = factor * magnitude;
      const intervals = Math.ceil(target / step - 1e-9);
      if (intervals <= maxIntervals) {
        return Array.from({ length: intervals + 1 }, (_, i) => i * step);
      }
    }
  }
}

/* ---------- 汇总 ---------- */

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const addLocalDays = (dayStart: number, days: number) => {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + days);
  return d.getTime();
};

/** Local day boundaries covering [from, to]. */
export function dayBounds(from: number, to: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let start = startOfLocalDay(from); start < to; start = addLocalDays(start, 1)) {
    out.push({ start, end: addLocalDays(start, 1) });
  }
  return out;
}

/** The view `auto` picks: recorded history up to four days back, through the latest reset. */
function autoSpan(
  tracked: ReturnType<typeof trackedAccounts>,
  history: QuotaHistory,
  now: number
): Pick<ForecastSpan, 'from' | 'to'> {
  const keys = new Set(tracked.map((entry) => entry.key));
  let firstSample = Infinity;
  Object.entries(history).forEach(([key, series]) => {
    if (keys.has(key) && series.points.length > 0) {
      firstSample = Math.min(firstSample, series.points[0].t);
    }
  });
  const from = clamp(firstSample, now - PAST_SPAN_MS, now - MIN_PAST_SPAN_MS);
  // Cover the day after tomorrow and reach the latest window end, up to a week out.
  const minTo = addLocalDays(startOfLocalDay(now), 3);
  const latestReset = Math.max(now, ...tracked.map((entry) => entry.limit.resetsAt));
  const to = Math.min(Math.max(latestReset, minTo), now + MAX_FUTURE_MS);
  return { from, to };
}

export function forecastSpan(
  accounts: QuotaAccount[],
  history: QuotaHistory,
  now: number,
  { window, range }: ForecastView = DEFAULT_FORECAST_VIEW
): ForecastSpan {
  const auto = autoSpan(trackedAccounts(accounts, window), history, now);
  if (range === 'auto') return { ...auto, now, horizon: auto.to };
  const { past, future } = RANGE_SPAN_MS[range];
  const to = now + future;
  return { from: now - past, now, to, horizon: Math.max(to, auto.to) };
}

function poolForecast(
  id: PoolForecast['id'],
  accounts: QuotaAccount[],
  history: QuotaHistory,
  span: ForecastSpan,
  window: ForecastWindow
): PoolForecast {
  const { from, now, to } = span;
  const tracked = trackedAccounts(accounts, window);
  const liveKeys = new Set(tracked.map((entry) => entry.key));

  // Only the accounts in today's pool. A removed, renamed or disabled account's
  // series would stack on top of `capacity`, so the pool could read above 100%
  // per account (and a renamed file would count its own history twice).
  const pool: PoolSeries[] = Object.entries(history)
    .filter(([key]) => liveKeys.has(key))
    .map(([, series]) => ({ series, activeUntil: now }));

  const simAccounts: SimAccount[] = tracked.map((entry) => ({
    v: entry.limit.remainingPct,
    r: entry.limit.resetsAt,
    periodMs: entry.periodHours * HOUR,
  }));
  const remaining = simAccounts.reduce((sum, account) => sum + account.v, 0);

  const observed = observedRange(pool);
  const paceWindow: [number, number] = [now - DAY, now];
  const covered = observed ? overlap(observed[0], observed[1], ...paceWindow) : 0;
  let ratePerHour = 0;
  let paceBasis: PaceBasis = 'none';
  if (covered >= HISTORY_PACE_MIN_COVERAGE_MS) {
    ratePerHour = poolUsage(pool, ...paceWindow) / (covered / HOUR);
    paceBasis = 'history';
  } else if (tracked.length > 0) {
    ratePerHour = tracked.reduce((sum, entry) => {
      const windowStart = entry.limit.resetsAt - entry.periodHours * HOUR;
      const elapsed = Math.max(HOUR, now - windowStart);
      return sum + (100 - entry.limit.remainingPct) / (elapsed / HOUR);
    }, 0);
    paceBasis = 'window';
  }

  const sim = simulate(simAccounts, ratePerHour, now, span.horizon);
  const projected = clipSeries(
    sim.points.map(({ t, v }) => ({ t, v })),
    to
  );
  const usedSeries = sim.points.map(({ t, used }) => ({ t, v: used }));
  const usedAt = (t: number) => valueAt(usedSeries, t);
  const recorded = recordedPoints(pool, from, now);

  const days: DayUsage[] = dayBounds(from, to).map(({ start, end }) => {
    if (end <= now) {
      const coverage = observed ? overlap(observed[0], observed[1], start, end) / (end - start) : 0;
      const usable = coverage >= 0.05;
      return {
        start,
        end,
        kind: 'past',
        used: usable ? poolUsage(pool, start, end) : null,
        restOfDay: null,
        endValue: usable ? poolValueAt(pool, end - 1) : null,
        coverage,
      };
    }
    if (start <= now) {
      const coverage = observed ? overlap(observed[0], observed[1], start, now) / (now - start || 1) : 0;
      const usedNow = usedAt(now) ?? 0;
      const usedEnd = usedAt(Math.min(end, to)) ?? usedNow;
      return {
        start,
        end,
        kind: 'today',
        used: coverage >= 0.05 ? poolUsage(pool, start, now) : null,
        restOfDay: usedEnd - usedNow,
        endValue: valueAt(projected, Math.min(end, to)),
        coverage,
      };
    }
    const dayEnd = Math.min(end, to);
    const usedStart = usedAt(start);
    const usedEnd = usedAt(dayEnd);
    return {
      start,
      end,
      kind: 'future',
      used: usedStart !== null && usedEnd !== null ? usedEnd - usedStart : null,
      restOfDay: null,
      endValue: valueAt(projected, dayEnd),
      coverage: 1,
    };
  });

  const emptyPoint =
    remaining > EMPTY_EPSILON ? sim.points.find((point) => point.v <= EMPTY_EPSILON) : undefined;
  const runsOutAt = emptyPoint ? emptyPoint.t : null;
  const refill = runsOutAt === null ? null : sim.resets.find((mark) => mark.t >= runsOutAt);

  return {
    id,
    accountCount: tracked.length,
    capacity: tracked.length * 100,
    remaining,
    pacePerDay: ratePerHour * 24,
    paceBasis,
    recorded,
    projected,
    recordedResets: recordedResets(pool, from, now),
    projectedResets: sim.resets,
    days,
    nextReset: sim.resets[0] ?? null,
    runsOutAt,
    refillAt: refill?.t ?? null,
    recordingSince: observed ? observed[0] : null,
  };
}

/**
 * Pointwise sum of piecewise-linear series. A series contributes nothing
 * outside its own range; a vertical step in any series stays a step in the sum.
 */
export function sumSeries(seriesList: ChartPoint[][]): ChartPoint[] {
  const times = new Set<number>();
  for (const points of seriesList) {
    points.forEach((point, index) => {
      times.add(point.t);
      if (index > 0 && points[index - 1].t === point.t) times.add(point.t - 1);
    });
  }
  const out: ChartPoint[] = [];
  Array.from(times)
    .sort((a, b) => a - b)
    .forEach((t) => {
      let sum = 0;
      let any = false;
      for (const points of seriesList) {
        const value = valueAt(points, t);
        if (value === null) continue;
        sum += value;
        any = true;
      }
      if (any) out.push({ t, v: sum });
    });
  return out;
}

/** Sum provider pools on a shared clock. */
function totalForecast(providers: PoolForecast[], span: ForecastSpan): PoolForecast {
  const sumOrNull = (values: (number | null)[]) =>
    values.some((value) => value !== null)
      ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null;
  const bases = new Set(providers.map((pool) => pool.paceBasis));
  const days = providers[0]?.days.map((day, index) => ({
    ...day,
    used: sumOrNull(providers.map((pool) => pool.days[index]?.used ?? null)),
    restOfDay: sumOrNull(providers.map((pool) => pool.days[index]?.restOfDay ?? null)),
    endValue: sumOrNull(providers.map((pool) => pool.days[index]?.endValue ?? null)),
    coverage: Math.min(...providers.map((pool) => pool.days[index]?.coverage ?? 0)),
  }));
  const resets = mergeResets(providers.flatMap((pool) => pool.projectedResets));
  const since = providers
    .map((pool) => pool.recordingSince)
    .filter((value): value is number => value !== null);
  return {
    id: 'all',
    accountCount: providers.reduce((sum, pool) => sum + pool.accountCount, 0),
    capacity: providers.reduce((sum, pool) => sum + pool.capacity, 0),
    remaining: providers.reduce((sum, pool) => sum + pool.remaining, 0),
    pacePerDay: providers.reduce((sum, pool) => sum + pool.pacePerDay, 0),
    paceBasis: bases.has('window') ? 'window' : bases.has('history') ? 'history' : 'none',
    recorded: sumSeries(providers.map((pool) => pool.recorded)),
    projected: sumSeries(providers.map((pool) => pool.projected)),
    recordedResets: mergeResets(providers.flatMap((pool) => pool.recordedResets)),
    projectedResets: resets,
    days: days ?? dayBounds(span.from, span.to).map(({ start, end }) => ({
      start,
      end,
      kind: end <= span.now ? 'past' : start <= span.now ? 'today' : 'future',
      used: null,
      restOfDay: null,
      endValue: null,
      coverage: 0,
    })),
    nextReset: resets[0] ?? null,
    runsOutAt: null,
    refillAt: null,
    recordingSince: since.length > 0 ? Math.min(...since) : null,
  };
}

export function buildForecast(
  accounts: QuotaAccount[],
  history: QuotaHistory,
  now: number,
  view: ForecastView = DEFAULT_FORECAST_VIEW
): QuotaForecast {
  const span = forecastSpan(accounts, history, now, view);
  const providers = QUOTA_TAB_ORDER.map((provider) =>
    accounts.filter((account) => account.provider === provider)
  )
    .filter((group) => trackedAccounts(group, view.window).length > 0)
    .map((group) => poolForecast(group[0].provider, group, history, span, view.window));
  return { view, span, total: totalForecast(providers, span), providers };
}
