import { formatContributionId, type PluginCaller, type PluginContext } from '@quirky/protocol'
import { createEnv } from './src/env'
import * as groups from './src/groups'
import { cloneRepo, createRepo, addRepo, removeRepo } from './src/projects'
import { importRepos, scan } from './src/scan'
import * as settings from './src/settings'
import { createStore } from './src/store'

type Params = Record<string, any>

export function activate(context: PluginContext): void {
  const env = createEnv(context, createStore(context))
  const provide = (name: string, handler: (params: Params, caller: PluginCaller) => unknown) =>
    context.provide(formatContributionId('method', context.pluginId, name), handler)

  provide('list', () => env.list())
  provide('add', (params) => addRepo(env, String(params.path), params.folder === true))
  provide('clone', (params) => cloneRepo(env, params as Parameters<typeof cloneRepo>[1]))
  provide('create', (params) => createRepo(env, params as Parameters<typeof createRepo>[1]))
  provide('scan', (params) => scan(env, params as Parameters<typeof scan>[1]))
  provide('import', (params) => importRepos(env, params as Parameters<typeof importRepos>[1]))
  provide('remove', (params) => removeRepo(env, String(params.repo), params.expectedLedgers as { ledgerId: string; revision: number }[] | undefined))
  provide('resolve', (params) => env.resolve(String(params.selector)))
  provide('show', (params) => settings.show(env, params as Parameters<typeof settings.show>[1]))
  provide('set', (params) => settings.set(env, params as settings.SetParams))
  provide('hooks', (params) => settings.hooks(env, params as Parameters<typeof settings.hooks>[1]))
  provide('trustHooks', (params) => settings.trustHooks(env, params as Parameters<typeof settings.trustHooks>[1]))

  provide('groupList', () => groups.groupList(env))
  provide('groupCreate', (params) => groups.groupCreate(env, params as Parameters<typeof groups.groupCreate>[1]))
  provide('groupRename', (params) => groups.groupRename(env, params as Parameters<typeof groups.groupRename>[1]))
  provide('groupDelete', (params) => groups.groupDelete(env, params as Parameters<typeof groups.groupDelete>[1]))
  provide('groupAdd', (params) => groups.groupAdd(env, params as Parameters<typeof groups.groupAdd>[1]))
  provide('groupRemove', (params) => groups.groupRemove(env, params as Parameters<typeof groups.groupRemove>[1]))
  provide('groupCollapse', (params) => groups.groupCollapse(env, params as Parameters<typeof groups.groupCollapse>[1]))
}
