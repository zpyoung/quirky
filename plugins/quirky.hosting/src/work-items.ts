import type { Handler, HostingEnv } from './env'
import { itemDetailMethods } from './item-details'
import { itemMutationMethods } from './item-mutations'
import { itemSearchMethods } from './item-search'
import { projectMutationMethods } from './project-mutations'
import { projectMethods } from './project-methods'
import { projectTableMethods } from './project-table'
import { taskPageMethods } from './task-page'

export function workItemMethods(env: HostingEnv): Record<string, Handler> {
  return {
    ...itemSearchMethods(env),
    ...taskPageMethods(env),
    ...itemDetailMethods(env),
    ...itemMutationMethods(env),
    ...projectMethods(env),
    ...projectTableMethods(env),
    ...projectMutationMethods(env)
  }
}
