import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Badge, Button, ControlIcon, Dialog, EmptyState, IconButton, InlineError, NoticeLine, StatusDot, TagButton } from '@quirky/ui'
import { RpcErrorCode, type QuirkyEvent, type UiPluginContext } from '@quirky/protocol'
import type { ViewMountInput, ViewNode, ViewPlacement, ViewRecord, ViewSpec, ViewSurface } from '../core/contract'
import { changedKeys } from './changes'
import { errorText } from './errors'
import { clampLabel, pointAt, usePointStyles } from './point'
import { claimPreview, reloadPreview } from './previews'
import { RenderNode } from './RenderNode'
import { RuntimeContext, type ViewRuntime } from './runtime'
import { ACTION_COMMAND_ID, CONTROL_COMMAND_ID, MOVE_COMMAND_ID, type ViewUiInstance } from '../control'
import { COLUMN, MONO, MUTED, ROW } from './styles'
import { when } from './when'

export const RENDER_VIEW_ID = 'view:quirky.view/render'

export { errorText }

const CHAT_POINT_COMMAND = 'command:quirky.session/chat-point'
const CHAT_EXPAND_COMMAND = 'command:quirky.session/chat-expand-visual'

/** The `data` of a daemon event of `type`, or undefined for any other event. */
export function eventData(event: QuirkyEvent, type: string): Record<string, unknown> | undefined {
  if (event.type !== type || !('data' in event)) return undefined
  const data = event.data as unknown
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined
}

/** The agent that runs `sessionId`, for the "by <agent>" tag; undefined until it is known or when the session is gone. */
export function useAgent(context: UiPluginContext, sessionId: string | undefined): string | undefined {
  const [agent, setAgent] = useState<{ sessionId: string; agent: string } | undefined>()
  useEffect(() => {
    if (sessionId === undefined) return
    let alive = true
    void (async () => {
      try {
        const session = (await context.call('quirky.session/get', { session: sessionId })) as { agent?: unknown } | null
        if (alive && typeof session?.agent === 'string') setAgent({ sessionId, agent: session.agent })
      } catch (error) {
        context.log(`could not read session ${sessionId}: ${errorText(error)}`)
      }
    })()
    return () => {
      alive = false
    }
  }, [context, sessionId])
  return agent !== undefined && agent.sessionId === sessionId ? agent.agent : undefined
}

