import { mkdirSync } from 'node:fs'
import type { LaunchHookInput, PluginStore, StoreMigration } from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import { createHandlers } from '../methods'
import type { Core } from '../service'
import type { Store } from '../store'
import { Dispatcher } from './dispatch'
import { PluginEvents } from './events'
import type { ContextExtension, PluginHost } from './host'
import { runLaunchHooks, type LaunchAdditions } from './launch-hooks'
import { Scheduler } from './scheduler'
import { openPluginStore, pluginDataDir } from './stores'

export type PluginRuntimeOptions = {
  home: string
  plugins: PluginHost
  core: Core
  store: Store
  log: (message: string) => void
  /** Bounds each launch hook; see `runLaunchHooks`. */
  launchHookTimeoutMs: number
  /** Longest a job timer sleeps before re-checking the clock. */
  schedulerRecheckMs?: number
}

type LaunchInput = Omit<LaunchHookInput, 'env' | 'args'>

export type PluginRuntime = {
  extension: ContextExtension
  dispatcher: Dispatcher
  events: PluginEvents
  scheduler: Scheduler
  /** Runs the launch hooks for a session about to start. Never rejects; failures yield no additions. */
  prepareLaunch(input: LaunchInput): Promise<LaunchAdditions>
}

type OpenedStore = { store: PluginStore; close(): void; migrations: number }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Composes the plugin API pieces (dispatcher, events, stores, scheduler, launch hooks) over one
 * host and core, and supplies the host with the context members it cannot build itself.
 */
export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const { home, plugins, core, store, log, launchHookTimeoutMs } = options

  const events = new PluginEvents(plugins, (event) => core.broadcast(event), log)
  const scheduler = new Scheduler({ plugins, store, log, recheckMs: options.schedulerRecheckMs })
  const dispatcher = new Dispatcher(createHandlers(core, plugins, scheduler), plugins, log)
  const openedStores = new Map<string, OpenedStore>()

  const extension: ContextExtension = {
    create({ id }, isRevoked) {
      const guard = () => {
        if (isRevoked()) throw new Error(`${id} is no longer active`)
      }
      const dataDir = pluginDataDir(home, id)
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      let opened: OpenedStore | undefined

      return {
        dataDir,
        emit(event, data) {
          guard()
          return events.emit(id, event, data)
        },
        subscribe(listener) {
          guard()
          return events.subscribe(id, listener)
        },
        call(method, params) {
          guard()
          const resolved = params ?? {}
          if (!isPlainObject(resolved)) return Promise.reject(invalidParams('params must be an object'))
          return dispatcher.dispatch(method, resolved, { pluginId: id })
        },
        openStore(migrations: StoreMigration[]) {
          guard()
          if (opened) {
            if (opened.migrations !== migrations.length) {
              throw new Error(`${id} already opened its store with ${opened.migrations} migrations`)
            }
            return opened.store
          }
          // the handle stays usable inside deactivate; extension.revoke closes it afterwards
          const created = openPluginStore({ home, pluginId: id, migrations, isActive: () => true })
          opened = { ...created, migrations: migrations.length }
          openedStores.set(id, opened)
          return opened.store
        },
        error(kind, message) {
          guard()
          if (kind === 'invalid-params') return invalidParams(message)
          if (kind === 'not-found') return notFound(message)
          if (kind === 'conflict') return conflict(message)
          return new Error(message)
        }
      }
    },
    revoke(pluginId) {
      events.removeAll(pluginId)
      scheduler.revokePlugin(pluginId)
      const opened = openedStores.get(pluginId)
      openedStores.delete(pluginId)
      opened?.close()
    }
  }

  const warn = (pluginId: string, message: string) => {
    plugins.addWarning(pluginId, message)
    log(`${pluginId}: ${message}`)
  }

  async function prepareLaunch(input: LaunchInput): Promise<LaunchAdditions> {
    try {
      return await runLaunchHooks({ plugins, input, timeoutMs: launchHookTimeoutMs, warn })
    } catch (error) {
      log(`launch hooks failed: ${error instanceof Error ? error.message : String(error)}`)
      return { env: {}, args: [] }
    }
  }

  return { extension, dispatcher, events, scheduler, prepareLaunch }
}
