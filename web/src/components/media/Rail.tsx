/**
 * Horizontal scroller for a row of posters.
 *
 * The reference sites this is modelled on put a full-bleed row under the header
 * with arrows that appear on hover. The scroll is native -- `scrollBy` on the
 * container -- so it keeps momentum on a trackpad, responds to a shift+wheel
 * and is reachable by keyboard without any of that being re-implemented.
 *
 * The arrows are hidden rather than disabled at the ends. A permanently visible
 * greyed-out arrow is visual noise, and the mask fade already communicates that
 * there is more.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export function Rail({
  children,
  labelledBy,
  className = '',
}: {
  children: ReactNode;
  /** Id of the heading this rail sits under, for the accessible name. */
  labelledBy: string;
  className?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  /**
   * Recompute the arrow state.
   *
   * Read from `scrollLeft` rather than tracked incrementally, because a rail can
   * also be moved by a trackpad, a scrollbar, a keyboard, or by content changing
   * size under it -- none of which go through `scrollBy`.
   *
   * The end test allows a pixel of slack: fractional device pixel ratios make
   * `scrollLeft + clientWidth` land a fraction short of `scrollWidth` on some
   * displays, which would leave the right arrow showing forever on a rail the
   * user has already scrolled to the end of.
   */
  const sync = useCallback(() => {
    const element = track.current;
    if (!element) return;
    const max = element.scrollWidth - element.clientWidth;
    setAtStart(element.scrollLeft <= 1);
    setAtEnd(element.scrollLeft >= max - 1);
  }, []);

  useEffect(() => {
    sync();
    const element = track.current;
    if (!element) return;

    // `ResizeObserver` rather than `window.resize`: the rail also changes width
    // when the nav drawer opens, a sidebar collapses, or the window is resized,
    // none of which fire a window resize event on the rail itself.
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    for (const child of Array.from(element.children)) observer.observe(child);

    return () => observer.disconnect();
  }, [sync, children]);

  const page = (direction: -1 | 1) => {
    const element = track.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(0, element.clientWidth - 80),
      behavior: 'smooth',
    });
  };

  return (
    <div className={`group/rail relative ${className}`}>
      <div
        ref={track}
        onScroll={sync}
        // `role="list"` so the row is announced as a group rather than as a run
        // of unrelated links; the cards are the list items.
        role="list"
        aria-labelledby={labelledBy}
        tabIndex={0}
        className="no-scrollbar flex gap-3 overflow-x-auto scroll-smooth pb-1 focus-visible:outline-none"
      >
        {children}
      </div>

      <RailArrow side="left" hidden={atStart} onClick={() => page(-1)} />
      <RailArrow side="right" hidden={atEnd} onClick={() => page(1)} />
    </div>
  );
}

function RailArrow({
  side,
  hidden,
  onClick,
}: {
  side: 'left' | 'right';
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;

  return (
    <button
      type="button"
      onClick={onClick}
      // Kept in the DOM and switched off, rather than removed: removing it would
      // make the tab order shift as the user scrolls, which is disorienting.
      aria-hidden={hidden}
      tabIndex={hidden ? -1 : 0}
      // The rail is not a landmark and this control only exists on hover, so it
      // is hidden from assistive tech entirely -- the cards inside are the
      // content, and arrow scrolling is a pointer convenience.
      className={`glass absolute top-[38%] z-10 grid size-9 -translate-y-1/2 place-items-center rounded-full border border-border-default text-fg-default shadow-md transition duration-200 hover:border-accent hover:text-accent disabled:pointer-events-none disabled:opacity-0 ${
        side === 'left' ? 'left-2' : 'right-2'
      } ${hidden ? 'pointer-events-none opacity-0' : 'opacity-100 group-hover/rail:opacity-100'}`}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}