/** "updated N times · HH:MM" for an updated view; the time is local. */
export function updatedLabel(record: Pick<ViewRecord, 'updates' | 'updatedAt'>): string | undefined {
  if (record.updates <= 0) return undefined
  const at = new Date(record.updatedAt)
  const clock = Number.isNaN(at.getTime()) ? '' : ` · ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return `updated ${record.updates} ${record.updates === 1 ? 'time' : 'times'}${clock}`
}

/** The version `record` holds and the newest version of its view; a record from before versions counts its updates. */
export function versionsOf(record: Pick<ViewRecord, 'updates' | 'version' | 'latestVersion'>): { shown: number; latest: number } {
  const shown = record.version ?? record.updates + 1
  return { shown, latest: record.latestVersion ?? shown }
}

const capabilities = new WeakMap<UiPluginContext, Promise<boolean>>()

/** Whether this window can open auxiliary windows, so the card knows if it may offer pop out. */
function usePopOutAvailable(context: UiPluginContext): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let alive = true
    let asked = capabilities.get(context)
    if (asked === undefined) {
      asked = (async () => {
        try {
          const reply = (await context.call('desktop.capabilities', {})) as { auxiliaryWindows?: unknown }
          return reply.auxiliaryWindows === true
        } catch {
          capabilities.delete(context)
          return false
        }
      })()
      capabilities.set(context, asked)
    }
    void asked.then((value) => {
      if (alive) setAvailable(value)
    })
    return () => {
      alive = false
    }
  }, [context])
  return available
}

const hasInteractiveHtml = (node: ViewNode): boolean => (node.type === 'html' && node.props?.interactive === true) || (node.children ?? []).some(hasInteractiveHtml)

const FRAME: CSSProperties = {
  ...COLUMN,
  padding: 'var(--ui-space-12)',
  borderWidth: 'var(--ui-border-width)',
  borderStyle: 'solid',
  borderColor: 'var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)'
}

const TITLE: CSSProperties = { margin: 0, fontSize: 'var(--ui-font-body)', fontWeight: 600, overflowWrap: 'anywhere' }

const RECORD: CSSProperties = { ...MUTED, margin: 0, padding: 'var(--ui-space-6) var(--ui-space-12)', overflowWrap: 'anywhere' }

const HEADER: CSSProperties = { ...ROW, justifyContent: 'space-between' }

const REFUSED_BOX: CSSProperties = { ...COLUMN, gap: 'var(--ui-space-6)', padding: 'var(--ui-space-8)', background: 'var(--ui-selected)', borderRadius: 'var(--ui-radius-control)' }

const SOURCE: CSSProperties = { ...MONO, margin: 0, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

const CHANGED_NOTE: CSSProperties = { ...MUTED, color: 'var(--ui-working)' }

/** Where each surface puts the card body: windows and the expanded view fill their space, a thumbnail shows a shrunken inert copy. */
const BODY: Record<ViewSurface, CSSProperties> = {
  inline: COLUMN,
  panel: COLUMN,
  expanded: { ...COLUMN, flex: 1, overflow: 'auto' },
  window: { ...COLUMN, flex: 1, overflow: 'auto' },
  thumbnail: { ...COLUMN, pointerEvents: 'none', transform: 'scale(0.5)', transformOrigin: 'top left', width: '200%', maxHeight: '200%', overflow: 'hidden' }
}

const NO_CHANGES: ReadonlySet<string> = new Set()

type Props = {
  context: UiPluginContext
  instance: ViewUiInstance
  record: ViewRecord
  link: string | null
  agent?: string
  /** Draws the card's own border; the pane already has a frame. */
  framed?: boolean
  /** True inside the Views pane, where a pane view shows its content. */
  inPane?: boolean
  surface?: ViewSurface
  /** The agent is still building this visual in the current turn. */
  drawing?: boolean
  focused?: boolean
  /** The spec of the version before this one, when this one is the newest; its differences are outlined. */
  previous?: ViewSpec | null
  /** False once the person stepped to a version, which the chat UI keeps when it expands the card. */
  following?: boolean
  /** Shows the version stepper; the stepping itself is the mount's `showVersion` handler. */
  stepper?: boolean
  /** Reports a diagram, image or html node that could not be drawn. */
  renderFailed?: (error: string) => void
}

/**
 * One view: its title, the "by <agent>" tag, the content, and the controls around it. Buttons and
 * fields send actions to the agent, and a markdown link asks before it opens. A click on a
 * pointable part of the content asks the chat to attach a reference to it.
 */
export function ViewCard({ context, instance, record, link, agent, framed = true, inPane = false, surface = 'inline', drawing = false, focused = false, previous = null, following = true, stepper = false, renderFailed: reportRenderFailed }: Props) {
  const { viewId } = record
  const { shown, latest } = versionsOf(record)
  const refused = record.refused ?? null
  const [moving, setMoving] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [reasonOpen, setReasonOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const popOutAvailable = usePopOutAvailable(context)
  const thumbnail = surface === 'thumbnail'
  usePointStyles(body, selected)

  useEffect(() => {
    setSelected(null)
  }, [viewId, shown])

  const changed = useMemo(() => (previous === null ? NO_CHANGES : changedKeys(previous.root, record.spec.root)), [previous, record.spec])

  const control = (args: { action: string; [key: string]: unknown }): void => {
    const request = { instance: instance.id, viewId, ...args }
    const sent = surface === 'window' ? instance.run(request) : context.executeCommand(CONTROL_COMMAND_ID, request, { activateOwner: false })
    void sent.catch((error: unknown) => {
      context.toast('Could not run the view action', errorText(error))
    })
  }

  const runInChat = useCallback(
    async (command: string, args: Record<string, unknown>) => {
      try {
        await context.executeCommand(command, args)
      } catch (error) {
        console.warn(`${command} is not available: ${errorText(error)}`)
      }
    },
    [context]
  )

  const point = useCallback(
    (element: string, label: string) => {
      setSelected(element)
      void runInChat(CHAT_POINT_COMMAND, { session: record.sessionId, viewId, version: shown, element, label: clampLabel(label) })
    },
    [runInChat, record.sessionId, viewId, shown]
  )

  const expand = useCallback(
    () => runInChat(CHAT_EXPAND_COMMAND, { session: record.sessionId, viewId, ...(following ? {} : { version: shown }) }),
    [runInChat, record.sessionId, viewId, shown, following]
  )

  const popOut = useCallback(async () => {
    try {
      await context.call('desktop.window.open', { view: RENDER_VIEW_ID, input: { viewId, surface: 'window' }, title: record.title })
    } catch (error) {
      context.toast('Could not pop out the visual', errorText(error))
    }
  }, [context, viewId, record.title])

  useEffect(() => {
    instance.setHandlers({ point, expand, popOut, toggleRefused: () => setReasonOpen((open) => !open), showPreview: async (node) => claimPreview(node), reloadPreview: async (node) => void (await reloadPreview(node)) })
    return () => instance.clearHandlers('point', 'expand', 'popOut', 'toggleRefused', 'showPreview', 'reloadPreview')
  }, [instance, point, expand, popOut])

  const runtime = useMemo<ViewRuntime>(() => {
    const send: ViewRuntime['send'] = async (name, source, data) => {
      try {
        await context.executeCommand(ACTION_COMMAND_ID, { viewId, name, source, ...(data === undefined ? {} : { data }) }, { activateOwner: false })
        return true
      } catch (error) {
        context.toast('Could not send the action', errorText(error))
        return false
      }
    }
    const onLink: ViewRuntime['openLink'] = (href) => {
      void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-preview', viewId, href }, { activateOwner: false }).catch((error: unknown) => {
        context.toast('Could not open link', errorText(error))
      })
    }
    return {
      send,
      openLink: onLink,
      context,
      viewId,
      session: record.sessionId,
      version: shown,
      surface,
      focused,
      changed,
      renderFailed: thumbnail || reportRenderFailed === undefined ? () => {} : reportRenderFailed,
      point: thumbnail ? () => {} : point,
      control
    }
  }, [context, instance, viewId, record.sessionId, shown, surface, focused, changed, thumbnail, reportRenderFailed, point])

  const target: ViewPlacement = record.placement === 'pane' ? 'inline' : 'pane'
  const move = async () => {
    setMoving(true)
    try {
      await context.executeCommand(MOVE_COMMAND_ID, { viewId, placement: target }, { activateOwner: false })
    } catch (error) {
      context.toast('Could not move the view', errorText(error))
    } finally {
      setMoving(false)
    }
  }

  const cancelLink = () => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-cancel', viewId }, { activateOwner: false }).catch((error: unknown) => {
      context.toast('Could not open link', errorText(error))
    })
  }

  const confirmLink = async () => {
    try {
      await context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'link-confirm', viewId }, { activateOwner: false })
    } catch (error) {
      context.toast('Could not open link', errorText(error))
    }
  }

  const pointFromClick = (event: MouseEvent) => {
    const found = pointAt(event.target, event)
    if (found !== null) control({ action: 'point', element: found.element, label: found.label })
  }

  const pointFromKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const found = event.target instanceof Element && event.target.hasAttribute('data-point-key') ? pointAt(event.target) : null
    if (found === null) return
    event.preventDefault()
    control({ action: 'point', element: found.element, label: found.label })
  }

  if (record.closed) {
    return <div data-view-record={viewId} role="status" style={RECORD}><NoticeLine>{record.title} closed</NoticeLine></div>
  }

  if (record.placement === 'pane' && !inPane && surface === 'inline') {
    return (
      <div data-view-record={viewId} role="status" style={RECORD}>
        <NoticeLine actions={[{ label: 'Move inline', disabled: moving, onAction: () => void move() }]}>
          {record.title} is in the Views pane
        </NoticeLine>
      </div>
    )
  }

  const content = (
    <RuntimeContext.Provider value={runtime}>
      <div ref={body} data-view-body onClick={thumbnail ? undefined : pointFromClick} onKeyDown={thumbnail ? undefined : pointFromKey} style={BODY[surface]}>
        <RenderNode node={record.spec.root} />
      </div>
    </RuntimeContext.Provider>
  )
  if (thumbnail) return <article data-view-card={viewId} data-view-surface={surface} aria-label={record.title} inert style={COLUMN}>{content}</article>

  const updated = surface === 'inline' ? updatedLabel(record) : undefined
  const unseen = refused === null ? shown + 1 : refused.version ?? latest + 1
  const focusRing: CSSProperties = focused ? { outlineWidth: 'var(--ui-focus-width)', outlineStyle: 'solid', outlineColor: 'var(--ui-accent)' } : {}
  const pending: CSSProperties = drawing ? { borderStyle: 'dashed' } : {}
  const cardStyle: CSSProperties = framed || surface !== 'inline' ? { ...FRAME, ...pending, ...focusRing } : COLUMN
  return (
    <article data-view-card={viewId} data-view-surface={surface} aria-label={record.title} style={{ ...cardStyle, ...(surface === 'expanded' || surface === 'window' ? { flex: 1, minHeight: 0 } : {}) }}>
      <header style={HEADER}>
        <div style={ROW}>
          <h3 style={TITLE}>{record.title}</h3>
          {when(agent !== undefined, () => <Badge>by {agent}</Badge>)}
          {when(hasInteractiveHtml(record.spec.root), () => <Badge tone="accent">sandboxed · no network</Badge>)}
          {when(drawing, () => <span data-view-drawing style={ROW}><StatusDot status="working" />drawing {record.title}</span>)}
          {when(refused !== null, () => (
            <TagButton aria-expanded={reasonOpen} onClick={() => control({ action: 'toggle-refused' })}>
              {`v${unseen} didn't render ${reasonOpen ? '▴' : '▾'}`}
            </TagButton>
          ))}
        </div>
        <div style={ROW}>
          {when(stepper, () => (
            <span role="group" aria-label="Versions" data-view-stepper style={ROW}>
              <IconButton label="Older version" disabled={shown <= 1} onClick={() => control({ action: 'show-version', version: shown - 1 })}>
                <ControlIcon name="caret-left" />
              </IconButton>
              <span data-view-version style={MUTED}>{`v${shown} of ${latest}`}</span>
              <IconButton label="Newer version" disabled={shown >= latest} onClick={() => control({ action: 'show-version', version: shown + 1 })}>
                <ControlIcon name="caret-right" />
              </IconButton>
            </span>
          ))}
          {when(surface === 'inline' || surface === 'panel', () => (
            <IconButton label="Expand" onClick={() => control({ action: 'expand' })}>
              <ControlIcon name="arrows-out" />
            </IconButton>
          ))}
          {when(surface !== 'window' && popOutAvailable, () => (
            <IconButton label="Pop out" onClick={() => control({ action: 'pop-out' })}>
              <ControlIcon name="export" />
            </IconButton>
          ))}
          {when(updated !== undefined, () => <span data-view-updated style={MUTED}>{updated}</span>)}
          {when(surface === 'inline' || surface === 'panel', () => (
            <Button disabled={moving} onClick={() => void move()}>{target === 'pane' ? 'Move to pane' : 'Move inline'}</Button>
          ))}
        </div>
      </header>
      {when(refused !== null && reasonOpen, () => (
        <div data-view-refused style={REFUSED_BOX}>
          {(refused?.errors ?? []).map((error, index) => <InlineError key={index} message={error} />)}
          <pre aria-label="Source that did not render" style={SOURCE}>{refused?.source}</pre>
          <span style={MUTED}>{`showing v${shown}, the last version that rendered`}</span>
        </div>
      ))}
      {content}
      {when(changed.size > 0, () => <span data-view-changed-note style={CHANGED_NOTE}>{`changed in v${shown}`}</span>)}
      <Dialog
        open={link !== null}
        title="Open this link?"
        onClose={cancelLink}
        actions={
          <>
            <Button onClick={cancelLink}>Cancel</Button>
            <Button variant="primary" onClick={() => void confirmLink()}>Open link</Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>This view links to a page outside Quirky. It opens in your browser.</p>
        <p style={{ ...MONO, overflowWrap: 'anywhere' }}>{link}</p>
      </Dialog>
    </article>
  )
}

