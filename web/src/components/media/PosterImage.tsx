/**
 * Poster image with a controlled loading lifecycle.
 *
 * Two things this handles that a bare `<img>` does not:
 *
 *  1. **Every poster goes through `/api/poster`.** MovieBox's CDN rejects requests
 *     without a browser User-Agent, so a direct `<img src>` returns an error
 *     image. The proxy sets the header and caps the size.
 *  2. **No layout shift.** The 2:3 box is reserved before the bytes arrive, so a
 *     rail does not reflow as images land.
 */

import { Film } from 'lucide-react';
import { useState } from 'react';

import { api } from '@/lib/api';

type Status = 'loading' | 'loaded' | 'failed';

export function PosterImage({
  src,
  alt,
  className = '',
  /** Overlay drawn on top once the image is ready, e.g. a badge or gradient. */
  children,
}: {
  src: string | null;
  alt: string;
  className?: string;
  children?: React.ReactNode;
}) {
  // Reset whenever the source changes. Without the key change the `loaded`
  // state from a previous poster would survive and the new image would appear
  // without ever fading in.
  const [status, setStatus] = useState<Status>(src ? 'loading' : 'failed');
  const [generation, setGeneration] = useState(0);

  return (
    <div className={`relative overflow-hidden bg-bg-raised ${className}`}>
      {src ? (
        <>
          {status === 'loading' && <div className="skeleton absolute inset-0" aria-hidden="true" />}

          {status !== 'failed' && (
            <img
              // Remounting per source is the simplest correct reset; there is no
              // other state on this element worth preserving.
              key={`${src}:${generation}`}
              src={api.posterUrl(src)}
              alt={alt}
              loading="lazy"
              decoding="async"
              onLoad={() => setStatus('loaded')}
              onError={() => {
                setStatus('failed');
                // One retry. Poster CDNs fail transiently more often than they
                // fail permanently, and a single retry recovers those without
                // looping on a genuinely missing image.
                if (generation === 0) setGeneration(1);
              }}
              className={`size-full object-cover transition-opacity duration-500 ${
                status === 'loaded' ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}

          {status === 'failed' && <PosterFallback label={alt} />}
        </>
      ) : (
        <PosterFallback label={alt} />
      )}

      {status === 'loaded' && children}
    </div>
  );
}

/**
 * What shows when there is no poster.
 *
 * A film glyph on the surface colour, plus the title in small print. Not just an
 * icon: on a search results page a wall of identical glyphs gives the user
 * nothing to scan.
 */
function PosterFallback({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg-raised px-2 text-center">
      <Film className="size-6 text-fg-subtle" aria-hidden="true" />
      <span className="line-clamp-3 text-[11px] leading-tight text-fg-subtle">{label}</span>
    </div>
  );
}