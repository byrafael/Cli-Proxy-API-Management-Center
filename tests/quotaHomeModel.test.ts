import { describe, expect, test } from 'bun:test';
import { buildFixtureAccounts } from './fixtures/quotaHomeAccounts';
import { accountNameFor, classifyLimits, planTierFor, readTimestamp } from '../src/features/quota/home/fromQuota';
import {
  DAY,
  HOUR,
  MINUTE,
  accountStatus,
  accountTitle,
  filterAccounts,
  formatCountdown,
  formatResetDay,
  groupAccounts,
  lowLevel,
  maskEmail,
  providerPool,
  nextEventAt,
  redactEmailsIn,
  summarize,
  timeTone,
  toneFor,
  windowEndsAt,
} from '../src/features/quota/home/model';
import { isQuotaGroupBy } from '../src/features/quota/uiState';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const accounts = buildFixtureAccounts(NOW);
const byId = (id: string) => {
  const found = accounts.find((account) => account.id === id);
  if (!found) throw new Error(`missing fixture ${id}`);
  return found;
};

describe('quota home tones and formatting', () => {
  test('uses the same thresholds as the quota meter: red only below 5%', () => {
    expect(toneFor(70)).toBe('high');
    expect(toneFor(69)).toBe('medium');
    expect(toneFor(11)).toBe('medium');
    expect(toneFor(5)).toBe('medium');
    expect(toneFor(4)).toBe('low');
    expect(toneFor(null)).toBe('none');
  });

  test('warns Low below 15% and Very low below 5%', () => {
    expect(lowLevel(15)).toBeNull();
    expect(lowLevel(14)).toBe('low');
    expect(lowLevel(11)).toBe('low');
    expect(lowLevel(5)).toBe('low');
    expect(lowLevel(4)).toBe('critical');
    expect(lowLevel(0)).toBe('critical');
    expect(lowLevel(null)).toBeNull();
  });

  test('formats countdowns and takes injected units', () => {
    expect(formatCountdown(0)).toBe('now');
    expect(formatCountdown(37 * MINUTE)).toBe('37m');
    expect(formatCountdown(1 * HOUR + 48 * MINUTE)).toBe('1h 48m');
    expect(formatCountdown(3 * DAY + 4 * HOUR)).toBe('3d 4h');
    expect(formatCountdown(3 * DAY, { now: '现在', d: '天', h: '小时', m: '分钟' })).toBe('3天');
  });

  test('masks emails so distinct identities stay distinguishable', () => {
    expect(maskEmail('maya@lumen.studio')).toBe('m•••a@l•••n.studio');
    expect(maskEmail('not-an-email')).toBe('not-an-email');
    const emails = Array.from(new Set(accounts.map((account) => account.email)));
    expect(new Set(emails.map(maskEmail)).size).toBe(emails.length);
  });

  test('only auth warms up as it nears expiry', () => {
    expect(timeTone('window', 1)).toBe('none');
    expect(timeTone('auth', 10 * MINUTE)).toBe('low');
    expect(timeTone('auth', 3 * HOUR)).toBe('medium');
    expect(timeTone('auth', 2 * DAY)).toBe('none');
  });
});

