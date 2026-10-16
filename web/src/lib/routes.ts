/**
 * Route construction and route-parameter parsing.
 *
 * Every `Link to=` and `navigate()` in the app goes through `paths`, so a route
 * change is a single edit rather than a hunt through string literals. The
 * `parse*` helpers are the other half: they validate values coming *in* from the
 * URL, which is the one input in the app that cannot be trusted.
 */

import type { ProviderKind } from '@/types';

const KINDS: readonly ProviderKind[] = [
  'moviebox',
  'fourkhdhub',
  'bdix_circleftp',
  'bdix_dhakaflix',
  'addons',
  'dramachi',
];

/** Whether a URL segment names a provider this build knows. */
export function isProviderKind(value: string | undefined): value is ProviderKind {
  return value !== undefined && (KINDS as readonly string[]).includes(value);
}

/**
 * Build the path for a title's details page.
 *
 * `id` is encoded: MovieBox subject ids are opaque strings and some providers
 * use ids containing `/`, which would otherwise split the path and 404.
 */
export const paths = {
  home: () => '/',

  /** One homepage tab's full listing. */
  tab: (tabId: string) => `/tab/${encodeURIComponent(tabId)}`,

  search: (query?: string, provider: ProviderKind = 'moviebox') => {
    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (provider) p.set('provider', provider);
    const suffix = p.toString();
    return suffix ? `/search?${suffix}` : '/search';
  },

  title: (provider: ProviderKind, id: string) =>
    `/title/${provider}/${encodeURIComponent(id)}`,

  /**
   * The player.
   *
   * Season and episode go in the query string, not the path, so that opening the
   * player without a selection and then choosing one is a URL update rather than
   * a navigation that would unmount the player and throw away its buffer.
   */
  watch: (provider: ProviderKind, id: string, position?: { season?: number; episode?: number }) => {
    const query = new URLSearchParams();
    if (position?.season !== undefined) query.set('season', String(position.season));
    if (position?.episode !== undefined) query.set('episode', String(position.episode));
    const suffix = query.toString();
    return `/watch/${provider}/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`;
  },

  library: () => '/favorites',
  favorites: () => '/favorites',
  history: () => '/history',
  downloads: () => '/downloads',
  addons: () => '/addons',
  settings: () => '/settings',
} as const;

/**
 * Build a details path from a provider string that came out of stored data.
 *
 * History and favourites store `provider` as a plain string, not a
 * `ProviderKind`. Narrowing it with a cast would be a lie if the value ever came
 * from a build with a provider this one does not know -- the backend would still
 * understand it. So the string is interpolated as-is and the URL is built; if the
 * id really is unknown, the route guard reports it rather than this pretending it
 * cannot happen.
 */
export function storedTitlePath(provider: string, id: string): string {
  return `/title/${provider}/${encodeURIComponent(id)}`;
}

/** [`storedTitlePath`] for the player, including a resume position. */
export function storedWatchPath(
  provider: string,
  id: string,
  position?: { season?: number; episode?: number },
): string {
  const query = new URLSearchParams();
  if (position?.season !== undefined) query.set('season', String(position.season));
  if (position?.episode !== undefined) query.set('episode', String(position.episode));
  const suffix = query.toString();
  return `/watch/${provider}/${encodeURIComponent(id)}${suffix ? `?${suffix}` : ''}`;
}

/**
 * A non-negative integer from a URL search param.
 *
 * Returns `undefined` for anything absent or malformed so the caller can apply
 * its own default. `Number` alone would happily turn `""` into `0` and `"3abc"`
 * into `NaN`, and a NaN episode index surfaces much later as an upstream 404 with
 * no obvious cause.
 */
export function readIndex(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
}