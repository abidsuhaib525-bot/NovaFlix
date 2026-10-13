/**
 * Video element state, bridged to React.
 *
 * The `<video>` element is the source of truth for position, volume, buffer and
 * fullscreen; Shaka is the source of truth for which track is playing. This hook
 * subscribes to both and exposes one flat controller, so the control bar never
 * touches either directly.
 *
 * Two deliberate choices:
 *
 * - **A rAF loop smooths the clock.** `timeupdate` fires roughly four times a
 *   second, which makes a progress bar visibly step. A 10 Hz rAF pass updates
 *   only `currentTime` while playing, and only when it has actually moved, so
 *   the rest of the snapshot does not churn sixty times a second.
 * - **Refs, not state, for the player handles.** Shaka's player object is created
 *   asynchronously and replaced on every source change; holding it in a ref
 *   keeps these callbacks stable across that.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';

import {
  activeHeight as heightOf,
  type PlayerLike,
  type QualityOption,
  qualityOptions,
  type ShakaTrack,
  subtitleMime,
} from './tracks';

/** The flat snapshot of the media element the UI renders from. */
export interface VideoSnapshot {
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  /** Buffered ranges as `[start, end]` pairs, in seconds. */
  buffered: Array<[number, number]>;
  volume: number;
  muted: boolean;
  playbackRate: number;
  waiting: boolean;
  /** True once metadata has arrived, so a duration is known. */
  ready: boolean;
}

export interface TrackSnapshot {
  variants: ShakaTrack[];
  text: ShakaTrack[];
  audio: ShakaTrack[];
}

const EMPTY_SNAPSHOT: VideoSnapshot = {
  paused: true,
  ended: false,
  currentTime: 0,
  duration: 0,
  buffered: [],
  volume: 1,
  muted: false,
  playbackRate: 1,
  waiting: false,
  ready: false,
};

const EMPTY_TRACKS: TrackSnapshot = { variants: [], text: [], audio: [] };

/** Read every field the UI cares about off the live element. */
function snapshotOf(video: HTMLVideoElement): VideoSnapshot {
  const buffered: Array<[number, number]> = [];
  for (let i = 0; i < video.buffered.length; i += 1) {
    buffered.push([video.buffered.start(i), video.buffered.end(i)]);
  }
  return {
    paused: video.paused,
    ended: video.ended,
    currentTime: video.currentTime,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    buffered,
    volume: video.volume,
    muted: video.muted,
    playbackRate: video.playbackRate,
    // readyState < 2 means not even current frame data is ready to show.
    // readyState >= 2 means current frame is visible; only show waiting when actively seeking or depleted.
    waiting: ((video.readyState < 2 && !video.paused && !video.ended) || video.seeking),
    ready: video.readyState >= 1,
  };
}

const clamp = (value: number, min: number, max: number) =>
  Number.isNaN(value) ? min : Math.min(max, Math.max(min, value));

/** Everything the player components can read or call. */
export interface PlayerController {
  state: VideoSnapshot;
  tracks: TrackSnapshot;
  quality: QualityOption[];
  activeHeight: number | null;
  /** Automatic bitrate switching is on. */
  abr: boolean;
  fullscreen: boolean;
  pip: boolean;
  togglePlay(): void;
  seekTo(seconds: number): void;
  seekBy(delta: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
  setRate(rate: number): void;
  selectQuality(track: ShakaTrack | null): void;
  selectText(track: ShakaTrack | null): void;
  selectAudio(track: ShakaTrack): void;
  toggleFullscreen(): void;
  togglePip(): void;
  /** Register a side-loaded subtitle with Shaka; failures are swallowed. */
  addExternalText(uri: string, language: string, label: string): Promise<void>;
  refreshTracks(): void;
}

export function usePlayerState({
  videoRef,
  playerRef,
  containerRef,
  ready,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  playerRef: MutableRefObject<PlayerLike | null>;
  containerRef: RefObject<HTMLElement | null>;
  /** Flipped once `player.load()` has resolved, to trigger the first scan. */
  ready: boolean;
}): PlayerController {
  const [state, setState] = useState<VideoSnapshot>(EMPTY_SNAPSHOT);
  const [tracks, setTracks] = useState<TrackSnapshot>(EMPTY_TRACKS);
  const [abr, setAbr] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);

