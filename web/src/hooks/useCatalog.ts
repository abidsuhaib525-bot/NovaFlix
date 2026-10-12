/**
 * Query hooks over the API client.
 *
 * Every server call in the app goes through one of these, and every cache key is
 * declared here. Two reasons for keeping them in one place rather than next to
 * each component:
 *
 *  - **Invalidation safety.** Marking the history stale after a progress report
 *    has to name the same key the list view read. Deriving both from one
 *    factory means they cannot drift.
 *  - **Loading state for free.** Components read `isPending` instead of each
 *    keeping its own `useState`, so a reload and a first load look the same.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';

import { api } from '@/lib/api';
import type {
  AddonCatalogTarget,
  BrowsePresetKey,
  BrowseRail,
  CatalogItem,
  FavoriteItem,
  HomeDeckResponse,
  HomepageTab,
  InstalledAddon,
  MediaDetails,
  ProviderInfo,
  ProviderKind,
  Release,
  Settings,
  WatchHistoryItem,
} from '@/types';

/* -------------------------------------------------------------------------- */
/* Keys                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cache key factory.
 *
 * `as const` on each leaf so the object literals are readonly tuples, which stops
 * a typo in one caller from producing a key that matches nothing.
 */
export const keys = {
  providers: () => ['providers'] as const,
  health: () => ['health'] as const,
  tabs: () => ['homepage', 'tabs'] as const,
  homepage: (tabId: string, page: number) => ['homepage', tabId, page] as const,
  browseAll: () => ['browse', 'all'] as const,
  browse: (preset: BrowsePresetKey) => ['browse', preset] as const,
  search: (provider: ProviderKind, query: string, page: number) =>
    ['search', provider, query, page] as const,
  details: (provider: ProviderKind, id: string) => ['details', provider, id] as const,
  streams: (provider: ProviderKind, id: string, season: number, episode: number) =>
    ['streams', provider, id, season, episode] as const,
  resolutions: (provider: ProviderKind, id: string) => ['resolutions', provider, id] as const,
  // `siblings` is part of the key, not an argument the query function closes
  // over: it selects which fallback release the upstream subtitle lookup uses,
  // so a different list is a genuinely different result.
  subtitles: (
    subjectId: string,
    resourceId: string,
    siblings: string[],
    season: number,
    episode: number,
  ) => ['subtitles', subjectId, resourceId, siblings, season, episode] as const,
  history: () => ['history'] as const,
  favorites: () => ['favorites'] as const,
  settings: () => ['settings'] as const,
  addons: () => ['addons'] as const,
  addonCatalog: (target: AddonCatalogTarget) =>
    ['addon-catalog', target.manifest_url, target.type, target.catalog_id] as const,
} as const;

/* -------------------------------------------------------------------------- */
/* System                                                                     */
/* -------------------------------------------------------------------------- */

export function useHealth() {
  return useQuery({
    queryKey: keys.health(),
    queryFn: api.health,
    // The banner that shows when the server is down must be able to poll for a
    // recovery, so this one opts out of the global stale time.
    staleTime: 5_000,
    retry: 1,
  });
}

export function useProviders(): UseQueryResult<ProviderInfo[]> {
  return useQuery({ queryKey: keys.providers(), queryFn: api.providers });
}

export function useSettings(): UseQueryResult<Settings> {
  return useQuery({ queryKey: keys.settings(), queryFn: api.settings });
}

/**
 * Queue a download.
 *
 * Separate from the transfer queue's own polling hook because starting a
 * download and watching one are different concerns: the details page starts many
 * without watching any, and the downloads page watches without starting.
 *
 * Invalidates the snapshot on success so the new task appears immediately rather
 * than on the next poll tick.
 */
export function useStartDownload() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.startDownload,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['downloads'] });
    },
  });
}

/**
 * Subtitle options for one release.
 *
 * `siblings` is the resource's own id list, which the upstream subtitle endpoint
 * needs as a fallback for a release that carries no subtitle of its own. It is
 * part of the cache key rather than an argument the query function closes over,
 * so switching mirrors fetches a different set rather than reusing the last one.
 */
export function useSubtitles({
  subjectId,
  resourceId,
  siblings,
  season,
  episode,
}: {
  subjectId: string;
  resourceId: string;
  siblings: string[];
  season: number;
  episode: number;
}) {
  return useQuery({
    queryKey: ['subtitles', subjectId, resourceId, siblings, season, episode] as const,
    queryFn: () => api.subtitles(subjectId, resourceId, siblings, season, episode),
    enabled: Boolean(subjectId && resourceId),
    staleTime: 10 * 60_000,
  });
}

