/**
 * Per-credential ordering for quota cache writes.
 *
 * Foreground writes — row refresh, Codex reset, Refresh all, the page's first
 * load, and the Auth Files quota actions — claim the credential. The most
 * recently started one owns the slot and is the only one allowed to commit.
 *
 * Background reads (live refresh) never claim the write slot. They skip a
 * credential while a foreground write is in flight, and commit only if no write
 * started since, so a periodic poll can never overwrite or discard a user's
 * action. Polls are also ordered among themselves: a newer poll for a
 * credential invalidates an older one (for example from a page instance the
 * user already left) without affecting any foreground write.
 *
 * Session isolation stays with the cache generation in useQuotaStore; this
 * only orders requests within a session.
 */

import type { QuotaAdapter, QuotaMapUpdater } from './providers';

const latestByKey = new Map<string, number>();
const activeByKey = new Map<string, number>();
const latestReadByKey = new Map<string, number>();
let sequence = 0;

export interface QuotaWrite {
  /** True while no later foreground write has started for this credential. */
  owns: () => boolean;
  /** Call once the write has committed or given up. Idempotent. */
  end: () => void;
}

export function beginQuotaWrite(cacheKey: string): QuotaWrite {
  sequence += 1;
  const token = sequence;
  latestByKey.set(cacheKey, token);
  activeByKey.set(cacheKey, (activeByKey.get(cacheKey) ?? 0) + 1);
  let ended = false;
  return {
    owns: () => latestByKey.get(cacheKey) === token,
    end: () => {
      if (ended) return;
      ended = true;
      const remaining = (activeByKey.get(cacheKey) ?? 1) - 1;
      if (remaining <= 0) activeByKey.delete(cacheKey);
      else activeByKey.set(cacheKey, remaining);
    },
  };
}

/**
 * Start a background read. Returns null while a foreground write is in flight;
 * otherwise a check that stays true until a foreground write or a newer poll
 * starts for the credential.
 */
export function beginQuotaRead(cacheKey: string): (() => boolean) | null {
  if (activeByKey.has(cacheKey)) return null;
  const seen = latestByKey.get(cacheKey) ?? 0;
  sequence += 1;
  const readToken = sequence;
  latestReadByKey.set(cacheKey, readToken);
  return () =>
    !activeByKey.has(cacheKey) &&
    (latestByKey.get(cacheKey) ?? 0) === seen &&
    latestReadByKey.get(cacheKey) === readToken;
}

/**
 * A failed mutation that superseded an in-flight read must not strand the row in
 * `loading`: the superseded read will never commit, so leave a terminal error.
 */
export function settleSupersededLoading(
  setQuota: QuotaMapUpdater,
  adapter: QuotaAdapter,
  cacheKey: string,
  message: string
): void {
  setQuota((prev) =>
    prev[cacheKey]?.status === 'loading'
      ? { ...prev, [cacheKey]: adapter.buildErrorState(message) }
      : prev
  );
}
