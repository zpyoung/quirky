import { createPortal } from 'react-dom'
import { useMemo, useSyncExternalStore } from 'react'
import { Banner } from './Banner'
import { Card } from './Card'
import { Chips, findPaneChips } from './Chip'
import { Dots } from './Dots'
import type { Layout } from './layout'
import { findMarkers } from './markers'
import type { Session } from './session'
import { Tray } from './Tray'

type Props = { session: Session; layout: Layout; bannerSlot: HTMLElement }

export function App({ session, layout, bannerSlot }: Props) {
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const version = useSyncExternalStore(layout.subscribe, layout.version)
  const found = useMemo(() => findMarkers(state.comments), [state.comments, version])
  const chips = useMemo(findPaneChips, [version])
  const editing = state.card?.id == null ? -1 : state.comments.findIndex((comment) => comment.id === state.card?.id)
  return <>
    {createPortal(<Banner count={state.comments.length} open={!state.collapsed} onToggle={session.toggleCollapsed} onExit={() => void session.exit()} />, bannerSlot)}
    <Dots comments={state.comments} found={found} />
    <Chips chips={chips} onComment={session.pickElement} onAnnotate={session.annotate} />
    <Tray state={state} found={found} session={session} onEdit={session.edit} />
    {state.card !== null ? <Card
      key={state.card.serial}
      card={state.card}
      number={editing < 0 ? null : editing + 1}
      onText={session.setText}
      onIntent={session.setIntent}
      onAdd={() => void session.add()}
      onSave={() => void session.save()}
      onCancel={session.cancel}
    /> : null}
  </>
}