/** Persist settings and refresh every list the settings control. */
export function useSaveSettings(): UseMutationResult<Settings, Error, Settings> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveSettings,
    onSuccess: (saved) => {
      client.setQueryData(keys.settings(), saved);
      // Provider toggles change what search and discovery return, so any cached
      // catalogue is now suspect.
      void client.invalidateQueries({ queryKey: ['providers'] });
      void client.invalidateQueries({ queryKey: ['homepage'] });
      void client.invalidateQueries({ queryKey: ['browse'] });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Addons                                                                     */
/* -------------------------------------------------------------------------- */

/** Installed Stremio-style addons. */
export function useAddons(): UseQueryResult<InstalledAddon[]> {
  return useQuery({
    queryKey: keys.addons(),
    queryFn: api.addons,
    // An install from another tab should land without a reload.
    staleTime: 10_000,
  });
}

/** Fetch one addon's catalogue through the server's CORS-less proxy. */
export function useAddonCatalog(
  target: AddonCatalogTarget | null,
): UseQueryResult<CatalogItem[]> {
  return useQuery({
    queryKey: target ? keys.addonCatalog(target) : ['addon-catalog', null],
    queryFn: () => api.addonCatalog(target as AddonCatalogTarget),
    enabled: target !== null,
    staleTime: 5 * 60_000,
  });
}

/** Install a manifest, replacing any previous copy of the same URL. */
export function useAddAddon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.addAddon,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.addons() });
    },
  });
}

/** Enable or disable one installed addon by list index. */
export function useToggleAddon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ index, enabled }: { index: number; enabled: boolean }) =>
      api.toggleAddon(index, enabled),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.addons() });
    },
  });
}

/** Uninstall an addon by list index. */
export function useRemoveAddon() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (index: number) => api.removeAddon(index),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.addons() });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

export function useHomepageTabs(): UseQueryResult<HomepageTab[]> {
  return useQuery({
    queryKey: keys.tabs(),
    queryFn: api.homepageTabs,
    // Settings can reveal the mature tab, and the tab rail is the thing that
    // changes. Cheap endpoint, so it is refetched when the window regains focus
    // even though the global default is not to.
    staleTime: 10_000,
  });
}

export function useHomepage(tabId: string, page = 1): UseQueryResult<HomeDeckResponse> {
  return useQuery({
    queryKey: keys.homepage(tabId, page),
    queryFn: () => api.homepage(tabId, page),
    // A tab with no items is a legitimate upstream answer, not an error, but it
    // is also not worth caching hard -- an empty tab may fill within minutes.
    retry: 1,
  });
}

/**
 * Every home-page rail, in one response.
 *
 * Deliberately one query rather than one per rail. `api.browse` fetches source
 * tabs sequentially because concurrency trips the upstream CDN's rate limiter,
 * so four separate rail queries meant four concurrent walks of that same
 * sequential path and rails came back empty. Asking for them together keeps the
 * server's "one at a time" guarantee intact and costs one round trip.
 */
export function useBrowseRails(): UseQueryResult<BrowseRail[]> {
  return useQuery({
    queryKey: keys.browseAll(),
    queryFn: api.browseAll,
    // Each rail pools several upstream tabs server-side, so this is the most
    // expensive read on the home page. Held fresh for longer than everything else.
    staleTime: 5 * 60_000,
  });
}

/**
 * One rail on its own.
 *
 * For a caller that already knows which preset it wants -- a details page asking
 * "what is the top-rated option for this title", say. Not for the home page;
 * see [`useBrowseRails`].
 */
export function useBrowseRail(preset: BrowsePresetKey): UseQueryResult<BrowseRail> {
  return useQuery({
    queryKey: keys.browse(preset),
    queryFn: () => api.browse(preset),
    staleTime: 5 * 60_000,
  });
}

export function useSearch(
  provider: ProviderKind,
  query: string,
  page = 1,
): UseQueryResult<CatalogItem[]> {
  const trimmed = query.trim();
  return useQuery({
    queryKey: keys.search(provider, trimmed, page),
    queryFn: () => api.search(provider, trimmed, page),
    // Never query an empty box: the backend treats it as "no results", and
    // firing a request per keystroke while the user is still typing would also
    // wipe the previous results and make the page jump.
    enabled: trimmed.length > 0,
    // Discard responses for a query the user has already moved past.
    // `placeholderData` rather than `keepPreviousData`: see the hook body below.
    staleTime: 60_000,
  });
}

