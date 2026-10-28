import {
  CATALOG_SCHEMA_VERSION,
  CONNECTION_METHODS,
  KERNEL_EVENT_SCHEMAS,
  KERNEL_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  type ApiDescription,
  type ClientRole,
  type ContributionInfo,
  type KernelMethodSchema,
  type MethodName,
  type ResultOf,
  type Schema,
  type NativeDesktopCapabilities,
  type DesktopShellReply,
  type UiLayout
} from '@quirky/protocol'
import { conflict, invalidParams } from './errors'
import { describeCli } from './plugins/cli-catalog'
import type { DistroService } from './plugins/distros'
import type { PluginHost } from './plugins/host'
import { inspectPlugin, installPlugin, uninstallPlugin, type PluginInstallDeps } from './plugins/install'
import type { LayoutService } from './plugins/layout'
import type { Scheduler } from './plugins/scheduler'
import type { UiService } from './plugins/ui-service'
import type { Core } from './service'
import type { RuntimeSessionAuthority } from './session-authority'
import type { ClientConn } from './types'

type Params = Record<string, unknown>
type Handler<M extends MethodName> = (params: Params, conn: ClientConn) => ResultOf<M> | Promise<ResultOf<M>>
export type Handlers = { [M in MethodName]: Handler<M> }

const ROLES: readonly ClientRole[] = ['desktop', 'ui', 'cli', 'mobile']
const OK = { ok: true } as const

function str(params: Params, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value === '') throw invalidParams(`${key} must be a non-empty string`)
  return value
}

function optStr(params: Params, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidParams(`${key} must be a string`)
  return value
}

function int(params: Params, key: string, min: number): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw invalidParams(`${key} must be an integer >= ${min}`)
  }
  return value
}

function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalidParams(`${key} must be a boolean`)
  return value
}

function focusTarget(params: Params): 'sidebar' | 'view' | 'panel' {
  const value = params.target
  if (value !== 'sidebar' && value !== 'view' && value !== 'panel') {
    throw invalidParams('target must be one of sidebar, view, panel')
  }
  return value
}

function nativeDesktopCapabilities(params: Params): NativeDesktopCapabilities {
  const directoryPicker = optBool(params, 'directoryPicker')
  const auxiliaryWindows = optBool(params, 'auxiliaryWindows')
  const revealItem = optBool(params, 'revealItem')
  const rawNotifications = params.notifications
  if (typeof rawNotifications !== 'object' || rawNotifications === null || Array.isArray(rawNotifications)) {
    throw invalidParams('notifications must declare permission, click, and dismiss capabilities')
  }
  const notifications = rawNotifications as Params
  const permission = optBool(notifications, 'permission')
  const click = optBool(notifications, 'click')
  const dismiss = optBool(notifications, 'dismiss')
  if (directoryPicker === undefined || auxiliaryWindows === undefined || revealItem === undefined ||
    permission === undefined || click === undefined || dismiss === undefined) {
    throw invalidParams('native desktop capabilities must include every supported operation')
  }
  if (permission || click || dismiss) throw invalidParams('native notification callbacks are unavailable in this SDK')
  return {
    directoryPicker,
    auxiliaryWindows,
    revealItem,
    notifications: { permission: false, click: false, dismiss: false }
  }
}

function desktopReplyError(params: Params): { message: string } | undefined {
  const value = params.error
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('error must contain a message')
  const message = (value as Params).message
  if (typeof message !== 'string' || message.length === 0) throw invalidParams('error.message must be a non-empty string')
  return { message }
}


