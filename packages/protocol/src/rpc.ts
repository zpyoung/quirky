import type { ApiDescription } from './catalog'
import type { DistroInfo, DistroInspection, PluginInspection } from './distro'
import type { ContributionInfo, JobInfo, JobRun, PluginEvent, PluginInfo } from './plugins'
import type { SettingInfo, ThemeList, UiLayout, UiModel, UiState } from './ui'

/** Bumped on any breaking change to `Methods`, `QuirkyEvent` or the frame layout. */
export const PROTOCOL_VERSION = 2

export type ClientRole = 'desktop' | 'ui' | 'cli' | 'mobile'

type Ok = { ok: true }

/** Params a destructive method also accepts: `yes` skips the confirmation, `confirmation` names an answered ask. */
export type Confirmable = { yes?: boolean; confirmation?: string }

/**
 * Every daemon method: params in, result out. The desktop UI, the CLI and mobile all use these;
 * there is no separate IPC surface.
 */
export type Methods = {
  'client.hello': {
    params: {
      role: ClientRole
      name?: string
      protocolVersion: number
      token?: string
      cwd?: string
      sessionId?: string
      worktreeId?: string
    }
    result: { protocolVersion: number; daemonVersion: string }
  }
  'events.subscribe': { params: Record<string, never>; result: Ok }

  'status.get': {
    params: Record<string, never>
    result: {
      daemonVersion: string
      pid: number
      startedAt: number
      home: string
      ptyHost: { pid: number | null; alive: boolean }
      clients: { role: ClientRole; name?: string }[]
      safeMode: boolean
      socket: string | null
    }
  }
  /** Replies, then stops the daemon (not the PTY host). */
  'daemon.stop': { params: Record<string, never>; result: Ok }

  /** Every discovered plugin, including invalid ones, with its state and diagnostics. */
  'plugin.list': { params: Record<string, never>; result: PluginInfo[] }
  /** Only `effective` contributions unless `all` is set, which returns every declaration. */
  'plugin.contributions': {
    params: { kind?: string; pluginId?: string; all?: boolean }
    result: ContributionInfo[]
  }
  /** Clears the user's disable of plugin `id`. */
  'plugin.enable': { params: { id: string }; result: Ok }
  /** Disables plugin `id` and every plugin that depends on it. */
  'plugin.disable': { params: { id: string }; result: Ok }
  /** Reads a plugin directory's manifest and lists its contributions; runs no plugin code. */
  'plugin.inspect': { params: { path: string }; result: PluginInspection }
  /** Copies the plugin at `path` into the home and takes it into effect; destructive. */
  'plugin.install': { params: { path: string } & Confirmable; result: PluginInfo }
  /** Deletes an installed plugin and its data; destructive. */
  'plugin.uninstall': { params: { id: string } & Confirmable; result: Ok }
  /** Activates the plugin now instead of waiting for first use. */
  'plugin.activate': { params: { pluginId: string }; result: PluginInfo }
  /** Every method, event and UI command in effect with its schemas; activates no plugin. */
  'api.describe': { params: Record<string, never>; result: ApiDescription }

  /** Every scheduled job with its schedule and last run. */
  'job.list': { params: Record<string, never>; result: JobInfo[] }
  /** Runs job `id` now and resolves with the finished run. */
  'job.run': { params: { id: string }; result: JobRun }

  /** Reads a distro directory and lists everything installing it would change; installs nothing. */
  'distro.inspect': { params: { path: string }; result: DistroInspection }
  /** Installs the distro at `path` as a layer under the user's own choices; destructive. */
  'distro.install': { params: { path: string } & Confirmable; result: DistroInfo }
  'distro.list': { params: Record<string, never>; result: DistroInfo[] }
  /** Removes the distro layer and its plugins; destructive. */
  'distro.remove': { params: { id: string } & Confirmable; result: Ok }

  /** The layout, the connected windows and what each slot reports. */
  'ui.state': { params: Record<string, never>; result: UiState }
  'ui.view.open': { params: { id: string; input?: unknown }; result: UiLayout }
  'ui.view.close': { params: Record<string, never>; result: UiLayout }
  'ui.panel.open': { params: { id: string }; result: UiLayout }
  /** Configures one effective panel's desired width and/or the global activity-bar position. */
  'ui.panel.configure': {
    params: { id: string; width?: number; activityBarPosition?: 'top' | 'side' }
    result: UiLayout
  }
  'ui.panel.close': { params: Record<string, never>; result: UiLayout }
  'ui.sidebar.set': { params: { visible: boolean }; result: UiLayout }
  'ui.focus': { params: { target: 'sidebar' | 'view' | 'panel' }; result: UiLayout }
  /** Runs a plugin UI command in one open window and returns its result. */
  'ui.command.run': { params: { id: string; args?: unknown }; result: { result: unknown } }
  /** A window reports what a mounted slot shows (`null` clears it); role `ui` only. */
  'ui.report': { params: { slot: string; state: unknown | null }; result: Ok }
  /** A window tells the daemon whether it has focus; role `ui` only. */
  'ui.window.focused': { params: { focused: boolean }; result: Ok }
  /** A window answers a `ui.command.request`; role `ui` only. */
  'ui.command.reply': {
    params: { requestId: string; result?: unknown; error?: { message: string } }
    result: Ok
  }

  /** The window's view of plugin UI: slots, commands, keybindings, settings, themes and module URLs. */
  'ui.contributions': { params: Record<string, never>; result: UiModel }
  /** Every plugin setting with its current value, or only those of plugin `pluginId`. */
  'setting.list': { params: { pluginId?: string }; result: SettingInfo[] }
  /** One plugin setting by full ID. */
  'setting.get': { params: { id: string }; result: SettingInfo }
  /** Validates `value` against the declaration, stores it and broadcasts `setting.changed`. */
  'setting.set': { params: { id: string; value: unknown }; result: SettingInfo }
  /** Drops the stored value so the setting reads as its default. */
  'setting.reset': { params: { id: string }; result: SettingInfo }
  /** Every available theme with the chosen and the active one. */
  'theme.list': { params: Record<string, never>; result: ThemeList }
  /** Chooses theme `id` (`default` or a theme ID) and broadcasts `theme.changed`. */
  'theme.set': { params: { id: string }; result: ThemeList }
}