  /* --- video element ------------------------------------------------ */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sync = () => setState(snapshotOf(video));
    const events = [
      'timeupdate',
      'durationchange',
      'progress',
      'volumechange',
      'play',
      'pause',
      'playing',
      'waiting',
      'stalled',
      'loadstart',
      'ended',
      'ratechange',
      'loadedmetadata',
      'canplay',
      'seeking',
      'seeked',
      'emptied',
    ] as const;
    for (const event of events) video.addEventListener(event, sync);
    sync();

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 100) return;
      last = now;
      if (video.paused || video.ended || document.hidden) return;
      setState((prev) =>
        Math.abs(prev.currentTime - video.currentTime) < 0.04
          ? prev
          : { ...prev, currentTime: video.currentTime },
      );
    };
    raf = requestAnimationFrame(tick);

    return () => {
      for (const event of events) video.removeEventListener(event, sync);
      cancelAnimationFrame(raf);
    };
  }, [videoRef]);

  /* --- fullscreen / picture-in-picture ------------------------------ */

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    onChange();
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const enter = () => setPip(true);
    const leave = () => setPip(false);
    video.addEventListener('enterpictureinpicture', enter);
    video.addEventListener('leavepictureinpicture', leave);
    return () => {
      video.removeEventListener('enterpictureinpicture', enter);
      video.removeEventListener('leavepictureinpicture', leave);
    };
  }, [videoRef]);

  /* --- shaka tracks ------------------------------------------------- */

  const refreshTracks = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    try {
      setTracks({
        variants: player.getVariantTracks() ?? [],
        text: player.getTextTracks() ?? [],
        audio: player.getAudioTracks() ?? [],
      });
    } catch {
      // The player can be mid-teardown during a source switch; a stale track
      // list for one frame is better than throwing out of an effect.
    }
  }, [playerRef]);

  useEffect(() => {
    if (ready) refreshTracks();
  }, [ready, refreshTracks]);

  /* --- actions ------------------------------------------------------ */

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => {
        /* autoplay policy; the play overlay stays up for a real click */
      });
    } else {
      video.pause();
    }
  }, [videoRef]);

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      const max = Number.isFinite(video.duration) ? video.duration : seconds;
      video.currentTime = clamp(seconds, 0, max);
    },
    [videoRef],
  );

  const seekBy = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (video) video.currentTime = clamp(video.currentTime + delta, 0, video.duration || 0);
    },
    [videoRef],
  );

  const setVolume = useCallback(
    (volume: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.volume = clamp(volume, 0, 1);
      // Dragging the slider up is an unambiguous request for sound.
      video.muted = video.volume === 0;
    },
    [videoRef],
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (video) video.muted = !video.muted;
  }, [videoRef]);

  const setRate = useCallback(
    (rate: number) => {
      const video = videoRef.current;
      if (video) video.playbackRate = rate;
      try {
        playerRef.current?.setPlaybackRate(rate);
      } catch {
        /* the element rate above is the fallback */
      }
    },
    [playerRef, videoRef],
  );

  const selectQuality = useCallback(
    (track: ShakaTrack | null) => {
      const player = playerRef.current;
      if (!player) return;
      if (track) {
        // Disabling ABR first is what makes the choice stick; leaving it on
        // lets the next adaptation immediately override the pick.
        player.configure({ abr: { enabled: false } });
        player.selectVariantTrack(track, true);
        setAbr(false);
      } else {
        player.configure({ abr: { enabled: true } });
        setAbr(true);
      }
      refreshTracks();
    },
    [playerRef, refreshTracks],
  );

  const selectText = useCallback(
    (track: ShakaTrack | null) => {
      const player = playerRef.current;
      if (!player) return;
      if (track) {
        player.selectTextTrack(track);
        player.setTextTrackVisibility(true);
      } else {
        player.setTextTrackVisibility(false);
      }
      refreshTracks();
    },
    [playerRef, refreshTracks],
  );

  const selectAudio = useCallback(
    (track: ShakaTrack) => {
      try {
        playerRef.current?.selectAudioTrack(track);
      } catch {
        /* a single-audio manifest rejects this; harmless */
      }
      refreshTracks();
    },
    [playerRef, refreshTracks],
  );

  const toggleFullscreen = useCallback(async () => {
    const target = containerRef.current ?? videoRef.current;
    if (!target) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await target.requestFullscreen();
    } catch {
      /* denied by the browser, or unsupported */
    }
  }, [containerRef, videoRef]);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled) await video.requestPictureInPicture();
    } catch {
      /* unsupported, or blocked without a gesture */
    }
  }, [videoRef]);

  const addExternalText = useCallback(
    async (uri: string, language: string, label: string) => {
      const player = playerRef.current;
      if (!player) return;
      try {
        await player.addTextTrackAsync(
          uri,
          language || 'und',
          'subtitles',
          subtitleMime(uri),
          undefined,
          label,
        );
      } catch {
        // A missing or unparseable subtitle must never take playback down.
      }
    },
    [playerRef],
  );

  const quality = useMemo(() => qualityOptions(tracks.variants), [tracks.variants]);
  const currentHeight = useMemo(() => heightOf(tracks.variants), [tracks.variants]);

  return {
    state,
    tracks,
    quality,
    activeHeight: currentHeight,
    abr,
    fullscreen,
    pip,
    togglePlay,
    seekTo,
    seekBy,
    setVolume,
    toggleMute,
    setRate,
    selectQuality,
    selectText,
    selectAudio,
    toggleFullscreen,
    togglePip,
    addExternalText,
    refreshTracks,
  };
}
