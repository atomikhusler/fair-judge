import React, { Component, ErrorInfo, ReactNode } from 'react';
import { blackBox } from '../../lib/blackBox';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
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
    // Record error immediately into the Black Box flight recorder
    blackBox.recordError('boundary', error, errorInfo.componentStack?.slice(0, 100));
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col items-center justify-center p-6 select-none font-sans">
          <div className="max-w-md w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-6 text-center space-y-4 shadow-2xl">
            {/* Header */}
            <div className="space-y-1">
              <h1 className="text-lg font-bold tracking-tight text-white">
                Something went wrong
              </h1>
              <p className="text-xs text-zinc-400 font-mono">
                Fair Judge caught an unhandled interface exception
              </p>
            </div>

            {/* Error Message Box */}
            <div className="p-3 bg-zinc-950 rounded-xl border border-white/5 font-mono text-[11px] text-zinc-400 break-words text-left">
              {blackBox.redactMessage(this.state.errorMessage)}
            </div>

            {/* Reload CTA */}
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full py-3 px-4 rounded-xl bg-white text-zinc-950 font-bold text-xs uppercase tracking-wider hover:bg-zinc-200 transition-colors cursor-pointer shadow-sm active:scale-95"
            >
              Reload Application
            </button>

            <p className="text-[10px] text-zinc-500 font-mono">
              Diagnostic telemetry saved to local flight recorder
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
