/**
 * UI state that is not server state.
 *
 * Anything that comes from the backend lives in TanStack Query
 * (`hooks/useCatalog.ts`); anything here is owned by this browser session only.
 * The one overlap is the theme, which is stored in both places on purpose --
 * see `setTheme`.
 */

import { create } from 'zustand';

import { DEFAULT_THEME, applyTheme, isKnownTheme } from '@/lib/theme';

const THEME_KEY = 'moviebox.theme';

/**
 * The theme to start with.
 *
 * Read from `localStorage` rather than the server because the server round-trip
 * would show the wrong colours for the first few frames on every load. The
 * stored value is the one the user last picked locally; `useSettings` reconciles
 * a server value that disagrees, but only once it arrives.
 */
function storedTheme(): string {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return isKnownTheme(value) ? (value as string) : DEFAULT_THEME;
  } catch {
    // Private mode, or a browser with storage disabled. The default theme is a
    // perfectly good outcome.
    return DEFAULT_THEME;
  }
}

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

/** Monotonic id source. Never reset, so a re-render cannot reuse an id. */
let nextToastId = 1;

export interface ActiveDownloadEvent {
  id?: string;
  title: string;
  format: string;
  timestamp: number;
}

interface UiState {
  /** The `data-theme` currently on `<html>`. */
  themeId: string;
  /** Whether the collapsed nav drawer is open. Only meaningful below `md`. */
  navOpen: boolean;
  toasts: Toast[];
  activeDownload: ActiveDownloadEvent | null;

  setTheme: (id: string) => void;
  setNavOpen: (open: boolean) => void;
  notify: (kind: ToastKind, message: string) => void;
  dismiss: (id: number) => void;
  triggerDownloadAnimation: (title: string, format: string, id?: string) => void;
  clearDownloadAnimation: () => void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  themeId: storedTheme(),
  navOpen: false,
  toasts: [],
  activeDownload: null,

  setTheme: (id) => {
    const theme = isKnownTheme(id) ? id : DEFAULT_THEME;
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* Non-fatal: the theme still applies for this session. */
    }
    set({ themeId: theme });
  },

  setNavOpen: (navOpen) => set({ navOpen }),

  notify: (kind, message) => {
    // Read the current list rather than closing over it: two failures in the same
    // tick must queue both, and a stale closure would drop the second.
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { id, kind, message }] });
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  triggerDownloadAnimation: (title, format, id) => {
    set({
      activeDownload: {
        id,
        title,
        format,
        timestamp: Date.now(),
      },
    });
  },

  clearDownloadAnimation: () => set({ activeDownload: null }),
}));

/**
 * Report an error as a toast, if it is worth one.
 *
 * Rejects values with no message. A bare `new Error()` or a rejected promise
 * carrying `undefined` would otherwise put an empty bar on screen, which tells
 * the user less than showing nothing.
 */
export function notifyError(error: unknown): void {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = message.trim();
  if (text) useUiStore.getState().notify('error', text);
}