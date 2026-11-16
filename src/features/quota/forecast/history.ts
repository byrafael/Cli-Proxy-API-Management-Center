/**
 * Recorded quota history: one series per account window. The proxy samples every
 * Claude and Codex login on a schedule and serves its history from
 * `/quota/history`; the browser also records what it sees and keeps that in
 * localStorage. The page shows the merge of both, so a fresh device or a cleared
 * browser still gets the proxy's 30 days, and providers the proxy does not sample
 * still chart while the page is open.
 *
 * Pure apart from `loadHistory` / `saveHistory`; the forecast model and tests
 * consume the parsed shape directly.
 */

import { QUOTA_TAB_ORDER } from '../constants';
import type { QuotaProviderType } from '../providers/types';
import { HOUR, MINUTE, DAY, type QuotaAccount, type QuotaLimit } from '../home/model';

export interface HistoryPoint {
  /** Sample instant, epoch ms. */
  t: number;
  /** Remaining percent of the window, 0..100. */
  v: number;
  /** Reset instant the provider reported with this sample, epoch ms. */
  r: number;
}

export interface HistorySeries {
  provider: QuotaProviderType;
  /** Window length in hours, used to roll the window forward in projections. */
  periodHours: number;
  points: HistoryPoint[];
}

/** Keyed by `${accountId}#${window}`. */
export type QuotaHistory = Record<string, HistorySeries>;

/** A month of samples, enough for a monthly view. */
export const HISTORY_RETENTION_MS = 30 * DAY;
/** An unchanged value is still recorded this often, so coverage stays measurable. */
const HEARTBEAT_MS = HOUR;
/** A reset instant that moved later than this marks a new window, as in the forecast model. */
const ROLLED_MS = 30 * MINUTE;

const STORAGE_KEY = 'quotaForecast.history.v1';
const PROVIDERS = new Set<string>(QUOTA_TAB_ORDER);

/** A quota window an account can report. Keys in the history end with one of these. */
export type QuotaWindowId = 'weekly' | 'session' | 'fable';

export const QUOTA_WINDOW_IDS: readonly QuotaWindowId[] = ['session', 'weekly', 'fable'];

/** Which window the forecast pools: one named window, or each account's primary one. */
export type ForecastWindow = 'auto' | QuotaWindowId;

export const FORECAST_WINDOWS: readonly ForecastWindow[] = ['auto', ...QUOTA_WINDOW_IDS];

export const isForecastWindow = (value: unknown): value is ForecastWindow =>
  typeof value === 'string' && (FORECAST_WINDOWS as readonly string[]).includes(value);

/** Period assumed when the provider states none: Claude only names five_hour and seven_day. */
const DEFAULT_PERIOD_HOURS: Record<QuotaWindowId, number> = { weekly: 168, session: 5, fable: 168 };

const limitFor = (account: QuotaAccount, window: QuotaWindowId): QuotaLimit | null =>
  window === 'weekly' ? account.weekly : window === 'session' ? account.fiveHour : account.fable;

/** The named window of one account, with its period, or null when the account has none. */
export const windowLimit = (
  account: QuotaAccount,
  window: QuotaWindowId
): { limit: QuotaLimit; window: QuotaWindowId; periodHours: number } | null => {
  const limit = limitFor(account, window);
  return limit
    ? { limit, window, periodHours: limit.periodHours ?? DEFAULT_PERIOD_HOURS[window] }
    : null;
};

/** The window a pool tracks by default: the weekly limit when there is one, else the short one. */
export const primaryLimit = (account: QuotaAccount) =>
  windowLimit(account, 'weekly') ?? windowLimit(account, 'session');

export const seriesKey = (accountId: string, window: QuotaWindowId) => `${accountId}#${window}`;

const isUsable = (account: QuotaAccount) => !account.pending && !account.error && !account.disabled;

/**
 * Accounts whose limits are loaded and usable, with the window each contributes:
 * the chosen one, or under `auto` each account's primary window. An account that
 * lacks the chosen window is left out rather than padded with another one.
 */
export const trackedAccounts = (accounts: QuotaAccount[], window: ForecastWindow = 'auto') =>
  accounts.flatMap((account) => {
    if (!isUsable(account)) return [];
    const picked = window === 'auto' ? primaryLimit(account) : windowLimit(account, window);
    return picked ? [{ account, ...picked, key: seriesKey(account.id, picked.window) }] : [];
  });

