import { apiClient } from './client';

/**
 * The proxy's recorded quota history, in the same stored format the panel keeps
 * in localStorage. Older proxies have no such route; callers treat any failure
 * as "no server history" and keep using the browser's own samples.
 */
export const quotaHistoryApi = {
  /**
   * Pinned to the connection that starts the request, so a late reply (including a
   * 401) from a previous proxy never reaches the shared client's session handling.
   */
  get: (client = apiClient.captureConnection()) => client.get<unknown>('/quota/history'),
};