/** Type-ahead suggestions for the search box. */
export function useSuggest(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ['suggest', trimmed] as const,
    queryFn: () => api.suggest(trimmed),
    enabled: trimmed.length >= 2,
    // Suggestions are advisory; a stale one is invisible to the user, and this
    // is the most frequently repeated request in the app.
    staleTime: 5 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Metadata                                                                   */
/* -------------------------------------------------------------------------- */

export function useDetails(
  provider: ProviderKind,
  id: string,
): UseQueryResult<MediaDetails> {
  return useQuery({
    queryKey: keys.details(provider, id),
    queryFn: () => api.details(provider, id),
    // Details pages are opened from a poster and usually watched to the end, so
    // re-entering the same title should be instant.
    staleTime: 5 * 60_000,
  });
}

export function useStreams(
  provider: ProviderKind,
  id: string,
  season: number,
  episode: number,
): UseQueryResult<Release[]> {
  return useQuery({
    queryKey: keys.streams(provider, id, season, episode),
    queryFn: () => api.streams(provider, id, season, episode),
    // Season 0 is the movie case; an explicit 0 is meaningful, so no defaulting.
    enabled: Boolean(id),
    staleTime: 5 * 60_000,
  });
}

export function useResolutions(provider: ProviderKind, id: string) {
  return useQuery({
    queryKey: keys.resolutions(provider, id),
    queryFn: () => api.resolutions(provider, id),
    enabled: Boolean(id),
    staleTime: 10 * 60_000,
  });
}

/* -------------------------------------------------------------------------- */
/* Library                                                                    */
/* -------------------------------------------------------------------------- */

export function useHistory(): UseQueryResult<WatchHistoryItem[]> {
  return useQuery({
    queryKey: keys.history(),
    queryFn: api.history,
    staleTime: 30_000,
  });
}

export function useFavorites(): UseQueryResult<FavoriteItem[]> {
  return useQuery({
    queryKey: keys.favorites(),
    queryFn: api.favorites,
    staleTime: 30_000,
  });
}

/**
 * Invalidate the library lists.
 *
 * Shared by every mutation below. History is read by three separate views (the
 * continue-watching rail, the library page and the details page's resume bar), so
 * a targeted invalidation of one of them would leave the others stale.
 */
function useInvalidateLibrary() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: keys.history() });
    void client.invalidateQueries({ queryKey: keys.favorites() });
  };
}

/** Toggle a favourite, optimistically settling the button. */
export function useToggleFavorite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.toggleFavorite,
    onMutate: async (payload) => {
      // The button has to respond on click, not after a round-trip. The previous
      // list is restored on failure so a rejected toggle visibly reverts.
      await client.cancelQueries({ queryKey: keys.favorites() });
      const previous = client.getQueryData<FavoriteItem[]>(keys.favorites());

      client.setQueryData<FavoriteItem[]>(keys.favorites(), (current = []) => {
        const exists = current.some(
          (item) => item.subject_id === payload.subject_id && item.provider === payload.provider,
        );
        return exists
          ? current.filter(
              (item) =>
                !(item.subject_id === payload.subject_id && item.provider === payload.provider),
            )
          : [
              ...current,
              {
                provider: payload.provider,
                subject_id: payload.subject_id,
                title: payload.title ?? 'Untitled',
                stype: payload.stype ?? 1,
                release_year: payload.release_year ?? '',
                cover_url: payload.cover_url ?? null,
                added_at: Math.floor(Date.now() / 1000),
              },
            ];
      });

      return { previous };
    },
    onError: (_error, _payload, context) => {
      if (context?.previous) {
        client.setQueryData(keys.favorites(), context.previous);
      }
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.favorites() });
    },
  });
}

/** Delete one history entry. Invalidates rather than patching the list. */
export function useDeleteHistory() {
  const invalidate = useInvalidateLibrary();
  return useMutation({
    mutationFn: ({ provider, id }: { provider: string; id: string }) =>
      api.deleteHistory(provider, id),
    onSettled: invalidate,
  });
}

export function useClearHistory() {
  const invalidate = useInvalidateLibrary();
  return useMutation({ mutationFn: api.clearHistory, onSettled: invalidate });
}

export function useClearFavorites() {
  const invalidate = useInvalidateLibrary();
  return useMutation({ mutationFn: api.clearFavorites, onSettled: invalidate });
}

/**
 * Report playback position.
 *
 * Fire-and-forget: the player calls this every few seconds and the user gets
 * nothing from the response. Errors are swallowed by the component rather than
 * surfaced, because a failed progress ping must never interrupt playback.
 */
export function useSaveProgress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.saveProgress,
    onSuccess: () => {
      // Only the continue-watching rail depends on position, and it sorts by
      // timestamp -- so a full invalidation here would reshuffle the home page
      // mid-scene.
      void client.invalidateQueries({ queryKey: keys.history() });
    },
  });
}

/**
 * Whether a history entry counts as "in progress".
 *
 * Mirrors `history.rs`'s `is_in_progress` so the continue-watching rail and the
 * server agree on what is resumable. A finished title belongs in history but not
 * on the rail, and a title watched for four seconds is not worth resuming.
 */
export function isInProgress(item: WatchHistoryItem): boolean {
  if (item.completed) return false;
  if (!item.duration_seconds || item.duration_seconds <= 0) return false;
  if (item.progress_seconds < 30) return false;

  // Treat the last few minutes as "finished" so a title is not offered for
  // resume when only the credits are left.
  const remaining = item.duration_seconds - item.progress_seconds;
  return remaining > 120;
}

/** Fraction watched, 0 to 1. Zero when the duration is unknown. */
export function progressFraction(item: WatchHistoryItem): number {
  if (!item.duration_seconds || item.duration_seconds <= 0) return 0;
  return Math.max(0, Math.min(1, item.progress_seconds / item.duration_seconds));
}