/** How many usable accounts report each window, so the picker offers only real choices. */
export const windowCounts = (accounts: QuotaAccount[]): Record<QuotaWindowId, number> => ({
  session: trackedAccounts(accounts, 'session').length,
  weekly: trackedAccounts(accounts, 'weekly').length,
  fable: trackedAccounts(accounts, 'fable').length,
});

/** Every window of every usable account: what gets recorded, so any view has history. */
const recordedWindows = (accounts: QuotaAccount[]) =>
  QUOTA_WINDOW_IDS.flatMap((window) => trackedAccounts(accounts, window));

/**
 * Append the current limits to the history. Returns the same object when
 * nothing new was recorded, so callers can skip a storage write.
 */
export function recordSamples(
  history: QuotaHistory,
  accounts: QuotaAccount[],
  now: number
): QuotaHistory {
  let next: QuotaHistory | null = null;
  const write = (): QuotaHistory => (next ??= { ...history });

  for (const tracked of recordedWindows(accounts)) {
    const point: HistoryPoint = {
      t: now,
      v: tracked.limit.remainingPct,
      r: tracked.limit.resetsAt,
    };
    const series = history[tracked.key];
    const last = series?.points[series.points.length - 1];
    if (last) {
      const unchanged = last.v === point.v && Math.abs(last.r - point.r) < 30 * MINUTE;
      const gap = now - last.t;
      if (gap < 0) continue;
      if (unchanged && gap < HEARTBEAT_MS) continue;
    }
    write()[tracked.key] = {
      provider: tracked.account.provider,
      periodHours: tracked.periodHours,
      points: [...(series?.points ?? []), point],
    };
  }

  const cutoff = now - HISTORY_RETENTION_MS;
  for (const [key, series] of Object.entries(next ?? history)) {
    if (series.points.length > 0 && series.points[0].t >= cutoff) continue;
    const kept = series.points.filter((point) => point.t >= cutoff);
    if (kept.length === series.points.length) continue;
    if (kept.length === 0) delete write()[key];
    else write()[key] = { ...series, points: kept };
  }

  return next ?? history;
}

/** Newest sample instant across every series, or 0 with no history. */
export function latestSampleAt(history: QuotaHistory): number {
  let latest = 0;
  for (const series of Object.values(history)) {
    const last = series.points[series.points.length - 1];
    if (last && last.t > latest) latest = last.t;
  }
  return latest;
}

/* ---------- 持久化：分钟精度的紧凑数组 ---------- */

interface StoredHistory {
  version: 1;
  series: Record<string, { p: string; h: number; d: [number, number, number][] }>;
}

