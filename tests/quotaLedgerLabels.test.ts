import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n';
import { ledgerWindowLabel } from '../src/features/quota/home/windowLabels';
import { QuotaLedger } from '../src/features/quota/home/QuotaLedger';
import { buildQuotaAccount, classifyLimits } from '../src/features/quota/home/fromQuota';
import { buildClaudeQuotaWindows } from '../src/features/quota/providers/claude/data';

const now = Date.UTC(2026, 9, 29, 12);
const reset = new Date(now + 86400000).toISOString();
const t = i18n.getFixedT('en');
const windows = buildClaudeQuotaWindows(
  {
    five_hour: { utilization: 20, resets_at: reset },
    seven_day: { utilization: 30, resets_at: reset },
    limits: [
      {
        kind: 'weekly_scoped',
        percent: 40,
        resets_at: reset,
        is_active: true,
        scope: { model: { display_name: 'Fable 5' } },
      },
    ],
  },
  t
);
const limits = classifyLimits('claude', { windows });

describe('ledger window labels', () => {
  test('formats Claude weekly, session and provider-scoped model names consistently', () => {
    expect(ledgerWindowLabel('claude', limits.weekly, 'weekly', t)).toBe('7-day • Weekly');
    expect(ledgerWindowLabel('claude', limits.fiveHour, 'session', t)).toBe('5-hour • Session');
    expect(ledgerWindowLabel('claude', limits.fable, 'fable', t)).toBe('7-day • Fable 5');
  });

  test('formats Codex from the actual window duration, including a monthly plan', () => {
    const limit = { label: 'Monthly limit', periodHours: 168, remainingPct: 50, resetsAt: now };
    expect(ledgerWindowLabel('codex', limit, 'weekly', t)).toBe('7-day • Weekly');
    expect(ledgerWindowLabel('codex', { ...limit, periodHours: 720 }, 'weekly', t)).toBe(
      'Monthly limit'
    );
    expect(ledgerWindowLabel('codex', { ...limit, periodHours: 5 }, 'session', t)).toBe(
      '5-hour • Session'
    );
  });

  test('preserves custom labels and leaves absent windows absent', () => {
    const limit = { label: 'Provider pool', remainingPct: 50, resetsAt: now };
    expect(ledgerWindowLabel('claude', null, 'fable', t)).toBeUndefined();
    expect(ledgerWindowLabel('claude', limit, 'weekly', t)).toBe('Provider pool');
    expect(ledgerWindowLabel('antigravity', { ...limit, periodHours: 168 }, 'weekly', t)).toBe(
      'Provider pool'
    );
  });

  test.each(['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'])(
    'localizes every window scope and duration in %s',
    (language) => {
      const translate = i18n.getFixedT(language);
      for (const [kind, limit] of [
        ['weekly', limits.weekly],
        ['session', limits.fiveHour],
        ['fable', limits.fable],
      ] as const) {
        const label = ledgerWindowLabel('claude', limit, kind, translate);
        expect(label).toContain(' • ');
        expect(label).not.toContain('quota_management');
      }
    }
  );

  test('renders normalized labels in the ledger itself', async () => {
    await i18n.changeLanguage('en');
    const account = buildQuotaAccount(
      { file: { name: 'fixture.json', type: 'claude' }, type: 'claude' },
      'fixture',
      { status: 'success', windows },
      { describeError: (_, message) => message }
    );
    const markup = renderToStaticMarkup(
      createElement(QuotaLedger, {
        accounts: [account],
        now,
        redact: true,
        theme: 'light',
        groupBy: 'none',
        actions: { canAct: false, noteFor: () => '', onRename: async () => {} },
        renderResets: () => null,
      })
    );
    expect(markup).toContain('7-day • Weekly');
    expect(markup).toContain('5-hour • Session');
    expect(markup).toContain('7-day • Fable 5');
    expect(markup).not.toContain('<span>7-day limit</span>');
  });
});
