/**
 * Live refresh: how often the quota page re-reads every credential's limits
 * while it is open and visible. Each read lands in the ledger and the forecast
 * history, so a short interval draws usage as it happens.
 *
 * The choice persists in localStorage: a live view is a standing preference,
 * unlike the session-scoped grouping and redaction toggles.
 */

import { MINUTE } from './home/model';

export const LIVE_REFRESH_OPTIONS = ['off', '30s', '1m', '5m', '15m'] as const;
export type LiveRefreshOption = (typeof LIVE_REFRESH_OPTIONS)[number];

/** Matches the page's earlier fixed cadence, so the forecast keeps recording by default. */
export const DEFAULT_LIVE_REFRESH: LiveRefreshOption = '15m';

const INTERVAL_MS: Record<LiveRefreshOption, number | null> = {
  off: null,
  '30s': 30_000,
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
};

export const liveRefreshIntervalMs = (option: LiveRefreshOption): number | null =>
  INTERVAL_MS[option];

const OPTION_SET = new Set<string>(LIVE_REFRESH_OPTIONS);

export const isLiveRefreshOption = (value: unknown): value is LiveRefreshOption =>
  typeof value === 'string' && OPTION_SET.has(value);

/**
 * Whether a background tick is due when the tab becomes visible again.
 * Hidden tabs skip ticks, so a returning viewer would otherwise wait up to a
 * full interval for fresh numbers.
 */
export const isLiveRefreshDue = (
  lastRefreshAt: number | null,
  intervalMs: number,
  now: number
): boolean => lastRefreshAt === null || now - lastRefreshAt >= intervalMs;

const STORAGE_KEY = 'quotaPage.liveRefresh';

export function readLiveRefresh(): LiveRefreshOption {
  if (typeof window === 'undefined') return DEFAULT_LIVE_REFRESH;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLiveRefreshOption(stored) ? stored : DEFAULT_LIVE_REFRESH;
  } catch {
    return DEFAULT_LIVE_REFRESH;
  }
}

export function writeLiveRefresh(option: LiveRefreshOption): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, option);
  } catch {
    // Storage blocked: the choice still applies for this visit.
  }
}
