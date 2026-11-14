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
 * Codex's summary count is authoritative; credit details can be partial. Missing
 * credits become undated account resets so the count and breakdown still agree.
 */
export const padToSummaryCount = (items: ResetItem[], summary: number): ResetItem[] => {
  const listed = items.reduce((sum, item) => sum + item.left, 0);
  if (summary <= listed) return items;
  return [
    ...items,
    { kind: 'account', label: '', model: null, left: summary - listed, expiresAt: null },
  ];
};