export function serializeHistory(history: QuotaHistory): string {
  const stored: StoredHistory = { version: 1, series: {} };
  for (const [key, series] of Object.entries(history)) {
    stored.series[key] = {
      p: series.provider,
      h: series.periodHours,
      d: series.points.map((point) => [
        Math.round(point.t / MINUTE),
        Math.round(point.v * 10) / 10,
        Math.round(point.r / MINUTE),
      ]),
    };
  }
  return JSON.stringify(stored);
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Parse stored history; anything malformed is dropped rather than trusted. */
export function parseHistory(raw: string | null): QuotaHistory {
  if (!raw) return {};
  try {
    return parseStoredHistory(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Parse an already-decoded stored history, such as the proxy's `/quota/history` body. */
export function parseStoredHistory(parsed: unknown): QuotaHistory {
  const stored = parsed as Partial<StoredHistory> | null;
  if (!stored || stored.version !== 1 || typeof stored.series !== 'object' || !stored.series) {
    return {};
  }
  const history: QuotaHistory = {};
  for (const [key, entry] of Object.entries(stored.series)) {
    if (!entry || !PROVIDERS.has(entry.p) || !isNumber(entry.h) || entry.h <= 0) continue;
    if (!Array.isArray(entry.d)) continue;
    const points = entry.d
      .filter(
        (row): row is [number, number, number] =>
          Array.isArray(row) && row.length === 3 && row.every(isNumber)
      )
      .map(([t, v, r]) => ({ t: t * MINUTE, v: Math.min(100, Math.max(0, v)), r: r * MINUTE }))
      .sort((a, b) => a.t - b.t);
    if (points.length === 0) continue;
    history[key] = { provider: entry.p as QuotaProviderType, periodHours: entry.h, points };
  }
  return history;
}

/**
 * Union of two histories. Samples from the same minute are one sample (the
 * stored format has minute precision), and `primary` wins a tie, so the proxy's
 * reading of a minute is kept over the browser's.
 */
export function mergeHistory(primary: QuotaHistory, secondary: QuotaHistory): QuotaHistory {
  const merged: QuotaHistory = { ...secondary };
  for (const [key, series] of Object.entries(primary)) {
    const other = secondary[key];
    if (!other) {
      merged[key] = series;
      continue;
    }
    const byMinute = new Map<number, HistoryPoint>();
    for (const point of other.points) byMinute.set(Math.round(point.t / MINUTE), point);
    for (const point of series.points) byMinute.set(Math.round(point.t / MINUTE), point);
    merged[key] = {
      provider: series.provider,
      periodHours: series.periodHours,
      points: [...byMinute.values()].sort((a, b) => a.t - b.t),
    };
  }
  return merged;
}

/**
 * Whether any series in the history belongs to one of these accounts, for the
 * named window when given.
 */
export function hasSeriesFor(
  history: QuotaHistory,
  accounts: Pick<QuotaAccount, 'id'>[],
  window?: QuotaWindowId
): boolean {
  const ids = new Set(accounts.map((account) => account.id));
  return Object.keys(history).some((key) => {
    const split = key.lastIndexOf('#');
    return (
      ids.has(key.slice(0, split)) && (window === undefined || key.slice(split + 1) === window)
    );
  });
}

export function loadHistory(): QuotaHistory {
  if (typeof window === 'undefined') return {};
  try {
    return parseHistory(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

/** `history` without samples older than `keepMs` before its newest sample. */
export function trimHistory(history: QuotaHistory, keepMs: number): QuotaHistory {
  const newest = latestSampleAt(history);
  const trimmed: QuotaHistory = {};
  for (const [key, series] of Object.entries(history)) {
    const points = series.points.filter((point) => point.t >= newest - keepMs);
    if (points.length > 0) trimmed[key] = { ...series, points };
  }
  return trimmed;
}

/** Indexes where the remaining percent turns around: the last sample of a fall or rise and the first of the next move. */
function turningPoints(points: HistoryPoint[]): Set<number> {
  const turns = new Set<number>();
  let direction = 0;
  let lastMove = 0;
  for (let index = 1; index < points.length; index += 1) {
    const move = Math.sign(points[index].v - points[index - 1].v);
    if (move === 0) continue;
    if (direction !== 0 && move !== direction) {
      turns.add(lastMove);
      turns.add(index - 1);
    }
    direction = move;
    lastMove = index;
  }
  return turns;
}

/**
 * `history` with only every `step`-th sample of each series, plus the samples that
 * matter: each series' first and last, both sides of every window reset, and every
 * turning point. Between kept samples the value only falls or only rises, so the use
 * the forecast adds up (the falls) is exactly what it was; only the detail inside a
 * run thins out, and lines draw straight across it.
 */
export function thinHistory(history: QuotaHistory, step: number): QuotaHistory {
  if (step <= 1) return history;
  const thinned: QuotaHistory = {};
  for (const [key, series] of Object.entries(history)) {
    const { points } = series;
    const turns = turningPoints(points);
    const kept = points.filter((point, index) => {
      if (index === 0 || index === points.length - 1 || index % step === 0) return true;
      if (turns.has(index)) return true;
      const before = points[index - 1];
      const after = points[index + 1];
      return point.r - before.r > ROLLED_MS || after.r - point.r > ROLLED_MS;
    });
    thinned[key] = { ...series, points: kept };
  }
  return thinned;
}

/**
 * Smaller versions of the history for a full store, best first: the whole span at
 * ever coarser detail, then only the recent days as a last resort.
 */
const SHRINKS: ((history: QuotaHistory) => QuotaHistory)[] = [
  (history) => history,
  (history) => thinHistory(history, 2),
  (history) => thinHistory(history, 4),
  (history) => thinHistory(history, 8),
  (history) => trimHistory(thinHistory(history, 8), 7 * DAY),
  (history) => trimHistory(thinHistory(history, 8), 2 * DAY),
];

/**
 * Persist the history. Recording every window multiplies what a browser holds, so
 * when storage refuses it, keep the whole span at coarser detail rather than losing
 * the older days; the proxy's own history and the page's memory still hold the rest.
 */
export function saveHistory(
  history: QuotaHistory,
  storage: Pick<Storage, 'setItem'> | null = typeof window === 'undefined'
    ? null
    : (() => {
        try {
          return window.localStorage;
        } catch {
          return null;
        }
      })()
): void {
  if (!storage) return;
  for (const shrink of SHRINKS) {
    try {
      storage.setItem(STORAGE_KEY, serializeHistory(shrink(history)));
      return;
    } catch {
      // Storage full or blocked: try a shorter history.
    }
  }
}
