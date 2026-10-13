/**
 * The custom control bar.
 *
 * Netflix-shaped, not a native `<video controls>`: a scrub bar with a buffered
 * track and a hover preview, a centred transport cluster, an expanding volume
 * control, and the option buttons on the right. Everything is driven through
 * [`PlayerController`], so the bar never touches the element or the player
 * directly.
 *
 * The bar is always mounted and hidden by opacity, so the auto-hide timer never
 * has to re-create DOM and the scrub position survives a hide/show.
 */

import {
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Scaling,
  Settings2,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useRef, useState } from 'react';

import { formatDuration } from '@/lib/format';

import type { AspectRatioMode, PlayerMenuTab } from './PlayerMenu';
import type { PlayerController } from './usePlayerState';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Volume icon that matches the level, so the button reads at a glance. */
function volumeIcon(volume: number, muted: boolean) {
  if (muted || volume === 0) return VolumeX;
  if (volume < 0.5) return Volume1;
  return Volume2;
}

/** Buffered ranges plus the played position, as fractional widths. */
function BarOverlays({
  duration,
  buffered,
  playedFraction,
}: {
  duration: number;
  buffered: Array<[number, number]>;
  playedFraction: number;
}) {
  return (
    <>
      {buffered.map(([start, end], index) => (
        <span
          key={index}
          className="absolute inset-y-0 rounded-full bg-white/25"
          style={{
            left: `${(start / duration) * 100}%`,
            width: `${((end - start) / duration) * 100}%`,
          }}
        />
      ))}
      <span
        className="absolute inset-y-0 left-0 rounded-full"
        style={{ width: `${playedFraction * 100}%`, background: 'var(--accent)' }}
      />
    </>
  );
}

