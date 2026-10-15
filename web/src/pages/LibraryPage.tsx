/**
 * Library: continue watching and favourites.
 *
 * Two lists in two states rather than tabs. Switching tabs hides half the content
 * behind a click, and both lists are short enough that showing them together
 * needs less scrolling than the tab bar costs.
 */

import { Heart, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  SkeletonGrid,
} from '@/components/common/StateBlocks';
import {
  isInProgress,
  progressFraction,
  useClearFavorites,
  useClearHistory,
  useDeleteHistory,
  useFavorites,
  useHistory,
} from '@/hooks/useCatalog';
import { cleanTitle, describeTitle, formatDuration, formatRelativeTime } from '@/lib/format';
import { paths, storedTitlePath, storedWatchPath } from '@/lib/routes';
import { api } from '@/lib/api';
import type { FavoriteItem, WatchHistoryItem } from '@/types';
import { notifyError } from '@/store/ui';

export function LibraryPage() {
  const history = useHistory();
  const favorites = useFavorites();
  const clearHistory = useClearHistory();
  const clearFavorites = useClearFavorites();

  const watching = (history.data ?? []).filter(isInProgress);
  const finished = (history.data ?? []).filter((entry) => !isInProgress(entry));

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading title="Your library" />

      <section className="mb-12">
        <div className="mb-3.5 flex items-end justify-between gap-4">
          <h2 className="text-[17px] font-semibold tracking-tight text-fg-default">
            Continue watching
          </h2>
          {watching.length > 0 && (
            <ClearButton
              label="Clear"
              onConfirm={() => clearHistory.mutate(undefined, { onError: notifyError })}
            />
          )}
        </div>

        {history.isPending ? (
          <SkeletonGrid count={6} />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : watching.length === 0 ? (
          <EmptyState
            icon={<Play className="size-8" aria-hidden="true" />}
            title="Nothing in progress"
            hint="Start something and it will show up here, ready to pick up where you left off."
          />
        ) : (
          <HistoryList items={watching} progress />
        )}
      </section>

      {finished.length > 0 && (
        <section className="mb-12">
          <h2 className="mb-3.5 text-[17px] font-semibold tracking-tight text-fg-default">
            Watch history
          </h2>
          <HistoryList items={finished} />
        </section>
      )}

      <section>
        <div className="mb-3.5 flex items-end justify-between gap-4">
          <h2 className="text-[17px] font-semibold tracking-tight text-fg-default">Favourites</h2>
          {favorites.data && favorites.data.length > 0 && (
            <ClearButton
              label="Clear all"
              onConfirm={() => clearFavorites.mutate(undefined, { onError: notifyError })}
            />
          )}
        </div>

        {favorites.isPending ? (
          <SkeletonGrid count={6} />
        ) : favorites.isError ? (
          <ErrorState error={favorites.error} onRetry={() => void favorites.refetch()} />
        ) : (favorites.data?.length ?? 0) === 0 ? (
          <EmptyState
            icon={<Heart className="size-8" aria-hidden="true" />}
            title="No favourites yet"
            hint="Use the heart on any title's details page to keep it here."
            action={
              <Link
                to={paths.home()}
                className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
              >
                Browse
              </Link>
            }
          />
        ) : (
          <FavoriteList items={favorites.data!} />
        )}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A destructive bulk action, with a confirm step.
 *
 * "Clear all" on a library is not undoable -- there is no trash -- and a
 * mis-click next to a thumb that just worked is easy. Two clicks rather than a
 * `window.confirm`, which blocks the event loop and is styled by the OS rather
 * than the app.
 *
 * Disarms itself after a few seconds so the button cannot sit permanently in a
 * confirm-but-never-confirmed state if the user walks away from it.
 */
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
        className="text-[12.5px] font-medium text-fg-subtle transition hover:text-danger"
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
      className="rounded-full border border-danger/50 px-3 py-1.5 text-[12.5px] font-medium text-danger transition hover:bg-danger/10"
    >
      Confirm
    </button>
  );
}

function HistoryList({ items, progress = false }: { items: WatchHistoryItem[]; progress?: boolean }) {
  const remove = useDeleteHistory();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <ul className="space-y-1.5">
      {items.map((entry) => {
        const key = `${entry.provider}:${entry.subject_id}`;
        const label = describeTitle(entry.title, entry.release_year);

        return (
          <li
            key={key}
            className="surface flex items-center gap-4 rounded-card px-3 py-2.5 transition hover:border-border-strong"
          >
            {entry.cover_url && (
              <img
                src={api.posterUrl(entry.cover_url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-[52px] w-[40px] shrink-0 rounded object-cover"
              />
            )}

            <div className="min-w-0 flex-1">
              <Link
                to={storedTitlePath(entry.provider, entry.subject_id)}
                className="line-clamp-1 text-[13.5px] font-medium text-fg-default transition hover:text-accent"
              >
                {cleanTitle(entry.title)}
              </Link>

              <p className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-fg-subtle">
                <span>
                  {entry.season > 0
                    ? `S${entry.season} E${entry.episode}`
                    : 'Movie'}
                </span>
                <span aria-hidden="true">&middot;</span>
                <span>{formatRelativeTime(entry.timestamp)}</span>
                {progress && (entry.duration_seconds ?? 0) > 0 && (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span>
                      {formatDuration(entry.progress_seconds)} /{' '}
                      {formatDuration(entry.duration_seconds ?? 0)}
                    </span>
                  </>
                )}
              </p>

              {progress && (
                <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-bg-raised">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.round(progressFraction(entry) * 100)}%` }}
                  />
                </div>
              )}
            </div>

            <Link
              to={storedWatchPath(entry.provider, entry.subject_id, {
                season: entry.season,
                episode: entry.episode,
              })}
              className="shrink-0 rounded-full border border-border-default px-4 py-1.5 text-[12px] font-medium text-fg-default transition hover:border-accent hover:text-accent"
            >
              {progress ? 'Resume' : 'Watch'}
            </Link>

            <button
              type="button"
              onClick={() => {
                setBusy(key);
                remove.mutate(
                  { provider: entry.provider, id: entry.subject_id },
                  {
                    onSettled: () => setBusy(null),
                    onError: notifyError,
                  },
                );
              }}
              disabled={busy === key}
              aria-label={`Remove ${label} from history`}
              className="grid size-8 shrink-0 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-danger disabled:opacity-40"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FavoriteList({ items }: { items: FavoriteItem[] }) {
  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
      {items.map((favorite) => {
        const key = `${favorite.provider}:${favorite.subject_id}`;

        return (
          <li key={key}>
            <Link
              to={storedTitlePath(favorite.provider, favorite.subject_id)}
              className="card-hover group block overflow-hidden rounded-card border border-border-subtle bg-bg-surface"
            >
              <div className="relative">
                {favorite.cover_url ? (
                  <img
                    src={api.posterUrl(favorite.cover_url)}
                    alt=""
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
              <div className="px-2.5 pb-2.5 pt-2">
                <p className="line-clamp-1 text-[12.5px] font-medium text-fg-default group-hover:text-accent">
                  {cleanTitle(favorite.title)}
                </p>
                {favorite.release_year && (
                  <p className="mt-0.5 text-[11px] text-fg-subtle">{favorite.release_year}</p>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
