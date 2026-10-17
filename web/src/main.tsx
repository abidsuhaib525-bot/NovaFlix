/**
 * Entry point.
 *
 * Four things happen here and nowhere else: the stylesheet is imported, the query
 * client is installed, the router is mounted, and the stored theme is applied
 * before React paints.
 *
 * The order of the last one matters. `applyTheme` runs as a plain function call
 * before `createRoot(...).render(...)`, so the first frame already has the right
 * palette. Doing it inside a `useEffect` would paint the default theme and then
 * swap, which reads as a flash of the wrong colours on every single load.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';

import { App } from '@/App';
import { ErrorBoundary } from '@/components/common/ErrorBoundary';
import { queryClient } from '@/lib/queryClient';
import { applyTheme } from '@/lib/theme';
import { useUiStore } from '@/store/ui';

import './index.css';

// Applied before the first render, not inside a component.
if (window.self === window.top) {
  applyTheme(useUiStore.getState().themeId);

  const container = document.getElementById('root');

  if (!container) {
    // A hard failure with a clear cause beats a silent blank page. The only way
    // this happens is a build/index.html mismatch.
    throw new Error('NovaFlixZone: #root is missing from index.html');
  }

  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary fallbackTitle="NovaFlixZone encountered an unexpected error">
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  );
}