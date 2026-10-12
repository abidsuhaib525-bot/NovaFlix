/**
 * Whether it is safe to open a playback session yet.
 *
 * Subtitles must be known *before* the session is created: the backend builds
 * its host whitelist from the subtitle list at session-creation time, so a
 * subtitle discovered afterwards is rejected by the proxy with a 403 and fails
 * silently. This holds the session until the subtitle query settles.
 *
 * The wait is not unbounded. A slow or wedged upstream would otherwise leave the
 * player on a spinner forever, so a short fuse proceeds without subtitles —
 * worse to lose captions than the whole episode. The fuse is keyed to the
 * request, not global, so changing episode re-arms it instead of inheriting the
 * previous episode's expiry.
 */

import { useEffect, useState } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import type { SubtitleOption } from '@/types';

const SETTLE_TIMEOUT_MS = 5000;

export function usePlayerSetup(
  query: UseQueryResult<SubtitleOption[]>,
  hasResource: boolean,
  /** Identifies the underlying request; a change re-arms the timeout. */
  resetKey: string,
): boolean {
  // The key whose fuse has already burned. Not a boolean: a stale `true` from
  // the previous episode would let the next one through before it was ready.
  const [expiredKey, setExpiredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!hasResource || query.isFetched || query.isError) return;
    const id = window.setTimeout(() => setExpiredKey(resetKey), SETTLE_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [hasResource, query.isFetched, query.isError, resetKey]);

  if (!hasResource) return true;
  return query.isFetched || query.isError || expiredKey === resetKey;
}
