import { Component, type ErrorInfo, type ReactNode } from 'react'
import { EmptyState } from '../design-system/panels'

/** Keeps shell render failures local to this window without replaying a broken subtree. */
export class ShellErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Shell render failed', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div
        role="alert"
        aria-label="Window error"
        style={{
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--ui-space-16)',
          background: 'var(--ui-surface)',
          color: 'var(--ui-text)'
        }}
      >
        <EmptyState message="This window couldn't render. Close and reopen the window. If it happens again, check the developer console." />
      </div>
    )
  }
}
