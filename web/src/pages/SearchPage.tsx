/**
 * Search results with multi-provider tabs and intelligent query fallback.
 */

import { Search as SearchIcon, Sparkles, RefreshCw } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SkeletonGrid,
} from '@/components/common/StateBlocks';
import { PosterCard } from '@/components/media/PosterCard';
import { useSearch } from '@/hooks/useCatalog';
import type { ProviderKind } from '@/types';

const PAGE_SIZE = 30;

const PROVIDER_OPTIONS: { kind: ProviderKind; label: string; tag: string }[] = [
  { kind: 'moviebox', label: 'MovieBox', tag: 'Global Cinema (Default)' },
  { kind: 'fourkhdhub', label: '4KHDHub', tag: '4K UHD' },
  { kind: 'dramachi', label: 'Dramachi', tag: 'Asian Drama' },
];

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const rawQuery = params.get('q') ?? '';
  const query = rawQuery.trim();
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Provider from URL parameter; ALWAYS defaults to 'moviebox' for global reliability
  const paramProvider = params.get('provider') as ProviderKind | null;
  const provider: ProviderKind =
    paramProvider && ['moviebox', 'fourkhdhub', 'dramachi'].includes(paramProvider)
      ? paramProvider
      : 'moviebox';

  // Extract clean title by removing bracketed info like [Hindi], (2024), etc.
  const cleanedQuery = useMemo(() => {
    return query
      .replace(/\[.*?\]|\(.*?\)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }, [query]);

  // Primary search with user query
  const results = useSearch(provider, query, page);

  // Automatic clean fallback if raw query with tags yields 0 results on current provider
  const shouldTryCleaned =
    !results.isPending &&
    !results.isError &&
    (results.data?.length ?? 0) === 0 &&
    cleanedQuery.length >= 2 &&
    cleanedQuery.toLowerCase() !== query.toLowerCase();

  const fallbackResults = useSearch(provider, shouldTryCleaned ? cleanedQuery : '', page);

  const isUsingFallback = shouldTryCleaned && (fallbackResults.data?.length ?? 0) > 0;
  const items = isUsingFallback ? (fallbackResults.data ?? []) : (results.data ?? []);
  const isLoading = results.isPending || (shouldTryCleaned && fallbackResults.isPending);
  const isError = results.isError && (!shouldTryCleaned || fallbackResults.isError);
  const error = results.error || fallbackResults.error;
  const hasMore = items.length >= PAGE_SIZE - 6;

  // Reset any obsolete local storage override that breaks global searches
  useEffect(() => {
    const stored = localStorage.getItem('novaflix_active_provider');
    if (!stored || stored === 'dramachi') {
      localStorage.setItem('novaflix_active_provider', 'moviebox');
    }
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [query, page, provider]);

  const goToPage = (next: number) => {
    setParams({
      q: query,
      provider,
      ...(next > 1 ? { page: String(next) } : {}),
    });
  };

  const selectProvider = (nextProvider: ProviderKind) => {
    setParams({
      q: query,
      provider: nextProvider,
      page: '1',
    });
    localStorage.setItem('novaflix_active_provider', nextProvider);
  };

  if (query.length === 0) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
        <EmptyState
          icon={<SearchIcon className="size-8" aria-hidden="true" />}
          title="Search for movies, series & anime"
          hint="Type any movie title, actor, or genre, or press / to jump straight to the search box."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          title={`Results for "${query}"`}
          subtitle={
            isLoading
              ? 'Searching catalog...'
              : isUsingFallback
              ? `${items.length}${hasMore ? '+' : ''} result${items.length === 1 ? '' : 's'} (matched "${cleanedQuery}")`
              : `${items.length}${hasMore ? '+' : ''} result${items.length === 1 ? '' : 's'}`
          }
        />

        {/* Provider Source Selector Pills */}
        <div className="flex items-center gap-1.5 self-start rounded-full border border-white/10 bg-black/40 p-1 backdrop-blur-md sm:self-center">
          {PROVIDER_OPTIONS.map((opt) => {
            const isActive = provider === opt.kind;
            return (
              <button
                key={opt.kind}
                type="button"
                onClick={() => selectProvider(opt.kind)}
                className={`rounded-full px-3.5 py-1 text-xs font-semibold transition ${
                  isActive
                    ? 'bg-accent text-black shadow-md shadow-accent/25'
                    : 'text-fg-subtle hover:text-fg-default'
                }`}
                title={`Switch search provider to ${opt.label}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {isUsingFallback && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-accent/20 bg-accent/10 px-4 py-2.5 text-xs text-accent">
          <Sparkles className="size-4 shrink-0" />
          <span>
            Exact search for <strong>&ldquo;{query}&rdquo;</strong> had no direct matches, showing results for{' '}
            <strong>&ldquo;{cleanedQuery}&rdquo;</strong>.
          </span>
        </div>
      )}

      {isLoading ? (
        <SkeletonGrid />
      ) : isError ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void results.refetch();
            if (shouldTryCleaned) void fallbackResults.refetch();
          }}
          title="Search failed"
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="No matches found"
          hint={
            provider !== 'moviebox'
              ? `No titles found for "${query}" on ${provider}. Try searching on our primary MovieBox catalog.`
              : `Nothing found for "${query}". Check the spelling, try removing special characters, or search by main actor.`
          }
          action={
            provider !== 'moviebox' ? (
              <button
                type="button"
                onClick={() => selectProvider('moviebox')}
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-xs font-bold text-black shadow-lg shadow-accent/20 transition hover:bg-accent-hover"
              >
                <SearchIcon className="size-3.5" />
                Search on MovieBox Catalog
              </button>
            ) : cleanedQuery.length >= 2 && cleanedQuery !== query ? (
              <button
                type="button"
                onClick={() => setParams({ q: cleanedQuery, provider: 'moviebox', page: '1' })}
                className="mt-4 inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2 text-xs font-bold text-black shadow-lg shadow-accent/20 transition hover:bg-accent-hover"
              >
                <RefreshCw className="size-3.5" />
                Search for &ldquo;{cleanedQuery}&rdquo;
              </button>
            ) : undefined
          }
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