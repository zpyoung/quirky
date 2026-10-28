import { formatContributionId, type MethodHandler, type PluginContext } from '@quirky/protocol'
import { readDirty } from './src/daemon/dirty'
import { projectActivity } from './src/daemon/projection'
import {
  ExtrasStateStore,
  KeyedSerialQueue,
  isPlainRecord,
  stateMigrations,
  validateDirtyParams,
  validateReadParams,
  validateSetParams,
  validateWorktreeParams,
  type ExtrasState
} from './src/daemon/state'

export function activate(context: PluginContext): void {
  const state = new ExtrasStateStore(context.openStore(stateMigrations()), () => Date.now())
  const mutations = new KeyedSerialQueue()

  const emitChanged = (value: ExtrasState) => {
    context.emit('changed', value)
  }

  const handlers: Record<string, MethodHandler> = {
    state(params) {
      return state.read(validateReadParams(params, context))
    },
    set(params) {
      const { client, patch } = validateSetParams(params, context)
      return mutations.run(client, () => {
        const result = state.set(client, patch)
        if (result.changed) emitChanged(result.state)
        return result.state
      })
    },
    activate(params) {
      const { client, worktree } = validateWorktreeParams(params, context)
      return mutations.run(client, async () => {
        let next: { worktreeId: string; instanceId: string } | null = null
        if (worktree !== null) {
          const resolved = await context.call('quirky.worktree/resolve', { selector: worktree })
          if (!isPlainRecord(resolved) || typeof resolved.id !== 'string' || typeof resolved.instanceId !== 'string') {
            throw context.error('not-found', 'quirky.worktree/resolve returned no canonical workspace identity')
          }
          next = { worktreeId: resolved.id, instanceId: resolved.instanceId }
        }
        const result = state.activate(client, next)
        if (result.changed) emitChanged(result.state)
        return result.state
      })
    },
    async projection(params) {
      const client = validateReadParams(params, context)
      return projectActivity(context, state.read(client), () => Date.now())
    },
    dirty(params) {
      return readDirty(context, validateDirtyParams(params, context))
    }
  }

  for (const [name, handler] of Object.entries(handlers)) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }
}
