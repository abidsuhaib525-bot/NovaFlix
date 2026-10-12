/**
 * A poster tile.
 *
 * The whole tile is one link to the details page, and the play icon is a second,
 * overlapping link to the player. Two links rather than a button over a link,
 * because a button nested inside an anchor is invalid HTML and breaks keyboard
 * navigation -- tab order, Enter and the focus ring all misbehave.
 */

import { Play, Tv } from 'lucide-react';
import { Link } from 'react-router-dom';

import { PosterImage } from '@/components/media/PosterImage';
import { cleanTitle, extractEditionTags } from '@/lib/format';
import { paths } from '@/lib/routes';
import type { CatalogItem } from '@/types';

export function PosterCard({
  item,
  /** Watched fraction, 0 to 1. Drawn as a bar along the bottom edge. */
  progress,
  className = '',
  rank,
}: {
  item: CatalogItem;
  progress?: number;
  className?: string;
  rank?: number;
}) {
  const title = cleanTitle(item.title);
  const editionTags = extractEditionTags(item.title);
  const series = item.media_type === 'series';
  const details = paths.title(item.id.provider, item.id.value);

  // Only offer "play now" when there is somewhere to play from. Providers report
  // availability differently and an unknown shape must not produce a link that
  // 404s on arrival.
  const playable = Boolean(item.poster_url) || series || item.media_type === 'movie';

  return (
    <article className={`card-hover group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0c0d14]/90 shadow-[0_8px_24px_rgba(0,0,0,0.6)] backdrop-blur-md transition-all duration-300 hover:border-accent/40 hover:shadow-[0_16px_40px_rgba(0,0,0,0.9),0_0_24px_var(--accent-subtle)] ${className}`}>
      {/* Netflix-style Top 10 Giant Rank Number */}
      {rank !== undefined && rank <= 10 && (
        <div className="pointer-events-none absolute -bottom-5 -left-1.5 z-20 select-none">
          <span
            className="font-display text-[75px] sm:text-[95px] font-black leading-none tracking-tighter text-black/90 drop-shadow-[0_4px_12px_rgba(0,0,0,0.95)]"
            style={{
              WebkitTextStroke: '3px rgba(255, 255, 255, 0.9)',
              textShadow: '0 8px 24px rgba(0,0,0,0.95)',
            }}
          >
            {rank}
          </span>
        </div>
      )}

      <div className="relative aspect-poster w-full overflow-hidden bg-black/40">
        <Link
          to={details}
          className="block size-full focus-visible:outline-none"
          aria-label={`${title}${item.year ? ` (${item.year})` : ''}`}
        >
          <PosterImage src={item.poster_url} alt="" className="size-full object-cover transition-transform duration-500 ease-out group-hover:scale-108" />

          {/* Top Edge Specular Glow */}
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none" />

          {/* Cinematic dark hover veil */}
          <div
            className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/95 via-black/40 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100"
            aria-hidden="true"
          />
        </Link>

        {/* Top Badges */}
        <div className="pointer-events-none absolute left-2.5 top-2.5 z-10 flex flex-wrap items-center gap-1.5 max-w-[85%]">
          {series ? (
            <span className="flex items-center gap-1 rounded-full border border-white/20 bg-black/85 px-2.5 py-0.5 text-[10.5px] font-bold text-white shadow-md backdrop-blur-md">
              <Tv className="size-3 text-accent" aria-hidden="true" />
              {item.season_count ? `S${item.season_count}` : 'Series'}
            </span>
          ) : (
            <span className="rounded-full border border-white/15 bg-black/80 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white/90 shadow-md backdrop-blur-md">
              Movie
            </span>
          )}

          {/* Edition / Dub tag if present (e.g., Hindi, English, S1-S2) */}
          {editionTags.length > 0 && (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200 shadow-md backdrop-blur-md">
              {editionTags[0]}
            </span>
          )}
        </div>

        <span className="pointer-events-none absolute right-2.5 top-2.5 rounded-full border border-white/15 bg-black/75 px-2 py-0.5 text-[9.5px] font-black uppercase tracking-wider text-accent shadow-md backdrop-blur-md">
          4K
        </span>

        {playable && (
          <Link
            to={paths.watch(item.id.provider, item.id.value)}
            aria-label={`Play ${title}`}
            className="absolute left-1/2 top-1/2 z-10 grid size-12 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-accent text-accent-contrast opacity-0 shadow-[0_0_30px_var(--accent)] transition-all duration-300 hover:scale-110 group-hover:scale-100 group-hover:opacity-100 focus-visible:scale-100 focus-visible:opacity-100"
          >
            <Play className="size-5.5 translate-x-0.5 fill-current" aria-hidden="true" />
          </Link>
        )}

        {progress !== undefined && progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/80" aria-hidden="true">
            <div
              className="h-full bg-accent shadow-[0_0_10px_var(--accent)]"
              style={{ width: `${Math.min(100, Math.round(progress * 100))}%` }}
            />
          </div>
        )}
      </div>

      <div className="p-3 bg-gradient-to-b from-[#0c0d14] to-[#07070b]">
        <h3 className="line-clamp-1 font-display text-[13.5px] font-bold leading-snug text-white transition group-hover:text-accent flex items-center gap-1.5">
          <Link to={details} className="truncate">
            {title}
          </Link>
          {editionTags.length > 0 && (
            <span className="shrink-0 rounded bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.2 text-[10px] font-bold text-amber-300">
              {editionTags[0]}
            </span>
          )}
        </h3>
        <div className="mt-1 flex items-center justify-between text-[11.5px] text-white/50">
          <span className="font-medium flex items-center gap-1.5">
            {item.year || (series ? 'Series' : 'Movie')}
            {editionTags.length > 1 && (
              <span className="text-[10px] text-amber-300/80 font-semibold">({editionTags[1]})</span>
            )}
          </span>
          {series && item.season_count ? (
            <span className="font-semibold text-accent text-[11px]">{item.season_count} Season{item.season_count > 1 ? 's' : ''}</span>
          ) : (
            <span className="text-[10.5px] text-white/40 font-mono">UHD</span>
          )}
        </div>
      </div>
    </article>
  );
}