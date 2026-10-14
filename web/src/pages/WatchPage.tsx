/**
 * The player page.
 *
 * Wiring, top to bottom:
 *
 * - The release list comes from `/api/streams`; which one plays comes from the
 *   details page through navigation state, or falls back to the best quality.
 * - The episode's subtitle list is fetched before a session opens, because the
 *   backend has to know the subtitle hosts up front in order to whitelist them.
 * - A session is opened per release+mirror choice; its proxied manifest URL is
 *   what Shaka loads. The player is dynamically imported so only this route
 *   pays for its megabyte.
 * - HEVC is the norm on this provider and not every browser decodes it, so
 *   codec support is checked before the player boots and the failure mode is
 *   an instruction, not a black rectangle.
 * - `<Player>` owns the video element and the custom controls; this file owns
 *   the Shaka instance and hands it down as a ref.
 */

import { AlertTriangle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EmptyState } from '@/components/common/StateBlocks';
import { Player, type NextEpisode } from '@/components/player/Player';
import { inferLanguage, type PlayerLike } from '@/components/player/tracks';
import shaka from 'shaka-player';
import {
  useDetails,
  useHistory,
  useSettings,
  useStreams,
  useSubtitles,
} from '@/hooks/useCatalog';
import {
  browserSupportsCodec,
  describeShakaError,
  pickRelease,
  usePlayback,
  useProgressSaver,
} from '@/hooks/usePlayback';
import { cleanTitle, formatDuration } from '@/lib/format';
import { api } from '@/lib/api';
import { isProviderKind, paths, readIndex } from '@/lib/routes';
import type { AudioTrackOption, ProviderKind, Release, Season, SubtitleOption } from '@/types';

interface WatchLocationState {
  resourceId?: string | null;
  mirror?: number;
  quality?: number | null;
}

const NO_RELEASES: Release[] = [];
const NO_SEASONS: Season[] = [];

export function WatchPage() {
  const { provider: rawProvider, id = '' } = useParams();
  const [params] = useSearchParams();
  const state = useLocation().state as WatchLocationState | null;

  if (!isProviderKind(rawProvider)) return <Unknown />;

  const seasonIdx = readIndex(params.get('season')) ?? 0;
  const episodeIdx = readIndex(params.get('episode'));
  // If season is 0 (or not specified for movies), episode must be 0, not 1!
  let resolvedEpisode = episodeIdx;
  if (resolvedEpisode === undefined) {
    resolvedEpisode = seasonIdx === 0 ? 0 : 1;
  } else if (seasonIdx === 0) {
    resolvedEpisode = 0;
  }
  return (
    <WatchInner
      provider={rawProvider}
      id={id}
      season={seasonIdx}
      episode={resolvedEpisode}
      resourceId={state?.resourceId ?? null}
      mirror={state?.mirror ?? null}
      quality={state?.quality ?? null}
    />
  );
}

/** The next episode after `(season, episode)`, or `null` at the end. */
function findNextEpisode(
  seasons: Season[],
  season: number,
  episode: number,
): NextEpisode | null {
  if (seasons.length === 0) return null;
  const current = seasons.find((s) => s.number === season);
  const next = current?.episodes.find((e) => e.number > episode);
  if (next) {
    return { season, episode: next.number, title: next.title?.trim() || `Episode ${next.number}` };
  }
  // Roll into the next season that has episodes.
  const ordered = [...seasons].sort((a, b) => a.number - b.number);
  const index = ordered.findIndex((s) => s.number === season);
  for (const candidate of ordered.slice(index + 1)) {
    const first = candidate.episodes[0];
    if (first) {
      return {
        season: candidate.number,
        episode: first.number,
        title: first.title?.trim() || `Episode ${first.number}`,
      };
    }
  }
  return null;
}

