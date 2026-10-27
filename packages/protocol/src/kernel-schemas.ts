import type { MethodName, QuirkyEvent } from './rpc'
import type { PluginEvent } from './plugins'
import type { Schema } from './schema'

export type KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']

/** Kernel methods that act on the calling connection itself, so only a live client can call them. */
export const CONNECTION_METHODS = [
  'client.hello',
  'events.subscribe',
  'ui.report',
  'ui.window.focused',
  'ui.window.activity',
  'ui.command.reply'
] as const

const string = (description?: string): Schema => ({ type: 'string', ...(description ? { description } : {}) })
const integer = (minimum: number, description?: string): Schema => ({
  type: 'integer',
  minimum,
  ...(description ? { description } : {})
})
const boolean = (description?: string): Schema => ({ type: 'boolean', ...(description ? { description } : {}) })
const strings: Schema = { type: 'array', items: { type: 'string' } }

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {})
})
const listOf = (items: Schema, description?: string): Schema => ({
  type: 'array',
  items,
  ...(description ? { description } : {})
})

/** `properties` plus the `yes` and `confirmation` params every destructive method accepts. */
const destructiveParams = (properties: Record<string, Schema>, required: string[] = []): Schema =>
  object(
    {
      ...properties,
      yes: boolean('Skips the confirmation.'),
      confirmation: string('The ID of an ask answered Yes for this call.')
    },
    required
  )

const noParams: Schema = { type: 'object' }
const ok: Schema = object({ ok: { type: 'boolean' } }, ['ok'])

const pluginInfo = object(
  {
    id: string(),
    name: string(),
    version: string(),
    description: string(),
    source: { type: 'string', enum: ['builtin', 'installed'] },
    dir: string(),
    activation: { type: 'string', enum: ['lazy', 'startup'] },
    dependencies: strings,
    state: { type: 'string', enum: ['inactive', 'activating', 'active', 'failed', 'disabled', 'invalid'] },
    ui: string('Relative path of the webview module.'),
    diagnostics: listOf(object({ level: { type: 'string', enum: ['error', 'warning'] }, message: string() }))
  },
  ['id', 'name', 'version', 'source', 'dir', 'activation', 'dependencies', 'state', 'diagnostics']
)
const contributionInfo = object(
  {
    id: string(),
    kind: string(),
    name: string(),
    plugin: string('The declaring plugin.'),
    override: boolean(),
    status: { type: 'string', enum: ['effective', 'overridden', 'disabled', 'rejected'] },
    overriddenBy: string(),
    disabledBy: { type: 'string', enum: ['user', 'plugin', 'owner'] },
    disablingPlugin: string(),
    conflictWith: string(),
    data: { type: 'object', additionalProperties: true }
  },
  ['id', 'kind', 'name', 'plugin', 'override', 'status', 'data']
)
const jobRun = object(
  {
    startedAt: { type: 'number' },
    finishedAt: { description: 'When the run ended, or null while running.' },
    status: { type: 'string', enum: ['running', 'ok', 'failed', 'timed-out'] },
    error: string()
  },
  ['startedAt', 'finishedAt', 'status']
)
const jobInfo = object(
  {
    id: string(),
    plugin: string(),
    intervalMs: { type: 'number' },
    timeoutMs: { type: 'number' },
    state: { type: 'string', enum: ['idle', 'running'] },
    nextRunAt: { description: 'The next run time, or null while running.' },
    lastRun: { description: 'The last run, or null.' }
  },
  ['id', 'plugin', 'intervalMs', 'timeoutMs', 'state', 'nextRunAt', 'lastRun']
)
const settingInfo = object(
  {
    id: string(),
    plugin: string(),
    type: { type: 'string', enum: ['boolean', 'number', 'string', 'enum'] },
    title: string(),
    description: string(),
    default: {},
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    values: strings,
    value: { description: 'The current value.' },
    stored: object({ value: {}, valid: boolean() }, ['value', 'valid'])
  },
  ['id', 'plugin', 'type', 'title', 'default', 'value']
)
const themeList = object(
  {
    chosen: string('`default` or a theme ID.'),
    active: string('`default` or a theme ID.'),
    themes: listOf(
      object(
        {
          id: string(),
          plugin: { description: 'The declaring plugin; null for the built-in default.' },
          title: string(),
          appearance: { type: 'string', enum: ['dark', 'light'] },
          colors: { type: 'object', additionalProperties: true }
        },
        ['id', 'plugin', 'title', 'appearance', 'colors']
      )
    )
  },
  ['chosen', 'active', 'themes']
)
const uiKeybinding = object(
  {
    id: string(),
    plugin: string(),
    key: string('The canonical chord.'),
    command: string(),
    status: { type: 'string', enum: ['active', 'shadowed', 'unbound'] },
    shadowedBy: string('The winning keybinding ID, or `kernel` for a reserved chord.'),
    when: string('The canonical `when` condition; absent when the binding is unconditional.')
  },
  ['id', 'plugin', 'key', 'command', 'status']
)
const uiModel = object(
  {
    sidebarSections: listOf({ type: 'object' }),
    panels: listOf({ type: 'object' }),
    settingsSections: listOf({ type: 'object' }),
    views: listOf({ type: 'object' }),
    overlays: listOf({ type: 'object' }),
    commands: listOf({ type: 'object' }),
    keybindings: listOf(uiKeybinding, 'Registry precedence order: distro bindings first, then plugin bindings.'),
    settings: listOf({ type: 'object' }),
    themes: listOf({ type: 'object' }),
    theme: object({ chosen: string(), active: string() }, ['chosen', 'active']),
    modules: { type: 'object', additionalProperties: true }
  },
  ['sidebarSections', 'panels', 'settingsSections', 'views', 'overlays', 'commands', 'keybindings', 'settings', 'themes', 'theme', 'modules']
)
const apiDescription = object(
  {
    schemaVersion: { type: 'integer' },
    daemonVersion: string(),
    protocolVersion: { type: 'integer' },
    methods: listOf({ type: 'object' }),
    events: listOf({ type: 'object' }),
    uiCommands: listOf({ type: 'object' })
  },
  ['schemaVersion', 'daemonVersion', 'protocolVersion', 'methods', 'events', 'uiCommands']
)

