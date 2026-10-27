import type { PluginContext } from '@quirky/protocol'
import type { FakeWorld } from '../world'

type StructuredGlobals = typeof globalThis & { __structuredFakes?: FakeWorld }

export function activate(context: PluginContext): void {
  const world = (globalThis as StructuredGlobals).__structuredFakes
  if (!world) throw new Error('the structured test world is not installed')
  context.provide('method:quirky.accounts/prepare', (params: Record<string, unknown>) => world.prepareAccount(params, context))
}
