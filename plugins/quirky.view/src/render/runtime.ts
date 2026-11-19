import { createContext, useContext } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { ViewSurface } from '../core/contract'

export type ViewRuntime = {
  /** Sends the action to the agent; resolves false, after telling the person, when it could not be sent. */
  send(name: string, source: 'button' | 'field', data?: Record<string, unknown>): Promise<boolean>
  /** Asks the person to confirm before the link opens. */
  openLink(href: string): void
  /** The window's plugin context; null outside a card, where only inert content is drawn. */
  context: UiPluginContext | null
  viewId: string
  /** The session that owns the view; image paths are relative to it. */
  session: string
  /** The version the card is drawing. */
  version: number
  surface: ViewSurface
  /** Whether this card is the focused or expanded one, which is the one that may hold the native browser view. */
  focused: boolean
  /** Keys of the nodes that differ from the previous version, empty when there is nothing to compare. */
  changed: ReadonlySet<string>
  /** Tells the card a diagram, image or html node of this version could not be drawn. */
  renderFailed(error: string): void
  /** Points at an element from somewhere a click cannot be read, such as inside a frame. */
  point(element: string, label: string): void
  /** Runs a card action, such as showing a preview, through the view's control command so it can be scripted. */
  control(args: { action: 'show-preview' | 'reload-preview'; node: string }): void
}

const NONE: ReadonlySet<string> = new Set()

const INERT: ViewRuntime = {
  send: async () => false,
  openLink: () => {},
  context: null,
  viewId: '',
  session: '',
  version: 1,
  surface: 'inline',
  focused: false,
  changed: NONE,
  renderFailed: () => {},
  point: () => {},
  control: () => {}
}

export const RuntimeContext = createContext<ViewRuntime>(INERT)

export const useRuntime = (): ViewRuntime => useContext(RuntimeContext)
