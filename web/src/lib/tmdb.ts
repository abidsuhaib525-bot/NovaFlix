/**
 * TMDB metadata enrichment client.
 *
 * Provides high-res actor profiles, characters, production stills,
 * and per-episode backdrop images exactly like Movnix.
 */

const TMDB_API_KEY = '4e44d9029b1270a757cddc766a1bcb63';
const BASE_URL = 'https://api.themoviedb.org/3';

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profile_path: string | null;
}

export interface TmdbEpisodeMeta {
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  still_path: string | null;
  runtime?: number;
}

// In-memory cache to avoid duplicate network requests
const searchCache = new Map<string, number | null>();
const creditsCache = new Map<string, CastMember[]>();
const seasonCache = new Map<string, Map<number, TmdbEpisodeMeta>>();

export function getTmdbImageUrl(path: string | null | undefined, size: 'w185' | 'w300' | 'w500' | 'w780' | 'original' = 'w500'): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

export async function searchTmdbMedia(title: string, year?: string | null, isTv = true): Promise<number | null> {
  const clean = title.replace(/[\[(].*?[\])]/g, '').replace(/S\d+(-S\d+)?/gi, '').trim();
  const cacheKey = `${isTv ? 'tv' : 'movie'}:${clean.toLowerCase()}:${year ?? ''}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey)!;
  }

  try {
    const type = isTv ? 'tv' : 'movie';
    let url = `${BASE_URL}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}`;
    if (year) {
      url += isTv ? `&first_air_date_year=${year}` : `&year=${year}`;
    }

    let res = await fetch(url);
    let data = res.ok ? await res.json() : null;

    // If searching with re-release year yields nothing (common in anime/dubs), fallback to query without year
    if (!data?.results?.length && year) {
      const fallbackUrl = `${BASE_URL}/search/${type}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(clean)}`;
      const fallbackRes = await fetch(fallbackUrl);
      if (fallbackRes.ok) {
        data = await fallbackRes.json();
      }
    }

    const top = data?.results?.[0];
    const id = top ? (top.id as number) : null;
    searchCache.set(cacheKey, id);
    return id;
  } catch {
    searchCache.set(cacheKey, null);
    return null;
  }
}

export async function fetchTmdbCast(tmdbId: number, isTv = true): Promise<CastMember[]> {
  const cacheKey = `${isTv ? 'tv' : 'movie'}:${tmdbId}`;
  if (creditsCache.has(cacheKey)) {
    return creditsCache.get(cacheKey)!;
  }

  try {
    const type = isTv ? 'tv' : 'movie';
    const url = `${BASE_URL}/${type}/${tmdbId}/credits?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      creditsCache.set(cacheKey, []);
      return [];
    }
    const data = await res.json();
    const cast = (data.cast ?? []).slice(0, 16).map((c: any) => ({
      id: c.id,
      name: c.name,
      character: c.character || 'Cast',
      profile_path: c.profile_path,
    }));
    creditsCache.set(cacheKey, cast);
    return cast;
  } catch {
    creditsCache.set(cacheKey, []);
    return [];
  }
}

export async function fetchTmdbSeasonEpisodes(
  tmdbId: number,
  seasonNumber: number,
  totalEpisodesInSeason = 24
): Promise<Map<number, TmdbEpisodeMeta>> {
  const cacheKey = `tv:${tmdbId}:s${seasonNumber}:cnt${totalEpisodesInSeason}`;
  if (seasonCache.has(cacheKey)) {
    return seasonCache.get(cacheKey)!;
  }

  const episodeMap = new Map<number, TmdbEpisodeMeta>();
  try {
    // First, try standard season lookup
    const url = `${BASE_URL}/tv/${tmdbId}/season/${seasonNumber}?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      for (const ep of data.episodes ?? []) {
        episodeMap.set(ep.episode_number, {
          episode_number: ep.episode_number,
          season_number: ep.season_number,
          name: ep.name,
          overview: ep.overview,
          still_path: ep.still_path,
          runtime: ep.runtime,
        });
      }
    }

    // If upstream bundles multiple arcs into one season (e.g. 40 or 54 episodes in S1 when TMDB split them into S1-S6)
    if (episodeMap.size < totalEpisodesInSeason && totalEpisodesInSeason > (episodeMap.size || 0)) {
      try {
        const tvUrl = `${BASE_URL}/tv/${tmdbId}?api_key=${TMDB_API_KEY}`;
        const tvRes = await fetch(tvUrl);
        if (tvRes.ok) {
          const tvData = await tvRes.json();
          const allSeasonNums: number[] = (tvData.seasons ?? [])
            .map((s: any) => s.season_number)
            .filter((n: number) => n > 0 && n !== seasonNumber);

          let cumulativeEp = episodeMap.size + 1;
          for (const sNum of allSeasonNums) {
            if (cumulativeEp > totalEpisodesInSeason) break;
            const subRes = await fetch(`${BASE_URL}/tv/${tmdbId}/season/${sNum}?api_key=${TMDB_API_KEY}`);
            if (subRes.ok) {
              const subData = await subRes.json();
              for (const ep of subData.episodes ?? []) {
                if (!episodeMap.has(cumulativeEp)) {
                  episodeMap.set(cumulativeEp, {
                    episode_number: cumulativeEp,
                    season_number: seasonNumber,
                    name: ep.name,
                    overview: ep.overview,
                    still_path: ep.still_path,
                    runtime: ep.runtime,
                  });
                }
                cumulativeEp++;
              }
            }
          }
        }
      } catch {
        /* fallback silent */
      }
    }

    seasonCache.set(cacheKey, episodeMap);
    return episodeMap;
  } catch {
    seasonCache.set(cacheKey, episodeMap);
    return episodeMap;
  }
}

export async function fetchTmdbTrailer(tmdbId: number, isTv = true): Promise<string | null> {
  try {
    const type = isTv ? 'tv' : 'movie';
    const url = `${BASE_URL}/${type}/${tmdbId}/videos?api_key=${TMDB_API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const videos: any[] = data.results ?? [];
    // Prioritize official trailer on YouTube
    const trailer =
      videos.find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
      videos.find((v) => v.site === 'YouTube' && v.type === 'Teaser') ||
      videos.find((v) => v.site === 'YouTube');
    return trailer?.key ? (trailer.key as string) : null;
  } catch {
    return null;
  }
}

