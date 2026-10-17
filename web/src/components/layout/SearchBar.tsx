/**
 * Search box with type-ahead.
 *
 * The dropdown is a listbox rather than a set of links so that arrow keys move
 * the active option and Enter commits it. Without that, a keyboard user has to
 * tab through every suggestion, which on a slow upstream provider is worse than
 * typing the full title.
 */

import { Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Spinner } from '@/components/common/StateBlocks';
import { useSuggest } from '@/hooks/useCatalog';
import { paths } from '@/lib/routes';

/**
 * How long to wait after the last keystroke.
 *
 * The suggestion endpoint is the most frequently repeated request the app makes
 * -- one per pause in typing. 220ms is short enough to feel immediate and long
 * enough that a five-letter word produces one request rather than five.
 */
const DEBOUNCE_MS = 220;

export function SearchBar({
  className = '',
  autoFocus = false,
  onSearchSubmitted,
}: {
  className?: string;
  autoFocus?: boolean;
  onSearchSubmitted?: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const listId = useId();

  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(text), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const { data: suggestions = [], isFetching } = useSuggest(debounced);
  const showList = open && debounced.trim().length >= 2;
  const options = suggestions.slice(0, 8);

  // Reset the highlight whenever the result set changes, so the cursor never
  // sits on an option index that no longer exists.
  useEffect(() => setActiveIndex(-1), [options.length]);

  // Close on an outside click. `pointerdown` rather than `click` so a press that
  // starts outside and ends inside does not leave the list open under the cursor.
  useEffect(() => {
    if (!showList) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showList]);

  /** `/` focuses the box from anywhere, the way every streaming site behaves. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (typing) return;

      event.preventDefault();
      input.current?.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Sync input value with URL when on search page
  useEffect(() => {
    if (location.pathname === '/search' || location.pathname.startsWith('/search')) {
      const searchParams = new URLSearchParams(location.search);
      const q = searchParams.get('q') ?? '';
      setText(q);
    }
  }, [location.pathname, location.search]);

  const submit = (value: string) => {
    const query = value.trim();
    if (!query) return;
    setOpen(false);
    input.current?.blur();
    onSearchSubmitted?.();
    const currentParams = new URLSearchParams(location.search);
    const isSameSearch = location.pathname.startsWith('/search') && currentParams.get('q') === query;
    if (!isSameSearch) {
      navigate(paths.search(query, 'moviebox'));
    }
  };

  return (
    <div ref={container} className={`relative ${className}`}>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          // Enter with a highlighted suggestion commits that one, not whatever
          // happens to be in the box.
          const chosen = activeIndex >= 0 ? options[activeIndex] : undefined;
          submit(chosen ?? text);
        }}
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden="true"
          />
          <input
            ref={input}
            type="search"
            autoFocus={autoFocus}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
                return;
              }
              if (!showList || options.length === 0) return;

              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((current) => (current + 1) % options.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((current) => (current - 1 + options.length) % options.length);
              }
            }}
            placeholder="Search movies, series, shows"
            aria-label="Search"
            // The listbox is a combobox: the text field owns it, and the active
            // option index travels with the field so a screen reader can say
            // which suggestion is highlighted.
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
            }
            className="w-full rounded-full border border-white/[0.08] bg-black/40 py-2.5 pl-10 pr-12 text-[13.5px] text-fg-default outline-none transition-all placeholder:text-fg-subtle/70 hover:border-white/20 focus:border-accent focus:bg-[#121218]/90 focus:ring-2 focus:ring-accent/20 focus:shadow-[0_0_20px_rgba(245,166,35,0.15)]"
          />

          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
            {isFetching ? (
              <Spinner className="size-3.5 text-accent animate-spin" />
            ) : text ? (
              <button
                type="button"
                onClick={() => {
                  setText('');
                  input.current?.focus();
                }}
                aria-label="Clear search"
                className="grid size-5 place-items-center rounded-full text-fg-subtle transition hover:bg-white/10 hover:text-fg-default"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            ) : (
              <kbd className="hidden sm:inline-block rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-mono text-fg-subtle shadow-sm select-none">
                /
              </kbd>
            )}
          </div>
        </div>
      </form>

      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search suggestions"
          className="absolute inset-x-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-white/15 bg-[#121218]/95 backdrop-blur-xl shadow-2xl animate-fade-in"
        >
          {options.length > 0 ? (
            <ul className="max-h-80 overflow-y-auto py-1.5 divide-y divide-white/[0.04]">
              {options.map((option, index) => (
                <li key={option} id={`${listId}-option-${index}`} role="option" aria-selected={index === activeIndex}>
                  <button
                    type="button"
                    // `onMouseDown` so the click lands before the input's blur
                    // closes the list.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setText(option);
                      submit(option);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`flex w-full items-center gap-2.5 truncate px-4 py-2.5 text-left text-[13px] transition ${
                      index === activeIndex
                        ? 'bg-accent/15 text-accent font-semibold pl-5'
                        : 'text-fg-default/90 hover:bg-white/[0.06]'
                    }`}
                  >
                    <Search className={`size-3 shrink-0 ${index === activeIndex ? 'text-accent' : 'text-fg-subtle'}`} />
                    <span className="truncate">{option}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-3 text-[12.5px] text-fg-subtle">
              {isFetching ? 'Searching catalog...' : 'No suggestions found'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}