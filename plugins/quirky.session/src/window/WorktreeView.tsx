import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { EmptyState } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import type { WorktreeSessions } from './model'
import { SessionTabs } from './SessionTabs'
import { SessionView } from './SessionView'

type Connection = { connected: boolean; epoch: number }

/** Connection state of the window; `epoch` changes on each reconnect so panes attach again. */
function useConnection(context: UiPluginContext): Connection {
  const [state, setState] = useState<Connection>({ connected: true, epoch: 0 })
  useEffect(
    () =>
      context.onConnection((status) =>
        setState((current) =>
          status === 'connected'
            ? { connected: true, epoch: current.connected ? current.epoch : current.epoch + 1 }
            : { ...current, connected: false }
        )
      ),
    [context]
  )
  return state
}

const layout = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  minWidth: 0,
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)'
} satisfies CSSProperties

const header = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--ui-space-8)',
  padding: 'var(--ui-space-8) var(--ui-space-12)',
  borderBottom: 'var(--ui-border-width) solid var(--ui-border)',
  minWidth: 0
} satisfies CSSProperties

const title = { fontSize: 'var(--ui-font-title)', overflowWrap: 'anywhere' } satisfies CSSProperties
const path = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)', overflowWrap: 'anywhere', minWidth: 0 } satisfies CSSProperties
const body = { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0 } satisfies CSSProperties

/** A worktree's header, session tabs and the active session. */
export function WorktreeView({
  context,
  store,
  themeSource
}: {
  context: UiPluginContext
  store: WorktreeSessions
  /** The element the view is mounted on, which carries the theme's custom properties. */
  themeSource: Element
}) {
  const { status, worktree, sessions, active } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { connected, epoch } = useConnection(context)

  return (
    <div style={layout}>
      <header style={header}>
        {worktree ? (
          <>
            <strong style={title}>{worktree.name}</strong>
            <span style={path}>{worktree.path}</span>
          </>
        ) : (
          <span style={path}>{status === 'missing' ? 'Worktree not found' : 'Quirky'}</span>
        )}
      </header>
      {worktree && <SessionTabs context={context} store={store} sessions={sessions} active={active} />}
      <main style={body}>
        {status === 'ready' && !active && (
          <EmptyState
            message="No sessions in this worktree."
            action={{ label: 'New shell', onAction: () => void store.create('shell', '', false) }}
          />
        )}
        {active && (
          <SessionView
            key={`${active.id}:${epoch}`}
            context={context}
            themeSource={themeSource}
            session={active}
            connected={connected}
            onClose={() => void store.close(active)}
          />
        )}
      </main>
    </div>
  )
}
