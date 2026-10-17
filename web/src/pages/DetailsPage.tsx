/**
 * Title details.
 *
 * The page answers four questions in order: what is this, can I watch it, which
 * episode, and which source. Everything below the fold is discovery, so it comes
 * after those rather than competing with them.
 *
 * Season and episode live in the URL. For a series that means an episode link is
 * shareable and the back button steps through episodes the way a user expects;
 * for a movie the URL stays bare.
 */

import { ArrowLeft, Calendar, Check, ChevronDown, Clock, Download, Film, Grid, Heart, Languages, List, Play, Share2, Sparkles, Star, Tv, User, Users, Video, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { EmptyState, ErrorState } from '@/components/common/StateBlocks';
import { PosterCard } from '@/components/media/PosterCard';
import { PosterImage } from '@/components/media/PosterImage';
import { Rail } from '@/components/media/Rail';
import {
  useBrowseRail,
  useDetails,
  useFavorites,
  useStreams,
  useToggleFavorite,
} from '@/hooks/useCatalog';
import { cleanDubLabel, cleanTitle, extractEditionTags, formatBytes, formatRuntime, parseQualityHeight } from '@/lib/format';
import { isProviderKind, paths, readIndex } from '@/lib/routes';
import { api } from '@/lib/api';
import { CastMember, fetchTmdbCast, fetchTmdbSeasonEpisodes, fetchTmdbTrailer, getTmdbImageUrl, searchTmdbMedia, TmdbEpisodeMeta } from '@/lib/tmdb';
import type { AudioTrackOption, MediaDetails, ProviderKind, Release } from '@/types';
import { notifyError, useUiStore } from '@/store/ui';

/** Show this much of an overlong synopsis before collapsing it. */
const SYNOPSIS_LIMIT = 420;

export function DetailsPage() {
  const { provider: rawProvider, id = '' } = useParams();

  // The URL is the one untrusted input in the app. An unknown provider means a
  // hand-edited or stale link, and passing it through would surface as a backend
  // complaint about a provider the user never named. The guard sits in this
  // outer component, which owns no other hooks, so the hook count cannot change
  // if the provider in the URL changes while the route stays mounted.
  if (!isProviderKind(rawProvider)) return <UnknownProvider />;

  return <DetailsView provider={rawProvider} id={id} />;
}

function DetailsView({ provider, id }: { provider: ProviderKind; id: string }) {
  const [params, setParams] = useSearchParams();
  const details = useDetails(provider, id);
  const nav = useNavigate();

  const seasons = details.data?.seasons ?? [];
  const isSeries = details.data?.media_type === 'series';

  // Season 0 is the movie case throughout the backend, so it is the default for
  // anything that is not a series.
  const season = readIndex(params.get('season')) ?? (isSeries ? 1 : 0);
  const episode = readIndex(params.get('episode')) ?? (isSeries ? 1 : 0);

  const [selectedDubId, setSelectedDubId] = useState<string>(id);

  useEffect(() => {
    setSelectedDubId(id);
  }, [id]);

  const activeId = selectedDubId || id;
  const streams = useStreams(provider, activeId, season, isSeries ? episode : 0);

  // Normalise available audio dubs (English/Original, Hindi, etc.)
  // MUST be called before any early returns to respect React's Rules of Hooks
  const allDubs = useMemo(() => {
    const dubsList = details.data?.dubs;
    if (!dubsList || dubsList.length === 0) return [];
    const list: AudioTrackOption[] = [];
    const seen = new Set<string>();

    const hasCurrent = dubsList.some((d) => d.subject_id === id);
    if (!hasCurrent && id) {
      list.push({
        subject_id: id,
        language: 'Original',
        label: 'English (Original)',
      });
      seen.add(id);
    }

    for (const d of dubsList) {
      if (!d.subject_id || seen.has(d.subject_id)) continue;
      seen.add(d.subject_id);
      list.push(d);
    }
    return list;
  }, [details.data?.dubs, id]);

  const hasDubs = allDubs.length > 1;
  const activeDub = allDubs.find((d) => d.subject_id === activeId);

  if (details.isPending) return <DetailsSkeleton />;

  if (details.isError) {
    return (
      <Frame>
        <ErrorState
          error={details.error}
          onRetry={() => void details.refetch()}
          title="Could not load this title"
          className="my-16"
        />
      </Frame>
    );
  }

  const item = details.data;

  // The upstream title carries release tags -- `Chernobyl [Hindi][CAM]`. They
  // belong in the API response, not in the page's `h1`, so the display copy is
  // derived once here rather than at every `item.title` below. Note that the
  // request payloads further down still send the raw title: cleaning is a
  // presentation decision and must not change what gets asked of the backend.
  const title = cleanTitle(item.title);
  const editionTags = extractEditionTags(item.title);


  return (
    <Frame>
      <Banner poster={item.poster_url} />

      <div className="relative px-1 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (window.history.state && window.history.state.idx > 0) {
                nav(-1);
              } else {
                nav(paths.home());
              }
            }}
            className="group inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/20 bg-[#121218]/90 px-4 py-2 text-[13px] font-semibold text-fg-default shadow-xl backdrop-blur-md transition-all hover:border-accent hover:bg-bg-surface hover:text-accent hover:scale-105 active:scale-95"
            title="Go back"
          >
            <ArrowLeft className="size-4 transition-transform group-hover:-translate-x-0.5" aria-hidden="true" />
            <span>Back</span>
          </button>
        </div>
        {/* Hero Section */}
        <div className="flex flex-col gap-8 md:flex-row md:items-start lg:gap-12">
          {/* Left: Premium Poster Card with Glowing Reflection */}
          <div className="group relative mx-auto shrink-0 md:mx-0">
            <div className="absolute -inset-1 rounded-2xl bg-gradient-to-b from-accent/30 to-purple-600/10 blur-xl opacity-70 transition duration-500 group-hover:opacity-100" />
            <div className="relative overflow-hidden rounded-2xl border border-white/10 shadow-2xl bg-bg-surface">
              <PosterImage
                src={item.poster_url}
                alt={title}
                className="w-[200px] sm:w-[240px] md:w-[270px] lg:w-[300px] aspect-[2/3] object-cover transition duration-300 group-hover:scale-105"
              />
            </div>
          </div>

          {/* Right: Rich Information & Action Center */}
          <div className="min-w-0 flex-1 space-y-5">
            <div>
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-accent border border-accent/25 shadow-sm">
                  {isSeries ? (
                    <>
                      <Tv className="size-3" /> TV Series
                    </>
                  ) : (
                    <>
                      <Film className="size-3" /> Feature Film
                    </>
                  )}
                </span>
                {editionTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-0.5 text-[11px] font-bold text-amber-200 shadow-sm"
                  >
                    {tag}
                  </span>
                ))}
                <span className="rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[10.5px] font-bold tracking-wider uppercase text-white/90 border border-white/15">
                  4K Ultra HD
                </span>
                <span className="rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[10.5px] font-bold tracking-wider uppercase text-white/80 border border-white/10">
                  HDR10+
                </span>
                {item.imdb_rating && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2.5 py-0.5 text-[11px] font-bold text-amber-400 shadow-sm">
                    <Star className="size-3 fill-amber-400 text-amber-400" />
                    IMDb {item.imdb_rating}
                  </span>
                )}
                {item.prints && (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold text-white/80 border border-white/10">
                    {item.prints}
                  </span>
                )}
                {item.audios && (
                  <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-medium text-white/70 border border-white/10">
                    {item.audios}
                  </span>
                )}
              </div>

              <h1 className="text-balance text-3xl font-extrabold leading-tight tracking-tight text-fg-default sm:text-4xl lg:text-5xl drop-shadow-sm">
                {title}
              </h1>

              {item.tagline && (
                <p className="mt-2 text-[15px] italic text-fg-muted font-light tracking-wide">
                  "{item.tagline}"
                </p>
              )}
            </div>

            <MetaRow item={item} seasonCount={seasons.length} />

            {/* Audio Language / Dubbing Selector - only displayed when dubbing is available */}
            {hasDubs && (
              <div className="space-y-2.5 rounded-2xl border border-white/10 bg-white/[0.04] p-3.5 sm:p-4 backdrop-blur-md animate-fade-in shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="flex items-center gap-2">
                    <Languages className="size-4 text-accent" />
                    <span className="text-[12px] font-bold uppercase tracking-wider text-white/90">
                      Audio Language / Dubbing Available
                    </span>
                  </div>
                  <span className="text-[11.5px] text-white/50">
                    Select language to play:
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {allDubs.map((dub) => {
                    const isSelected = dub.subject_id === activeId;
                    const displayLabel = cleanDubLabel(dub.label || dub.language);
                    return (
                      <button
                        key={dub.subject_id}
                        type="button"
                        onClick={() => setSelectedDubId(dub.subject_id)}
                        className={`group inline-flex cursor-pointer items-center gap-2 rounded-xl px-3.5 py-2 text-[12.5px] font-semibold transition-all ${
                          isSelected
                            ? 'bg-accent text-accent-contrast shadow-[0_0_15px_var(--accent-subtle)] ring-1 ring-accent/40 scale-102 font-bold'
                            : 'border border-white/10 bg-white/5 text-white/80 hover:border-white/20 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        <Volume2 className={`size-3.5 ${isSelected ? 'text-accent-contrast' : 'text-accent'}`} />
                        <span>{displayLabel}</span>
                        {isSelected && <Check className="size-3.5 stroke-[2.5]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <ActionRow
              item={item}
              provider={provider}
              id={activeId}
              selectedDubLabel={activeDub?.label || activeDub?.language}
              hasDubs={hasDubs}
              season={season}
              episode={isSeries ? episode : 0}
              streams={streams.data ?? []}
              hasStreams={(streams.data?.length ?? 0) > 0}
            />

            {/* Overview & Quick Info Bento Grid */}
            <div className="grid gap-4 pt-2 md:grid-cols-3">
              {/* Synopsis Column */}
              <div className="md:col-span-2 rounded-2xl border border-white/[0.08] bg-bg-surface/50 p-5 shadow-sm backdrop-blur-sm">
                <div className="mb-2 flex items-center gap-2">
                  <Sparkles className="size-4 text-accent" />
                  <h2 className="text-[14px] font-bold uppercase tracking-wider text-fg-default">
                    Storyline
                  </h2>
                </div>
                <Synopsis text={item.description} />
              </div>

              {/* Quick Info Sidebar */}
              <div className="rounded-2xl border border-white/[0.08] bg-bg-surface/50 p-5 shadow-sm backdrop-blur-sm space-y-4">
                <h3 className="text-[13px] font-bold uppercase tracking-wider text-fg-subtle border-b border-white/[0.06] pb-2">
                  Details
                </h3>
                <Credits item={item} />
              </div>
            </div>
          </div>
        </div>

        {/* Seasons & Episodes Section */}
        {isSeries && seasons.length > 0 && (
          <SeasonPicker
            seasons={seasons}
            season={season}
            episode={episode}
            posterUrl={item.poster_url}
            seriesTitle={title}
            releaseYear={item.year}
            onSelect={(nextSeason, nextEpisode) => {
              const query = new URLSearchParams();
              query.set('season', String(nextSeason));
              query.set('episode', String(nextEpisode));
              setParams(query);
            }}
          />
        )}

        {/* Movnix-Style Top Billed Cast Section with Actor Photos & Roles */}
        <CastSection
          title={title}
          year={item.year}
          isTv={isSeries}
          starsFallback={item.stars}
        />

        {/* More Like This Recommended Titles Rail */}
        <MoreLikeThis currentId={id} />
      </div>
    </Frame>
  );
}

function MoreLikeThis({ currentId }: { currentId: string }) {
  const trending = useBrowseRail('trending');
  const items = useMemo(() => {
    return (trending.data?.items ?? [])
      .filter((candidate) => candidate.id.value !== currentId)
      .slice(0, 14);
  }, [trending.data?.items, currentId]);

  if (items.length === 0) return null;

  return (
    <section className="mt-14 border-t border-white/[0.08] pt-8">
      <div className="mb-4 flex items-center gap-2.5">
        <div className="h-5 w-1 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" />
        <h2 className="text-[20px] font-bold tracking-tight text-fg-default">
          More Like This
        </h2>
      </div>
      <Rail labelledBy="heading-more-like-this">
        {items.map((item) => (
          <PosterCard
            key={`${item.id.provider}:${item.id.value}`}
            item={item}
            className="w-[145px] sm:w-[170px] md:w-[185px]"
          />
        ))}
      </Rail>
    </section>
  );
}

/** The page's horizontal frame. Used by this file and its fallbacks alike. */
function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-[1600px] px-4 pt-20 sm:pt-24 lg:pt-28 pb-14 sm:px-6 lg:px-8">{children}</div>;
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The full-bleed backdrop.
 *
 * A blurred, cropped copy of the poster, because there is no landscape artwork in
 * the payload at all. Drawn `fixed` so the content below scrolls over it.
 */
function Banner({ poster }: { poster: string | null }) {
  return (
    <div
      className="fixed inset-x-0 top-0 -z-10 h-[500px] overflow-hidden sm:h-[620px]"
      aria-hidden="true"
    >
      {poster && <PosterImage src={poster} alt="" className="size-full scale-125" />}
      <div className="absolute inset-0 bg-gradient-to-b from-bg-base/45 via-bg-base/80 to-bg-base" />
      {/* Fades into the page so the content below does not appear to begin
          part-way down a hard-edged rectangle. */}
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg-base to-transparent" />
    </div>
  );
}

/** Year, runtime, rating, seasons. Omitted entirely when none are known. */
function MetaRow({ item, seasonCount }: { item: MediaDetails; seasonCount: number }) {
  const entries = [
    item.year && { key: 'year', icon: Calendar, text: item.year },
    item.duration && { key: 'runtime', icon: Clock, text: formatRuntime(item.duration) },
    item.imdb_rating && {
      key: 'rating',
      icon: Star,
      text: item.imdb_rating,
      // Filled rather than outlined: a rating is the one unambiguously good
      // number on the page and should read as such at a glance.
      className: 'fill-accent text-accent',
    },
    item.media_type === 'series' && {
      key: 'seasons',
      icon: Users,
      text: `${seasonCount} season${seasonCount === 1 ? '' : 's'}`,
    },
  ].filter(Boolean) as Array<{
    key: string;
    icon: typeof Calendar;
    text: string;
    className?: string;
  }>;

  if (entries.length === 0) return null;

  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] text-fg-muted">
      {entries.map(({ key, icon: Icon, text, className }) => (
        <span key={key} className="inline-flex items-center gap-1.5">
          <Icon className={`size-3.5 ${className ?? 'text-fg-subtle'}`} aria-hidden="true" />
          {text}
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

function ActionRow({
  item,
  provider,
  id,
  selectedDubLabel,
  hasDubs,
  season,
  episode,
  streams = [],
}: {
  item: MediaDetails;
  provider: ProviderKind;
  id: string;
  selectedDubLabel?: string;
  hasDubs?: boolean;
  season: number;
  episode: number;
  streams?: Release[];
  hasStreams?: boolean;
}) {
  const notify = useUiStore((s) => s.notify);
  const [downloadStarted, setDownloadStarted] = useState(false);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [downloadFormat, setDownloadFormat] = useState<'mp4' | 'mkv'>('mp4');
  const [showTrailer, setShowTrailer] = useState(false);
  const [trailerKey, setTrailerKey] = useState<string | null>(null);

  // Playback quality state
  const [selectedQuality, setSelectedQuality] = useState<number | null>(null);
  const [playQualityMenuOpen, setPlayQualityMenuOpen] = useState(false);

  // Available playback qualities derived from streams
  const availableQualities = useMemo(() => {
    const list = streams ?? [];
    const qualities: Array<{
      height: number;
      label: string;
      badge: string;
      size: string | null;
      release: Release;
    }> = [];

    const seenHeights = new Set<number>();

    for (const rel of list) {
      const h = parseQualityHeight(rel.quality) ?? parseQualityHeight(rel.filename);
      if (!h || seenHeights.has(h)) continue;
      seenHeights.add(h);

      let label = `${h}p`;
      let badge = 'HD';
      if (h >= 2160) {
        label = '4K Ultra HD';
        badge = '4K';
      } else if (h >= 1080) {
        label = '1080p Full HD';
        badge = 'FHD';
      } else if (h >= 720) {
        label = '720p HD';
        badge = 'HD';
      } else if (h <= 480) {
        label = '480p SD';
        badge = 'SD';
      }

      qualities.push({
        height: h,
        label,
        badge,
        size: rel.size_bytes ? formatBytes(rel.size_bytes) : null,
        release: rel,
      });
    }

    qualities.sort((a, b) => b.height - a.height);
    return qualities;
  }, [streams]);

  const selectedRelease = useMemo(() => {
    if (!selectedQuality) return streams[0];
    return (
      streams.find((r) => {
        const h = parseQualityHeight(r.quality) ?? parseQualityHeight(r.filename);
        return h === selectedQuality;
      }) ?? streams[0]
    );
  }, [streams, selectedQuality]);

  const watchUrl = useMemo(() => {
    const base = paths.watch(provider, id, { season, episode });
    const qParams = new URLSearchParams();
    if (selectedQuality) qParams.set('quality', String(selectedQuality));
    if (selectedRelease?.resource_id) qParams.set('resourceId', selectedRelease.resource_id);
    const qs = qParams.toString();
    return qs ? `${base}?${qs}` : base;
  }, [provider, id, season, episode, selectedQuality, selectedRelease]);

  const activeQualityBadge = selectedQuality
    ? (availableQualities.find((q) => q.height === selectedQuality)?.badge ?? `${selectedQuality}p`)
    : (availableQualities[0]?.badge ?? 'Auto');

  useEffect(() => {
    let cancelled = false;
    async function loadTrailer() {
      const tmdbId = await searchTmdbMedia(item.title, item.year, item.media_type === 'series');
      if (tmdbId && !cancelled) {
        const key = await fetchTmdbTrailer(tmdbId, item.media_type === 'series');
        if (!cancelled && key) {
          setTrailerKey(key);
        }
      }
    }
    loadTrailer();
    return () => {
      cancelled = true;
    };
  }, [item.title, item.year, item.media_type]);

  const triggerDownload = (release?: Release, formatToUse?: 'mp4' | 'mkv') => {
    const selectedRel = release ?? streams[0];
    const resourceId = selectedRel?.resource_id ?? null;
    const height = selectedRel?.quality ? parseInt(selectedRel.quality, 10) || null : null;
    const targetFormat = formatToUse ?? downloadFormat;

    setQualityMenuOpen(false);

    // Direct browser local download: save directly to user's device Downloads folder
    const directUrl = api.directDownloadUrl({
      provider,
      subject_id: id,
      season,
      episode,
      resource_id: resourceId,
      max_height: height,
      format: targetFormat,
      title: item.title,
    });

    const displayTitle = cleanTitle(item.title);
    const anchor = document.createElement('a');
    anchor.href = directUrl;
    anchor.setAttribute('download', `${displayTitle}.${targetFormat}`);
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      document.body.removeChild(anchor);
    }, 150);

    setDownloadStarted(true);
    notify('success', `Starting download: "${displayTitle}" (${targetFormat.toUpperCase()})`);
    setTimeout(() => setDownloadStarted(false), 3000);
  };

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      {/* Play button with Quality selector */}
      <div className="relative">
        <div className="inline-flex items-center rounded-full bg-accent text-accent-contrast shadow-[0_0_28px_var(--accent-subtle)] transition-all hover:scale-105 hover:shadow-[0_0_40px_var(--accent)] active:scale-95">
          <Link
            to={watchUrl}
            state={{ quality: selectedQuality, resourceId: selectedRelease?.resource_id ?? null }}
            className="inline-flex cursor-pointer items-center gap-2 rounded-l-full py-3.5 pl-7 pr-3 text-[14.5px] font-black transition"
            title="Start movie playback"
          >
            <Play className="size-4.5 fill-current" aria-hidden="true" />
            <span>{item.media_type === 'series' ? `Play S${season} E${episode}` : 'Play Now'}</span>
            {hasDubs && selectedDubLabel && (
              <span className="rounded-full bg-black/25 px-2 py-0.5 text-[10.5px] font-bold text-accent-contrast">
                {cleanDubLabel(selectedDubLabel)}
              </span>
            )}
            <span className="rounded-full bg-black/30 px-2 py-0.5 text-[11px] font-extrabold text-accent-contrast">
              {activeQualityBadge}
            </span>
          </Link>

          {/* Quality dropdown caret button */}
          <button
            type="button"
            onClick={() => setPlayQualityMenuOpen((prev) => !prev)}
            aria-expanded={playQualityMenuOpen}
            className="inline-flex cursor-pointer items-center rounded-r-full border-l border-black/20 py-3.5 pr-4 pl-2.5 text-accent-contrast transition hover:bg-black/15"
            title="Select playback quality (4K, 1080p, 720p, 480p, Auto)"
          >
            <ChevronDown
              className={`size-4 transition-transform ${playQualityMenuOpen ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {/* Quality selection popup */}
        {playQualityMenuOpen && (
          <div className="absolute top-full left-0 z-50 mt-2 w-72 rounded-2xl border border-white/15 bg-[#121218]/95 p-3.5 text-white shadow-2xl backdrop-blur-md animate-fade-in">
            <div className="mb-2.5 flex items-center justify-between border-b border-white/10 px-1 pb-2">
              <span className="text-[12px] font-bold tracking-wider text-white/80 uppercase">
                Playback Quality
              </span>
              <button
                type="button"
                onClick={() => setPlayQualityMenuOpen(false)}
                className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
              >
                <X className="size-3.5" />
              </button>
            </div>

            <div className="space-y-1.5 max-h-56 overflow-y-auto pr-0.5">
              {/* Option: Auto */}
              <button
                type="button"
                onClick={() => {
                  setSelectedQuality(null);
                  setPlayQualityMenuOpen(false);
                }}
                className={`group flex w-full cursor-pointer items-center justify-between rounded-xl p-2.5 text-left transition ${
                  selectedQuality === null
                    ? 'bg-accent text-accent-contrast font-bold shadow-sm'
                    : 'bg-white/[0.04] text-white/80 hover:bg-white/10 hover:text-white border border-white/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                    selectedQuality === null ? 'bg-black/25 text-accent-contrast' : 'bg-accent/20 text-accent'
                  }`}>
                    Auto
                  </span>
                  <span className="text-[12.5px]">Best Available</span>
                </div>
                {selectedQuality === null && <Check className="size-4 stroke-[2.5]" />}
              </button>

              {/* Specific Qualities */}
              {availableQualities.map((q) => {
                const isSelected = selectedQuality === q.height;
                return (
                  <button
                    key={q.height}
                    type="button"
                    onClick={() => {
                      setSelectedQuality(q.height);
                      setPlayQualityMenuOpen(false);
                    }}
                    className={`group flex w-full cursor-pointer items-center justify-between rounded-xl p-2.5 text-left transition ${
                      isSelected
                        ? 'bg-accent text-accent-contrast font-bold shadow-sm'
                        : 'bg-white/[0.04] text-white/80 hover:bg-white/10 hover:text-white border border-white/[0.06]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                        isSelected ? 'bg-black/25 text-accent-contrast' : 'bg-white/15 text-white'
                      }`}>
                        {q.badge}
                      </span>
                      <div>
                        <span className="text-[12.5px] block">{q.label}</span>
                        {q.size && (
                          <span className={`text-[10.5px] ${isSelected ? 'text-accent-contrast/80' : 'text-white/45'}`}>
                            {q.size}
                          </span>
                        )}
                      </div>
                    </div>
                    {isSelected && <Check className="size-4 stroke-[2.5]" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Download button with Quality Selection */}
      <div className="relative">
        <div className="inline-flex items-center rounded-full border border-border-strong bg-white/5 shadow-sm transition hover:border-accent">
          <button
            type="button"
            onClick={() => triggerDownload()}
            disabled={downloadStarted}
            className={`inline-flex cursor-pointer items-center gap-2 rounded-l-full py-3 pl-5 pr-3 text-[14px] font-semibold transition ${
              downloadStarted
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-fg-default hover:text-accent'
            }`}
            title="Download directly to your device (or click arrow for options)"
          >
            {downloadStarted ? (
              <Check className="size-4 text-emerald-400" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            <span>{downloadStarted ? 'Downloading...' : 'Download'}</span>
          </button>

            {/* Quality dropdown caret button */}
            <button
              type="button"
              onClick={() => setQualityMenuOpen((prev) => !prev)}
              aria-expanded={qualityMenuOpen}
              className="inline-flex cursor-pointer items-center rounded-r-full border-l border-white/10 py-3 pr-3.5 pl-2 text-fg-muted transition hover:bg-white/10 hover:text-fg-default"
              title="Choose download format & quality"
            >
              <ChevronDown className={`size-4 transition-transform ${qualityMenuOpen ? 'rotate-180 text-accent' : ''}`} />
            </button>
          </div>

          {/* Quality & Format selection popup */}
          {qualityMenuOpen && (
            <div className="absolute top-full left-0 z-50 mt-2 w-80 rounded-2xl border border-white/15 bg-[#121218]/95 p-3.5 text-white shadow-2xl backdrop-blur-md animate-fade-in">
              <div className="mb-3 flex items-center justify-between border-b border-white/10 px-1 pb-2.5">
                <span className="text-[12px] font-bold tracking-wider text-white/80 uppercase">
                  Download Options
                </span>
                <button
                  type="button"
                  onClick={() => setQualityMenuOpen(false)}
                  className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
                >
                  <X className="size-3.5" />
                </button>
              </div>

              {/* Format Switcher (MP4 vs MKV) */}
              <div className="mb-3 rounded-xl bg-white/[0.04] p-2 border border-white/[0.08]">
                <div className="flex items-center justify-between mb-1.5 px-1">
                  <span className="text-[11px] font-medium text-white/60">File Format:</span>
                  <span className="text-[10px] text-accent font-semibold uppercase">{downloadFormat}</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5 p-0.5 rounded-lg bg-black/40">
                  <button
                    type="button"
                    onClick={() => setDownloadFormat('mp4')}
                    className={`py-1.5 rounded-md text-[12px] font-bold transition flex items-center justify-center gap-1.5 ${
                      downloadFormat === 'mp4'
                        ? 'bg-accent text-accent-contrast shadow-sm'
                        : 'text-white/60 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>MP4</span>
                    <span className="text-[9px] font-normal opacity-80">(Standard)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDownloadFormat('mkv')}
                    className={`py-1.5 rounded-md text-[12px] font-bold transition flex items-center justify-center gap-1.5 ${
                      downloadFormat === 'mkv'
                        ? 'bg-accent text-accent-contrast shadow-sm'
                        : 'text-white/60 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>MKV</span>
                    <span className="text-[9px] font-normal opacity-80">(Original)</span>
                  </button>
                </div>
              </div>

              <div className="mb-1.5 px-1 flex items-center justify-between">
                <span className="text-[11px] font-medium text-white/60">Select Quality:</span>
                <span className="text-[10px] text-white/40">
                  {streams.length > 0 ? `${streams.length} available` : 'Default stream'}
                </span>
              </div>

              <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {streams.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => triggerDownload()}
                    className="group flex w-full cursor-pointer items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.04] p-3 text-left transition hover:border-accent/40 hover:bg-accent/15"
                  >
                    <div>
                      <span className="rounded bg-accent/20 px-2 py-0.5 text-[11px] font-bold text-accent">
                        Best Available
                      </span>
                      <p className="mt-1 text-[11.5px] text-white/70">
                        Default highest quality stream
                      </p>
                    </div>
                    <span className="text-[11px] font-bold text-accent">
                      Download .{downloadFormat}
                    </span>
                  </button>
                ) : (
                  streams.map((release, idx) => {
                  const qualityBadge = release.quality || 'Auto';
                  const sizeBadge = release.size_bytes ? formatBytes(release.size_bytes) : null;
                  const codecBadge = release.codec;

                  return (
                    <button
                      key={`${release.filename || idx}:${release.quality}`}
                      type="button"
                      onClick={() => triggerDownload(release)}
                      className="group flex w-full cursor-pointer items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.04] p-2.5 text-left transition hover:border-accent/40 hover:bg-accent/15"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[11px] font-bold text-accent">
                            {qualityBadge}
                          </span>
                          {codecBadge && (
                            <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/60">
                              {codecBadge}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-[11px] text-white/50 group-hover:text-white/80">
                          {release.filename || `Option ${idx + 1}`}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        {sizeBadge && (
                          <span className="block text-[11.5px] font-semibold text-white/70">
                            {sizeBadge}
                          </span>
                        )}
                        <span className="text-[10px] font-bold text-accent opacity-0 group-hover:opacity-100">
                          Download .{downloadFormat}
                        </span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
          )}
        </div>

      {/* Watch Trailer Button */}
      <button
        type="button"
        onClick={() => setShowTrailer(true)}
        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/5 px-5 py-3 text-[13.5px] font-semibold text-fg-default shadow-sm backdrop-blur transition hover:border-accent/40 hover:bg-white/10 hover:text-accent active:scale-95"
        title="Watch Official Trailer"
      >
        <Video className="size-4 text-accent" />
        <span>Watch Trailer</span>
      </button>

      <FavoriteButton item={item} provider={provider} id={id} />

      {/* Share Button */}
      <button
        type="button"
        onClick={() => {
          if (navigator.clipboard) {
            navigator.clipboard.writeText(window.location.href);
            notify('info', 'Link copied to clipboard!');
          }
        }}
        className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-3 text-[13.5px] font-medium text-fg-muted transition hover:border-accent hover:text-fg-default active:scale-95"
        title="Copy title link to share"
      >
        <Share2 className="size-4 text-fg-subtle" />
        <span className="hidden sm:inline">Share</span>
      </button>



      {/* Trailer Modal */}
      {showTrailer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in">
          <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-[#0b0b10] shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-3.5 bg-black/60">
              <div className="flex items-center gap-2.5">
                <Video className="size-4.5 text-accent" />
                <h3 className="text-[14px] font-bold text-fg-default truncate">
                  Trailer: {cleanTitle(item.title)} {item.year ? `(${item.year})` : ''}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowTrailer(false)}
                className="rounded-full p-1.5 text-fg-subtle hover:bg-white/10 hover:text-fg-default transition cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Video Player Embed */}
            <div className="relative aspect-video w-full bg-black flex items-center justify-center">
              {trailerKey ? (
                <iframe
                  src={`https://www.youtube.com/embed/${trailerKey}?autoplay=1&rel=0&modestbranding=1`}
                  title={`${item.title} Trailer`}
                  className="size-full border-0"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              ) : (
                <div className="flex flex-col items-center justify-center text-center p-6 gap-3">
                  <Video className="size-12 text-accent/50 animate-pulse" />
                  <p className="text-[14px] text-white/80 font-medium">
                    Finding official trailer for &quot;{cleanTitle(item.title)}&quot;...
                  </p>
                  <a
                    href={`https://www.youtube.com/results?search_query=${encodeURIComponent(
                      cleanTitle(item.title) + ' ' + (item.year ?? '') + ' official trailer'
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-[12.5px] font-bold text-accent-contrast shadow-md hover:bg-accent-hover transition"
                  >
                    Watch on YouTube ↗
                  </a>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 bg-black/60 border-t border-white/5 text-[12px] text-fg-subtle">
              <span>{trailerKey ? 'Official YouTube trailer' : 'YouTube search'}</span>
              <a
                href={
                  trailerKey
                    ? `https://www.youtube.com/watch?v=${trailerKey}`
                    : `https://www.youtube.com/results?search_query=${encodeURIComponent(
                        cleanTitle(item.title) + ' ' + (item.year ?? '') + ' official trailer'
                      )}`
                }
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline inline-flex items-center gap-1 font-medium"
              >
                Open directly in YouTube ↗
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The favourite toggle.
 *
 * Its state is derived from the server's favourites list rather than held locally,
 * which is what makes it correct on a fresh page load. The mutation settles the
 * list optimistically, so the button responds on the click instead of after a
 * round trip.
 */
function FavoriteButton({
  item,
  provider,
  id,
}: {
  item: MediaDetails;
  provider: ProviderKind;
  id: string;
}) {
  const favorites = useFavorites();
  const toggle = useToggleFavorite();

  const isFavorite = useMemo(
    () =>
      (favorites.data ?? []).some(
        (entry) => entry.provider === provider && entry.subject_id === id,
      ),
    [favorites.data, provider, id],
  );

  return (
    <button
      type="button"
      onClick={() =>
        toggle.mutate(
          {
            subject_id: id,
            provider,
            title: item.title,
            stype: item.media_type === 'series' ? 2 : 1,
            release_year: item.year ?? '',
            cover_url: item.poster_url,
          },
          { onError: notifyError },
        )
      }
      disabled={toggle.isPending}
      aria-pressed={isFavorite}
      className={`inline-flex items-center gap-2 rounded-full border px-5 py-3 text-[14px] font-medium transition disabled:opacity-50 ${
        isFavorite
          ? 'border-accent bg-accent-subtle text-accent'
          : 'border-border-strong text-fg-default hover:border-accent hover:text-accent'
      }`}
    >
      <Heart className={`size-4 ${isFavorite ? 'fill-current' : ''}`} aria-hidden="true" />
      {isFavorite ? 'In favourites' : 'Add to favourites'}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Text blocks                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The synopsis, collapsed past a length.
 *
 * MovieBox overviews run to several paragraphs, and an untruncated one pushes
 * the source list entirely below the fold on a title with a long description.
 */
function Synopsis({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!text?.trim()) return <p className="text-[13.5px] text-fg-subtle italic">No synopsis available for this title.</p>;

  const trimmed = text.trim();
  const long = trimmed.length > SYNOPSIS_LIMIT;
  const shown = long && !expanded ? `${trimmed.slice(0, SYNOPSIS_LIMIT).trimEnd()}...` : trimmed;

  return (
    <div>
      <p className="text-[14px] leading-relaxed text-fg-muted">{shown}</p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-2 text-[13px] font-semibold text-accent transition hover:text-accent-hover cursor-pointer"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}
    </div>
  );
}

/** Facts as label/value rows. Rendered only if there are any. */
function Credits({ item }: { item: MediaDetails }) {
  const hasCredits = item.director || item.stars || item.genres.length > 0 || item.prints || item.audios;
  if (!hasCredits) return <p className="text-[12px] text-fg-subtle italic">No details available.</p>;

  return (
    <div className="space-y-3.5">
      {item.director && (
        <div className="space-y-1">
          <span className="block text-[11px] font-bold text-fg-subtle uppercase tracking-wider">
            Director
          </span>
          <div className="flex flex-wrap gap-1.5 text-[13px]">
            {item.director.split(/,\s*/).map((name) => (
              <Link
                key={name}
                to={paths.search(name.trim())}
                className="rounded-md bg-white/5 px-2 py-0.5 text-fg-muted transition hover:bg-accent/20 hover:text-accent"
              >
                {name.trim()}
              </Link>
            ))}
          </div>
        </div>
      )}

      {item.stars && (
        <div className="space-y-1">
          <span className="block text-[11px] font-bold text-fg-subtle uppercase tracking-wider">
            Cast
          </span>
          <div className="flex flex-wrap gap-1.5 text-[12.5px]">
            {item.stars.split(/,\s*/).map((name) => (
              <Link
                key={name}
                to={paths.search(name.trim())}
                className="rounded-md bg-white/5 px-2 py-0.5 text-fg-muted transition hover:bg-accent/20 hover:text-accent"
              >
                {name.trim()}
              </Link>
            ))}
          </div>
        </div>
      )}

      {item.genres.length > 0 && (
        <div className="space-y-1">
          <span className="block text-[11px] font-bold text-fg-subtle uppercase tracking-wider">
            Genres
          </span>
          <div className="flex flex-wrap gap-1.5 text-[12px]">
            {item.genres.map((genre) => (
              <Link
                key={genre}
                to={paths.search(genre.trim())}
                className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 font-medium text-fg-muted transition hover:border-accent hover:text-accent"
              >
                {genre}
              </Link>
            ))}
          </div>
        </div>
      )}

      {item.prints && (
        <div className="space-y-0.5">
          <span className="block text-[11px] font-bold text-fg-subtle uppercase tracking-wider">
            Prints
          </span>
          <span className="block text-[13px] leading-snug text-fg-muted">
            {item.prints}
          </span>
        </div>
      )}

      {item.audios && (
        <div className="space-y-0.5">
          <span className="block text-[11px] font-bold text-fg-subtle uppercase tracking-wider">
            Audio
          </span>
          <span className="block text-[13px] leading-snug text-fg-muted">
            {item.audios}
          </span>
        </div>
      )}
    </div>
  );
}



/* -------------------------------------------------------------------------- */
/* Episode selection                                                           */
/* -------------------------------------------------------------------------- */

function SeasonPicker({
  seasons,
  season,
  episode,
  onSelect,
  posterUrl,
  seriesTitle,
  releaseYear,
}: {
  seasons: MediaDetails['seasons'];
  season: number;
  episode: number;
  onSelect: (season: number, episode: number) => void;
  posterUrl?: string | null;
  seriesTitle?: string;
  releaseYear?: string | null;
}) {
  if (!seasons || seasons.length === 0) return null;
  const current = seasons.find((candidate) => candidate.number === season) ?? seasons[0];
  if (!current || !Array.isArray(current.episodes)) return null;
  const lastEpisode = Math.max(1, current.episodes.length);
  const active = Math.min(Math.max(1, episode), lastEpisode);

  // TMDB per-episode still images & metadata lookup
  const [epMetaMap, setEpMetaMap] = useState<Map<number, TmdbEpisodeMeta>>(new Map());
  const [viewMode, setViewMode] = useState<'compact' | 'grid'>('grid');

  useEffect(() => {
    let cancelled = false;
    async function loadEpisodeStills() {
      if (!seriesTitle) return;
      const tmdbId = await searchTmdbMedia(seriesTitle, releaseYear, true);
      if (!tmdbId || cancelled) return;
      const meta = await fetchTmdbSeasonEpisodes(tmdbId, current.number, current.episodes.length);
      if (!cancelled) {
        setEpMetaMap(meta);
      }
    }
    loadEpisodeStills();
    return () => {
      cancelled = true;
    };
  }, [seriesTitle, releaseYear, current.number]);

  return (
    <section className="mt-10 space-y-4 border-t border-white/[0.08] pt-8">
      {/* Movnix Header: Title, Season dropdown, Count, and View toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-white/[0.08]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-5 rounded-full bg-accent" />
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">
              Episodes
            </span>
          </div>
          <h2 className="font-display text-xl sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2.5">
            <span>Season {current.number}</span>
            <span className="text-[11px] font-mono font-semibold text-white/50 px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/10">
              {current.episodes.length} Ep
            </span>
          </h2>
        </div>

        {/* Controls: Season Dropdown + Grid/List switch */}
        <div className="flex items-center gap-2">
          {seasons.length > 1 && (
            <div className="relative">
              <select
                id="season-select"
                aria-label="Select Season"
                value={current.number}
                onChange={(e) => onSelect(Number(e.target.value), 1)}
                className="appearance-none cursor-pointer rounded-full border border-white/15 bg-[#14141e] px-3.5 py-1.5 pr-8 text-[12px] font-semibold text-white shadow transition hover:border-accent hover:bg-[#1a1a26] focus:border-accent focus:outline-none"
              >
                {seasons.map((s) => (
                  <option key={s.number} value={s.number} className="bg-[#121218] text-white">
                    Season {s.number} ({s.episodes.length} Ep)
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 size-3 text-white/60" />
            </div>
          )}

          {/* Grid vs Compact List Toggle */}
          <div className="flex items-center rounded-full bg-white/[0.06] p-0.5 border border-white/10">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              title="Grid Cards"
              className={`rounded-full p-1.5 transition ${
                viewMode === 'grid'
                  ? 'bg-accent text-accent-contrast shadow'
                  : 'text-white/50 hover:text-white'
              }`}
            >
              <Grid className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('compact')}
              title="Compact Rows"
              className={`rounded-full p-1.5 transition ${
                viewMode === 'compact'
                  ? 'bg-accent text-accent-contrast shadow'
                  : 'text-white/50 hover:text-white'
              }`}
            >
              <List className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      {current.episodes.length === 0 ? (
        <EmptyState title="No episodes available" hint="Upstream has not published episodes for this season yet." />
      ) : viewMode === 'grid' ? (
        /* Movnix Responsive Compact Grid (2 to 5 columns of neat cards) */
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
          {current.episodes.map((item) => {
            const isSelected = item.number === active;
            const tmdbEp = epMetaMap.get(item.number);
            const stillUrl = tmdbEp?.still_path
              ? getTmdbImageUrl(tmdbEp.still_path, 'w500')
              : posterUrl;
            const episodeTitle = tmdbEp?.name || (item.title ? cleanTitle(item.title) : `Episode ${item.number}`);
            const durationLabel = tmdbEp?.runtime ? `${tmdbEp.runtime}m` : '24m';

            return (
              <div
                key={`${item.season}:${item.number}`}
                onClick={() => onSelect(current.number, item.number)}
                className={`group cursor-pointer rounded-xl border p-2 transition duration-200 overflow-hidden flex flex-col ${
                  isSelected
                    ? 'bg-accent/15 border-accent/60 shadow-[0_0_18px_rgba(245,166,35,0.2)] ring-1 ring-accent/40'
                    : 'bg-[#121218]/80 hover:bg-[#181824] border-white/[0.08] hover:border-white/20'
                }`}
              >
                {/* 16:9 Thumbnail with Overlay */}
                <div className="relative aspect-video w-full rounded-lg overflow-hidden bg-black/60 border border-white/10 shrink-0">
                  <PosterImage
                    src={stillUrl ?? null}
                    alt={episodeTitle}
                    className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-105 opacity-85"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                  {/* Centered Play Button */}
                  <div
                    className={`absolute inset-0 grid place-items-center transition duration-200 ${
                      isSelected ? 'opacity-100 bg-black/20' : 'opacity-0 group-hover:opacity-100 bg-black/35'
                    }`}
                  >
                    <div
                      className={`size-7 rounded-full grid place-items-center transition shadow-md ${
                        isSelected
                          ? 'bg-accent text-accent-contrast scale-105'
                          : 'bg-white/90 text-black group-hover:scale-110'
                      }`}
                    >
                      <Play className="size-3 fill-current ml-0.5" />
                    </div>
                  </div>

                  {/* E{number} Badge */}
                  <div
                    className={`absolute top-1 left-1 rounded px-1.5 py-0.2 text-[9px] font-bold font-mono shadow backdrop-blur-md ${
                      isSelected
                        ? 'bg-accent text-accent-contrast font-black'
                        : 'bg-black/80 text-white/90 border border-white/15'
                    }`}
                  >
                    E{item.number}
                  </div>

                  {/* Duration */}
                  <div className="absolute bottom-1 right-1 rounded bg-black/75 px-1 py-0.2 text-[8.5px] font-mono text-white/70">
                    {durationLabel}
                  </div>
                </div>

                {/* Text Content */}
                <div className="mt-2 min-w-0 flex-1 flex flex-col justify-between">
                  <h3
                    className={`text-[12px] font-semibold leading-snug line-clamp-2 transition ${
                      isSelected ? 'text-accent' : 'text-white/90 group-hover:text-accent'
                    }`}
                    title={episodeTitle}
                  >
                    {item.number}. {episodeTitle}
                  </h3>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-white/40">
                    <span>S{current.number} E{item.number}</span>
                    {isSelected && (
                      <span className="text-accent font-bold">Selected</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Movnix Sleek Compact List (slim rows, zero bulky height) */
        <ul className="grid gap-2 list-none p-0 m-0">
          {current.episodes.map((item) => {
            const isSelected = item.number === active;
            const tmdbEp = epMetaMap.get(item.number);
            const stillUrl = tmdbEp?.still_path
              ? getTmdbImageUrl(tmdbEp.still_path, 'w500')
              : posterUrl;
            const episodeTitle = tmdbEp?.name || (item.title ? cleanTitle(item.title) : `Episode ${item.number}`);
            const episodeOverview = tmdbEp?.overview || item.overview || `Season ${current.number}, Episode ${item.number}`;
            const durationLabel = tmdbEp?.runtime ? `${tmdbEp.runtime}m` : '24m';

            return (
              <li key={`${item.season}:${item.number}`} className="w-full">
                <div
                  onClick={() => onSelect(current.number, item.number)}
                  className={`group flex items-center gap-3 p-1.5 sm:p-2 rounded-xl transition duration-150 border w-full overflow-hidden cursor-pointer ${
                    isSelected
                      ? 'bg-accent/15 border-accent/60 shadow-[0_0_15px_rgba(245,166,35,0.18)] ring-1 ring-accent/40'
                      : 'bg-white/[0.03] hover:bg-white/[0.06] border-white/[0.06] hover:border-white/15'
                  }`}
                >
                  {/* Slim Thumbnail */}
                  <div className="relative shrink-0 w-24 sm:w-28 aspect-video rounded-lg overflow-hidden bg-black/60 border border-white/10">
                    <PosterImage
                      src={stillUrl ?? null}
                      alt={episodeTitle}
                      className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-105 opacity-85"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />

                    <div
                      className={`absolute inset-0 grid place-items-center transition duration-150 ${
                        isSelected ? 'opacity-100 bg-black/25' : 'opacity-0 group-hover:opacity-100 bg-black/40'
                      }`}
                    >
                      <div
                        className={`size-6 rounded-full grid place-items-center shadow ${
                          isSelected
                            ? 'bg-accent text-accent-contrast'
                            : 'bg-white/90 text-black'
                        }`}
                      >
                        <Play className="size-2.5 fill-current ml-0.5" />
                      </div>
                    </div>

                    <div
                      className={`absolute top-1 left-1 rounded px-1 py-0.2 text-[8.5px] font-bold font-mono shadow ${
                        isSelected
                          ? 'bg-accent text-accent-contrast'
                          : 'bg-black/80 text-white/90 border border-white/15'
                      }`}
                    >
                      E{item.number}
                    </div>
                  </div>

                  {/* Episode Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3
                        className={`text-[12.5px] font-semibold tracking-tight transition line-clamp-1 ${
                          isSelected ? 'text-accent' : 'text-white group-hover:text-accent'
                        }`}
                      >
                        {item.number}. {episodeTitle}
                      </h3>
                      <span className="shrink-0 text-[10.5px] text-white/40 font-mono">
                        {durationLabel}
                      </span>
                    </div>

                    <p className="mt-0.5 text-[11px] text-white/50 line-clamp-1">
                      {episodeOverview}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Movnix-style Top Billed Cast section:
 * Displays circular actor profile photos, real names, character roles,
 * and clickable search links.
 */
function CastSection({
  title,
  year,
  isTv,
  starsFallback,
}: {
  title: string;
  year?: string | null;
  isTv: boolean;
  starsFallback?: string | null;
}) {
  const [cast, setCast] = useState<CastMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function loadCast() {
      setLoading(true);
      const tmdbId = await searchTmdbMedia(title, year, isTv);
      if (tmdbId) {
        const members = await fetchTmdbCast(tmdbId, isTv);
        if (!cancelled && members.length > 0) {
          setCast(members);
          setLoading(false);
          return;
        }
      }

      // Fallback: Use starsFallback if TMDB doesn't find cast
      if (!cancelled) {
        if (starsFallback) {
          const names = starsFallback.split(/,\s*/);
          setCast(
            names.map((name, i) => ({
              id: i,
              name: name.trim(),
              character: 'Cast',
              profile_path: null,
            }))
          );
        }
        setLoading(false);
      }
    }
    loadCast();
    return () => {
      cancelled = true;
    };
  }, [title, year, isTv, starsFallback]);

  if (!loading && cast.length === 0) return null;

  return (
    <section className="mt-14 border-t border-white/[0.08] pt-10">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="h-1.5 w-6 rounded-full bg-accent" />
            <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50">
              The Ensemble
            </span>
          </div>
          <h2 className="font-display text-2xl md:text-3xl font-bold tracking-tight text-white flex flex-wrap items-center gap-3">
            <span>Top Billed Cast</span>
            <span className="text-xs font-mono font-normal text-white/50 px-2.5 py-1 rounded-full bg-white/[0.06] border border-white/10">
              {cast.length} Actors & Performers
            </span>
          </h2>
        </div>
      </div>

      {loading ? (
        <div className="flex gap-6 overflow-x-auto pb-4 scrollbar-hide">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="shrink-0 w-[110px] sm:w-[124px] text-center space-y-3">
              <div className="size-[110px] sm:size-[124px] mx-auto rounded-full skeleton animate-pulse bg-white/5" />
              <div className="h-3.5 w-20 mx-auto rounded skeleton bg-white/5" />
              <div className="h-2.5 w-16 mx-auto rounded skeleton bg-white/5" />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar-hide -mx-4 sm:-mx-6 select-none">
          <div className="flex gap-6 px-4 sm:px-6 pb-4">
            {cast.map((actor) => {
              const photo = actor.profile_path
                ? getTmdbImageUrl(actor.profile_path, 'w185')
                : null;

              return (
                <Link
                  key={actor.id}
                  to={paths.search(actor.name)}
                  className="shrink-0 w-[110px] sm:w-[124px] text-center block group hover:no-underline cursor-pointer"
                  title={`${actor.name} as ${actor.character}`}
                >
                  <div className="relative size-[110px] sm:size-[124px] mx-auto rounded-full overflow-hidden bg-white/5 ring-1 ring-white/15 shadow-xl transition-all duration-300 group-hover:ring-accent/80 group-hover:scale-105 group-hover:shadow-[0_0_20px_var(--accent-subtle)]">
                    {photo ? (
                      <img
                        src={photo}
                        alt={actor.name}
                        loading="lazy"
                        className="size-full object-cover transition-transform duration-500 group-hover:scale-110"
                      />
                    ) : (
                      <div className="size-full flex items-center justify-center bg-white/[0.04] text-white/40">
                        <User className="size-10" />
                      </div>
                    )}
                  </div>
                  <p className="mt-3 text-[13px] font-semibold text-white line-clamp-1 group-hover:text-accent transition-colors">
                    {actor.name}
                  </p>
                  <p className="text-xs text-white/50 italic font-display line-clamp-1">
                    {actor.character}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Fallbacks                                                                   */
/* -------------------------------------------------------------------------- */

export function DetailsSkeleton() {
  return (
    <Frame>
      <div className="fixed inset-x-0 top-0 -z-10 h-[420px] skeleton" aria-hidden="true" />
      <div className="flex flex-col gap-7 lg:flex-row lg:gap-10">
        <div className="skeleton h-[240px] w-[160px] shrink-0 rounded-card sm:h-[315px] sm:w-[210px]" />
        <div className="flex-1">
          <div className="skeleton h-9 w-2/3" />
          <div className="skeleton mt-4 h-3.5 w-40" />
          <div className="skeleton mt-7 h-12 w-52 rounded-full" />
          <div className="skeleton mt-6 h-3 w-full" />
          <div className="skeleton mt-2.5 h-3 w-11/12" />
          <div className="skeleton mt-2.5 h-3 w-3/4" />
        </div>
      </div>
    </Frame>
  );
}

/** A link naming a provider this build does not know. */
export function UnknownProvider() {
  return (
    <Frame>
      <EmptyState
        title="Unknown provider"
        hint="This link names a source MovieBox does not recognise. It may come from an older or newer version."
        action={
          <Link
            to={paths.home()}
            className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
          >
            Back to home
          </Link>
        }
      />
    </Frame>
  );
}