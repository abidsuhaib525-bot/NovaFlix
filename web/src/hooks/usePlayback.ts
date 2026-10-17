/**
 * Playback session hook: stream selection, Shaka wiring, and progress saves.
 *
 * Kept out of `WatchPage.tsx` because the page is view code; everything here is
 * behaviour that can break silently and is easier to reason about in isolation.
 *
 * The chain this drives, in order:
 *
 * 1. `/api/streams` lists the releases for the episode.
 * 2. The chosen release's mirror URL and headers go to
 *    `POST /api/playback/session`, which returns a *proxied* manifest URL. The
 *    browser cannot send the CDN's auth headers itself, so every byte flows
 *    through the backend.
 * 3. That URL is handed to Shaka Player. The player is imported dynamically:
 *    it is roughly a megabyte, and only the watch route pays for it.
 * 4. `timeupdate` drives periodic progress saves, throttled well below the
 *    rate the home page's continue-watching rail can absorb.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/lib/api';
import { clearLocalProgress, saveLocalProgress } from '@/lib/playbackProgress';
import type { PlaybackSessionResponse, PlaybackSubtitle, Release } from '@/types';

/** A session opened against the backend proxy, ready for a player. */
export interface PlaybackSetup {
  session: PlaybackSessionResponse;
  release: Release;
  /** Which release in the list was chosen, for the picker UI. */
  releaseIndex: number;
  /** Which mirror within that release, for the server picker. */
  mirrorIndex: number;
}

export interface PlaybackOptions {
  releases: Release[] | undefined;
  /** `resource_id` of the release picked on the details page, if any. */
  resourceId: string | null | undefined;
  /** Mirror index picked on the details page, if any. */
  mirror: number | null | undefined;
  /** Height cap from the details page's quality picker. */
  quality: number | null | undefined;
  subtitle: string | null | undefined;
  /**
   * External subtitle tracks for the session.
   *
   * Carried to the backend so the proxy will accept their hosts; the player
   * registers them itself with `addTextTrackAsync`. The caller should hold the
   * session back until this list has settled, or the first fetch will race the
   * host whitelist.
   */
  subtitles?: PlaybackSubtitle[] | null;
  /**
   * Gate for opening a session at all. Callers use it to skip work whose
   * result they cannot show -- an unsupported codec, for instance.
   */
  enabled?: boolean;
}

/**
 * Which release a page would play, given the details page's hand-off.
 *
 * Exported because the codec check has to ask about *this* release before a
 * session exists, and answering that with `releases[0]` would check the wrong
 * one the moment a details page points at a specific `resource_id`.
 */
export function pickRelease(
  releases: Release[] | undefined,
  resourceId: string | null | undefined,
  mirror: number | null | undefined,
): { release: Release; releaseIndex: number; mirrorIndex: number } | null | undefined {
  if (!releases || releases.length === 0) return undefined;
  const mirrorIndex = mirror ?? 0;
  if (resourceId) {
    const byId = releases.findIndex((r) => r.resource_id === resourceId);
    if (byId >= 0) return { release: releases[byId]!, releaseIndex: byId, mirrorIndex };
  }

  const hevcSupported = isHevcSupported();

  // If the device does NOT support HEVC, prioritize an H.264 / AVC release first!
  if (!hevcSupported) {
    const avcIndex = releases.findIndex((r) => {
      if (!r.mirrors || r.mirrors.length === 0) return false;
      const c = (r.codec || '').toLowerCase();
      return !c.includes('hevc') && !c.includes('265') && !c.includes('hvc') && !c.includes('hev');
    });
    if (avcIndex >= 0) {
      return { release: releases[avcIndex]!, releaseIndex: avcIndex, mirrorIndex };
    }
  }

  // No explicit pick: the first release with a playable mirror. The provider
  // orders releases best-quality first, so "first" is the right default.
  const first = releases.findIndex((r) => r.mirrors && r.mirrors.length > 0);
  if (first < 0) return null;
  return { release: releases[first]!, releaseIndex: first, mirrorIndex };
}

/**
 * Pick a release and open a session for it.
 *
 * Three states, distinguished because collapsing them makes the page lie:
 *
 * - `undefined` — nothing decided yet: streams are loading, or the session
 *   request is in flight. Show a spinner.
 * - `null` — decided and unplayable: no release has a mirror, or the session
 *   request failed. Show an explanation.
 * - a setup — a session is live, point the player at it.
 *
 * A single `null` for the first two states was the original version, and it
 * made every visit flash "No playable source" while the session was still
 * being created.
 */
