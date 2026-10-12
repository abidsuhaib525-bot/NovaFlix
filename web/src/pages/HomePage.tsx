/**
 * Home page.
 *
 * Order is deliberate. The hero is the first thing a visitor sees. Resume-watching
 * sits above discovery because the reason to come back to a streaming app is to
 * finish something already started. The metric-ranked rails come last because
 * browsing is what you do when you have nothing specific in mind.
 *
 * Each rail is an independent query with its own state, and a rail that fails is
 * skipped rather than shown. One broken upstream tab must not take the home page
 * down with it -- the page is a collection of rails, not one request.
 */

import { X } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { ErrorState, SectionHeading, SkeletonRail } from '@/components/common/StateBlocks';
import { HeroBanner } from '@/components/media/HeroBanner';
import { PosterCard } from '@/components/media/PosterCard';
import { Rail } from '@/components/media/Rail';
import {
  isInProgress,
  progressFraction,
  useBrowseRails,
  useDeleteHistory,
  useFavorites,
  useHomepage,
  useHomepageTabs,
  useHistory,
} from '@/hooks/useCatalog';
import { cleanTitle, describeTitle } from '@/lib/format';
import { paths, storedTitlePath, storedWatchPath } from '@/lib/routes';
import type { BrowseRail, CatalogItem, FavoriteItem, WatchHistoryItem } from '@/types';

/**
 * Rail order is not decided here.
 *
 * `BrowsePreset::ALL` on the server owns it, because the server is also what
 * decides how many rails exist. A frontend copy of the list would silently drift
 * the moment a preset was added, and would render a placeholder row for a rail
 * that does not exist while quietly dropping one that does.
 */

/** Tile width. Shared so the rail's scroll maths and the tiles cannot drift. */
const TILE = 'w-[165px] shrink-0 sm:w-[195px] md:w-[215px]';

/** How many resume cards before the row stops being a glance and starts being a list. */
const RESUME_LIMIT = 12;

/** How many favourites the home page offers before deferring to the library. */
const FAVORITES_LIMIT = 12;

/** How many titles from the default feed feed the hero and the latest rail. */
const FEATURED = 20;

/**
 * Skeleton rails shown while the real ones load.
 *
 * Four, because the response carries every rail and they all arrive together --
 * there is no point in a placeholder for one row and an empty gap for the rest.
 * A per-rail skeleton would imply a per-rail request, which is exactly what this
 * page no longer does.
 */
const RAIL_COUNT = 4;

