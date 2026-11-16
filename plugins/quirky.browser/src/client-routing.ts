import type { PluginCaller } from '@quirky/protocol'
import type { BrowserPage } from './profiles/store'
import { fault } from './runtime/errors'

export type RoutingCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>
export type ClientSelector = 'caller' | number

type RecordValue = Record<string, unknown>
type WindowCandidate = { connId: number; focused: boolean }

export type RevealSteps = {
  call: RoutingCall
  revealPage(page: BrowserPage): Promise<{ pane: string; opened: boolean }>
  closePane(pane: string): Promise<void>
}

function recordOf(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function windowsOf(value: unknown): WindowCandidate[] {
  const windows = recordOf(value)?.windows
  if (!Array.isArray(windows)) return []
  return windows.flatMap((value) => {
    const window = recordOf(value)
    const connId = window?.connId
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) return []
    return [{ connId, focused: window?.focused === true }]
  })
}

function unavailable(detail: string): never {
  throw fault('browser_client_unavailable', detail)
}

function ambiguous(connIds: number[]): never {
  const ids = connIds.sort((left, right) => left - right).join(', ')
  throw fault('browser_client_ambiguous', `windows ${ids} are connected and none is identified as the caller's; pass client <id>`)
}

/** Accepts caller or a canonical positive safe-integer ID; rejects other values with invalid_argument. */
export function parseClientSelector(value: unknown): ClientSelector {
  if (value === 'caller') return value
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const connId = Number(value)
    if (Number.isSafeInteger(connId)) return connId
  }
  throw fault('invalid_argument', 'client must be caller or a live window connection ID')
}

/**
 * Chooses an explicit live window, the caller's window/worktree, or the sole remaining window.
 * Focus breaks ties only within the caller's worktree; unavailable or ambiguous targets fail without mutation.
 */
export async function selectClient(call: RoutingCall, selector: ClientSelector, caller: PluginCaller): Promise<number> {
  const windows = windowsOf(await call('ui.state'))
  const connIds = windows.map(({ connId }) => connId)

  if (typeof selector === 'number') {
    if (!connIds.includes(selector)) return unavailable(`window ${selector} is not connected`)
    return selector
  }

  const callerConnId = caller.role === 'plugin' ? undefined : caller.connection?.id
  if (callerConnId !== undefined && connIds.includes(callerConnId)) return callerConnId
  if (windows.length === 0) return unavailable('no Quirky window is connected to show the page')

  const callerWorktree = caller.role === 'plugin' ? undefined : caller.worktreeId
  if (callerWorktree === undefined) {
    if (windows.length === 1) return windows[0]!.connId
    return ambiguous(connIds)
  }

  const available: WindowCandidate[] = []
  const showingCallerWorktree: WindowCandidate[] = []
  for (const window of windows.sort((left, right) => left.connId - right.connId)) {
    try {
      const state = recordOf(await call('ui.window.state', { connId: window.connId }))
      available.push(window)
      const layout = recordOf(state?.layout)
      if (layout?.worktree === callerWorktree) showingCallerWorktree.push(window)
    } catch {
      continue
    }
  }

  if (showingCallerWorktree.length === 1) return showingCallerWorktree[0]!.connId
  if (showingCallerWorktree.length > 1) {
    const focused = showingCallerWorktree.filter((window) => window.focused)
    if (focused.length === 1) return focused[0]!.connId
    return ambiguous(showingCallerWorktree.map(({ connId }) => connId))
  }

  if (available.length === 0) return unavailable('no Quirky window is connected to show the page')
  if (available.length === 1) return available[0]!.connId
  return ambiguous(available.map(({ connId }) => connId))
}

/** Shows one window's worktree or the shared floating workspace without OS focus; reports display failures as browser_client_unavailable. */
export async function showWorktreeOnClient(call: RoutingCall, connId: number, worktreeId: string): Promise<void> {
  if (worktreeId === 'floating') {
    try {
      await call('quirky.terminal/setFloating', { open: true })
    } catch {
      unavailable('the floating workspace could not be opened before the page was shown')
    }
    return
  }

  try {
    await call('ui.window.view.open', {
      connId,
      id: 'view:quirky.session/worktree',
      input: { worktree: worktreeId }
    })
  } catch {
    unavailable(`window ${connId} disconnected before the page was shown`)
  }
}

/** Reveals an existing worktree page, preserving its pane and selection if display fails; rejects unscoped pages before mutation. */
export async function revealOnClient(steps: RevealSteps, page: BrowserPage, connId: number): Promise<{ pane: string; paneOpened: boolean; client: number }> {
  if (page.worktreeId === null) {
    throw fault('invalid_argument', `page ${page.browserPageId} belongs to no worktree, so no browser pane can show it`)
  }
  const result = await steps.revealPage(page)
  await showWorktreeOnClient(steps.call, connId, page.worktreeId)
  return { pane: result.pane, paneOpened: result.opened, client: connId }
}

/** Creates and reveals a routed page; on failure, attempts pane cleanup before page cleanup and preserves the original error. */
export async function openUrlOnClient(steps: RevealSteps & {
  createPage(): Promise<BrowserPage>
  closePage(pageId: string): Promise<void>
}, connId: number): Promise<{ browserPageId: string; pane: string; client: number }> {
  const page = await steps.createPage()
  let pane: string | undefined
  try {
    if (page.worktreeId === null) {
      throw fault('invalid_argument', `page ${page.browserPageId} belongs to no worktree, so no browser pane can show it`)
    }
    const result = await steps.revealPage(page)
    pane = result.pane
    await showWorktreeOnClient(steps.call, connId, page.worktreeId)
  } catch (error) {
    if (pane !== undefined) {
      try {
        await steps.closePane(pane)
      } catch {}
    }
    try {
      await steps.closePage(page.browserPageId)
    } catch {}
    throw error
  }
  return { browserPageId: page.browserPageId, pane: pane!, client: connId }
}