function ScrubBar({ controller }: { controller: PlayerController }) {
  const { currentTime, duration, buffered } = controller.state;
  const barRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState<number | null>(null);

  const fractionAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((clientX - rect.left) / rect.width, 0, 1);
  };

  const seekToFraction = (fraction: number) => {
    if (duration > 0) controller.seekTo(fraction * duration);
  };

  const played = duration > 0 ? clamp(currentTime / duration, 0, 1) : 0;
  const marker = hover ?? (dragging ? currentTime : null);

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      className="group/bar relative -mx-1 flex h-4 cursor-pointer touch-none items-center px-1"
      onPointerDown={(event) => {
        if (duration <= 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        const fraction = fractionAt(event.clientX);
        setHover(fraction * duration);
        seekToFraction(fraction);
      }}
      onPointerMove={(event) => {
        const fraction = fractionAt(event.clientX);
        setHover(fraction * duration);
        if (dragging) seekToFraction(fraction);
      }}
      onPointerUp={(event) => {
        if (dragging) seekToFraction(fractionAt(event.clientX));
        setDragging(false);
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerLeave={() => {
        if (!dragging) setHover(null);
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') controller.seekBy(-10);
        else if (event.key === 'ArrowRight') controller.seekBy(10);
        else return;
        event.preventDefault();
      }}
    >
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-white/20 transition-[height] group-hover/bar:h-2">
        <BarOverlays duration={duration || 1} buffered={buffered} playedFraction={played} />
      </div>
      {/* The handle sits outside the clipped track so it is not cut off. */}
      <span
        className="pointer-events-none absolute top-1/2 size-3.5 -translate-y-1/2 rounded-full opacity-0 shadow transition-opacity group-hover/bar:opacity-100"
        style={{ left: `calc(${played * 100}% - 0.4375rem)`, background: 'var(--accent)' }}
      />
      {marker !== null && duration > 0 && (
        <span
          className="pointer-events-none absolute -top-8 -translate-x-1/2 rounded-md bg-black/85 px-2 py-1 text-[11px] font-medium tabular-nums text-white"
          style={{ left: `${clamp(marker / duration, 0, 1) * 100}%` }}
        >
          {formatDuration(marker)}
        </span>
      )}
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
  badge,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  badge?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="relative inline-flex size-9 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 hover:text-white"
    >
      {children}
      {badge && (
        <span className="absolute -bottom-0.5 rounded bg-black/60 px-1 text-[9px] font-semibold tabular-nums text-white/90">
          {badge}
        </span>
      )}
    </button>
  );
}

export function PlayerControls({
  controller,
  visible,
  activeMenu,
  onToggleMenu,
  hasEpisodes,
  onToggleEpisodes,
  showNext,
  onNext,
  aspectRatio = 'contain',
  onCycleAspectRatio,
}: {
  controller: PlayerController;
  /** Controls hide after inactivity while playing. */
  visible: boolean;
  activeMenu: PlayerMenuTab | null;
  onToggleMenu: (menu: PlayerMenuTab) => void;
  hasEpisodes: boolean;
  onToggleEpisodes: () => void;
  /** Near the end of an episode with another one queued. */
  showNext: boolean;
  onNext: () => void;
  aspectRatio?: AspectRatioMode;
  onCycleAspectRatio?: () => void;
}) {
  const { state } = controller;
  const VolumeIcon = volumeIcon(state.volume, state.muted);
  const playing = !state.paused && !state.ended;

  const qualityBadge = controller.abr
    ? controller.activeHeight
      ? `${controller.activeHeight}p Auto`
      : 'Auto'
    : `${controller.activeHeight ?? 'HD'}p`;

  return (
    <div
      className={`pointer-events-none absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pt-10 pb-3 transition-opacity duration-300 sm:px-5 sm:pb-4 ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
    >
      <div className="pointer-events-auto space-y-1" data-player-chrome>
        <ScrubBar controller={controller} />

        <div className="flex items-center gap-0.5 sm:gap-1">
          <IconButton label={playing ? 'Pause' : 'Play'} onClick={controller.togglePlay}>
            {playing ? (
              <Pause className="size-6 fill-current" />
            ) : (
              <Play className="size-6 fill-current" />
            )}
          </IconButton>

          <IconButton label="Skip back 10 seconds" onClick={() => controller.seekBy(-10)}>
            <RotateCcw className="size-5" />
          </IconButton>
          <IconButton label="Skip forward 10 seconds" onClick={() => controller.seekBy(10)}>
            <RotateCw className="size-5" />
          </IconButton>

          {/* Volume: icon plus a slider that reveals on hover/focus. */}
          <div className="group/vol flex items-center">
            <IconButton
              label={state.muted ? 'Unmute' : 'Mute'}
              onClick={controller.toggleMute}
            >
              <VolumeIcon className="size-5" />
            </IconButton>
            <input
              type="range"
              min={0}
              max={1}
              step={0.02}
              aria-label="Volume"
              value={state.muted ? 0 : state.volume}
              onChange={(event) => controller.setVolume(Number(event.target.value))}
              className="h-1 w-0 cursor-pointer opacity-0 transition-all duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 focus:w-20 focus:opacity-100 sm:group-hover/vol:w-24"
              style={{ accentColor: 'var(--accent)' }}
            />
          </div>

          <span className="ml-1.5 text-[12.5px] font-medium tabular-nums text-white/85">
            {formatDuration(state.currentTime)}
            <span className="text-white/45"> / {formatDuration(state.duration)}</span>
          </span>

          <div className="flex-1" />

          {showNext && (
            <button
              type="button"
              onClick={onNext}
              className="mr-1 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-white/25"
            >
              <SkipForward className="size-4" />
              Next
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              const speeds = [1, 1.25, 1.5, 2, 0.75];
              const currIdx = speeds.indexOf(state.playbackRate);
              const nextSpeed = speeds[(currIdx + 1) % speeds.length] ?? 1;
              controller.setRate(nextSpeed);
            }}
            title="Click to change playback speed"
            className={`inline-flex cursor-pointer items-center rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums transition border ${
              state.playbackRate !== 1
                ? 'bg-accent/20 border-accent/40 text-accent'
                : 'bg-white/10 border-white/10 text-white/80 hover:bg-white/20 hover:text-white'
            }`}
          >
            {state.playbackRate}x
          </button>

          {hasEpisodes && (
            <IconButton label="Episodes" onClick={onToggleEpisodes}>
              <ListVideo className="size-5" />
            </IconButton>
          )}

          {/* Display & Screen Aspect Ratio Quick Toggle & Menu */}
          <IconButton
            label={`Display (${aspectRatio.toUpperCase()})`}
            onClick={() => {
              if (onCycleAspectRatio) onCycleAspectRatio();
              else onToggleMenu('aspect_ratio');
            }}
          >
            <Scaling className={`size-5 ${aspectRatio !== 'contain' ? 'text-accent' : ''}`} />
          </IconButton>

          {/* Unified Settings Icon (Quality, Audio, Dubs, Subs, Speed, Shortcuts) */}
          <IconButton
            label={`Settings · ${qualityBadge}`}
            onClick={() => onToggleMenu(activeMenu ? activeMenu : 'quality')}
          >
            <Settings2 className={`size-5 ${activeMenu ? 'text-accent' : ''}`} />
          </IconButton>

          <IconButton label="Picture in picture" onClick={controller.togglePip}>
            <PictureInPicture2 className="size-5" />
          </IconButton>

          <IconButton
            label={controller.fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            onClick={controller.toggleFullscreen}
          >
            {controller.fullscreen ? (
              <Minimize className="size-5" />
            ) : (
              <Maximize className="size-5" />
            )}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
