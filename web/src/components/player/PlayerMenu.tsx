/**
 * The player's options panel with Netflix-style tabs for Audio/Subtitles, Quality, and Speed.
 */

import { Check, Gauge, Languages, ListVideo, Monitor, Scaling, Sliders, Volume2 } from 'lucide-react';

import type { AudioTrackOption, Release, Season } from '@/types';
import type { PlayerController } from './usePlayerState';
import { variantLabel } from './tracks';

export type PlayerMenuTab = 'episodes' | 'audio_subs' | 'quality' | 'aspect_ratio' | 'settings';

export type AspectRatioMode = 'contain' | 'cover' | 'fill' | '16:9' | '4:3';

export interface AspectRatioOption {
  id: AspectRatioMode;
  label: string;
  badge: string;
  desc: string;
}

export const ASPECT_RATIOS: AspectRatioOption[] = [
  {
    id: 'contain',
    label: 'Original Fit',
    badge: 'DEFAULT',
    desc: 'Native video ratio with cinema letterbox bars',
  },
  {
    id: 'cover',
    label: 'Cinema Fill',
    badge: 'NO BARS',
    desc: 'Zooms in to fill entire screen edge-to-edge',
  },
  {
    id: '16:9',
    label: '16:9 Widescreen',
    badge: 'HDTV',
    desc: 'Standard widescreen display ratio',
  },
  {
    id: '4:3',
    label: '4:3 Classic',
    badge: 'RETRO',
    desc: 'Classic television format with pillar bars',
  },
  {
    id: 'fill',
    label: 'Stretch to Window',
    badge: '100% FIT',
    desc: 'Stretches video to full dimensions without crop',
  },
];

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

const speedLabel = (rate: number) => (rate === 1 ? 'Normal' : `${rate}x`);

