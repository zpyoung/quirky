import { resolve } from 'node:path'
import { RpcErrorCode, type CliArgs, type CliContext, type CliModule, type HookScript, type ProjectGroup, type Repo, type RepoDetails } from '@quirky/protocol'
import { groupSubtreeIds } from './src/groups'

type ScanResult = { repos: { path: string; name: string }[]; truncated: boolean }
type ImportResult = {
  results: { path: string; status: string; repoId?: string; error?: string }[]
  imported: number
  alreadyKnown: number
  failed: number
  groupId?: string
}

const repoRecord = (ctx: CliContext, repo: Repo) =>
  ctx.format.record([
    ['id', repo.id],
    ['name', repo.name],
    ['path', repo.path]
  ])

const groupRecord = (ctx: CliContext, group: ProjectGroup) =>
  ctx.format.record([
    ['id', group.id],
    ['name', group.name],
    ['parent path', group.parentPath ?? '-'],
    ['collapsed', group.collapsed ? 'yes' : 'no'],
    ['projects', String(group.repoIds.length)]
  ])

const oneLine = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ; ')

function hookLine(hook: HookScript | null): string {
  if (!hook) return '-'
  const shared = hook.shared
  if (!shared) return hook.badge
  const trust = shared.trusted ? 'trusted' : shared.changed ? 'changed since it was trusted' : 'not trusted'
  return `${hook.badge} (shared script ${trust})`
}

function detailsRecord(ctx: CliContext, { repo, settings, hooks }: RepoDetails): string {
  const pairs: [string, string][] = [
    ['id', repo.id],
    ['name', repo.name],
    ['display name', repo.displayName ?? '-'],
    ['path', repo.path],
    ['kind', repo.kind],
    ['group', repo.groupId ?? '-'],
    ['default base', settings.defaultBase ?? '-'],
    ['worktree location', settings.worktreeLocation ?? '-'],
    ['setup policy', settings.setupPolicy],
    ['agent startup', settings.agentStartup ?? '-'],
    ['command source', settings.commandSource ?? '-'],
    ['setup script', settings.setupScript ? oneLine(settings.setupScript) : '-'],
    ['archive script', settings.archiveScript ? oneLine(settings.archiveScript) : '-'],
    ['hooks file', hooks.file ?? '-'],
    ['setup', hookLine(hooks.setup)],
    ['archive', hookLine(hooks.archive)],
    ['effective agent startup', hooks.agentStartup ?? '-'],
    ['shared directories', hooks.sharedDirectories.join(', ') || '-']
  ]
  for (const warning of hooks.warnings) pairs.push(['warning', warning])
  return ctx.format.record(pairs)
}

const absolute = (ctx: CliContext, path: string): string => resolve(ctx.cwd, path)

/** A clone source that is a URL or an scp-style `host:path` stays as given; a local path is made absolute. */
const cloneSource = (ctx: CliContext, source: string): string =>
  source.includes('://') || /^[^/\\:]+:/.test(source) ? source : absolute(ctx, source)

/** The flags in `names` that were given, as params under `rename`'s names (default camelCase). */
function flagParams(args: CliArgs, names: Record<string, string>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [flag, param] of Object.entries(names)) {
    if (Object.hasOwn(args.flags, flag) && args.flags[flag] !== undefined) params[param] = args.flags[flag]
  }
  return params
}

const resolvedFlag = (ctx: CliContext, args: CliArgs, flag: string, params: Record<string, unknown>, param: string) => {
  const value = args.flags[flag]
  if (typeof value === 'string' && value !== '') params[param] = absolute(ctx, value)
}

const SET_FLAGS = {
  'display-name': 'displayName',
  'default-base': 'defaultBase',
  'worktree-location': 'worktreeLocation',
  'setup-policy': 'setupPolicy',
  'agent-startup': 'agentStartup',
  'command-source': 'commandSource',
  'setup-script': 'setupScript',
  'archive-script': 'archiveScript'
}

