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
  // No explicit pick: the first release with a playable mirror. The provider
  // orders releases best-quality first, so "first" is the right default.
  const first = releases.findIndex((r) => r.mirrors.length > 0);
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
 *
 * Chromium rejects a bare `hev1` / `hvc1` as not a valid RFC 6381 string and
 * answers `false` for it on *every* machine -- including ones that decode HEVC
 * perfectly well. The first version of `browserSupportsCodec` probed exactly
 * that, so the gate blocked playback for the very users who had installed the
 * codec it tells them to install. Probe real profile strings instead.
 */
const HEVC_PROBES = [
  'video/mp4; codecs="hev1.1.6.L93.B0"', // Main: what MovieBox ships today
  'video/mp4; codecs="hev1.2.4.L120.90"', // Main 10: for 10-bit encodes
];

/**
 * True when this browser cannot decode the codec a release needs.
 *
 * MovieBox is HEVC-only today, and a browser without an HEVC decoder reports
 * `MediaSource.isTypeSupported('<full hev1 string>') === false`. Asking before
 * playback starts turns a silent black rectangle into a sentence the user can
 * act on.
 */
export function browserSupportsCodec(release: Release | undefined): boolean {
  if (!release?.codec) return true;
  if (typeof MediaSource === 'undefined') return false;
  const codec = release.codec.toLowerCase();
  if (codec.includes('hevc') || codec.includes('265') || codec.includes('hvc') || codec.includes('hev')) {
    // Any real HEVC decoder counts: a machine with only Main 10 support still
    // deserves to try rather than be turned away at the door.
    return HEVC_PROBES.some((type) => MediaSource.isTypeSupported(type));
  }
  // Anything else (h264, avc, unknown) is safe to attempt: h264 is universal,
  // and an unknown label must not block playback on a guess.
  return true;
}

/**
 * Throttled `timeupdate` -> `/api/history/progress`.
 *
 * The home rail reads this; a save every two seconds is cheap for a
 * single-user localhost app and keeps the resume point honest even if the tab
 * is closed without unmounting.
 *
 * Returns the ref to put on the `<video>` element. Taking the consumer's own
 * ref instead of an internal one is the whole point: with two refs the hook's
 * effect ran against a ref nothing had attached, found `null`, and returned
 * early -- so progress was silently never saved.
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
  // The caller builds `payload` inline, so it is a new object every render.
  // Reading it through a ref keeps the listener stable instead of detaching and
  // reattaching it on each render for a payload whose values never changed.
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
      if (now - lastSave.current < 2000) return;
      if (video.duration <= 0 || Number.isNaN(video.duration)) return;
      lastSave.current = now;
      void api.saveProgress({
        ...current,
        position: Math.floor(video.currentTime),
        duration: Math.floor(video.duration),
        completed: video.duration > 0 && video.currentTime / video.duration > 0.95,
      });
    };

    video.addEventListener('timeupdate', onTime);
    return () => video.removeEventListener('timeupdate', onTime);
  }, [enabled]);

  return videoRef;
}

/** Shaka error categories worth naming in the UI instead of a raw number. */
export function describeShakaError(error: unknown): string {
  const e = error as { category?: number; code?: number; message?: string } | null;
  if (!e || typeof e.category !== 'number') {
    return error instanceof Error ? error.message : 'Unknown playback error';
  }
  // Category 1 = NETWORK, 2 = TEXT, 4 = MANIFEST, 8 = MEDIA in Shaka's enum.
  if (e.category === 1) {
    if (e.code === 1001) {
      return 'Stream host returned an HTTP error (1001). The source CDN or subtitle server temporarily rejected the request. Try switching quality or another source.';
    }
    return 'Network connection issue with the video stream. Check your internet or try another mirror.';
  }
  if (e.category === 2) {
    return 'Subtitle track could not be loaded or parsed from this host.';
  }
  if (e.category === 4 && e.code === 4032) {
    return 'This stream uses a codec your browser cannot decode. Install the HEVC video codec from the Microsoft Store, then reload.';
  }
  if (e.category === 10) {
    return 'Lost connection to the stream. Check that the MovieBox backend is still running.';
  }
  if (e.category === 8) {
    return 'The stream sent data this browser could not decode.';
  }
  return `Playback error ${e.category}/${e.code}`;
}
