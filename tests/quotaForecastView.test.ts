import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import {
  hasSeriesFor,
  isForecastWindow,
  recordSamples,
  trackedAccounts,
  windowCounts,
  type QuotaHistory,
} from '../src/features/quota/forecast/history';
import {
  buildForecast,
  forecastSpan,
  isForecastRange,
  type ForecastView,
} from '../src/features/quota/forecast/model';
import { QuotaForecast } from '../src/features/quota/forecast/QuotaForecast';
import { DAY, HOUR, type QuotaAccount, type QuotaLimit } from '../src/features/quota/home/model';

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);

const limit = (remainingPct: number, resetsAt: number, periodHours?: number): QuotaLimit => ({
  remainingPct,
  resetsAt,
  periodHours: periodHours ?? null,
});

const account = (id: string, overrides: Partial<QuotaAccount> = {}): QuotaAccount => ({
  id,
  provider: 'claude',
  email: `${id}@example.com`,
  name: id,
  plan: 'Max',
  planTier: 'max',
  authExpiresAt: null,
  lastRefreshAt: null,
  fiveHour: null,
  weekly: null,
  fable: null,
  ...overrides,
});

/** A Claude login reporting all three windows, like a Max plan with Fable. */
const full = (id: string) =>
  account(id, {
    fiveHour: limit(40, NOW + 2 * HOUR, 5),
    weekly: limit(80, NOW + 2 * DAY, 168),
    fable: limit(60, NOW + 3 * DAY),
  });

const view = (overrides: Partial<ForecastView> = {}): ForecastView => ({
  window: 'auto',
  range: 'auto',
  ...overrides,
});

describe('forecast window selection', () => {
  test('auto pools each account by its weekly limit, else its 5-hour one', () => {
    const accounts = [full('a'), account('b', { fiveHour: limit(40, NOW + HOUR, 5) })];
    expect(trackedAccounts(accounts).map((entry) => entry.key)).toEqual(['a#weekly', 'b#session']);
  });

  test('a named window pools only the accounts that report it', () => {
    const accounts = [full('a'), account('b', { weekly: limit(50, NOW + DAY, 168) })];
    expect(trackedAccounts(accounts, 'session').map((entry) => entry.key)).toEqual(['a#session']);
    expect(trackedAccounts(accounts, 'weekly').map((entry) => entry.key)).toEqual([
      'a#weekly',
      'b#weekly',
    ]);
    expect(trackedAccounts(accounts, 'fable').map((entry) => entry.key)).toEqual(['a#fable']);
  });

  test('a window without a stated period falls back to its kind', () => {
    const fable = trackedAccounts([full('a')], 'fable')[0];
    expect(fable.periodHours).toBe(168);
    expect(trackedAccounts([full('a')], 'session')[0].periodHours).toBe(5);
  });

  test('skips accounts that are pending, failed or disabled in every window', () => {
    const accounts = [
      { ...full('a'), pending: true },
      { ...full('b'), error: 'expired' },
      { ...full('c'), disabled: true },
    ];
    expect(windowCounts(accounts)).toEqual({ session: 0, weekly: 0, fable: 0 });
    expect(windowCounts([full('d'), account('e', { weekly: limit(1, NOW + DAY) })])).toEqual({
      session: 1,
      weekly: 2,
      fable: 1,
    });
  });

  test('the pool figures follow the chosen window', () => {
    const accounts = [full('a'), full('b')];
    const pool = (window: ForecastView['window']) =>
      buildForecast(accounts, {}, NOW, view({ window })).providers[0];
    expect(pool('weekly').remaining).toBe(160);
    expect(pool('session').remaining).toBe(80);
    expect(pool('fable').remaining).toBe(120);
    expect(pool('fable').capacity).toBe(200);
    // Auto is the weekly pool, as before windows could be chosen.
    expect(pool('auto').remaining).toBe(160);
  });

  test('a window nobody reports leaves no provider to chart', () => {
    const accounts = [account('a', { weekly: limit(80, NOW + DAY, 168) })];
    expect(buildForecast(accounts, {}, NOW, view({ window: 'fable' })).providers).toEqual([]);
  });

  test('the 5-hour pool refills on its own short cycle', () => {
    const accounts = [account('a', { fiveHour: limit(10, NOW + HOUR, 5), weekly: limit(90, NOW + DAY, 168) })];
    const session = buildForecast(accounts, {}, NOW, view({ window: 'session' })).providers[0];
    expect(session.nextReset?.t).toBe(NOW + HOUR);
    const weekly = buildForecast(accounts, {}, NOW, view({ window: 'weekly' })).providers[0];
    expect(weekly.nextReset?.t).toBe(NOW + DAY);
  });
});