export function HomePage() {
  // Tab 1 is "For You": the broad mixed feed. A constant rather than a fetched
  // value because the home page must render before the tab list arrives, and the
  // hero is the largest thing on screen -- it cannot wait on two requests.
  const deck = useHomepage('1');
  const rails = useBrowseRails();
  const history = useHistory();
  const favorites = useFavorites();

  const resumable = useMemo(
    () => (history.data ?? []).filter(isInProgress).slice(0, RESUME_LIMIT),
    [history.data],
  );

  const featured = useMemo(
    () => deck.data?.items.slice(0, FEATURED) ?? [],
    [deck.data],
  );

  const trendingRail = useMemo(
    () => (rails.data ?? []).find((r) => r.key === 'trending') ?? null,
    [rails.data],
  );

  const otherRails = useMemo(
    () => (rails.data ?? []).filter((r) => r.key !== 'trending'),
    [rails.data],
  );

  return (
    <div className="relative">
      {deck.data && deck.data.items.length > 0 ? (
        <HeroBanner items={deck.data.items} metrics={deck.data.metrics} />
      ) : deck.isPending ? (
        <div className="skeleton h-[580px] sm:h-[660px] md:h-[720px] lg:h-[780px] w-full" aria-hidden="true" />
      ) : null}

      <div className="relative z-10 mx-auto max-w-[1700px] px-4 -mt-14 sm:-mt-20 md:-mt-24 sm:px-6 lg:px-8 space-y-12 pb-16">
        {resumable.length > 0 && (
          <ResumeRail items={resumable} history={history.data ?? []} />
        )}

        {(favorites.data?.length ?? 0) > 0 && (
          <FavoritesRail items={favorites.data!.slice(0, FAVORITES_LIMIT)} />
        )}

        {/* 1. Trending at top */}
        {trendingRail && <BrowseRailSection key={trendingRail.key} rail={trendingRail} />}

        {/* 2. Latest additions second */}
        <FeaturedRail items={featured} pending={deck.isPending} />

        {/* 3. Remaining ranked rails */}
        {rails.isPending ? (
          Array.from({ length: Math.max(1, RAIL_COUNT - 1) }, (_, index) => <SkeletonRail key={index} />)
        ) : (
          otherRails.map((rail) => <BrowseRailSection key={rail.key} rail={rail} />)
        )}

        <CategoryDirectory />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Resume                                                                      */
/* -------------------------------------------------------------------------- */

function ResumeRail({
  items,
  history,
}: {
  items: WatchHistoryItem[];
  history: WatchHistoryItem[];
}) {
  // Progress is keyed by subject id so the tile can look up its own bar without
  // being handed a second copy of every field.
  const progress = useMemo(
    () => new Map(history.map((entry) => [entry.subject_id, progressFraction(entry)])),
    [history],
  );

  return (
    <section className="mb-9">
      <SectionHeading
        id="heading-resume"
        title="Continue watching"
        action={<SeeAllLink to={paths.library()}>See all</SeeAllLink>}
      />
      <Rail labelledBy="heading-resume">
        {items.map((entry) => (
          <ResumeCard
            key={`${entry.provider}:${entry.subject_id}`}
            entry={entry}
            progress={progress.get(entry.subject_id) ?? 0}
          />
        ))}
      </Rail>
    </section>
  );
}

/**
 * A resume tile.
 *
 * Not `PosterCard`: a history entry has a cover URL and a resume position, not a
 * `CatalogItem`, so there is no provider-id object or media type to build one
 * from. The bar along the bottom edge is the reason this is a separate component
 * rather than a `PosterCard` variant.
 */
function ResumeCard({ entry, progress }: { entry: WatchHistoryItem; progress: number }) {
  // `describeTitle` cleans the upstream tags and appends the year. The card body
  // shows the bare title and the year is already implied by the season line, so
  // only the aria-label needs the full form.
  const label = describeTitle(entry.title, entry.release_year);
  const deleteHistory = useDeleteHistory();

  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    deleteHistory.mutate({ provider: entry.provider, id: entry.subject_id });
  };

  return (
    <article
      className={`group card-hover relative ${TILE} overflow-hidden rounded-card border border-border-subtle bg-bg-surface`}
    >
      <Link to={storedWatchPath(entry.provider, entry.subject_id, {
        season: entry.season,
        episode: entry.episode,
      })} aria-label={`Resume ${label}`}>
        <CoverImage url={entry.cover_url} alt="" />
        <div className="px-2.5 pb-2.5 pt-2">
          <h3 className="line-clamp-1 text-[12.5px] font-medium leading-snug text-fg-default">
            {cleanTitle(entry.title)}
          </h3>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            {entry.season > 0 ? `Season ${entry.season}, Episode ${entry.episode}` : 'Movie'}
          </p>
        </div>
      </Link>

      {/* Quick Remove Button */}
      <button
        type="button"
        onClick={handleRemove}
        title="Remove from Continue Watching"
        aria-label="Remove from Continue Watching"
        className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-fg-muted backdrop-blur-md opacity-0 shadow-md transition-all duration-200 hover:scale-110 hover:bg-red-600 hover:text-white group-hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="absolute inset-x-0 bottom-0 h-[3px] bg-bg-base/70" aria-hidden="true">
        <div
          className="h-full bg-accent"
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Favourites                                                                  */
/* -------------------------------------------------------------------------- */

function FavoritesRail({ items }: { items: FavoriteItem[] }) {
  return (
    <section className="mb-9">
      <SectionHeading
        id="heading-favourites"
        title="Your favourites"
        action={<SeeAllLink to={paths.library()}>See all</SeeAllLink>}
      />
      <Rail labelledBy="heading-favourites">
        {items.map((favorite) => (
          <article
            key={`${favorite.provider}:${favorite.subject_id}`}
            className={`card-hover ${TILE} overflow-hidden rounded-card border border-border-subtle bg-bg-surface`}
          >
            <Link
              to={storedTitlePath(favorite.provider, favorite.subject_id)}
              aria-label={describeTitle(favorite.title, favorite.release_year)}
            >
              <CoverImage url={favorite.cover_url} alt="" />
              <div className="px-2.5 pb-2.5 pt-2">
                <h3 className="line-clamp-1 text-[12.5px] font-medium leading-snug text-fg-default">
                  {cleanTitle(favorite.title)}
                </h3>
                {favorite.release_year && (
                  <p className="mt-0.5 text-[11px] text-fg-subtle">{favorite.release_year}</p>
                )}
              </div>
            </Link>
          </article>
        ))}
      </Rail>
    </section>
  );
}

/**
 * A cover that keeps its box when there is no image.
 *
 * History and favourite covers are landscape artwork, cropped into a 2:3 tile.
 * Cropping alone leaves a strip of a face; the gradient at the foot carries the
 * text instead, which is why the text sits over the image rather than under it.
 */
function CoverImage({ url, alt }: { url: string | null; alt: string }) {
  return (
    <div className="relative">
      {url ? (
        <img
          src={`/api/poster?url=${encodeURIComponent(url)}`}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="aspect-poster w-full object-cover"
        />
      ) : (
        <div className="aspect-poster w-full bg-bg-raised" />
      )}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg-base/90 to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rails                                                                       */
/* -------------------------------------------------------------------------- */

function FeaturedRail({ items, pending }: { items: CatalogItem[]; pending: boolean }) {
  if (pending) return <SkeletonRail />;
  if (items.length === 0) return null;

  return (
    <section className="mb-9">
      <SectionHeading id="heading-latest" title="Latest additions" />
      <Rail labelledBy="heading-latest">
        {items.map((item) => (
          <PosterCard key={itemKey(item)} item={item} className={TILE} />
        ))}
      </Rail>
    </section>
  );
}

/**
 * One metric-ranked rail.
 *
 * A plain prop now, not a query of its own. It was a query per rail before, and
 * four of them at once is what drove the upstream CDN into rate-limiting -- see
 * `useBrowseRails`. The server has already ordered and capped the items, so this
 * only lays them out.
 *
 * An empty rail renders nothing rather than an empty heading. The server omits
 * rails whose sources all failed, so an empty one here means the response
 * carried a rail with nothing in it, and a heading over blank space is worse
 * than no heading.
 */
function BrowseRailSection({ rail }: { rail: BrowseRail }) {
  if (rail.items.length === 0) return null;
  const isTrending = rail.key === 'trending';

  return (
    <section className="mb-9">
      <SectionHeading
        id={`heading-${rail.key}`}
        title={isTrending ? "Top 10 Trending Today" : rail.label}
      />
      <Rail labelledBy={`heading-${rail.key}`}>
        {rail.items.map((item, index) => (
          <PosterCard
            key={itemKey(item)}
            item={item}
            className={TILE}
            rank={isTrending && index < 10 ? index + 1 : undefined}
          />
        ))}
      </Rail>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Categories                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every category as a link grid.
 *
 * The nav bar shows four tabs; this shows all of them. That redundancy is the
 * point -- nothing on the site should be reachable only by knowing its id.
 */
function CategoryDirectory() {
  const tabs = useHomepageTabs();

  if (tabs.isPending) {
    return (
      <section className="mb-6 mt-12">
        <SectionHeading id="heading-categories" title="Browse by category" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, index) => (
            <div key={index} className="skeleton h-[72px] rounded-card" />
          ))}
        </div>
      </section>
    );
  }

  if (tabs.isError) {
    return (
      <section className="mb-6 mt-12">
        <SectionHeading id="heading-categories" title="Browse by category" />
        <ErrorState
          error={tabs.error}
          onRetry={() => void tabs.refetch()}
          title="Could not load categories"
        />
      </section>
    );
  }

  return (
    <section className="mb-6 mt-12">
      <SectionHeading id="heading-categories" title="Browse by category" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tabs.data.map((tab) => (
          <Link
            key={tab.id}
            to={paths.tab(tab.id)}
            className="surface card-hover rounded-card px-4 py-3.5"
          >
            <p className="truncate text-[13.5px] font-semibold text-fg-default transition group-hover:text-accent">
              {tab.label}
            </p>
            <p className="mt-0.5 line-clamp-1 text-[11.5px] text-fg-subtle">{tab.blurb}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

/** Stable React key. Provider plus id, because two providers can share an id. */
function itemKey(item: CatalogItem): string {
  return `${item.id.provider}:${item.id.value}`;
}

function SeeAllLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="text-[12.5px] font-medium text-fg-muted transition hover:text-accent">
      {children}
    </Link>
  );
}