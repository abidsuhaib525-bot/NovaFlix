/**
 * The router and the page frame.
 *
 * One `QueryClientProvider` above everything, so a navigation never remounts the
 * cache. Routes are lazy except the home page: the home page is the entry point
 * for almost every visit, so deferring it would trade the first meaningful paint
 * for nothing. Everything else is loaded on demand.
 */

import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { Toaster } from '@/components/common/Toaster';
import { ErrorState, SkeletonRail } from '@/components/common/StateBlocks';
import { Footer } from '@/components/layout/Footer';
import { MobileBottomNav } from '@/components/layout/MobileBottomNav';
import { TopNav } from '@/components/layout/TopNav';
import { NotFoundPage } from '@/pages/NotFoundPage';
const HomePage = lazy(() => import('@/pages/HomePage').then((m) => ({ default: m.HomePage })));
const TabPage = lazy(() => import('@/pages/TabPage').then((m) => ({ default: m.TabPage })));
const SearchPage = lazy(() => import('@/pages/SearchPage').then((m) => ({ default: m.SearchPage })));
const DetailsPage = lazy(() =>
  import('@/pages/DetailsPage').then((m) => ({ default: m.DetailsPage })),
);
const WatchPage = lazy(() => import('@/pages/WatchPage').then((m) => ({ default: m.WatchPage })));
const FavoritesPage = lazy(() =>
  import('@/pages/FavoritesPage').then((m) => ({ default: m.FavoritesPage })),
);
const HistoryPage = lazy(() =>
  import('@/pages/HistoryPage').then((m) => ({ default: m.HistoryPage })),
);
const AddonsPage = lazy(() => import('@/pages/AddonsPage').then((m) => ({ default: m.AddonsPage })));
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

export function App() {
  const location = useLocation();
  const isWatch = location.pathname.startsWith('/watch');
  const isHeroPage = location.pathname === '/' || location.pathname.startsWith('/title/');

  // Guaranteed audio silencing: stop, mute, and unload all video elements when leaving watch page
  useEffect(() => {
    if (!isWatch) {
      const videos = document.querySelectorAll('video');
      videos.forEach((v) => {
        try {
          v.pause();
          v.muted = true;
          v.currentTime = 0;
          v.srcObject = null;
          v.removeAttribute('src');
          v.load();
        } catch {
          /* ignore */
        }
      });
    }
  }, [isWatch, location.pathname]);

  return (
    <div className={`relative flex flex-col ${isWatch ? 'h-dvh w-screen overflow-hidden bg-black' : 'min-h-dvh bg-bg-base'}`}>
      {/* Ambient Cinema Lighting Mesh Backdrop */}
      {!isWatch && (
        <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden select-none" aria-hidden="true">
          {/* Top spotlight glow that illuminates header and hero */}
          <div className="absolute -top-[140px] left-1/2 -translate-x-1/2 h-[550px] w-[1100px] rounded-full bg-gradient-to-b from-accent/18 via-purple-600/10 to-transparent blur-[130px] opacity-90" />
          {/* Left subtle colored aurora bloom */}
          <div className="absolute top-[35%] -left-[200px] h-[500px] w-[500px] rounded-full bg-blue-600/6 blur-[150px]" />
          {/* Right subtle ambient glow */}
          <div className="absolute top-[65%] -right-[200px] h-[550px] w-[550px] rounded-full bg-accent/8 blur-[160px]" />
          {/* Cinematic subtle vignette overlay */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.5)_100%)]" />
        </div>
      )}

      {/* First tab stop on the page. Announced by screen readers, invisible
          otherwise. Needed because the header is full of links and there is
          nothing above it to reach them by. */}
      {!isWatch && (
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-accent-contrast"
        >
          Skip to content
        </a>
      )}

      {!isWatch && <TopNav />}

      <main
        id="main"
        className={
          isWatch
            ? 'h-full w-full flex-1 overflow-hidden bg-black'
            : isHeroPage
            ? 'flex-1 pb-20 md:pb-0'
            : 'flex-1 pt-20 sm:pt-24 pb-20 md:pb-0'
        }
      >
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />

            {/* `:tabId?` optional so `/tab` renders a message rather than the
                404 page -- it is a plausible thing to type. */}
            <Route path="/tab" element={<TabPage />} />
            <Route path="/tab/:tabId" element={<TabPage />} />

            <Route path="/search" element={<SearchPage />} />

            {/* The id may contain anything, including slashes and unicode, so it
                is matched to the end of the path rather than one segment. */}
            <Route
              path="/title/:provider/:id/*"
              element={
                <ErrorBoundary fallbackTitle="Could not load title details">
                  <DetailsPage />
                </ErrorBoundary>
              }
            />
            <Route
              path="/watch/:provider/:id/*"
              element={
                <ErrorBoundary fallbackTitle="Player encountered an issue">
                  <WatchPage />
                </ErrorBoundary>
              }
            />

            <Route path="/favorites" element={<FavoritesPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/library" element={<FavoritesPage />} />
            <Route path="/downloads" element={<Navigate to="/" replace />} />
            <Route path="/addons" element={<AddonsPage />} />
            <Route path="/settings" element={<SettingsPage />} />

            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </main>

      {!isWatch && <Footer />}
      {!isWatch && <MobileBottomNav />}
      <Toaster />
    </div>
  );
}

/**
 * Route-aware fallback to prevent layout flash on page refresh or navigation.
 */
function RouteFallback() {
  const location = useLocation();
  const path = location.pathname;

  if (path.startsWith('/watch')) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-black">
        <div className="relative flex size-16 items-center justify-center sm:size-20">
          <div className="size-full rounded-full border-4 border-white/10 border-t-accent animate-spin" />
          <div className="absolute size-4 rounded-full bg-accent/40 animate-ping" />
        </div>
      </div>
    );
  }

  if (path.startsWith('/title')) {
    return (
      <div className="relative isolate mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6 md:pt-10 lg:px-8">
        <div className="flex flex-col gap-7 lg:flex-row lg:gap-10">
          <div className="skeleton h-[280px] w-[180px] shrink-0 rounded-2xl sm:h-[340px] sm:w-[230px]" />
          <div className="flex-1 space-y-4">
            <div className="skeleton h-10 w-2/3 rounded-lg" />
            <div className="skeleton h-4 w-48 rounded" />
            <div className="skeleton mt-6 h-12 w-48 rounded-full" />
            <div className="skeleton mt-6 h-28 w-full rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (path === '/' || path.startsWith('/tab')) {
    return (
      <div className="mx-auto max-w-[1600px] px-4 pt-8 sm:px-6 lg:px-8">
        <SkeletonRail />
        <SkeletonRail />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] px-4 pt-8 sm:px-6 lg:px-8">
      <div className="skeleton mb-6 h-10 w-48 rounded-xl" />
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="skeleton aspect-[2/3] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * An app-level failure.
 *
 * Mounted around the routes rather than inside any one page, so an error thrown
 * during render -- a bad chunk, a provider shape this build does not understand --
 * shows a recoverable message instead of a blank white page. A localhost app has
 * no crash reporter, so this is the only signal anything is wrong.
 */
export class AppErrorBoundary extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppErrorBoundary';
  }
}

export { ErrorState };