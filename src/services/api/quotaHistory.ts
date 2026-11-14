import { apiClient } from './client';

/**
 * The proxy's recorded quota history, in the same stored format the panel keeps
 * in localStorage. Older proxies have no such route; callers treat any failure
 * as "no server history" and keep using the browser's own samples.
 */
export const quotaHistoryApi = {
  get: () => apiClient.get<unknown>('/quota/history'),
};
