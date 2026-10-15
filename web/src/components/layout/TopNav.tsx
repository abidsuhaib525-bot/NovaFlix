/**
 * Site header.
 *
 * A top navigation bar rather than a sidebar, to match the reference site. Three
 * rows, collapsing into one on narrow screens:
 *
 *   wide    [logo] [tabs] [search] [actions]
 *   narrow  [logo] [search] [menu]
 *
 * The tab links come from the server rather than a constant. Tab ids are an
 * undocumented upstream detail and an unknown id returns the default feed
 * instead of erroring, so a hardcoded copy in the client could rot invisibly.
 */

import { Check, Clapperboard, Download, Heart, Menu, Palette, Puzzle, Settings, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { SearchBar } from '@/components/layout/SearchBar';
import { useHomepageTabs } from '@/hooks/useCatalog';
import { formatBytes, formatSpeed } from '@/lib/format';
import { paths } from '@/lib/routes';
import { api } from '@/lib/api';
import { THEMES } from '@/lib/theme';
import { useUiStore } from '@/store/ui';

/**
 * How many tabs fit in the bar.
 *
 * The full list runs to ten and a bar that scrolls horizontally looks broken, so
 * the bar shows the first few and the home page's tab rail carries the rest. The
 * cut is a display decision only -- nothing is unreachable.
 */
const NAV_TABS = 4;

/** Header actions, always visible, never collapsed. */
/**
 * Header actions.
 *
 * `to` is a string rather than the `paths` function itself. A route builder is a
 * function, and passing one where a resolved path is expected is a mistake that
 * only shows up as a runtime navigation to the literal function's source -- the
 * types caught it here.
 */
const ACTIONS = [
  { to: paths.library(), label: 'Library', icon: Heart },
  { to: paths.downloads(), label: 'Downloads', icon: Download },
  { to: paths.addons(), label: 'Addons', icon: Puzzle },
  { to: paths.settings(), label: 'Settings', icon: Settings },
] as const;

export function TopNav() {
  const { data: tabs = [] } = useHomepageTabs();
  const location = useLocation();

  const navOpen = useUiStore((state) => state.navOpen);
  const setNavOpen = useUiStore((state) => state.setNavOpen);

  const [scrolled, setScrolled] = useState(false);

  /**
   * Whether the header has a frosted background.
   *
   * Driven by scroll rather than by a prop from the page, because the header
   * spans every route and only the scroll position is common to all of them.
   * `passive` because this fires on every frame of a scroll.
   */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Collapse the drawer on navigation. Without this it stays open over the page
  // the user just chose, hiding the result of their click.
  useEffect(() => setNavOpen(false), [location.pathname, setNavOpen]);

  const actions = ACTIONS;

  // Make sure Anime (id: '8') is included in the top navigation bar along with For You, Movies, TV Series
  const navTabs = (() => {
    const desired = ['1', '2', '5', '8']; // For You, Movies, TV Series, Anime
    const picked: typeof tabs = [];
    for (const id of desired) {
      const found = tabs.find((t) => t.id === id);
      if (found) picked.push(found);
    }
    // Fill remaining up to NAV_TABS + 1 if any desired was missing
    for (const t of tabs) {
      if (picked.length >= Math.max(NAV_TABS, 4)) break;
      if (!picked.some((p) => p.id === t.id)) picked.push(t);
    }
    return picked;
  })();

  return (
    <header
      className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
        scrolled || navOpen
          ? 'bg-[#07070a]/90 backdrop-blur-2xl border-b border-white/[0.08] shadow-[0_12px_36px_rgba(0,0,0,0.7)] py-2.5 sm:py-3'
          : 'bg-gradient-to-b from-black/90 via-black/50 to-transparent border-b border-transparent py-3.5 sm:py-4.5'
      }`}
    >
      <div className="mx-auto flex max-w-[1700px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link
          to={paths.home()}
          className="group flex shrink-0 items-center gap-3 transition transform hover:scale-[1.02]"
          aria-label="NovaFlix home"
        >
          <span className="relative flex size-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent via-rose-500 to-amber-400 p-[1.5px] shadow-[0_0_24px_var(--accent)] transition duration-300 group-hover:shadow-[0_0_35px_var(--accent)]">
            <span className="flex size-full items-center justify-center rounded-[14px] bg-[#09090e]/90 backdrop-blur-md">
              <Clapperboard className="size-5 text-accent group-hover:scale-110 transition-transform duration-300" aria-hidden="true" />
            </span>
          </span>
          <div className="flex items-center gap-1.5">
            <span className="font-display text-[22px] font-black tracking-tight text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
              Nova<span className="text-accent">Flix</span>
            </span>
            <span className="rounded-full bg-accent/20 border border-accent/40 px-2 py-0.5 text-[9.5px] font-black uppercase tracking-widest text-accent shadow-[0_0_12px_var(--accent-subtle)]">
              4K
            </span>
          </div>
        </Link>

        {/* Wide-screen tab links. */}
        <nav aria-label="Categories" className="hidden min-w-0 flex-1 items-center gap-1.5 lg:flex ml-3">
          <NavTab to={paths.home()} end>
            Home
          </NavTab>
          {navTabs.map((tab) => (
            <NavTab key={tab.id} to={paths.tab(tab.id)}>
              {tab.label}
            </NavTab>
          ))}
        </nav>

        <SearchBar className="ml-auto w-full max-w-xs lg:max-w-sm" />

        <div className="hidden shrink-0 items-center gap-0.5 md:flex">
          {actions.map(({ to, label, icon: Icon }) => {
            if (to === paths.downloads()) {
              return <DownloadHeaderAction key={to} to={to} label={label} />;
            }

            return (
              <NavLink
                key={to}
                to={to}
                title={label}
                aria-label={label}
                className={({ isActive }) =>
                  `grid size-9 place-items-center rounded-lg transition ${
                    isActive ? 'bg-bg-hover text-accent' : 'text-fg-muted hover:bg-bg-hover hover:text-fg-default'
                  }`
                }
              >
                <Icon className="size-4.5" aria-hidden="true" />
              </NavLink>
            );
          })}
          <ThemeQuickSwitcher />
        </div>

        <button
          type="button"
          onClick={() => setNavOpen(!navOpen)}
          aria-expanded={navOpen}
          aria-controls="nav-drawer"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          className="grid size-9 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-bg-hover hover:text-fg-default lg:hidden"
        >
          {navOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
        </button>
      </div>

      {/* Narrow-screen drawer. Rendered rather than hidden with CSS so it is out
          of the tab order when closed. */}
      {navOpen && (
        <div id="nav-drawer" className="glass animate-fade-in border-t border-border-subtle lg:hidden">
          <nav aria-label="Categories" className="mx-auto max-w-[1600px] px-4 py-3 sm:px-6">
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
              <DrawerTab to={paths.home()} end>
                Home
              </DrawerTab>
              {tabs.map((tab) => (
                <DrawerTab key={tab.id} to={paths.tab(tab.id)}>
                  {tab.label}
                </DrawerTab>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap gap-1 border-t border-border-subtle pt-3">
              {actions.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] transition ${
                      isActive
                        ? 'bg-bg-hover text-accent'
                        : 'text-fg-muted hover:bg-bg-hover hover:text-fg-default'
                    }`
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

function NavTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `relative whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-all duration-200 ${
          isActive
            ? 'bg-white/15 text-white shadow-sm ring-1 ring-white/20 font-bold backdrop-blur-md'
            : 'text-fg-muted hover:text-white hover:bg-white/[0.06]'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function DrawerTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `truncate rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition ${
          isActive ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:bg-bg-hover hover:text-fg-default'
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/**
 * Chrome-style Download Indicator & Header Action.
 * Shows animated glowing download badge, live progress ring, and real-time popover tray.
 */
function DownloadHeaderAction({ to, label }: { to: string; label: string }) {
  const activeDownload = useUiStore((state) => state.activeDownload);
  const clearDownloadAnimation = useUiStore((state) => state.clearDownloadAnimation);
  const [showTray, setShowTray] = useState(false);
  const [isBouncing, setIsBouncing] = useState(false);
  const [liveProgress, setLiveProgress] = useState<{
    percent: number;
    downloaded_bytes: number;
    total_bytes: number | null;
    speed_bps: number | null;
    state?: string;
  } | null>(null);

  const [activeTasks, setActiveTasks] = useState<Record<string, string>>({});

  // Trigger chrome-style bounce and popup when a new download starts
  useEffect(() => {
    if (!activeDownload) return;
    setIsBouncing(true);
    setShowTray(true);
    setLiveProgress(null);

    const bounceTimer = setTimeout(() => setIsBouncing(false), 2400);
    // Stay open longer if active so user can see real progress moving
    const trayTimer = setTimeout(() => {
      setShowTray(false);
      clearDownloadAnimation();
    }, 12000);

    return () => {
      clearTimeout(bounceTimer);
      clearTimeout(trayTimer);
    };
  }, [activeDownload, clearDownloadAnimation]);

  // Hook live SSE progress stream for real download metrics & multi-download count
  useEffect(() => {
    const stream = new EventSource(api.downloadsStreamUrl());
    const onProgress = (event: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(event.data);
        if (frame.id && frame.state) {
          setActiveTasks((prev) => {
            if (frame.state === 'running') {
              if (prev[frame.id] === 'running') return prev;
              return { ...prev, [frame.id]: frame.state };
            }
            if (['completed', 'failed', 'cancelled', 'paused'].includes(frame.state)) {
              if (!prev[frame.id]) return prev;
              const next = { ...prev };
              delete next[frame.id];
              return next;
            }
            return prev;
          });
        }

        // Match specific task or most recent live task
        if (activeDownload && (!activeDownload.id || frame.id === activeDownload.id)) {
          const rawPct = frame.progress ?? 0;
          setLiveProgress((prev) => {
            const nextPct = Math.max(prev?.percent ?? 0, Math.min(100, Math.round(rawPct)));
            return {
              percent: nextPct,
              downloaded_bytes: Math.max(prev?.downloaded_bytes ?? 0, frame.downloaded_bytes ?? 0),
              total_bytes: frame.total_bytes ?? prev?.total_bytes ?? null,
              speed_bps: frame.speed_bps ?? prev?.speed_bps ?? null,
              state: frame.state,
            };
          });
        }
      } catch {
        /* Ignore malformed SSE */
      }
    };

    stream.addEventListener('progress', onProgress);
    return () => stream.close();
  }, [activeDownload]);

  const runningCount = Object.keys(activeTasks).length;
  const hasActive = Boolean(activeDownload || runningCount > 0);
  const percent = liveProgress?.percent ?? 0;
  const isCompleted = liveProgress?.state === 'completed' || percent >= 100;

  return (
    <div className="relative">
      <NavLink
        to={to}
        title={label}
        aria-label={label}
        className={({ isActive }) =>
          `relative grid size-9 place-items-center rounded-lg transition ${
            isActive
              ? 'bg-bg-hover text-accent'
              : hasActive
              ? 'bg-accent/20 text-accent font-bold shadow-[0_0_15px_rgba(232,180,74,0.4)]'
              : 'text-fg-muted hover:bg-bg-hover hover:text-fg-default'
          } ${isBouncing ? 'animate-bounce text-accent scale-110' : ''}`
        }
      >
        <Download className={`size-4.5 transition-transform ${isBouncing ? 'translate-y-0.5' : ''}`} aria-hidden="true" />

        {/* Chrome-style active download pulse ring & count badge */}
        {hasActive && (
          <span className="absolute -top-1 -right-1 flex size-3.5 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-black text-black border border-bg-surface">
              {runningCount > 1 ? runningCount : ''}
            </span>
          </span>
        )}
      </NavLink>

      {/* Chrome-style Download Tray Popover with REAL live progress */}
      {showTray && activeDownload && (
        <div className="absolute right-0 top-full mt-2 w-80 rounded-2xl border border-white/20 bg-[#121218]/95 p-3.5 text-white shadow-2xl backdrop-blur-xl animate-fade-in z-50">
          <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
            <div className="flex items-center gap-1.5 text-[12px] font-bold text-accent">
              <Download className={`size-3.5 ${isCompleted ? 'text-emerald-400' : 'animate-bounce'}`} />
              <span className={isCompleted ? 'text-emerald-400' : 'text-accent'}>
                {isCompleted ? 'Download Complete!' : 'Downloading File...'}
              </span>
              {runningCount > 1 && (
                <span className="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[9.5px] font-normal text-white/60">
                  +{runningCount - 1} other
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setShowTray(false);
                clearDownloadAnimation();
              }}
              className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="mt-3">
            <p className="truncate text-[13px] font-semibold text-white/90">
              {activeDownload.title}
            </p>

            <div className="mt-1 flex items-center justify-between text-[11px] text-white/60">
              <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-bold text-accent uppercase">
                {activeDownload.format}
              </span>
              {liveProgress?.speed_bps ? (
                <span className="text-[10.5px] text-accent font-medium">
                  {formatSpeed(liveProgress.speed_bps)}
                </span>
              ) : (
                <span className="text-[10px] text-emerald-400 font-medium">Downloading</span>
              )}
            </div>

            {/* REAL Chrome-style progress line bar */}
            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>

            {/* Real Numbers & Percentage Display */}
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-white/60 font-medium">
              <span>{percent}%</span>
              <span>
                {liveProgress?.total_bytes
                  ? `${formatBytes(liveProgress.downloaded_bytes)} / ${formatBytes(liveProgress.total_bytes)}`
                  : liveProgress?.downloaded_bytes
                  ? `${formatBytes(liveProgress.downloaded_bytes)} downloaded`
                  : 'Starting...'}
              </span>
            </div>

            <Link
              to={paths.downloads()}
              onClick={() => setShowTray(false)}
              className="mt-3 block text-center rounded-xl bg-white/10 py-2 text-[11.5px] font-semibold text-accent transition hover:bg-accent hover:text-accent-contrast shadow-sm"
            >
              View in Downloads &rarr;
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function ThemeQuickSwitcher() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const themeId = useUiStore((s) => s.themeId);
  const setTheme = useUiStore((s) => s.setTheme);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        title="Change Theme Palette"
        aria-label="Change Theme Palette"
        aria-expanded={open}
        className={`grid size-9 place-items-center rounded-lg transition cursor-pointer ${
          open
            ? 'bg-accent/20 text-accent shadow-[0_0_12px_rgba(245,166,35,0.3)] ring-1 ring-accent/40'
            : 'text-fg-muted hover:bg-bg-hover hover:text-fg-default'
        }`}
      >
        <Palette className="size-4.5" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-64 rounded-2xl border border-white/15 bg-[#121218]/95 p-2 shadow-2xl backdrop-blur-xl animate-scale-in">
          <div className="mb-2 flex items-center justify-between border-b border-white/10 px-2.5 pb-2 pt-1">
            <span className="text-[12px] font-bold uppercase tracking-wider text-white/90">
              Select Theme
            </span>
            <span className="text-[10px] text-accent font-semibold uppercase">
              {THEMES.find((t) => t.id === themeId)?.label.split(' ')[0] ?? 'Custom'}
            </span>
          </div>

          <div className="max-h-72 overflow-y-auto space-y-1 pr-0.5">
            {THEMES.map((theme) => {
              const active = theme.id === themeId;
              return (
                <button
                  key={theme.id}
                  type="button"
                  onClick={() => {
                    setTheme(theme.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[12.5px] transition-all cursor-pointer ${
                    active
                      ? 'bg-white/10 font-bold text-white ring-1 ring-white/20 shadow-sm'
                      : 'text-fg-muted hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {/* Swatch dots */}
                    <div className="flex -space-x-1">
                      <span
                        className="inline-block size-3.5 rounded-full border border-black/40 shadow-xs"
                        style={{ backgroundColor: theme.swatch[0] }}
                      />
                      <span
                        className="inline-block size-3.5 rounded-full border border-black/40 shadow-xs"
                        style={{ backgroundColor: theme.swatch[1] }}
                      />
                      <span
                        className="inline-block size-3.5 rounded-full border border-black/40 shadow-xs"
                        style={{ backgroundColor: theme.swatch[2] }}
                      />
                    </div>
                    <span>{theme.label}</span>
                  </div>

                  {active && <Check className="size-3.5 text-accent" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}