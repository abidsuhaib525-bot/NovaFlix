/**
 * Live TV.
 *
 * Channels arrive as a flat list with an optional `group`, which is how IPTV
 * playlists are shaped in practice. Grouped here rather than left flat, because
 * a thousand unlabelled rows is not a browsable list.
 */

import { Plus, Radio, Sparkles, Trash2, Tv, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import shaka from 'shaka-player';

import {
  EmptyState,
  ErrorState,
  PageHeading,
  Spinner,
} from '@/components/common/StateBlocks';
import { describeShakaError } from '@/hooks/usePlayback';
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

const IPTV_ORG_PRESETS = [
  { label: 'English Channels', url: 'https://iptv-org.github.io/iptv/languages/eng.m3u' },
  { label: 'Movies', url: 'https://iptv-org.github.io/iptv/categories/movies.m3u' },
  { label: 'News', url: 'https://iptv-org.github.io/iptv/categories/news.m3u' },
  { label: 'Animation', url: 'https://iptv-org.github.io/iptv/categories/animation.m3u' },
  { label: 'Entertainment', url: 'https://iptv-org.github.io/iptv/categories/entertainment.m3u' },
  { label: 'Sports', url: 'https://iptv-org.github.io/iptv/categories/sports.m3u' },
  { label: 'Music', url: 'https://iptv-org.github.io/iptv/categories/music.m3u' },
];

export function TvPage() {
  const playlists = useQuery({ queryKey: ['tv', 'playlists'] as const, queryFn: api.tvPlaylists });
  const [playlist, setPlaylist] = useState<string | undefined>(undefined);
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [activeChannel, setActiveChannel] = useState<TvChannel | null>(null);

  // Stop playback immediately on unmount so audio never leaks when navigating away
  useEffect(() => {
    return () => {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        try {
          v.pause();
          v.removeAttribute('src');
          v.load();
        } catch {
          /* ignore */
        }
      });
    };
  }, []);

  const channels = useQuery({
    queryKey: ['tv', 'channels', playlist] as const,
    queryFn: () => api.tvChannels(playlist),
    // Stale for a minute: channels change on the order of hours, and this query
    // is the second-heaviest in the app after the homepage rails.
    staleTime: 60_000,
  });

  const categoriesWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of channels.data ?? []) {
      const g = c.group?.trim() || 'General';
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return counts;
  }, [channels.data]);

  const displayCategories = useMemo(() => {
    const canonicalOrder = [
      'Movies',
      'News',
      'Entertainment',
      'Animation',
      'Sports',
      'Music',
      'Documentary',
      'Comedy',
      'Kids',
      'Family',
      'General',
    ];
    const present = new Set(categoriesWithCounts.keys());
    const ordered: string[] = ['All'];
    for (const cat of canonicalOrder) {
      if (present.has(cat)) {
        ordered.push(cat);
        present.delete(cat);
      }
    }
    const remaining = Array.from(present).sort();
    return [...ordered, ...remaining];
  }, [categoriesWithCounts]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = channels.data ?? [];
    let matched = all;

    if (selectedCategory !== 'All') {
      matched = matched.filter(
        (channel) =>
          (channel.group?.trim() || 'General').toLowerCase() ===
          selectedCategory.toLowerCase(),
      );
    }

    if (needle) {
      matched = matched.filter(
        (channel) =>
          channel.name.toLowerCase().includes(needle) ||
          channel.group?.toLowerCase().includes(needle),
      );
    }

    // Sort: prioritize working non-geo-blocked channels and channels with logos
    matched = [...matched].sort((a, b) => {
      const aGeo = a.name.includes('[Geo-blocked]');
      const bGeo = b.name.includes('[Geo-blocked]');
      if (aGeo !== bGeo) return aGeo ? 1 : -1;

      const aLogo = Boolean(a.logo && a.logo.trim());
      const bLogo = Boolean(b.logo && b.logo.trim());
      if (aLogo !== bLogo) return bLogo ? 1 : -1;

      return a.name.localeCompare(b.name);
    });

    return matched.slice(0, limit);
  }, [channels.data, filter, limit, selectedCategory]);

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
      const key = channel.group?.trim() || 'General';
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
        subtitle={total > 0 ? `${total} channels available` : undefined}
        action={<PlaylistControls />}
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setLimit(PAGE);
          }}
          placeholder="Filter channels by name or group"
          aria-label="Filter channels"
          className="w-full max-w-xs rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[13px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />

        {(playlists.data?.length ?? 0) > 0 && (
          <select
            value={playlist ?? ''}
            onChange={(event) => {
              setPlaylist(event.target.value || undefined);
              setSelectedCategory('All');
            }}
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

      {/* Category Navigation Pills */}
      {total > 0 && displayCategories.length > 1 && (
        <div className="mb-6 flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {displayCategories.map((cat) => {
            const count = cat === 'All' ? total : (categoriesWithCounts.get(cat) || 0);
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat);
                  setLimit(PAGE);
                }}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition cursor-pointer ${
                  isSelected
                    ? 'bg-accent text-accent-contrast shadow-sm'
                    : 'surface text-fg-muted hover:border-accent hover:text-fg-default'
                }`}
              >
                <span>{cat}</span>
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${
                      isSelected
                        ? 'bg-black/20 text-accent-contrast'
                        : 'bg-white/10 text-fg-subtle'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

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
          hint="Add an M3U playlist above or select a preset to load channels."
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
                  <li key={`${channel.tvg_id ?? channel.id ?? ''}:${channel.name}:${channel.stream_url}`}>
                    <button
                      type="button"
                      onClick={() => setActiveChannel(channel)}
                      className="surface flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:border-accent cursor-pointer group"
                    >
                      <ChannelLogo channel={channel} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="line-clamp-1 text-[13px] text-fg-default group-hover:text-accent transition font-medium">
                            {channel.name}
                          </span>
                          {channel.name.includes('[Geo-blocked]') && (
                            <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.2 text-[9px] font-semibold text-amber-400">
                              Geo
                            </span>
                          )}
                        </div>
                        {channel.group && (
                          <span className="line-clamp-1 text-[11px] text-fg-subtle">
                            {channel.group}
                          </span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          {/* In-app Live Stream Player Modal with Shaka */}
          {activeChannel && (
            <TvPlayerModal
              channel={activeChannel}
              onClose={() => setActiveChannel(null)}
            />
          )}

          {visible.length < total && (
            <button
              type="button"
              onClick={() => setLimit(limit + PAGE)}
              className="mx-auto block rounded-full border border-border-default px-5 py-2.5 text-[13px] font-medium text-fg-muted transition hover:border-accent hover:text-accent cursor-pointer"
            >
              Show more ({total - visible.length} left)
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ChannelLogo({ channel }: { channel: TvChannel }) {
  const [stage, setStage] = useState<'direct' | 'proxy' | 'fallback'>('direct');
  const rawLogo = channel.logo?.trim();
  const initial = (channel.name || 'TV').trim().charAt(0).toUpperCase();

  useEffect(() => {
    setStage('direct');
  }, [rawLogo]);

  if (!rawLogo || stage === 'fallback') {
    return (
      <div className="flex size-7 shrink-0 items-center justify-center rounded bg-white/10 font-bold text-[12px] text-white/80 group-hover:bg-accent group-hover:text-accent-contrast transition select-none">
        {initial}
      </div>
    );
  }

  const src = stage === 'direct'
    ? rawLogo
    : `/api/poster?url=${encodeURIComponent(rawLogo)}`;

  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded bg-black/40 overflow-hidden p-0.5 border border-white/10">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="size-full object-contain"
        onError={() => {
          if (stage === 'direct') {
            setStage('proxy');
          } else {
            setStage('fallback');
          }
        }}
      />
    </div>
  );
}

function TvPlayerModal({
  channel,
  onClose,
}: {
  channel: TvChannel;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [useDirect, setUseDirect] = useState(false);

  const rawStreamUrl = channel.url || channel.stream_url;
  const proxiedStreamUrl = rawStreamUrl ? api.tvStreamUrl(rawStreamUrl) : '';
  const streamUrl = useDirect ? rawStreamUrl : (proxiedStreamUrl || rawStreamUrl);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let player: any = null;

    (async () => {
      try {
        setLoading(true);
        setErrorText(null);

        shaka.polyfill.installAll();

        if (shaka.Player.isBrowserSupported()) {
          const instance = new shaka.Player();
          player = instance;

          instance.configure({
            streaming: {
              rebufferingGoal: 2,
              bufferingGoal: 10,
              bufferBehind: 15,
              jumpLargeGaps: true,
              retryParameters: {
                maxAttempts: 4,
                baseDelay: 1000,
                backoffFactor: 1.5,
                timeout: 15000,
              },
            },
            manifest: {
              retryParameters: {
                maxAttempts: 4,
                baseDelay: 1000,
                backoffFactor: 1.5,
                timeout: 15000,
              },
            },
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          instance.addEventListener('error', (event: any) => {
            if (cancelled) return;
            const detail = event.detail;
            if (detail?.severity === 1) return;
            console.warn('[TvPlayer Shaka Warning/Error]', detail);
            setErrorText(describeShakaError(detail));
            setLoading(false);
          });

          await instance.attach(video);
          if (cancelled) return;

          await instance.load(streamUrl);
          if (cancelled) return;

          setLoading(false);
          video.muted = false;
          await video.play().catch(async () => {
            try {
              video.muted = true;
              await video.play();
            } catch {
              /* ignore */
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = streamUrl;
          await video.play().catch(() => {});
          setLoading(false);
        } else {
          setErrorText('This browser does not support HLS live streams.');
          setLoading(false);
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (!cancelled) {
          console.warn('[TvPlayer failed]', err);
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            try {
              video.src = streamUrl;
              await video.play();
              setLoading(false);
              return;
            } catch {
              /* ignore */
            }
          }
          setErrorText(describeShakaError(err));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (video) {
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
        } catch {
          /* ignore */
        }
      }
      if (player) {
        try {
          void player.destroy();
        } catch {
          /* ignore */
        }
      }
    };
  }, [streamUrl]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3 sm:p-6 backdrop-blur-md animate-fade-in select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-white/15 bg-[#09090e] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-[#121218]">
          <div className="flex items-center gap-2.5 min-w-0">
            <Radio className="size-4 shrink-0 text-accent animate-pulse" />
            <span className="truncate text-[14px] font-semibold text-white">{channel.name}</span>
            {channel.group && (
              <span className="hidden sm:inline-block rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium text-white/70">
                {channel.group}
              </span>
            )}
            {channel.name.includes('[Geo-blocked]') && (
              <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                Geo-restricted
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-white/60 hover:bg-white/10 hover:text-white transition cursor-pointer"
            aria-label="Close player"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="relative aspect-video w-full bg-black flex items-center justify-center">
          <video
            ref={videoRef}
            controls
            playsInline
            className="size-full object-contain"
          />

          {loading && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
              <Spinner className="size-8 text-accent animate-spin" />
              <p className="text-[13px] font-medium text-white/80 animate-pulse">
                Connecting to live stream...
              </p>
            </div>
          )}

          {errorText && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
              <Radio className="size-8 text-amber-500/80" />
              <p className="text-[14px] font-semibold text-white">Stream Unavailable</p>
              <p className="max-w-md text-[12.5px] text-white/60 leading-relaxed">
                {errorText}. Live streams can go offline temporarily or be geo-restricted.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setErrorText(null);
                    setLoading(true);
                    const v = videoRef.current;
                    if (v) v.load();
                  }}
                  className="rounded-full bg-accent px-5 py-2 text-[12px] font-bold text-accent-contrast transition hover:bg-accent-hover cursor-pointer"
                >
                  Retry Stream
                </button>
                {!useDirect && (
                  <button
                    type="button"
                    onClick={() => {
                      setErrorText(null);
                      setLoading(true);
                      setUseDirect(true);
                    }}
                    className="rounded-full bg-white/10 px-5 py-2 text-[12px] font-medium text-white transition hover:bg-white/20 cursor-pointer"
                  >
                    Try Direct Stream
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
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

  const add = async (sourceUrl?: string) => {
    const source = (sourceUrl || url).trim();
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

  const existingPlaylists = new Set(playlists.data ?? []);

  return (
    <div className="flex w-full max-w-lg flex-col gap-2.5">
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
          onClick={() => void add()}
          disabled={busy || !url.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-40 cursor-pointer"
        >
          {busy ? <Spinner className="size-3" /> : <Plus className="size-3.5" />}
          Add
        </button>
      </div>

      {/* IPTV-Org Preset Quick Buttons */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-[11px] font-medium text-white/50 mr-1">
          <Sparkles className="size-3 text-accent" />
          IPTV Presets:
        </span>
        {IPTV_ORG_PRESETS.map((preset) => {
          const isAdded = existingPlaylists.has(preset.url);
          return (
            <button
              key={preset.url}
              type="button"
              disabled={busy || isAdded}
              onClick={() => void add(preset.url)}
              title={isAdded ? 'Already added' : `Add ${preset.label} from iptv-org`}
              className={`rounded-full px-2.5 py-1 text-[10.5px] font-medium transition cursor-pointer ${
                isAdded
                  ? 'bg-white/5 text-white/35 cursor-default'
                  : 'bg-white/10 text-white/80 hover:bg-accent hover:text-accent-contrast'
              }`}
            >
              {isAdded ? `✓ ${preset.label}` : `+ ${preset.label}`}
            </button>
          );
        })}
      </div>

      {(playlists.data?.length ?? 0) > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1">
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
                className="grid size-5 place-items-center rounded-full text-fg-subtle transition hover:bg-bg-hover hover:text-danger cursor-pointer"
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