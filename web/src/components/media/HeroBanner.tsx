/**
 * Hero banner.
 *
 * One featured title at a time, with the poster as a heavily blurred backdrop and
 * the copy over a scrim. There is no landscape artwork anywhere in the MovieBox
 * catalogue -- `CatalogItem` carries only a portrait poster -- so the backdrop is
 * the portrait blown up and blurred rather than a wide still that does not exist.
 * A heavily blurred portrait does not read as a stretched one; a stretched
 * portrait reads as broken immediately.
 */

import { Info, Play, Star } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { PosterImage } from '@/components/media/PosterImage';
import { cleanTitle } from '@/lib/format';
import { paths } from '@/lib/routes';
import type { CatalogItem, BrowseMetrics } from '@/types';

/** How long each slide is held. */
const SLIDE_MS = 7_000;

/**
 * How many titles are eligible to be the hero.
 *
 * Capped because the selector strip below the copy grows with the pool, and a
 * banner offering twenty choices stops being a banner. The cap also keeps the
 * strip inside one line on a laptop screen.
 */
const HERO_POOL = 6;

export function HeroBanner({
  items,
  metrics,
}: {
  items: CatalogItem[];
  metrics: Record<string, BrowseMetrics>;
}) {
  const pool = useMemo(() => items.slice(0, HERO_POOL), [items]);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  /**
   * Clamp rather than reset.
   *
   * When the pool shrinks -- a different tab, or a refetch that returns fewer
   * items -- the old index can point past the end. Resetting to 0 would flash
   * back to the first slide; clamping keeps whatever the user was looking at.
   */
  const active = pool.length === 0 ? undefined : pool[Math.min(index, pool.length - 1)];

  useEffect(() => {
    if (paused || pool.length < 2) return;

    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % pool.length);
    }, SLIDE_MS);

    return () => window.clearInterval(timer);
  }, [paused, pool.length]);

  if (!active) return null;

  const title = cleanTitle(active.title);
  const rating = metrics[active.id.value]?.rating ?? null;
  const isSeries = active.media_type === 'series';

  return (
    <section
      className="relative w-full overflow-hidden h-[580px] sm:h-[660px] md:h-[720px] lg:h-[780px]"
      // Paused on hover so the slide does not change out from under a pointer
      // that is about to click.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-roledescription="carousel"
      aria-label="Featured titles"
    >
      {/* Full-Bleed Cinematic Backdrop */}
      <div className="absolute inset-0" aria-hidden="true">
        <PosterImage
          src={active.poster_url}
          alt=""
          className="size-full object-cover object-top scale-105 filter brightness-[0.85] contrast-[1.05] transition-all duration-700 ease-out"
        />
        {/* Left deep gradient veil for maximum text legibility */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#07070a] via-[#07070a]/85 via-45% to-transparent" />
        {/* Bottom smooth fade seamlessly connecting into content rails */}
        <div className="absolute inset-x-0 bottom-0 h-80 bg-gradient-to-t from-[#07070a] via-[#07070a]/75 via-40% to-transparent" />
        {/* Top subtle fade underneath floating glass navigation */}
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#07070a]/90 via-[#07070a]/40 to-transparent" />
      </div>

      <div className="relative mx-auto flex h-full max-w-[1700px] flex-col justify-end px-4 pb-28 sm:px-6 sm:pb-36 lg:px-8">
        <div className="max-w-2xl lg:max-w-3xl space-y-4 animate-fade-in" key={active.id.value}>
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[11px] font-black uppercase tracking-widest text-accent-contrast shadow-[0_0_18px_var(--accent)]">
              <span className="size-1.5 rounded-full bg-accent-contrast animate-pulse" />
              {isSeries ? 'TOP 10 SERIES' : 'BLOCKBUSTER PREMIERE'}
            </span>
            <span className="rounded-full bg-white/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white/90 backdrop-blur-md border border-white/20">
              Ultra HD 4K
            </span>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70 backdrop-blur-md">
              Dolby Atmos
            </span>
          </div>

          <h1 className="text-balance font-display text-4xl font-black leading-[1.05] tracking-tight text-white drop-shadow-[0_4px_30px_rgba(0,0,0,0.95)] sm:text-6xl lg:text-[68px]">
            {title}
          </h1>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-white/80 font-medium">
            {active.year && (
              <span className="font-bold text-white rounded-md bg-white/15 px-2.5 py-0.5 text-[12.5px] border border-white/20">
                {active.year}
              </span>
            )}
            {rating !== null && Number.isFinite(rating) && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-400/20 px-3 py-0.5 text-amber-300 font-bold ring-1 ring-amber-400/40">
                <Star className="size-4 fill-amber-400 text-amber-400" aria-hidden="true" />
                <span>{rating.toFixed(1)}</span>
                <span className="text-[12px] font-normal opacity-70">IMDb</span>
              </span>
            )}
            {isSeries && active.season_count ? (
              <span className="text-white/90 font-semibold">
                {active.season_count} Season{active.season_count === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>

          <div className="pt-2 flex flex-wrap items-center gap-4">
            <Link
              to={paths.watch(active.id.provider, active.id.value)}
              className="inline-flex items-center gap-3 rounded-2xl bg-white px-9 py-4 text-[15.5px] font-black text-black shadow-[0_4px_30px_rgba(255,255,255,0.4)] transition-all duration-200 hover:scale-105 hover:bg-white/90 active:scale-95"
            >
              <Play className="size-5 fill-current" aria-hidden="true" />
              Play Now
            </Link>
            <Link
              to={paths.title(active.id.provider, active.id.value)}
              className="inline-flex items-center gap-2.5 rounded-2xl border border-white/25 bg-white/15 px-7 py-4 text-[15px] font-bold text-white backdrop-blur-2xl transition-all duration-200 hover:bg-white/25 hover:border-white/40 hover:scale-105 active:scale-95"
            >
              <Info className="size-5" aria-hidden="true" />
              More Info
            </Link>
          </div>
        </div>

        {/* Carousel indicators placed cleanly on bottom right */}
        {pool.length > 1 && (
          <div className="absolute right-4 bottom-24 sm:right-6 sm:bottom-32 lg:right-8 flex items-center gap-2">
            {pool.map((item, position) => {
              const isCurrent = position === Math.min(index, pool.length - 1);
              return (
                <button
                  key={`${item.id.provider}:${item.id.value}:${position}`}
                  type="button"
                  onClick={() => setIndex(position)}
                  aria-label={`Show ${cleanTitle(item.title)}`}
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`h-1.5 rounded-full transition-all duration-300 cursor-pointer ${
                    isCurrent ? 'w-10 bg-accent shadow-[0_0_12px_var(--accent)]' : 'w-4 bg-white/30 hover:bg-white/60'
                  }`}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}