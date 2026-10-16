/**
 * Favorites / Watchlist Page.
 *
 * Dedicated page for saved titles and bookmarked movies/shows.
 */

import { Heart, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SkeletonGrid,
} from '@/components/common/StateBlocks';
import {
  useClearFavorites,
  useFavorites,
} from '@/hooks/useCatalog';
import { cleanTitle } from '@/lib/format';
import { paths, storedTitlePath } from '@/lib/routes';
import { api } from '@/lib/api';
import type { FavoriteItem } from '@/types';
import { notifyError } from '@/store/ui';

export function FavoritesPage() {
  const favorites = useFavorites();
  const clearFavorites = useClearFavorites();
  const [filter, setFilter] = useState('');

  const items = favorites.data ?? [];
  const filtered = filter.trim()
    ? items.filter((f) => f.title.toLowerCase().includes(filter.trim().toLowerCase()))
    : items;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="My Favorites"
        subtitle={
          items.length > 0
            ? `${items.length} saved title${items.length === 1 ? '' : 's'} in your watchlist`
            : undefined
        }
        action={
          items.length > 0 ? (
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                <input
                  type="text"
                  placeholder="Filter favorites..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="rounded-full border border-border-subtle bg-bg-surface py-1.5 pl-8 pr-3 text-[12.5px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
                />
              </div>
              <ClearButton
                label="Clear All"
                onConfirm={() => clearFavorites.mutate(undefined, { onError: notifyError })}
              />
            </div>
          ) : undefined
        }
      />

      <section>
        {favorites.isPending ? (
          <SkeletonGrid count={8} />
        ) : favorites.isError ? (
          <ErrorState error={favorites.error} onRetry={() => void favorites.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Heart className="size-8" aria-hidden="true" />}
            title="No favourites yet"
            hint="Click the heart icon on any movie or TV series details page to add it to your watchlist."
            action={
              <Link
                to={paths.home()}
                className="rounded-full bg-accent px-6 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                Explore Catalogue
              </Link>
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No matching favorites"
            hint={`No saved titles found matching "${filter}".`}
          />
        ) : (
          <FavoriteGrid items={filtered} />
        )}
      </section>
    </div>
  );
}

function ClearButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        className="rounded-full border border-border-subtle px-3.5 py-1.5 text-[12px] font-medium text-fg-subtle transition hover:border-danger hover:text-danger cursor-pointer"
      >
        {label}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        onConfirm();
        setArmed(false);
      }}
      className="rounded-full border border-danger/60 bg-danger/10 px-3.5 py-1.5 text-[12px] font-medium text-danger transition hover:bg-danger/20 cursor-pointer"
    >
      Confirm Clear
    </button>
  );
}

function FavoriteGrid({ items }: { items: FavoriteItem[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 2xl:grid-cols-8">
      {items.map((favorite) => {
        const key = `${favorite.provider}:${favorite.subject_id}`;

        return (
          <li key={key}>
            <Link
              to={storedTitlePath(favorite.provider, favorite.subject_id)}
              className="card-hover group block overflow-hidden rounded-2xl border border-white/10 bg-bg-surface transition-all duration-300 hover:border-accent hover:shadow-[0_4px_24px_rgba(245,166,35,0.2)]"
            >
              <div className="relative aspect-[2/3] w-full overflow-hidden bg-bg-raised">
                {favorite.cover_url ? (
                  <img
                    src={api.posterUrl(favorite.cover_url)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                ) : (
                  <div className="size-full flex items-center justify-center text-fg-subtle">
                    <Heart className="size-8 opacity-30" />
                  </div>
                )}
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-bg-base/90 to-transparent"
                  aria-hidden="true"
                />
              </div>
              <div className="p-3">
                <p className="line-clamp-1 text-[13px] font-semibold text-fg-default group-hover:text-accent transition-colors">
                  {cleanTitle(favorite.title)}
                </p>
                {favorite.release_year && (
                  <p className="mt-1 text-[11px] font-medium text-fg-subtle">{favorite.release_year}</p>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
