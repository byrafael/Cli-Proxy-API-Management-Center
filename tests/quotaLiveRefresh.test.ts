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
import {
  beginQuotaRead,
  beginQuotaWrite,
  settleSupersededLoading,
} from '@/features/quota/requestOwnership';
import type { QuotaAdapter, QuotaCardState } from '@/features/quota/providers';
import { useQuotaBatchLoader } from '@/features/quota/hooks/useQuotaBatchLoader';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { AuthFileItem } from '@/types';
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

  test('a later foreground write owns the credential, whichever lands first', () => {
    const first = beginQuotaWrite('own:a');
    const second = beginQuotaWrite('own:a');
    expect(second.owns()).toBe(true);
    expect(first.owns()).toBe(false);
    first.end();
    second.end();
    const other = beginQuotaWrite('own:b');
    expect(other.owns()).toBe(true);
    other.end();
  });

  test('a background read in flight yields to a manual write from any page', () => {
    const canCommit = beginQuotaRead('own:c');
    expect(canCommit).not.toBeNull();
    const manual = beginQuotaWrite('own:c');
    manual.end();
    // The manual result landed first; the older poll must not overwrite it.
    expect(canCommit?.()).toBe(false);
  });

  test('a poll never starts while a reset is in flight', () => {
    const reset = beginQuotaWrite('own:d');
    expect(beginQuotaRead('own:d')).toBeNull();
    expect(reset.owns()).toBe(true);
    reset.end();
    reset.end();
    const poll = beginQuotaRead('own:d');
    expect(poll?.()).toBe(true);
  });

  test('a newer poll invalidates an older one without touching writes', () => {
    const older = beginQuotaRead('own:e');
    const newer = beginQuotaRead('own:e');
    expect(older?.()).toBe(false);
    expect(newer?.()).toBe(true);
    const write = beginQuotaWrite('own:e');
    expect(write.owns()).toBe(true);
    expect(newer?.()).toBe(false);
    write.end();
  });

  test('a poll that skips a write-locked credential is not a full read', async () => {
    let loadQuota: ReturnType<typeof useQuotaBatchLoader>['loadQuota'] | null = null;
    const Probe = () => {
      loadQuota = useQuotaBatchLoader().loadQuota;
      return null;
    };
    renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Probe)));
    const file = { name: 'locked.json', type: 'codex' } as AuthFileItem;
    const reset = beginQuotaWrite(getQuotaCacheKey(file));
    try {
      const read = await loadQuota!([{ file, type: 'codex' }], { background: true });
      expect(read).toBe(false);
    } finally {
      reset.end();
    }
  });

  test('a failed reset settles a row a superseded read left loading', () => {
    let map: Record<string, QuotaCardState> = {
      loading: { status: 'loading' } as QuotaCardState,
      loaded: { status: 'success' } as QuotaCardState,
    };
    const setQuota = (update: (prev: typeof map) => typeof map) => {
      map = update(map);
    };
    const adapter = {
      buildErrorState: (message: string) => ({ status: 'error', error: message }),
    } as unknown as QuotaAdapter;
    settleSupersededLoading(setQuota, adapter, 'loading', 'reset failed');
    settleSupersededLoading(setQuota, adapter, 'loaded', 'reset failed');
    expect(map.loading).toEqual({ status: 'error', error: 'reset failed' } as QuotaCardState);
    expect(map.loaded.status).toBe('success');
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