describe('forecast window recording', () => {
  test('records every window an account reports so any view has history', () => {
    const history = recordSamples({}, [full('a'), account('b', { fiveHour: limit(40, NOW + HOUR, 5) })], NOW);
    expect(Object.keys(history).sort()).toEqual([
      'a#fable',
      'a#session',
      'a#weekly',
      'b#session',
    ]);
    expect(history['a#fable'].periodHours).toBe(168);
    expect(history['a#session'].points).toEqual([{ t: NOW, v: 40, r: NOW + 2 * HOUR }]);
  });

  test('says the proxy recorded a window only when it holds that window', () => {
    const proxy: QuotaHistory = {
      'a#weekly': { provider: 'claude', periodHours: 168, points: [{ t: NOW, v: 80, r: NOW + DAY }] },
    };
    const accounts = [{ id: 'a' }];
    expect(hasSeriesFor(proxy, accounts)).toBe(true);
    expect(hasSeriesFor(proxy, accounts, 'weekly')).toBe(true);
    expect(hasSeriesFor(proxy, accounts, 'session')).toBe(false);
    expect(hasSeriesFor(proxy, accounts, 'fable')).toBe(false);
  });

  test("an account's window history is not mixed into another window's pool", () => {
    const history = recordSamples({}, [full('a')], NOW - 2 * DAY);
    const later = buildForecast([full('a')], history, NOW, view({ window: 'session' })).providers[0];
    expect(later.recordingSince).toBe(NOW - 2 * DAY);
    const other = buildForecast([full('a')], { 'a#weekly': history['a#weekly'] }, NOW, view({ window: 'session' }))
      .providers[0];
    expect(other.recordingSince).toBeNull();
  });
});

describe('forecast range', () => {
  test('auto keeps the span it always had', () => {
    const span = forecastSpan([full('a')], {}, NOW, view());
    expect(span.now).toBe(NOW);
    expect(span.from).toBe(NOW - 12 * HOUR);
    expect(span.horizon).toBe(span.to);
  });

  test('a chosen range is exact, with or without recorded history', () => {
    expect(forecastSpan([full('a')], {}, NOW, view({ range: 'day' }))).toMatchObject({
      from: NOW - DAY,
      to: NOW + DAY,
    });
    expect(forecastSpan([full('a')], {}, NOW, view({ range: 'week' }))).toMatchObject({
      from: NOW - 7 * DAY,
      to: NOW + 7 * DAY,
    });
    expect(forecastSpan([full('a')], {}, NOW, view({ range: 'month' }))).toMatchObject({
      from: NOW - 30 * DAY,
      to: NOW + 7 * DAY,
    });
  });

  test('the chart stops at the range while the projection reads further', () => {
    // 80 left, burning about 40 a day: empty in about two days, past a one-day view.
    const accounts = [account('a', { weekly: limit(20, NOW + 6 * DAY, 168) })];
    const history: QuotaHistory = {
      'a#weekly': {
        provider: 'claude',
        periodHours: 168,
        points: [
          { t: NOW - DAY, v: 60, r: NOW + 6 * DAY },
          { t: NOW, v: 20, r: NOW + 6 * DAY },
        ],
      },
    };
    const day = buildForecast(accounts, history, NOW, view({ range: 'day' }));
    const pool = day.providers[0];
    const lastShown = pool.projected[pool.projected.length - 1];
    expect(lastShown.t).toBe(NOW + DAY);
    expect(day.span.horizon).toBeGreaterThan(day.span.to);
    // It runs out after the day on screen, and the readout still says so.
    expect(pool.runsOutAt).not.toBeNull();
    expect(pool.runsOutAt!).toBeGreaterThan(NOW + 11 * HOUR);
    expect(pool.runsOutAt!).toBeLessThan(NOW + 13 * HOUR);
  });

  test('readouts do not depend on the range', () => {
    const accounts = [account('a', { weekly: limit(20, NOW + 6 * DAY, 168) })];
    const history: QuotaHistory = {
      'a#weekly': {
        provider: 'claude',
        periodHours: 168,
        points: [
          { t: NOW - DAY, v: 60, r: NOW + 6 * DAY },
          { t: NOW, v: 20, r: NOW + 6 * DAY },
        ],
      },
    };
    const facts = (range: ForecastView['range']) => {
      const pool = buildForecast(accounts, history, NOW, view({ range })).providers[0];
      return [pool.runsOutAt, pool.refillAt, pool.nextReset, pool.pacePerDay];
    };
    expect(facts('day')).toEqual(facts('auto'));
    expect(facts('week')).toEqual(facts('auto'));
    expect(facts('month')).toEqual(facts('auto'));
  });

  test('day cells cover exactly the span for every range', () => {
    for (const range of ['day', 'week', 'month'] as const) {
      const forecast = buildForecast([full('a')], {}, NOW, view({ range }));
      const pool = forecast.providers[0];
      expect(pool.days[0].start).toBeLessThanOrEqual(forecast.span.from);
      expect(pool.days[pool.days.length - 1].end).toBeGreaterThanOrEqual(forecast.span.to);
      expect(pool.days.filter((day) => day.kind === 'today')).toHaveLength(1);
    }
  });

  test('recognises only the known windows and ranges', () => {
    expect(['auto', 'session', 'weekly', 'fable'].every(isForecastWindow)).toBe(true);
    expect(['auto', 'day', 'week', 'month'].every(isForecastRange)).toBe(true);
    for (const bad of ['', 'monthly', 'primary', 'five-hour', null, undefined, 3]) {
      expect(isForecastWindow(bad)).toBe(false);
      expect(isForecastRange(bad)).toBe(false);
    }
  });
});

