import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  // Identifier shown in the fallback so we know *what* crashed (e.g. "Sessions
  // page"). Also used as the React `key` strategy: bumping `resetKey` will
  // re-mount children after an error so the user can recover without reload.
  label?: string
  resetKey?: unknown
  fallback?: (err: Error, reset: () => void) => ReactNode
}

interface State {
  err: Error | null
  info: ErrorInfo | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null, info: null }

  static getDerivedStateFromError(err: Error): Partial<State> {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // Log to devtools so the stack is recoverable; the visible fallback keeps
    // it short to avoid burying recovery actions.
    console.error(`[ErrorBoundary:${this.props.label ?? 'root'}]`, err, info)
    this.setState({ info })
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.err && prev.resetKey !== this.props.resetKey) {
      this.setState({ err: null, info: null })
    }
  }

  reset = (): void => {
    this.setState({ err: null, info: null })
  }

  render(): ReactNode {
    const { err, info } = this.state
    if (!err) return this.props.children
    if (this.props.fallback) return this.props.fallback(err, this.reset)
    return (
      <div className="error-boundary">
        <div className="error-boundary-card">
          <div className="error-boundary-eyebrow">
            // {this.props.label ?? 'app'} crashed
          </div>
          <div className="error-boundary-title">Something broke</div>
          <div className="error-boundary-msg">{err.message || String(err)}</div>
          {info?.componentStack && (
            <details className="error-boundary-stack">
              <summary>stack</summary>
              <pre>{info.componentStack.trim()}</pre>
            </details>
          )}
          <div className="error-boundary-actions">
            <button className="btn primary" onClick={this.reset}>Retry</button>
            <button className="btn ghost" onClick={() => location.reload()}>Reload app</button>
          </div>
        </div>
      </div>
    )
  }
}
