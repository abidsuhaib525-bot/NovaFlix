/**
 * One homepage tab, as a paginated grid.
 *
 * Explicit paging rather than infinite scroll. MovieBox returns a few hundred
 * titles per tab, the grid reflows as pages land, and a mis-click five screens
 * down throws away the scroll position. Paging also keeps the URL shareable and
 * the back button meaningful.
 */

import { ChevronLeft, ChevronRight, Film, Search, SlidersHorizontal, Tv, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SkeletonGrid,
} from '@/components/common/StateBlocks';
import { PosterCard } from '@/components/media/PosterCard';
import { useHomepage, useHomepageTabs } from '@/hooks/useCatalog';
import { paths, readIndex } from '@/lib/routes';

/**
 * How many titles a page is expected to hold.
 *
 * Only used to decide whether a next page exists, because the upstream response
 * carries no total. See `hasMore` below for why the threshold is loose.
 */
const PAGE_SIZE = 30;

export function TabPage() {
  const { tabId: rawTabId = '' } = useParams();
  const [params, setParams] = useSearchParams();

  const tabs = useHomepageTabs();
  const tabId = rawTabId || '1';
  const page = readIndex(params.get('page')) ?? 1;
  const deck = useHomepage(tabId, page);

  const [searchQuery, setSearchQuery] = useState('');
  const [mediaFilter, setMediaFilter] = useState<'all' | 'movie' | 'series'>('all');
  const [sortBy, setSortBy] = useState<'default' | 'newest' | 'oldest' | 'title-asc' | 'title-desc'>('default');

  // Reset in-page filters on tab or page change
  useEffect(() => {
    setSearchQuery('');
    setMediaFilter('all');
    setSortBy('default');
  }, [tabId, page]);

  // Back to the top on a page change. Without this, page 2 renders at the
  // scroll offset page 1 left behind and the user lands mid-grid.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [tabId, page]);

  const tab = tabs.data?.find((candidate) => candidate.id === tabId);
  const rawItems = deck.data?.items ?? [];
  const count = rawItems.length;

  // Filtered and sorted items
  const displayItems = useMemo(() => {
    let result = [...rawItems];

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((item) => item.title.toLowerCase().includes(q));
    }

    if (mediaFilter !== 'all') {
      result = result.filter((item) => item.media_type === mediaFilter);
    }

    if (sortBy === 'title-asc') {
      result.sort((a, b) => a.title.localeCompare(b.title));
    } else if (sortBy === 'title-desc') {
      result.sort((a, b) => b.title.localeCompare(a.title));
    } else if (sortBy === 'newest') {
      result.sort((a, b) => {
        const ya = a.year ? parseInt(a.year, 10) || 0 : 0;
        const yb = b.year ? parseInt(b.year, 10) || 0 : 0;
        return yb - ya;
      });
    } else if (sortBy === 'oldest') {
      result.sort((a, b) => {
        const ya = a.year ? parseInt(a.year, 10) || 9999 : 9999;
        const yb = b.year ? parseInt(b.year, 10) || 9999 : 9999;
        return ya - yb;
      });
    }

    return result;
  }, [rawItems, searchQuery, mediaFilter, sortBy]);

  const hasActiveFilters = searchQuery.trim() !== '' || mediaFilter !== 'all' || sortBy !== 'default';

  /**
   * Whether a next page exists.
   */
  const hasMore = count >= PAGE_SIZE - 6;

  const goToPage = (next: number) => {
    setParams(next <= 1 ? {} : { page: String(next) });
  };

  const tabTitle = useMemo(() => {
    if (tabId === '19') return 'Hollywood Blockbusters';
    if (tabId === '2') return 'Bollywood & Hindi Cinema';
    if (tabId === '8') return 'Anime & Japanese Animation';
    if (tabId === '5') return 'TV Series & Shows';
    return tab?.label ?? 'Browse';
  }, [tabId, tab?.label]);

  const tabSubtitle = useMemo(() => {
    if (tabId === '19') return 'Hollywood and international blockbuster movies and series in 4K UHD';
    if (tabId === '2') return 'Top Hindi and Bollywood movies, romance, action, thriller & comedy';
    if (tabId === '8') return 'Popular Japanese anime series and movies with multi-language dubs';
    if (tabId === '5') return 'Binge-worthy television shows and serialized drama';
    return tab?.blurb;
  }, [tabId, tab?.blurb]);

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title={tabTitle}
        subtitle={tabSubtitle}
        action={<CategorySelect current={tabId} />}
      />

      {/* Filter and Discovery Control Bar */}
      {!deck.isPending && !deck.isError && count > 0 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-bg-surface/60 p-3 shadow-md backdrop-blur-md">
          {/* Left: Quick search and type pills */}
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex items-center">
              <Search className="pointer-events-none absolute left-3 size-4 text-fg-subtle" />
              <input
                type="text"
                placeholder="Filter titles on this page..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-48 sm:w-64 rounded-full border border-border-default bg-black/40 py-1.5 pl-9 pr-8 text-[12.5px] text-fg-default placeholder-fg-subtle outline-none transition focus:border-accent focus:w-72"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 text-fg-subtle hover:text-fg-default"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            {/* Media type pills */}
            <div className="flex items-center rounded-full bg-black/40 p-0.5 border border-white/5">
              <button
                type="button"
                onClick={() => setMediaFilter('all')}
                className={`rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  mediaFilter === 'all'
                    ? 'bg-accent text-accent-contrast shadow-sm'
                    : 'text-fg-muted hover:text-fg-default'
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setMediaFilter('movie')}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  mediaFilter === 'movie'
                    ? 'bg-accent text-accent-contrast shadow-sm'
                    : 'text-fg-muted hover:text-fg-default'
                }`}
              >
                <Film className="size-3" />
                Movies
              </button>
              <button
                type="button"
                onClick={() => setMediaFilter('series')}
                className={`flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition ${
                  mediaFilter === 'series'
                    ? 'bg-accent text-accent-contrast shadow-sm'
                    : 'text-fg-muted hover:text-fg-default'
                }`}
              >
                <Tv className="size-3" />
                Series
              </button>
            </div>
          </div>

          {/* Right: Sort & Count */}
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-medium text-fg-subtle">
              Showing <strong className="text-fg-default">{displayItems.length}</strong> of {count}
            </span>

            <div className="flex items-center gap-1.5">
              <SlidersHorizontal className="size-3.5 text-fg-subtle" />
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="appearance-none rounded-full border border-border-default bg-black/40 py-1.5 pl-3 pr-7 text-[12px] font-medium text-fg-default outline-none transition hover:border-border-strong focus:border-accent"
              >
                <option value="default">Default Sort</option>
                <option value="newest">Newest Year</option>
                <option value="oldest">Oldest Year</option>
                <option value="title-asc">Title (A to Z)</option>
                <option value="title-desc">Title (Z to A)</option>
              </select>
            </div>

            {hasActiveFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setMediaFilter('all');
                  setSortBy('default');
                }}
                className="text-[11.5px] font-semibold text-accent hover:underline"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}

      {deck.isPending ? (
        <SkeletonGrid />
      ) : deck.isError ? (
        <ErrorState
          error={deck.error}
          onRetry={() => void deck.refetch()}
          title={`Could not load ${tab?.label ?? 'this category'}`}
        />
      ) : count === 0 ? (
        <EmptyState
          title="Nothing here yet"
          hint="This category is empty upstream. Try another one, or search for what you have in mind."
        />
      ) : displayItems.length === 0 ? (
        <EmptyState
          title="No matching titles"
          hint="No items match your filter. Try adjusting your search term or filters."
          action={
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setMediaFilter('all');
                setSortBy('default');
              }}
              className="rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-contrast"
            >
              Clear Filters
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
          {displayItems.map((item) => (
            <PosterCard
              key={`${item.id.provider}:${item.id.value}`}
              item={item}
              className="w-full"
            />
          ))}
        </div>
      )}

      {!deck.isPending && !deck.isError && (hasMore || page > 1) && (
        <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3">
          <PageButton side="prev" disabled={page <= 1} onClick={() => goToPage(page - 1)} />
          <span className="text-[13px] text-fg-muted">Page {page}</span>
          <PageButton side="next" disabled={!hasMore} onClick={() => goToPage(page + 1)} />
        </nav>
      )}
    </div>
  );
}

