/**
 * Global React Error Boundary.
 *
 * Prevents uncaught render or component errors from crashing the application
 * into a blank black screen. Displays an elegant cinema recovery card with
 * options to reload the page or return to the home screen.
 */

import { AlertTriangle, Home, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary caught error]', error, errorInfo);
  }

  resetError = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[500px] h-full w-full flex-col items-center justify-center bg-black/90 p-6 text-center text-white animate-fade-in select-none">
          <div className="relative mb-4 flex size-16 items-center justify-center rounded-2xl bg-danger/15 text-danger border border-danger/30 shadow-2xl">
            <AlertTriangle className="size-8" />
          </div>

          <h2 className="text-xl font-bold tracking-tight text-white">
            {this.props.fallbackTitle || 'Playback encountered an issue'}
          </h2>

          <p className="mt-2 max-w-md text-sm text-white/70 leading-relaxed">
            {this.state.error?.message ||
              'A temporary glitch occurred while rendering this view. You can reload to try again.'}
          </p>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => {
                this.resetError();
                window.location.reload();
              }}
              className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-[13px] font-bold text-accent-contrast shadow-lg transition hover:scale-105 active:scale-95"
            >
              <RotateCcw className="size-4" />
              Reload Page
            </button>

            <a
              href="/"
              className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-white/20 bg-white/10 px-6 py-2.5 text-[13px] font-semibold text-white transition hover:bg-white/20"
            >
              <Home className="size-4" />
              Return Home
            </a>
          </div>

          {process.env.NODE_ENV !== 'production' && this.state.error && (
            <details className="mt-6 max-w-xl text-left">
              <summary className="cursor-pointer text-xs text-white/40 hover:text-white/70">
                Show Technical Stack Trace
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-black/80 p-3 font-mono text-[11px] text-red-300 border border-white/10">
                {this.state.error.stack}
              </pre>
            </details>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