function WatchInner({
  provider,
  id,
  season,
  episode,
  resourceId,
  mirror,
  quality,
}: {
  provider: string;
  id: string;
  season: number;
  episode: number;
  resourceId: string | null;
  mirror: number | null;
  quality: number | null;
}) {
  // `provider` is already narrowed by the guard above; the hooks below need the
  // narrowed type, which is why the split into two components exists.
  const p = provider as ProviderKind;
  const details = useDetails(p, id);
  const isSeries = details.data?.media_type === 'series';
  const effectiveSeason = isSeries ? (season || 1) : 0;
  const effectiveEpisode = isSeries ? (episode || 1) : 0;
  const streams = useStreams(p, id, effectiveSeason, effectiveEpisode);
  const settings = useSettings();
  const navigate = useNavigate();

  const title = cleanTitle(details.data?.title ?? 'Now playing');
  const seasons = details.data?.seasons ?? NO_SEASONS;

  const nextEpisode = useMemo(
    () => findNextEpisode(seasons, effectiveSeason, effectiveEpisode),
    [seasons, effectiveSeason, effectiveEpisode],
  );

  // The player is gated on the Streaming toggle from settings. Loading the
  // setting lazily (rather than blocking on it) keeps the page fast, but the
  // gate itself has to be exact: once loaded, streaming off means no player.
  const streamingOff = settings.data !== undefined && settings.data.streaming_enabled === false;

  const goToEpisode = (nextSeason: number, nextEpisodeNumber: number) => {
    navigate(paths.watch(p, id, { season: nextSeason, episode: nextEpisodeNumber }));
  };

  const handleBack = () => {
    const videos = document.querySelectorAll('video');
    videos.forEach((v) => {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {
        /* ignore */
      }
    });
    if (window.history.state && window.history.state.idx > 0) {
      navigate(-1);
    } else {
      navigate(paths.title(p, id));
    }
  };

  // Stop playback immediately on unmount so audio never leaks when navigating away
  useEffect(() => {
    return () => {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch {
          /* ignore */
        }
      });
    };
  }, []);

  if (streamingOff) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-6">
        <EmptyState
          title="Streaming is turned off"
          hint="You can still browse, and downloads from details pages keep working. Turn streaming back on in Settings to watch in the browser."
          action={
            <Link
              to={paths.settings()}
              className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
            >
              Open settings
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full bg-black">
      <PlayerStage
        key={`${p}:${id}:${effectiveSeason}:${effectiveEpisode}`}
        provider={p}
        id={id}
        season={effectiveSeason}
        episode={effectiveEpisode}
        resourceId={resourceId}
        mirror={mirror}
        quality={quality}
        releases={streams.data ?? NO_RELEASES}
        releasesLoading={streams.isLoading}
        releasesError={streams.isError}
        title={title}
        releaseYear={details.data?.year ?? null}
        episodeLabel={isSeries ? `Season ${effectiveSeason}, Episode ${effectiveEpisode}` : null}
        poster={details.data?.poster_url ?? null}
        seasons={seasons}
        nextEpisode={nextEpisode}
        autoplayNext={settings.data?.autoplay_next_episode ?? true}
        onSelectEpisode={goToEpisode}
        onPlayNext={() => {
          if (nextEpisode) goToEpisode(nextEpisode.season, nextEpisode.episode);
        }}
        onBack={handleBack}
        dubs={details.data?.dubs ?? []}
        onSelectDub={(dub) => {
          if (dub.subject_id && dub.subject_id !== id) {
            navigate(paths.watch(p, dub.subject_id, { season: effectiveSeason, episode: effectiveEpisode }));
          }
        }}
      />
    </div>
  );
}