/**
 * Move between categories.
 *
 * A `<select>` rather than a second strip of tab links. The nav bar already
 * carries category links; a full-width row of ten tabs above a grid would push
 * the first row of posters below the fold on a laptop. One control wide costs
 * nothing and keeps the grid high.
 */
function CategorySelect({ current }: { current: string }) {
  const { data: tabs = [] } = useHomepageTabs();
  const navigate = useNavigate();

  // With one category there is nothing to switch to, so the control is noise.
  if (tabs.length <= 1) return null;

  return (
    <label className="relative">
      <span className="sr-only">Category</span>
      <select
        value={current}
        onChange={(event) => navigate(paths.tab(event.target.value))}
        className="appearance-none rounded-full border border-border-default bg-bg-surface py-2 pl-4 pr-9 text-[13px] font-medium text-fg-default outline-none transition hover:border-border-strong focus:border-accent"
      >
        {tabs.map((tab) => (
          <option key={tab.id} value={tab.id}>
            {tab.label}
          </option>
        ))}
        {/* Keeps the control from rendering blank if the current category has
            left the advertised list -- a mature tab that settings have since
            turned off, reached from a stale link or the back button. */}
        {!tabs.some((tab) => tab.id === current) && (
          <option value={current}>{current}</option>
        )}
      </select>
      <ChevronRight
        className="pointer-events-none absolute right-3.5 top-1/2 size-3.5 -translate-y-1/2 rotate-90 text-fg-subtle"
        aria-hidden="true"
      />
    </label>
  );
}

function PageButton({
  side,
  disabled,
  onClick,
}: {
  side: 'prev' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = side === 'prev' ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-full border border-border-default px-4 py-2 text-[13px] font-medium text-fg-default transition hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-35"
    >
      {side === 'prev' ? (
        <>
          <Icon className="size-4" aria-hidden="true" />
          Previous
        </>
      ) : (
        <>
          Next
          <Icon className="size-4" aria-hidden="true" />
        </>
      )}
    </button>
  );
}

/**
 * A tab request with no id at all.
 *
 * `TabPage` handles any id it is given, including ones that are not in the
 * advertised list -- upstream answers an unknown id with the default feed rather
 * than an error, so refusing to render would be less helpful than showing
 * something. This only covers a missing parameter, which means a malformed URL.
 */
export function InvalidTabPage() {
  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <EmptyState
        title="No category requested"
        hint="The address is missing a category."
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