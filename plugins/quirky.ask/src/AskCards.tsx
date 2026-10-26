import { useSyncExternalStore } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { AskCard } from './AskCard'
import type { AskStore } from './store'

export function AskCards({ store, context }: { store: AskStore; context: UiPluginContext }) {
  const asks = useSyncExternalStore(store.subscribe, store.get)
  if (asks.length === 0) return <p className="muted">No pending questions.</p>
  return (
    <div className="ask-stack" style={{ position: 'static', width: 'auto', maxHeight: 'none', overflowY: 'visible' }}>
      {asks.map((ask) => (
        <AskCard key={ask.id} ask={ask} context={context} onResolved={store.remove} />
      ))}
    </div>
  )
}