function PlayerStage({
  provider,
  id,
  season,
  episode,
  resourceId,
  mirror,
  quality,
  releases,
  releasesLoading,
  releasesError,
  title,
  releaseYear,
  episodeLabel,
  poster,
  seasons,
  nextEpisode,
  autoplayNext,
  onSelectEpisode,
  onPlayNext,
  onBack,
  dubs,
  onSelectDub,
}: {
  provider: ProviderKind;
  id: string;
  season: number;
  episode: number;
  resourceId: string | null;
  mirror: number | null;
  quality: number | null;
  releases: Release[];
  releasesLoading: boolean;
  releasesError: boolean;
  title: string;
  releaseYear: string | null;
  episodeLabel: string | null;
  poster: string | null;
  seasons: Season[];
  nextEpisode: NextEpisode | null;
  autoplayNext: boolean;
  onSelectEpisode: (season: number, episode: number) => void;
  onPlayNext: () => void;
  onBack: () => void;
  dubs?: AudioTrackOption[];
  onSelectDub?: (dub: AudioTrackOption) => void;
}) {
  // Which release will play, asked before a session exists. Checking
  // `releases[0]` instead would test the wrong release the moment the details
  // page pointed at a specific one.
  const candidate = useMemo(
    () => pickRelease(releases, resourceId, mirror),
    [releases, resourceId, mirror],
  );
  const codecOk = useMemo(() => browserSupportsCodec(candidate?.release), [candidate]);

  const siblingIds = useMemo(
    () =>
      (dubs ?? [])
        .map((d) => d.subject_id)
        .filter((sid): sid is string => Boolean(sid && sid !== id)),
    [dubs, id],
  );

  const subtitleResourceId = candidate?.release.resource_id ?? null;
  const subtitles = useSubtitles({
    subjectId: id,
    resourceId: subtitleResourceId ?? '',
    siblings: siblingIds,
    season,
    episode,
  });


  const subtitleTracks = useMemo<SubtitleOption[]>(
    () => (subtitles.data ?? []).filter((s) => Boolean(s.url)),
    [subtitles.data],
  );
  const sessionSubtitles = useMemo(
    () =>
      subtitleTracks.map((s) => ({
        url: s.url,
        lang: inferLanguage(s.name, s.url),
        label: s.name || 'Subtitle',
      })),
    [subtitleTracks],
  );

  const setup = usePlayback({
    releases,
    resourceId,
    mirror,
    quality,
    subtitle: null,
    subtitles: sessionSubtitles,
    // Immediate playback start: creating session warms manifest & segments immediately.
    enabled: codecOk,
  });

  // Where this episode was left off, read from the same cache the
  // continue-watching rail fills.
  const history = useHistory();
  const resumeAt = useMemo(() => {
    const hit = history.data?.find(
      (h) =>
        h.provider === provider &&
        h.subject_id === id &&
        h.season === season &&
        h.episode === episode,
    );
    if (!hit || hit.completed) return 0;
    const seconds = hit.progress_seconds ?? 0;
    if (seconds < 30) return 0;
    if (hit.duration_seconds && hit.duration_seconds - seconds < 120) return 0;
    return seconds;
  }, [history.data, provider, id, season, episode]);

  if (releasesLoading) return <StageFrame onBack={onBack} />;

  if (releasesError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-6">
        <EmptyState
          title="Could not list sources"
          hint="The provider did not answer. Try again in a moment."
          action={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                Try Again
              </button>
              <Link to={paths.title(provider, id)} className="text-[13px] text-white/70 underline hover:text-white">
                Back to details
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  if (releases.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-6">
        <EmptyState
          title="No playable source"
          hint="This title has no stream right now. Try a different episode or provider."
          action={
            <div className="flex items-center gap-3">
              <Link
                to={paths.title(provider, id)}
                className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                Back to details
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  if (!codecOk) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-6">
        <CodecNotice />
      </div>
    );
  }

  // `undefined` is "the session request is in flight", not "nothing works".
  if (setup === undefined) {
    return <StageFrame onBack={onBack} onRetry={() => window.location.reload()} />;
  }

  if (setup === null) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black p-6">
        <EmptyState
          title="Could not open a playback session"
          hint="The backend could not start a session for this source. Check that the MovieBox backend is still running, then reload."
          action={
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                Try Again
              </button>
              <Link to={paths.title(provider, id)} className="text-[13px] text-white/70 underline hover:text-white">
                Back to details
              </Link>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <ShakaStage
      key={setup.session.session_id}
      manifestUrl={api.resolveUrl(setup.session.manifest_url)}
      proxyBase={api.resolveUrl(setup.session.proxy_base)}
      release={setup.release}
      mirrorIndex={setup.mirrorIndex}
      releases={releases}
      title={title}
      episodeLabel={episodeLabel}
      poster={poster}
      resumeAt={resumeAt}
      seasons={seasons}
      currentSeason={season}
      currentEpisode={episode}
      nextEpisode={nextEpisode}
      autoplayNext={autoplayNext}
      onSelectEpisode={onSelectEpisode}
      onPlayNext={onPlayNext}
      onBack={onBack}
      subtitleTracks={subtitleTracks}
      dubs={dubs}
      currentDubId={id}
      onSelectDub={onSelectDub}
      progressPayload={{
        subject_id: id,
        provider,
        title,
        season,
        episode,
        cover_url: poster ?? undefined,
        release_year: releaseYear ?? undefined,
      }}
    />
  );
}

/** A reserved, empty stage so loading never collapses the page height, with timeout guidance. */
function StageFrame({
  onRetry,
  onBack,
}: {
  onRetry?: () => void;
  onBack?: () => void;
}) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 2200);
    const t2 = setTimeout(() => setStep(2), 5500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  const stepMessages = [
    'Resolving stream sources from provider...',
    'Establishing secure media session & preparing stream...',
    'Connecting to video host CDN...',
  ];

  return (
    <div className="flex h-full w-full flex-col items-center justify-center bg-black gap-4 p-6 text-center animate-fade-in">
      <div className="relative flex size-16 items-center justify-center sm:size-20">
        <div className="size-full rounded-full border-4 border-white/10 border-t-accent animate-spin" />
        <div className="absolute size-4 rounded-full bg-accent/40 animate-ping" />
      </div>

      <div className="space-y-1">
        <p className="text-[14px] font-semibold text-fg-default animate-pulse">
          {stepMessages[step]}
        </p>
        <p className="text-[11.5px] text-white/50">
          NovaFlix 4K Stream Engine
        </p>
      </div>

      {step >= 2 && (
        <div className="mt-3 flex max-w-md flex-col items-center gap-3 rounded-2xl border border-white/15 bg-[#101016]/80 p-5 text-center backdrop-blur-md animate-fade-in shadow-2xl">
          <p className="text-[12.5px] leading-relaxed text-white/80">
            Upstream video host is taking longer than usual to respond. This can happen when free CDN servers are busy.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => {
                if (onRetry) onRetry();
                else window.location.reload();
              }}
              className="rounded-full bg-accent px-5 py-2 text-[12px] font-bold text-accent-contrast shadow-sm transition hover:scale-105 active:scale-95"
            >
              Retry Connection
            </button>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-full border border-white/20 bg-white/10 px-5 py-2 text-[12px] font-semibold text-white transition hover:bg-white/20"
              >
                Back to Details
              </button>
            )}
          </div>
          <p className="text-[11px] text-white/40 pt-1">
            Tip: You can also click "Download" on details page to download the file directly.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The live Shaka player. Mounted once per session id, so changing the source
 * unmounts and rebuilds rather than trying to re-point a live player.
 */
function ShakaStage({
  manifestUrl,
  proxyBase,
  release: _release,
  mirrorIndex: _mirrorIndex,
  releases,
  title,
  episodeLabel,
  poster,
  resumeAt,
  seasons,
  currentSeason,
  currentEpisode,
  nextEpisode,
  autoplayNext,
  onSelectEpisode,
  onPlayNext,
  onBack,
  subtitleTracks,
  progressPayload,
  dubs,
  currentDubId,
  onSelectDub,
}: {
  manifestUrl: string;
  proxyBase: string;
  release: Release;
  mirrorIndex: number;
  releases: Release[];
  title: string;
  episodeLabel: string | null;
  poster: string | null;
  resumeAt: number;
  seasons: Season[];
  currentSeason: number;
  currentEpisode: number;
  nextEpisode: NextEpisode | null;
  autoplayNext: boolean;
  onSelectEpisode: (season: number, episode: number) => void;
  onPlayNext: () => void;
  onBack: () => void;
  subtitleTracks: SubtitleOption[];
  progressPayload: Parameters<typeof useProgressSaver>[1];
  dubs?: AudioTrackOption[];
  currentDubId?: string;
  onSelectDub?: (dub: AudioTrackOption) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PlayerLike | null>(null);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');
  const [errorText, setErrorText] = useState('');
  const [resumeLabel, setResumeLabel] = useState('');
  const didResume = useRef(false);
  // The progress saver's ref is the canonical `<video>` handle: the player and
  // the DOM share it rather than this component keeping a second copy, which is
  // exactly the two-refs bug that silently disabled progress saving before.
  const videoRef = useProgressSaver(status === 'playing', progressPayload);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let player: unknown = null;

    (async () => {
      try {
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) {
          throw new Error('This browser cannot run the player.');
        }

        // Register SRT parser for both standard and alternative MIME types
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const textEngine = (shaka.text as any)?.TextEngine;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const SrtParser = (shaka.text as any)?.SrtTextParser;
          if (textEngine && SrtParser) {
            textEngine.registerParser('application/x-subrip', () => new SrtParser());
            textEngine.registerParser('text/srt', () => new SrtParser());
          }
        } catch {
          /* parser registration fallback */
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const instance: any = new shaka.Player();
        playerRef.current = instance as PlayerLike;
        player = instance;

        // Configure UITextDisplayer for beautiful, reliable subtitle rendering on top of container
        try {
          const displayContainer = containerRef.current || video.parentElement;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const UITextDisplayer = (shaka.text as any)?.UITextDisplayer;
          if (displayContainer && UITextDisplayer) {
            instance.configure('textDisplayFactory', () => new UITextDisplayer(video, displayContainer));
          }
        } catch (e) {
          console.warn('[UITextDisplayer fallback]', e);
        }

        // Configure Shaka for instant start, network resilience, and automatic retry on packet drops
        instance.configure({
          streaming: {
            rebufferingGoal: 2,
            bufferingGoal: 15,
            bufferBehind: 30,
            stallEnabled: true,
            stallThreshold: 1,
            jumpLargeGaps: true,
            inaccurateManifestTolerance: 2,
            retryParameters: {
              maxAttempts: 6,
              baseDelay: 1000,
              backoffFactor: 1.5,
              fuzzFactor: 0.5,
              timeout: 15000,
            },
          },
          manifest: {
            dash: {
              ignoreMinBufferTime: true,
            },
            retryParameters: {
              maxAttempts: 5,
              baseDelay: 1000,
              backoffFactor: 1.5,
              fuzzFactor: 0.5,
              timeout: 15000,
            },
          },
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        instance.addEventListener('error', (event: { detail?: any }) => {
          if (cancelled) return;
          const detail = event.detail;
          // In Shaka Player, severity 1 is RECOVERABLE (e.g. non-critical subtitle fetch failure).
          if (detail && detail.severity === 1) {
            console.warn('[Shaka Non-Critical Warning]', detail);
            return;
          }

          // If it's a temporary network glitch (Category 1: NETWORK), attempt automatic recovery
          if (detail && detail.category === 1 && instance.retryStreaming) {
            console.warn('[Shaka Network Glitch - Attempting Auto-Recovery]', detail);
            try {
              instance.retryStreaming();
              return;
            } catch {
              /* fallback to error */
            }
          }

          setStatus('error');
          setErrorText(describeShakaError(detail));
        });

        await instance.attach(video);
        if (cancelled) return;
        await instance.load(manifestUrl);
        if (cancelled) return;

        setStatus('playing');
        video.muted = false;
        await video.play().catch(async () => {
          // If browser autoplay policy blocks unmuted audio, try muted play immediately
          // so video starts playing right away instead of getting stuck in buffering!
          try {
            video.muted = true;
            await video.play();
          } catch {
            // Centre play button is user's gesture fallback
          }
        });
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setErrorText(describeShakaError(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch {
          /* ignore */
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const instance = player as any;
      if (instance) {
        try {
          void instance.destroy();
        } catch {
          /* a torn-down player that refuses to die is not worth reporting */
        }
      }
      playerRef.current = null;
    };
  }, [manifestUrl, videoRef]);

  const [resumePromptVisible, setResumePromptVisible] = useState(false);

  // If there's a saved progress point, pause and prompt the user to choose:
  // Resume from where they left off OR Start Over from 0:00.
  useEffect(() => {
    if (didResume.current || status !== 'playing' || resumeAt <= 0) return;
    const video = videoRef.current;
    if (!video) return;
    didResume.current = true;
    try {
      video.pause();
    } catch {
      /* ignore */
    }
    setResumePromptVisible(true);
  }, [status, resumeAt, videoRef]);

  const handleResume = () => {
    setResumePromptVisible(false);
    const video = videoRef.current;
    if (!video) return;
    try {
      video.currentTime = resumeAt;
      setResumeLabel(`Resumed at ${formatDuration(resumeAt)}`);
      void video.play();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => setResumeLabel(''), 5000);
    return () => clearTimeout(timer);
  };

  const handleStartOver = () => {
    setResumePromptVisible(false);
    const video = videoRef.current;
    if (!video) return;
    try {
      video.currentTime = 0;
      void video.play();
    } catch {
      /* ignore */
    }
  };

  const externalSubtitles = useMemo(
    () =>
      subtitleTracks.map((s) => ({
        url: `${proxyBase}/sub/${encodeURIComponent(s.url)}`,
        lang: inferLanguage(s.name, s.url),
        label: s.name || 'Subtitle',
      })),
    [subtitleTracks, proxyBase],
  );

  return (
    <div className="h-full w-full bg-black">
      <Player
        videoRef={videoRef}
        containerRef={containerRef}
        playerRef={playerRef}
        ready={status === 'playing'}
        status={status}
        errorText={errorText}
        onRetry={() => setStatus('loading')}
        poster={poster}
        title={title}
        episodeLabel={episodeLabel}
        onBack={onBack}
        externalSubtitles={externalSubtitles}
        seasons={seasons}
        currentSeason={currentSeason}
        currentEpisode={currentEpisode}
        onSelectEpisode={onSelectEpisode}
        nextEpisode={nextEpisode}
        autoplayNext={autoplayNext}
        onPlayNext={onPlayNext}
        resumeLabel={resumeLabel || null}
        resumePrompt={
          resumePromptVisible
            ? {
                seconds: resumeAt,
                onResume: handleResume,
                onStartOver: handleStartOver,
              }
            : null
        }
        dubs={dubs}
        currentDubId={currentDubId}
        onSelectDub={onSelectDub}
        releases={releases}
      />
    </div>
  );
}

/** The HEVC dead end, turned into something the user can fix. */
function CodecNotice() {
  return (
    <div className="surface flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-card px-6 text-center">
      <AlertTriangle className="size-10 text-warning" aria-hidden="true" />
      <div className="max-w-lg space-y-2">
        <h2 className="text-[16px] font-semibold text-fg-default">
          This stream needs the HEVC codec
        </h2>
        <p className="text-[13.5px] leading-relaxed text-fg-muted">
          MovieBox serves HEVC video, and this browser has no HEVC decoder. Install the free{' '}
          <span className="text-fg-default">
            HEVC Video Extensions from Device Manufacturer
          </span>{' '}
          from the Microsoft Store, then reload this page. Chrome and Edge both use the Windows
          codec once it is installed.
        </p>
      </div>
      <Link
        to={paths.home()}
        className="rounded-full bg-accent px-5 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
      >
        Back to home
      </Link>
    </div>
  );
}

function Unknown() {
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <EmptyState
        title="Unknown provider"
        hint="This link names a source MovieBox does not recognise."
        action={
          <Link
            to={paths.home()}
            className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
          >
            Back to home
          </Link>
        }
      />
    </div>
  );
}
