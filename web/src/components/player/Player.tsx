/**
 * The watch-page player.
 *
 * Owns the video element and every overlay on top of it; the page above owns the
 * Shaka instance and hands it down as a ref. Splitting it that way keeps this
 * component free of any import of the megabyte player chunk -- Shaka is loaded
 * by the page, which is where the dynamic import lives.
 *
 * Behaviour, in one place:
 * - custom controls with keyboard shortcuts, auto-hide and double-click fullscreen
 * - a settings panel for speed, quality, audio and subtitles
 * - an episode drawer and a next-episode prompt that can auto-advance
 */

import { AlertTriangle, ArrowLeft, Keyboard, Play, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';

import type { AudioTrackOption, Release, Season } from '@/types';

import { EpisodeDrawer } from './EpisodeDrawer';
import { PlayerControls } from './PlayerControls';
import { PlayerMenu, type AspectRatioMode, type PlayerMenuTab } from './PlayerMenu';
import type { PlayerLike } from './tracks';
import { usePlayerState } from './usePlayerState';

/** A subtitle the page told the server about, routed through the proxy. */
export interface ExternalSubtitle {
  url: string;
  lang: string;
  label: string;
}

export interface NextEpisode {
  season: number;
  episode: number;
  title: string;
}

/**
 * Elements that swallow a click instead of toggling playback.
 *
 * The container's click handler turns a tap into play/pause, which is what a
 * video should do — but only for the video itself. Buttons, the scrub slider,
 * the options panel and the episode drawer all live inside that container, and a
 * click on any of them must not also pause the film. Naming them once keeps the
 * click and double-click handlers in agreement.
 */
const CHROME_SELECTOR = 'button, input, [role="slider"], aside, [data-player-chrome]';

export interface ResumePromptState {
  seconds: number;
  onResume: () => void;
  onStartOver: () => void;
}

export function Player({
  videoRef,
  containerRef,
  playerRef,
  ready,
  status,
  errorText,
  onRetry,
  poster,
  title,
  episodeLabel,
  onBack,
  externalSubtitles,
  seasons,
  currentSeason,
  currentEpisode,
  onSelectEpisode,
  nextEpisode,
  autoplayNext,
  onPlayNext,
  resumeLabel,
  resumePrompt,
  dubs = [],
  currentDubId = '',
  onSelectDub,
  releases = [],
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  playerRef: MutableRefObject<PlayerLike | null>;
  ready: boolean;
  status: 'loading' | 'playing' | 'error';
  errorText: string;
  onRetry: () => void;
  poster: string | null;
  title: string;
  episodeLabel: string | null;
  onBack?: () => void;
  externalSubtitles: ExternalSubtitle[];
  seasons: Season[];
  currentSeason: number;
  currentEpisode: number;
  onSelectEpisode: (season: number, episode: number) => void;
  nextEpisode: NextEpisode | null;
  autoplayNext: boolean;
  onPlayNext: () => void;
  resumeLabel: string | null;
  resumePrompt?: ResumePromptState | null;
  dubs?: AudioTrackOption[];
  currentDubId?: string;
  onSelectDub?: (dub: AudioTrackOption) => void;
  releases?: Release[];
}) {
  const controller = usePlayerState({ videoRef, playerRef, containerRef, ready });
  const {
    state,
    togglePlay,
    seekBy,
    seekTo,
    setVolume,
    toggleMute,
    toggleFullscreen,
    togglePip,
    addExternalText,
    refreshTracks,
  } = controller;

  const [controlsVisible, setControlsVisible] = useState(true);
  const [activeMenu, setActiveMenu] = useState<PlayerMenuTab | null>(null);
  const [episodesOpen, setEpisodesOpen] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatioMode>('contain');
  const [ratioToast, setRatioToast] = useState<string | null>(null);
  const [seekToast, setSeekToast] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [dismissNearEnd, setDismissNearEnd] = useState(false);

  const handleSeekBy = useCallback(
    (delta: number) => {
      seekBy(delta);
      setSeekToast(delta > 0 ? `+${delta}s` : `${delta}s`);
    },
    [seekBy],
  );

  useEffect(() => {
    if (!seekToast) return;
    const timer = setTimeout(() => setSeekToast(null), 900);
    return () => clearTimeout(timer);
  }, [seekToast]);

  const cycleAspectRatio = useCallback(() => {
    const modes: AspectRatioMode[] = ['contain', 'cover', 'fill', '16:9', '4:3'];
    const labels: Record<AspectRatioMode, string> = {
      contain: 'Fit (Default)',
      cover: 'Fill / Zoom',
      fill: 'Stretch',
      '16:9': '16:9 Widescreen',
      '4:3': '4:3 Classic',
    };
    setAspectRatio((prev) => {
      const nextIdx = (modes.indexOf(prev) + 1) % modes.length;
      const nextMode = modes[nextIdx];
      setRatioToast(labels[nextMode]);
      return nextMode;
    });
  }, []);

  useEffect(() => {
    if (!ratioToast) return;
    const timer = setTimeout(() => setRatioToast(null), 2200);
    return () => clearTimeout(timer);
  }, [ratioToast]);

  const menuOpen = activeMenu !== null;
  const barVisible = controlsVisible || menuOpen || episodesOpen;

  /* --- side-loaded subtitles ---------------------------------------- */

  // Registered dynamically as tracks become available.
  const addedSubtitlesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!ready || externalSubtitles.length === 0) return;
    let cancelled = false;
    void (async () => {
      let anyAdded = false;
      for (const subtitle of externalSubtitles) {
        if (cancelled) return;
        if (!addedSubtitlesRef.current.has(subtitle.url)) {
          addedSubtitlesRef.current.add(subtitle.url);
          await addExternalText(subtitle.url, subtitle.lang, subtitle.label);
          anyAdded = true;
        }
      }
      if (!cancelled && anyAdded) {
        refreshTracks();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, externalSubtitles, addExternalText, refreshTracks]);

  /* --- auto-hide ----------------------------------------------------- */

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let timer = 0;
    const wake = () => {
      setControlsVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const video = videoRef.current;
        // Never hide mid-pause: the play button is the one thing the viewer
        // needs and hunting for it is the worst part of a mis-hide.
        if (video && !video.paused && !video.ended) setControlsVisible(false);
      }, 3200);
    };

    const events = ['pointermove', 'pointerdown', 'keydown'] as const;
    for (const event of events) {
      container.addEventListener(event, wake);
      window.addEventListener(event, wake);
    }
    wake();
    return () => {
      window.clearTimeout(timer);
      for (const event of events) {
        container.removeEventListener(event, wake);
        window.removeEventListener(event, wake);
      }
    };
  }, [containerRef, videoRef]);

  /* --- keyboard shortcuts ------------------------------------------- */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const video = videoRef.current;
      if (!video) return;

      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          // Let a focused button or link handle Space/Enter itself.
          if (event.key === ' ' && (tag === 'BUTTON' || tag === 'A')) return;
          event.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          handleSeekBy(-10);
          break;
        case 'ArrowRight':
          event.preventDefault();
          handleSeekBy(10);
          break;
        case 'j':
        case 'J':
          handleSeekBy(-10);
          break;
        case 'l':
        case 'L':
          handleSeekBy(10);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setVolume(video.volume + 0.05);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setVolume(video.volume - 0.05);
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          void toggleFullscreen();
          break;
        case 'a':
        case 'A':
          cycleAspectRatio();
          break;
        case 'p':
        case 'P':
          void togglePip();
          break;
        case '?':
          setShowShortcuts((prev) => !prev);
          break;
        case 'Escape':
          // While fullscreen the browser handles Esc itself.
          setShowShortcuts(false);
          if (!document.fullscreenElement) {
            setActiveMenu(null);
            setEpisodesOpen(false);
          }
          break;
        default:
          if (/^[0-9]$/.test(event.key) && video.duration > 0) {
            seekTo((Number(event.key) / 10) * video.duration);
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videoRef, togglePlay, handleSeekBy, seekTo, setVolume, toggleMute, toggleFullscreen, togglePip, cycleAspectRatio]);

  /* --- next-episode auto-advance ------------------------------------ */

  const queueNext = Boolean(nextEpisode) && (state.ended || countdown !== null);

  useEffect(() => {
    if (!autoplayNext || !nextEpisode || !state.ended) {
      setCountdown(null);
      return;
    }
    setCountdown(8);
    const id = window.setInterval(() => {
      setCountdown((value) => {
        if (value === null) return null;
        if (value <= 1) {
          window.clearInterval(id);
          onPlayNext();
          return null;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [autoplayNext, nextEpisode, state.ended, onPlayNext]);

  const nearEnd =
    Boolean(nextEpisode) && state.duration > 0 && state.duration - state.currentTime < 40;

  const handleBackdropClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const el = event.target as HTMLElement;
      if (el.closest(CHROME_SELECTOR)) return;
      if (menuOpen || episodesOpen) {
        setActiveMenu(null);
        setEpisodesOpen(false);
        return;
      }
      togglePlay();
    },
    [menuOpen, episodesOpen, togglePlay],
  );

  const lastTapRef = useRef<number>(0);
  const handleTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const el = event.target as HTMLElement;
      if (el.closest(CHROME_SELECTOR)) return;
      const now = Date.now();
      if (now - lastTapRef.current < 320) {
        // Mobile double tap detected
        void toggleFullscreen();
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    },
    [toggleFullscreen],
  );

  return (
    <div
      ref={containerRef}
      className="group/player relative h-full w-full overflow-hidden bg-black select-none flex items-center justify-center touch-manipulation"
      onClick={handleBackdropClick}
      onTouchEnd={handleTouchEnd}
      onDoubleClick={(event) => {
        const el = event.target as HTMLElement;
        if (el.closest(CHROME_SELECTOR)) return;
        void toggleFullscreen();
      }}
    >
      <video
        ref={videoRef}
        playsInline
        poster={poster ?? undefined}
        className={`h-full w-full bg-black transition-all duration-200 ${
          aspectRatio === 'cover'
            ? 'object-cover'
            : aspectRatio === 'fill'
            ? 'object-fill'
            : aspectRatio === '16:9'
            ? 'object-contain aspect-video'
            : aspectRatio === '4:3'
            ? 'object-contain aspect-[4/3]'
            : 'object-contain'
        }`}
        style={
          aspectRatio === 'fill'
            ? { width: '100%', height: '100%', objectFit: 'fill' }
            : aspectRatio === 'cover'
            ? { width: '100%', height: '100%', objectFit: 'cover' }
            : undefined
        }
      />

      {/* Aspect Ratio Change On-Screen Notification */}
      {ratioToast && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/20 bg-black/85 px-4 py-2 text-[13px] font-semibold text-white shadow-2xl backdrop-blur-md animate-fade-in flex items-center gap-2">
          <span className="size-2 rounded-full bg-accent animate-pulse" />
          <span>Aspect Ratio: {ratioToast}</span>
        </div>
      )}

      {/* Seeking Forward/Backward Visual Indicator */}
      {seekToast && (
        <div className="pointer-events-none absolute top-1/2 left-1/2 z-30 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/20 bg-black/85 px-6 py-3 text-[18px] font-black text-white shadow-2xl backdrop-blur-md animate-fade-in flex items-center gap-2.5">
          <span className="text-accent">{seekToast.startsWith('+') ? '⏩' : '⏪'}</span>
          <span>{seekToast}</span>
        </div>
      )}

      {/* Top scrim: back button and title. */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start gap-3 bg-gradient-to-b from-black/80 to-transparent px-3 pt-3 pb-10 transition-opacity duration-300 sm:px-5 ${
          barVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {onBack && (
          <button
            type="button"
            onClick={() => {
              const video = videoRef.current;
              if (video) {
                try {
                  video.pause();
                  video.muted = true;
                  video.currentTime = 0;
                  video.srcObject = null;
                  video.removeAttribute('src');
                  video.load();
                } catch {
                  /* ignore */
                }
              }
              onBack();
            }}
            aria-label="Back to details"
            className="pointer-events-auto inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/70 cursor-pointer"
          >
            <ArrowLeft className="size-5" />
          </button>
        )}
        <div className="min-w-0 pt-1">
          <p className="truncate text-[14px] font-semibold text-white drop-shadow">{title}</p>
          {episodeLabel && (
            <p className="truncate text-[12px] text-white/65">{episodeLabel}</p>
          )}
        </div>
      </div>

      {resumeLabel && status === 'playing' && (
        <div className="pointer-events-none absolute top-16 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/75 px-3.5 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm animate-fade-in">
          {resumeLabel}
        </div>
      )}

      {/* Centre play button: covers paused, autoplay-blocked and ended. */}
      {status === 'playing' && state.paused && !state.ended && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            togglePlay();
          }}
          aria-label="Play"
          className="absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="flex size-16 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:scale-105 hover:bg-black/70">
            <Play className="size-8 translate-x-0.5 fill-current" />
          </span>
        </button>
      )}

      {/* Netflix-style unobtrusive circular buffering indicator (never dims entire screen) */}
      {(status === 'loading' ||
        (status === 'playing' && !state.paused && (state.waiting || !state.ready))) && (
        <div className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center transition-opacity duration-300">
          <div className="relative flex size-14 items-center justify-center rounded-2xl bg-black/50 p-3 backdrop-blur-md border border-white/10 shadow-2xl">
            {/* Outer rotating accent arc */}
            <div className="size-8 animate-spin rounded-full border-3 border-white/20 border-t-accent" />
          </div>
          {status === 'loading' && (
            <p className="mt-2 text-[11px] font-semibold tracking-wider text-white/80 drop-shadow uppercase bg-black/60 px-3 py-1 rounded-full backdrop-blur-sm border border-white/10">
              Loading video...
            </p>
          )}
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/85 px-6 text-center">
          <AlertTriangle className="size-8 text-danger" aria-hidden="true" />
          <p className="max-w-lg text-[13.5px] text-white">{errorText}</p>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      )}

      <PlayerControls
        controller={controller}
        visible={barVisible === true && status === 'playing'}
        activeMenu={activeMenu}
        onToggleMenu={(menu) => {
          setActiveMenu((curr) => (curr === menu ? null : menu));
          setEpisodesOpen(false);
        }}
        hasEpisodes={seasons.length > 0}
        onToggleEpisodes={() => {
          setEpisodesOpen((open) => !open);
          setActiveMenu(null);
        }}
        showNext={nearEnd && !state.ended}
        onNext={onPlayNext}
        aspectRatio={aspectRatio}
        onCycleAspectRatio={cycleAspectRatio}
      />

      {activeMenu && (
        <div className="absolute right-3 bottom-20 z-30 sm:right-5" data-player-chrome>
          <PlayerMenu
            controller={controller}
            activeTab={activeMenu}
            onTabChange={setActiveMenu}
            dubs={dubs}
            currentDubId={currentDubId}
            onSelectDub={(dub) => {
              onSelectDub?.(dub);
              setActiveMenu(null);
            }}
            releases={releases}
            aspectRatio={aspectRatio}
            seasons={seasons}
            currentSeason={currentSeason}
            currentEpisode={currentEpisode}
            onSelectEpisode={(nextSeason, nextEp) => {
              onSelectEpisode(nextSeason, nextEp);
              setActiveMenu(null);
            }}
            onAspectRatioChange={(ratio) => {
              const labels: Record<AspectRatioMode, string> = {
                contain: 'Fit (Default)',
                cover: 'Fill / Zoom',
                fill: 'Stretch',
                '16:9': '16:9 Widescreen',
                '4:3': '4:3 Classic',
              };
              setAspectRatio(ratio);
              setRatioToast(labels[ratio]);
            }}
          />
        </div>
      )}

      <EpisodeDrawer
        open={episodesOpen}
        onClose={() => setEpisodesOpen(false)}
        seasons={seasons}
        currentSeason={currentSeason}
        currentEpisode={currentEpisode}
        onSelect={onSelectEpisode}
        title={title}
      />

      {/* Non-intrusive Resume Notification Toast */}
      {status === 'playing' && resumeLabel && (
        <div
          className="pointer-events-auto absolute bottom-20 left-4 z-30 flex items-center gap-2.5 rounded-full border border-white/20 bg-black/85 px-4 py-2 text-[12.5px] font-semibold text-white shadow-2xl backdrop-blur-md animate-fade-in sm:left-6"
          data-player-chrome
        >
          <span className="size-2 rounded-full bg-accent animate-pulse" />
          <span>{resumeLabel}</span>
          {resumePrompt?.onStartOver && (
            <button
              type="button"
              onClick={resumePrompt.onStartOver}
              className="ml-1 cursor-pointer rounded-full bg-white/15 px-2.5 py-0.5 text-[11px] font-semibold text-white/90 hover:bg-white/25 hover:text-white transition"
            >
              Start Over
            </button>
          )}
        </div>
      )}

      {/* End-of-episode prompt. */}
      {(state.ended || queueNext) && nextEpisode && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#0b0b10]/95 p-5 text-center text-white shadow-2xl">
            <p className="text-[11px] font-semibold tracking-[0.14em] text-white/45 uppercase">
              Up next
            </p>
            <p className="mt-1.5 text-[15px] font-semibold">{nextEpisode.title}</p>
            <p className="mt-0.5 text-[12px] text-white/55">
              S{nextEpisode.season}E{nextEpisode.episode}
            </p>
            <div className="mt-4 flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={onPlayNext}
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                <Play className="size-4 fill-current" />
                Play next{countdown !== null ? ` (${countdown})` : ''}
              </button>
              <button
                type="button"
                onClick={() => setCountdown(null)}
                className="rounded-full bg-white/10 px-4 py-2 text-[13px] font-medium text-white/85 transition hover:bg-white/20"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Next Episode Preview Card when near the end */}
      {nearEnd && !state.ended && nextEpisode && !dismissNearEnd && (
        <div className="absolute right-4 bottom-22 z-30 flex items-center gap-3 rounded-2xl border border-white/15 bg-black/85 p-3.5 shadow-2xl backdrop-blur-xl animate-fade-in" data-player-chrome>
          <div className="flex flex-col">
            <span className="text-[10px] font-bold uppercase tracking-wider text-accent">Next Episode</span>
            <span className="text-[13px] font-bold text-white max-w-[200px] truncate">{nextEpisode.title}</span>
            <span className="text-[11px] text-white/60">S{nextEpisode.season}E{nextEpisode.episode}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onPlayNext}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-[12px] font-bold text-accent-contrast shadow-sm transition hover:bg-accent-hover cursor-pointer"
            >
              <Play className="size-3.5 fill-current" />
              Play
            </button>
            <button
              type="button"
              onClick={() => setDismissNearEnd(true)}
              aria-label="Dismiss next episode preview"
              className="grid size-7 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white cursor-pointer"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Keyboard Shortcuts Modal */}
      {showShortcuts && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 px-4 backdrop-blur-md animate-fade-in" data-player-chrome>
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#101016]/95 p-6 text-white shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <Keyboard className="size-5 text-accent" />
                <h3 className="text-[16px] font-bold">Keyboard Shortcuts</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                className="rounded-lg p-1 text-white/50 hover:bg-white/10 hover:text-white cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5 text-[12.5px]">
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Play / Pause</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">Space / K</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Fullscreen</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">F</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Seek 10s</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">&larr; / &rarr;</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Volume</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">&uarr; / &darr;</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Mute / Unmute</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">M</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Picture in Picture</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">P</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Aspect Ratio</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">A</kbd>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.04] p-2 border border-white/[0.06]">
                <span className="text-white/70">Shortcuts Help</span>
                <kbd className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-[11px] text-accent font-bold">?</kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
