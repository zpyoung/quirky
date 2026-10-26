import {
  AGENT_KINDS,
  CATALOG_SCHEMA_VERSION,
  CONNECTION_METHODS,
  KERNEL_EVENT_SCHEMAS,
  KERNEL_METHOD_SCHEMAS,
  PROTOCOL_VERSION,
  type AgentKind,
  type ApiDescription,
  type ClientRole,
  type ContributionInfo,
  type MethodName,
  type ResultOf,
  type Schema
} from '@quirky/protocol'
import { conflict, invalidParams } from './errors'
import type { PluginHost } from './plugins/host'
import type { Scheduler } from './plugins/scheduler'
import type { UiService } from './plugins/ui-service'
import type { Core } from './service'
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

function text(params: Params, key: string): string {
  const value = params[key]
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

function optInt(params: Params, key: string, min: number): number | undefined {
  return params[key] === undefined ? undefined : int(params, key, min)
}

function optBool(params: Params, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalidParams(`${key} must be a boolean`)
  return value
}

function strList(params: Params, key: string): string[] {
  const value = params[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw invalidParams(`${key} must be an array of strings`)
  }
  return value as string[]
}

function agent(params: Params): AgentKind {
  const value = params.agent
  if (typeof value !== 'string' || !AGENT_KINDS.includes(value as AgentKind)) {
    throw invalidParams(`agent must be one of ${AGENT_KINDS.join(', ')}`)
  }
  return value as AgentKind
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
    ...Object.entries(KERNEL_METHOD_SCHEMAS).map(([name, entry]) => ({
      name,
      plugin: null,
      description: entry.description,
      params: entry.params,
      result: entry.result,
      ...(connection.includes(name) ? { connection: true as const } : {})
    })),
    ...effective('method').map((contribution) => ({
      name: shortId(contribution),
      plugin: contribution.plugin,
      ...descriptionOf(contribution.data),
      params: schemaField(contribution.data, 'params', { type: 'object' })!,
      result: schemaField(contribution.data, 'result', {})!
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
    uiCommands: uiCommands.sort(byName((entry) => entry.id))
  }
}

/** Maps every RPC method to the core or the plugin host, validating params so bad input becomes InvalidParams. */
export function createHandlers(core: Core, plugins: PluginHost, scheduler: Scheduler, ui: UiService): Handlers {
  return {
    'client.hello': (params, conn) => {
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
      return { protocolVersion: PROTOCOL_VERSION, daemonVersion: core.status().daemonVersion }
    },
    'events.subscribe': (_params, conn) => {
      conn.subscribed = true
      return OK
    },
    'status.get': () => core.status(),
    'settings.get': () => core.getSettings(),
    'settings.set': (params) =>
      core.setSettings({
        worktreesRoot: optStr(params, 'worktreesRoot'),
        terminalScrollback: optInt(params, 'terminalScrollback', 0),
        notifications: optBool(params, 'notifications')
      }),

    'repo.list': () => core.listRepos(),
    'repo.add': (params) => core.addRepo(str(params, 'path')),
    'repo.remove': async (params) => {
      await core.removeRepo(str(params, 'repoId'))
      return OK
    },

    'worktree.list': (params) => core.listWorktrees(optStr(params, 'repoId')),
    'worktree.create': (params) =>
      core.createWorktree(str(params, 'repoId'), text(params, 'name'), optStr(params, 'baseRef')),
    'worktree.remove': async (params) => {
      await core.removeWorktree(str(params, 'worktreeId'), optBool(params, 'force') ?? false)
      return OK
    },

    'session.list': (params) => core.listSessions(optStr(params, 'worktreeId')),
    'session.create': (params) =>
      core.createSession({
        worktreeId: str(params, 'worktreeId'),
        agent: agent(params),
        prompt: optStr(params, 'prompt'),
        cols: optInt(params, 'cols', 1),
        rows: optInt(params, 'rows', 1)
      }),
    'session.createStructured': (params) =>
      core.createStructuredSession({
        worktreeId: str(params, 'worktreeId'),
        agent: agent(params),
        prompt: text(params, 'prompt')
      }),
    'session.close': async (params) => {
      await core.closeSession(str(params, 'sessionId'))
      return OK
    },

    'terminal.attach': (params, conn) =>
      core.attach(conn, {
        sessionId: str(params, 'sessionId'),
        cols: int(params, 'cols', 1),
        rows: int(params, 'rows', 1)
      }),
    'terminal.detach': (params, conn) => {
      core.detach(conn, int(params, 'streamId', 0))
      return OK
    },
    'terminal.write': (params) => {
      core.writeTerminal(str(params, 'sessionId'), text(params, 'data'))
      return OK
    },
    'terminal.resize': async (params) => {
      await core.resizeTerminal(str(params, 'sessionId'), int(params, 'cols', 1), int(params, 'rows', 1))
      return OK
    },
    'terminal.send': async (params) => {
      await core.sendToTerminal(str(params, 'sessionId'), text(params, 'text'), optBool(params, 'enter') ?? false)
      return OK
    },
    'terminal.read': (params) => core.readTerminal(str(params, 'sessionId'), optInt(params, 'lines', 1) ?? 50),

    'git.status': (params) => core.gitStatus(str(params, 'worktreeId')),
    'git.diff': (params) =>
      core.gitDiff(str(params, 'worktreeId'), str(params, 'path'), optBool(params, 'staged') ?? false),
    'git.stage': async (params) => {
      await core.gitStage(str(params, 'worktreeId'), strList(params, 'paths'))
      return OK
    },
    'git.unstage': async (params) => {
      await core.gitUnstage(str(params, 'worktreeId'), strList(params, 'paths'))
      return OK
    },
    'git.commit': (params) => {
      const message = str(params, 'message')
      return core.gitCommit(str(params, 'worktreeId'), message)
    },

    'ask.create': (params) => ({
      askId: core.asks.create(params.spec, optStr(params, 'sessionId'), optStr(params, 'worktreeId')).id
    }),
    'ask.wait': (params) => core.asks.wait(str(params, 'askId'), optInt(params, 'timeoutMs', 0)),
    'ask.answer': (params) => core.asks.answer(str(params, 'askId'), params.answers, params.skipped),
    'ask.cancel': (params) => core.asks.cancel(str(params, 'askId')),
    'ask.list': (params) => core.asks.list(optBool(params, 'pendingOnly') ?? false),

    'structured.messages': (params) =>
      core.structuredMessages(str(params, 'sessionId'), optInt(params, 'afterSeq', 0)),
    'structured.send': async (params) => {
      await core.sendStructured(str(params, 'sessionId'), str(params, 'text'))
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
    'plugin.activate': (params) => plugins.activate(str(params, 'pluginId')),
    'api.describe': () => describeApi(core, plugins),

    'job.list': () => scheduler.list(),
    'job.run': (params) => scheduler.run(str(params, 'id')),

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
    'theme.set': (params) => ui.setTheme(str(params, 'id'))
  }
}
