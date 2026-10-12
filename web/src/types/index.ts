/**
 * Domain types - mirrors `src/providers/models.rs` and `src/models.rs`.
 *
 * These are hand-maintained to match the Rust serde output. When the Rust side
 * is stable, swap this file for `ts-rs` generated output (see plan Phase 1).
 */

export type ProviderKind =
  | 'moviebox'
  | 'fourkhdhub'
  | 'bdix_circleftp'
  | 'bdix_dhakaflix'
  | 'addons'
  | 'dramachi';

export type MediaType = 'movie' | 'series';

export interface ProviderMediaId {
  provider: ProviderKind;
  value: string;
}

export interface CatalogItem {
  id: ProviderMediaId;
  title: string;
  media_type: MediaType;
  year: string | null;
  poster_url: string | null;
  season_count: number | null;
}

export interface Episode {
  season: number;
  number: number;
  title: string | null;
  overview: string | null;
}

export interface Season {
  number: number;
  episodes: Episode[];
}

export interface AudioTrackOption {
  subject_id: string;
  language: string;
  label: string;
}

export interface MediaDetails {
  id: ProviderMediaId;
  title: string;
  media_type: MediaType;
  year: string | null;
  description: string | null;
  tagline: string | null;
  imdb_rating: string | null;
  director: string | null;
  stars: string | null;
  prints: string | null;
  audios: string | null;
  poster_url: string | null;
  duration: string | null;
  genres: string[];
  seasons: Season[];
  dubs: AudioTrackOption[];
}

export interface SourceMirror {
  label: string;
  resolver_url: string;
  headers: [string, string][];
  direct_file: boolean;
}

export interface Release {
  provider: ProviderKind;
  filename: string;
  quality: string | null;
  codec: string | null;
  language: string | null;
  size_bytes: number | null;
  season: number | null;
  episode: number | null;
  mirrors: SourceMirror[];
  resource_id: string | null;
}

export interface PlaybackSubtitle {
  url: string;
  lang: string;
  label: string;
}

export interface PlaybackSource {
  provider: ProviderKind;
  url: string;
  headers: [string, string][];
  subtitle: string | null;
  /**
   * External subtitle tracks the browser will register with Shaka.
   *
   * Sent so the backend proxy can whitelist their hosts; without it the
   * subtitle route answers 403 and every track silently fails to load.
   */
  subtitles?: PlaybackSubtitle[];
  source_label: string;
  max_height: number | null;
}

export interface SubtitleOption {
  name: string;
  url: string;
}

export interface BrowseMetrics {
  trending: number | null;
  rating: number | null;
  recent_rating: number | null;
  popularity: number | null;
}

export interface BrowsePreset {
  key: BrowsePresetKey;
  label: string;
  /**
   * Which `BrowseMetrics` field orders this rail. Echoed by the server so the
   * client can show a rating badge on the cards without a second request.
   */
  metric: BrowseMetricKey;
  /** Upstream tabs pooled together, for the curious. Not needed by the UI. */
  sources: string[];
}

export type BrowsePresetKey =
  | 'trending'
  | 'top_rated_all_time'
  | 'top_rated_recent'
  | 'most_watched';

export type BrowseMetricKey = 'trending' | 'rating' | 'recent_rating' | 'popularity';

/** One horizontal scroller of titles, already ordered and capped by the server. */
export interface BrowseRail {
  key: BrowsePresetKey;
  label: string;
  items: CatalogItem[];
}

/**
 * A homepage tab.
 *
 * Fetched from the server rather than hardcoded: the upstream `tabId`s are an
 * undocumented implementation detail, and an unknown id silently returns the
 * default feed instead of erroring, so a stale copy in the client would be
 * impossible to notice.
 */
export interface HomepageTab {
  id: string;
  label: string;
  blurb: string;
  /** Always false in the response - mature tabs are filtered out server-side. */
  mature: boolean;
}

export interface ProviderCapabilities {
  supports_search: boolean;
  supports_pagination: boolean;
  supports_series: boolean;
  supports_subtitles: boolean;
  supports_homepage: boolean;
}

