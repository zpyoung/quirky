import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { FloatingBounds, FloatingState } from '../../layout/types'
import { FLOATING_WORKSPACE } from '../../layout/types'
import { Menu } from '../workspace/Menu'
import { controllerFor, injectWorkspaceStyles, mountWorkspace, setFloatingFocus } from '../workspace'
import { terminalSettingName } from '../workspace/model'
import type { ViewReport, WorkspaceOptions } from '../workspace'
import { BUTTON_SIZE, clampButton, defaultButton, moveBounds, resizeBounds, resolveBounds, type Edge, type Point, type Viewport } from './geometry'
import { injectFloatingStyles } from './styles'

const FLOATING_EVENT = 'quirky.terminal/floating'
const ENABLED_SETTING = 'setting:quirky.terminal/floating-enabled'
const DRAG_THRESHOLD = 4
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

type Props = {
  context: UiPluginContext
  report?(state: unknown): void
  /** The slots the floating workspace shares with the main one (pane menu rows). */
  workspaceOptions(): WorkspaceOptions
}

type Local = { bounds?: FloatingBounds; button?: Point }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

function currentViewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight }
}

function useViewport(): Viewport {
  const [view, setView] = useState(currentViewport)
  useEffect(() => {
    const onResize = () => setView(currentViewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return view
}

/** Follows the mouse from `origin` until it is released; `stop` ends the drag early. */
function trackMouse(origin: Point, onMove: (dx: number, dy: number) => void, onEnd: (dx: number, dy: number) => void): () => void {
  const stop = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  const move = (event: MouseEvent) => onMove(event.clientX - origin.x, event.clientY - origin.y)
  const up = (event: MouseEvent) => {
    stop()
    onEnd(event.clientX - origin.x, event.clientY - origin.y)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
  return stop
}

const same = (a: FloatingBounds, b: FloatingBounds) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

function Icon({ path }: { path: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={path} />
    </svg>
  )
}

const MINIMIZE = 'M2.5 9.5h7'
const MAXIMIZE = 'M2.5 2.5h7v7h-7z'
const RESTORE = 'M4 4h5.5v5.5H4zM4 4V2.5h5.5V8'
const PANELS = 'M1.5 2.5h9v7h-9zM1.5 5h9M4.5 5v4.5'

/** The workspace inside the panel: the main view's components over the `floating` workspace. */
function PanelBody({ context, options, onReport }: { context: UiPluginContext; options: () => WorkspaceOptions; onReport(report: ViewReport | null): void }) {
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = element.current!
    const unmount = mountWorkspace(context, target, { report: (state) => onReport(state as ViewReport) }, { ...options(), workspace: FLOATING_WORKSPACE })
    return () => {
      // unmounting a root while React commits another one is refused, so it waits a tick
      queueMicrotask(unmount)
      onReport(null)
    }
  }, [context])
  return <div ref={element} className="qf-body" data-floating-body />
}

/**
 * The floating workspace: a draggable button that toggles a panel (title bar, edge resize,
 * maximize, minimize) over the window. Geometry changes are local while the mouse is down and sent
 * once through `setFloating` on release. It tells the window when focus is inside the panel
 * (`floatingFocus`), so the app keys act on its workspace, and reports `{shown, state, layout,
 * focusedPane, panes, visibleSessions}`. Draws nothing while the Enable Floating Workspace setting is off.
 */
export function FloatingOverlay({ context, report, workspaceOptions }: Props) {
  const [state, setState] = useState<FloatingState | null>(null)
  const [local, setLocal] = useState<Local | null>(null)
  const [menu, setMenu] = useState<Point | null>(null)
  const [body, setBody] = useState<ViewReport | null>(null)
  const view = useViewport()
  const panel = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const stopDrag = useRef<(() => void) | null>(null)

  useState(() => {
    injectWorkspaceStyles(document)
    injectFloatingStyles(document)
  })

  useEffect(() => {
    let live = true
    // a read answered after a newer event describes an older daemon state and must not replace it
    let eventSeq = 0
    let settingSeq = 0
    let settingEnabled = false
    const load = () => {
      const eventAtStart = eventSeq
      const settingAtStart = settingSeq
      void context
        .call('quirky.terminal/floating')
        .then((next) => {
          if (!live || eventAtStart !== eventSeq) return
          const read = next as FloatingState
          setState(settingAtStart === settingSeq ? read : { ...read, enabled: settingEnabled })
        })
        .catch((error) => context.log(`floating state: ${messageOf(error)}`))
    }
    load()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      const data = (event as { data?: { state?: FloatingState } }).data
      if (event.type === FLOATING_EVENT && data?.state) {
        eventSeq += 1
        setState(data.state)
      } else if (event.type === 'setting.changed' && terminalSettingName(event.id) === 'floating-enabled') {
        settingSeq += 1
        settingEnabled = event.value === true
        setState((held) => (held ? { ...held, enabled: settingEnabled } : held))
      }
    })
    const unwatch = context.onConnection((status) => status === 'connected' && load())
    return () => {
      live = false
      unsubscribe()
      unwatch()
      stopDrag.current?.()
    }
  }, [context])

  const showPanel = state !== null && state.enabled && state.open

  useEffect(() => {
    report?.({
      shown: showPanel,
      state,
      layout: showPanel ? (body?.layout ?? null) : null,
      focusedPane: showPanel ? (body?.focusedPane ?? null) : null,
      panes: showPanel ? (body?.panes ?? []) : [],
      visibleSessions: showPanel ? (body?.visibleSessions ?? []) : []
    })
  }, [report, state, showPanel, body])

  useEffect(() => {
    const element = panel.current
    if (!showPanel || !element) return
    const doc = element.ownerDocument
    const hold = (value: boolean) => {
      setFloatingFocus(value)
      context.setContext('floatingFocus', value)
    }
    const onFocusIn = (event: FocusEvent) => hold(element.contains(event.target as Node))
    const onFocusOut = (event: FocusEvent) => {
      if (!event.relatedTarget || !element.contains(event.relatedTarget as Node)) hold(false)
    }
    doc.addEventListener('focusin', onFocusIn)
    element.addEventListener('focusout', onFocusOut)
    if (!element.contains(doc.activeElement)) element.focus({ preventScroll: true })
    hold(element.contains(doc.activeElement))
    return () => {
      doc.removeEventListener('focusin', onFocusIn)
      element.removeEventListener('focusout', onFocusOut)
      hold(false)
    }
  }, [context, showPanel])

  if (state === null || !state.enabled) return null

  const send = async (patch: Record<string, unknown>) => {
    try {
      setState((await context.call('quirky.terminal/setFloating', patch)) as FloatingState)
    } catch (error) {
      context.toast('Could not change the floating workspace', messageOf(error))
    }
  }

  const bounds = local?.bounds ?? resolveBounds(state, view)
  const button = local?.button ?? (state.button ? clampButton(state.button, view) : defaultButton(view))

  const dragPanel = (event: ReactMouseEvent) => {
    if (event.button !== 0 || state.maximized || (event.target as HTMLElement).closest('button')) return
    const start = bounds
    let latest = start
    stopDrag.current = trackMouse(
      { x: event.clientX, y: event.clientY },
      (dx, dy) => {
        latest = moveBounds(start, dx, dy, view)
        setLocal({ bounds: latest })
      },
      async () => {
        if (!same(latest, start)) await send({ bounds: latest })
        setLocal(null)
      }
    )
  }

  const resizePanel = (edge: Edge, event: ReactMouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    const start = bounds
    const workspace = controllerFor(FLOATING_WORKSPACE)
    let latest = start
    workspace?.setDragging(true)
    stopDrag.current = trackMouse(
      { x: event.clientX, y: event.clientY },
      (dx, dy) => {
        latest = resizeBounds(start, edge, dx, dy, view)
        setLocal({ bounds: latest })
      },
      async () => {
        if (!same(latest, start)) await send({ bounds: latest })
        setLocal(null)
        workspace?.setDragging(false)
      }
    )
  }

  const dragButton = (event: ReactMouseEvent) => {
    if (event.button !== 0) return
    const start = button
    let latest = start
    let moved = false
    stopDrag.current = trackMouse(
      { x: event.clientX, y: event.clientY },
      (dx, dy) => {
        if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
        moved = true
        latest = clampButton({ x: start.x + dx, y: start.y + dy }, view)
        setLocal({ button: latest })
      },
      async () => {
        suppressClick.current = moved
        if (moved) await send({ button: latest })
        setLocal(null)
      }
    )
  }

  const onButtonClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    void send({ open: !state.open })
  }

  return (
    <>
      {showPanel ? (
        <div
          ref={panel}
          className={`qf-panel${state.maximized ? ' qf-maximized' : ''}`}
          role="dialog"
          aria-label="Floating Workspace"
          data-floating-panel
          tabIndex={-1}
          style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
        >
          <div className="qf-titlebar" data-floating-titlebar onMouseDown={dragPanel} onDoubleClick={() => void send({ maximized: !state.maximized })}>
            <span>Floating Workspace</span>
            <div className="qf-controls">
              <button type="button" className="qf-control" aria-label={state.maximized ? 'Restore' : 'Maximize'} title={state.maximized ? 'Restore' : 'Maximize'} onClick={() => void send({ maximized: !state.maximized })}>
                <Icon path={state.maximized ? RESTORE : MAXIMIZE} />
              </button>
              <button type="button" className="qf-control" aria-label="Minimize" title="Minimize" onClick={() => void send({ open: false })}>
                <Icon path={MINIMIZE} />
              </button>
            </div>
          </div>
          <PanelBody context={context} options={workspaceOptions} onReport={setBody} />
          {state.maximized ? null : EDGES.map((edge) => <div key={edge} className={`qf-edge qf-edge-${edge}`} data-edge={edge} onMouseDown={(event) => resizePanel(edge, event)} />)}
        </div>
      ) : null}
      <button
        type="button"
        className={`qf-button${local?.button ? ' qf-dragging' : ''}`}
        data-floating-button
        aria-label={state.open ? 'Minimize floating workspace' : 'Show floating workspace'}
        aria-pressed={state.open}
        title={`${state.open ? 'Minimize' : 'Show'} floating workspace (⌘⌥A)`}
        style={{ left: button.x, top: button.y, width: BUTTON_SIZE, height: BUTTON_SIZE }}
        onMouseDown={dragButton}
        onClick={onButtonClick}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
      >
        <Icon path={PANELS} />
      </button>
      {menu ? (
        <div className="qf-menu-layer">
          <Menu
            items={[{ label: 'Hide Floating Workspace', onSelect: () => void context.call('setting.set', { id: ENABLED_SETTING, value: false }).catch((error) => context.toast('Could not hide the floating workspace', messageOf(error))) }]}
            label="Floating workspace"
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
          />
        </div>
      ) : null}
    </>
  )
}
