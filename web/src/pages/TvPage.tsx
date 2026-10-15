/**
 * Live TV - Global Cinema & Broadcast Channels.
 *
 * Supports browsing by Country (with national flags and counts) or Category,
 * view toggling between spacious visual TV cards and compact lists,
 * high-reliability curated FAST/Free-TV streams, and an expansive cinema live player.
 */

import {
  Globe,
  Info,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Sparkles,
  Trash2,
  Tv,
  X,
} from 'lucide-react';
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
 * How many channels are rendered initially before pagination.
 */
const PAGE_SIZE = 120;

/**
 * Country to National Flag Emoji map.
 */
const COUNTRY_FLAGS: Record<string, string> = {
  'United States': '🇺🇸',
  USA: '🇺🇸',
  'United Kingdom': '🇬🇧',
  UK: '🇬🇧',
  Pakistan: '🇵🇰',
  India: '🇮🇳',
  Canada: '🇨🇦',
  Australia: '🇦🇺',
  Germany: '🇩🇪',
  France: '🇫🇷',
  Spain: '🇪🇸',
  Italy: '🇮🇹',
  'Saudi Arabia': '🇸🇦',
  'United Arab Emirates': '🇦🇪',
  UAE: '🇦🇪',
  Turkey: '🇹🇷',
  Brazil: '🇧🇷',
  Egypt: '🇪🇬',
  Bangladesh: '🇧🇩',
  Netherlands: '🇳🇱',
  Sweden: '🇸🇪',
  Norway: '🇳🇴',
  Denmark: '🇩🇰',
  Switzerland: '🇨🇭',
  Austria: '🇦🇹',
  Japan: '🇯🇵',
  'South Korea': '🇰🇷',
  China: '🇨🇳',
  Mexico: '🇲🇽',
  Argentina: '🇦🇷',
  'South Africa': '🇿🇦',
  Russia: '🇷🇺',
  Ukraine: '🇺🇦',
  'New Zealand': '🇳🇿',
  Ireland: '🇮🇪',
  Afghanistan: '🇦🇫',
  Qatar: '🇶🇦',
  Kuwait: '🇰🇼',
};

function getCountryFlag(country?: string | null): string {
  if (!country) return '🌐';
  const trimmed = country.trim();
  return COUNTRY_FLAGS[trimmed] || '🌐';
}

/**
 * High-reliability curated and FAST playlist presets.
 */
const CURATED_PRESETS = [
  {
    label: 'Free-TV Global (Daily Verified)',
    url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
    category: 'Curated',
    badge: '99% Uptime',
  },
  {
    label: 'Samsung TV Plus (FAST 24/7)',
    url: 'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/samsungtvplus_all.m3u',
    category: 'Curated',
    badge: '1080p FAST',
  },
  {
    label: 'Pluto TV (FAST Movies & Shows)',
    url: 'https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/plutotv_all.m3u',
    category: 'Curated',
    badge: 'FAST',
  },
  {
    label: 'USA Channels',
    url: 'https://iptv-org.github.io/iptv/countries/us.m3u',
    category: 'Country',
    flag: '🇺🇸',
  },
  {
    label: 'UK Channels',
    url: 'https://iptv-org.github.io/iptv/countries/uk.m3u',
    category: 'Country',
    flag: '🇬🇧',
  },
  {
    label: 'Pakistan Channels',
    url: 'https://iptv-org.github.io/iptv/countries/pk.m3u',
    category: 'Country',
    flag: '🇵🇰',
  },
  {
    label: 'India Channels',
    url: 'https://iptv-org.github.io/iptv/countries/in.m3u',
    category: 'Country',
    flag: '🇮🇳',
  },
  {
    label: 'Canada Channels',
    url: 'https://iptv-org.github.io/iptv/countries/ca.m3u',
    category: 'Country',
    flag: '🇨🇦',
  },
  {
    label: 'Global Countries Index',
    url: 'https://iptv-org.github.io/iptv/index.country.m3u',
    category: 'Country',
    flag: '🌐',
  },
  {
    label: 'Movies',
    url: 'https://iptv-org.github.io/iptv/categories/movies.m3u',
    category: 'Category',
  },
  {
    label: 'News',
    url: 'https://iptv-org.github.io/iptv/categories/news.m3u',
    category: 'Category',
  },
  {
    label: 'Sports',
    url: 'https://iptv-org.github.io/iptv/categories/sports.m3u',
    category: 'Category',
  },
  {
    label: 'Animation',
    url: 'https://iptv-org.github.io/iptv/categories/animation.m3u',
    category: 'Category',
  },
];

