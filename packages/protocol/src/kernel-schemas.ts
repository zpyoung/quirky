import { AGENT_KINDS } from './model'
import type { MethodName, QuirkyEvent } from './rpc'
import type { PluginEvent } from './plugins'
import type { Schema } from './schema'

export type KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']

/** Kernel methods that act on the calling connection itself, so only a live client can call them. */
export const CONNECTION_METHODS = [
  'client.hello',
  'events.subscribe',
  'terminal.attach',
  'terminal.detach',
  'ui.report',
  'ui.window.focused',
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
const agent: Schema = { type: 'string', enum: [...AGENT_KINDS], description: 'The agent to run.' }

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

const repo = object(
  {
    id: string(),
    name: string(),
    path: string("Absolute path of the repository's main working tree."),
    addedAt: { type: 'number' }
  },
  ['id', 'name', 'path', 'addedAt']
)
const worktree = object(
  {
    id: string(),
    repoId: string(),
    path: string(),
    branch: { description: 'Short branch name, or null when HEAD is detached.' },
    head: string(),
    isMain: boolean(),
    name: string()
  },
  ['id', 'repoId', 'path', 'branch', 'head', 'isMain', 'name']
)
const session = object(
  {
    id: string(),
    kind: { type: 'string', enum: ['terminal', 'structured'] },
    agent,
    worktreeId: string(),
    cwd: string(),
    title: string(),
    status: { type: 'string', enum: ['starting', 'running', 'working', 'waiting', 'done', 'exited'] },
    createdAt: { type: 'number' },
    lastActivityAt: { type: 'number' },
    exitCode: { description: 'The exit code, or null while the process is alive.' }
  },
  ['id', 'kind', 'agent', 'worktreeId', 'cwd', 'title', 'status', 'createdAt', 'lastActivityAt', 'exitCode']
)
const settings = object(
  {
    worktreesRoot: string('Root under which new worktrees are created.'),
    terminalScrollback: { type: 'integer' },
    notifications: boolean()
  },
  ['worktreesRoot', 'terminalScrollback', 'notifications']
)
const askEnvelope = object(
  {
    status: { type: 'string', enum: ['pending', 'answered', 'partial', 'declined', 'timed_out'] },
    askId: string(),
    answers: { type: 'object', additionalProperties: true, description: 'Answers by question ID.' },
    skipped: strings
  },
  ['status', 'askId', 'answers', 'skipped']
)
const ask = object(
  {
    id: string(),
    spec: { type: 'object', additionalProperties: true },
    sessionId: { description: 'The asking session, or null.' },
    worktreeId: { description: 'The asking worktree, or null.' },
    createdAt: { type: 'number' },
    envelope: askEnvelope
  },
  ['id', 'spec', 'sessionId', 'worktreeId', 'createdAt', 'envelope']
)
const structuredMessage = object(
  {
    sessionId: string(),
    seq: { type: 'integer' },
    role: { type: 'string', enum: ['user', 'assistant', 'tool', 'system', 'result'] },
    text: string(),
    data: { description: "The agent's raw event." },
    at: { type: 'number' }
  },
  ['sessionId', 'seq', 'role', 'text', 'at']
)
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
const uiModel = object(
  {
    sidebarSections: listOf({ type: 'object' }),
    panels: listOf({ type: 'object' }),
    views: listOf({ type: 'object' }),
    commands: listOf({ type: 'object' }),
    keybindings: listOf({ type: 'object' }),
    settings: listOf({ type: 'object' }),
    themes: listOf({ type: 'object' }),
    theme: object({ chosen: string(), active: string() }, ['chosen', 'active']),
    modules: { type: 'object', additionalProperties: true }
  },
  ['sidebarSections', 'panels', 'views', 'commands', 'keybindings', 'settings', 'themes', 'theme', 'modules']
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
const uiState = object(
  {
    windows: listOf(object({ connId: { type: 'integer' }, name: string(), focused: boolean() }, ['connId', 'focused'])),
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

const worktreeId = string()
const sessionId = string()

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

  'settings.get': { description: 'The daemon settings.', params: noParams, result: settings },
  'settings.set': {
    description: 'Changes the given daemon settings and returns all of them.',
    params: object({
      worktreesRoot: string(),
      terminalScrollback: integer(0),
      notifications: boolean()
    }),
    result: settings
  },

  'repo.list': { description: 'Every added repository.', readOnly: true, params: noParams, result: listOf(repo) },
  'repo.add': {
    description: 'Resolves `path` to its repository toplevel; adding the same repo twice returns the existing one.',
    params: object({ path: string() }, ['path']),
    result: repo
  },
  'repo.remove': {
    description: 'Forgets a repository.',
    params: object({ repoId: string() }, ['repoId']),
    result: ok
  },

  'worktree.list': {
    description: 'Worktrees, optionally only those of one repository.',
    readOnly: true,
    params: object({ repoId: string() }),
    result: listOf(worktree)
  },
  'worktree.create': {
    description:
      "Creates branch `name` from `baseRef` (default: the repo's current HEAD) at `<worktreesRoot>/<repo>/<name>`.",
    params: object({ repoId: string(), name: string(), baseRef: string() }, ['repoId', 'name']),
    result: worktree
  },
  'worktree.remove': {
    description: 'Removes a worktree.',
    params: object({ worktreeId, force: boolean() }, ['worktreeId']),
    result: ok
  },

  'session.list': {
    description: 'Sessions, optionally only those of one worktree.',
    readOnly: true,
    params: object({ worktreeId: string() }),
    result: listOf(session)
  },
  'session.create': {
    description: 'Starts a terminal session; `prompt` is passed to agents that accept an initial prompt.',
    params: object({ worktreeId, agent, prompt: string(), cols: integer(1), rows: integer(1) }, [
      'worktreeId',
      'agent'
    ]),
    result: session
  },
  'session.createStructured': {
    description: 'Starts a structured (no PTY) background agent session; only `claude` is supported in v1.',
    params: object({ worktreeId, agent, prompt: string() }, ['worktreeId', 'agent', 'prompt']),
    result: session
  },
  'session.close': {
    description: 'Kills the process if alive and forgets the session.',
    params: object({ sessionId }, ['sessionId']),
    result: ok
  },

  'terminal.attach': {
    description:
      'Starts streaming a terminal session to this client: base64 replay of recent output, then live binary frames tagged with `streamId`.',
    params: object({ sessionId, cols: integer(1), rows: integer(1) }, ['sessionId', 'cols', 'rows']),
    result: object({ streamId: { type: 'integer' }, replay: string('Base64 of recent output.'), offset: { type: 'integer' } }, [
      'streamId',
      'replay',
      'offset'
    ])
  },
  'terminal.detach': {
    description: 'Stops a terminal stream.',
    params: object({ streamId: integer(0) }, ['streamId']),
    result: ok
  },
  'terminal.write': {
    description: 'Writes raw input to a terminal, as typed.',
    params: object({ sessionId, data: string() }, ['sessionId', 'data']),
    result: ok
  },
  'terminal.resize': {
    description: 'Resizes a terminal.',
    params: object({ sessionId, cols: integer(1), rows: integer(1) }, ['sessionId', 'cols', 'rows']),
    result: ok
  },
  'terminal.send': {
    description: 'Sends a prompt as a bracketed paste, then Enter as a separate write when `enter` is set.',
    params: object({ sessionId, text: string(), enter: boolean() }, ['sessionId', 'text']),
    result: ok
  },
  'terminal.read': {
    description: 'The visible screen plus up to `lines` (default 50) of recent scrollback, as plain text.',
    readOnly: true,
    params: object({ sessionId, lines: integer(1) }, ['sessionId']),
    result: object({ lines: strings, cols: { type: 'integer' }, rows: { type: 'integer' }, alt: boolean() }, [
      'lines',
      'cols',
      'rows',
      'alt'
    ])
  },

  'git.status': {
    description: "A worktree's branch, upstream and changed files.",
    readOnly: true,
    params: object({ worktreeId }, ['worktreeId']),
    result: object(
      {
        branch: {},
        upstream: {},
        ahead: { type: 'integer' },
        behind: { type: 'integer' },
        files: listOf({ type: 'object' })
      },
      ['branch', 'upstream', 'ahead', 'behind', 'files']
    )
  },
  'git.diff': {
    description: 'Both sides of a file diff; with `staged`, HEAD against the index, else the index against the working tree.',
    readOnly: true,
    params: object({ worktreeId, path: string(), staged: boolean() }, ['worktreeId', 'path']),
    result: object(
      { path: string(), staged: boolean(), original: string(), modified: string(), binary: boolean() },
      ['path', 'staged', 'original', 'modified', 'binary']
    )
  },
  'git.stage': {
    description: 'Stages files.',
    params: object({ worktreeId, paths: strings }, ['worktreeId', 'paths']),
    result: ok
  },
  'git.unstage': {
    description: 'Unstages files.',
    params: object({ worktreeId, paths: strings }, ['worktreeId', 'paths']),
    result: ok
  },
  'git.commit': {
    description: 'Commits the staged changes.',
    params: object({ worktreeId, message: string() }, ['worktreeId', 'message']),
    result: object({ sha: string() }, ['sha'])
  },

  'ask.create': {
    description: 'Registers a question for the user and returns its ID.',
    params: object(
      {
        spec: { type: 'object', additionalProperties: true, description: 'The ask: an optional title and its questions.' },
        sessionId: string(),
        worktreeId: string()
      },
      ['spec']
    ),
    result: object({ askId: string() }, ['askId'])
  },
  'ask.wait': {
    description: 'Long-polls up to `timeoutMs` (max 60000); returns status `pending` if still unanswered.',
    readOnly: true,
    params: object({ askId: string(), timeoutMs: integer(0) }, ['askId']),
    result: askEnvelope
  },
  'ask.answer': {
    description: 'Answers an ask.',
    params: object(
      {
        askId: string(),
        answers: { type: 'object', additionalProperties: true, description: 'Answers by question ID.' },
        skipped: strings
      },
      ['askId', 'answers']
    ),
    result: askEnvelope
  },
  'ask.cancel': {
    description: 'Declines an ask.',
    params: object({ askId: string() }, ['askId']),
    result: askEnvelope
  },
  'ask.list': {
    description: 'Asks, optionally only the pending ones.',
    readOnly: true,
    params: object({ pendingOnly: boolean() }),
    result: listOf(ask)
  },

  'structured.messages': {
    description: 'The messages of a structured session, optionally only those after `afterSeq`.',
    readOnly: true,
    params: object({ sessionId, afterSeq: integer(0) }, ['sessionId']),
    result: listOf(structuredMessage)
  },
  'structured.send': {
    description: 'Sends a message to a structured session.',
    params: object({ sessionId, text: string() }, ['sessionId', 'text']),
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
  'repo.changed': { description: 'The list of repositories changed.', data: { type: 'object' } },
  'worktree.changed': {
    description: "A repository's worktrees changed.",
    data: object({ repoId: string() }, ['repoId'])
  },
  'session.changed': {
    description: 'A session was created or its state changed.',
    data: object({ session }, ['session'])
  },
  'session.removed': { description: 'A session was closed.', data: object({ sessionId }, ['sessionId']) },
  'git.changed': { description: "A worktree's git state changed.", data: object({ worktreeId }, ['worktreeId']) },
  'ask.created': { description: 'A new ask is waiting for the user.', data: object({ ask }, ['ask']) },
  'ask.resolved': {
    description: 'An ask was answered, declined or timed out.',
    data: object({ askId: string(), envelope: askEnvelope }, ['askId', 'envelope'])
  },
  notify: {
    description: 'A notification for the user.',
    data: object(
      {
        title: string(),
        body: string(),
        sessionId: string(),
        worktreeId: string(),
        open: object({ view: string(), input: { description: 'Passed to the view as its input.' } }, ['view']),
        desktop: boolean('Whether the desktop shell shows a native notification.')
      },
      ['title', 'body']
    )
  },
  'structured.message': {
    description: 'A message was added to a structured session.',
    data: object({ message: structuredMessage }, ['message'])
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
  'hook.received': {
    description: 'An agent hook arrived; delivered to plugin listeners only, never to clients.',
    data: object(
      { agent: string(), sessionId: string(), payload: { description: 'The hook body.' } },
      ['agent', 'sessionId']
    )
  }
} satisfies { [T in KernelEventType]: { description: string; data: Schema } }
