import { expect, test } from 'bun:test';

const LOCALES = ['en', 'ko', 'ru', 'vi', 'zh-CN', 'zh-TW'];
const KEYS = [
  'limit_low',
  'limit_critical',
  'pool',
  'pool_next_reset',
  'pool_window_weekly',
  'pool_window_session',
  'pool_window_mixed',
  'pool_excluded',
  'pool_reset_tip',
];

test('pool and Low warning strings exist in every locale with their placeholders', async () => {
  for (const locale of LOCALES) {
    const home = (await Bun.file(`src/i18n/locales/${locale}.json`).json()).quota_management.home;
    for (const key of KEYS) expect(typeof home[key] === 'string' && home[key].trim()).toBeTruthy();
    expect(home.pool).toContain('<0>{{remaining}}%</0>');
    expect(home.pool).toContain('{{capacity}}%');
    expect(home.pool_next_reset).toContain('+{{gain}}%');
    expect(home.pool_next_reset).toContain('{{time}}');
    expect(home.pool_excluded).toContain('{{count}}');
  }
});
