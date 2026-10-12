/**
 * TanStack Query setup.
 *
 * One shared client for the whole app. Query keys are defined next to the hooks
 * that use them (`hooks/useCatalog.ts`) so that invalidating a list after a
 * mutation is a typo-proof lookup rather than a hand-written string.
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api';

/**
 * How long a successful response stays fresh.
 *
 * Long on purpose. This is a single-user localhost app talking to one server
 * with no intervening cache, so a refetch window buys nothing and costs a request
 * per component mount. Invalidation after an explicit action is what keeps the
 * UI correct.
 */
const STALE_TIME_MS = 60_000;

/**
 * Retries are suppressed for client errors.
 *
 * A 400 or 404 will fail identically every time, and retrying it just delays the
 * message the user needs to read. Network-level failures (status 0, thrown by
 * `request()` when the server is unreachable) do retry, because a server that was
 * down a moment ago may well be up now.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  // Three is enough to ride out a restart without hammering a server that is
  // genuinely gone.
  return failureCount < 3;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: STALE_TIME_MS,
      retry: shouldRetry,
      // No refetch on focus: the home page has several rails and a hero, and a
      // tab switch firing all of them at once is both slow and pointless when
      // nothing that feeds them has changed underneath the user.
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});