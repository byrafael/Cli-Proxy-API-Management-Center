import type { AnthropicResetGrantKind } from '@/services/api/claudeResetGrants';

/** One banked reset source (a Claude grant or a Codex credit) shown in the resets cell. */
export interface ResetItem {
  kind: AnthropicResetGrantKind;
  label: string;
  model: string | null;
  left: number;
  expiresAt: number | null;
}

/**
 * Codex's summary count is authoritative; credit details can be partial or stale.
 * Keep the soonest-expiring details up to the summary, then list any missing
 * credits as undated account resets, so the count and breakdown always agree.
 */
/** Counts from upstream can arrive fractional or negative; a reset count is a whole number. */
export const wholeCount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export const reconcileToSummaryCount = (items: ResetItem[], summary: number): ResetItem[] => {
  const sorted = [...items].sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  const kept: ResetItem[] = [];
  let remaining = wholeCount(summary);
  for (const item of sorted) {
    if (remaining === 0) break;
    const left = Math.min(item.left, remaining);
    kept.push(left === item.left ? item : { ...item, left });
    remaining -= left;
  }
  if (remaining > 0)
    kept.push({ kind: 'account', label: '', model: null, left: remaining, expiresAt: null });
  return kept;
};
