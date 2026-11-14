import type { PluginCaller, PluginContext } from '@quirky/protocol'
import { objectivePayloadSchema } from './src/contract'
import { createObjectiveHooks } from './src/hooks'
import { createObjectiveStore } from './src/store'

export async function activate(context: PluginContext): Promise<void> {
  const hooks = createObjectiveHooks(context, createObjectiveStore(context))
  for (const [name, method] of Object.entries(hooks)) {
    // heimdall owns the hook parameter contracts; only detail admits arbitrary client callers.
    const invoke = method as unknown as (params: Record<string, unknown>) => unknown
    context.provide(`method:quirky.objective/${name}`, (params: Record<string, unknown>, caller: PluginCaller) => {
      if (name !== 'detail' && (caller.role !== 'plugin' || caller.pluginId !== 'quirky.heimdall')) {
        throw context.error('invalid-params', 'only quirky.heimdall may call objective kind hooks')
      }
      return invoke(params)
    })
  }
  try {
    await context.call('quirky.heimdall/registerKind', {
      id: 'objective', displayName: 'Objective', enrollmentPayloadSchema: objectivePayloadSchema,
      hooks: Object.fromEntries(Object.keys(hooks).filter(name => name !== 'detail').map(name => [name, `quirky.objective/${name}`]))
    })
  } catch (error) {
    context.log(`Objective kind registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
