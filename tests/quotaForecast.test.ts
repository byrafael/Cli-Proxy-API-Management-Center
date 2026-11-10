import { describe, expect, test } from 'bun:test';
import {
  HISTORY_RETENTION_MS,
  parseHistory,
  recordSamples,
  serializeHistory,
  type QuotaHistory,
} from '../src/features/quota/forecast/history';
import {
  buildForecast,
  seriesUsage,
  simulate,
  startOfLocalDay,
  valueAt,
} from '../src/features/quota/forecast/model';
import {
  DAY,
  HOUR,
  MINUTE,
  recoversAt,
  summarize,
  type QuotaAccount,
  type QuotaLimit,
} from '../src/features/quota/home/model';

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);

const limit = (remainingPct: number, resetsAt: number, periodHours: number): QuotaLimit => ({
  remainingPct,
  resetsAt,
  periodHours,
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

describe('quota history recording', () => {
  test('records loaded weekly limits and skips pending, failed and disabled accounts', () => {
    const accounts = [
      account('a', { weekly: limit(80, NOW + 2 * DAY, 168) }),
      account('b', { fiveHour: limit(40, NOW + HOUR, 5) }),
      account('c', { weekly: limit(50, NOW + DAY, 168), pending: true }),
      account('d', { weekly: limit(50, NOW + DAY, 168), error: 'expired' }),
      account('e', { weekly: limit(50, NOW + DAY, 168), disabled: true }),
    ];
    const history = recordSamples({}, accounts, NOW);
    expect(Object.keys(history).sort()).toEqual(['a#weekly', 'b#session']);
    expect(history['a#weekly'].periodHours).toBe(168);
    expect(history['b#session'].points).toEqual([{ t: NOW, v: 40, r: NOW + HOUR }]);
  });

  test('skips unchanged readings until the hourly heartbeat, records changes at once', () => {
    const at = (v: number) => [account('a', { weekly: limit(v, NOW + DAY, 168) })];
    const first = recordSamples({}, at(80), NOW);
    expect(recordSamples(first, at(80), NOW + 15 * MINUTE)).toBe(first);
    expect(recordSamples(first, at(78), NOW + 15 * MINUTE)['a#weekly'].points).toHaveLength(2);
    expect(recordSamples(first, at(80), NOW + HOUR)['a#weekly'].points).toHaveLength(2);
  });

  test('drops samples older than the retention window', () => {
    const old: QuotaHistory = {
      'a#weekly': {
        provider: 'claude',
        periodHours: 168,
        points: [{ t: NOW - HISTORY_RETENTION_MS - HOUR, v: 90, r: NOW }],
      },
    };
    expect(recordSamples(old, [], NOW)).toEqual({});
  });

  test('keeps a month of samples', () => {
    const at = (age: number): QuotaHistory => ({
      'a#weekly': { provider: 'claude', periodHours: 168, points: [{ t: NOW - age, v: 90, r: NOW }] },
    });
    expect(recordSamples(at(29 * DAY), [], NOW)['a#weekly'].points).toHaveLength(1);
    expect(recordSamples(at(31 * DAY), [], NOW)).toEqual({});
  });

  test('round-trips through storage and rejects malformed entries', () => {
    const history = recordSamples(
      {},
      [account('a', { weekly: limit(72.5, NOW + DAY, 168) })],
      NOW
    );
    expect(parseHistory(serializeHistory(history))).toEqual(history);
    expect(parseHistory('not json')).toEqual({});
    expect(
      parseHistory(
        JSON.stringify({
          version: 1,
          series: { x: { p: 'unknown', h: 5, d: [[1, 2, 3]] }, y: { p: 'codex', h: 5, d: 'bad' } },
        })
      )
    ).toEqual({});
  });
});

describe('recorded usage', () => {
  test('counts drops inside a window and the refill after a reset', () => {
    const series = {
      provider: 'claude' as const,
      periodHours: 168,
      points: [
        { t: NOW - 10 * HOUR, v: 60, r: NOW - 4 * HOUR },
        { t: NOW - 6 * HOUR, v: 40, r: NOW - 4 * HOUR },
        // Window rolled at NOW - 4h; 5% used since.
        { t: NOW - 2 * HOUR, v: 95, r: NOW + 7 * DAY - 4 * HOUR },
      ],
    };
    expect(seriesUsage(series, NOW - 12 * HOUR, NOW)).toBeCloseTo(25);
    // Half the first drop falls inside [NOW-8h, NOW].
    expect(seriesUsage(series, NOW - 8 * HOUR, NOW)).toBeCloseTo(15);
  });
});

describe('projection', () => {
  test('spreads demand over accounts with room and refills each at its reset', () => {
    const sim = simulate(
      [
        { v: 10, r: NOW + 10 * HOUR, periodMs: 168 * HOUR },
        { v: 50, r: NOW + 100 * HOUR, periodMs: 168 * HOUR },
      ],
      10,
      NOW,
      NOW + 12 * HOUR
    );
    // 60 available, 10/h demand: empty after 6 hours.
    expect(valueAt(sim.points, NOW + 6 * HOUR)).toBeCloseTo(0);
    expect(valueAt(sim.points, NOW + 8 * HOUR)).toBeCloseTo(0);
    expect(sim.resets).toEqual([{ t: NOW + 10 * HOUR, gain: 100 }]);
    // After the refill the pool burns again from 100.
    expect(valueAt(sim.points, NOW + 12 * HOUR)).toBeCloseTo(80);
    expect(sim.points[sim.points.length - 1].used).toBeCloseTo(80);
  });

  test('a reset that already passed starts the account full', () => {
    const sim = simulate([{ v: 5, r: NOW - HOUR, periodMs: 5 * HOUR }], 0, NOW, NOW + HOUR);
    expect(sim.points[0].v).toBe(100);
  });
});

describe('forecast', () => {
  test('pools a provider, projects from the window average and finds when it runs out', () => {
    const accounts = [
      // Two days into a seven-day window with 40% used: 20% a day each.
      account('a', { weekly: limit(60, NOW + 5 * DAY, 168) }),
      account('b', { weekly: limit(60, NOW + 5 * DAY, 168) }),
      account('x', { provider: 'codex', weekly: limit(100, NOW + 3 * DAY, 168) }),
    ];
    const forecast = buildForecast(accounts, {}, NOW);
    const claude = forecast.providers.find((pool) => pool.id === 'claude');
    if (!claude) throw new Error('missing claude pool');

    expect(claude.capacity).toBe(200);
    expect(claude.remaining).toBe(120);
    expect(claude.paceBasis).toBe('window');
    expect(claude.pacePerDay).toBeCloseTo(40);
    // 120 at 40 a day lasts three days, before the reset in five.
    // Within one 15-minute projection step.
    expect(Math.abs((claude.runsOutAt ?? 0) - (NOW + 3 * DAY))).toBeLessThanOrEqual(15 * MINUTE);
    expect(claude.refillAt).toBe(NOW + 5 * DAY);

    const tomorrow = claude.days.find((day) => day.start === startOfLocalDay(NOW + DAY));
    expect(tomorrow?.kind).toBe('future');
    expect(tomorrow?.used).toBeCloseTo(40);

    expect(forecast.total.capacity).toBe(300);
    expect(forecast.total.remaining).toBe(220);
    expect(forecast.span.to).toBeGreaterThanOrEqual(startOfLocalDay(NOW) + 3 * DAY);
  });

  test('switches to the recorded pace once the last day is covered', () => {
    const history: QuotaHistory = {
      'a#weekly': {
        provider: 'claude',
        periodHours: 168,
        points: [
          { t: NOW - 20 * HOUR, v: 90, r: NOW + 5 * DAY },
          { t: NOW, v: 80, r: NOW + 5 * DAY },
        ],
      },
    };
    const accounts = [account('a', { weekly: limit(80, NOW + 5 * DAY, 168) })];
    const pool = buildForecast(accounts, history, NOW).providers[0];
    expect(pool.paceBasis).toBe('history');
    expect(pool.pacePerDay).toBeCloseTo(12);
    expect(pool.recordingSince).toBe(NOW - 20 * HOUR);
    expect(valueAt(pool.recorded, NOW - 10 * HOUR)).toBeCloseTo(85);
  });
});

describe('limited accounts', () => {
  test('come back when the last exhausted account-wide limit resets', () => {
    const weeklyOut = account('a', {
      weekly: limit(0, NOW + 14 * HOUR, 168),
      fiveHour: limit(100, NOW + 2 * HOUR, 5),
    });
    expect(recoversAt(weeklyOut, NOW)).toBe(NOW + 14 * HOUR);

    const bothOut = account('b', {
      weekly: limit(2, NOW + 3 * DAY, 168),
      fiveHour: limit(0, NOW + HOUR, 5),
      fable: limit(0, NOW + 20 * MINUTE, 168),
    });
    expect(recoversAt(bothOut, NOW)).toBe(NOW + 3 * DAY);

    const fableOnly = account('c', {
      weekly: limit(60, NOW + 3 * DAY, 168),
      fable: limit(0, NOW + 37 * MINUTE, 168),
    });
    expect(recoversAt(fableOnly, NOW)).toBe(NOW + 37 * MINUTE);
    expect(recoversAt(account('d', { weekly: limit(50, NOW + DAY, 168) }), NOW)).toBeNull();
  });

  test('the next recovery counts weekly limits, not the five-hour reset', () => {
    const summary = summarize(
      [
        account('a', {
          weekly: limit(0, NOW + 14 * HOUR, 168),
          fiveHour: limit(100, NOW + 2 * HOUR, 5),
        }),
      ],
      NOW
    );
    expect(summary.nextRecoveryAt).toBe(NOW + 14 * HOUR);
  });
});
