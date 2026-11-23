import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, InlineError, INITIAL_DECK_FOCUS, NoticeLine, ToolPanelFrame, VisualDeckTabs, deckFocusReducer, orderDeckEntries, type DeckClosedEntry, type DeckEntry, type DeckEvent, type DeckFocus } from '@quirky/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { ViewRecord } from './core/contract'
import { CONTROL_COMMAND_ID, type ViewUiInstance } from './control'
import { ViewCard, errorText, eventData, versionsOf } from './render/ViewCard'

export const PANE_VIEW_ID = 'view:quirky.view/pane'

/** The pane's input, untrusted until it has a `session`. */
export function parsePaneInput(input: unknown): { session: string } | null {
  if (typeof input !== 'object' || input === null) return null
  const { session } = input as { session?: unknown }
  return typeof session === 'string' && session !== '' ? { session } : null
}

type Deck = { open: ViewRecord[]; entries: DeckEntry[]; closed: DeckClosedEntry[] }

const labelOf = (record: ViewRecord): string => record.spec.label ?? record.title

/** The pane's open views in tab order, with the deck entries for them and the closed views the tab row can reopen. */
function deckOf(records: readonly ViewRecord[]): Deck {
  const inPane = records.filter((record) => record.placement === 'pane')
  const live = inPane.filter((record) => !record.closed)
  const entries = orderDeckEntries(live.map((record, index) => ({ id: record.viewId, label: labelOf(record), title: record.title, created: index, done: record.done === true })))
  const byId = new Map(live.map((record) => [record.viewId, record]))
  const closed = inPane
    .filter((record) => record.closed)
    .map((record) => ({ id: record.viewId, label: labelOf(record), title: record.title, closedOrder: Number.isNaN(Date.parse(record.updatedAt)) ? 0 : Date.parse(record.updatedAt) }))
  return { open: entries.map((entry) => byId.get(entry.id) as ViewRecord), entries, closed }
}

const DRAWN_KINDS: readonly unknown[] = ['open', 'update', 'patch']

