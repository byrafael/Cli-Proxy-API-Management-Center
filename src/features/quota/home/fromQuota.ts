/**
 * 把「认证文件 + 各提供商额度状态」归一成首页的 QuotaAccount。
 *
 * 纯函数，无 React、无时钟：各提供商的状态形状不同（窗口放在 windows / rows /
 * groups.buckets / billing / data.windows），这里按提供商结构化读取，不改动它们的 data 层。
 *
 * 归类规则：
 * - Claude / Codex 按窗口 id 精确取：five-hour、seven-day|weekly；Claude 另取 seven-day-fable。
 * - 其余提供商没有稳定 id，按周期归类：≤24h 的归「5 小时」列，24h–8d 的归「每周」列；
 *   同一类里有多个窗口（例如 Antigravity 的多个模型桶）时取剩余最少的那个，
 *   因为真正限制你的是最先耗尽的那个。
 */

import { parseIsoToMs } from '@/utils/quota';
import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from '../logic';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import type { PlanTier, QuotaAccount, QuotaLimit } from './model';

const SHORT_WINDOW_MAX_HOURS = 24;
const WEEKLY_WINDOW_MAX_HOURS = 24 * 8;

interface NormalizedWindow {
  id: string;
  /** 剩余百分比 0–100。 */
  remaining: number;
  resetsAt: number;
  periodHours: number | null;
}

