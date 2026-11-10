/**
 * 混合提供商批量额度加载（原 useQuotaLoader 的跨分区泛化）。
 *
 * 保留的三道守卫与旧实现逐一对应：
 * - loadingRef：并发批量加载去重；
 * - requestIdRef：被超越的响应直接丢弃；
 * - cacheGeneration：断线重连后过期请求不得写入新会话缓存。
 * 提交按 provider 分组进行 —— 快的提供商先落地，不等慢的。
 *
 * A background load (live refresh) shows no loading state, so periodic reads
 * update numbers in place, and it yields to any foreground write on the same
 * credential (see requestOwnership.ts).
 */

import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter, type QuotaCardState } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';
import { beginQuotaRead, beginQuotaWrite } from '../requestOwnership';
import type { QuotaProviderType } from '../providers/types';

interface BatchFetchResult {
  name: string;
  cacheKey: string;
  status: 'success' | 'error';
  data?: unknown;
  error?: string;
  errorStatus?: number;
}

export interface QuotaBatchOptions {
  background?: boolean;
}

export function useQuotaBatchLoader() {
  const { t } = useTranslation();
  const [batchLoading, setBatchLoading] = useState(false);
  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    /**
     * Resolves true only when every target was read and committed for the current
     * session: false when another batch is in flight, a poll skipped a credential
     * held by a foreground write, a newer batch superseded this one, or the session
     * changed.
     */
    async (targets: QuotaFileEntry[], options: QuotaBatchOptions = {}): Promise<boolean> => {
      if (loadingRef.current) return false;
      if (targets.length === 0) return true;
      loadingRef.current = true;
      const requestId = ++requestIdRef.current;
      const cacheGeneration = captureQuotaCacheGeneration();
      setBatchLoading(true);
      let complete = true;

      try {
        const groups = new Map<QuotaProviderType, QuotaFileEntry[]>();
        targets.forEach((entry) => {
          const group = groups.get(entry.type) ?? [];
          group.push(entry);
          groups.set(entry.type, group);
        });

        await Promise.all(
          Array.from(groups.entries()).map(async ([type, entries]) => {
            const adapter = QUOTA_ADAPTERS[type];
            const setQuota = getQuotaSetter(adapter);
            const claims = entries.flatMap((entry) => {
              const cacheKey = getQuotaCacheKey(entry.file);
              if (options.background) {
                const canCommit = beginQuotaRead(cacheKey);
                return canCommit ? [{ entry, cacheKey, canCommit, end: () => {} }] : [];
              }
              const write = beginQuotaWrite(cacheKey);
              return [{ entry, cacheKey, canCommit: write.owns, end: write.end }];
            });
            if (claims.length < entries.length) complete = false;
            if (claims.length === 0) return;

            try {
              if (!options.background) {
                commitIfQuotaCacheCurrent(cacheGeneration, () => {
                  setQuota((prev) => {
                    const nextState = { ...prev };
                    claims.forEach(({ cacheKey }) => {
                      nextState[cacheKey] = adapter.buildLoadingState();
                    });
                    return nextState;
                  });
                });
              }

              const results = await Promise.all(
                claims.map(async ({ entry: { file }, cacheKey }): Promise<BatchFetchResult> => {
                  try {
                    const data = await adapter.fetchQuota(file, t);
                    return { name: file.name, cacheKey, status: 'success', data };
                  } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : t('common.unknown_error');
                    return {
                      name: file.name,
                      cacheKey,
                      status: 'error',
                      error: message,
                      errorStatus: getStatusFromError(err),
                    };
                  }
                })
              );

              if (requestId !== requestIdRef.current) {
                complete = false;
                return;
              }

              const committedStates = new Map<string, QuotaCardState>();
              setQuota((prev) => {
                const nextState = { ...prev };
                results.forEach((result, index) => {
                  // A later foreground write owns this credential now.
                  if (!claims[index].canCommit()) return;
                  commitIfQuotaCacheCurrent(
                    cacheGeneration,
                    () => {
                      nextState[result.cacheKey] =
                        result.status === 'success'
                          ? adapter.buildSuccessState(result.data)
                          : adapter.buildErrorState(
                              result.error || t('common.unknown_error'),
                              result.errorStatus
                            );
                      committedStates.set(result.cacheKey, nextState[result.cacheKey]);
                    },
                    result.name
                  );
                });
                return nextState;
              });
              results.forEach((result, index) => {
                const state = committedStates.get(result.cacheKey);
                if (result.status === 'success' && state) {
                  void enrichQuotaInBackground(
                    adapter,
                    claims[index].entry.file,
                    result.data,
                    state,
                    t
                  );
                }
              });
            } finally {
              claims.forEach(({ end }) => end());
            }
          })
        );
      } finally {
        if (requestId === requestIdRef.current) {
          setBatchLoading(false);
          loadingRef.current = false;
        }
      }
      let sessionCurrent = false;
      commitIfQuotaCacheCurrent(cacheGeneration, () => {
        sessionCurrent = true;
      });
      return complete && sessionCurrent;
    },
    [t]
  );

  return { batchLoading, loadQuota };
}
