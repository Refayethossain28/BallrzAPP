import { Component, type ReactNode } from 'react';

/**
 * Last-resort error boundary: a render crash anywhere in the tree shows a
 * friendly recover screen instead of a blank page. Errors are logged to the
 * console (the seam for Sentry/Crashlytics later).
 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Error-monitoring seam: swap for Sentry.captureException(error) in prod.
    console.error('[apex] render crash', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="centerpage">
        <div className="empty">
          <div className="big">😵</div>
          <p style={{ margin: '0 0 6px' }}><b>Something went wrong.</b></p>
          <p className="sub" style={{ margin: '0 0 16px' }}>
            The error has been logged. Reloading usually fixes it — your data is safe on the server.
          </p>
          <button className="cta" onClick={() => window.location.reload()}>Reload Apex</button>
        </div>
      </div>
    );
  }
}