const clampPct = (value: number): number => Math.min(100, Math.max(0, value));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** 秒或毫秒的 epoch、或 ISO 字符串 → 毫秒；无法识别返回 null。 */
export const readTimestamp = (value: unknown): number | null => {
  if (isFiniteNumber(value)) {
    if (value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return readTimestamp(numeric);
    return parseIsoToMs(value);
  }
  return null;
};

/* ---------- 套餐 ---------- */

const CLAUDE_PLAN_LABEL: Record<string, string> = {
  plan_max: 'Max',
  plan_pro: 'Pro',
  plan_team: 'Team',
  plan_free: 'Free',
};

const prettifyPlan = (raw: string): string =>
  raw
    .replace(/^plan[_-]/i, '')
    .replace(/^self[_-]?serve[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());

/**
 * 从展示名推档位，用于「按套餐分组」。
 * 同一个词在不同提供商含义不同：Claude 的 Pro 是入门付费档，ChatGPT 的 Pro 是最高档，
 * 所以先按提供商分流。Business/Team/Enterprise 一律归 team（含 ProLite 之类的变体）。
 */
export const planTierFor = (provider: QuotaProviderType, label: string | null): PlanTier => {
  if (!label) return 'unknown';
  const text = label.toLowerCase();
  if (/team|business|enterprise|edu/.test(text)) return 'team';
  if (/free|trial/.test(text)) return 'free';
  if (provider === 'claude') {
    if (/\bmax\b/.test(text)) return 'max';
    if (/\bpro\b/.test(text)) return 'pro';
    return 'unknown';
  }
  if (provider === 'codex') {
    if (/\bpro\b/.test(text)) return 'max';
    if (/plus|go/.test(text)) return 'pro';
    return 'unknown';
  }
  if (/ultra|\bmax\b|supergrok heavy|heavy/.test(text)) return 'max';
  if (/pro|plus|paid|premium|moderato|basic|standard|supergrok/.test(text)) return 'pro';
  return 'unknown';
};

const readPlan = (provider: QuotaProviderType, quota: Record<string, unknown>): string | null => {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;

  if (provider === 'claude') {
    const raw = text(quota.planType);
    return raw ? (CLAUDE_PLAN_LABEL[raw] ?? prettifyPlan(raw)) : null;
  }
  if (provider === 'codex') {
    const raw = text(quota.planType);
    return raw ? prettifyPlan(raw) : null;
  }
  if (provider === 'antigravity' || provider === 'plugin') {
    const subscription = quota.subscription as { tierName?: unknown; plan?: unknown } | null;
    const raw = text(subscription?.tierName) ?? text(subscription?.plan);
    return raw ? prettifyPlan(raw).replace(/^(Antigravity|Gemini)\s+/i, '') : null;
  }
  if (provider === 'devin') {
    const raw = text(quota.plan);
    return raw ? prettifyPlan(raw) : null;
  }
  if (provider === 'meta') {
    return text((quota.data as { planName?: unknown } | undefined)?.planName);
  }
  if (provider === 'xai') {
    const raw = text((quota.billing as { planType?: unknown } | null)?.planType);
    return raw ? prettifyPlan(raw) : null;
  }
  return null;
};

const readSubscriptionEnd = (
  provider: QuotaProviderType,
  quota: Record<string, unknown>
): number | null => {
  if (provider === 'codex') return readTimestamp(quota.subscriptionActiveUntil);
  if (provider === 'devin') return readTimestamp(quota.planEndMs);
  return null;
};

/* ---------- 窗口 ---------- */

interface WindowLike {
  id?: unknown;
  usedPercent?: unknown;
  remainingPercent?: unknown;
  resetAtMs?: unknown;
  periodHours?: unknown;
}

const fromWindowLike = (window: WindowLike, index: number): NormalizedWindow | null => {
  const resetsAt = readTimestamp(window.resetAtMs);
  if (resetsAt === null) return null;
  let remaining: number | null = null;
  if (isFiniteNumber(window.remainingPercent)) remaining = window.remainingPercent;
  else if (isFiniteNumber(window.usedPercent)) remaining = 100 - window.usedPercent;
  if (remaining === null) return null;
  return {
    id: typeof window.id === 'string' ? window.id : `window-${index}`,
    remaining: clampPct(remaining),
    resetsAt,
    periodHours: isFiniteNumber(window.periodHours) ? window.periodHours : null,
  };
};

const collectWindows = (
  provider: QuotaProviderType,
  quota: Record<string, unknown>
): NormalizedWindow[] => {
  const keep = (list: (NormalizedWindow | null)[]) =>
    list.filter((window): window is NormalizedWindow => window !== null);

  if (provider === 'claude' || provider === 'codex' || provider === 'devin') {
    return keep(((quota.windows as WindowLike[] | undefined) ?? []).map(fromWindowLike));
  }

  if (provider === 'antigravity' || provider === 'plugin') {
    const buckets = (
      (quota.groups as { buckets?: (WindowLike & { remainingFraction?: unknown })[] }[]) ?? []
    ).flatMap((group) => group.buckets ?? []);
    return keep(
      buckets.map((bucket, index) =>
        fromWindowLike(
          {
            ...bucket,
            remainingPercent: isFiniteNumber(bucket.remainingFraction)
              ? bucket.remainingFraction * 100
              : undefined,
          },
          index
        )
      )
    );
  }

  if (provider === 'kimi') {
    const rows = (quota.rows as (WindowLike & { used?: unknown; limit?: unknown })[]) ?? [];
    return keep(
      rows.map((row, index) =>
        fromWindowLike(
          {
            ...row,
            remainingPercent:
              isFiniteNumber(row.used) && isFiniteNumber(row.limit) && row.limit > 0
                ? ((row.limit - row.used) / row.limit) * 100
                : undefined,
          },
          index
        )
      )
    );
  }

  if (provider === 'meta') {
    const windows =
      (
        quota.data as
          | { windows?: { id: string; usedPercent: number | null; resetAt?: number }[] }
          | undefined
      )?.windows ?? [];
    return keep(
      windows.map((window, index) =>
        fromWindowLike(
          {
            id: window.id,
            usedPercent: window.usedPercent,
            resetAtMs: isFiniteNumber(window.resetAt) ? window.resetAt * 1000 : null,
            periodHours: window.id === 'weekly' ? 24 * 7 : null,
          },
          index
        )
      )
    );
  }

  if (provider === 'xai') {
    const billing = quota.billing as {
      periodType?: string;
      usagePercent?: number | null;
      resetAtMs?: number | null;
      periodHours?: number | null;
    } | null;
    // 只有 weekly 是限流窗口；monthly 是计费周期，含义不同，不进来。
    if (!billing || billing.periodType !== 'weekly') return [];
    return keep([
      fromWindowLike(
        {
          id: 'xai:weekly',
          usedPercent: billing.usagePercent,
          resetAtMs: billing.resetAtMs,
          periodHours: billing.periodHours ?? 24 * 7,
        },
        0
      ),
    ]);
  }

  return [];
};

const toLimit = (window: NormalizedWindow | undefined): QuotaLimit | null =>
  window ? { remainingPct: window.remaining, resetsAt: window.resetsAt } : null;

const mostConstrained = (windows: NormalizedWindow[]): NormalizedWindow | undefined =>
  windows.reduce<NormalizedWindow | undefined>(
    (best, window) => (!best || window.remaining < best.remaining ? window : best),
    undefined
  );

export interface ClassifiedLimits {
  fiveHour: QuotaLimit | null;
  weekly: QuotaLimit | null;
  fable: QuotaLimit | null;
}

export const classifyLimits = (
  provider: QuotaProviderType,
  quota: Record<string, unknown>
): ClassifiedLimits => {
  const windows = collectWindows(provider, quota);

  if (provider === 'claude' || provider === 'codex') {
    const byId = (...ids: string[]) => windows.find((window) => ids.includes(window.id));
    return {
      fiveHour: toLimit(byId('five-hour')),
      weekly: toLimit(byId('seven-day', 'weekly')),
      fable: provider === 'claude' ? toLimit(byId('seven-day-fable')) : null,
    };
  }

  const short = windows.filter(
    (window) => window.periodHours !== null && window.periodHours <= SHORT_WINDOW_MAX_HOURS
  );
  const weekly = windows.filter(
    (window) =>
      window.periodHours !== null &&
      window.periodHours > SHORT_WINDOW_MAX_HOURS &&
      window.periodHours <= WEEKLY_WINDOW_MAX_HOURS
  );
  // 周期未知的窗口只在没有已归类的每周窗口时顶上，避免把短窗口误当周限额。
  const unknownPeriod = windows.filter((window) => window.periodHours === null);

  return {
    fiveHour: toLimit(mostConstrained(short)),
    weekly: toLimit(mostConstrained(weekly.length > 0 ? weekly : unknownPeriod)),
    fable: null,
  };
};

/* ---------- 账号 ---------- */

const stripJson = (name: string): string => name.replace(/\.json$/i, '');

const readString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** 凭证显示名：用户备注优先，其次后端 label，最后是文件名。绝不使用 account（可能是密钥）。 */
export const accountNameFor = (file: AuthFileItem): string =>
  readString(file.note) || readString(file.label) || stripJson(file.name);

export interface BuildAccountOptions {
  /** 把 HTTP 状态 + 原始消息变成给人看的文案（需要 i18n，所以由页面注入）。 */
  describeError: (status: number | undefined, message: string) => string;
}

export function buildQuotaAccount(
  entry: QuotaFileEntry,
  cacheKey: string,
  quota: QuotaCardState | undefined,
  options: BuildAccountOptions
): QuotaAccount {
  const { file, type } = entry;
  const state = (quota ?? { status: 'idle' }) as unknown as Record<string, unknown> &
    QuotaCardState;
  const loaded = state.status === 'success';
  const plan = loaded ? readPlan(type, state) : null;
  const limits = loaded
    ? classifyLimits(type, state)
    : { fiveHour: null, weekly: null, fable: null };

  return {
    id: cacheKey,
    provider: type,
    email: readString(file.email),
    name: accountNameFor(file),
    plan,
    planTier: planTierFor(type, plan),
    subscriptionEndsAt: loaded ? readSubscriptionEnd(type, state) : null,
    // 后端的 auth-files 列表目前不下发 token 到期；若以后下发会自动生效。
    authExpiresAt: readTimestamp(file.expired ?? file.expires_at ?? file.expiresAt),
    lastRefreshAt: readTimestamp(file.lastRefresh ?? file.last_refresh),
    ...limits,
    disabled: file.disabled === true,
    pending: state.status === 'idle' || state.status === 'loading',
    error:
      state.status === 'error'
        ? options.describeError(state.errorStatus, state.error ?? '')
        : undefined,
  };
}