const uiLayout = object(
  {
    view: { description: 'The open view as {id, input?}, or null.' },
    panel: { description: 'The open panel ID, or null.' },
    sidebar: boolean(),
    focus: { description: "'sidebar', 'view', 'panel' or null." }
  },
  ['view', 'panel', 'sidebar', 'focus']
)
const windowInfo = object(
  {
    connId: { type: 'integer' },
    name: string(),
    focused: boolean(),
    inputAt: { description: 'Epoch milliseconds of the last reported input, or null.' },
    present: boolean('Whether the last input is recent enough to count as at the machine.')
  },
  ['connId', 'focused', 'inputAt', 'present']
)
const uiState = object(
  {
    windows: listOf(windowInfo),
    layout: uiLayout,
    slots: listOf({ type: 'object' })
  },
  ['windows', 'layout', 'slots']
)
const distroManifest: Schema = { type: 'object', additionalProperties: true }
const pluginInspection = object(
  {
    id: string(),
    name: string(),
    version: string(),
    description: string(),
    contributions: listOf({ type: 'object' }),
    overrides: listOf({ type: 'object' }),
    disables: strings,
    installed: { type: 'object', additionalProperties: true }
  },
  ['id', 'name', 'version', 'contributions', 'overrides', 'disables']
)
const distroInfo = object(
  {
    id: string(),
    name: string(),
    version: string(),
    description: string(),
    plugins: strings,
    installedAt: { type: 'number' }
  },
  ['id', 'name', 'version', 'plugins', 'installedAt']
)
const distroInspection = object(
  { manifest: distroManifest, plugins: listOf(pluginInspection), settings: listOf({ type: 'object' }) },
  ['manifest', 'plugins', 'settings']
)

/** One kernel method's schemas and flags; `destructive.confirm` is the question asked before it runs. */
export type KernelMethodSchema = {
  description: string
  params: Schema
  result: Schema
  readOnly?: true
  destructive?: { confirm: string }
}

