/**
 * Placeholder, empty and failure states.
 *
 * Collected in one file because they are always used together and are always
 * small: a rail that is loading, a rail that failed, and a rail with nothing in
 * it are three states of the same component, and splitting them across three
 * files would scatter the decision of which one to show.
 */

import { AlertTriangle, Inbox, Loader2, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { ApiError } from '@/lib/api';

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/** A shimmer block. Sized by the caller; this only supplies the animation. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} aria-hidden="true" />;
}

/**
 * Placeholder for one poster.
 *
 * Matches `PosterCard`'s geometry exactly -- 2:3 image plus two lines of text.
 * A skeleton of the wrong height is worse than none, because content jumps into
 * the gap when it arrives and the whole page appears to twitch.
 */
export function SkeletonCard() {
  return (
    <div className="w-[150px] shrink-0 sm:w-[172px]">
      <Skeleton className="aspect-poster w-full" />
      <Skeleton className="mt-2.5 h-3 w-4/5" />
      <Skeleton className="mt-1.5 h-2.5 w-2/5" />
    </div>
  );
}

/** Placeholder for a horizontal rail: a heading and a row of cards. */
export function SkeletonRail() {
  return (
    <section className="mb-9">
      <Skeleton className="mb-3.5 h-5 w-40" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 8 }, (_, index) => (
          <SkeletonCard key={index} />
        ))}
      </div>
    </section>
  );
}

/** Placeholder for a poster grid. */
export function SkeletonGrid({ count = 18 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="w-full">
          <Skeleton className="aspect-poster w-full" />
          <Skeleton className="mt-2.5 h-3 w-4/5" />
          <Skeleton className="mt-1.5 h-2.5 w-2/5" />
        </div>
      ))}
    </div>
  );
}

/** Inline spinner for a button that is waiting on a mutation. */
export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin-slow`} aria-hidden="true" />;
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A message worth showing.
 *
 * Prefers the server's own wording. `ApiError` carries the `error` field the
 * backend sent, which is written to be read by a person -- "Provider unreachable"
 * is actionable, "Request failed (502)" is not. Anything unrecognised falls back
 * to a generic line rather than rendering `[object Object]` at the user.
 */
export function errorMessage(error: unknown, fallback = 'Something went wrong'): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/**
 * Full-width failure panel.
 *
 * `onRetry` is optional but its absence changes the design: with no way to
 * retry, an offer to retry is a lie, so the button is omitted rather than shown
 * disabled.
 */
export function ErrorState({
  error,
  onRetry,
  title = 'Could not load',
  className = '',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}) {
  const message = errorMessage(error);

  return (
    <div
      className={`surface flex flex-col items-center gap-3 rounded-card px-6 py-12 text-center ${className}`}
      role="alert"
    >
      <AlertTriangle className="size-7 text-danger" aria-hidden="true" />
      <p className="text-[15px] font-semibold text-fg-default">{title}</p>
      <p className="max-w-md text-[13px] leading-relaxed text-fg-muted">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 inline-flex items-center gap-2 rounded-full border border-border-default px-4 py-2 text-[13px] font-medium text-fg-default transition hover:border-accent hover:text-accent"
        >
          <RotateCw className="size-3.5" aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty                                                                       */
/* -------------------------------------------------------------------------- */

/** Nothing to show, but nothing is wrong. */
export function EmptyState({
  title,
  hint,
  icon,
  action,
  className = '',
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center gap-2.5 px-6 py-16 text-center ${className}`}>
      <span className="text-fg-subtle">{icon ?? <Inbox className="size-8" aria-hidden="true" />}</span>
      <p className="text-[15px] font-semibold text-fg-default">{title}</p>
      {hint && <p className="max-w-md text-[13px] leading-relaxed text-fg-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A rail or page section heading.
 *
 * `id` is not decoration: `Rail` takes it as `labelledBy`, which is how a screen
 * reader announces "Trending, list, 20 items" rather than an unlabelled group.
 */
export function SectionHeading({
  id,
  title,
  subtitle,
  action,
  className = '',
}: {
  id: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex items-end justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <span className="h-4.5 w-1 rounded-full bg-accent shadow-[0_0_10px_var(--accent)]" aria-hidden="true" />
          <h2
            id={id}
            className="font-display truncate text-[18px] font-bold tracking-tight text-white/95 sm:text-[20px]"
          >
            {title}
          </h2>
        </div>
        {subtitle && <p className="mt-1 ml-3.5 truncate text-[12.5px] text-fg-subtle">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The page title used by every non-home route. */
export function PageHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-8 mt-2 flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.06] pb-5">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-white md:text-[32px] drop-shadow-sm">{title}</h1>
        {subtitle && <p className="mt-1.5 text-[14px] text-white/60">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </header>
  );
}