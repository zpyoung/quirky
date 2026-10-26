import { AGENT_KINDS } from './model'
import type { MethodName, QuirkyEvent } from './rpc'
import type { PluginEvent } from './plugins'
import type { Schema } from './schema'

export type KernelEventType = Exclude<QuirkyEvent, PluginEvent>['type']

/** Kernel methods that act on the calling connection itself, so only a live client can call them. */
export const CONNECTION_METHODS = ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach'] as const

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

const worktreeId = string()
const sessionId = string()

/** Every kernel method's params and result schema; `params` never rejects what the handler accepts. */
export const KERNEL_METHOD_SCHEMAS = {
  'client.hello': {
    description: 'Identifies this connection to the daemon and checks the protocol version.',
    params: object(
      {
        role: { type: 'string', enum: ['desktop', 'ui', 'cli', 'mobile'] },
        name: string(),
        protocolVersion: integer(0)
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
    params: noParams,
    result: object(
      {
        daemonVersion: string(),
        pid: { type: 'integer' },
        startedAt: { type: 'number' },
        home: string(),
        ptyHost: object({ pid: {}, alive: boolean() }, ['pid', 'alive']),
        clients: listOf(object({ role: string(), name: string() }, ['role']))
      },
      ['daemonVersion', 'pid', 'startedAt', 'home', 'ptyHost', 'clients']
    )
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

  'repo.list': { description: 'Every added repository.', params: noParams, result: listOf(repo) },
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
    params: object({ pendingOnly: boolean() }),
    result: listOf(ask)
  },

  'structured.messages': {
    description: 'The messages of a structured session, optionally only those after `afterSeq`.',
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
    params: noParams,
    result: listOf(pluginInfo)
  },
  'plugin.contributions': {
    description: 'Only `effective` contributions unless `all` is set, which returns every declaration.',
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
  'plugin.activate': {
    description: 'Activates the plugin now instead of waiting for first use.',
    params: object({ pluginId: string() }, ['pluginId']),
    result: pluginInfo
  },
  'api.describe': {
    description: 'Every method, event and UI command in effect, with its schemas.',
    params: noParams,
    result: apiDescription
  },

  'job.list': { description: 'Every scheduled job with its schedule and last run.', params: noParams, result: listOf(jobInfo) },
  'job.run': {
    description: 'Runs job `id` now and resolves with the finished run.',
    params: object({ id: string() }, ['id']),
    result: jobRun
  },

  'ui.contributions': {
    description: "The window's view of plugin UI: slots, commands, keybindings, settings, themes and module URLs.",
    params: noParams,
    result: uiModel
  },
  'setting.list': {
    description: 'Every plugin setting with its current value, or only those of plugin `pluginId`.',
    params: object({ pluginId: string() }),
    result: listOf(settingInfo)
  },
  'setting.get': {
    description: 'One plugin setting by full ID.',
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
    params: noParams,
    result: themeList
  },
  'theme.set': {
    description: 'Chooses theme `id` (`default` or a theme ID) and broadcasts `theme.changed`.',
    params: object({ id: string() }, ['id']),
    result: themeList
  }
} satisfies { [M in MethodName]: { description: string; params: Schema; result: Schema } }

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
    data: object({ title: string(), body: string(), sessionId: string(), worktreeId: string() }, ['title', 'body'])
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
  }
} satisfies { [T in KernelEventType]: { description: string; data: Schema } }
