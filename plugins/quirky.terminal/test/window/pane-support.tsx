import { createRef } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Terminal } from '@xterm/xterm'
import { DEFAULT_PANE_SETTINGS, type PaneSettings } from '../../src/window/pane/settings'
import type { PaneReport, TerminalPaneHandle, TerminalPaneProps } from '../../src/window/pane/TerminalPaneView'
import { fakeContext, paneHandlers, settle, type FakeContext } from '../ui-fake'

type PaneModule = typeof import('../../src/window/pane/TerminalPaneView')
type XtermModule = typeof import('@xterm/xterm')

let pane: PaneModule
let xterm: XtermModule
let restoreOpen: (() => void) | null = null
let restoreCanvas: (() => void) | null = null
export const terminals: Terminal[] = []

/** Registers happy-dom and loads the pane after it, since xterm reads `window` when imported. */
export async function loadPane(): Promise<void> {
  GlobalRegistrator.register()
  // happy-dom has no canvas; xterm's overview ruler needs a 2d context to open, and WebGL stays unavailable
  const getContext = HTMLCanvasElement.prototype.getContext
  const context2d = new Proxy({}, { get: () => () => ({ width: 0 }), set: () => true })
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
    return type === '2d' ? context2d : null
  } as typeof getContext
  restoreCanvas = () => {
    HTMLCanvasElement.prototype.getContext = getContext
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  xterm = await import('@xterm/xterm')
  pane = await import('../../src/window/pane/TerminalPaneView')
}

export async function unloadPane(): Promise<void> {
  restoreCanvas?.()
  await GlobalRegistrator.unregister()
}

/** Starts recording every terminal that gets opened; call `stopRecording` afterwards. */
export function startRecording(): void {
  terminals.length = 0
  const open = xterm.Terminal.prototype.open
  xterm.Terminal.prototype.open = function (this: Terminal, element: HTMLElement) {
    terminals.push(this)
    return open.call(this, element)
  }
  restoreOpen = () => {
    xterm.Terminal.prototype.open = open
  }
}

export function stopRecording(): void {
  restoreOpen?.()
  restoreOpen = null
}

export function settings(over: Partial<PaneSettings> = {}): PaneSettings {
  return { ...DEFAULT_PANE_SETTINGS, ...over }
}

export type MountedPane = Awaited<ReturnType<typeof mountPane>>

/**
 * Mounts a pane for session `s1` into a fresh element with the fake daemon's handlers and
 * returns its handle, the reports it made and a way to re-render it with new props.
 */
export async function mountPane(fake: FakeContext, over: Partial<TerminalPaneProps> = {}) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  const handle = createRef<TerminalPaneHandle>()
  const reports: PaneReport[] = []
  let props: TerminalPaneProps = {
    context: fake.context,
    sessionId: 's1',
    cwd: '/tmp/w/api',
    settings: settings(),
    active: true,
    interactive: true,
    dragging: false,
    onState: (state) => void reports.push(state),
    ...over
  }
  const render = (next: Partial<TerminalPaneProps> = {}) => {
    props = { ...props, ...next }
    return act(async () => root.render(<pane.TerminalPaneView {...props} ref={handle} />))
  }
  await render()
  await settle()
  const term = () => [...terminals].reverse().find((candidate) => element.contains(candidate.element ?? null))!
  return {
    element,
    handle: () => handle.current!,
    reports,
    lastReport: () => reports.at(-1)!,
    rerender: render,
    term,
    textarea: () => term().textarea!,
    /** Resolves once xterm has parsed everything written so far. */
    flush: () => new Promise<void>((resolve) => term().write('', resolve)),
    unmount: () => act(async () => root.unmount())
  }
}

export { fakeContext, paneHandlers, settle }