const reported = new Set<string>()

/** Loads the view `viewId` and keeps it fresh: reloaded when the daemon reports a change to it and when the connection returns. */
export function ViewCardView({ context, instance, viewId, version: requested, surface = 'inline', drawing = false, focused = false }: ViewMountInput & { context: UiPluginContext; instance: ViewUiInstance }) {
  const [record, setRecord] = useState<ViewRecord | null>(null)
  const recordRef = useRef<ViewRecord | null>(null)
  const alive = useRef(true)
  const requestId = useRef(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed' | 'missing'>('loading')
  const [failure, setFailure] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [previous, setPrevious] = useState<ViewSpec | null>(null)
  const [pinned, setPinned] = useState<number | null>(requested ?? null)
  const pinnedRef = useRef<number | null>(requested ?? null)

  const readVersion = useCallback(
    async (version?: number): Promise<ViewRecord | null> => {
      try {
        return ((await context.call('quirky.view/get', { viewId, ...(version === undefined ? {} : { version }) })) as ViewRecord | null | undefined) ?? null
      } catch (error) {
        if (version === undefined) throw error
        return null
      }
    },
    [context, viewId]
  )

  const load = useCallback(async () => {
    const request = ++requestId.current
    try {
      let next = ((await context.call('quirky.view/get', { viewId, ...(pinnedRef.current === null ? {} : { version: pinnedRef.current }) })) as ViewRecord | null | undefined) ?? null
      if (!alive.current || request !== requestId.current) return
      let before: ViewSpec | null = null
      if (next !== null) {
        const { shown, latest } = versionsOf(next)
        const failedHere = pinnedRef.current === null && next.refused?.attempt === 'render' && next.refused.version === shown && shown > 1
        if (failedHere) {
          const good = await readVersion(shown - 1)
          if (!alive.current || request !== requestId.current) return
          next = good === null ? next : { ...good, version: shown - 1, latestVersion: latest, refused: next.refused }
        } else if (shown === latest && shown > 1) {
          before = (await readVersion(shown - 1))?.spec ?? null
          if (!alive.current || request !== requestId.current) return
        }
      }
      const earlier = recordRef.current
      if (earlier?.closed !== next?.closed || earlier?.placement !== next?.placement ||
        JSON.stringify(earlier?.spec) !== JSON.stringify(next?.spec)) instance.update({ pendingLink: null })
      recordRef.current = next
      setRecord(next)
      setPrevious(before)
      setFailure(null)
      const nextPhase = next ? 'ready' : 'missing'
      setPhase(nextPhase)
      instance.update({ phase: nextPhase, activeViewId: next?.viewId ?? null })
    } catch (error) {
      if (!alive.current || request !== requestId.current) throw error
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.NotFound) {
        recordRef.current = null
        setRecord(null)
        setFailure(null)
        setPhase('missing')
        instance.update({ phase: 'missing', activeViewId: null })
        return
      }
      setPhase('failed')
      setFailure(errorText(error))
      instance.update({ phase: 'failed' })
      throw error
    }
  }, [context, instance, viewId, readVersion])

  const showVersion = useCallback(
    (version: number) => {
      const latest = recordRef.current === null ? version : versionsOf(recordRef.current).latest
      const next = version >= latest ? null : version
      pinnedRef.current = next
      setPinned(next)
      return load()
    },
    [load]
  )

  const renderFailed = useCallback(
    (error: string) => {
      const current = recordRef.current
      if (current === null) return
      const { shown, latest } = versionsOf(current)
      const key = `${viewId}:${shown}`
      if (shown !== latest || reported.has(key)) return
      reported.add(key)
      context.call('quirky.view/render-failed', { viewId, version: shown, error }).catch((reason: unknown) => {
        reported.delete(key)
        context.log(`could not report a version that did not render: ${errorText(reason)}`)
      })
    },
    [context, viewId]
  )

  useEffect(() => {
    alive.current = true
    recordRef.current = null
    pinnedRef.current = requested ?? null
    setPinned(requested ?? null)
    setRecord(null)
    setPrevious(null)
    setPhase('loading')
    setFailure(null)
    setLink(null)
    instance.update({ phase: 'loading', activeViewId: null, tabs: [], pendingLink: null })
    instance.setHandlers({
      refresh: load,
      showVersion,
      previewLink: (href) => {
        const current = recordRef.current
        if (!current || current.closed || (surface === 'inline' && current.placement !== 'inline')) throw new Error('View link preview is not available for this mount.')
        setLink(href)
      },
      cancelLink: () => setLink(null)
    })
    void load().catch(() => {})
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (eventData(event, 'quirky.view/changed')?.viewId === viewId) void load().catch(() => {})
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load().catch(() => {})
    })
    return () => {
      alive.current = false
      ++requestId.current
      instance.clearHandlers('refresh', 'showVersion', 'previewLink', 'cancelLink')
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, instance, viewId, requested, surface, load, showVersion])

  const agent = useAgent(context, record?.sessionId)
  const retry = () => {
    void context.executeCommand(CONTROL_COMMAND_ID, { instance: instance.id, action: 'refresh' }, { activateOwner: false }).catch(() => {})
  }
  const steppable = surface === 'inline' || surface === 'panel' || surface === 'expanded' || surface === 'window'
  if (phase === 'loading') return <NoticeLine>Loading view…</NoticeLine>
  if (phase === 'missing') return <EmptyState message="This view is no longer available." />
  return (
    <>
      {failure !== null && <InlineError message={`Could not load view: ${failure}`} action={{ label: 'Retry', onAction: retry }} />}
      {record && (
        <ViewCard
          context={context}
          instance={instance}
          record={record}
          link={link}
          agent={agent}
          surface={surface}
          drawing={drawing}
          focused={focused}
          previous={previous}
          following={pinned === null}
          stepper={steppable}
          renderFailed={renderFailed}
        />
      )}
    </>
  )
}

/** Reads the view input, which is untrusted until it has a `viewId`. */
export function parseRenderInput(input: unknown): ViewMountInput | null {
  if (typeof input !== 'object' || input === null) return null
  const { viewId, version, surface, drawing, focused } = input as Record<string, unknown>
  if (typeof viewId !== 'string' || viewId === '') return null
  const surfaces: readonly ViewSurface[] = ['inline', 'panel', 'thumbnail', 'expanded', 'window']
  return {
    viewId,
    ...(typeof version === 'number' && Number.isInteger(version) && version >= 1 ? { version } : {}),
    ...(typeof surface === 'string' && (surfaces as readonly string[]).includes(surface) ? { surface: surface as ViewSurface } : {}),
    ...(typeof drawing === 'boolean' ? { drawing } : {}),
    ...(typeof focused === 'boolean' ? { focused } : {})
  }
}