export type MethodName = keyof Methods
export type ParamsOf<M extends MethodName> = Methods[M]['params']
export type ResultOf<M extends MethodName> = Methods[M]['result']

/** Pushed to clients that called `events.subscribe`, as JSON-RPC notifications named `event`. */
export type QuirkyEvent =
  | {
      type: 'notify'
      title: string
      body: string
      sessionId?: string
      worktreeId?: string
      open?: { view: string; input?: unknown }
      desktop: boolean
    }
  | { type: 'plugin.changed' }
  | { type: 'setting.changed'; id: string; value: boolean | number | string }
  | { type: 'theme.changed'; chosen: string; active: string }
  | { type: 'ui.state.changed'; layout: UiLayout }
  | { type: 'ui.command.request'; requestId: string; id: string; args: unknown }
  /** Delivered to plugin listeners only, never to clients. */
  | {
      type: 'hook.received'
      agent: string
      sessionId: string
      payload: unknown
      /** The agent process that ran the hook, when the shim reported it. */
      agentPid?: number
      /** That process's start time (`ps lstart`, UTC), to tell a reused pid from the agent. */
      agentStart?: string
      /** The hook event name when the payload carries none. */
      event?: string
    }
  | PluginEvent

export type RpcRequest = { jsonrpc: '2.0'; id: number; method: string; params?: unknown; requestId?: string }
export type RpcSuccess = { jsonrpc: '2.0'; id: number; result: unknown }
export type RpcFailure = {
  jsonrpc: '2.0'
  id: number | null
  error: { code: number; message: string; data?: unknown }
}
export type RpcNotification = { jsonrpc: '2.0'; method: 'event'; params: QuirkyEvent }

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  Unauthorized: -32001,
  NotFound: -32004,
  Conflict: -32009,
  ConfirmationRequired: -32010
} as const

/** WebSocket path on the daemon's loopback port; auth is `?token=<runtime token>`. */
export const RPC_PATH = '/rpc'
/** Agent hooks POST here: `/hook/<agent>?session=<id>` with header `x-quirky-hook-token`. */
export const HOOK_PATH_PREFIX = '/hook/'
export const HOOK_TOKEN_HEADER = 'x-quirky-hook-token'