export function TvPage() {
  const playlists = useQuery({
    queryKey: ['tv', 'playlists'] as const,
    queryFn: api.tvPlaylists,
  });

  const [playlist, setPlaylist] = useState<string | undefined>(undefined);
  const [browseMode, setBrowseMode] = useState<'country' | 'category'>('country');
  const [selectedCountry, setSelectedCountry] = useState<string>('All');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [activeChannel, setActiveChannel] = useState<TvChannel | null>(null);
  const [showDockerHelp, setShowDockerHelp] = useState(false);

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
    staleTime: 60_000,
  });

  // Calculate Country counts
  const countriesWithCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of channels.data ?? []) {
      const country = c.country?.trim() || 'Global';
      counts.set(country, (counts.get(country) || 0) + 1);
    }
    return counts;
  }, [channels.data]);

  // Priority sorted countries for tabs
  const displayCountries = useMemo(() => {
    const priority = [
      'United States',
      'United Kingdom',
      'Pakistan',
      'India',
      'Canada',
      'Australia',
      'Germany',
      'France',
      'Spain',
      'Italy',
      'Saudi Arabia',
      'United Arab Emirates',
      'Turkey',
      'Brazil',
      'Egypt',
      'Global',
    ];
    const present = new Set(countriesWithCounts.keys());
    const ordered: string[] = ['All'];
    for (const p of priority) {
      if (present.has(p)) {
        ordered.push(p);
        present.delete(p);
      }
    }
    const remaining = Array.from(present).sort();
    return [...ordered, ...remaining];
  }, [countriesWithCounts]);

  // Calculate Category counts
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

  // Filter channels based on Search, Country, and Category
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = channels.data ?? [];
    let matched = all;

    if (browseMode === 'country' && selectedCountry !== 'All') {
      matched = matched.filter((c) => {
        const country = c.country?.trim() || 'Global';
        return country.toLowerCase() === selectedCountry.toLowerCase();
      });
    } else if (browseMode === 'category' && selectedCategory !== 'All') {
      matched = matched.filter((c) => {
        const group = c.group?.trim() || 'General';
        return group.toLowerCase() === selectedCategory.toLowerCase();
      });
    }

    if (needle) {
      matched = matched.filter(
        (channel) =>
          channel.name.toLowerCase().includes(needle) ||
          channel.group?.toLowerCase().includes(needle) ||
          channel.country?.toLowerCase().includes(needle),
      );
    }

    // Sort: prioritize non-geo-blocked channels and channels with verified logos
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
  }, [channels.data, filter, limit, browseMode, selectedCountry, selectedCategory]);

  /**
   * Channels grouped according to current browse mode.
   */
  const groupedSections = useMemo(() => {
    const buckets = new Map<string, typeof visible>();
    for (const channel of visible) {
      let key = 'General';
      if (browseMode === 'country') {
        key = channel.country?.trim() || 'Global';
      } else {
        key = channel.group?.trim() || 'General';
      }
      const bucket = buckets.get(key);
      if (bucket) bucket.push(channel);
      else buckets.set(key, [channel]);
    }
    return [...buckets.entries()];
  }, [visible, browseMode]);

  const total = channels.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-[1700px] px-4 pt-4 sm:px-6 lg:px-8 pb-16">
      <PageHeading
        title="Live TV"
        subtitle={
          total > 0
            ? `${total.toLocaleString()} channels available across ${countriesWithCounts.size} countries`
            : undefined
        }
        action={<PlaylistControls />}
      />

      {/* Docker Self-Hosting / High Reliability Notice */}
      <div className="mb-6 rounded-2xl border border-accent/20 bg-gradient-to-r from-accent/10 via-bg-surface to-bg-surface p-4 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent/20 text-accent">
              <Sparkles className="size-5" />
            </div>
            <div>
              <p className="text-[13px] font-semibold text-fg-default">
                High Reliability Live TV & Ready-to-Host Docker Solutions
              </p>
              <p className="text-[12px] text-fg-subtle">
                Public web streams can go offline or be geo-blocked. We&apos;ve added verified Free-TV and Samsung FAST presets, plus Docker hosting options.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowDockerHelp(!showDockerHelp)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border-default bg-bg-surface px-3 py-1.5 text-[11.5px] font-medium text-fg-default transition hover:border-accent hover:text-accent cursor-pointer"
          >
            <Info className="size-3.5" />
            {showDockerHelp ? 'Hide Docker Guide' : 'Docker Hosting Options'}
          </button>
        </div>

        {showDockerHelp && (
          <div className="mt-4 border-t border-border-default/60 pt-4 text-[12px] leading-relaxed text-fg-muted space-y-2">
            <p className="font-semibold text-fg-default">
              Want 100% stable channels running 24/7 on your Blitz Cloud or Docker backend?
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-1">
                <span className="font-semibold text-accent flex items-center gap-1">
                  1. guovin/iptv-api (Automated Speed & Health Tester)
                </span>
                <p className="text-[11px] text-fg-subtle">
                  Scrapes, live-tests speed and removes dead streams automatically:
                </p>
                <code className="block rounded bg-black/60 p-2 font-mono text-[10.5px] text-emerald-400 select-all">
                  docker run -d -p 8000:8000 --name iptv-api guovin/iptv-api
                </code>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-1">
                <span className="font-semibold text-accent flex items-center gap-1">
                  2. matthuisman/samsung-tvplus-for-channels (1000+ FAST)
                </span>
                <p className="text-[11px] text-fg-subtle">
                  Dedicated container providing clean 1080p Samsung TV Plus streams & EPG:
                </p>
                <code className="block rounded bg-black/60 p-2 font-mono text-[10.5px] text-emerald-400 select-all">
                  docker run -d -p 8182:80 --name stvp-channels matthuisman/samsung-tvplus-for-channels
                </code>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Controls Bar: Search, Playlist, Browse Mode, View Toggle */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5 flex-1 min-w-[280px]">
          <input
            type="search"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setLimit(PAGE_SIZE);
            }}
            placeholder="Search channels, country, or genre..."
            aria-label="Filter channels"
            className="w-full sm:w-72 rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[13px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
          />

          {(playlists.data?.length ?? 0) > 0 && (
            <select
              value={playlist ?? ''}
              onChange={(event) => {
                setPlaylist(event.target.value || undefined);
                setSelectedCategory('All');
                setSelectedCountry('All');
              }}
              aria-label="Playlist"
              className="rounded-full border border-border-default bg-bg-surface px-4 py-2.5 text-[12.5px] text-fg-default outline-none transition hover:border-border-strong focus:border-accent"
            >
              <option value="">All active playlists</option>
              {playlists.data?.map((source) => (
                <option key={source} value={source}>
                  {source.split('/').pop() ?? source}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Mode Switcher: Browse by Country vs Category */}
          <div className="flex rounded-full border border-border-default bg-bg-surface p-1">
            <button
              type="button"
              onClick={() => {
                setBrowseMode('country');
                setLimit(PAGE_SIZE);
              }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition cursor-pointer ${
                browseMode === 'country'
                  ? 'bg-accent text-accent-contrast shadow-sm'
                  : 'text-fg-muted hover:text-fg-default'
              }`}
            >
              <Globe className="size-3.5" />
              <span>By Country</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setBrowseMode('category');
                setLimit(PAGE_SIZE);
              }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium transition cursor-pointer ${
                browseMode === 'category'
                  ? 'bg-accent text-accent-contrast shadow-sm'
                  : 'text-fg-muted hover:text-fg-default'
              }`}
            >
              <Tv className="size-3.5" />
              <span>By Category</span>
            </button>
          </div>

          {/* View Mode Toggle: Grid Cards vs List */}
          <div className="flex rounded-full border border-border-default bg-bg-surface p-1">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              title="Spacious Grid View"
              className={`rounded-full p-1.5 transition cursor-pointer ${
                viewMode === 'grid'
                  ? 'bg-white/15 text-white'
                  : 'text-fg-subtle hover:text-fg-default'
              }`}
            >
              <LayoutGrid className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              title="Compact List View"
              className={`rounded-full p-1.5 transition cursor-pointer ${
                viewMode === 'list'
                  ? 'bg-white/15 text-white'
                  : 'text-fg-subtle hover:text-fg-default'
              }`}
            >
              <List className="size-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Country Filter Navigation Pills */}
      {browseMode === 'country' && total > 0 && displayCountries.length > 1 && (
        <div className="mb-6 flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-none">
          {displayCountries.map((country) => {
            const count =
              country === 'All' ? total : countriesWithCounts.get(country) || 0;
            const isSelected = selectedCountry === country;
            const flag = country === 'All' ? '🌐' : getCountryFlag(country);

            return (
              <button
                key={country}
                type="button"
                onClick={() => {
                  setSelectedCountry(country);
                  setLimit(PAGE_SIZE);
                }}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition cursor-pointer ${
                  isSelected
                    ? 'bg-accent text-accent-contrast shadow-sm ring-2 ring-accent/30'
                    : 'surface text-fg-muted hover:border-accent hover:text-fg-default'
                }`}
              >
                <span className="text-[13px]">{flag}</span>
                <span>{country}</span>
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${
                      isSelected
                        ? 'bg-black/25 text-accent-contrast'
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

      {/* Category Filter Navigation Pills */}
      {browseMode === 'category' && total > 0 && displayCategories.length > 1 && (
        <div className="mb-6 flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-none">
          {displayCategories.map((cat) => {
            const count = cat === 'All' ? total : categoriesWithCounts.get(cat) || 0;
            const isSelected = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  setSelectedCategory(cat);
                  setLimit(PAGE_SIZE);
                }}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition cursor-pointer ${
                  isSelected
                    ? 'bg-accent text-accent-contrast shadow-sm ring-2 ring-accent/30'
                    : 'surface text-fg-muted hover:border-accent hover:text-fg-default'
                }`}
              >
                <span>{cat}</span>
                {count > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-0.2 text-[10px] font-semibold ${
                      isSelected
                        ? 'bg-black/25 text-accent-contrast'
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

      {/* Loading Skeleton */}
      {channels.isPending ? (
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 18 }, (_, index) => (
            <div key={index} className="skeleton h-36 rounded-2xl" />
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
          icon={<Tv className="size-10" aria-hidden="true" />}
          title="No channels loaded"
          hint="Add an M3U playlist above or select a preset to begin watching live TV."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<Radio className="size-10" aria-hidden="true" />}
          title="No matching channels"
          hint={`Nothing matches your filter "${filter}". Try selecting a different country or category.`}
        />
      ) : (
        <>
          {groupedSections.map(([sectionTitle, list]) => {
            const flag =
              browseMode === 'country' ? getCountryFlag(sectionTitle) : null;

            return (
              <section key={sectionTitle} className="mb-8">
                <div className="mb-3.5 flex items-center justify-between border-b border-border-default/40 pb-2">
                  <h2 className="flex items-center gap-2 text-[14px] font-bold uppercase tracking-wider text-fg-default">
                    {flag && <span className="text-[16px]">{flag}</span>}
                    <span>{sectionTitle}</span>
                    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-fg-subtle">
                      {list.length}
                    </span>
                  </h2>
                </div>

                {viewMode === 'grid' ? (
                  /* Spacious Visual TV Grid Cards */
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                    {list.map((channel) => (
                      <TvChannelCard
                        key={`${channel.tvg_id ?? channel.id ?? ''}:${channel.name}:${channel.stream_url}`}
                        channel={channel}
                        onPlay={() => setActiveChannel(channel)}
                      />
                    ))}
                  </div>
                ) : (
                  /* Compact List View */
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {list.map((channel) => (
                      <li
                        key={`${channel.tvg_id ?? channel.id ?? ''}:${channel.name}:${channel.stream_url}`}
                      >
                        <button
                          type="button"
                          onClick={() => setActiveChannel(channel)}
                          className="surface group flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition hover:border-accent hover:shadow-md cursor-pointer"
                        >
                          <ChannelLogo channel={channel} size="sm" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="line-clamp-1 text-[13px] font-medium text-fg-default transition group-hover:text-accent">
                                {channel.name}
                              </span>
                              {channel.name.includes('[Geo-blocked]') && (
                                <span className="shrink-0 rounded bg-amber-500/15 px-1 py-0.2 text-[9px] font-semibold text-amber-400">
                                  Geo
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {channel.country && (
                                <span className="text-[11px] text-fg-subtle flex items-center gap-1">
                                  {getCountryFlag(channel.country)} {channel.country}
                                </span>
                              )}
                              {channel.group && (
                                <span className="line-clamp-1 text-[10.5px] text-fg-subtle">
                                  • {channel.group}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="opacity-0 transition group-hover:opacity-100 flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast">
                            <Play className="size-3.5 fill-current" />
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}

          {/* Full-Featured Cinema Live Stream Player Modal */}
          {activeChannel && (
            <TvPlayerModal
              channel={activeChannel}
              onClose={() => setActiveChannel(null)}
            />
          )}

          {visible.length < total && (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit((prev) => prev + PAGE_SIZE)}
                className="rounded-full border border-border-default bg-bg-surface px-6 py-2.5 text-[13px] font-semibold text-fg-muted transition hover:border-accent hover:text-accent cursor-pointer shadow-sm"
              >
                Show More Channels ({total - visible.length} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Spacious Visual TV Channel Card (Grid Mode).
 */
function TvChannelCard({
  channel,
  onPlay,
}: {
  channel: TvChannel;
  onPlay: () => void;
}) {
  const isGeo = channel.name.includes('[Geo-blocked]');
  const countryFlag = getCountryFlag(channel.country);

  return (
    <div
      onClick={onPlay}
      className="surface group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-border-default/70 p-3.5 transition-all duration-200 hover:-translate-y-1 hover:border-accent hover:shadow-xl hover:shadow-accent/10 bg-gradient-to-b from-white/[0.04] to-transparent cursor-pointer select-none"
    >
      {/* Top Bar: Logo & Status Badges */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <ChannelLogo channel={channel} size="md" />
        <div className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-red-400">
            <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
          {isGeo && (
            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.2 text-[9px] font-semibold text-amber-300">
              Geo-Restricted
            </span>
          )}
        </div>
      </div>

      {/* Channel Title & Meta */}
      <div className="min-w-0 flex-1">
        <h3
          title={channel.name}
          className="line-clamp-1 text-[13.5px] font-semibold text-fg-default transition group-hover:text-accent"
        >
          {channel.name}
        </h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {channel.country && (
            <span className="flex items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] font-medium text-fg-subtle">
              <span>{countryFlag}</span>
              <span className="truncate max-w-[80px]">{channel.country}</span>
            </span>
          )}
          {channel.group && (
            <span className="truncate max-w-[90px] rounded-md bg-white/5 px-1.5 py-0.5 text-[10.5px] text-fg-subtle">
              {channel.group}
            </span>
          )}
        </div>
      </div>

      {/* Play Overlay Indicator on Hover */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 backdrop-blur-[1px] transition-opacity duration-200 group-hover:opacity-100">
        <div className="flex size-11 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-lg transition-transform group-hover:scale-105">
          <Play className="size-5 fill-current ml-0.5" />
        </div>
      </div>
    </div>
  );
}

/**
 * Robust Channel Logo Component with Direct, Proxy, and Initial Letter fallback.
 */
function ChannelLogo({
  channel,
  size = 'md',
}: {
  channel: TvChannel;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [stage, setStage] = useState<'direct' | 'proxy' | 'fallback'>('direct');
  const rawLogo = channel.logo?.trim();
  const initial = (channel.name || 'TV').trim().charAt(0).toUpperCase();

  useEffect(() => {
    setStage('direct');
  }, [rawLogo]);

  const sizeClasses = {
    sm: 'size-8 rounded-lg text-[12px]',
    md: 'size-12 rounded-xl text-[15px]',
    lg: 'size-16 rounded-2xl text-[18px]',
  }[size];

  if (!rawLogo || stage === 'fallback') {
    return (
      <div
        className={`flex shrink-0 items-center justify-center bg-white/10 font-bold text-white/80 transition select-none group-hover:bg-accent group-hover:text-accent-contrast ${sizeClasses}`}
      >
        {initial}
      </div>
    );
  }

  const src =
    stage === 'direct'
      ? rawLogo
      : `/api/poster?url=${encodeURIComponent(rawLogo)}`;

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden border border-white/10 bg-black/50 p-1 ${sizeClasses}`}
    >
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

/**
 * Expansive Cinema Live Player with Native Fullscreen & Stream Fallback.
 */
function TvPlayerModal({
  channel,
  onClose,
}: {
  channel: TvChannel;
  onClose: () => void;
}) {
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [useDirect, setUseDirect] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const rawStreamUrl = channel.url || channel.stream_url;
  const proxiedStreamUrl = rawStreamUrl ? api.tvStreamUrl(rawStreamUrl) : '';
  const streamUrl = useDirect ? rawStreamUrl : proxiedStreamUrl || rawStreamUrl;

  const toggleFullscreen = () => {
    if (!playerContainerRef.current) return;
    if (!document.fullscreenElement) {
      playerContainerRef.current.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, []);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-2 sm:p-6 backdrop-blur-md animate-fade-in select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={playerContainerRef}
        className="relative flex flex-col w-full max-w-5xl overflow-hidden rounded-2xl border border-white/15 bg-[#09090e] shadow-2xl"
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3 bg-[#121218]">
          <div className="flex items-center gap-3 min-w-0">
            <ChannelLogo channel={channel} size="sm" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[15px] font-bold text-white">
                  {channel.name}
                </span>
                <span className="flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-[9.5px] font-bold uppercase text-red-400">
                  <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
                  LIVE
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-white/60">
                {channel.country && (
                  <span className="flex items-center gap-1">
                    {getCountryFlag(channel.country)} {channel.country}
                  </span>
                )}
                {channel.group && <span>• {channel.group}</span>}
                <span className="text-white/40">
                  ({useDirect ? 'Direct Stream' : 'Proxied Stream'})
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleFullscreen}
              className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white transition cursor-pointer"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-white/70 hover:bg-white/10 hover:text-white transition cursor-pointer"
              aria-label="Close player"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {/* Video Canvas */}
        <div className="relative aspect-video w-full bg-black flex items-center justify-center">
          <video
            ref={videoRef}
            controls
            playsInline
            className="size-full object-contain"
          />

          {loading && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/75 backdrop-blur-sm">
              <Spinner className="size-10 text-accent animate-spin" />
              <p className="text-[13.5px] font-semibold text-white/90 animate-pulse">
                Connecting to live broadcast stream...
              </p>
            </div>
          )}

          {errorText && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3.5 bg-black/90 p-6 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-400">
                <Radio className="size-7" />
              </div>
              <p className="text-[16px] font-bold text-white">Stream Unavailable</p>
              <p className="max-w-md text-[13px] text-white/70 leading-relaxed">
                {errorText}. Many live TV links are geo-blocked by national broadcasters or go offline.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2.5 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    setErrorText(null);
                    setLoading(true);
                    const v = videoRef.current;
                    if (v) v.load();
                  }}
                  className="flex items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 text-[12.5px] font-bold text-accent-contrast transition hover:bg-accent-hover cursor-pointer shadow-md"
                >
                  <RotateCcw className="size-3.5" />
                  Retry Stream
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setErrorText(null);
                    setLoading(true);
                    setUseDirect(!useDirect);
                  }}
                  className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-5 py-2.5 text-[12.5px] font-semibold text-white transition hover:bg-white/20 cursor-pointer"
                >
                  {useDirect ? 'Switch to Proxy' : 'Try Direct Connection'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Playlist management with presets.
 */
function PlaylistControls() {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const playlists = useQuery({
    queryKey: ['tv', 'playlists'] as const,
    queryFn: api.tvPlaylists,
  });

  const add = async (sourceUrl?: string) => {
    const source = (sourceUrl || url).trim();
    if (!source) return;

    setBusy(true);
    try {
      await api.addTvPlaylist(source);
      setUrl('');
      await playlists.refetch();
      useUiStore.getState().notify('success', 'Playlist added successfully');
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
    <div className="flex w-full max-w-xl flex-col gap-3">
      {/* Input row */}
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
          placeholder="Paste M3U playlist URL (e.g., https://.../playlist.m3u)"
          aria-label="Playlist URL"
          className="min-w-0 flex-1 rounded-full border border-border-default bg-bg-surface px-4 py-2 text-[12.5px] text-fg-default outline-none transition placeholder:text-fg-subtle focus:border-accent"
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={busy || !url.trim()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-contrast transition hover:bg-accent-hover disabled:opacity-40 cursor-pointer shadow-sm"
        >
          {busy ? <Spinner className="size-3" /> : <Plus className="size-3.5" />}
          Add
        </button>
      </div>

      {/* Quick Add Presets: Curated, Country & Category */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1 text-[11px] font-medium text-white/50 mr-1">
          <Sparkles className="size-3 text-accent" />
          Presets:
        </span>
        {CURATED_PRESETS.map((preset) => {
          const isAdded = existingPlaylists.has(preset.url);
          return (
            <button
              key={preset.url}
              type="button"
              disabled={busy || isAdded}
              onClick={() => void add(preset.url)}
              title={isAdded ? 'Already active' : `Add ${preset.label}`}
              className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
                isAdded
                  ? 'bg-white/5 text-white/35 cursor-default'
                  : 'bg-white/10 text-white/80 hover:bg-accent hover:text-accent-contrast'
              }`}
            >
              {preset.flag && <span>{preset.flag}</span>}
              <span>{isAdded ? `✓ ${preset.label}` : `+ ${preset.label}`}</span>
              {preset.badge && (
                <span className="rounded bg-accent/20 px-1 py-0.2 text-[9px] font-bold text-accent">
                  {preset.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Playlists List */}
      {(playlists.data?.length ?? 0) > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1">
          {playlists.data!.map((source, index) => (
            <li
              key={`${index}:${source}`}
              className="surface flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 border border-border-default/50"
            >
              <span className="max-w-[15rem] truncate text-[11.5px] text-fg-muted font-medium">
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