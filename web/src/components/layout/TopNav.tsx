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

import { Clapperboard, Heart, History, Menu, Puzzle, Search, Settings, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';

import { SearchBar } from '@/components/layout/SearchBar';
import { useHomepageTabs } from '@/hooks/useCatalog';
import { paths } from '@/lib/routes';
import { useUiStore } from '@/store/ui';

/**
 * Header actions.
 */
const ACTIONS = [
  { to: paths.favorites(), label: 'Favorites', icon: Heart },
  { to: paths.history(), label: 'History', icon: History },
  { to: paths.addons(), label: 'Addons', icon: Puzzle },
  { to: paths.settings(), label: 'Settings', icon: Settings },
] as const;

export function TopNav() {
  const { data: tabs = [] } = useHomepageTabs();
  const location = useLocation();

  const navOpen = useUiStore((state) => state.navOpen);
  const setNavOpen = useUiStore((state) => state.setNavOpen);

  const [scrolled, setScrolled] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Collapse drawer and search on navigation.
  useEffect(() => {
    setNavOpen(false);
    setMobileSearchOpen(false);
  }, [location.pathname, setNavOpen]);

  const actions = ACTIONS;

  // Categorized navigation tabs: Hollywood (19), Bollywood (2), TV Series (5), Anime (8)
  const navTabs = (() => {
    const desired = [
      { id: '19', fallbackLabel: 'Hollywood' },
      { id: '2', fallbackLabel: 'Bollywood' },
      { id: '5', fallbackLabel: 'TV Series' },
      { id: '8', fallbackLabel: 'Anime' },
    ];
    return desired.map(({ id, fallbackLabel }) => {
      const found = tabs.find((t) => t.id === id);
      return {
        id,
        label: id === '19' ? 'Hollywood' : id === '2' ? 'Bollywood' : (found?.label ?? fallbackLabel),
        blurb: found?.blurb ?? '',
        mature: false,
      };
    });
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
          aria-label="NovaFlixZone home"
        >
          <span className="relative flex size-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent via-rose-500 to-amber-400 p-[1.5px] shadow-[0_0_24px_var(--accent)] transition duration-300 group-hover:shadow-[0_0_35px_var(--accent)]">
            <span className="flex size-full items-center justify-center rounded-[14px] bg-[#09090e]/90 backdrop-blur-md">
              <Clapperboard className="size-5 text-accent group-hover:scale-110 transition-transform duration-300" aria-hidden="true" />
            </span>
          </span>
          <div className="flex items-center gap-1.5">
            <span className="font-display text-[22px] font-black tracking-tight text-white drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]">
              NovaFlix<span className="text-accent">Zone</span>
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

        {/* Wide/tablet screen search bar */}
        <div className="hidden sm:block ml-auto w-full max-w-xs lg:max-w-sm">
          <SearchBar className="w-full" />
        </div>

        {/* Mobile search toggle button */}
        <button
          type="button"
          onClick={() => {
            setMobileSearchOpen(!mobileSearchOpen);
            if (navOpen) setNavOpen(false);
          }}
          aria-label={mobileSearchOpen ? 'Close search' : 'Open search'}
          className="ml-auto grid size-9 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-bg-hover hover:text-fg-default sm:hidden"
        >
          {mobileSearchOpen ? <X className="size-5 text-accent" /> : <Search className="size-5" />}
        </button>

        <div className="hidden shrink-0 items-center gap-0.5 md:flex">
          {actions.map(({ to, label, icon: Icon }) => (
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
          ))}
        </div>

        <button
          type="button"
          onClick={() => {
            setNavOpen(!navOpen);
            if (mobileSearchOpen) setMobileSearchOpen(false);
          }}
          aria-expanded={navOpen}
          aria-controls="nav-drawer"
          aria-label={navOpen ? 'Close menu' : 'Open menu'}
          className="grid size-9 shrink-0 place-items-center rounded-lg text-fg-muted transition hover:bg-bg-hover hover:text-fg-default lg:hidden"
        >
          {navOpen ? <X className="size-5" aria-hidden="true" /> : <Menu className="size-5" aria-hidden="true" />}
        </button>
      </div>

      {/* Expandable Mobile Search Bar */}
      {mobileSearchOpen && (
        <div className="border-t border-white/[0.08] bg-[#07070a]/95 px-4 py-3 backdrop-blur-2xl sm:hidden animate-fade-in shadow-xl">
          <SearchBar
            autoFocus
            className="w-full"
            onSearchSubmitted={() => setMobileSearchOpen(false)}
          />
        </div>
      )}

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
