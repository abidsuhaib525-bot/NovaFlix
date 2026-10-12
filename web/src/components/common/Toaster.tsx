/**
 * Transient messages.
 *
 * Downloads, cache clears and failed mutations all report through here rather
 * than through inline text, because they happen away from the control that
 * caused them -- a download started from the details page finishes minutes later
 * on the downloads page.
 */

import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';

import type { Toast, ToastKind } from '@/store/ui';
import { useUiStore } from '@/store/ui';

/**
 * How long each kind stays up.
 *
 * Errors get the longest. A success the user did not read is not a problem, but
 * a failure they did not read might be a download that silently stopped.
 */
const LIFETIME_MS: Record<ToastKind, number> = {
  info: 4_000,
  success: 3_500,
  // Deliberately not dismiss-on-click-only: 7s is enough to read a sentence.
  error: 7_000,
};

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: XCircle,
} as const;

const ACCENTS = {
  info: 'text-info',
  success: 'text-success',
  error: 'text-danger',
} as const;

/**
 * One row, with its own dismissal timer.
 *
 * Split from the list so that a new toast starting its countdown does not reset
 * the countdown on the ones already on screen, which would keep an older error
 * up indefinitely while a stream of successes arrived.
 */
function ToastRow({ toast }: { toast: Toast }) {
  const dismiss = useUiStore((state) => state.dismiss);

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), LIFETIME_MS[toast.kind]);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.kind, dismiss]);

  const Icon = ICONS[toast.kind];

  return (
    <div
      className="glass animate-scale-in pointer-events-auto flex items-start gap-3 rounded-card border border-border-default px-4 py-3 shadow-lg"
      role={toast.kind === 'error' ? 'alert' : 'status'}
    >
      <Icon className={`mt-px size-4 shrink-0 ${ACCENTS[toast.kind]}`} aria-hidden="true" />
      <p className="min-w-0 flex-1 text-[13px] leading-snug text-fg-default">{toast.message}</p>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 rounded p-1 text-fg-subtle transition hover:text-fg-default"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Mounted once in `App`; renders nothing when there is nothing to say. */
export function Toaster() {
  const toasts = useUiStore((state) => state.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-5 right-5 z-[100] flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2"
      // The list is not a live region itself; each row already carries the
      // `role` that suits its severity, which is what a screen reader announces.
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}