const named: CliModule['commands'] = {
  async add(args, ctx) {
    const [path] = args.positionals as [string]
    const repo = (await ctx.call('quirky.repo/add', {
      path: absolute(ctx, path),
      ...(args.flags.folder === true ? { folder: true } : {})
    })) as Repo
    ctx.out.result(repo, () => repoRecord(ctx, repo))
  },

  async list(_args, ctx) {
    const repos = (await ctx.call('quirky.repo/list')) as Repo[]
    ctx.out.result(repos, () =>
      repos.length ? ctx.format.table(['ID', 'NAME', 'PATH'], repos.map((r) => [r.id, r.name, r.path])) : 'no repos'
    )
  },

  async rm(args, ctx) {
    const [repo] = args.positionals as [string]
    const result = await ctx.call('quirky.repo/remove', { repo, ...flagParams(args, { 'expected-ledgers': 'expectedLedgers' }) })
    ctx.out.result(result, () => `removed ${repo}`)
  },

  async clone(args, ctx) {
    const [url] = args.positionals as [string]
    const params: Record<string, unknown> = { url: cloneSource(ctx, url), ...flagParams(args, { name: 'name' }) }
    resolvedFlag(ctx, args, 'location', params, 'location')
    const repo = (await ctx.call('quirky.repo/clone', params)) as Repo
    ctx.out.result(repo, () => repoRecord(ctx, repo))
  },

  async create(args, ctx) {
    const [name] = args.positionals as [string]
    const params: Record<string, unknown> = { name }
    resolvedFlag(ctx, args, 'location', params, 'location')
    const repo = (await ctx.call('quirky.repo/create', params)) as Repo
    ctx.out.result(repo, () => repoRecord(ctx, repo))
  },

  async scan(args, ctx) {
    const [path] = args.positionals as [string]
    const result = (await ctx.call('quirky.repo/scan', {
      path: absolute(ctx, path),
      ...flagParams(args, { 'max-depth': 'maxDepth', 'max-repos': 'maxRepos' })
    })) as ScanResult
    ctx.out.result(result, () => {
      if (result.repos.length === 0) return 'no repositories found'
      const table = ctx.format.table(['NAME', 'PATH'], result.repos.map((r) => [r.name, r.path]))
      return result.truncated ? `${table}\nstopped at the limit; raise --max-repos to see more` : table
    })
  },

  async import(args, ctx) {
    const [path] = args.positionals as [string]
    const result = (await ctx.call('quirky.repo/import', {
      path: absolute(ctx, path),
      ...flagParams(args, { group: 'group', 'max-depth': 'maxDepth', 'max-repos': 'maxRepos' })
    })) as ImportResult
    ctx.out.result(result, () => {
      const lines = [`imported ${result.imported}, already known ${result.alreadyKnown}, failed ${result.failed}`]
      for (const entry of result.results) if (entry.status === 'failed') lines.push(`failed ${entry.path}: ${entry.error ?? 'unknown error'}`)
      if (result.groupId) lines.push(`group ${String(args.flags.group)} (${result.groupId})`)
      return lines.join('\n')
    })
  },

  async show(args, ctx) {
    const [repo] = args.positionals as [string]
    const details = (await ctx.call('quirky.repo/show', { repo })) as RepoDetails
    ctx.out.result(details, () => detailsRecord(ctx, details))
  },

  async set(args, ctx) {
    const [repo] = args.positionals as [string]
    const changes = flagParams(args, SET_FLAGS)
    if (Object.keys(changes).length === 0) {
      throw ctx.usage(`nothing to set; pass at least one of ${Object.keys(SET_FLAGS).map((flag) => `--${flag}`).join(', ')}`)
    }
    const details = (await ctx.call('quirky.repo/set', { repo, ...changes })) as RepoDetails
    ctx.out.result(details, () => detailsRecord(ctx, details))
  },

  async 'trust-hooks'(args, ctx) {
    const [repo] = args.positionals as [string]
    const kind = typeof args.flags.kind === 'string' ? args.flags.kind : 'all'
    const ref = typeof args.flags.ref === 'string' ? args.flags.ref : undefined
    const details = (await ctx.call('quirky.repo/trustHooks', { repo, kind, ...(ref !== undefined ? { ref } : {}) })) as RepoDetails
    ctx.out.result(details, () => {
      const trusted = (['setup', 'archive'] as const).filter((k) => (kind === 'all' || kind === k) && details.hooks[k]?.shared?.trusted)
      return trusted.length ? `trusted ${trusted.join(', ')} hooks of ${repo}` : `no shared hooks to trust in ${repo}`
    })
  },

  async 'group-list'(_args, ctx) {
    const groups = (await ctx.call('quirky.repo/groupList')) as ProjectGroup[]
    const names = new Map(((await ctx.call('quirky.repo/list')) as Repo[]).map((repo) => [repo.id, repo.name]))
    ctx.out.result(groups, () =>
      groups.length
        ? ctx.format.table(
            ['ID', 'NAME', 'PROJECTS', 'COLLAPSED', 'PARENT'],
            groups.map((g) => [g.id, g.name, g.repoIds.map((id) => names.get(id) ?? id).join(', ') || '-', g.collapsed ? 'yes' : 'no', g.parentPath ?? '-'])
          )
        : 'no groups'
    )
  },

  async 'group-create'(args, ctx) {
    const [name] = args.positionals as [string]
    const group = (await ctx.call('quirky.repo/groupCreate', { name, ...flagParams(args, { 'parent-path': 'parentPath', parent: 'parent' }) })) as ProjectGroup
    ctx.out.result(group, () => groupRecord(ctx, group))
  },
  async 'group-set-parent'(args, ctx) {
    const [group] = args.positionals as [string]
    const parentFlag = args.flags.parent
    const clear = args.flags['no-parent'] === true
    let parent: string | null
    if (clear) {
      if (parentFlag !== undefined) throw ctx.usage('--parent and --no-parent cannot be used together')
      parent = null
    } else if (typeof parentFlag === 'string') {
      parent = parentFlag
    } else {
      throw ctx.usage('pass exactly one of --parent or --no-parent')
    }
    const updated = (await ctx.call('quirky.repo/groupSetParent', { group, parent })) as ProjectGroup
    ctx.out.result(updated, () => groupRecord(ctx, updated))
  },

  async 'group-rename'(args, ctx) {
    const [group, name] = args.positionals as [string, string]
    const renamed = (await ctx.call('quirky.repo/groupRename', { group, name })) as ProjectGroup
    ctx.out.result(renamed, () => groupRecord(ctx, renamed))
  },

  async 'group-delete'(args, ctx) {
    const [group] = args.positionals as [string]
    const groups = (await ctx.call('quirky.repo/groupList')) as ProjectGroup[]
    const idMatch = groups.find((entry) => entry.id === group)
    const nameMatches = idMatch ? [] : groups.filter((entry) => entry.name === group)
    const root = idMatch ?? nameMatches[0]
    if (!root) throw ctx.fail(`no group matches ${group}; use its ID or exact name`)
    if (nameMatches.length > 1) throw ctx.fail(`${group} matches ${nameMatches.length} groups: ${nameMatches.map((entry) => entry.id).join(', ')}`)

    const expectedLedgerParams = flagParams(args, { 'expected-ledgers': 'expectedLedgers' })
    let expectedLedgers: { ledgerId: string; revision: number }[] | undefined
    try {
      const preview = await ctx.call('quirky.ledger/removal-preview', {
        removal: {
          groupIds: groupSubtreeIds(groups, root.id),
          ...(expectedLedgerParams.expectedLedgers !== undefined ? { expectedLedgers: expectedLedgerParams.expectedLedgers } : {})
        }
      })
      const previewObject = typeof preview === 'object' && preview !== null ? (preview as { removalPreview?: unknown }) : undefined
      if (!previewObject || !Array.isArray(previewObject.removalPreview)) {
        throw ctx.fail('ledger removal preview did not return snapshots')
      }
      const snapshots: { ledgerId: string; revision: number }[] = []
      for (const snapshot of previewObject.removalPreview) {
        if (typeof snapshot !== 'object' || snapshot === null) throw ctx.fail('ledger removal preview returned invalid snapshots')
        const { ledgerId, revision } = snapshot as { ledgerId?: unknown; revision?: unknown }
        if (typeof ledgerId !== 'string' || ledgerId.trim() === '' || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
          throw ctx.fail('ledger removal preview returned invalid snapshots')
        }
        snapshots.push({ ledgerId, revision })
      }
      expectedLedgers = snapshots
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== RpcErrorCode.MethodNotFound) throw error
    }
    const result = await ctx.call('quirky.repo/groupDelete', {
      group: root.id,
      ...(expectedLedgers !== undefined ? { expectedLedgers } : {})
    })
    ctx.out.result(result, () => `deleted group ${group}`)
  },

  async 'group-add'(args, ctx) {
    const [group, repo] = args.positionals as [string, string]
    const updated = (await ctx.call('quirky.repo/groupAdd', { group, repo })) as ProjectGroup
    ctx.out.result(updated, () => groupRecord(ctx, updated))
  },

  async 'group-remove'(args, ctx) {
    const [group, repo] = args.positionals as [string, string]
    const updated = (await ctx.call('quirky.repo/groupRemove', { group, repo })) as ProjectGroup
    ctx.out.result(updated, () => groupRecord(ctx, updated))
  },

  async 'group-collapse'(args, ctx) {
    const [group] = args.positionals as [string]
    const updated = (await ctx.call('quirky.repo/groupCollapse', { group, collapsed: args.flags.expand !== true })) as ProjectGroup
    ctx.out.result(updated, () => groupRecord(ctx, updated))
  }
}

// the CLI looks a module command up by its full contribution ID, the module contract by its name
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.repo/${name}`, run]))
}
