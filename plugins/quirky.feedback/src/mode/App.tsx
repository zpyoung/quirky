import { useMemo, useSyncExternalStore } from 'react'
import { Banner } from './Banner'
import { Card } from './Card'
import { Chips, findPaneChips } from './Chip'
import { Dots } from './Dots'
import type { Layout } from './layout'
import { findMarkers } from './markers'
import type { Session } from './session'
import { Tray } from './Tray'

type Props = { session: Session; layout: Layout; annotate(pane: string): void }

export function App({ session, layout, annotate }: Props) {
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const version = useSyncExternalStore(layout.subscribe, layout.version)
  const found = useMemo(() => findMarkers(state.comments), [state.comments, version])
  const chips = useMemo(findPaneChips, [version])
  const editing = state.card?.id == null ? -1 : state.comments.findIndex((comment) => comment.id === state.card?.id)
  return <>
    <Banner onExit={() => void session.exit()} />
    <Dots comments={state.comments} found={found} />
    <Chips chips={chips} onComment={session.pickElement} onAnnotate={annotate} />
    <Tray state={state} found={found} session={session} />
    {state.card !== null ? <Card key={state.card.serial} card={state.card} number={editing < 0 ? null : editing + 1} actions={{
      setText: session.setText,
      setIntent: session.setIntent,
      submit: () => void session.submit(),
      cancel: session.cancel
    }} /> : null}
  </>
}
