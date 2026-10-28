import { formatContributionId, type PluginContext } from '@quirky/protocol'
import { coreMethods, createTasksEnv } from './src/env'
import { listMethods } from './src/list/methods'
import { issueMethods } from './src/issue/methods'
import { projectMethods } from './src/projects/methods'
import type { TaskMethodTable } from './src/contracts'

export function activate(context: PluginContext): void {
  const env = createTasksEnv(context)
  const methods: TaskMethodTable = {}
  for (const table of [coreMethods(env), listMethods(env), issueMethods(env), projectMethods(env)]) {
    for (const [name, handler] of Object.entries(table)) {
      if (Object.hasOwn(methods, name)) throw new Error(`Duplicate Tasks method: ${name}`)
      methods[name] = handler
    }
  }
  for (const [name, handler] of Object.entries(methods)) context.provide(formatContributionId('method', context.pluginId, name), handler)
}
