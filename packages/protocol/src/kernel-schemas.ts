import type { MethodName, QuirkyEvent } from './rpc'
import type { PluginEvent } from './plugins'
import type { Schema } from './schema'
import { UI_TOOL_SLOTS } from './tool-slots'

export type KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']

/** Kernel methods that act on the calling connection itself, so only a live client can call them. */
export const CONNECTION_METHODS = [
  'client.hello',
  'events.subscribe',
  'ui.window.self',
  'ui.report',
  'ui.shell.report',
  'ui.window.focused',
  'ui.window.activity',
  'ui.command.reply',
  'desktop.shell.capabilities',
  'desktop.shell.reply',
  'desktop.window.attach',
  'desktop.window.update',
  'desktop.window.runOwnerCommand',
  'desktop.window.closed'
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
    apiVersion: string('The declaring plugin minimum API release.'),
    repository: string('The GitHub repository URL the manifest declares.'),
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
    category: string(),
    section: string(),
    description: string(),
    default: {},
    minimum: { type: 'number' },
    maximum: { type: 'number' },
    values: strings,
    menu: { type: 'string', enum: ['view'], description: 'A boolean setting exposed in the native View menu.' },
    whenSetting: string("The plugin's own boolean setting that must be true for this setting's View menu row."),
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
const uiMenuItem = object(
  {
    id: string(),
    plugin: string(),
    menu: { type: 'string', enum: ['quirky.terminal/pane', 'quirky.terminal/tab'] },
    title: string(),
    command: string('A full command ID; receives pane session or new-tab worktree/workspace/group context.'),
    when: object({ agent: { type: 'string', enum: ['any'] } }),
    after: { type: 'string', enum: ['quick-commands'] }
  },
  ['id', 'plugin', 'menu', 'title', 'command']
)
const toolSlot: Schema = { type: 'string', enum: [...UI_TOOL_SLOTS] }
const uiTool = object(
  {
    id: string(),
    title: string(),
    icon: string(),
    defaultSlot: toolSlot,
    contributionId: { description: 'A contribution ID, or null for the host-owned Inbox.' },
    aliases: strings
  },
  ['id', 'title', 'icon', 'defaultSlot', 'contributionId', 'aliases']
)
const uiToolLayout = object(
  {
    placements: { type: 'object', additionalProperties: true },
    order: strings,
    open: object(Object.fromEntries(UI_TOOL_SLOTS.map((slot) => [slot, { description: 'A tool ID, or null when the slot is closed.' }])), [...UI_TOOL_SLOTS]),
    sizes: object(
      {
        left: { type: 'number', minimum: 160, maximum: 1200 },
        right: { type: 'number', minimum: 160, maximum: 1200 },
        bottom: { type: 'number', minimum: 100, maximum: 1000 },
        leftSplit: { type: 'number', minimum: 0.15, maximum: 0.85 },
        rightSplit: { type: 'number', minimum: 0.15, maximum: 0.85 },
        bottomSplit: { type: 'number', minimum: 0.15, maximum: 0.85 }
      },
      ['left', 'right', 'bottom', 'leftSplit', 'rightSplit', 'bottomSplit']
    )
  },
  ['placements', 'order', 'open', 'sizes']
)
const uiViewTab = object({ id: string(), input: { description: 'The latest input for this opened view.' } }, ['id'])
const uiResize = object(
  {
    left: { type: 'number', minimum: 160, maximum: 1200 },
    right: { type: 'number', minimum: 160, maximum: 1200 },
    bottom: { type: 'number', minimum: 100, maximum: 1000 },
    leftSplit: { type: 'number', minimum: 0.15, maximum: 0.85 },
    rightSplit: { type: 'number', minimum: 0.15, maximum: 0.85 },
    bottomSplit: { type: 'number', minimum: 0.15, maximum: 0.85 }
  }
)
const uiModel = object(
  {
    sidebarSections: listOf({ type: 'object' }),
    statusBars: listOf({ type: 'object' }),
    activityItems: listOf({ type: 'object' }),
    panels: listOf({ type: 'object' }),
    views: listOf({ type: 'object' }),
    overlays: listOf({ type: 'object' }),
    commands: listOf({ type: 'object' }),
    keybindings: listOf(uiKeybinding, 'Registry precedence order: distro bindings first, then plugin bindings.'),
    settings: listOf({ type: 'object' }),
    settingsSections: listOf({ type: 'object' }),
    menuItems: listOf(uiMenuItem),
    themes: listOf({ type: 'object' }),
    theme: object({ chosen: string(), active: string() }, ['chosen', 'active']),
    tools: listOf(uiTool),
    visibilitySettings: strings,
    modules: { type: 'object', additionalProperties: true }
  },
  ['sidebarSections', 'statusBars', 'activityItems', 'panels', 'views', 'overlays', 'commands', 'keybindings', 'settings', 'settingsSections', 'menuItems', 'themes', 'theme', 'modules']
)
const apiDescription = object(
  {
    schemaVersion: { type: 'integer' },
    daemonVersion: string(),
    protocolVersion: { type: 'integer' },
    pluginApiVersion: string('Stable plugin-author API release hosted by this daemon.'),
    methods: listOf({ type: 'object' }),
    events: listOf({ type: 'object' }),
    uiCommands: listOf({ type: 'object' })
  },
  ['schemaVersion', 'daemonVersion', 'protocolVersion', 'pluginApiVersion', 'methods', 'events', 'uiCommands']
)

const uiLayout = object(
  {
    view: { description: 'The open view as {id, input?}, or null.' },
    worktree: { description: 'The selected worktree path for this window, or null when none is selected.' },
    panel: { description: 'The open panel ID, or null.' },
    sidebar: boolean(),
    focus: { description: "'sidebar', 'view', 'panel' or null." },
    panelWidths: { type: 'object', additionalProperties: true, description: 'Desired width by panel ID.' },
    palette: { type: 'boolean', description: 'Whether the command palette is open; absent means closed.' },
    viewTabs: listOf(uiViewTab, 'Open center view contributions, retaining each view’s latest input.'),
    tools: uiToolLayout
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
const toastKind: Schema = { type: 'string', enum: ['info', 'success', 'warning', 'error'] }
const toastCommand = (extra: Record<string, Schema> = {}): Record<string, Schema> => ({
  command: string('A window command ID.'),
  args: { description: "Passed to the command; checked against the command's args schema when it runs." },
  ...extra
})
const toastAction = object(
  { label: string(), ...toastCommand({ keepOpen: boolean('Keeps the toast showing after the action runs.') }) },
  ['label', 'command']
)
const toastOnDismiss = object(toastCommand(), ['command'])
const toastState = object(
  {
    key: { description: "The plugin's ID for the toast, or null." },
    kind: toastKind,
    title: string(),
    body: string(),
    detail: { description: 'The second line, or null.' },
    persistent: boolean('Whether the toast stays until dismissed.'),
    actions: listOf(object({ label: string(), ...toastCommand() }, ['label', 'command']))
  },
  ['key', 'kind', 'title', 'body', 'detail', 'persistent', 'actions']
)
const uiState = object(
  {
    windows: listOf(windowInfo),
    layout: uiLayout,
    slots: listOf({ type: 'object' }),
    toasts: listOf(toastState)
  },
  ['windows', 'layout', 'slots', 'toasts']
)
const uiWindowState = object(
  {
    connId: integer(1, 'The live kernel UI connection, not a native auxiliary window ID.'),
    windows: listOf(windowInfo),
    layout: uiLayout,
    slots: listOf({ type: 'object' }),
    toasts: listOf(toastState)
  },
  ['connId', 'windows', 'layout', 'slots', 'toasts']
)


const nativeNotificationCapabilities = object(
  { permission: boolean(), click: boolean(), dismiss: boolean() },
  ['permission', 'click', 'dismiss']
)
const nativeDesktopCapabilities = object(
  {
    directoryPicker: boolean(),
    auxiliaryWindows: boolean(),
    revealItem: boolean(),
    notifications: nativeNotificationCapabilities
  },
  ['directoryPicker', 'auxiliaryWindows', 'revealItem', 'notifications']
)

const desktopWindowOwner = object({ connId: integer(1), name: string() }, ['connId'])
const desktopWindowSummary = object(
  {
    windowId: string(),
    view: { description: 'The effective view ID, or null for an empty auxiliary window.' },
    input: { description: 'The current view input, if any.' },
    title: string(),
    ownerShell: desktopWindowOwner,
    attached: boolean('Whether the auxiliary UI connection has attached.')
  },
  ['windowId', 'view', 'ownerShell', 'attached']
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
        sessionToken: string('The launch-scoped session token; independent from sessionId.'),
        cwd: string(),
        sessionId: string(),
        worktreeId: string(),
        desktopClientId: string('Stable first-party UI installation identity; accepted only for role ui.')
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
    description: 'The layout, the connected windows, what each slot reports and the toasts the focused window shows.',
    readOnly: true,
    params: noParams,
    result: uiState
  },
  'ui.window.self': {
    description: 'Returns the calling connection ID and optional stable desktop identity only for a live UI-role connection.',
    readOnly: true,
    params: noParams,
    result: object({ connId: integer(1), desktopClientId: string() }, ['connId'])
  },
  'ui.window.state': {
    description: 'The exact live UI connection’s effective layout, its slot reports and its toasts.',
    readOnly: true,
    params: object(
      { connId: integer(1, 'A live kernel UI connection ID.') },
      ['connId']
    ),
    result: uiWindowState
  },
  'ui.window.view.open': {
    description: 'Opens view `id` with `input` only in the exact live target UI connection.',
    params: object(
      {
        connId: integer(1, 'A live kernel UI connection ID.'),
        id: string(),
        input: { description: 'Passed to the view as its input.' }
      },
      ['connId', 'id']
    ),
    result: uiLayout
  },
  'ui.window.view.close': {
    description: 'Closes the target UI connection’s view; `expectedView` compares the complete current view before mutation.',
    params: object(
      {
        connId: integer(1, 'A live kernel UI connection ID.'),
        expectedView: object(
          {
            id: string(),
            input: { description: 'The exact input value currently shown by the view.' }
          },
          ['id']
        )
      },
      ['connId']
    ),
    result: uiLayout
  },
  'ui.window.command.run': {
    description: 'Runs a UI command only in the exact live target UI connection.',
    params: object(
      {
        connId: integer(1, 'A live kernel UI connection ID.'),
        id: string(),
        args: { description: "Checked against the command's args schema." }
      },
      ['connId', 'id']
    ),
    result: object({ result: { description: "The command's return value." } }, ['result'])
  },
  'ui.palette.set': {
    description: 'Opens or closes the shared command palette; omitting `open` toggles its current state.',
    params: object({ open: { type: 'boolean', description: 'True opens, false closes; omitted toggles.' } }),
    result: uiLayout
  },
  'ui.tool.open': {
    description: 'Opens tool `id` in its assigned slot, toggling that slot closed when the tool is already shown.',
    params: object({ id: string() }, ['id']),
    result: uiLayout
  },
  'ui.tool.close': {
    description: 'Closes the tool currently shown in `slot` without changing its placement.',
    params: object({ slot: toolSlot }, ['slot']),
    result: uiLayout
  },
  'ui.tool.move': {
    description: 'Moves tool `id` to `slot`, moving it there atomically when it is currently open.',
    params: object({ id: string(), slot: toolSlot }, ['id', 'slot']),
    result: uiLayout
  },
  'ui.tool.resize': {
    description: 'Updates one or more bounded tool widths, bottom height or side splits; at least one size field is required.',
    params: uiResize,
    result: uiLayout
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
  'ui.panel.configure': {
    description: 'Configures an effective panel width (an integer from 220 through 4096).',
    params: object(
      {
        id: string('An effective panel contribution ID.'),
        width: { type: 'integer', minimum: 220, maximum: 4096 }
      },
      ['id']
    ),
    result: uiLayout
  },
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
  'ui.toast.dismiss': {
    description:
      'Dismisses the toast with `key` in the window that shows it and runs its onDismiss command; NotFound for an unknown key.',
    params: object({ key: string() }, ['key']),
    result: ok
  },
  'ui.shell.report': {
    description: 'A window reports the toasts it shows, replacing its earlier list. Role `ui` only.',
    params: object({ toasts: listOf(toastState) }, ['toasts']),
    result: ok
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
  'desktop.shell.capabilities': {
    description: 'Reports the real native shell operations this exact UI window can fulfill. Notification permission and callbacks are unsupported by the pinned SDK. Role `ui` only.',
    params: nativeDesktopCapabilities,
    result: ok
  },
  'desktop.shell.reply': {
    description: 'Completes a native shell request only for the UI window that received it. Role `ui` only.',
    params: object(
      {
        requestId: string(),
        result: { description: 'The actual native result for the matching request.' },
        error: object({ message: string() }, ['message'])
      },
      ['requestId']
    ),
    result: ok
  },
  'desktop.capabilities': {
    description: 'Reads the reported native capabilities of the selected shell; absent capabilities are false.',
    readOnly: true,
    params: noParams,
    result: nativeDesktopCapabilities
  },
  'desktop.folder.pick': {
    description: 'Opens the selected native shell directory chooser and returns its actual selected paths; an empty selection is cancellation.',
    params: object(
      { title: string(), startingFolder: string(), multiple: boolean() }
    ),
    result: object({ cancelled: boolean(), paths: strings }, ['cancelled', 'paths'])
  },
  'desktop.window.open': {
    description: 'Opens effective view `view` with its exact `input` in a separately owned native window.',
    params: object({ view: string(), input: { description: 'Passed to the view as its input.' }, title: string() }, ['view']),
    result: object({ windowId: string() }, ['windowId'])
  },
  'desktop.window.close': {
    description: 'Closes one auxiliary native window only when it is owned by the calling shell.',
    params: object({ windowId: string() }, ['windowId']),
    result: object({ closed: boolean() }, ['closed'])
  },
  'desktop.item.reveal': {
    description: 'Asks the selected native shell to reveal an exact absolute path.',
    params: object({ path: string() }, ['path']),
    result: object({ requested: boolean() }, ['requested'])
  },
  'desktop.window.list': {
    description: 'Reads daemon-owned auxiliary window routes and their exact owner shells.',
    readOnly: true,
    params: noParams,
    result: listOf(desktopWindowSummary)
  },
  'desktop.window.attach': {
    description: 'Attaches the calling UI connection to its exact daemon-owned auxiliary route. Role `ui` only.',
    params: object({ windowId: string(), ownerShellConnId: integer(1) }, ['windowId', 'ownerShellConnId']),
    result: desktopWindowSummary
  },
  'desktop.window.update': {
    description: 'Updates view and input in the calling auxiliary window without changing the main layout. Role `ui` only.',
    params: object(
      { windowId: string(), view: { description: 'An effective view ID, or null to clear this window view.' }, input: { description: 'Passed to the view as its input.' }, title: string() },
      ['windowId', 'view']
    ),
    result: desktopWindowSummary
  },
  'desktop.window.runOwnerCommand': {
    description: 'Runs a command in the exact owner shell of an auxiliary window and activates that native window on success. Role `ui` only.',
    params: object({ windowId: string(), id: string(), args: { description: 'Command arguments, validated against the UI command declaration.' } }, ['windowId', 'id']),
    result: object({ result: { description: 'The owner window command result.' }, activated: boolean() }, ['result', 'activated'])
  },
  'desktop.window.closed': {
    description: 'Removes an auxiliary route after its native window closes. The owner shell identity must match; role `desktop` only.',
    params: object({ windowId: string(), ownerShellConnId: integer(1) }, ['windowId', 'ownerShellConnId']),
    result: object({ closed: boolean() }, ['closed'])
  },
  'keybinding.list': {
    description: 'Lists effective keybindings and their current override status.',
    readOnly: true,
    params: noParams,
    result: listOf(uiKeybinding)
  },
  'keybinding.set': {
    description: 'Overrides one keybinding with a canonical chord, or clears the override with null.',
    params: object({ id: string(), key: { description: 'A canonical key chord, or null to clear the override.' } }, ['id', 'key']),
    result: listOf(uiKeybinding)
  },
  'keybinding.reset': {
    description: "Resets one keybinding to the contribution's declared default.",
    params: object({ id: string() }, ['id']),
    result: listOf(uiKeybinding)
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
    description: 'Chooses `default` (follow system), the `dark` or `light` appearance pin, or a theme ID and broadcasts `theme.changed`.',
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
        toast: boolean('Whether the webview shows a toast; absent means it does.'),
        kind: toastKind,
        key: string('A toast with this key replaces the one already showing under it.'),
        persistent: boolean('Keeps the toast until it is dismissed.'),
        detail: string('A second line under the body.'),
        actions: listOf(toastAction),
        onDismiss: toastOnDismiss
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
  'ui.keybindings.changed': { description: 'The effective keybinding overrides changed.', data: { type: 'object' } },
  'ui.command.request': {
    description: 'A routed UI command for this window to run; sent only to the target window.',
    data: object(
      { requestId: string(), id: string(), args: { description: 'The command arguments.' } },
      ['requestId', 'id']
    )
  },
  'desktop.shell.request': {
    description: 'A native shell operation for this exact UI window to fulfill.',
    data: object(
      {
        requestId: string(),
        action: object(
          {
            kind: { type: 'string', enum: ['folder-picker', 'window-open', 'window-close', 'window-activate-owner', 'reveal-item'] },
            request: { type: 'object', additionalProperties: true, description: 'The request matching `kind`.' }
          },
          ['kind', 'request']
        ),
        ownerShell: desktopWindowOwner
      },
      ['requestId', 'action', 'ownerShell']
    )
  },
  'desktop.window.changed': {
    description: 'Daemon-owned auxiliary window routes were opened, attached, updated or closed.',
    data: object({ windows: listOf(desktopWindowSummary) }, ['windows'])
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
