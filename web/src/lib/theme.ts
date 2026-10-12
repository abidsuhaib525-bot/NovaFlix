/**
 * Theme registry.
 *
 * The nine palettes are ported from the TUI's `theme.rs` and defined as CSS
 * custom properties in `index.css`. This module owns only the metadata -- names,
 * swatches for the picker -- and the mechanism for swapping `data-theme` on
 * `<html>`.
 *
 * Why CSS variables rather than a JS theme object: swapping a theme is one
 * attribute write and the browser repaints without React re-rendering a single
 * component. A context-driven theme would re-run every `useTheme()` consumer.
 */

/** A palette as offered in the settings picker. */
export interface Theme {
  /** The `data-theme` value. Also what the backend stores in settings. */
  readonly id: string;
  readonly label: string;
  /**
   * Three swatches: background, surface, accent.
   *
   * Hardcoded here rather than read back from the CSS custom properties. Reading
   * them would need a mounted element and a forced style recalculation, and the
   * picker renders server-provided metadata too, where no DOM exists yet.
   */
  readonly swatch: readonly [string, string, string];
}

/**
 * Display order: the dark cinematic palettes first, light last.
 *
 * Matches the order they appear in the picker's grouped list, and puts the
 * default (`noir`) at the top where it belongs for a streaming app.
 */
export const THEMES: readonly Theme[] = [
  { id: 'cinema-red', label: 'Cinema Red (Netflix)', swatch: ['#08080c', '#14141d', '#e50914'] },
  { id: 'cyber-gold', label: 'Midnight Gold', swatch: ['#08090d', '#131520', '#ffb703'] },
  { id: 'hbo-purple', label: 'Neon Violet (HBO)', swatch: ['#0a0812', '#161324', '#a855f7'] },
  { id: 'noir', label: 'Noir Minimal', swatch: ['#08080b', '#17171f', '#e8b44a'] },
  { id: 'tokyonight', label: 'Tokyo Night', swatch: ['#1a1b26', '#292e42', '#7aa2f7'] },
  { id: 'catppuccin', label: 'Catppuccin', swatch: ['#1e1e2e', '#313244', '#f5c2e7'] },
  { id: 'nord', label: 'Nord Glacier', swatch: ['#2e3440', '#434c5e', '#88c0d0'] },
  { id: 'dracula', label: 'Dracula', swatch: ['#282a36', '#44475a', '#bd93f9'] },
  { id: 'mocha', label: 'Mocha', swatch: ['#1e1e2e', '#313244', '#cba6f7'] },
  { id: 'rose-pine', label: 'Rosé Pine', swatch: ['#191724', '#26233a', '#ebbcba'] },
  { id: 'gruvbox', label: 'Gruvbox', swatch: ['#282828', '#3c3836', '#fabd2f'] },
  { id: 'solarized-light', label: 'Solarized Light', swatch: ['#fdf6e3', '#ece4cd', '#cb4b16'] },
] as const;

/** Used when settings carry a theme this build does not know. */
export const DEFAULT_THEME = 'cinema-red';

/** Whether a theme id is one this build can render. */
export function isKnownTheme(id: string | null | undefined): boolean {
  return THEMES.some((theme) => theme.id === id);
}

/**
 * Write the theme onto `<html>`.
 *
 * `document.documentElement` rather than a wrapper div, because the CSS
 * variables are declared on `:root` and `body`'s background has to change too --
 * a themed inner div would leave the page's overscroll area the wrong colour.
 *
 * Also updates `<meta name="theme-color">` when one exists, so the browser UI
 * (including on Android, where MovieBox is the main way this gets used) matches
 * the app instead of staying stuck on the default theme's background.
 */
export function applyTheme(id: string): void {
  const theme = isKnownTheme(id) ? id : DEFAULT_THEME;

  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;

    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      // Read the resolved variable rather than keeping a second copy of every
      // palette's background in TypeScript, which would drift the moment a
      // palette is edited.
      const background = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg-base')
        .trim();
      if (background) meta.content = background;
    }
  }
}

/** The theme currently applied. */
export function currentTheme(): string {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return document.documentElement.dataset.theme ?? DEFAULT_THEME;
}