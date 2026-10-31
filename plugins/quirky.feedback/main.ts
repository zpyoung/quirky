import type { PluginContext } from '@quirky/protocol'
import { FeedbackStore } from './src/store'

export function activate(context: PluginContext): void {
  const store = new FeedbackStore(context)
  const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
    list: () => store.list(),
    add: (params) => store.add(params),
    update: (params) => store.update(params),
    remove: (params) => store.remove(params),
    clear: () => store.clear()
  }
  for (const [name, handler] of Object.entries(methods)) {
    context.provide(`method:${context.pluginId}/${name}`, handler)
  }
}
