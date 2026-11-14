import type { UiPluginContext } from '@quirky/protocol'

export const LIST_CONTROL_COMMAND = 'command:quirky.tasks/list-control'

export type ListControl = 'repositories' | 'filters'
export type ListControlRequest = { control: ListControl; open: boolean }
export type ListControlResult = { delivered: number }
/** Returns true when this mounted list applied the request. */
export type ListControlHandler = (request: ListControlRequest) => boolean
const identityError = 'list-control needs a control of repositories or filters, and open as true or false.'
const handlersByContext = new WeakMap<UiPluginContext, Set<ListControlHandler>>()
const connIdsByContext = new WeakMap<UiPluginContext, number>()
const pendingConnIdsByContext = new WeakMap<UiPluginContext, Promise<number>>()

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function parseListControlRequest(input: unknown): ListControlRequest {
  const raw = record(input)
  if (!raw || (raw.control !== 'repositories' && raw.control !== 'filters') || typeof raw.open !== 'boolean') {
    throw new Error(identityError)
  }
  return { control: raw.control, open: raw.open }
}

export function registerListControl(context: UiPluginContext, handler: ListControlHandler): () => void {
  let handlers = handlersByContext.get(context)
  if (!handlers) {
    handlers = new Set<ListControlHandler>()
    handlersByContext.set(context, handlers)
  }
  handlers.add(handler)

  let active = true
  return function unregisterListControl() {
    if (!active) return
    active = false
    const registered = handlersByContext.get(context)
    if (!registered) return
    registered.delete(handler)
    if (registered.size === 0) handlersByContext.delete(context)
  }
}

export function runListControl(context: UiPluginContext, input: unknown): ListControlResult {
  const request = parseListControlRequest(input)
  const handlers = handlersByContext.get(context)
  if (!handlers) return { delivered: 0 }

  let delivered = 0
  for (const handler of handlers) {
    if (handler(request)) delivered += 1
  }
  return { delivered }
}

export function listControlDescriptor(request: ListControlRequest): { command: typeof LIST_CONTROL_COMMAND; args: ListControlRequest } {
  return { command: LIST_CONTROL_COMMAND, args: request }
}

async function windowConnId(context: UiPluginContext): Promise<number> {
  const cached = connIdsByContext.get(context)
  if (cached !== undefined) return cached
  const pending = pendingConnIdsByContext.get(context)
  if (pending) return pending

  const read = Promise.resolve().then(async () => {
    const self = record(await context.call('ui.window.self', {}))
    const connId = self?.connId
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) {
      throw new Error('The daemon did not identify this UI connection.')
    }
    connIdsByContext.set(context, connId)
    return connId
  })
  pendingConnIdsByContext.set(context, read)
  try {
    return await read
  } finally {
    if (pendingConnIdsByContext.get(context) === read) pendingConnIdsByContext.delete(context)
  }
}

export async function dispatchListControl(context: UiPluginContext, request: ListControlRequest): Promise<void> {
  const connId = await windowConnId(context)
  const descriptor = listControlDescriptor(request)
  await context.call('ui.window.command.run', { connId, id: descriptor.command, args: descriptor.args })
}