/** Every kernel method's params and result schema; `params` never rejects what the handler accepts. */
export const KERNEL_METHOD_SCHEMAS = {
  'client.hello': {
    description: 'Identifies this connection to the daemon and checks the protocol version.',
    params: object(
      {
        role: { type: 'string', enum: ['desktop', 'ui', 'cli', 'mobile'] },
        name: string(),
        protocolVersion: integer(0),
        token: string('The runtime token; required on the unix socket.'),
        cwd: string(),
        sessionId: string(),
        worktreeId: string()
      },
      ['role', 'protocolVersion']
    ),
    result: object({ protocolVersion: { type: 'integer' }, daemonVersion: string() }, [
      'protocolVersion',
      'daemonVersion'
    ])
  },
  'events.subscribe': {
    description: 'Starts pushing daemon events to this connection.',
    params: noParams,
    result: ok
  },
  'status.get': {
    description: 'The daemon process, its PTY host and the connected clients.',
    readOnly: true,
    params: noParams,
    result: object(
      {
        daemonVersion: string(),
        pid: { type: 'integer' },
        startedAt: { type: 'number' },
        home: string(),
        ptyHost: object({ pid: {}, alive: boolean() }, ['pid', 'alive']),
        clients: listOf(object({ role: string(), name: string() }, ['role'])),
        safeMode: boolean(),
        socket: { description: 'The unix socket path, or null when none is listening.' }
      },
      ['daemonVersion', 'pid', 'startedAt', 'home', 'ptyHost', 'clients', 'safeMode', 'socket']
    )
  },
  'daemon.stop': {
    description: 'Replies, then stops the daemon (not the PTY host).',
    params: noParams,
    result: ok
  },

  'plugin.list': {
    description: 'Every discovered plugin, including invalid ones, with its state and diagnostics.',
    readOnly: true,
    params: noParams,
    result: listOf(pluginInfo)
  },
  'plugin.contributions': {
    description: 'Only `effective` contributions unless `all` is set, which returns every declaration.',
    readOnly: true,
    params: object({ kind: string(), pluginId: string(), all: boolean() }),
    result: listOf(contributionInfo)
  },
  'plugin.enable': {
    description: "Clears the user's disable of plugin `id`.",
    params: object({ id: string() }, ['id']),
    result: ok
  },
  'plugin.disable': {
    description: 'Disables plugin `id` and every plugin that depends on it.',
    params: object({ id: string() }, ['id']),
    result: ok
  },
  'plugin.inspect': {
    description: "Reads a plugin directory's manifest and lists its contributions; runs no plugin code.",
    readOnly: true,
    params: object({ path: string() }, ['path']),
    result: pluginInspection
  },
  'plugin.install': {
    description: 'Copies the plugin at `path` into the home and takes it into effect.',
    destructive: { confirm: 'Install plugin {path}?' },
    params: destructiveParams({ path: string() }, ['path']),
    result: pluginInfo
  },
  'plugin.uninstall': {
    description: 'Deletes an installed plugin and its data.',
    destructive: { confirm: 'Uninstall plugin {id}?' },
    params: destructiveParams({ id: string() }, ['id']),
    result: ok
  },
  'plugin.activate': {
    description: 'Activates the plugin now instead of waiting for first use.',
    params: object({ pluginId: string() }, ['pluginId']),
    result: pluginInfo
  },
  'api.describe': {
    description: 'Every method, event and UI command in effect, with its schemas.',
    readOnly: true,
    params: noParams,
    result: apiDescription
  },

  'job.list': { description: 'Every scheduled job with its schedule and last run.', readOnly: true, params: noParams, result: listOf(jobInfo) },
  'job.run': {
    description: 'Runs job `id` now and resolves with the finished run.',
    params: object({ id: string() }, ['id']),
    result: jobRun
  },

  'distro.inspect': {
    description: 'Reads a distro directory and lists everything installing it would change; installs nothing.',
    readOnly: true,
    params: object({ path: string() }, ['path']),
    result: distroInspection
  },
  'distro.install': {
    description: "Installs the distro at `path` as a layer under the user's own choices.",
    destructive: { confirm: 'Install distro {path}?' },
    params: destructiveParams({ path: string() }, ['path']),
    result: distroInfo
  },
  'distro.list': { description: 'The installed distro.', readOnly: true, params: noParams, result: listOf(distroInfo) },
  'distro.remove': {
    description: 'Removes the distro layer, its plugins and their data.',
    destructive: { confirm: 'Remove distro {id}?' },
    params: destructiveParams({ id: string() }, ['id']),
    result: ok
  },

  'ui.state': {
    description: 'The layout, the connected windows and what each slot reports.',
    readOnly: true,
    params: noParams,
    result: uiState
  },
  'ui.view.open': {
    description: 'Opens view `id` with `input` (JSON up to 64 KiB); `id` must be an effective view.',
    params: object({ id: string(), input: { description: 'Passed to the view as its input.' } }, ['id']),
    result: uiLayout
  },
  'ui.view.close': { description: 'Closes the open view.', params: noParams, result: uiLayout },
  'ui.panel.open': {
    description: 'Opens panel `id`; it must be an effective panel.',
    params: object({ id: string() }, ['id']),
    result: uiLayout
  },
  'ui.panel.close': { description: 'Closes the open panel.', params: noParams, result: uiLayout },
  'ui.sidebar.set': {
    description: 'Shows or hides the sidebar.',
    params: object({ visible: boolean() }, ['visible']),
    result: uiLayout
  },
  'ui.focus': {
    description: 'Moves focus to the sidebar, the view or the panel.',
    params: object({ target: { type: 'string', enum: ['sidebar', 'view', 'panel'] } }, ['target']),
    result: uiLayout
  },
  'ui.command.run': {
    description: 'Runs a plugin UI command in one open window and returns its result.',
    params: object({ id: string(), args: { description: "Checked against the command's args schema." } }, ['id']),
    result: object({ result: { description: "The command's return value." } }, ['result'])
  },
  'ui.report': {
    description: 'A window reports what a mounted slot shows; null clears it. Role `ui` only.',
    params: object({ slot: string(), state: { description: 'A JSON summary up to 64 KiB, or null.' } }, ['slot', 'state']),
    result: ok
  },
  'ui.window.focused': {
    description: 'A window tells the daemon whether it has focus. Role `ui` only.',
    params: object({ focused: boolean() }, ['focused']),
    result: ok
  },
  'ui.window.activity': {
    description: 'A window reports user input, which keeps it present. Role `ui` only.',
    params: noParams,
    result: ok
  },
  'ui.command.reply': {
    description: 'A window answers a `ui.command.request`. Role `ui` only.',
    params: object(
      {
        requestId: string(),
        result: { description: "The command's return value." },
        error: object({ message: string() }, ['message'])
      },
      ['requestId']
    ),
    result: ok
  },

  'ui.contributions': {
    description: "The window's view of plugin UI: slots, commands, keybindings, settings, themes and module URLs.",
    readOnly: true,
    params: noParams,
    result: uiModel
  },
  'setting.list': {
    description: 'Every plugin setting with its current value, or only those of plugin `pluginId`.',
    readOnly: true,
    params: object({ pluginId: string() }),
    result: listOf(settingInfo)
  },
  'setting.get': {
    description: 'One plugin setting by full ID.',
    readOnly: true,
    params: object({ id: string() }, ['id']),
    result: settingInfo
  },
  'setting.set': {
    description: 'Validates `value` against the declaration, stores it and broadcasts `setting.changed`.',
    params: object({ id: string(), value: { description: 'The new value; checked against the setting.' } }, ['id', 'value']),
    result: settingInfo
  },
  'setting.reset': {
    description: 'Drops the stored value so the setting reads as its default.',
    params: object({ id: string() }, ['id']),
    result: settingInfo
  },
  'theme.list': {
    description: 'Every available theme with the chosen and the active one.',
    readOnly: true,
    params: noParams,
    result: themeList
  },
  'theme.set': {
    description: 'Chooses theme `id` (`default` or a theme ID) and broadcasts `theme.changed`.',
    params: object({ id: string() }, ['id']),
    result: themeList
  }
} satisfies { [M in MethodName]: KernelMethodSchema }

