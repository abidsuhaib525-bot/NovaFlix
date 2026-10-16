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
  const [status, setStatus] = useState<Status>(src ? 'loading' : 'failed');
  const [useFallbackProxy, setUseFallbackProxy] = useState(false);

  // Fast direct load with referrerpolicy="no-referrer"; fallback to proxy if blocked
  const initialUrl = src?.startsWith('http') ? src : src ? api.posterUrl(src) : '';
  const effectiveSrc = useFallbackProxy && src ? api.posterUrl(src) : initialUrl;

  return (
    <div className={`relative overflow-hidden bg-bg-raised ${className}`}>
      {src ? (
        <>
          {status === 'loading' && <div className="skeleton absolute inset-0" aria-hidden="true" />}

          {status !== 'failed' && (
            <img
              key={effectiveSrc}
              src={effectiveSrc}
              alt={alt}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onLoad={() => setStatus('loaded')}
              onError={() => {
                if (!useFallbackProxy && src?.startsWith('http')) {
                  setUseFallbackProxy(true);
                } else {
                  setStatus('failed');
                }
              }}
              className={`size-full object-cover transition-opacity duration-300 ${
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