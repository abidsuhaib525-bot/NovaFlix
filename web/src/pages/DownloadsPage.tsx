/**
 * Downloads.
 *
 * Progress arrives over SSE rather than polling. The server pushes a broadcast
 * frame every time a transfer reports a chunk, and pushing beats asking: a
 * forty-task queue would otherwise re-request the whole snapshot once a second,
 * and the `EventSource` reconnects on its own when anything drops the
 * connection.
 *
 * The stream is a *diff*, not the whole table. Each frame carries only the
 * fields that change while a transfer runs (bytes, speed, state), and the page
 * overlays them on the latest `GET /api/downloads` snapshot. That split keeps
 * each frame a few hundred bytes and makes deletions correct by construction:
 * removing a task invalidates the snapshot, and overrides for ids the server no
 * longer returns are dropped.
 */

import { Ban, Download, FolderOpen, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { EmptyState, ErrorState, PageHeading, Spinner } from '@/components/common/StateBlocks';
import { api } from '@/lib/api';
import { cleanTitle, formatBytes, formatDuration, formatSpeed } from '@/lib/format';
import { paths } from '@/lib/routes';
import type { DownloadProgressEvent, DownloadState, DownloadTask } from '@/types';
import { notifyError, useUiStore } from '@/store/ui';

const TERMINAL: readonly DownloadState[] = ['completed', 'failed', 'cancelled'];

export function DownloadsPage() {
  const client = useQueryClient();

  /**
   * The table as of the last fetch. Progress frames then overlay it, so the
   * page never needs to refetch a whole snapshot just to move a progress bar.
   */
  const snapshot = useQuery({
    queryKey: ['downloads'] as const,
    queryFn: api.downloads,
  });

  const [overrides, setOverrides] = useState<Record<string, DownloadProgressEvent>>({});

  /**
   * The ids the latest snapshot knows about. While the page is open a task can
   * be added from another tab; a frame naming a task we have never seen means
   * the snapshot is stale, so the SSE handler invalidates it.
   */
  const knownIdsRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    const stream = new EventSource(api.downloadsStreamUrl());
    const onProgress = (event: MessageEvent<string>) => {
      try {
        // A bare JSON `progress` event, as produced by
        // `routes::downloads::progress_stream`.
        const frame = JSON.parse(event.data) as DownloadProgressEvent;
        setOverrides((current) => ({ ...current, [frame.id]: frame }));
        if (knownIdsRef.current && !knownIdsRef.current.has(frame.id)) {
          void client.invalidateQueries({ queryKey: ['downloads'] });
        }
      } catch {
        // A malformed frame tears nothing down; the next one will be fine.
      }
    };
    stream.addEventListener('progress', onProgress);

    // On the first open -- and on every reconnect after a drop, which
    // `EventSource` does by itself -- ask for a fresh snapshot so frames missed
    // while disconnected are caught up in one request.
    stream.onopen = () => {
      void client.invalidateQueries({ queryKey: ['downloads'] });
    };

    return () => stream.close();
  }, [client]);

  const tasks = snapshot.data?.tasks ?? [];
  const active = tasks.filter((task) => !TERMINAL.includes(task.state)).length;

  /**
   * Drop overrides whose task the server no longer knows.
   *
   * Ran whenever the snapshot lands. A deleted row would otherwise keep
   * rendering from memory; a task that finished and was cleared is gone from
   * both sides this way.
   */
  useEffect(() => {
    if (!snapshot.data) return;
    const known = new Set(snapshot.data.tasks.map((task) => task.id));
    knownIdsRef.current = known;
    setOverrides((current) => {
      const hasStale = Object.keys(current).some((id) => !known.has(id));
      if (!hasStale) return current;
      const next: Record<string, DownloadProgressEvent> = {};
      for (const [id, frame] of Object.entries(current)) {
        if (known.has(id)) next[id] = frame;
      }
      return next;
    });
  }, [snapshot.data]);

  const merged = tasks.map((task) => {
    const frame = overrides[task.id];
    return frame ? { ...task, ...frame } : task;
  });

  /**
   * Refresh after a mutation.
   *
   * Invalidate rather than patch: the backend is authoritative about the queue
   * and a locally-patched list would drift the moment anything else touched it.
   */
  const act = async (run: () => Promise<unknown>, message?: string) => {
    try {
      await run();
      await client.invalidateQueries({ queryKey: ['downloads'] });
      if (message) useUiStore.getState().notify('success', message);
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="Downloads"
        subtitle={
          tasks.length === 0
            ? undefined
            : `${tasks.length} task${tasks.length === 1 ? '' : 's'}${active > 0 ? `, ${active} in progress` : ''}`
        }
        action={
          tasks.length > 0 && (
            <button
              type="button"
              onClick={() => act(() => api.clearDownloads(), 'Download list cleared')}
              className="rounded-full border border-border-default px-4 py-2 text-[13px] font-medium text-fg-muted transition hover:border-danger hover:text-danger"
            >
              Clear finished
            </button>
          )
        }
      />

      {snapshot.isPending ? (
        <ul className="space-y-1.5">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="skeleton h-[86px] rounded-card" />
          ))}
        </ul>
      ) : snapshot.isError ? (
        <ErrorState
          error={snapshot.error}
          onRetry={() => void snapshot.refetch()}
          title="Could not load downloads"
        />
      ) : tasks.length === 0 ? (
        <EmptyState
          icon={<Download className="size-8" aria-hidden="true" />}
          title="No downloads yet"
          hint="Start one from any title's details page, using the download button next to a source."
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
        <ul className="space-y-1.5">
          {merged.map((task) => (
            <TaskRow key={task.id} task={task} act={act} />
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One transfer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A single task row.
 *
 * The controls offered depend on the state, and the mapping is exhaustive on
 * purpose: a paused transfer that still shows a pause button is a small thing
 * that makes the whole page look unconsidered.
 */
function TaskRow({
  task,
  act,
}: {
  task: DownloadTask;
  act: (run: () => Promise<unknown>, message?: string) => Promise<void>;
}) {
  const running = task.state === 'running';
  const paused = task.state === 'paused';
  const queued = task.state === 'queued';
  const live = running || queued || paused;
  const terminal = TERMINAL.includes(task.state);

  // Keep highest progress seen so progress bar line never jumps backwards
  const maxPercentRef = useRef(0);
  const currentPercent = Math.max(0, Math.min(100, Math.round(task.progress ?? 0)));
  if (currentPercent > maxPercentRef.current) {
    maxPercentRef.current = currentPercent;
  }
  const percent = maxPercentRef.current;

  /**
   * Estimated time left.
   *
   * Only show when speed is realistic and total_bytes is known.
   */
  const remaining =
    task.total_bytes !== null && task.total_bytes > task.downloaded_bytes && running && (task.speed_bps ?? 0) > 10_000
      ? formatDuration((task.total_bytes - task.downloaded_bytes) / task.speed_bps!)
      : null;

  return (
    <li className="group rounded-2xl border border-white/[0.08] bg-[#101016]/80 p-4 shadow-sm backdrop-blur transition-all hover:border-white/20 hover:bg-[#14141e]/90 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-[14.5px] font-semibold text-fg-default">
            {task.title ? cleanTitle(task.title) : task.filename}
          </p>

          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-subtle">
            <StateBadge state={task.state} />
            <span aria-hidden="true">&middot;</span>
            <span className="truncate">{task.filename}</span>
          </p>

          {task.error && (
            <p className="mt-1.5 line-clamp-2 text-[11.5px] text-danger">{task.error}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {running && (
            <IconAction
              label="Pause"
              onClick={() => act(() => api.pauseDownload(task.id))}
              icon={<Pause className="size-3.5" />}
            />
          )}

          {paused && (
            <IconAction
              label="Resume"
              onClick={() => act(() => api.resumeDownload(task.id), 'Download resumed')}
              icon={<Play className="size-3.5" />}
            />
          )}

          {live && (
            <IconAction
              label="Cancel"
              onClick={() => act(() => api.cancelDownload(task.id))}
              icon={<Ban className="size-3.5" />}
            />
          )}

          {terminal && (
            <IconAction
              label="Remove from list"
              onClick={() => act(() => api.deleteDownload(task.id))}
              icon={<Trash2 className="size-3.5" />}
            />
          )}

          {/* Interactive folder button: copies path to clipboard and notifies user */}
          {task.path && (
            <button
              type="button"
              title={`File: ${task.path} (Click to copy path)`}
              onClick={() => {
                if (navigator.clipboard) {
                  navigator.clipboard.writeText(task.path!).then(() => {
                    useUiStore.getState().notify('success', `Copied to clipboard: ${task.path}`);
                  }).catch(() => {
                    useUiStore.getState().notify('info', `File location: ${task.path}`);
                  });
                } else {
                  useUiStore.getState().notify('info', `File location: ${task.path}`);
                }
              }}
              className="grid size-8 place-items-center rounded-full text-fg-subtle transition hover:bg-white/10 hover:text-accent cursor-pointer"
              aria-label="Copy file path"
            >
              <FolderOpen className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {live && (
        <div className="mt-3">
          <div className="h-2 overflow-hidden rounded-full bg-black/40 border border-white/[0.05]">
            <div
              className={`h-full rounded-full transition-[width] duration-700 ${
                paused ? 'bg-warning' : 'bg-gradient-to-r from-accent to-amber-400 shadow-[0_0_10px_rgba(245,166,35,0.5)]'
              }`}
              style={{ width: `${percent}%` }}
            />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-fg-subtle">
            <span>{percent}%</span>
            {task.total_bytes !== null ? (
              <span>
                {formatBytes(task.downloaded_bytes)} / {formatBytes(task.total_bytes)}
              </span>
            ) : task.downloaded_bytes > 0 ? (
              <span>{formatBytes(task.downloaded_bytes)} downloaded</span>
            ) : null}
            {running && task.speed_bps ? <span>{formatSpeed(task.speed_bps)}</span> : null}
            {remaining && <span>{remaining} left</span>}
            {queued && !running && <Spinner className="size-2.5" />}
          </div>
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Small shared pieces                                                         */
/* -------------------------------------------------------------------------- */

const STATE_STYLES: Record<DownloadState, string> = {
  queued: 'text-fg-subtle',
  running: 'text-accent',
  paused: 'text-warning',
  completed: 'text-success',
  failed: 'text-danger',
  cancelled: 'text-fg-subtle',
};

/**
 * The state, spelled out.
 *
 * Colour alone would not do: red/green is exactly the distinction a
 * red-green colourblind reader cannot make, and "failed" versus "completed" is
 * the one pair that matters here.
 */
function StateBadge({ state }: { state: DownloadState }) {
  return (
    <span className={`font-medium capitalize ${STATE_STYLES[state]}`}>
      {state === 'running' ? 'Downloading' : state}
    </span>
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid size-8 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-fg-default"
    >
      {icon}
    </button>
  );
}