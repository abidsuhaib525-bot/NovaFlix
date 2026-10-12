/**
 * Live TV.
 *
 * Channels arrive as a flat list with an optional `group`, which is how IPTV
 * playlists are shaped in practice. Grouped here rather than left flat, because
 * a thousand unlabelled rows is not a browsable list.
 */

import { Plus, Radio, Trash2, Tv, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  Spinner,
} from '@/components/common/StateBlocks';
import { api } from '@/lib/api';
import { notifyError, useUiStore } from '@/store/ui';
import type { TvChannel } from '@/types';

/**
 * How many channels are rendered at once.
 *
 * A real playlist holds thousands. Rendering them all is what makes a channel
 * list feel slow, and none of them are scrolled to; the filter is the way people
 * actually find a channel. Raised in steps of this size as the filter narrows.
 */
const PAGE = 120;

export function TvPage() {
  const playlists = useQuery({ queryKey: ['tv', 'playlists'] as const, queryFn: api.tvPlaylists });
  const [playlist, setPlaylist] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [activeChannel, setActiveChannel] = useState<TvChannel | null>(null);

  const channels = useQuery({
    queryKey: ['tv', 'channels', playlist] as const,
    queryFn: () => api.tvChannels(playlist),
    // Stale for a minute: channels change on the order of hours, and this query
    // is the second-heaviest in the app after the homepage rails.
    staleTime: 60_000,
  });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = channels.data ?? [];
    const matched = needle
      ? all.filter(
          (channel) =>
            channel.name.toLowerCase().includes(needle) ||
            channel.group?.toLowerCase().includes(needle),
        )
      : all;
    return matched.slice(0, limit);
  }, [channels.data, filter, limit]);

  /**
   * Channels, bucketed by group.
   *
   * `Map` rather than an object so insertion order is preserved -- a playlist's
   * own group order is the only sensible ordering available, and sorting the keys
   * would put "Entertainment" before "Sports" for no reason.
   */
  const groups = useMemo(() => {
    const buckets = new Map<string, typeof visible>();
    for (const channel of visible) {
      const key = channel.group?.trim() || 'Ungrouped';
      const bucket = buckets.get(key);
      if (bucket) bucket.push(channel);
      else buckets.set(key, [channel]);
    }
    return [...buckets.entries()];
  }, [visible]);

  const total = channels.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-4 sm:px-6 lg:px-8">
      <PageHeading
        title="Live TV"
        subtitle={total > 0 ? `${total} channels` : undefined}
        action={<PlaylistControls />}
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setLimit(PAGE);
          }}
          placeholder="Filter channels"
          aria-label="Filter channels"
          className="w-full max-w-xs rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[13px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />

        {(playlists.data?.length ?? 0) > 0 && (
          <select
            value={playlist ?? ''}
            onChange={(event) => setPlaylist(event.target.value || undefined)}
            aria-label="Playlist"
            className="rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[13px] text-fg-default outline-none transition hover:border-border-strong focus:border-accent"
          >
            <option value="">All playlists</option>
            {playlists.data?.map((source) => (
              <option key={source} value={source}>
                {source.split('/').pop() ?? source}
              </option>
            ))}
          </select>
        )}
      </div>

      {channels.isPending ? (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 18 }, (_, index) => (
            <div key={index} className="skeleton h-11 rounded-lg" />
          ))}
        </div>
      ) : channels.isError ? (
        <ErrorState
          error={channels.error}
          onRetry={() => void channels.refetch()}
          title="Could not load channels"
        />
      ) : total === 0 ? (
        <EmptyState
          icon={<Tv className="size-8" aria-hidden="true" />}
          title="No channels"
          hint="Add an M3U or Xtream playlist above to load channels."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Radio className="size-8" aria-hidden="true" />}
          title="No matches"
          hint={`Nothing matches "${filter}".`}
        />
      ) : (
        <>
          {groups.map(([group, list]) => (
            <section key={group} className="mb-7">
              <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wider text-fg-subtle">
                {group}
              </h2>
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((channel) => (
                  <li key={`${channel.tvg_id ?? ''}:${channel.name}`}>
                    <button
                      type="button"
                      onClick={() => setActiveChannel(channel)}
                      className="surface flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition hover:border-accent cursor-pointer group"
                    >
                      {channel.logo ? (
                        <img
                          src={`/api/poster?url=${encodeURIComponent(channel.logo)}`}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          className="size-6 shrink-0 rounded object-contain"
                        />
                      ) : (
                        <Radio className="size-4 shrink-0 text-fg-subtle group-hover:text-accent transition" aria-hidden="true" />
                      )}
                      <span className="line-clamp-1 text-[13px] text-fg-default group-hover:text-accent transition">
                        {channel.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* In-app Live Stream Player Modal */}
          {activeChannel && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 backdrop-blur-md animate-fade-in">
              <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-black shadow-2xl">
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-[#121218]">
                  <div className="flex items-center gap-2">
                    <Radio className="size-4 text-accent animate-pulse" />
                    <span className="text-[14px] font-semibold text-white">{activeChannel.name}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveChannel(null)}
                    className="rounded-full p-1 text-white/60 hover:bg-white/10 hover:text-white"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="aspect-video w-full bg-black">
                  <video
                    src={activeChannel.url}
                    controls
                    autoPlay
                    playsInline
                    className="size-full"
                  >
                    Your browser does not support this stream format.
                  </video>
                </div>
              </div>
            </div>
          )}

          {visible.length < total && (
            <button
              type="button"
              onClick={() => setLimit(limit + PAGE)}
              className="mx-auto block rounded-full border border-border-default px-5 py-2.5 text-[13px] font-medium text-fg-muted transition hover:border-accent hover:text-accent"
            >
              Show more ({total - visible.length} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Playlist management                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Add and remove playlists.
 *
 * Adding accepts a pasted URL rather than a file picker: an M3U playlist lives on
 * some other machine or is served by an addon, and there is nothing local to
 * browse to.
 */
function PlaylistControls() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const playlists = useQuery({ queryKey: ['tv', 'playlists'] as const, queryFn: api.tvPlaylists });

  const add = async () => {
    const source = url.trim();
    if (!source) return;

    setBusy(true);
    try {
      await api.addTvPlaylist(source);
      setUrl('');
      await playlists.refetch();
      useUiStore.getState().notify('success', 'Playlist added');
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (index: number) => {
    try {
      await api.removeTvPlaylist(index);
      await playlists.refetch();
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
          placeholder="https://.../playlist.m3u"
          aria-label="Playlist URL"
          className="min-w-0 flex-1 rounded-full border border-border-default bg-bg-surface px-4 py-2 text-[12.5px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          disabled={busy || !url.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? <Spinner className="size-3" /> : <Plus className="size-3.5" />}
          Add
        </button>
      </div>

      {(playlists.data?.length ?? 0) > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {playlists.data!.map((source, index) => (
            <li
              key={`${index}:${source}`}
              className="surface flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5"
            >
              <span className="max-w-[14rem] truncate text-[11.5px] text-fg-muted">
                {source.split('/').pop() ?? source}
              </span>
              <button
                type="button"
                onClick={() => void remove(index)}
                aria-label={`Remove ${source}`}
                className="grid size-5 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-danger"
              >
                <Trash2 className="size-2.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}