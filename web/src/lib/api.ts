import type {
  AddonCatalogTarget,
  BdixProbeResult,
  BrowsePreset,
  BrowsePresetKey,
  BrowseRail,
  CatalogItem,
  DownloadSnapshot,
  FavoriteItem,
  HomeDeckResponse,
  HomepageTab,
  InstalledAddon,
  MediaDetails,
  PlaybackSessionResponse,
  PlaybackSource,
  ProviderInfo,
  ProviderKind,
  Release,
  Settings,
  SubtitleOption,
  WatchHistoryItem,
} from '@/types';

/* -------------------------------------------------------------------------- */
/* Base                                                                       */
/* -------------------------------------------------------------------------- */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider?: ProviderKind,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function qs(params: Query): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const API_BASE = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL ||
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ||
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_BACKEND_URL ||
  (typeof window !== 'undefined' && window.location.hostname.includes('vercel.app') ? 'https://123.fluxcode.blitz.cloud' : '')
).replace(/\/+$/, '');

export function resolveUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(resolveUrl(path), {
      ...init,
      headers: {
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('Cannot reach the MovieBox server. Is it running?', 0);
  }

  if (!res.ok) {
    // The backend returns `{ "error": "..." }` for handled failures.
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body?.error) message = body.error;
      else if (body?.message) message = body.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string, params?: Query) => request<T>(`${path}${qs(params ?? {})}`);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const put = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/* -------------------------------------------------------------------------- */
/* Catalog                                                                    */
/* -------------------------------------------------------------------------- */

export const api = {
  health: () => get<{ status: string; version: string }>('/api/health'),

  /* Providers ------------------------------------------------------------ */
  providers: () => get<ProviderInfo[]>('/api/providers'),
  setProviderEnabled: (kind: ProviderKind, enabled: boolean) =>
    post<{ ok: true }>('/api/providers/enabled', { kind, enabled }),
  probeBdix: () => post<BdixProbeResult>('/api/providers/bdix/probe'),

  /* Search / discovery -------------------------------------------------- */
  search: (provider: ProviderKind, query: string, page = 1) =>
    get<CatalogItem[]>('/api/search', { provider, q: query, page }),
  suggest: (query: string) => get<string[]>('/api/search/suggest', { q: query }),
  homepage: (tabId: string, page = 1) => get<HomeDeckResponse>('/api/homepage', { tab_id: tabId, page }),
  /** The tab rail. Fetched, never hardcoded - see `HomepageTab`. */
  homepageTabs: () => get<HomepageTab[]>('/api/homepage/tabs'),
  browsePresets: () => get<BrowsePreset[]>('/api/browse/presets'),
  /**
   * Every rail at once.
   *
   * The home page uses this rather than four calls to `browse` below. Each
   * `browse` call fetches its source tabs sequentially because concurrency trips
   * the upstream CDN's rate limiter, so four browser requests meant four
   * simultaneous sequential walks and rails started coming back empty. One
   * request keeps the server's "one at a time" guarantee intact.
   *
   * `browse` is kept for a single rail on demand, where the caller already knows
   * which one it wants and there is nothing to be gained from the round trips.
   */
  browseAll: () => get<BrowseRail[]>('/api/browse/all'),
  /** One pre-ordered, pre-capped rail. Each call may hit several upstream tabs. */
  browse: (preset: BrowsePresetKey) => get<BrowseRail>(`/api/browse/${preset}`),
  addonCatalog: (target: AddonCatalogTarget) =>
    get<CatalogItem[]>('/api/addons/catalog', {
      manifest: target.manifest_url,
      type: target.type,
      id: target.catalog_id,
    }),

  /* Metadata ------------------------------------------------------------- */
  details: (provider: ProviderKind, id: string) => get<MediaDetails>('/api/details', { provider, id }),
  streams: (provider: ProviderKind, id: string, season = 0, episode = 0) =>
    get<Release[]>('/api/streams', { provider, id, season, episode }),
  resolutions: (provider: ProviderKind, id: string) =>
    get<number[]>('/api/streams/resolutions', { provider, id }),
  subtitles: (
    subjectId: string,
    resourceId: string,
    siblings: string[],
    season: number,
    episode: number,
  ) =>
    get<SubtitleOption[]>('/api/subtitles', {
      subject_id: subjectId,
      resource_id: resourceId,
      siblings: siblings.join(','),
      season,
      episode,
    }),

  /** Poster bytes are proxied so we control the User-Agent and size cap. */
  posterUrl: (url: string) => resolveUrl(`/api/poster${qs({ url })}`),
  downloadsStreamUrl: () => resolveUrl('/api/downloads/stream'),
  directDownloadUrl: (params: {
    provider: string;
    subject_id: string;
    season?: number;
    episode?: number;
    resource_id?: string | null;
    max_height?: number | null;
    format?: string | null;
    title?: string | null;
  }) => resolveUrl(`/api/downloads/direct${qs(params)}`),
  downloadFileUrl: (id: string) => resolveUrl(`/api/downloads/${encodeURIComponent(id)}/file`),
  resolveUrl: (path: string) => resolveUrl(path),

  /* Playback ------------------------------------------------------------- */
  createPlaybackSession: (source: PlaybackSource) =>
    post<PlaybackSessionResponse>('/api/playback/session', source),

  /* Library -------------------------------------------------------------- */
  history: () => get<WatchHistoryItem[]>('/api/history'),
  saveHistory: (item: Partial<WatchHistoryItem>) => post<{ ok: true }>('/api/history', item),
  saveProgress: (payload: {
    subject_id: string;
    provider: string;
    title?: string;
    season: number;
    episode: number;
    position: number;
    duration: number;
    completed?: boolean;
    cover_url?: string | null;
    release_year?: string;
  }) => post<{ ok: true }>('/api/history/progress', payload),
  deleteHistory: (provider: string, id: string) =>
    del<{ ok: true }>(`/api/history/${encodeURIComponent(provider)}/${encodeURIComponent(id)}`),
  markWatched: (payload: Partial<WatchHistoryItem> & { subject_id: string; provider: string }) =>
    post<{ ok: true }>('/api/history/mark-watched', payload),
  clearHistory: () => del<{ ok: true }>('/api/history'),

  favorites: () => get<FavoriteItem[]>('/api/favorites'),
  toggleFavorite: (item: Partial<FavoriteItem> & { subject_id: string; provider: string }) =>
    post<{ favorite: boolean }>('/api/favorites', item),
  clearFavorites: () => del<{ ok: true }>('/api/favorites'),

  /* Addons --------------------------------------------------------------- */
  addons: () => get<InstalledAddon[]>('/api/addons'),
  addAddon: (manifestUrl: string) => post<InstalledAddon>('/api/addons', { manifest_url: manifestUrl }),
  toggleAddon: (index: number, enabled: boolean) =>
    post<{ ok: true }>(`/api/addons/${index}/toggle`, { enabled }),
  removeAddon: (index: number) => del<{ ok: true }>(`/api/addons/${index}`),

  /* Downloads ------------------------------------------------------------ */
  downloads: () => get<DownloadSnapshot>('/api/downloads'),
  startDownload: (payload: {
    subject_id: string;
    provider: string;
    title?: string;
    season: number;
    episode: number;
    resource_id?: string | null;
    max_height?: number | null;
    subtitle?: string | null;
    filename?: string | null;
    format?: 'mp4' | 'mkv' | string | null;
    /** Carried through to the library row, so history can show a thumbnail. */
    cover_url?: string | null;
    release_year?: string | null;
  }) => post<{ id: string }>('/api/downloads', payload),
  pauseDownload: (id: string) => post<{ ok: true }>(`/api/downloads/${id}/pause`),
  resumeDownload: (id: string) => post<{ ok: true }>(`/api/downloads/${id}/resume`),
  cancelDownload: (id: string) => post<{ ok: true }>(`/api/downloads/${id}/cancel`),
  deleteDownload: (id: string) => del<{ ok: true }>(`/api/downloads/${id}`),
  clearDownloads: () => del<{ ok: true }>('/api/downloads'),

  /* Settings / cache ------------------------------------------------------ */
  settings: () => get<Settings>('/api/settings'),
  saveSettings: (settings: Settings) => put<Settings>('/api/settings', settings),
  clearCache: () => post<{ ok: true; freed_bytes: number }>('/api/cache/clear'),
};

export type Api = typeof api;