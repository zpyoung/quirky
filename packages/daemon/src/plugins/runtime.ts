import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isReservedLaunchEnv,
  KERNEL_METHOD_SCHEMAS,
  type LaunchHookInput,
  type PluginStore,
  type StoreMigration
} from '@quirky/protocol'
import { conflict, invalidParams, notFound } from '../errors'
import { buildSessionEnv, commandArgv, shellArgv, shellKind } from '../launch'
import { createHandlers } from '../methods'
import type { Core } from '../service'
import type { Store } from '../store'
import type { RuntimeSessionAuthority } from '../session-authority'
import { fillConfirm } from './confirm'
import { DistroService, renderDistroInspection } from './distros'
import { Dispatcher } from './dispatch'
import { PluginEvents } from './events'
import type { ContextExtension, PluginHost } from './host'
import { runLaunchHooks, type LaunchAdditions } from './launch-hooks'
import { inspectPlugin, renderInspection, type PluginInstallDeps } from './install'
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
  sessionAuthority: RuntimeSessionAuthority
}

type LaunchInput = Omit<LaunchHookInput, 'env' | 'args' | 'jsonArgs'>

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
  const distros = new DistroService({
    home,
    store,
    plugins,
    log,
    safeMode: options.safeMode ?? false,
    broadcast: (event) => core.broadcast(event)
  })
  const installDeps: PluginInstallDeps = {
    home,
    plugins,
    log,
    distroOf: (id) => distros.list().find((distro) => distro.plugins.includes(id))?.id ?? null
  }
  const ui = new UiService({
    plugins,
    store,
    broadcast: (event) => core.broadcast(event),
    distro: () => distros.active(),
    safeMode: options.safeMode
  })
  const layout = new LayoutService({
    plugins,
    store,
    ui,
    clients: () => core.clients(),
    broadcast: (event) => core.broadcast(event),
    sendTo: (conn, event) => core.sendTo(conn, event)
  })
  const handlers = createHandlers(core, plugins, scheduler, ui, {
    layout,
    distros,
    install: installDeps,
    sessionAuthority: options.sessionAuthority,
    stopDaemon: options.stopDaemon
  })
  const confirmText = (method: 'plugin.install' | 'distro.install', params: Record<string, unknown>) =>
    fillConfirm(KERNEL_METHOD_SCHEMAS[method].destructive.confirm, params)
  const dispatcher = new Dispatcher(handlers, plugins, log, {
    store,
    resolveSessionAuthority: (conn) => options.sessionAuthority.resolveForConnection(conn),
    kernelDescribers: {
      'plugin.install': async (params) =>
        `${confirmText('plugin.install', params)}\n\n${renderInspection(inspectPlugin(installDeps, String(params.path)))}`,
      'distro.install': async (params) =>
        `${confirmText('distro.install', params)}\n\n${renderDistroInspection(await distros.inspect(String(params.path)))}`
    }
  })
  const openedStores = new Map<string, OpenedStore>()
  const ptyApis = new Map<string, { revoke(): void }>()

  const buildEnv = (input: {
    sessionId: string
    worktreeId: string
    agent: string
    envPatch?: Record<string, string | null>
    shellInit?: string
  }) =>
    buildSessionEnv({
      home,
      sessionId: input.sessionId,
      worktreeId: input.worktreeId,
      hookUrl: core.hookUrl,
      hookToken: core.hookToken,
      shell: options.shell,
      agent: input.agent,
      ...(input.shellInit === undefined ? {} : { shellInit: input.shellInit }),
      envPatch: input.envPatch ?? {}
    })

  const extension: ContextExtension = {
    create({ id }, isRevoked) {
      const guard = () => {
        if (isRevoked()) throw new Error(`${id} is no longer active`)
      }
      const dataDir = pluginDataDir(home, id)
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      let opened: OpenedStore | undefined
      const ptyApi = createPtyApi(core.pty, id, log, options.sessionAuthority)
      ptyApis.set(id, ptyApi)

      return {
        dataDir,
        home,
        pty: ptyApi.api,
        notify(notification) {
          guard()
          core.notify(notification)
        },
        launch: {
          shell: options.shell,
          binDir: join(home, 'bin'),
          env(input) {
            guard()
            const envPatch: Record<string, string | null> = {}
            for (const [name, value] of Object.entries(input.envPatch ?? {})) {
              if (!isReservedLaunchEnv(name)) envPatch[name] = value
            }
            return {
              ...buildEnv({ ...input, envPatch }),
              QUIRKY_SESSION_TOKEN: options.sessionAuthority.issueTerminalToken(input.sessionId)
            }
          },
          openStructuredLease(input) {
            guard()
            const env = buildEnv(input)
            const lease = options.sessionAuthority.openStructuredLease(id, input.sessionId)
            return {
              env: { ...env, QUIRKY_SESSION_TOKEN: lease.token },
              release: lease.release
            }
          },
          sessionIdentity(sessionId) {
            guard()
            return options.sessionAuthority.sessionIdentity(sessionId)
          },
          shellArgv() {
            guard()
            return shellArgv(home, options.shell)
          },
          shellReady() {
            guard()
            const kind = shellKind(options.shell)
            return kind === 'zsh' || kind === 'bash'
          },
          commandArgv(command) {
            guard()
            return commandArgv(home, options.shell, command)
          },
          hooks(input) {
            guard()
            return prepareLaunch(input)
          }
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
        storedSettingValue(settingId) {
          guard()
          return store.getSettingValue(settingId)?.value
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
      options.sessionAuthority.releasePlugin(pluginId)
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