/** Every kernel event's data schema: the event object without its `type`. */
export const KERNEL_EVENT_SCHEMAS = {
  notify: {
    description: 'A notification for the user.',
    data: object(
      {
        title: string(),
        body: string(),
        sessionId: string(),
        worktreeId: string(),
        open: object({ view: string(), input: { description: 'Passed to the view as its input.' } }, ['view']),
        desktop: boolean('Whether the desktop shell shows a native notification.'),
        sound: object(
          {
            file: { description: 'A sound file path, or null for the system sound.' },
            volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Playback volume, 0-100.' }
          },
          ['file', 'volume']
        ),
        toast: boolean('Whether the webview shows a toast; absent means it does.')
      },
      ['title', 'body', 'desktop']
    )
  },
  'plugin.changed': { description: 'The plugin set or a plugin state changed.', data: { type: 'object' } },
  'setting.changed': {
    description: 'A plugin setting changed.',
    data: object({ id: string(), value: { description: 'The new value: a boolean, number or string.' } }, ['id', 'value'])
  },
  'theme.changed': {
    description: 'The chosen or active theme changed.',
    data: object({ chosen: string(), active: string() }, ['chosen', 'active'])
  },
  'ui.state.changed': { description: 'The layout changed.', data: object({ layout: uiLayout }, ['layout']) },
  'ui.command.request': {
    description: 'A routed UI command for this window to run; sent only to the target window.',
    data: object(
      { requestId: string(), id: string(), args: { description: 'The command arguments.' } },
      ['requestId', 'id']
    )
  },
  'ui.window.changed': {
    description: 'A window changed focus or presence, or a window connection dropped.',
    data: object({ windows: listOf(windowInfo) }, ['windows'])
  },
  'ui.report.changed': {
    description: "A window's report for a slot changed; delivered to plugin listeners only, never to clients.",
    data: object({ slot: string(), connId: { type: 'integer' } }, ['slot', 'connId'])
  },
  'hook.received': {
    description: 'An agent hook arrived; delivered to plugin listeners only, never to clients.',
    data: object(
      {
        agent: string(),
        sessionId: string(),
        payload: { description: 'The hook body.' },
        agentPid: integer(1, 'The agent process that ran the hook, when the shim reported it.'),
        agentStart: string('That process start time (ps lstart, UTC).'),
        event: string('The hook event name when the payload carries none.')
      },
      ['agent', 'sessionId']
    )
  }
} satisfies { [T in KernelEventType]: { description: string; data: Schema } }
