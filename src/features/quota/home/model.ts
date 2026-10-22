/**
 * 额度首页数据模型：纯逻辑，无 React / SCSS，tests/quotaHomeModel.test.ts 直接消费。
 *
 * 所有「剩余」都按百分比表示（与现有 QuotaMeter 同口径：≥70 绿 / ≥30 琥珀 / <30 红）。
 * 各提供商的原始额度形状在 fromQuota.ts 里归一成这里的 QuotaAccount。
 */

import { QUOTA_TAB_ORDER } from '../constants';
import type { QuotaProviderType } from '../providers/types';

export const PROVIDER_ORDER: readonly QuotaProviderType[] = QUOTA_TAB_ORDER;

export const PROVIDER_LABEL: Record<QuotaProviderType, string> = {
  claude: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex',
  xai: 'xAI',
  kimi: 'Kimi',
  devin: 'Devin',
  meta: 'Meta',
  plugin: 'Plugin',
};

export type PlanTier = 'free' | 'pro' | 'max' | 'team' | 'unknown';

export const PLAN_TIER_ORDER: readonly PlanTier[] = ['max', 'team', 'pro', 'free', 'unknown'];

export interface QuotaLimit {
  /** Display name supplied by the provider quota response, when available. */
  label?: string;
  /** 剩余百分比，0–100。 */
  remainingPct: number;
  /** 窗口重置的绝对时刻（epoch ms）。 */
  resetsAt: number;
}

export type AccountStatus = 'ready' | 'limited' | 'expiring' | 'error' | 'disabled' | 'pending';

export interface QuotaAccount {
  /** 额度缓存键（getQuotaCacheKey），同时是列表 key。 */
  id: string;
  provider: QuotaProviderType;
  /** 空串 = 凭证没有邮箱（例如 API key 类）。 */
  email: string;
  name: string;
  /** 展示用套餐名；null = 提供商没给。 */
  plan: string | null;
  planTier: PlanTier;
  /** 订阅到期；null = 后端不提供（Claude 的 profile 不暴露）。 */
  /** access token 到期；null = Management API 没有下发。 */
  authExpiresAt: number | null;
  /** 最近一次 token 刷新，到期未知时用它代替。 */
  lastRefreshAt: number | null;
  fiveHour: QuotaLimit | null;
  weekly: QuotaLimit | null;
  /** 仅 Claude 的 weekly_scoped Fable 限额。 */
  fable: QuotaLimit | null;
  disabled?: boolean;
  /** 额度尚未加载完成（idle / loading）。 */
  pending?: boolean;
  error?: string;
}

export type GroupBy = 'provider' | 'email' | 'plan' | 'status' | 'none';

export const GROUP_BY_OPTIONS: readonly GroupBy[] = ['provider', 'email', 'plan', 'status', 'none'];

export type Tone = 'high' | 'medium' | 'low' | 'none';

export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 30;
export const LIMITED_THRESHOLD = 5;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 鉴权 1 小时内到期视为需要关注。 */
export const AUTH_SOON_MS = HOUR;
/** 订阅 7 天内到期视为需要关注。 */

export const toneFor = (remainingPct: number | null | undefined): Tone => {
  if (remainingPct === null || remainingPct === undefined) return 'none';
  if (remainingPct >= HIGH_THRESHOLD) return 'high';
  if (remainingPct >= MEDIUM_THRESHOLD) return 'medium';
  return 'low';
};

export const clampPct = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

export type TimeKind = 'window' | 'auth';

/** 时间列的着色：窗口重置是中性信息；鉴权临近到期才升温。 */
export const timeTone = (kind: TimeKind, deltaMs: number): Tone => {
  if (kind === 'window') return 'none';
  if (deltaMs <= 0) return 'low';
  if (kind === 'auth') {
    if (deltaMs <= AUTH_SOON_MS) return 'low';
    return deltaMs <= 6 * HOUR ? 'medium' : 'none';
  }
  return 'none';
};

/** 5h 窗口优先；没有 5h 的账号退到周窗口。 */
export const windowEndsAt = (account: QuotaAccount): number | null =>
  account.fiveHour?.resetsAt ?? account.weekly?.resetsAt ?? null;

/**
 * 窗口重置 / 登录到期里最早还没到的那个，用来给时间轴排序（最近的在前）。
 * 错误账号不看窗口；没有任何未来事件的排在有事件的后面。
 */
