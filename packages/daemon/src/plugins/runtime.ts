import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchHookInput, PluginStore, StoreMigration } from '@quirky/protocol'
import { conflict, internal, invalidParams, notFound } from '../errors'
import { createHandlers } from '../methods'
import type { Core } from '../service'
import type { Store } from '../store'
import { DistroService } from './distros'
import { Dispatcher } from './dispatch'
import { PluginEvents } from './events'
import type { ContextExtension, PluginHost } from './host'
import { runLaunchHooks, type LaunchAdditions } from './launch-hooks'
import { LayoutService } from './layout'
import { createPtyApi } from './pty-api'
import { Scheduler } from './scheduler'
import { openPluginStore, pluginDataDir } from './stores'
import { UiService } from './ui-service'

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
  /** Login shell that agents run under; reported by `context.launch.shell`. */
  shell: string
  /** True in safe mode: the stored distro is ignored. */
  safeMode?: boolean
  /** Stops the daemon process; `daemon.stop` calls it after replying. */
  stopDaemon: () => void
}

type LaunchInput = Omit<LaunchHookInput, 'env' | 'args'>

export type PluginRuntime = {
  extension: ContextExtension
  dispatcher: Dispatcher
  events: PluginEvents
  scheduler: Scheduler
  layout: LayoutService
  distros: DistroService
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
  const layout = new LayoutService()
  const distros = new DistroService({ home, store, plugins, log, safeMode: options.safeMode ?? false })
  const ui = new UiService({
    plugins,
    store,
    broadcast: (event) => core.broadcast(event),
    distro: () => distros.active(),
    safeMode: options.safeMode
  })
  const handlers = createHandlers(core, plugins, scheduler, ui, {
    layout,
    distros,
    install: { home, plugins, log },
    stopDaemon: options.stopDaemon
  })
  const dispatcher = new Dispatcher(handlers, plugins, log)
  const openedStores = new Map<string, OpenedStore>()
  const ptyApis = new Map<string, { revoke(): void }>()

  const extension: ContextExtension = {
    create({ id }, isRevoked) {
      const guard = () => {
        if (isRevoked()) throw new Error(`${id} is no longer active`)
      }
      const dataDir = pluginDataDir(home, id)
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      let opened: OpenedStore | undefined
      const ptyApi = createPtyApi(core.pty, id)
      ptyApis.set(id, ptyApi)
      const notImplemented = (name: string) => () => {
        throw internal(`not implemented: ${name}`)
      }

      return {
        dataDir,
        home,
        pty: ptyApi.api,
        notify: notImplemented('notify'),
        launch: {
          shell: options.shell,
          binDir: join(home, 'bin'),
          env: notImplemented('launch.env'),
          shellArgv: notImplemented('launch.shellArgv'),
          commandArgv: notImplemented('launch.commandArgv'),
          hooks: notImplemented('launch.hooks')
        },
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
        getSetting(name) {
          guard()
          return ui.valueFor(id, name)
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
      ptyApis.get(pluginId)?.revoke()
      ptyApis.delete(pluginId)
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

  return { extension, dispatcher, events, scheduler, layout, distros, prepareLaunch }
}
