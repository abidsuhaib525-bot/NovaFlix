/**
 * Site footer.
 *
 * Small, but it does two jobs a layout without one cannot: it stops the last
 * rail from ending flush against the bottom of the window, and it carries the
 * server version, which is the first thing anyone asks for when reporting a
 * problem with a locally-served app.
 */

import { Clapperboard } from 'lucide-react';
import { Link } from 'react-router-dom';

import { useHealth } from '@/hooks/useCatalog';
import { paths } from '@/lib/routes';

export function Footer() {
  const { data: health } = useHealth();

  return (
    <footer className="mt-24 border-t border-white/[0.08] bg-[#07070a]/80 backdrop-blur-md">
      <div className="mx-auto max-w-[1600px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="space-y-3 md:col-span-2">
            <div className="flex items-center gap-2.5">
              <span className="grid size-8 place-items-center rounded-xl bg-accent/20 border border-accent/40 text-accent">
                <Clapperboard className="size-4" aria-hidden="true" />
              </span>
              <span className="font-display text-[20px] font-black tracking-tight text-white">
                Nova<span className="text-accent">Flix</span>
              </span>
              <span className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[11px] font-medium text-white/60">
                v{health?.version ?? '2.0'}
              </span>
            </div>
            <p className="max-w-md text-[13px] leading-relaxed text-fg-muted">
              Experience the ultimate cinematic universe. Stream and download top trending movies, binge-worthy TV series, and legendary anime in ultra-high fidelity 4K UHD.
            </p>
          </div>

          <div>
            <h4 className="mb-3 text-[12px] font-bold uppercase tracking-wider text-white/80">Navigation</h4>
            <ul className="space-y-2 text-[13px]">
              <li><Link to={paths.home()} className="text-fg-subtle hover:text-accent transition">Home</Link></li>
              <li><Link to={paths.tab('2')} className="text-fg-subtle hover:text-accent transition">Movies</Link></li>
              <li><Link to={paths.tab('5')} className="text-fg-subtle hover:text-accent transition">TV Series</Link></li>
              <li><Link to={paths.tab('8')} className="text-fg-subtle hover:text-accent transition">Anime</Link></li>
            </ul>
          </div>

          <div>
            <h4 className="mb-3 text-[12px] font-bold uppercase tracking-wider text-white/80">Features</h4>
            <ul className="space-y-2 text-[13px]">
              <li><Link to={paths.downloads()} className="text-fg-subtle hover:text-accent transition">Downloads & Offline</Link></li>
              <li><Link to={paths.library()} className="text-fg-subtle hover:text-accent transition">My Watchlist</Link></li>
              <li><Link to={paths.tv()} className="text-fg-subtle hover:text-accent transition">Live TV Channels</Link></li>
              <li><Link to={paths.settings()} className="text-fg-subtle hover:text-accent transition">Settings & Themes</Link></li>
            </ul>
          </div>
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/[0.06] pt-6 sm:flex-row text-[12px] text-fg-subtle">
          <p>&copy; {new Date().getFullYear()} NovaFlix. All rights reserved.</p>
          <p className="text-[11.5px] opacity-70">
            Powered by high-performance local streaming engine.
          </p>
        </div>
      </div>
    </footer>
  );
}