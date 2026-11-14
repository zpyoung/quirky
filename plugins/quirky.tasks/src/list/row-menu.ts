import type { UiPluginContext } from '@quirky/protocol'

export const ROW_MENU_COMMAND = 'command:quirky.tasks/row-menu'

export type RowMenuRequest = { worktree: string; kind: 'issue' | 'pullRequest'; number: number; x?: number; y?: number }
export type RowMenuResult = { delivered: number }

/** Returns true when the panel shows the row and opened its menu. */
export type RowMenuHandler = (request: RowMenuRequest) => boolean

const handlersByContext = new WeakMap<UiPluginContext, Set<RowMenuHandler>>()
const identityError = 'row-menu needs a worktree, a kind of issue or pullRequest, and a positive integer number.'
const pointError = 'row-menu needs both x and y as finite numbers, or neither.'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function parseRowMenuRequest(input: unknown): RowMenuRequest {
  const raw = record(input)
  if (
    !raw ||
    typeof raw.worktree !== 'string' || raw.worktree.length === 0 ||
    (raw.kind !== 'issue' && raw.kind !== 'pullRequest') ||
    typeof raw.number !== 'number' || !Number.isSafeInteger(raw.number) || raw.number < 1
  ) throw new Error(identityError)

  const hasX = raw.x !== undefined
  const hasY = raw.y !== undefined
  if (hasX !== hasY || (hasX && (typeof raw.x !== 'number' || !Number.isFinite(raw.x) || typeof raw.y !== 'number' || !Number.isFinite(raw.y)))) {
    throw new Error(pointError)
  }

  return {
    worktree: raw.worktree,
    kind: raw.kind,
    number: raw.number,
    ...(hasX ? { x: raw.x as number, y: raw.y as number } : {})
  }
}

export function registerRowMenu(context: UiPluginContext, handler: RowMenuHandler): () => void {
  let handlers = handlersByContext.get(context)
  if (!handlers) {
    handlers = new Set<RowMenuHandler>()
    handlersByContext.set(context, handlers)
  }
  handlers.add(handler)

  let active = true
  return function unregisterRowMenu() {
    if (!active) return
    active = false
    const registered = handlersByContext.get(context)
    if (!registered) return
    registered.delete(handler)
    if (registered.size === 0) handlersByContext.delete(context)
  }
}

export function runRowMenu(context: UiPluginContext, input: unknown): RowMenuResult {
  const request = parseRowMenuRequest(input)
  const handlers = handlersByContext.get(context)
  if (!handlers) return { delivered: 0 }

  let delivered = 0
  for (const handler of handlers) {
    if (handler(request)) delivered += 1
  }
  return { delivered }
}
