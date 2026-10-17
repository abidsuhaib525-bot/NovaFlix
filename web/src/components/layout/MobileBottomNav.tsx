import { Film, Heart, Home, Search, Sparkles } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { paths } from '@/lib/routes';

const NAV_ITEMS = [
  { to: paths.home(), label: 'Home', icon: Home, end: true },
  { to: paths.tab('19'), label: 'Hollywood', icon: Film, end: false },
  { to: paths.tab('2'), label: 'Bollywood', icon: Sparkles, end: false },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: paths.favorites(), label: 'Saved', icon: Heart, end: false },
];

export function MobileBottomNav() {
  return (
    <nav
      aria-label="Mobile Bottom Navigation"
      className="fixed bottom-0 inset-x-0 z-40 flex h-16 items-center justify-around border-t border-white/[0.08] bg-[#07070a]/92 px-2 pb-[env(safe-area-inset-bottom,0px)] backdrop-blur-2xl shadow-[0_-8px_30px_rgba(0,0,0,0.8)] md:hidden select-none"
    >
      {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center justify-center py-1 transition-all duration-200 active:scale-95 ${
              isActive
                ? 'text-accent font-semibold'
                : 'text-fg-subtle hover:text-white'
            }`
          }
        >
          {({ isActive }) => (
            <>
              <div
                className={`relative flex items-center justify-center rounded-xl p-1 transition-all ${
                  isActive ? 'bg-accent/15 text-accent shadow-[0_0_12px_var(--accent-subtle)]' : ''
                }`}
              >
                <Icon className={`size-5 transition-transform ${isActive ? 'scale-110' : ''}`} aria-hidden="true" />
              </div>
              <span
                className={`text-[10.5px] tracking-tight mt-0.5 transition-all ${
                  isActive ? 'font-bold text-accent' : 'font-normal opacity-80'
                }`}
              >
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
