/**
 * Per-credential request ownership: the most recently started quota read for a
 * credential owns its cache slot. Batch loads, live refresh, row refresh and
 * Codex reset each claim before fetching and commit only while they still own
 * the slot, so an older response can never overwrite a newer one.
 *
 * Session isolation stays with the cache generation in useQuotaStore; this
 * only orders requests within a session.
 */

const latestByKey = new Map<string, number>();
let sequence = 0;

export function claimQuotaRequest(cacheKey: string): number {
  sequence += 1;
  latestByKey.set(cacheKey, sequence);
  return sequence;
}

export function ownsQuotaRequest(cacheKey: string, token: number): boolean {
  return latestByKey.get(cacheKey) === token;
}