function byName<T>(key: (entry: T) => string): (a: T, b: T) => number {
  return (a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

function descriptionOf(data: Record<string, unknown>): { description?: string } {
  return typeof data.description === 'string' ? { description: data.description } : {}
}

function schemaField(data: Record<string, unknown>, key: string, fallback: Schema | null): Schema | null {
  const value = data[key]
  return typeof value === 'object' && value !== null ? (value as Schema) : fallback
}

/** The kernel's schemas plus every effective method, event and UI command contribution; activates nothing. */
function describeApi(core: Core, plugins: PluginHost): ApiDescription {
  const effective = (kind: string): ContributionInfo[] => plugins.contributions({ kind })
  const shortId = (contribution: ContributionInfo) => contribution.id.slice(contribution.kind.length + 1)
  const connection: readonly string[] = CONNECTION_METHODS

  const methods: ApiDescription['methods'] = [
    ...Object.entries(KERNEL_METHOD_SCHEMAS as Record<string, KernelMethodSchema>).map(([name, entry]) => ({
      name,
      plugin: null,
      description: entry.description,
      params: entry.params,
      result: entry.result,
      ...(connection.includes(name) ? { connection: true as const } : {}),
      ...(entry.readOnly ? { readOnly: true as const } : {}),
      ...(entry.destructive ? { destructive: true as const, confirm: entry.destructive.confirm } : {})
    })),
    ...effective('method').map((contribution) => ({
      name: shortId(contribution),
      plugin: contribution.plugin,
      ...descriptionOf(contribution.data),
      params: schemaField(contribution.data, 'params', { type: 'object' })!,
      result: schemaField(contribution.data, 'result', {})!,
      ...(contribution.data.connection === true ? { connection: true as const } : {}),
      ...(contribution.data.readOnly === true ? { readOnly: true as const } : {}),
      ...(contribution.data.destructive === true ? { destructive: true as const } : {}),
      ...(typeof contribution.data.confirm === 'string' ? { confirm: contribution.data.confirm } : {})
    }))
  ]
  const events: ApiDescription['events'] = [
    ...Object.entries(KERNEL_EVENT_SCHEMAS).map(([name, entry]) => ({
      name,
      plugin: null,
      description: entry.description,
      data: entry.data as Schema | null
    })),
    ...effective('event').map((contribution) => ({
      name: shortId(contribution),
      plugin: contribution.plugin,
      ...descriptionOf(contribution.data),
      data: schemaField(contribution.data, 'data', null)
    }))
  ]
  const uiCommands: ApiDescription['uiCommands'] = effective('command').map((contribution) => ({
    id: contribution.id,
    plugin: contribution.plugin,
    title: typeof contribution.data.title === 'string' ? contribution.data.title : contribution.name,
    ...descriptionOf(contribution.data),
    args: schemaField(contribution.data, 'args', { type: 'object' })!
  }))

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    daemonVersion: core.status().daemonVersion,
    protocolVersion: PROTOCOL_VERSION,
    methods: methods.sort(byName((entry) => entry.name)),
    events: events.sort(byName((entry) => entry.name)),
    uiCommands: uiCommands.sort(byName((entry) => entry.id)),
    cli: describeCli(plugins)
  }
}

/** The services the kernel's own methods delegate to. */
export type HandlerServices = {
  layout: LayoutService
  distros: DistroService
  install: PluginInstallDeps
  /** Validates a launch-scoped session token against live kernel process evidence. */
  sessionAuthority?: RuntimeSessionAuthority
  /** Stops the daemon process; called after `daemon.stop` has replied. */
  stopDaemon: () => void
}

/** Maps every RPC method to the core or the plugin host, validating params so bad input becomes InvalidParams. */
export function createHandlers(
  core: Core,
  plugins: PluginHost,
  scheduler: Scheduler,
  ui: UiService,
  services: HandlerServices
): Handlers {
  const { layout, distros } = services
  return {
    'client.hello': async (params, conn) => {
      if (conn.deviceId !== undefined) {
        const version = int(params, 'protocolVersion', 0)
        if (version !== PROTOCOL_VERSION) {
          throw conflict(`protocol version mismatch: daemon speaks ${PROTOCOL_VERSION}, client ${version}`)
        }
        return { protocolVersion: PROTOCOL_VERSION, daemonVersion: core.status().daemonVersion }
      }
      const role = params.role
      if (typeof role !== 'string' || !ROLES.includes(role as ClientRole)) {
        throw invalidParams(`role must be one of ${ROLES.join(', ')}`)
      }
      const name = optStr(params, 'name')
      const version = int(params, 'protocolVersion', 0)
      if (version !== PROTOCOL_VERSION) {
        throw conflict(`protocol version mismatch: daemon speaks ${PROTOCOL_VERSION}, client ${version}`)
      }
      conn.role = role as ClientRole
      conn.name = name
      conn.cwd = optStr(params, 'cwd')
      conn.sessionId = optStr(params, 'sessionId')
      conn.sessionToken = optStr(params, 'sessionToken')
      conn.worktreeId = optStr(params, 'worktreeId')
      await services.sessionAuthority?.resolveForConnection(conn)
      return { protocolVersion: PROTOCOL_VERSION, daemonVersion: core.status().daemonVersion }
    },
    'events.subscribe': (_params, conn) => {
      conn.subscribed = true
      return OK
    },
    'status.get': () => core.status(),
    'daemon.stop': () => {
      setTimeout(services.stopDaemon, 0)
      return OK
    },
    'plugin.list': () => plugins.list(),
    'plugin.contributions': (params) =>
      plugins.contributions({
        kind: optStr(params, 'kind'),
        pluginId: optStr(params, 'pluginId'),
        all: optBool(params, 'all')
      }),
    'plugin.enable': async (params) => {
      await plugins.setEnabled(str(params, 'id'), true)
      return OK
    },
    'plugin.disable': async (params) => {
      await plugins.setEnabled(str(params, 'id'), false)
      return OK
    },
    'plugin.inspect': (params) => inspectPlugin(services.install, str(params, 'path')),
    'plugin.install': (params) => installPlugin(services.install, str(params, 'path')),
    'plugin.uninstall': async (params) => {
      await uninstallPlugin(services.install, str(params, 'id'))
      return OK
    },
    'plugin.activate': (params) => plugins.activate(str(params, 'pluginId')),
    'api.describe': () => describeApi(core, plugins),

    'job.list': () => scheduler.list(),
    'job.run': (params) => scheduler.run(str(params, 'id')),

    'distro.inspect': (params) => distros.inspect(str(params, 'path')),
    'distro.install': (params) => distros.install(str(params, 'path')),
    'distro.list': () => distros.list(),
    'distro.remove': async (params) => {
      await distros.remove(str(params, 'id'))
      return OK
    },

    'ui.state': () => layout.state(),
    'ui.window.self': (_params, conn) => layout.windowSelf(conn),
    'ui.window.state': (params) => layout.windowState(int(params, 'connId', 1)),
    'ui.window.view.open': (params) =>
      layout.openWindowView(int(params, 'connId', 1), str(params, 'id'), params.input),
    'ui.window.view.close': (params) =>
      layout.closeWindowView(int(params, 'connId', 1), params.expectedView as NonNullable<UiLayout['view']> | undefined),
    'ui.window.command.run': (params) =>
      layout.runCommandOnWindow(int(params, 'connId', 1), str(params, 'id'), params.args),
    'ui.palette.set': (params) => {
      const open = optBool(params, 'open')
      if (params.open !== undefined && open === undefined) throw invalidParams('open must be a boolean')
      return layout.setPalette(open)
    },
    'ui.view.open': (params) => layout.openView(str(params, 'id'), params.input),
    'ui.view.close': () => layout.closeView(),
    'ui.panel.open': (params) => layout.openPanel(str(params, 'id')),
    'ui.panel.configure': (params) =>
      layout.configurePanel(
        str(params, 'id'),
        params.width as number | undefined,
        params.activityBarPosition as 'top' | 'side' | undefined
      ),
    'ui.panel.close': () => layout.closePanel(),
    'ui.sidebar.set': (params) => {
      const visible = optBool(params, 'visible')
      if (visible === undefined) throw invalidParams('visible must be a boolean')
      return layout.setSidebar(visible)
    },
    'ui.focus': (params) => layout.focus(focusTarget(params)),
    'ui.command.run': (params) => layout.runCommand(str(params, 'id'), params.args),
    'ui.toast.dismiss': async (params) => {
      await layout.dismissToast(str(params, 'key'))
      return OK
    },
    'ui.shell.report': (params, conn) => {
      layout.reportToasts(conn, params.toasts)
      return OK
    },
    'ui.report': (params, conn) => {
      layout.report(conn, str(params, 'slot'), params.state ?? null)
      return OK
    },
    'ui.window.focused': (params, conn) => {
      const focused = optBool(params, 'focused')
      if (focused === undefined) throw invalidParams('focused must be a boolean')
      layout.windowFocused(conn, focused)
      return OK
    },
    'ui.window.activity': (_params, conn) => {
      layout.windowActivity(conn)
      return OK
    },
    'ui.command.reply': (params, conn) => {
      const error = params.error as { message?: unknown } | undefined
      layout.commandReply(conn, str(params, 'requestId'), {
        result: params.result,
        error: error && typeof error.message === 'string' ? { message: error.message } : undefined
      })
      return OK
    },

    'desktop.shell.capabilities': (params, conn) => {
      layout.setDesktopCapabilities(conn, nativeDesktopCapabilities(params))
      return OK
    },
    'desktop.shell.reply': (params, conn) => {
      const error = desktopReplyError(params)
      if ((params.result === undefined) === (error === undefined)) {
        throw invalidParams('provide exactly one of result or error')
      }
      layout.desktopShellReply(conn, {
        requestId: str(params, 'requestId'),
        ...(params.result === undefined ? {} : { result: params.result as DesktopShellReply['result'] }),
        ...(error === undefined ? {} : { error })
      })
      return OK
    },
    'desktop.capabilities': (_params, conn) => layout.desktopCapabilities(conn),
    'desktop.folder.pick': (params, conn) => {
      const title = optStr(params, 'title')
      const startingFolder = optStr(params, 'startingFolder')
      const multiple = optBool(params, 'multiple')
      return layout.pickFolder(conn, {
        ...(title === undefined ? {} : { title }),
        ...(startingFolder === undefined ? {} : { startingFolder }),
        ...(multiple === undefined ? {} : { multiple })
      })
    },
    'desktop.window.open': (params, conn) => {
      const title = optStr(params, 'title')
      return layout.openDesktopWindow(conn, {
        view: str(params, 'view'),
        ...(params.input === undefined ? {} : { input: params.input }),
        ...(title === undefined ? {} : { title })
      })
    },
    'desktop.window.list': (_params, conn) => layout.listDesktopWindows(conn),
    'desktop.window.attach': (params, conn) =>
      layout.attachDesktopWindow(conn, {
        windowId: str(params, 'windowId'),
        ownerShellConnId: int(params, 'ownerShellConnId', 1)
      }),
    'desktop.window.update': (params, conn) => {
      const view = params.view
      if (view !== null && (typeof view !== 'string' || view.length === 0)) {
        throw invalidParams('view must be a non-empty string or null')
      }
      const title = optStr(params, 'title')
      return layout.updateDesktopWindow(conn, {
        windowId: str(params, 'windowId'),
        view,
        ...(params.input === undefined ? {} : { input: params.input }),
        ...(title === undefined ? {} : { title })
      })
    },
    'desktop.window.runOwnerCommand': (params, conn) => layout.runOwnerCommand(conn, {
      windowId: str(params, 'windowId'),
      id: str(params, 'id'),
      ...(params.args === undefined ? {} : { args: params.args })
    }),
    'desktop.window.closed': (params, conn) => {
      if (conn.role !== 'desktop') throw invalidParams('only the native desktop shell can close an auxiliary window')
      return layout.desktopWindowClosed(conn, {
        windowId: str(params, 'windowId'),
        ownerShellConnId: int(params, 'ownerShellConnId', 1)
      })
    },
    'desktop.window.close': (params, conn) => layout.closeDesktopWindow(conn, str(params, 'windowId')),
    'desktop.item.reveal': (params, conn) => layout.revealDesktopItem(conn, str(params, 'path')),


    'ui.contributions': () => ui.contributions(),
    'setting.list': (params) => ui.listSettings({ pluginId: optStr(params, 'pluginId') }),
    'setting.get': (params) => ui.getSetting(str(params, 'id')),
    'setting.set': (params) => {
      const id = str(params, 'id')
      if (params.value === undefined) throw invalidParams('value is required')
      return ui.setSetting(id, params.value)
    },
    'setting.reset': (params) => ui.resetSetting(str(params, 'id')),
    'theme.list': () => ui.listThemes(),
    'theme.set': (params) => ui.setTheme(str(params, 'id')),
    'keybinding.list': () => ui.listKeybindings(),
    'keybinding.set': (params) => {
      const key = params.key
      if (key !== null && typeof key !== 'string') throw invalidParams('key must be a string or null')
      return ui.setKeybinding(str(params, 'id'), key)
    },
    'keybinding.reset': (params) => ui.resetKeybinding(str(params, 'id'))
  }
}