export function usePlayback({
  releases,
  resourceId,
  mirror,
  quality,
  subtitle,
  subtitles,
  enabled = true,
}: PlaybackOptions): PlaybackSetup | null | undefined {
  const [setup, setSetup] = useState<PlaybackSetup | null | undefined>(undefined);
  // The session request is keyed on what would change the upstream URL.
  const sessionKeyRef = useRef<string | null>(null);
  const setupRef = useRef<PlaybackSetup | null | undefined>(undefined);
  setupRef.current = setup;

  const chosen = useMemo(
    () => pickRelease(releases, resourceId, mirror),
    [releases, resourceId, mirror],
  );

  useEffect(() => {
    if (!enabled) {
      setSetup(undefined);
      sessionKeyRef.current = null;
      return;
    }
    if (chosen === undefined) {
      setSetup(undefined);
      return;
    }
    if (chosen === null) {
      setSetup(null);
      return;
    }

    const { release, releaseIndex, mirrorIndex } = chosen;
    const mirrorUrl = release.mirrors[mirrorIndex] ?? release.mirrors[0];
    if (!mirrorUrl) {
      setSetup(null);
      return;
    }

    const key = `${release.resource_id ?? release.filename}:${mirrorIndex}:${quality ?? 0}`;
    // If a working session already exists for this exact key, don't recreate it
    if (sessionKeyRef.current === key && setupRef.current !== undefined && setupRef.current !== null) {
      return;
    }

    let cancelled = false;
    setSetup(undefined);

    // Timeout guard so the UI never hangs indefinitely if the backend or proxy network stalls
    const timeoutTimer = setTimeout(() => {
      if (!cancelled) {
        console.warn('Playback session creation timed out after 12s for key:', key);
        sessionKeyRef.current = null;
        setSetup(null);
      }
    }, 12000);

    api
      .createPlaybackSession({
        provider: release.provider,
        url: mirrorUrl.resolver_url,
        headers: mirrorUrl.headers,
        subtitle: subtitle ?? null,
        subtitles: subtitles ?? [],
        source_label: mirrorUrl.label || release.filename,
        max_height: quality && quality > 0 ? quality : null,
      })
      .then((session) => {
        clearTimeout(timeoutTimer);
        if (!cancelled) {
          sessionKeyRef.current = key;
          setSetup({ session, release, releaseIndex, mirrorIndex });
        }
      })
      .catch((err) => {
        clearTimeout(timeoutTimer);
        if (!cancelled) {
          console.error('Failed to create playback session:', err);
          sessionKeyRef.current = null;
          setSetup(null);
        }
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutTimer);
      // If we got torn down before a successful setup completed, clear key so re-mount will run
      if (setupRef.current === undefined) {
        sessionKeyRef.current = null;
      }
    };
  }, [chosen, quality, subtitle, enabled]);

  return setup;
}

/**
 * HEVC codec strings worth probing, most capable last.
 */
const HEVC_PROBES = [
  'video/mp4; codecs="hev1.1.6.L93.B0"',
  'video/mp4; codecs="hev1.2.4.L120.90"',
  'video/mp4; codecs="hvc1.1.6.L93.B0"',
  'video/mp4; codecs="hvc1.2.4.L120.90"',
  'video/mp4; codecs="hevc"',
  'video/mp4; codecs="hvc1"',
  'video/mp4; codecs="hev1"',
];

/**
 * Robust detection of whether the current device supports HEVC/H.265.
 */
