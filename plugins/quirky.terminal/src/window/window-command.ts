import type { UiPluginContext } from '@quirky/protocol'

export const RUN_MENU_ITEM_COMMAND = 'command:quirky.terminal/run-menu-item'
export const WORKSPACE_MENU_COMMAND = 'command:quirky.terminal/workspace-menu-action'
export type WindowCommandDescriptor = { command: string; args?: unknown }

/** Runs a UI-local action in the clicking window and preserves its result. */
export async function requestWindowCommand(context: UiPluginContext, descriptor: WindowCommandDescriptor): Promise<unknown> {
  const self = await context.call<{ connId?: number }>('ui.window.self', {})
  const connId = self?.connId
  if (typeof connId !== 'number' || !Number.isSafeInteger(connId) || connId <= 0) throw new Error('window connection is unavailable')
  const reply = await context.call<{ result: unknown }>('ui.window.command.run', { connId, id: descriptor.command, args: descriptor.args })
  return reply.result
}
