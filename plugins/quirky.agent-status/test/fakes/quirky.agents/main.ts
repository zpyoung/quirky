import type { PluginContext } from '@quirky/protocol'

/** Stand-in for quirky.agents: `get` returns the command a test set with `setCommand`. */
export function activate(context: PluginContext): void {
  let command = '/usr/bin/false'
  context.provide('method:quirky.agents/setCommand', (params: Record<string, unknown>) => {
    command = String(params.command)
    return true
  })
  context.provide('method:quirky.agents/get', (params: Record<string, unknown>) => {
    if (params.agent !== 'claude') throw context.error('not-found', `no agent ${params.agent}`)
    return { id: 'claude', command, args: '' }
  })
}
