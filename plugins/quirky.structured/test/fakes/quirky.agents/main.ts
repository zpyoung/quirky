import type { PluginContext } from '@quirky/protocol'
import type { FakeWorld } from '../world'

type StructuredGlobals = typeof globalThis & { __structuredFakes?: FakeWorld }

export function activate(context: PluginContext) {
  const world = (globalThis as StructuredGlobals).__structuredFakes
  if (!world) throw new Error('the structured test world is not installed')
  context.provide('method:quirky.agents/resolveLaunch', (params: Record<string, unknown>) => world.agents.resolveLaunch(params, context))
  context.provide('method:quirky.agents/plan', (params: Record<string, unknown>) => world.agents.plan(params))
}
