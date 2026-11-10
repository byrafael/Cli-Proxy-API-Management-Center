/**
 * Live refresh preference: interval mapping, catch-up on tab return, and
 * localStorage persistence that never trusts a stored value it does not know.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '../src/i18n/locales/en.json';
import { QuotaHeader } from '@/features/quota/components/QuotaHeader';
import {
  DEFAULT_LIVE_REFRESH,
  LIVE_REFRESH_OPTIONS,
  isLiveRefreshDue,
  liveRefreshIntervalMs,
  readLiveRefresh,
  writeLiveRefresh,
} from '@/features/quota/liveRefresh';
import { claimQuotaRequest, ownsQuotaRequest } from '@/features/quota/requestOwnership';
import { latestSampleAt, type QuotaHistory } from '@/features/quota/forecast/history';
import { buildForecast } from '@/features/quota/forecast/model';

const KEY = 'quotaPage.liveRefresh';
const i18n = createInstance();
await i18n.init({ lng: 'en', resources: { en: { translation: en } } });
const originalWindow = (globalThis as { window?: unknown }).window;

function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: storage };
  return storage;
}

let storage: ReturnType<typeof installLocalStorage>;

beforeEach(() => {
  storage = installLocalStorage();
});

afterAll(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

describe('live refresh', () => {
  test('maps every option to an interval, off to none', () => {
    expect(liveRefreshIntervalMs('off')).toBeNull();
    expect(liveRefreshIntervalMs('30s')).toBe(30_000);
    expect(liveRefreshIntervalMs('1m')).toBe(60_000);
    expect(liveRefreshIntervalMs('5m')).toBe(300_000);
    expect(liveRefreshIntervalMs('15m')).toBe(900_000);
    const live = LIVE_REFRESH_OPTIONS.filter((option) => option !== 'off');
    expect(live.every((option) => (liveRefreshIntervalMs(option) ?? 0) >= 30_000)).toBe(true);
  });

  test('defaults to the 15 minute cadence the forecast relied on', () => {
    expect(DEFAULT_LIVE_REFRESH).toBe('15m');
    expect(readLiveRefresh()).toBe('15m');
  });

  test('round-trips a choice and ignores unknown stored values', () => {
    writeLiveRefresh('30s');
    expect(storage.getItem(KEY)).toBe('30s');
    expect(readLiveRefresh()).toBe('30s');
    storage.setItem(KEY, '5s');
    expect(readLiveRefresh()).toBe(DEFAULT_LIVE_REFRESH);
  });

  test('a returning tab catches up only once the interval has passed', () => {
    expect(isLiveRefreshDue(null, 30_000, 1_000)).toBe(true);
    expect(isLiveRefreshDue(1_000, 30_000, 20_000)).toBe(false);
    expect(isLiveRefreshDue(1_000, 30_000, 31_000)).toBe(true);
  });

  test('header shows the picker, live indicator, and updated stamp', () => {
    const render = (liveRefresh: 'off' | '30s', updatedAt: number | null) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(QuotaHeader, {
            totalCount: 3,
            loadedCount: 3,
            attentionCount: 0,
            refreshing: false,
            disableControls: false,
            onRefreshAll: () => {},
            liveRefresh,
            onLiveRefreshChange: () => {},
            updatedAt,
          })
        )
      );
    const on = render('30s', Date.UTC(2026, 10, 10, 14, 3, 22));
    expect(on).toContain('data-live="true"');
    expect(on).toContain('Auto refresh');
    expect(on).toContain('Every 30s');
    expect(on).toMatch(/updated \d{2}:03:22/);
    const off = render('off', null);
    expect(off).toContain('data-live="false"');
    expect(off).toContain('>Off<');
    expect(off).not.toContain('updated ');
  });

  test('a read started later owns the credential, whichever lands first', () => {
    const background = claimQuotaRequest('codex:a.json');
    const manual = claimQuotaRequest('codex:a.json');
    // Manual lands first and commits; the older background response must not.
    expect(ownsQuotaRequest('codex:a.json', manual)).toBe(true);
    expect(ownsQuotaRequest('codex:a.json', background)).toBe(false);
    // Other credentials are independent.
    const other = claimQuotaRequest('codex:b.json');
    expect(ownsQuotaRequest('codex:b.json', other)).toBe(true);
    expect(ownsQuotaRequest('codex:a.json', manual)).toBe(true);
  });

  test('forecast now covers a sample recorded after the minute clock ticked', () => {
    const minuteClock = Date.UTC(2026, 10, 10, 14, 0, 0);
    const sampleAt = minuteClock + 42_000;
    const history: QuotaHistory = {
      'a#weekly': {
        provider: 'codex',
        periodHours: 168,
        points: [{ t: sampleAt, v: 80, r: sampleAt + 3 * 86_400_000 }],
      },
    };
    expect(latestSampleAt({})).toBe(0);
    const now = Math.max(minuteClock, latestSampleAt(history));
    expect(now).toBe(sampleAt);
    const forecast = buildForecast([], history, now);
    expect(forecast.span.now).toBeGreaterThanOrEqual(sampleAt);
  });
});
