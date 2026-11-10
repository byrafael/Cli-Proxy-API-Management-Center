/**
 * Recorded quota history: one series per account window, sampled whenever the
 * quota page loads limits. The Management API keeps no history, so the browser
 * records what it sees and persists it in localStorage.
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

const STORAGE_KEY = 'quotaForecast.history.v1';
const PROVIDERS = new Set<string>(QUOTA_TAB_ORDER);

export type PrimaryWindow = 'weekly' | 'session';

/** The window a pool tracks: the weekly limit when there is one, else the short one. */
export const primaryLimit = (
  account: QuotaAccount
): { limit: QuotaLimit; window: PrimaryWindow; periodHours: number } | null => {
  if (account.weekly) {
    return { limit: account.weekly, window: 'weekly', periodHours: account.weekly.periodHours ?? 168 };
  }
  if (account.fiveHour) {
    return {
      limit: account.fiveHour,
      window: 'session',
      periodHours: account.fiveHour.periodHours ?? 5,
    };
  }
  return null;
};

export const seriesKey = (accountId: string, window: PrimaryWindow) => `${accountId}#${window}`;

/** Accounts whose limits are loaded and usable, with the window each contributes. */
export const trackedAccounts = (accounts: QuotaAccount[]) =>
  accounts.flatMap((account) => {
    if (account.pending || account.error || account.disabled) return [];
    const primary = primaryLimit(account);
    return primary ? [{ account, ...primary, key: seriesKey(account.id, primary.window) }] : [];
  });

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

  for (const tracked of trackedAccounts(accounts)) {
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
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

export function loadHistory(): QuotaHistory {
  if (typeof window === 'undefined') return {};
  try {
    return parseHistory(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

export function saveHistory(history: QuotaHistory): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, serializeHistory(history));
  } catch {
    // Storage full or blocked: the forecast still works from the current window.
  }
}
