import type { UiPluginContext } from '@quirky/protocol'

export type WindowCommandDescriptor = { command: string; args: Record<string, unknown> }

type CachedConnection = number | Promise<number>

const connections = new WeakMap<UiPluginContext, CachedConnection>()
const watchedContexts = new WeakSet<UiPluginContext>()

async function connectionId(context: UiPluginContext): Promise<number> {
  if (!watchedContexts.has(context)) {
    context.onConnection(() => connections.delete(context))
    watchedContexts.add(context)
  }
  const cached = connections.get(context)
  if (typeof cached === 'number') return cached
  if (cached) return cached

  let pending!: Promise<number>
  pending = context.call('ui.window.self', {}).then((value) => {
    if (connections.get(context) !== pending) throw new Error('No live window connection is available.')
    const connId = (value as { connId?: unknown } | null)?.connId
    if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId < 1) {
      throw new Error('No live window connection is available.')
    }
    connections.set(context, connId)
    return connId
  }).catch((error: unknown) => {
    if (connections.get(context) === pending) connections.delete(context)
    throw error
  })
  connections.set(context, pending)
  return pending
}

/** Runs a command in this context's live window without replaying a failed action. */
export async function requestWindowCommand(context: UiPluginContext, descriptor: WindowCommandDescriptor): Promise<unknown> {
  const connId = await connectionId(context)
  if (connections.get(context) !== connId) throw new Error('No live window connection is available.')
  let reply: unknown
  try {
    reply = await context.call('ui.window.command.run', {
      connId,
      id: descriptor.command,
      args: descriptor.args
    })
  } catch (error) {
    if (connections.get(context) === connId) connections.delete(context)
    throw error
  }

  const result = (reply as { result?: unknown } | null)?.result
  if (typeof result === 'object' && result !== null && !Array.isArray(result) &&
      'ok' in result && result.ok === false && 'reason' in result && typeof result.reason === 'string') {
    throw new Error(result.reason)
  }
  return result
}

export function searchCommand(pane: string, options: { query?: string; regex?: boolean; caseSensitive?: boolean }): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal/search', args: { pane, ...options } }
}

export function searchNextCommand(pane: string): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal/search-next', args: { pane } }
}

export function searchPreviousCommand(pane: string): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal/search-previous', args: { pane } }
}

export function searchCloseCommand(pane: string): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal/search-close', args: { pane } }
}

export function copyTextCommand(text: string): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal/copy', args: { text } }
}

export function dockFocusCommand(pane: string): WindowCommandDescriptor {
  return { command: 'command:quirky.terminal-dock/focus', args: { pane } }
}