export const nextEventAt = (account: QuotaAccount, now: number): number => {
  const candidates = [
    account.error ? null : windowEndsAt(account),
    account.authExpiresAt,
  ].filter((value): value is number => value !== null && value > now);
  return candidates.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...candidates);
};

export const accountStatus = (account: QuotaAccount, now: number): AccountStatus => {
  if (account.disabled) return 'disabled';
  if (account.error) return 'error';
  if (account.pending) return 'pending';
  const limits = [account.fiveHour, account.weekly, account.fable];
  const exhausted = limits.some((limit) => limit !== null && limit.remainingPct <= LIMITED_THRESHOLD);
  if (exhausted) return 'limited';
  const authSoon = account.authExpiresAt !== null && account.authExpiresAt - now <= AUTH_SOON_MS;
  if (authSoon) return 'expiring';
  return 'ready';
};

/** 排序键：越需要处理越靠前。 */
export const STATUS_RANK: Record<AccountStatus, number> = {
  error: 0,
  limited: 1,
  expiring: 2,
  ready: 3,
  pending: 4,
  disabled: 5,
};

/* ---------- 格式化 ---------- */

export interface CountdownUnits {
  now: string;
  d: string;
  h: string;
  m: string;
}

const EN_UNITS: CountdownUnits = { now: 'now', d: 'd', h: 'h', m: 'm' };

/** "37m" · "1h 48m" · "3d 4h"；已过去的返回 units.now。单位由调用方按语言注入。 */
export const formatCountdown = (ms: number, units: CountdownUnits = EN_UNITS): string => {
  if (ms <= 0) return units.now;
  const totalMinutes = Math.max(1, Math.round(ms / MINUTE));
  if (totalMinutes < 60) return `${totalMinutes}${units.m}`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) {
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}${units.h}` : `${hours}${units.h} ${minutes}${units.m}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}${units.d}` : `${days}${units.d} ${restHours}${units.h}`;
};

const absoluteFormats = new Map<string, Intl.DateTimeFormat>();

/** "Oct 20, 1:43 AM"，按界面语言本地化；格式器按 locale 缓存。 */
export const formatAbsolute = (ts: number, locale = 'en-US'): string => {
  let format = absoluteFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    absoluteFormats.set(locale, format);
  }
  return format.format(ts);
};

const maskPart = (value: string): string =>
  value.length <= 2 ? `${value[0] ?? ''}•••` : `${value[0]}•••${value[value.length - 1]}`;

/**
 * m•••a@l•••n.studio —— 首尾字符 + 顶级域。只留首字母时 build@ 与 build2@ 会撞成同一个
 * 掩码，同一屏上分不清两个身份；首尾各留一位足以区分，又不泄露完整地址。
 */
export const maskEmail = (email: string): string => {
  const at = email.indexOf('@');
  if (at < 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${maskPart(local)}@${maskPart(host)}${tld}`;
};

/** 没有邮箱的凭证（API key 类）显示为 —，不回落到 account（它可能就是密钥本身）。 */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

/** 文本里夹带的邮箱（文件名、备注、标签常常就是邮箱）一并按脱敏处理。 */
export const redactEmailsIn = (text: string): string => text.replace(EMAIL_PATTERN, maskEmail);

export const displayEmail = (email: string, redact: boolean): string => {
  if (!email) return '—';
  return redact ? maskEmail(email) : email;
};

/**
 * 行的两行标题。后端的 label / 文件名经常就是邮箱本身：这时主行显示邮箱、副行显示提供商，
 * 不再把同一个邮箱写两遍；否则主行是备注 / 名称（脱敏时其中的邮箱同样被遮住），副行是邮箱。
 */
export const accountTitle = (
  account: QuotaAccount,
  redact: boolean
): { primary: string; secondary: string } => {
  const name = account.name.trim();
  const nameIsEmail = account.email !== '' && name.toLowerCase() === account.email.toLowerCase();
  if (nameIsEmail) {
    return {
      primary: displayEmail(account.email, redact),
      secondary: PROVIDER_LABEL[account.provider],
    };
  }
  return {
    primary: redact ? redactEmailsIn(name) : name,
    secondary: displayEmail(account.email, redact),
  };
};

