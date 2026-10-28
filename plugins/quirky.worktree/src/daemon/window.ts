import type { UiLayout } from '@quirky/protocol'

type RecordValue = Record<string, unknown>
export type WindowEnv = {
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): Error
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
}
export type SelectedWindow = { connId: number; windowCount: number; layout: UiLayout; view: NonNullable<UiLayout['view']> | null }

function recordOf(value: unknown): RecordValue | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : null
}

function connIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const ids: number[] = []
  for (const item of value) {
    const window = recordOf(item)
    if (!window || typeof window.connId !== 'number' || !Number.isSafeInteger(window.connId) || window.connId < 1) return null
    ids.push(window.connId)
  }
  return ids
}

function layoutOf(value: unknown): UiLayout | null {
  const state = recordOf(value)
  const layout = recordOf(state?.layout)
  if (!layout || !('view' in layout)) return null
  return layout as UiLayout
}

/** Resolve only a live kernel UI connId; an omitted selector is compatible only with one window. */
export async function selectWindow(env: WindowEnv, selector?: unknown): Promise<SelectedWindow> {
  if (selector !== undefined && (typeof selector !== 'number' || !Number.isSafeInteger(selector) || selector < 1)) {
    throw env.fail('invalid-params', 'window must be a positive live UI connection ID')
  }

  let state: unknown
  try {
    state = await env.call('ui.state')
  } catch (error) {
    throw env.fail('conflict', `Workspace window state is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const current = recordOf(state)
  const ids = connIds(current?.windows)
  if (!ids) throw env.fail('conflict', 'Workspace navigation requires authoritative connected-window identities.')

  let connId: number
  if (selector === undefined) {
    if (ids.length !== 1) {
      throw env.fail('conflict', ids.length === 0
        ? 'Workspace navigation requires one connected UI window.'
        : 'Workspace navigation is ambiguous because multiple windows are connected; select a window.')
    }
    connId = ids[0]!
  } else {
    connId = selector
    if (!ids.includes(connId)) throw env.fail('not-found', `UI window connection ${connId} is not live.`)
  }

  let selected: unknown
  try {
    selected = await env.call('ui.window.state', { connId })
  } catch (error) {
    throw env.fail('not-found', `UI window connection ${connId} is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const selectedState = recordOf(selected)
  if (selectedState?.connId !== connId) throw env.fail('conflict', 'The UI window state did not match the selected connection.')
  const layout = layoutOf(selected)
  if (!layout) throw env.fail('conflict', 'The selected UI window did not expose its canonical layout.')
  return { connId, windowCount: ids.length, layout, view: layout.view ?? null }
}

/** Create may proceed with no connected windows, but never guess an ambiguous navigation target. */
export async function preflightCreateWindow(env: WindowEnv, selector?: unknown): Promise<SelectedWindow | null> {
  if (selector !== undefined) return selectWindow(env, selector)
  const state = await env.call('ui.state')
  const ids = connIds(recordOf(state)?.windows)
  if (ids?.length === 0) return null
  return selectWindow(env)
}

export function openWindowView(env: WindowEnv, connId: number, id: string, input?: unknown): Promise<unknown> {
  return env.call('ui.window.view.open', { connId, id, ...(input === undefined ? {} : { input }) })
}

export function closeWindowView(env: WindowEnv, selected: SelectedWindow & { view: NonNullable<UiLayout['view']> }): Promise<unknown> {
  return env.call('ui.window.view.close', { connId: selected.connId, expectedView: selected.view })
}

