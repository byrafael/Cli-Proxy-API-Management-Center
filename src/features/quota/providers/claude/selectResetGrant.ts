import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrantKind,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** Prefer the upstream recommendation; otherwise use stable ID ordering. */
export function selectResetGrant(
  status: AnthropicResetGrantStatus,
  now: number,
  kind?: AnthropicResetGrantKind
) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return undefined;
  const usable = status.grants.filter(
    (grant) =>
      (!kind || grant.kind === kind) &&
      !anthropicResetGrantBlocker(status, grant.id) &&
      (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
      (!grant.endsAt || Date.parse(grant.endsAt) > now)
  );
  return (
    usable.find((grant) => grant.id === status.nextGrantId) ??
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  );
}