/* ---------- 分组 ---------- */

export interface AccountGroup {
  /** 分组键：provider id / 档位 / 状态 / 邮箱（无邮箱为 'none'）/ 'all'。标题由界面按语言生成。 */
  key: string;
  /** provider 分组时用于取图标。 */
  provider?: QuotaProviderType;
  /** email 分组时的真实邮箱（空串 = 无邮箱），展示前须经 displayEmail。 */
  email?: string;
  accounts: QuotaAccount[];
  readyCount: number;
}

const countReady = (accounts: QuotaAccount[], now: number): number =>
  accounts.filter((account) => accountStatus(account, now) === 'ready').length;

const withReady = (
  groups: Omit<AccountGroup, 'readyCount'>[],
  now: number
): AccountGroup[] =>
  groups.map((group) => ({ ...group, readyCount: countReady(group.accounts, now) }));

export const groupAccounts = (accounts: QuotaAccount[], by: GroupBy, now: number): AccountGroup[] => {
  if (by === 'none') {
    return withReady([{ key: 'all', accounts }], now);
  }

  if (by === 'provider') {
    return withReady(
      PROVIDER_ORDER.map((provider) => ({
        key: provider,
        provider,
        accounts: accounts.filter((account) => account.provider === provider),
      })).filter((group) => group.accounts.length > 0),
      now
    );
  }

  if (by === 'plan') {
    return withReady(
      PLAN_TIER_ORDER.map((tier) => ({
        key: tier,
        accounts: accounts.filter((account) => account.planTier === tier),
      })).filter((group) => group.accounts.length > 0),
      now
    );
  }

  if (by === 'status') {
    const order: AccountStatus[] = ['error', 'limited', 'expiring', 'ready', 'pending', 'disabled'];
    return withReady(
      order
        .map((status) => ({
          key: status,
          accounts: accounts.filter((account) => accountStatus(account, now) === status),
        }))
        .filter((group) => group.accounts.length > 0),
      now
    );
  }

  const byEmail = new Map<string, QuotaAccount[]>();
  accounts.forEach((account) => {
    const bucket = byEmail.get(account.email) ?? [];
    bucket.push(account);
    byEmail.set(account.email, bucket);
  });
  return withReady(
    Array.from(byEmail.entries())
      .sort(([emailA, a], [emailB, b]) => b.length - a.length || emailA.localeCompare(emailB))
      .map(([email, list]) => ({ key: email || 'none', email, accounts: list })),
    now
  );
};

/* ---------- 汇总 ---------- */

export interface QuotaSummary {
  total: number;
  ready: number;
  limited: number;
  needsAttention: number;
  /** 最近一次「额度恢复」：只统计当前已耗尽账号的窗口重置。 */
  nextRecoveryAt: number | null;
  nextRecoveryAccount: QuotaAccount | null;
}

export const summarize = (accounts: QuotaAccount[], now: number): QuotaSummary => {
  let ready = 0;
  let limited = 0;
  let needsAttention = 0;
  let nextRecoveryAt: number | null = null;
  let nextRecoveryAccount: QuotaAccount | null = null;

  accounts.forEach((account) => {
    const status = accountStatus(account, now);
    if (status === 'ready') ready += 1;
    if (status === 'limited') {
      limited += 1;
      const recovery = windowEndsAt(account);
      if (recovery !== null && recovery > now && (nextRecoveryAt === null || recovery < nextRecoveryAt)) {
        nextRecoveryAt = recovery;
        nextRecoveryAccount = account;
      }
    }
    if (status === 'error' || status === 'expiring') needsAttention += 1;
  });

  return {
    total: accounts.length,
    ready,
    limited,
    needsAttention,
    nextRecoveryAt,
    nextRecoveryAccount,
  };
};

export const filterAccounts = (accounts: QuotaAccount[], query: string, redact: boolean): QuotaAccount[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return accounts;
  return accounts.filter((account) => {
    const haystack = [
      // 名称里可能带真实邮箱：脱敏时只拿遮住后的文本参与搜索。
      redact ? redactEmailsIn(account.name) : account.name,
      account.plan,
      PROVIDER_LABEL[account.provider],
      // 脱敏时不允许按真实邮箱搜索，避免通过搜索结果反推。
      redact ? '' : account.email,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
};
