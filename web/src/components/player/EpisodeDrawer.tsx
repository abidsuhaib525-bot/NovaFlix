/**
 * The episode selector.
 *
 * A right-side drawer, opened from the control bar, rather than a rail under the
 * player: a list of a hundred episodes would push the page into a second screen
 * of scrolling, and the drawer keeps the video the dominant element. Seasons are
 * chips because there are usually only a handful and a `<select>` hides them.
 */

import { X } from 'lucide-react';

import type { Season } from '@/types';

export function EpisodeDrawer({
  open,
  onClose,
  seasons,
  currentSeason,
  currentEpisode,
  onSelect,
  title,
}: {
  open: boolean;
  onClose: () => void;
  seasons: Season[];
  currentSeason: number;
  currentEpisode: number;
  onSelect: (season: number, episode: number) => void;
  title: string;
}) {
  if (!open) return null;

  const selected = seasons.find((s) => s.number === currentSeason) ?? seasons[0];
  const episodes = selected?.episodes ?? [];

  return (
    <div className="absolute inset-0 z-30 flex justify-end">
      {/* Backdrop: closes on click, and dims the video so text stays readable. */}
      <button
        type="button"
        aria-label="Close episodes"
        className="absolute inset-0 cursor-default bg-black/50"
        onClick={onClose}
      />

      <aside className="relative flex h-full w-[21rem] max-w-[85vw] flex-col border-l border-white/10 bg-[#0b0b10]/97 text-white shadow-2xl backdrop-blur-md">
        <header className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">{title}</p>
            <p className="text-[11px] text-white/50">
              {seasons.length} season{seasons.length === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close episodes"
            onClick={onClose}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-white/80 transition hover:bg-white/15 hover:text-white"
          >
            <X className="size-4.5" />
          </button>
        </header>

        {seasons.length > 1 && (
          <div className="flex flex-wrap gap-1.5 border-b border-white/10 px-4 py-3">
            {seasons.map((season) => (
              <button
                key={season.number}
                type="button"
                onClick={() => {
                  const first = season.episodes[0]?.number ?? 1;
                  onSelect(season.number, first);
                }}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-medium transition ${
                  season.number === currentSeason
                    ? 'bg-accent text-accent-contrast'
                    : 'bg-white/10 text-white/80 hover:bg-white/20'
                }`}
              >
                Season {season.number}
              </button>
            ))}
          </div>
        )}

        <ol className="flex-1 overflow-y-auto px-3 py-2">
          {episodes.map((episode) => {
            const active = episode.number === currentEpisode;
            return (
              <li key={episode.number}>
                <button
                  type="button"
                  onClick={() => onSelect(selected?.number ?? currentSeason, episode.number)}
                  className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    active ? 'bg-white/15' : 'hover:bg-white/8'
                  }`}
                >
                  <span
                    className={`mt-0.5 w-6 shrink-0 text-center text-[13px] font-semibold tabular-nums ${
                      active ? 'text-accent' : 'text-white/45'
                    }`}
                  >
                    {episode.number}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-white/90">
                      {episode.title?.trim() || `Episode ${episode.number}`}
                    </span>
                    {episode.overview && (
                      <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-white/45">
                        {episode.overview}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {episodes.length === 0 && (
            <li className="px-3 py-6 text-center text-[12.5px] text-white/45">
              No episodes listed for this season.
            </li>
          )}
        </ol>
      </aside>
    </div>
  );
}
