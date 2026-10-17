/**
 * LocalStorage Playback Progress Manager
 *
 * Persists resume positions locally with zero network latency.
 * Whenever a user returns, playback continues from their exact timestamp.
 * When a movie or episode finishes, the entry is automatically purged from localStorage.
 */

const STORAGE_PREFIX = 'novaflix_progress:';

interface StoredProgress {
  seconds: number;
  duration: number;
  savedAt: number;
}

export function getProgressKey(
  provider: string,
  id: string,
  season: number = 1,
  episode: number = 1,
): string {
  return `${STORAGE_PREFIX}${provider}:${id}:${season}:${episode}`;
}

/**
 * Saves playback progress to localStorage.
 * Automatically clears when the video has reached >= 95% completion or ended.
 */
export function saveLocalProgress(
  provider: string,
  id: string,
  season: number,
  episode: number,
  seconds: number,
  duration: number,
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const key = getProgressKey(provider, id, season, episode);

  // If completed (within last 15s or 95%+ of video), remove from localStorage
  if (duration > 0 && (seconds >= duration - 15 || seconds / duration >= 0.95)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }

  // Only record if at least 3 seconds in
  if (seconds >= 3 && Number.isFinite(seconds)) {
    try {
      const data: StoredProgress = {
        seconds: Math.floor(seconds),
        duration: Math.floor(duration || 0),
        savedAt: Date.now(),
      };
      window.localStorage.setItem(key, JSON.stringify(data));
    } catch {
      /* ignore quota or private browsing errors */
    }
  }
}

/**
 * Retrieves the stored progress in seconds.
 * Returns 0 if none exists, expired, or completed.
 */
export function getLocalProgress(
  provider: string,
  id: string,
  season: number = 1,
  episode: number = 1,
): number {
  if (typeof window === 'undefined' || !window.localStorage) return 0;
  const key = getProgressKey(provider, id, season, episode);
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as StoredProgress;
    if (!parsed || typeof parsed.seconds !== 'number') return 0;

    // Purge if completed
    if (parsed.duration > 0 && (parsed.seconds >= parsed.duration - 15 || parsed.seconds / parsed.duration >= 0.95)) {
      window.localStorage.removeItem(key);
      return 0;
    }

    // Expire entries older than 45 days
    if (Date.now() - parsed.savedAt > 45 * 24 * 3600 * 1000) {
      window.localStorage.removeItem(key);
      return 0;
    }

    return parsed.seconds;
  } catch {
    return 0;
  }
}

/**
 * Explicitly removes stored progress for an item (e.g. when completed).
 */
export function clearLocalProgress(
  provider: string,
  id: string,
  season: number = 1,
  episode: number = 1,
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const key = getProgressKey(provider, id, season, episode);
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