export interface ProviderInfo {
  kind: ProviderKind;
  label: string;
  enabled: boolean;
  available: boolean;
  capabilities: ProviderCapabilities;
}

export interface BdixProbeResult {
  circleftp: boolean;
  dhakaflix: boolean;
}

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

export interface SubjectIdentity {
  provider: string;
  subject_id: string;
  title: string;
  stype: number;
  release_year: string;
}

export interface WatchHistoryItem {
  provider: string;
  subject_id: string;
  title: string;
  stype: number;
  release_year: string;
  cover_url: string | null;
  season: number;
  episode: number;
  timestamp: number;
  /**
   * Seconds watched so far.
   *
   * The server calls this `progress_seconds`, not `position_secs`. The first
   * version of this type invented the other names, so every read was
   * `undefined`: `isInProgress` returned false for every entry, `progressFraction`
   * returned 0, and the continue-watching rail and its progress bars rendered
   * as if nothing had ever been watched.
   */
  progress_seconds: number;
  /** `null` while nothing has been played yet, so the duration is unknown. */
  duration_seconds: number | null;
  completed: boolean;
  /** The source's filename when the entry came from a stream listing. */
  stream_filename: string | null;
}

export interface FavoriteItem {
  provider: string;
  subject_id: string;
  title: string;
  stype: number;
  release_year: string;
  cover_url: string | null;
  added_at: number;
}

/* -------------------------------------------------------------------------- */
/* TV / Addons                                                                */
/* -------------------------------------------------------------------------- */

export interface TvChannel {
  name: string;
  url: string;
  group: string | null;
  logo: string | null;
  tvg_id: string | null;
}

export interface InstalledAddon {
  manifest_url: string;
  name: string;
  version: string | null;
  description: string | null;
  enabled: boolean;
  provides_catalog: boolean;
  provides_meta: boolean;
  provides_stream: boolean;
  id_prefixes: string[];
  types: string[];
}

export interface AddonCatalogTarget {
  manifest_url: string;
  type: string;
  catalog_id: string;
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

export type DownloadState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface DownloadTask {
  id: string;
  filename: string;
  title: string;
  state: DownloadState;
  /** 0–100, or `null` while the total size is still unknown. */
  progress: number | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number | null;
  error: string | null;
  path: string | null;
}

export interface DownloadSnapshot {
  tasks: DownloadTask[];
  active: number;
}

/**
 * One frame pushed over `GET /api/downloads/stream`.
 *
 * A subset of `DownloadTask` — the fields that change while a transfer runs. The
 * page merges a frame into the task it names; everything else (filename, title,
 * path) comes from the snapshot.
 */
export interface DownloadProgressEvent {
  id: string;
  state: DownloadState;
  progress: number | null;
  downloaded_bytes: number;
  total_bytes: number | null;
  speed_bps: number | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export interface Settings {
  active_provider: ProviderKind;
  active_theme: string;
  moviebox_enabled: boolean;
  fourkhdhub_enabled: boolean;
  dramachi_enabled: boolean;
  bdix_circleftp_enabled: boolean;
  bdix_dhakaflix_enabled: boolean;
  streaming_enabled: boolean;
  /** Reveals the adult "Midnight" homepage tab. Off by default. */
  mature_content_enabled: boolean;
  tv_enabled: boolean;
  addons_enabled: boolean;
  download_dir: string | null;
  default_quality: number | null;
  autoplay_next_episode: boolean;
}

/* -------------------------------------------------------------------------- */
/* Playback                                                                   */
/* -------------------------------------------------------------------------- */

export interface PlaybackSessionResponse {
  session_id: string;
  manifest_url: string;
  proxy_base: string;
  source: PlaybackSource;
}

/* -------------------------------------------------------------------------- */
/* Misc                                                                       */
/* -------------------------------------------------------------------------- */

export interface HomeDeckResponse {
  items: CatalogItem[];
  metrics: Record<string, BrowseMetrics>;
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  moviebox: 'MovieBox',
  fourkhdhub: '4KHDHub',
  bdix_circleftp: 'CircleFTP',
  bdix_dhakaflix: 'DhakaFlix',
  addons: 'Addons',
  dramachi: 'Dramachi',
};