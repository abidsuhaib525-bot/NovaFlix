/**
 * History Page.
 *
 * Dedicated page for Continue Watching (in-progress items) and Watch History (finished titles).
 */

import { Clock, Play, Trash2 } from 'lucide-react';
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
  useClearHistory,
  useDeleteHistory,
  useHistory,
} from '@/hooks/useCatalog';
import { cleanTitle, describeTitle, formatDuration, formatRelativeTime } from '@/lib/format';
import { paths, storedTitlePath, storedWatchPath } from '@/lib/routes';
import { api } from '@/lib/api';
import type { WatchHistoryItem } from '@/types';
import { notifyError } from '@/store/ui';

export function HistoryPage() {
  const history = useHistory();
  const clearHistory = useClearHistory();

  const watching = (history.data ?? []).filter(isInProgress);
  const finished = (history.data ?? []).filter((entry) => !isInProgress(entry));

  const totalCount = (history.data ?? []).length;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="Watch History"
        subtitle={
          totalCount > 0
            ? `${totalCount} item${totalCount === 1 ? '' : 's'} recorded`
            : undefined
        }
        action={
          totalCount > 0 ? (
            <ClearButton
              label="Clear History"
              onConfirm={() => clearHistory.mutate(undefined, { onError: notifyError })}
            />
          ) : undefined
        }
      />

      {/* 1. Continue Watching Section */}
      <section className="mb-12">
        <div className="mb-3.5 flex items-end justify-between gap-4">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-semibold tracking-tight text-fg-default">
              Continue Watching
            </h2>
            {watching.length > 0 && (
              <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[11px] font-bold text-accent">
                {watching.length} in progress
              </span>
            )}
          </div>
        </div>

        {history.isPending ? (
          <SkeletonGrid count={4} />
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : watching.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-bg-surface/50 p-6 text-center text-[13px] text-fg-muted">
            No active streams in progress. Start watching any movie or episode to pick up right where you left off.
          </div>
        ) : (
          <HistoryList items={watching} progress />
        )}
      </section>

      {/* 2. Finished Titles Section */}
      {finished.length > 0 && (
        <section>
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="text-[17px] font-semibold tracking-tight text-fg-default">
              Completed Titles
            </h2>
            <span className="text-[12px] text-fg-subtle">
              {finished.length} completed
            </span>
          </div>
          <HistoryList items={finished} />
        </section>
      )}

      {totalCount === 0 && !history.isPending && (
        <EmptyState
          icon={<Clock className="size-8" aria-hidden="true" />}
          title="No watch history yet"
          hint="Titles you watch will automatically show up here with playback position and progress."
          action={
            <Link
              to={paths.home()}
              className="rounded-full bg-accent px-6 py-2.5 text-[13px] font-semibold text-accent-contrast transition hover:bg-accent-hover"
            >
              Browse Movies & Shows
            </Link>
          }
        />
      )}
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

function HistoryList({ items, progress = false }: { items: WatchHistoryItem[]; progress?: boolean }) {
  const remove = useDeleteHistory();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <ul className="space-y-2">
      {items.map((entry) => {
        const key = `${entry.provider}:${entry.subject_id}`;
        const label = describeTitle(entry.title, entry.release_year);

        return (
          <li
            key={key}
            className="surface flex items-center gap-4 rounded-2xl border border-white/[0.08] p-3 transition hover:border-border-strong hover:bg-white/[0.02]"
          >
            {entry.cover_url && (
              <img
                src={api.posterUrl(entry.cover_url)}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-[60px] w-[45px] shrink-0 rounded-lg object-cover shadow-sm"
              />
            )}

            <div className="min-w-0 flex-1">
              <Link
                to={storedTitlePath(entry.provider, entry.subject_id)}
                className="line-clamp-1 text-[14px] font-semibold text-fg-default transition hover:text-accent"
              >
                {cleanTitle(entry.title)}
              </Link>

              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-subtle">
                <span className="font-medium text-white/80">
                  {entry.season > 0
                    ? `Season ${entry.season}, Episode ${entry.episode}`
                    : 'Feature Film'}
                </span>
                <span aria-hidden="true">&middot;</span>
                <span>{formatRelativeTime(entry.timestamp)}</span>
                {progress && (entry.duration_seconds ?? 0) > 0 && (
                  <>
                    <span aria-hidden="true">&middot;</span>
                    <span className="text-accent font-medium">
                      {formatDuration(entry.progress_seconds)} /{' '}
                      {formatDuration(entry.duration_seconds ?? 0)}
                    </span>
                  </>
                )}
              </p>

              {progress && (
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10 max-w-md">
                  <div
                    className="h-full rounded-full bg-accent"
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
              className="inline-flex items-center gap-1.5 shrink-0 rounded-full bg-accent/15 border border-accent/30 px-4 py-1.5 text-[12.5px] font-semibold text-accent transition hover:bg-accent hover:text-accent-contrast shadow-sm"
            >
              <Play className="size-3.5 fill-current" />
              <span>{progress ? 'Resume' : 'Replay'}</span>
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
              title="Delete from history"
              className="grid size-8 shrink-0 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-danger disabled:opacity-40 cursor-pointer"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