/** A labelled group of chips. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="px-1 text-[11px] font-semibold tracking-[0.12em] text-white/50 uppercase">
        {title}
      </h3>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </section>
  );
}

/** One selectable chip. */
function Chip({
  selected,
  onClick,
  children,
  title,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
        selected
          ? 'bg-accent text-accent-contrast shadow-sm ring-1 ring-accent/30 font-semibold'
          : 'bg-white/10 text-white/85 hover:bg-white/20'
      }`}
    >
      {selected && <Check className="size-3.5 stroke-[2.5]" aria-hidden="true" />}
      {children}
    </button>
  );
}

export function PlayerMenu({
  controller,
  activeTab = 'audio_subs',
  onTabChange,
  dubs = [],
  currentDubId = '',
  onSelectDub,
  releases = [],
  aspectRatio = 'contain',
  onAspectRatioChange,
  seasons = [],
  currentSeason = 1,
  currentEpisode = 1,
  onSelectEpisode,
}: {
  controller: PlayerController;
  activeTab?: PlayerMenuTab;
  onTabChange?: (tab: PlayerMenuTab) => void;
  dubs?: AudioTrackOption[];
  currentDubId?: string;
  onSelectDub?: (dub: AudioTrackOption) => void;
  releases?: Release[];
  aspectRatio?: AspectRatioMode;
  onAspectRatioChange?: (ratio: AspectRatioMode) => void;
  seasons?: Season[];
  currentSeason?: number;
  currentEpisode?: number;
  onSelectEpisode?: (season: number, episode: number) => void;
}) {
  const { state, tracks, quality, abr, activeHeight } = controller;
  const hasSeasons = seasons.length > 0;

  // Active provider dub
  const activeDub = dubs.find((d) => d.subject_id === currentDubId) ?? dubs[0];

  // Only audio tracks that actually carry a language or label
  const audioLabel = (track: (typeof tracks.audio)[number]) =>
    track.label || track.language || 'Track';

  const selectedTextId = tracks.text.find((t) => t.active)?.id ?? null;

  const subtitleLabel = (track: (typeof tracks.text)[number]) =>
    track.label || track.language || 'Subtitle';

  const selectedSeasonObj = seasons.find((s) => s.number === currentSeason) ?? seasons[0];

  return (
    <div className="w-[23.5rem] sm:w-[26rem] max-w-[calc(100vw-1.5rem)] space-y-4 rounded-2xl border border-white/10 bg-[#0b0b10]/95 p-4 text-white shadow-2xl backdrop-blur-md">
      {/* Tab Navigation Header */}
      <div className={`grid gap-1 border-b border-white/10 pb-3 ${hasSeasons ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {hasSeasons && (
          <button
            type="button"
            onClick={() => onTabChange?.('episodes')}
            className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg py-1.5 px-1 text-[11px] font-semibold transition ${
              activeTab === 'episodes'
                ? 'bg-accent text-accent-contrast shadow-sm'
                : 'text-white/70 hover:bg-white/10 hover:text-white'
            }`}
            title="Episodes Selection"
          >
            <ListVideo className="size-3.5 shrink-0" />
            <span className="truncate">Episodes</span>
          </button>
        )}

        <button
          type="button"
          onClick={() => onTabChange?.('audio_subs')}
          className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg py-1.5 px-1 text-[11px] font-semibold transition ${
            activeTab === 'audio_subs'
              ? 'bg-accent text-accent-contrast shadow-sm'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
          title="Audio & Subtitles"
        >
          <Languages className="size-3.5 shrink-0" />
          <span className="truncate">Audio</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange?.('quality')}
          className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg py-1.5 px-1 text-[11px] font-semibold transition ${
            activeTab === 'quality'
              ? 'bg-accent text-accent-contrast shadow-sm'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
          title="Quality & Resolution"
        >
          <Sliders className="size-3.5 shrink-0" />
          <span className="truncate">Quality</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange?.('aspect_ratio')}
          className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg py-1.5 px-1 text-[11px] font-semibold transition ${
            activeTab === 'aspect_ratio'
              ? 'bg-accent text-accent-contrast shadow-sm'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
          title="Display Aspect Ratio (Fit, Fill, 16:9, Stretch)"
        >
          <Monitor className="size-3.5 shrink-0" />
          <span className="truncate">Display</span>
        </button>

        <button
          type="button"
          onClick={() => onTabChange?.('settings')}
          className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg py-1.5 px-1 text-[11px] font-semibold transition ${
            activeTab === 'settings'
              ? 'bg-accent text-accent-contrast shadow-sm'
              : 'text-white/70 hover:bg-white/10 hover:text-white'
          }`}
          title="Speed & Shortcuts"
        >
          <Gauge className="size-3.5 shrink-0" />
          <span className="truncate">Speed</span>
        </button>
      </div>

      {/* Tab 0: Episodes (when available) */}
      {activeTab === 'episodes' && hasSeasons && selectedSeasonObj && (
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {seasons.length > 1 && (
            <Section title="Select Season">
              {seasons.map((s) => (
                <Chip
                  key={s.number}
                  selected={s.number === currentSeason}
                  onClick={() => {
                    const firstEp = s.episodes[0]?.number ?? 1;
                    onSelectEpisode?.(s.number, firstEp);
                  }}
                >
                  Season {s.number} ({s.episodes.length} Ep)
                </Chip>
              ))}
            </Section>
          )}

          <Section title={`Season ${currentSeason} Episodes (${selectedSeasonObj.episodes.length})`}>
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-1.5 w-full">
              {selectedSeasonObj.episodes.map((ep) => {
                const isActive = ep.number === currentEpisode;
                return (
                  <button
                    key={ep.number}
                    type="button"
                    onClick={() => onSelectEpisode?.(currentSeason, ep.number)}
                    className={`flex flex-col items-center justify-center rounded-xl p-2 text-center transition ${
                      isActive
                        ? 'bg-accent text-accent-contrast font-bold shadow-md ring-1 ring-accent/40'
                        : 'bg-white/10 text-white/85 hover:bg-white/20'
                    }`}
                    title={ep.title || `Episode ${ep.number}`}
                  >
                    <span className="text-[12px] font-bold">E{ep.number}</span>
                  </button>
                );
              })}
            </div>
          </Section>
        </div>
      )}

      {/* Tab 1: Audio & Subtitles */}
      {activeTab === 'audio_subs' && (
        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          {/* Provider Dubs (e.g. Hindi Dub, English, Original) */}
          {dubs.length > 0 && (
            <Section title="Audio Language / Dub">
              {dubs.map((dub, index) => {
                const isSelected = dub.subject_id === activeDub?.subject_id;
                return (
                  <Chip
                    key={`${dub.subject_id || index}:${dub.language}`}
                    selected={isSelected}
                    onClick={() => onSelectDub?.(dub)}
                  >
                    <Volume2 className="size-3 text-accent" />
                    <span>{dub.label || dub.language}</span>
                  </Chip>
                );
              })}
            </Section>
          )}

          {/* Shaka internal audio tracks */}
          {tracks.audio.length > 1 && (
            <Section title="Stream Audio Tracks">
              {tracks.audio.map((track) => (
                <Chip
                  key={track.id}
                  selected={track.active}
                  onClick={() => controller.selectAudio(track)}
                >
                  {audioLabel(track)}
                  {track.channelsCount ? ` · ${track.channelsCount}ch` : ''}
                </Chip>
              ))}
            </Section>
          )}

          {/* Subtitles */}
          <Section title="Subtitles">
            <Chip selected={selectedTextId === null} onClick={() => controller.selectText(null)}>
              Off
            </Chip>
            {tracks.text.map((track) => (
              <Chip
                key={track.id}
                selected={selectedTextId === track.id}
                onClick={() => controller.selectText(track)}
              >
                {subtitleLabel(track)}
              </Chip>
            ))}
            {tracks.text.length === 0 && (
              <span className="px-1 py-1.5 text-[12px] text-white/45">No subtitles available</span>
            )}
          </Section>
        </div>
      )}

      {/* Tab 2: Quality */}
      {activeTab === 'quality' && (
        <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
          <Section title="Resolution">
            <Chip selected={abr} onClick={() => controller.selectQuality(null)} title="Adaptive Bitrate">
              Auto {activeHeight ? `(${activeHeight}p)` : ''}
            </Chip>
            {quality.map((option) => (
              <Chip
                key={option.height}
                selected={!abr && activeHeight === option.height}
                onClick={() => controller.selectQuality(option.best)}
                title={option.count > 1 ? `${option.count} renditions` : undefined}
              >
                {variantLabel(option.best)}
              </Chip>
            ))}
          </Section>

          {quality.length === 0 && releases.length > 0 && (
            <div className="rounded-lg bg-white/5 p-3 text-[12px] text-white/70">
              <p className="font-semibold text-white">Stream Quality: Direct {activeHeight ? `${activeHeight}p` : 'Source'}</p>
              <p className="mt-1 text-white/50">
                Playing the highest quality direct stream available.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tab: Screen Display & Aspect Ratio */}
      {activeTab === 'aspect_ratio' && (
        <div className="space-y-3.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-white/50">
              Screen Scaling
            </span>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-bold text-accent tracking-wide">
              {aspectRatio.toUpperCase()}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {ASPECT_RATIOS.map((item) => {
              const isSelected = aspectRatio === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onAspectRatioChange?.(item.id)}
                  className={`group relative flex items-center justify-between rounded-xl p-3 text-left transition-all duration-150 cursor-pointer border ${
                    isSelected
                      ? 'border-accent/60 bg-gradient-to-r from-accent/20 via-accent/10 to-transparent shadow-lg shadow-accent/10 ring-1 ring-accent/30'
                      : 'border-white/5 bg-white/[0.03] hover:border-white/15 hover:bg-white/[0.07]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Visual aspect ratio wireframe preview box */}
                    <div
                      className={`relative flex size-9 shrink-0 items-center justify-center rounded-lg border transition ${
                        isSelected
                          ? 'border-accent/60 bg-accent/20 text-accent'
                          : 'border-white/15 bg-black/40 text-white/60 group-hover:border-white/25 group-hover:text-white'
                      }`}
                    >
                      {item.id === 'contain' && (
                        <div className="flex flex-col items-center justify-between h-4 w-6 rounded-[2px] border border-current p-[1px]">
                          <div className="h-[2px] w-full bg-black/60 rounded-[0.5px]" />
                          <div className="h-[5px] w-full bg-current opacity-80 rounded-[0.5px]" />
                          <div className="h-[2px] w-full bg-black/60 rounded-[0.5px]" />
                        </div>
                      )}
                      {item.id === 'cover' && (
                        <div className="h-4 w-6 rounded-[2px] border border-current bg-current opacity-85" />
                      )}
                      {item.id === '16:9' && (
                        <div className="flex items-center justify-center h-3.5 w-6 rounded-[2px] border border-current">
                          <span className="text-[7px] font-black leading-none tracking-tighter">16:9</span>
                        </div>
                      )}
                      {item.id === '4:3' && (
                        <div className="flex items-center justify-center h-4.5 w-5 rounded-[2px] border border-current">
                          <span className="text-[7px] font-black leading-none tracking-tighter">4:3</span>
                        </div>
                      )}
                      {item.id === 'fill' && (
                        <div className="flex items-center justify-center h-4 w-6 rounded-[2px] border border-dashed border-current">
                          <Scaling className="size-3 stroke-[2.5]" />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={`text-[13px] font-bold ${isSelected ? 'text-white' : 'text-white/90'}`}>
                          {item.label}
                        </p>
                        <span
                          className={`rounded px-1.5 py-0.2 text-[9.5px] font-bold tracking-wider uppercase ${
                            isSelected
                              ? 'bg-accent text-accent-contrast'
                              : 'bg-white/10 text-white/50 group-hover:text-white/70'
                          }`}
                        >
                          {item.badge}
                        </span>
                      </div>
                      <p
                        className={`text-[11px] leading-tight truncate mt-0.5 ${
                          isSelected ? 'text-white/75' : 'text-white/45 group-hover:text-white/60'
                        }`}
                      >
                        {item.desc}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 pl-2">
                    {isSelected ? (
                      <div className="flex size-5 items-center justify-center rounded-full bg-accent text-accent-contrast shadow-sm">
                        <Check className="size-3.5 stroke-[3]" />
                      </div>
                    ) : (
                      <div className="size-4 rounded-full border border-white/20 group-hover:border-white/40" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-2.5 flex items-center justify-between text-[11px] text-white/50">
            <span>Cycle Aspect Ratios quickly:</span>
            <kbd className="rounded border border-white/20 bg-black/70 px-2 py-0.5 font-mono text-[10px] font-semibold text-white shadow-inner">
              Press A
            </kbd>
          </div>
        </div>
      )}

      {/* Tab 4: Playback Speed & Shortcuts */}
      {activeTab === 'settings' && (
        <div className="space-y-4">
          <Section title="Playback speed">
            {SPEEDS.map((rate) => (
              <Chip
                key={rate}
                selected={Math.abs(state.playbackRate - rate) < 0.01}
                onClick={() => controller.setRate(rate)}
              >
                {speedLabel(rate)}
              </Chip>
            ))}
          </Section>

          <div className="border-t border-white/10 pt-3">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                Keyboard Shortcuts
              </span>
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-white/50">
                Quick Guide
              </span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-[11.5px]">
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Play / Pause</span>
                <div className="flex items-center gap-1">
                  <kbd className="min-w-5 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">Space</kbd>
                  <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">K</kbd>
                </div>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Seek ±10s</span>
                <div className="flex items-center gap-1">
                  <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">J</kbd>
                  <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">L</kbd>
                </div>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Volume</span>
                <div className="flex items-center gap-1">
                  <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">↑</kbd>
                  <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">↓</kbd>
                </div>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Fullscreen</span>
                <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">F</kbd>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Mute</span>
                <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">M</kbd>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">PiP</span>
                <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">P</kbd>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06]">
                <span className="text-white/70">Fill / Fit</span>
                <kbd className="min-w-4 text-center rounded border border-white/20 bg-black/60 px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">A</kbd>
              </div>
              <div className="flex items-center justify-between gap-1.5 rounded-lg bg-white/[0.04] px-2.5 py-1.5 border border-white/[0.06] col-span-2">
                <span className="text-white/70">Jump to %</span>
                <kbd className="rounded border border-white/20 bg-black/60 px-2 py-0.5 font-mono text-[10.5px] font-semibold text-white shadow-sm">0 – 9 (0% to 90%)</kbd>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