describe('quota home status, grouping and ordering', () => {
  test('classifies each fixture archetype', () => {
    expect(accountStatus(byId('claude-maya-max'), NOW)).toBe('ready');
    expect(accountStatus(byId('claude-ci-a'), NOW)).toBe('limited');
    expect(accountStatus(byId('claude-ci-b'), NOW)).toBe('expiring');
    expect(accountStatus(byId('claude-kestrel'), NOW)).toBe('error');
    expect(accountStatus(byId('codex-qa'), NOW)).toBe('disabled');
  });

  test('an unknown auth expiry is never reported as expiring, and pending beats ready', () => {
    const base = byId('claude-maya-max');
    expect(accountStatus({ ...base, authExpiresAt: null }, NOW)).toBe('ready');
    expect(accountStatus({ ...base, pending: true }, NOW)).toBe('pending');
  });

  test('window end falls back to the weekly window', () => {
    const grok = byId('xai-kestrel');
    expect(windowEndsAt(grok)).toBe(grok.weekly?.resetsAt ?? null);
  });

  test('groups by provider, email, plan and status', () => {
    expect(groupAccounts(accounts, 'provider', NOW)[0].key).toBe('claude');
    expect(groupAccounts(accounts, 'email', NOW)[0].email).toBe('maya@lumen.studio');
    expect(groupAccounts(accounts, 'status', NOW)[0].key).toBe('error');
    expect(groupAccounts(accounts, 'none', NOW)).toHaveLength(1);
    const noEmail = [{ ...byId('claude-maya-max'), email: '' }];
    expect(groupAccounts(noEmail, 'email', NOW)[0].key).toBe('none');
  });

  test('orders the runway by the soonest upcoming event, with eventless accounts last', () => {
    const sorted = [...accounts].sort((a, b) => nextEventAt(a, NOW) - nextEventAt(b, NOW));
    expect(sorted[0].id).toBe('claude-ci-b');
    const none = { ...byId('claude-maya-max'), authExpiresAt: null, fiveHour: null, weekly: null };
    expect(nextEventAt(none, NOW)).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('summarises readiness and the next recovery', () => {
    const summary = summarize(accounts, NOW);
    expect(summary.total).toBe(15);
    expect(summary.nextRecoveryAccount?.id).toBe('claude-ci-a');
  });

  test('search never matches the real email while redaction is on', () => {
    expect(filterAccounts(accounts, 'kestrel.io', false).length).toBeGreaterThan(0);
    expect(filterAccounts(accounts, 'kestrel.io', true)).toHaveLength(0);
  });
});

describe('quota home provider mapping', () => {
  test('reads Claude windows by id including the Fable limit', () => {
    const limits = classifyLimits('claude', {
      windows: [
        { id: 'five-hour', usedPercent: 38, resetAtMs: NOW + HOUR, periodHours: 5 },
        { id: 'seven-day', usedPercent: 59, resetAtMs: NOW + 3 * DAY, periodHours: 168 },
        { id: 'seven-day-fable', usedPercent: 22, resetAtMs: NOW + 3 * DAY, periodHours: 168 },
      ],
    });
    expect(limits.fiveHour?.remainingPct).toBe(62);
    expect(limits.weekly?.remainingPct).toBe(41);
    expect(limits.fable?.remainingPct).toBe(78);
  });

  test('a Claude account without a Fable window has no Fable limit, and Codex never does', () => {
    const windows = [{ id: 'five-hour', usedPercent: 10, resetAtMs: NOW + HOUR, periodHours: 5 }];
    expect(classifyLimits('claude', { windows }).fable).toBeNull();
    expect(classifyLimits('codex', { windows }).fable).toBeNull();
  });

  test('other providers classify by period and surface the most constrained window', () => {
    const limits = classifyLimits('antigravity', {
      groups: [
        {
          buckets: [
            { id: 'a', remainingFraction: 0.9, resetAtMs: NOW + HOUR, periodHours: 5 },
            { id: 'b', remainingFraction: 0.2, resetAtMs: NOW + 2 * HOUR, periodHours: 5 },
            { id: 'c', remainingFraction: 0.6, resetAtMs: NOW + 3 * DAY, periodHours: 168 },
          ],
        },
      ],
    });
    expect(limits.fiveHour?.remainingPct).toBe(20);
    expect(limits.weekly?.remainingPct).toBe(60);
  });

  test('plugin quotas classify like antigravity', () => {
    const limits = classifyLimits('plugin', {
      groups: [
        {
          buckets: [
            { id: 'a', remainingFraction: 0.5, resetAtMs: NOW + HOUR, periodHours: 5 },
            { id: 'b', remainingFraction: 0.7, resetAtMs: NOW + 3 * DAY, periodHours: 168 },
          ],
        },
      ],
    });
    expect(limits.fiveHour?.remainingPct).toBe(50);
    expect(limits.weekly?.remainingPct).toBe(70);
  });

  test('xAI only exposes a weekly window; a monthly billing cycle is not a limit', () => {
    const weekly = classifyLimits('xai', {
      billing: { periodType: 'weekly', usagePercent: 26, resetAtMs: NOW + DAY },
    });
    expect(weekly.weekly?.remainingPct).toBe(74);
    const monthly = classifyLimits('xai', {
      billing: { periodType: 'monthly', usagePercent: 26, resetAtMs: NOW + DAY },
    });
    expect(monthly.weekly).toBeNull();
  });

  test('plan tiers depend on the provider: Pro is entry-level on Claude, top-level on Codex', () => {
    expect(planTierFor('claude', 'Pro')).toBe('pro');
    expect(planTierFor('claude', 'Max')).toBe('max');
    expect(planTierFor('codex', 'Pro')).toBe('max');
    expect(planTierFor('codex', 'Self Serve Business Prolite')).toBe('team');
    expect(planTierFor('codex', null)).toBe('unknown');
  });

  test('reads second and millisecond epochs and ISO strings', () => {
    expect(readTimestamp(1_792_000_000)).toBe(1_792_000_000_000);
    expect(readTimestamp(1_792_000_000_000)).toBe(1_792_000_000_000);
    expect(readTimestamp('2026-10-20T12:00:00Z')).toBe(NOW);
    expect(readTimestamp(null)).toBeNull();
    expect(readTimestamp(0)).toBeNull();
  });
});

describe('quota home email redaction', () => {
  const base = byId('claude-maya-max');

  test('redacts every email inside free text', () => {
    expect(redactEmailsIn('maya@lumen.studio')).toBe(maskEmail('maya@lumen.studio'));
    expect(redactEmailsIn('Maya <maya@lumen.studio> via jon@kestrel.io')).not.toContain('@lumen.studio');
    expect(redactEmailsIn('no addresses here')).toBe('no addresses here');
    expect(redactEmailsIn('429 too many requests for jon@kestrel.io, retry later')).not.toContain('kestrel.io');
  });

  test('a name that is the email never leaks when redacted', () => {
    const email = 'maya@lumen.studio';
    const account = { ...base, name: email, email };
    expect(accountTitle(account, true).primary).not.toContain('lumen.studio');
    expect(accountTitle(account, true).primary).toBe(maskEmail(email));
    expect(accountTitle(account, false).primary).toBe(email);
    // The email must not be repeated as a secondary line.
    expect(accountTitle(account, false).secondary).not.toBe(email);
  });

  test('a named account keeps its name and redacts only the email line', () => {
    const account = { ...base, name: 'Maya · daily driver', email: 'maya@lumen.studio' };
    const redacted = accountTitle(account, true);
    expect(redacted.primary).toBe('Maya · daily driver');
    expect(redacted.secondary).toBe(maskEmail('maya@lumen.studio'));
  });

  test('derives the display name from the file name without .json', () => {
    expect(accountNameFor({ name: 'maya-claude.json' } as never)).toBe('maya-claude');
  });

  test('a custom display name (note) wins over the label and file name, and clearing it falls back', () => {
    const file = { name: 'maya-claude.json', label: 'maya@lumen.studio' };
    expect(accountNameFor({ ...file, note: ' Maya · main ' } as never)).toBe('Maya · main');
    expect(accountNameFor({ ...file, note: '' } as never)).toBe('maya@lumen.studio');
  });
});

describe('quota home ui state', () => {
  test('validates persisted grouping', () => {
    expect(isQuotaGroupBy('email')).toBe(true);
    expect(isQuotaGroupBy('nope')).toBe(false);
  });
});

describe('provider pool', () => {
  const limit = (remainingPct: number, resetsAt: number) => ({ remainingPct, resetsAt });
  const base = {
    id: 'a',
    provider: 'codex' as const,
    email: 'a@x.dev',
    name: 'a',
    plan: null,
    planTier: 'unknown' as const,
    authExpiresAt: null,
    lastRefreshAt: null,
    fiveHour: null,
    weekly: null,
    fable: null,
  };

  test('sums remaining over primary limits against 100 per counted account', () => {
    const pool = providerPool(
      [
        { ...base, id: 'w1', weekly: limit(80, NOW + 2 * DAY), fiveHour: limit(10, NOW + HOUR) },
        { ...base, id: 'w2', weekly: limit(9, NOW + 3 * DAY) },
        { ...base, id: 's1', fiveHour: limit(50, NOW + 2 * HOUR) },
        { ...base, id: 'off', weekly: limit(100, NOW + DAY), disabled: true },
        { ...base, id: 'err', error: 'boom' },
        { ...base, id: 'wait', pending: true },
      ],
      NOW
    )!;
    expect(pool.remainingPct).toBe(139);
    expect(pool.capacityPct).toBe(300);
    expect(pool.accounts.map((a) => a.id)).toEqual(['w1', 'w2', 's1']);
    expect(pool.excluded).toBe(3);
    expect(pool.window).toBe('mixed');
    // The soonest primary reset that gives something back: s1's session, +50%.
    expect(pool.nextReset).toMatchObject({ at: NOW + 2 * HOUR, gainPct: 50 });
  });

  test('adds up accounts resetting together and skips full limits', () => {
    const pool = providerPool(
      [
        { ...base, id: 'full', weekly: limit(100, NOW + HOUR) },
        { ...base, id: 'a', weekly: limit(9, NOW + DAY) },
        { ...base, id: 'b', weekly: limit(40, NOW + DAY + 10 * MINUTE) },
        { ...base, id: 'later', weekly: limit(0, NOW + 2 * DAY) },
      ],
      NOW
    )!;
    expect(pool.window).toBe('weekly');
    expect(pool.nextReset?.at).toBe(NOW + DAY);
    expect(pool.nextReset?.gainPct).toBe(151);
    expect(pool.nextReset?.accounts.map((a) => a.id)).toEqual(['a', 'b']);
  });

  test('has no pool without a loaded limit, and no reset when nothing is used', () => {
    expect(providerPool([{ ...base, pending: true }], NOW)).toBeNull();
    const full = providerPool([{ ...base, fiveHour: limit(100, NOW + HOUR) }], NOW)!;
    expect(full.window).toBe('session');
    expect(full.nextReset).toBeNull();
  });

  test('formats a reset within the week by weekday, later ones by date', () => {
    // NOW is Tue Oct 20 12:00 UTC; three days later is a Friday in every zone near UTC.
    expect(formatResetDay(NOW + 3 * DAY, NOW, 'en-US')).toMatch(/^Fri \d{1,2}:00\s?[AP]M$/);
    expect(formatResetDay(NOW + 8 * DAY, NOW, 'en-US')).toMatch(/^Oct 28\b/);
  });
});
