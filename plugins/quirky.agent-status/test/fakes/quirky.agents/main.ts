import type { PluginContext } from '@quirky/protocol'

type FakeAgent = { id: string; installed: boolean; enabled: boolean }
type Plan = { enterWithPaste: boolean; delayMs: number; retryMs: number | null }
type DeliverCall = { sessionId: string; agent: string; text: string; submit: boolean; ready: boolean }

const DEFAULT_PLAN: Plan = { enterWithPaste: false, delayMs: 500, retryMs: null }
const PASTE = (text: string) => `\x1b[200~${text.replace(/\r?\n/g, '\r').replaceAll('\x1b', '␛')}\x1b[201~`

/**
 * Stand-in for quirky.agents: `get` returns the command a test set with `setCommand`, `list` the
 * agents a test set with `setAgents`, `submitPlan` the plan a test set with `setPlan` (claude,
 * codex and cursor have the default one, any other agent is unknown), and `deliver` pastes into the
 * session like the real one and records the call.
 */
export function activate(context: PluginContext): void {
  let command = '/usr/bin/false'
  // a daemon restart loses the fake's state, so a test seeds the first listing through the environment
  let agents: FakeAgent[] = JSON.parse(process.env.QUIRKY_TEST_FAKE_AGENTS ?? '[]')
  const plans = new Map<string, Plan>(['claude', 'codex', 'cursor'].map((agent) => [agent, DEFAULT_PLAN]))
  const delivered: DeliverCall[] = []
  context.provide('method:quirky.agents/setCommand', (params: Record<string, unknown>) => {
    command = String(params.command)
    return true
  })
  context.provide('method:quirky.agents/setAgents', (params: Record<string, unknown>) => {
    agents = params.agents as FakeAgent[]
    return true
  })
  context.provide('method:quirky.agents/setPlan', (params: Record<string, unknown>) => {
    if (params.plan === null) plans.delete(String(params.agent))
    else plans.set(String(params.agent), { ...DEFAULT_PLAN, ...(params.plan as Partial<Plan>) })
    return true
  })
  context.provide('method:quirky.agents/get', (params: Record<string, unknown>) => {
    if (params.agent !== 'claude') throw context.error('not-found', `no agent ${params.agent}`)
    return { id: 'claude', command, args: '' }
  })
  context.provide('method:quirky.agents/list', () => ({ agents }))
  context.provide('method:quirky.agents/submitPlan', (params: Record<string, unknown>) => {
    const plan = plans.get(String(params.agent))
    if (!plan) throw context.error('not-found', `no agent ${params.agent}`)
    return plan
  })
  context.provide('method:quirky.agents/deliver', async (params: Record<string, unknown>) => {
    const call = {
      sessionId: String(params.sessionId),
      agent: String(params.agent),
      text: String(params.text),
      submit: params.submit === true,
      ready: params.ready === true
    }
    delivered.push(call)
    const alive = (await context.pty.list()).some((info) => info.sessionId === call.sessionId && info.alive)
    if (!alive) return { delivery: 'not-delivered' }
    const plan = plans.get(call.agent) ?? DEFAULT_PLAN
    context.pty.write(call.sessionId, PASTE(call.text) + (call.submit && plan.enterWithPaste ? '\r' : ''))
    return { delivery: 'pasted' }
  })
  context.provide('method:quirky.agents/delivered', () => delivered)
}