export function isHevcSupported(): boolean {
  if (typeof window === 'undefined') return true;

  // 1. Apple Ecosystem (iOS Safari, iPadOS, macOS Safari/WebKit):
  // iPhones (iPhone 7 and up), iPads, and Macs natively support hardware HEVC.
  const ua = window.navigator.userAgent;
  const isApple =
    /iPad|iPhone|iPod|Macintosh/.test(ua) ||
    (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  if (isApple) return true;

  // 2. Modern Android devices (Android 5.0+ / API 21+) have native hardware HEVC decoders
  if (/Android/i.test(ua)) return true;

  // 3. Probing HTMLMediaElement.canPlayType (supported across modern Chromium/Firefox with OS codecs)
  if (typeof document !== 'undefined') {
    try {
      const v = document.createElement('video');
      for (const p of HEVC_PROBES) {
        const can = v.canPlayType(p);
        if (can === 'probably' || can === 'maybe') return true;
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Probing MediaSource.isTypeSupported (Chromium MSE with hardware decode or OS codec)
  if (typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function') {
    for (const p of HEVC_PROBES) {
      try {
        if (MediaSource.isTypeSupported(p)) return true;
      } catch {
        /* ignore */
      }
    }
  }

  return false;
}

/**
 * True when this browser can decode the codec a release needs.
 */
export function browserSupportsCodec(release: Release | undefined): boolean {
  if (!release?.codec) return true;
  const codec = release.codec.toLowerCase();
  const isHevc =
    codec.includes('hevc') || codec.includes('265') || codec.includes('hvc') || codec.includes('hev');

  if (isHevc) {
    return isHevcSupported();
  }
  return true;
}

/**
 * Throttled `timeupdate` -> localStorage + `/api/history/progress`.
 * Automatically purges from localStorage when completed.
 */
export function useProgressSaver(
  enabled: boolean,
  payload: {
    subject_id: string;
    provider: string;
    title?: string;
    season: number;
    episode: number;
    cover_url?: string | null;
    release_year?: string;
  } | null,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const lastSave = useRef(0);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;

  useEffect(() => {
    if (!enabled) return;
    const video = videoRef.current;
    if (!video) return;

    const onTime = () => {
      const current = payloadRef.current;
      if (!current) return;
      const now = Date.now();
      if (video.duration <= 0 || Number.isNaN(video.duration)) return;

      const isCompleted = video.duration > 0 && video.currentTime / video.duration > 0.95;

      // Always update local storage
      if (isCompleted) {
        clearLocalProgress(current.provider, current.subject_id, current.season, current.episode);
      } else {
        saveLocalProgress(
          current.provider,
          current.subject_id,
          current.season,
          current.episode,
          video.currentTime,
          video.duration,
        );
      }

      // Throttle backend network calls
      if (now - lastSave.current < 2500) return;
      lastSave.current = now;

      void api.saveProgress({
        ...current,
        position: Math.floor(video.currentTime),
        duration: Math.floor(video.duration),
        completed: isCompleted,
      });
    };

    const onPause = () => {
      const current = payloadRef.current;
      if (!current || !video || video.duration <= 0) return;
      saveLocalProgress(
        current.provider,
        current.subject_id,
        current.season,
        current.episode,
        video.currentTime,
        video.duration,
      );
    };

    const onEnded = () => {
      const current = payloadRef.current;
      if (!current) return;
      clearLocalProgress(current.provider, current.subject_id, current.season, current.episode);
      void api.saveProgress({
        ...current,
        position: Math.floor(video.duration || 0),
        duration: Math.floor(video.duration || 0),
        completed: true,
      });
    };

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('timeupdate', onTime);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }, [enabled]);

  return videoRef;
}

/** Shaka error categories with user-friendly actionable guidance. */
export function describeShakaError(error: unknown): string {
  const e = error as { category?: number; code?: number; message?: string } | null;
  if (!e || typeof e.category !== 'number') {
    return error instanceof Error ? error.message : 'Unknown playback error';
  }
  // Category 1 = NETWORK, 2 = TEXT, 3 = MEDIA, 4 = MANIFEST, 8 = MEDIA
  if (e.category === 1) {
    if (e.code === 1001) {
      return 'Stream source returned a temporary HTTP error (1001). Please try another mirror or quality.';
    }
    return 'Network connection issue with the video stream. Please check your internet or try another mirror.';
  }
  if (e.category === 2) {
    return 'Subtitle track could not be loaded or parsed from this host.';
  }
  if (e.category === 3) {
    if (e.code === 3016) {
      return 'Media decoder error (3/3016). Your browser or hardware had trouble decoding this stream format. Please switch quality or try another mirror.';
    }
    return `Media stream decode error (${e.category}/${e.code}). Please try switching quality or source.`;
  }
  if (e.category === 4 && e.code === 4032) {
    return 'This stream requires a different video codec. Please switch to 1080p or 720p quality.';
  }
  if (e.category === 10) {
    return 'Lost connection to the stream. Please check that the server is online and reload.';
  }
  if (e.category === 8) {
    return 'The stream sent data this browser could not decode. Please select an alternative quality.';
  }
  return `Playback issue (${e.category}/${e.code}). Please try selecting another quality or mirror.`;
}
