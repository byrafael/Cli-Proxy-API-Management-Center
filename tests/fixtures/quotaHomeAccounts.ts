/**
 * Quota Lab 夹具：全部为虚构账号，字段形状来自真实 auth 文件
 * （codex: plan_type/expired/last_refresh；antigravity: expired；claude 不暴露订阅到期）。
 * 以偏移量描述，渲染时相对「现在」展开，倒计时才有意义。
 */

import { DAY, HOUR, MINUTE, type QuotaAccount, type QuotaProviderType, type PlanTier } from '../../src/features/quota/home/model';

interface Seed {
  id: string;
  provider: QuotaProviderType;
  email: string;
  name: string;
  plan: string;
  planTier: PlanTier;
  subscriptionInMs: number | null;
  authInMs: number;
  fiveHour: [remainingPct: number, resetsInMs: number] | null;
  weekly: [remainingPct: number, resetsInMs: number] | null;
  fable: [remainingPct: number, resetsInMs: number] | null;
  disabled?: boolean;
  error?: string;
}

const SEEDS: Seed[] = [
  {
    id: 'claude-maya-max',
    provider: 'claude',
    email: 'maya@lumen.studio',
    name: 'Maya · daily driver',
    plan: 'Max 20x',
    planTier: 'max',
    subscriptionInMs: null,
    authInMs: 6 * HOUR + 12 * MINUTE,
    fiveHour: [62, 1 * HOUR + 48 * MINUTE],
    weekly: [41, 3 * DAY + 4 * HOUR],
    fable: [78, 3 * DAY + 4 * HOUR],
  },
  {
    id: 'claude-maya-personal',
    provider: 'claude',
    email: 'maya.reyes@gmail.com',
    name: 'Personal',
    plan: 'Pro',
    planTier: 'pro',
    subscriptionInMs: null,
    authInMs: 2 * DAY + 3 * HOUR,
    fiveHour: [8, 37 * MINUTE],
    weekly: [55, 5 * DAY + 2 * HOUR],
    fable: null,
  },
  {
    id: 'claude-lumen-team',
    provider: 'claude',
    email: 'ops@lumen.studio',
    name: 'Lumen Team seat',
    plan: 'Team',
    planTier: 'team',
    subscriptionInMs: null,
    authInMs: 22 * HOUR,
    fiveHour: [94, 4 * HOUR + 12 * MINUTE],
    weekly: [88, 6 * DAY + 1 * HOUR],
    fable: [91, 6 * DAY + 1 * HOUR],
  },
  {
    id: 'claude-ci-a',
    provider: 'claude',
    email: 'build@lumen.studio',
    name: 'CI runner A',
    plan: 'Max 5x',
    planTier: 'max',
    subscriptionInMs: null,
    authInMs: 3 * DAY,
    fiveHour: [0, 2 * HOUR + 5 * MINUTE],
    weekly: [12, 1 * DAY + 9 * HOUR],
    fable: [3, 1 * DAY + 9 * HOUR],
  },
  {
    id: 'claude-ci-b',
    provider: 'claude',
    email: 'build2@lumen.studio',
    name: 'CI runner B',
    plan: 'Max 5x',
    planTier: 'max',
    subscriptionInMs: null,
    authInMs: 14 * MINUTE,
    fiveHour: [71, 3 * HOUR + 31 * MINUTE],
    weekly: [66, 4 * DAY + 11 * HOUR],
    fable: [80, 4 * DAY + 11 * HOUR],
  },
  {
    id: 'claude-kestrel',
    provider: 'claude',
    email: 'jon@kestrel.io',
    name: 'Kestrel',
    plan: 'Max 20x',
    planTier: 'max',
    subscriptionInMs: null,
    authInMs: -2 * HOUR,
    fiveHour: null,
    weekly: null,
    fable: null,
    error: 'Token revoked — sign in again',
  },
  {
    id: 'codex-maya',
    provider: 'codex',
    email: 'maya@lumen.studio',
    name: 'Maya · Codex',
    plan: 'ChatGPT Pro',
    planTier: 'max',
    subscriptionInMs: 18 * DAY + 3 * HOUR,
    authInMs: 8 * DAY,
    fiveHour: [83, 3 * HOUR + 40 * MINUTE],
    weekly: [47, 2 * DAY + 6 * HOUR],
    fable: null,
  },
  {
    id: 'codex-lumen',
    provider: 'codex',
    email: 'ops@lumen.studio',
    name: 'Lumen Business',
    plan: 'Business',
    planTier: 'team',
    subscriptionInMs: 41 * DAY,
    authInMs: 9 * DAY,
    fiveHour: [35, 52 * MINUTE],
    weekly: [71, 4 * DAY + 20 * HOUR],
    fable: null,
  },
  {
    id: 'codex-kestrel',
    provider: 'codex',
    email: 'jon@kestrel.io',
    name: 'Kestrel',
    plan: 'ChatGPT Plus',
    planTier: 'pro',
    subscriptionInMs: 4 * DAY + 7 * HOUR,
    authInMs: 6 * DAY,
    fiveHour: [100, 5 * HOUR],
    weekly: [92, 6 * DAY + 22 * HOUR],
    fable: null,
  },
  {
    id: 'codex-qa',
    provider: 'codex',
    email: 'qa@lumen.studio',
    name: 'QA bot',
    plan: 'ChatGPT Plus',
    planTier: 'pro',
    subscriptionInMs: 25 * DAY,
    authInMs: 5 * DAY,
    fiveHour: null,
    weekly: null,
    fable: null,
    disabled: true,
  },
  {
    id: 'codex-ci',
    provider: 'codex',
    email: 'build@lumen.studio',
    name: 'CI Codex',
    plan: 'ChatGPT Pro',
    planTier: 'max',
    subscriptionInMs: 9 * DAY,
    authInMs: 7 * DAY,
    fiveHour: [12, 4 * HOUR + 3 * MINUTE],
    weekly: [30, 3 * DAY + 1 * HOUR],
    fable: null,
  },
  {
    id: 'antigravity-maya',
    provider: 'antigravity',
    email: 'maya@lumen.studio',
    name: 'Maya · Antigravity',
    plan: 'Google AI Pro',
    planTier: 'pro',
    subscriptionInMs: 22 * DAY,
    authInMs: 50 * MINUTE,
    fiveHour: [90, 2 * HOUR + 15 * MINUTE],
    weekly: [64, 5 * DAY],
    fable: null,
  },
  {
    id: 'antigravity-kestrel',
    provider: 'antigravity',
    email: 'dev@kestrel.io',
    name: 'Kestrel sandbox',
    plan: 'Free',
    planTier: 'free',
    subscriptionInMs: null,
    authInMs: 5 * DAY,
    fiveHour: [40, 1 * HOUR + 5 * MINUTE],
    weekly: [20, 2 * DAY + 14 * HOUR],
    fable: null,
  },
  {
    id: 'kimi-maya',
    provider: 'kimi',
    email: 'maya@lumen.studio',
    name: 'Maya · Kimi',
    plan: 'Moderato',
    planTier: 'pro',
    subscriptionInMs: 12 * DAY,
    authInMs: 11 * DAY,
    fiveHour: [77, 2 * HOUR + 50 * MINUTE],
    weekly: [59, 4 * DAY + 2 * HOUR],
    fable: null,
  },
  {
    id: 'xai-kestrel',
    provider: 'xai',
    email: 'dev@kestrel.io',
    name: 'Kestrel Grok',
    plan: 'SuperGrok',
    planTier: 'pro',
    subscriptionInMs: 27 * DAY,
    authInMs: 13 * DAY,
    fiveHour: null,
    weekly: [74, 3 * DAY + 8 * HOUR],
    fable: null,
  },
];

const limit = (pair: [number, number] | null, now: number) =>
  pair === null ? null : { remainingPct: pair[0], resetsAt: now + pair[1] };

export const buildFixtureAccounts = (now: number): QuotaAccount[] =>
  SEEDS.map((seed) => ({
    id: seed.id,
    provider: seed.provider,
    email: seed.email,
    name: seed.name,
    plan: seed.plan,
    planTier: seed.planTier,
    subscriptionEndsAt: seed.subscriptionInMs === null ? null : now + seed.subscriptionInMs,
    authExpiresAt: now + seed.authInMs,
    lastRefreshAt: null,
    fiveHour: limit(seed.fiveHour, now),
    weekly: limit(seed.weekly, now),
    fable: limit(seed.fable, now),
    disabled: seed.disabled,
    error: seed.error,
  }));
