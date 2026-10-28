import type { CliContext, CliModule } from '@quirky/protocol'
import type { HostedSession, HostOutcome, PublicListResult, SearchResponse, SearchStatus, ViewState } from './src/types'
import { HISTORY_AGENTS } from './src/agents'

type PublicSearchStatus = { status: SearchStatus; hosts: HostOutcome[] }

type Flags = Record<string, unknown>
type Args = { positionals: string[]; flags: Flags }

function repeated(value: unknown, name: string, context: CliContext): string[] {
  if (value === undefined) return []
  const input: unknown[] = Array.isArray(value) ? value : [value]
  const output: string[] = []
  for (const item of input) {
    if (typeof item !== 'string' || item === '') throw context.usage(`--${name} expects non-empty values`)
    output.push(item)
  }
  return output
}

function numberFlag(value: unknown, name: string, context: CliContext, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw context.usage(`--${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return number
}

function sinceFlag(value: unknown, context: CliContext): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw context.usage('--since must be an ISO 8601 timestamp with an offset')
  }
  return value
}

function hostOf(flags: Flags): string | undefined {
  return typeof flags.host === 'string' ? flags.host : undefined
}

function listRequest(args: Args, context: CliContext): Record<string, unknown> {
  const paths = repeated(args.flags.path, 'path', context)
  if (paths.length > 64) throw context.usage('--path accepts at most 64 values')
  const agents = repeated(args.flags.agent, 'agent', context)
  const limit = numberFlag(args.flags.limit, 'limit', context, 1, 5000)
  return {
    ...(agents.length === 0 ? {} : { agents }),
    ...(paths.length === 0 ? {} : { scopePaths: paths }),
    ...(limit === undefined ? {} : { limit }),
    ...(args.flags.unlimited === true ? { unlimited: true } : {}),
    ...(args.flags.force === true ? { force: true } : {}),
    ...(args.flags.sort === undefined ? {} : { sort: args.flags.sort }),
    ...(args.flags['hide-empty'] === undefined ? {} : { hideEmpty: args.flags['hide-empty'] }),
    ...(hostOf(args.flags) === undefined ? {} : { host: hostOf(args.flags) })
  }
}

function searchRequest(args: Args, context: CliContext): Record<string, unknown> {
  const query = args.positionals[0]
  if (query === undefined || query === '') throw context.usage('missing <query> (or use --index-status)')
  const paths = repeated(args.flags.path, 'path', context)
  if (paths.length > 64) throw context.usage('--path accepts at most 64 values')
  const agents = repeated(args.flags.agent, 'agent', context)
  const since = sinceFlag(args.flags.since, context)
  const limit = numberFlag(args.flags.limit, 'limit', context, 1, 100)
  if (args.flags.scope !== undefined && args.flags.scope !== 'conversation' && args.flags.scope !== 'all') {
    throw context.usage('--scope must be conversation or all')
  }
  if (args.flags.sort !== undefined && args.flags.sort !== 'relevance' && args.flags.sort !== 'newest') {
    throw context.usage('--sort must be relevance or newest')
  }
  return {
    query,
    ...(args.flags.scope === undefined ? {} : { scope: args.flags.scope }),
    ...(args.flags.fresh === true ? { freshness: 'wait-until-current' } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(args.flags.cursor === undefined ? {} : { cursor: args.flags.cursor }),
    ...(agents.length === 0 && paths.length === 0 && since === undefined && args.flags.sort === undefined
      ? {}
      : { filters: {
          ...(agents.length === 0 ? {} : { agents }),
          ...(paths.length === 0 ? {} : { scopePaths: paths }),
          ...(since === undefined ? {} : { since }),
          ...(args.flags.sort === undefined ? {} : { sort: args.flags.sort })
        } }),
    ...(args.flags.debug === true ? { debug: true } : {}),
    ...(hostOf(args.flags) === undefined ? {} : { host: hostOf(args.flags) })
  }
}

function queryFlagPresent(flags: Flags): boolean {
  return ['scope', 'fresh', 'limit', 'cursor', 'agent', 'path', 'since', 'sort', 'debug'].some((key) => flags[key] !== undefined && flags[key] !== false)
}

const named: CliModule['commands'] = {
  async list(args, context) {
    const result = await context.call('quirky.vault/list', listRequest(args, context)) as PublicListResult
    context.out.result(result, () => result.sessions.length === 0
      ? 'no agent sessions'
      : context.format.table(
          ['ID', 'AGENT', 'TITLE', 'UPDATED', 'MESSAGES'],
          result.sessions.map((session) => [session.id, session.agent, session.title, new Date(session.updatedAt).toISOString(), String(session.messageCount)])
        ))
  },

  async search(args, context) {
    if (args.flags['index-status'] === true) {
      if (args.positionals.length > 0 || queryFlagPresent(args.flags)) {
        throw context.usage('--index-status cannot be combined with query arguments')
      }
      const status = await context.call('quirky.vault/searchStatus', hostOf(args.flags) === undefined ? {} : { host: hostOf(args.flags) })
      context.out.result(status, () => context.format.record([
        ['enabled', String((status as { status: { enabled: boolean } }).status.enabled)],
        ['phase', (status as { status: { phase: string } }).status.phase]
      ]))
      return
    }
    const request = searchRequest(args, context)
    const result = await context.call('quirky.vault/search', request) as SearchResponse
    context.out.result(result, () => result.kind === 'results'
      ? result.hits.length === 0
        ? 'no matching sessions'
        : context.format.table(
            ['ID', 'AGENT', 'TITLE', 'UPDATED', 'SCORE'],
            result.hits.map((hit) => [hit.id, hit.agent, hit.title, new Date(hit.updatedAt).toISOString(), String(hit.score)])
          )
      : context.format.record([['status', result.kind], ['reason', result.kind === 'unavailable' ? result.reason : '']]))
  },

  async 'search-status'(args, context) {
    const result = await context.call('quirky.vault/searchStatus', hostOf(args.flags) === undefined ? {} : { host: hostOf(args.flags) })
    context.out.result(result, () => context.format.record([
      ['enabled', String((result as { status: { enabled: boolean } }).status.enabled)],
      ['phase', (result as { status: { phase: string } }).status.phase]
    ]))
  },

  async enable(args, context) {
    const historyDays = numberFlag(args.flags['history-days'], 'history-days', context, 1, 3650)
    const result = await context.call('quirky.vault/setSearchEnabled', {
      enabled: true,
      ...(historyDays === undefined ? {} : { historyDays }),
      ...(hostOf(args.flags) === undefined ? {} : { host: hostOf(args.flags) })
    })
    context.out.result(result, () => `transcript search ${result ? 'enabled' : 'not enabled'}`)
  },

  async clear(args, context) {
    const result = await context.call('quirky.vault/clearSearchIndex', args.flags.yes === true ? { yes: true } : {}) as { cleared: boolean; reason?: string }
    context.out.result(result, () => result.cleared ? 'search index cleared' : `search index was not cleared: ${result.reason ?? 'unknown reason'}`)
  },

  async get(args, context) {
    const id = args.positionals[0]
    if (id === undefined) throw context.usage('missing <id>')
    const session = await context.call('quirky.vault/get', { id })
    context.out.result(session, () => context.format.record([
      ['id', (session as { id: string }).id],
      ['agent', (session as { agent: string }).agent],
      ['title', (session as { title: string }).title]
    ]))
  },

  async resume(args, context) {
    const id = args.positionals[0]
    if (id === undefined) throw context.usage('missing <id>')
    const result = await context.call('quirky.vault/resume', {
      id,
      ...(args.flags.group === undefined ? {} : { group: args.flags.group }),
      ...(args.flags.worktree === undefined ? {} : { worktree: args.flags.worktree }),
      ...(args.flags.fork === true ? { fork: true } : {})
    })
    context.out.result(result, () => `resumed ${id}`)
  },

  async delete(args, context) {
    const id = args.positionals[0]
    if (id === undefined) throw context.usage('missing <id>')
    const result = await context.call('quirky.vault/deleteSession', {
      id,
      ...(args.flags.yes === true ? { yes: true } : {})
    }) as { deleted: boolean; trashed: number; alreadyMissing: boolean; reason?: string }
    context.out.result(result, () => result.deleted
      ? result.alreadyMissing ? 'source was already missing' : `moved ${result.trashed} source file(s) to Trash`
      : `source was not moved to Trash: ${result.reason ?? 'unknown reason'}`)
  },

  async view(args, context) {
    const patch: Record<string, unknown> = {}
    if (args.flags.group !== undefined) patch.group = args.flags.group
    if (args.flags['browse-sort'] !== undefined) patch.browseSort = args.flags['browse-sort']
    if (args.flags['search-sort'] !== undefined) patch.searchSort = args.flags['search-sort']
    if (args.flags['hide-empty-sessions'] !== undefined) patch.hideEmptySessions = args.flags['hide-empty-sessions']
    if (args.flags['session-limit'] !== undefined) {
      const limit = numberFlag(args.flags['session-limit'], 'session-limit', context, 0, 1000)
      patch.sessionLimit = limit === 0 ? null : limit
    }
    if (args.flags.host !== undefined) patch.host = args.flags.host
    if (args.flags.scope !== undefined) patch.scope = args.flags.scope
    if (args.flags.query !== undefined) patch.query = args.flags.query
    const result = Object.keys(patch).length === 0
      ? await context.call('quirky.vault/getView', {})
      : await context.call('quirky.vault/setView', patch)
    context.out.result(result, () => context.format.record(Object.entries(result as Record<string, unknown>).map(([key, value]) => [key, String(value)])))
  },

  async open(args, context) {
    const agent = typeof args.flags.agent === 'string' ? args.flags.agent : undefined
    const sessionId = typeof args.flags.session === 'string' ? args.flags.session : undefined
    const query = typeof args.flags.query === 'string' ? args.flags.query : undefined
    const knownAgent = agent !== undefined && HISTORY_AGENTS.some((supported) => supported === agent)
    const patch: Record<string, unknown> = { focusedSearch: true, selectedId: null, expandedIds: [] }
    if (agent !== undefined) {
      patch.disabledAgents = knownAgent
        ? HISTORY_AGENTS.filter((supported) => supported !== agent)
        : [...HISTORY_AGENTS]
    }
    let matching: PublicListResult['sessions'][number] | undefined
    if (sessionId !== undefined && (agent === undefined || knownAgent)) {
      const agents = agent === undefined ? [...HISTORY_AGENTS] : [agent]
      const listed = await context.call('quirky.vault/list', { agents, unlimited: true }) as PublicListResult
      const matches = listed.sessions.filter((session) =>
        session.sessionId === sessionId && (agent === undefined || session.agent === agent)
      )
      if (matches.length === 1) matching = matches[0]
    }
    if (matching) {
      patch.selectedId = matching.id
      patch.expandedIds = [matching.id]
      patch.query = query ?? ''
      if (agent === undefined) patch.disabledAgents = HISTORY_AGENTS.filter((supported) => supported !== matching.agent)
    } else if (sessionId !== undefined) {
      patch.query = query ?? sessionId
    } else if (query !== undefined) {
      patch.query = query
    }
    await context.call('quirky.vault/setView', patch)
    const result = await context.call('ui.panel.open', { id: 'panel:quirky.vault/history' })
    context.out.result(result, () => 'opened Agent Session History')
  },

  async settings(_args, context) {
    const result = await context.call('ui.view.open', { id: 'view:quirky.vault/search-settings' })
    context.out.result(result, () => 'opened Agent Session Search settings')
  }
}

export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.vault/${name}`, run]))
}
