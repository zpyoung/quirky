import type { PluginContext } from '@quirky/protocol'

type FakeAgent = { id: string; installed: boolean; enabled: boolean }

/**
 * Stand-in for quirky.agents: `get` returns the command a test set with `setCommand`, and `list`
 * the agents a test set with `setAgents`.
 */
export function activate(context: PluginContext): void {
  let command = '/usr/bin/false'
  // a daemon restart loses the fake's state, so a test seeds the first listing through the environment
  let agents: FakeAgent[] = JSON.parse(process.env.QUIRKY_TEST_FAKE_AGENTS ?? '[]')
  context.provide('method:quirky.agents/setCommand', (params: Record<string, unknown>) => {
    command = String(params.command)
    return true
  })
  context.provide('method:quirky.agents/setAgents', (params: Record<string, unknown>) => {
    agents = params.agents as FakeAgent[]
    return true
  })
  context.provide('method:quirky.agents/get', (params: Record<string, unknown>) => {
    if (params.agent !== 'claude') throw context.error('not-found', `no agent ${params.agent}`)
    return { id: 'claude', command, args: '' }
  })
  context.provide('method:quirky.agents/list', () => ({ agents }))
}