/** The Views pane of one session: the session's pane views on the shared visual deck, one at a time. */
export function ViewsPane({ context, session, instance }: { context: UiPluginContext; session: string; instance: ViewUiInstance }) {
  const [records, setRecords] = useState<ViewRecord[]>([])
  const recordsRef = useRef<ViewRecord[]>([])
  const [focus, setFocus] = useState<DeckFocus>(INITIAL_DECK_FOCUS)
  const focusRef = useRef<DeckFocus>(INITIAL_DECK_FOCUS)
  const pins = useRef(new Map<string, number>())
  const [pinned, setPinned] = useState<Record<string, ViewRecord>>({})
  const pinnedRef = useRef<Record<string, ViewRecord>>({})
  const alive = useRef(true)
  const requestId = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const phase = useRef<'loading' | 'ready' | 'failed'>('loading')

  const publish = useCallback(() => {
    const deck = deckOf(recordsRef.current)
    const active = deck.open.find((record) => record.viewId === focusRef.current.focusedId) ?? deck.open[0]
    instance.update({
      phase: phase.current,
      tabs: deck.open.map((record) => ({ viewId: record.viewId, title: record.title, label: labelOf(record), done: record.done === true })),
      activeViewId: active?.viewId ?? null
    })
  }, [instance])

  const send = useCallback(
    (event: DeckEvent) => {
      focusRef.current = deckFocusReducer(focusRef.current, event)
      setFocus(focusRef.current)
      publish()
    },
    [publish]
  )

  const readPinned = useCallback(
    async (listed: readonly ViewRecord[]): Promise<Record<string, ViewRecord>> => {
      const next: [string, ViewRecord][] = []
      for (const [viewId, version] of [...pins.current]) {
        const current = listed.find((record) => record.viewId === viewId && record.placement === 'pane' && !record.closed)
        if (!current) {
          pins.current.delete(viewId)
          continue
        }
        try {
          const got = (await context.call('quirky.view/get', { viewId, version })) as ViewRecord | null | undefined
          if (got) next.push([viewId, { ...got, version, latestVersion: versionsOf(current).latest }])
          else pins.current.delete(viewId)
        } catch (error) {
          context.toast(`Could not load version ${version}`, errorText(error))
          const shownBefore = pinnedRef.current[viewId]
          if (shownBefore) next.push([viewId, { ...shownBefore, latestVersion: versionsOf(current).latest }])
        }
      }
      return Object.fromEntries(next)
    },
    [context]
  )

  const load = useCallback(async () => {
    const request = ++requestId.current
    try {
      const next = (await context.call('quirky.view/list', { session })) as ViewRecord[]
      if (!alive.current || request !== requestId.current) return
      const pinnedNext = await readPinned(next)
      if (!alive.current || request !== requestId.current) return
      const before = deckOf(recordsRef.current).open
      const after = deckOf(next).open
      const focusedId = focusRef.current.focusedId
      const previousActive = before.find((record) => record.viewId === focusedId) ?? before[0]
      const updatedActive = next.find((record) => record.viewId === previousActive?.viewId)
      if (JSON.stringify(previousActive?.spec) !== JSON.stringify(updatedActive?.spec)) instance.update({ pendingLink: null })
      phase.current = 'ready'
      recordsRef.current = next
      setRecords(next)
      pinnedRef.current = pinnedNext
      setPinned(pinnedNext)
      setLoaded(true)
      setFailure(null)
      if (focusedId !== null && !after.some((record) => record.viewId === focusedId)) {
        const remaining = after.map((record) => record.viewId)
        const left = before.map((record) => record.viewId).slice(0, Math.max(0, before.findIndex((record) => record.viewId === focusedId))).reverse().find((id) => remaining.includes(id))
        send({ type: 'removed', id: focusedId, next: left ?? remaining[0] ?? null })
      } else if (focusedId === null && after.length > 0) send({ type: 'asked', id: after[0]!.viewId })
      else publish()
    } catch (error) {
      if (alive.current && request === requestId.current) {
        phase.current = 'failed'
        setLoaded(true)
        setFailure(errorText(error))
        instance.update({ phase: phase.current })
      }
      throw error
    }
  }, [context, instance, publish, readPinned, send, session])

  const selectTab = useCallback(
    (viewId: string) => {
      if (!deckOf(recordsRef.current).open.some((record) => record.viewId === viewId)) throw new Error('View is not an open pane tab.')
      send({ type: 'picked', id: viewId })
    },
    [send]
  )

  const closeView = useCallback(
    async (viewId: string) => {
      if (!deckOf(recordsRef.current).open.some((record) => record.viewId === viewId)) throw new Error('View is not an open pane tab.')
      try {
        await context.call('quirky.view/close', { viewId })
      } catch (error) {
        context.toast('Could not close the visual', errorText(error))
        throw error
      }
      await load()
    },
    [context, load]
  )

  const showVersion = useCallback(
    async (version: number) => {
      const deck = deckOf(recordsRef.current)
      const active = deck.open.find((record) => record.viewId === focusRef.current.focusedId) ?? deck.open[0]
      if (!active) return
      if (version >= versionsOf(active).latest) pins.current.delete(active.viewId)
      else pins.current.set(active.viewId, version)
      send({ type: 'stepped', id: active.viewId })
      await load()
    },
    [load, send]
  )

  useEffect(() => {
    alive.current = true
    recordsRef.current = []
    focusRef.current = INITIAL_DECK_FOCUS
    pins.current = new Map()
    phase.current = 'loading'
    setRecords([])
    setFocus(INITIAL_DECK_FOCUS)
    pinnedRef.current = {}
    setPinned({})
    setLoaded(false)
    setFailure(null)
    setLink(null)
    instance.update({ phase: 'loading', activeViewId: null, tabs: [], pendingLink: null })
    instance.setHandlers({ refresh: load, selectTab, dismissTab: closeView, showVersion, previewLink: setLink, cancelLink: () => setLink(null) })
    void load().catch(() => {})
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      const data = eventData(event, 'quirky.view/changed')
      if (data?.sessionId !== session) return
      if (DRAWN_KINDS.includes(data.kind) && data.placement === 'pane' && typeof data.viewId === 'string') send({ type: 'drawn', id: data.viewId })
      void load().catch(() => {})
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load().catch(() => {})
    })
    return () => {
      alive.current = false
      ++requestId.current
      instance.clearHandlers('refresh', 'selectTab', 'dismissTab', 'showVersion', 'previewLink', 'cancelLink')
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [closeView, context, instance, load, selectTab, send, session, showVersion])

  const deck = useMemo(() => deckOf(records), [records])
  const active = deck.open.find((record) => record.viewId === focus.focusedId) ?? deck.open[0]
  const shown = active === undefined ? undefined : pinned[active.viewId] ?? active
  const retry = () => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'refresh' }, { activateOwner: false }).catch(() => {})
  }

  const runControl = (action: 'select-tab' | 'dismiss-tab', viewId: string): void => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action, viewId }, { activateOwner: false }).catch((error: unknown) => {
      context.log(`could not ${action === 'select-tab' ? 'select' : 'dismiss'} view tab: ${errorText(error)}`)
    })
  }

  const reopenView = async (viewId: string): Promise<void> => {
    try {
      await context.call('quirky.view/reopen', { viewId })
      send({ type: 'picked', id: viewId })
      await load()
    } catch (error) {
      context.toast('Could not reopen the visual', errorText(error))
    }
  }

  return (
    <ToolPanelFrame
      title="Views"
      tabs={(deck.entries.length > 0 || deck.closed.length > 0) && (
        <VisualDeckTabs
          label="Views"
          entries={deck.entries}
          closed={deck.closed}
          focusedId={active?.viewId ?? null}
          dots={focus.dots}
          onPick={(viewId) => runControl('select-tab', viewId)}
          onClose={(viewId) => runControl('dismiss-tab', viewId)}
          onReopen={(viewId) => void reopenView(viewId)}
        />
      )}
    >
      {!loaded && <NoticeLine>Loading views…</NoticeLine>}
      {failure !== null && <InlineError message={`Could not load views: ${failure}`} action={{ label: 'Retry', onAction: retry }} />}
      {loaded && failure === null && !active && <EmptyState message="No views in the pane." />}
      {shown && <ViewCard key={shown.viewId} context={context} instance={instance} record={shown} link={link} framed={false} inPane surface="panel" stepper />}
    </ToolPanelFrame>
  )
}
