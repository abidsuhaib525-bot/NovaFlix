/**
 * Search results.
 *
 * The query lives in the URL, not in component state, for the usual reasons: a
 * result page is shareable, the back button steps through previous searches, and
 * a reload keeps the results.
 */

import { Search as SearchIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SkeletonGrid,
} from '@/components/common/StateBlocks';
import { PosterCard } from '@/components/media/PosterCard';
import { useSearch, useSettings } from '@/hooks/useCatalog';

const PAGE_SIZE = 30;

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q')?.trim() ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  /**
   * Search runs against the active provider.
   *
   * Read from settings rather than offered as a control: adding a provider
   * picker to the search page would imply searching several at once, and none of
   * the providers can be merged into one ordered result set without pretending
   * the rankings are comparable.
   */
  const { data: settings } = useSettings();
  const provider = settings?.active_provider ?? 'moviebox';

  const results = useSearch(provider, query, page);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [query, page]);

  const items = results.data ?? [];
  const hasMore = items.length >= PAGE_SIZE - 6;

  const goToPage = (next: number) => {
    setParams(next <= 1 ? { q: query } : { q: query, page: String(next) });
  };

  if (query.length === 0) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
        <EmptyState
          icon={<SearchIcon className="size-8" aria-hidden="true" />}
          title="Search for something"
          hint="Press / from anywhere to jump to the search box."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title={`Results for "${query}"`}
        subtitle={
          results.isPending
            ? 'Searching...'
            : `${items.length}${hasMore ? '+' : ''} result${items.length === 1 ? '' : 's'}`
        }
      />

      {results.isPending ? (
        <SkeletonGrid />
      ) : results.isError ? (
        <ErrorState
          error={results.error}
          onRetry={() => void results.refetch()}
          title="Search failed"
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No matches"
          hint={`Nothing found for "${query}". Check the spelling, or try a shorter phrase.`}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
            {items.map((item) => (
              <PosterCard
                key={`${item.id.provider}:${item.id.value}`}
                item={item}
                className="w-full"
              />
            ))}
          </div>

          {(hasMore || page > 1) && (
            <nav aria-label="Pagination" className="mt-10 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => goToPage(page - 1)}
                disabled={page <= 1}
                className="rounded-full border border-border-default px-4 py-2 text-[13px] font-medium text-fg-default transition hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-35"
              >
                Previous
              </button>
              <span className="text-[13px] text-fg-muted">Page {page}</span>
              <button
                type="button"
                onClick={() => goToPage(page + 1)}
                disabled={!hasMore}
                className="rounded-full border border-border-default px-4 py-2 text-[13px] font-medium text-fg-default transition hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-35"
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}