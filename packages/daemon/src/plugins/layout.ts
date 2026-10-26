import type { UiLayout, UiState } from '@quirky/protocol'
import { internal } from '../errors'
import type { ClientConn } from '../types'

const notImplemented = (name: string) => internal(`not implemented: LayoutService.${name}`)

/** The daemon's record of the window layout, the connected windows and their slot reports. */
export class LayoutService {
  /** The layout, the windows and the per-slot reports. */
  state(): UiState {
    return { windows: [], layout: { view: null, panel: null, sidebar: true, focus: null }, slots: [] }
  }

  openView(_id: string, _input?: unknown): UiLayout {
    throw notImplemented('openView')
  }

  closeView(): UiLayout {
    throw notImplemented('closeView')
  }

  openPanel(_id: string): UiLayout {
    throw notImplemented('openPanel')
  }

  closePanel(): UiLayout {
    throw notImplemented('closePanel')
  }

  setSidebar(_visible: boolean): UiLayout {
    throw notImplemented('setSidebar')
  }

  focus(_target: 'sidebar' | 'view' | 'panel'): UiLayout {
    throw notImplemented('focus')
  }

  /** Keeps a window's report for a slot; `null` clears it. */
  report(_conn: ClientConn, _slot: string, _state: unknown): void {
    throw notImplemented('report')
  }

  windowFocused(_conn: ClientConn, _focused: boolean): void {
    throw notImplemented('windowFocused')
  }

  /** Routes a UI command to one open window and resolves with its reply. */
  runCommand(_id: string, _args: unknown): Promise<{ result: unknown }> {
    throw notImplemented('runCommand')
  }

  commandReply(
    _conn: ClientConn,
    _requestId: string,
    _reply: { result?: unknown; error?: { message: string } }
  ): void {
    throw notImplemented('commandReply')
  }

  /** Forgets a disconnected window's reports and fails commands routed to it. */
  dropConnection(_conn: ClientConn): void {}
}
