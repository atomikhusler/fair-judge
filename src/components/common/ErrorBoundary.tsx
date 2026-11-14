import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { blackBox } from '../../lib/blackBox';
import { clearLazyReloadFlags } from '../../lib/lazyWithRetry';

interface Props {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  variant?: 'fullscreen' | 'inline';
  onRetry?: () => void;
  resetKeys?: unknown[];
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

function areResetKeysEqual(a?: unknown[], b?: unknown[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    errorMessage: '',
  };

  public static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected runtime error occurred',
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    blackBox.recordError('boundary', error, errorInfo.componentStack?.slice(0, 120));
  }

  public componentDidUpdate(prevProps: Props): void {
    if (this.state.hasError && !areResetKeysEqual(prevProps.resetKeys, this.props.resetKeys)) {
      clearLazyReloadFlags();
      this.setState({ hasError: false, errorMessage: '' });
    }
  }

  private handleRetry = () => {
    clearLazyReloadFlags();
    this.setState({ hasError: false, errorMessage: '' });
    if (this.props.onRetry) {
      this.props.onRetry();
    }
  };

  private handleReload = () => {
    clearLazyReloadFlags();
    window.location.reload();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      const isInline = this.props.variant === 'inline';
      const title = this.props.title || 'Something went wrong';
      const subtitle =
        this.props.subtitle || 'Fair Judge caught an unexpected screen error';

      return (
        <div
          role="alert"
          className={
            isInline
              ? 'w-full flex-1 flex flex-col items-center justify-center p-4 sm:p-6 bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 select-none font-sans'
              : 'min-h-[100dvh] w-full bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col items-center justify-center p-6 select-none font-sans'
          }
        >
          <div className="max-w-md w-full bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-4 shadow-xl">
            <div className="w-11 h-11 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto">
              <AlertTriangle className="w-5 h-5" />
            </div>

            <div className="space-y-1">
              <h1 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
                {title}
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                {subtitle}
              </p>
            </div>

            <div className="p-3 bg-stone-100 dark:bg-zinc-950 rounded-xl border border-stone-200 dark:border-zinc-800 font-mono text-[11px] text-zinc-600 dark:text-zinc-400 break-words text-left">
              {blackBox.redactMessage(this.state.errorMessage)}
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                onClick={this.handleRetry}
                className="flex-1 min-h-[44px] py-2.5 px-4 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-950 font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-opacity motion-reduce:transition-none cursor-pointer shadow-sm active:scale-95 flex items-center justify-center gap-2"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Retry</span>
              </button>

              {!isInline && (
                <button
                  type="button"
                  onClick={this.handleReload}
                  className="sm:w-auto min-h-[44px] py-2.5 px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 font-bold text-xs uppercase tracking-wider hover:opacity-90 transition-opacity motion-reduce:transition-none cursor-pointer active:scale-95"
                >
                  Reload App
                </button>
              )}
            </div>

            <p className="text-[10px] text-zinc-500 dark:text-zinc-500 font-mono">
              Diagnostic telemetry saved to local flight recorder
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