describe('forecast view picker', () => {
  beforeAll(() => i18n.changeLanguage('en'));
  afterAll(() => i18n.changeLanguage('zh-CN'));

  const render = (accounts: QuotaAccount[], forecastView: ForecastView) => {
    const forecast = buildForecast(accounts, {}, NOW, forecastView);
    return renderToStaticMarkup(
      createElement(QuotaForecast, {
        forecast,
        theme: 'light',
        available: windowCounts(accounts),
        onWindowChange: () => {},
        onRangeChange: () => {},
      })
    );
  };

  test('offers each window an account reports and marks the one in use', () => {
    const html = render([full('a')], view({ window: 'fable', range: 'month' }));
    for (const label of ['Auto', '5-hour', 'Weekly', 'Fable', 'Day', 'Week', 'Month']) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toMatch(/aria-pressed="true"[^>]*>Fable</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Month</);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Weekly</);
    expect(html).toContain('Pooling each account&#x27;s Fable window');
  });

  test('offers no window a login does not report', () => {
    const html = render(
      [account('a', { weekly: limit(80, NOW + DAY, 168), fiveHour: limit(40, NOW + HOUR, 5) })],
      view()
    );
    expect(html).toContain('>5-hour</button>');
    expect(html).not.toContain('>Fable</button>');
    expect(html).not.toContain('Pooling each account');
  });

  test('hides the window choice when auto is the only real option', () => {
    const html = render([account('a', { weekly: limit(80, NOW + DAY, 168) })], view());
    expect(html).not.toContain('>Weekly</button>');
    expect(html).toContain('>Month</button>');
  });
});

describe('forecast view locales', () => {
  const KEYS = [
    'window_label',
    'window_auto',
    'window_session',
    'window_weekly',
    'window_fable',
    'window_auto_hint',
    'window_pooling',
    'range_label',
    'range_auto',
    'range_day',
    'range_week',
    'range_month',
    'range_auto_hint',
  ];

  test('every locale names each window and range, and the note keeps its placeholder', async () => {
    for (const locale of ['en', 'ko', 'ru', 'vi', 'zh-CN', 'zh-TW']) {
      const forecast = (await Bun.file(`src/i18n/locales/${locale}.json`).json()).quota_management
        .forecast;
      for (const key of KEYS) {
        expect(typeof forecast[key] === 'string' && forecast[key].trim()).toBeTruthy();
      }
      expect(forecast.window_pooling).toContain('{{window}}');
    }
  });
});
