import { describe, expect, test } from 'bun:test';
import {
  hasSeriesFor,
  mergeHistory,
  parseStoredHistory,
  serializeHistory,
  type QuotaHistory,
} from '../src/features/quota/forecast/history';

const MIN = 60_000;

// The proxy's internal/quotahistory tests use this exact string as their fixture,
// so both sides read and write the same format.
const PROXY_BODY = {
  version: 1,
  series: {
    'codex-a.json#weekly': {
      p: 'codex',
      h: 168,
      d: [
        [29000000, 81.3, 29005000],
        [29000060, 80, 29005000],
      ],
    },
    'claude-b.json#session': { p: 'claude', h: 5, d: [[29000010, 42.5, 29000200]] },
  },
};

describe('server quota history', () => {
  test('reads the proxy body and writes the same format back', () => {
    const history = parseStoredHistory(PROXY_BODY);
    expect(history['codex-a.json#weekly'].points).toEqual([
      { t: 29000000 * MIN, v: 81.3, r: 29005000 * MIN },
      { t: 29000060 * MIN, v: 80, r: 29005000 * MIN },
    ]);
    expect(JSON.parse(serializeHistory(history))).toEqual(PROXY_BODY);
  });

  test('ignores a body that is not stored history', () => {
    expect(parseStoredHistory(null)).toEqual({});
    expect(parseStoredHistory({ error: 'not found' })).toEqual({});
    expect(parseStoredHistory({ version: 2, series: {} })).toEqual({});
  });

  test('merges proxy and browser samples, proxy winning the same minute', () => {
    const server: QuotaHistory = {
      'a#weekly': {
        provider: 'codex',
        periodHours: 168,
        points: [
          { t: 10 * MIN, v: 90, r: 100 * MIN },
          { t: 30 * MIN, v: 70, r: 100 * MIN },
        ],
      },
    };
    const local: QuotaHistory = {
      'a#weekly': {
        provider: 'codex',
        periodHours: 168,
        points: [
          { t: 20 * MIN, v: 80, r: 100 * MIN },
          { t: 30 * MIN + 10_000, v: 71, r: 100 * MIN },
        ],
      },
      'x#weekly': {
        provider: 'xai',
        periodHours: 168,
        points: [{ t: 5 * MIN, v: 50, r: 9 * MIN }],
      },
    };
    const merged = mergeHistory(server, local);
    expect(merged['a#weekly'].points.map((point) => [point.t / MIN, point.v])).toEqual([
      [10, 90],
      [20, 80],
      [30, 70],
    ]);
    // Providers the proxy does not record keep the browser's samples.
    expect(merged['x#weekly']).toBe(local['x#weekly']);
    // Inputs are not modified.
    expect(server['a#weekly'].points).toHaveLength(2);
    expect(local['a#weekly'].points).toHaveLength(2);
  });

  test('the proxy label needs a proxy series for an account on the page', () => {
    const history = parseStoredHistory(PROXY_BODY);
    expect(hasSeriesFor({}, [{ id: 'codex-a.json' }])).toBe(false);
    expect(hasSeriesFor(history, [{ id: 'xai-c.json' }])).toBe(false);
    expect(hasSeriesFor(history, [{ id: 'xai-c.json' }, { id: 'codex-a.json' }])).toBe(true);
  });

  test('server-recorded hint exists in six locales', async () => {
    for (const locale of ['en', 'ko', 'ru', 'vi', 'zh-CN', 'zh-TW']) {
      const json = await Bun.file(`src/i18n/locales/${locale}.json`).json();
      const forecast = json.quota_management.forecast;
      const value = forecast?.hint_since_server;
      expect(typeof value === 'string' && value.includes('{{date}}')).toBe(true);
    }
  });
});
