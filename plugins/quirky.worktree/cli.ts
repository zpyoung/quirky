import type { CliArgs, CliContext, CliModule, ProjectGroup, Worktree, WorktreeCreateResult, WorktreeRemoveResult, WorkspaceOriginView } from '@quirky/protocol'
import type { CleanupCandidate, CleanupRemovalResult, CleanupSelection, StockWorktreeOptions, WorktreeSleepState } from './src/control-types'

const worktreeRecord = (ctx: CliContext, worktree: Worktree) =>
  ctx.format.record([
    ['id', worktree.id],
    ['name', worktree.name],
    ['branch', worktree.branch ?? '-'],
    ['path', worktree.path]
  ])

const stringFlag = (args: CliArgs, flag: string): string | undefined => {
  const value = args.flags[flag]
  return typeof value === 'string' ? value : undefined
}
function windowFlag(args: CliArgs, ctx: CliContext): number | undefined {
  const value = args.flags.window
  const window = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : undefined
  if (value === undefined) return undefined
  if (window === undefined || !Number.isSafeInteger(window) || window < 1) {
    throw ctx.usage('--window must be a positive live UI connection ID')
  }
  return window
}

function windowParams(args: CliArgs, ctx: CliContext): Record<string, number> {
  const window = windowFlag(args, ctx)
  return window === undefined ? {} : { window }
}

/** `--on` and `--off` as one boolean: true, false, or undefined when neither was given; both is a usage error. */
function toggle(args: CliArgs, ctx: CliContext, on: string, off: string): boolean | undefined {
  const wantsOn = args.flags[on] === true
  const wantsOff = args.flags[off] === true
  if (wantsOn && wantsOff) throw ctx.usage(`--${on} and --${off} cannot be used together`)
  return wantsOn ? true : wantsOff ? false : undefined
}
function jsonFlag(args: CliArgs, ctx: CliContext, flag: string): unknown {
  const value = args.flags[flag]
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw ctx.usage(`--${flag} must be valid JSON`)
  }
}
type MainUpdateReceipt = {
  status: 'not-requested' | 'fast-forwarded' | 'already-current' | 'not-updated'
  reason?: string
  from?: string
  to?: string
}
type WorktreeCreateReceipt = WorktreeCreateResult & {
  creationReceipt?: {
    sparsePaths: string[]
    sharedDirectories?: string[]
    preparedCheckout?: boolean
    defaultTabs?: Array<{ title: string; tab: string; session: string }>
    main: MainUpdateReceipt
    agentLaunch?: { sessionId: string; launchSettings: { summary: string } | null }
  }
}
type RemoteWorktreeCreateReceipt = {
  runtime: { id: string; name: string; endpoint: string; grantId: string }
  result: WorktreeCreateReceipt
}

function launchOptions(args: CliArgs, ctx: CliContext): { model?: string; options?: Record<string, string | boolean> } {
  const model = stringFlag(args, 'model')
  const effort = stringFlag(args, 'effort')
  const raw = args.flags.option
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]
  const options: Record<string, string | boolean> = Object.create(null)
  for (const entry of entries) {
    if (typeof entry !== 'string') throw ctx.usage('--option expects KEY=VALUE')
    const separator = entry.indexOf('=')
    if (separator < 1) throw ctx.usage(`--option expects KEY=VALUE, got \"${entry}\"`)
    const key = entry.slice(0, separator)
    if (key.length > 64 || ['model', '__proto__', 'constructor', 'prototype'].includes(key)) {
      throw ctx.usage(`--option has an invalid key \"${key}\"`)
    }
    if (Object.hasOwn(options, key)) throw ctx.usage(`--option ${key} given more than once`)
    const value = entry.slice(separator + 1)
    options[key] = value === 'true' ? true : value === 'false' ? false : value
  }
  if (effort !== undefined) {
    if (Object.hasOwn(options, 'effort')) throw ctx.usage('effort is set by both --effort and --option effort=…')
    options.effort = effort
  }
  if (model !== undefined && (model.trim() === '' || model.length > 128)) throw ctx.usage('--model must contain 1 to 128 characters')
  if (model === undefined && effort !== undefined) throw ctx.usage('--effort requires --model')
  if (model === undefined && entries.length > 0) throw ctx.usage('--option requires --model')
  if (Object.keys(options).length > 16) throw ctx.usage('--option may be given at most 16 times')
  return {
    ...(model === undefined ? {} : { model }),
    ...(Object.keys(options).length === 0 ? {} : { options })
  }
}

function sparsePathsFlag(args: CliArgs, ctx: CliContext): string[] | undefined {
  const value = jsonFlag(args, ctx, 'sparse-paths')
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((path) => typeof path === 'string')) {
    throw ctx.usage('--sparse-paths must be a JSON array of path strings')
  }
  return value
}


type ProjectMetadataResult = {
  repoId: string
  identity: { displayName: string | null; icon: string | null; color: string | null; trackerProject: string | null }
  externalVisibility: string
  effectiveExternalVisibility: string
  sharedDirectories: string[]
}

function projectMetadataResult(value: unknown): ProjectMetadataResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const identity = record.identity
  if (typeof record.repoId !== 'string' || typeof identity !== 'object' || identity === null || Array.isArray(identity)) return null
  const fields = identity as Record<string, unknown>
  if (
    (fields.displayName !== null && typeof fields.displayName !== 'string') ||
    (fields.icon !== null && typeof fields.icon !== 'string') ||
    (fields.color !== null && typeof fields.color !== 'string') ||
    (fields.trackerProject !== null && typeof fields.trackerProject !== 'string') ||
    typeof record.externalVisibility !== 'string' || typeof record.effectiveExternalVisibility !== 'string' ||
    !Array.isArray(record.sharedDirectories) || !record.sharedDirectories.every((entry) => typeof entry === 'string')
  ) return null
  return {
    repoId: record.repoId,
    identity: {
      displayName: fields.displayName,
      icon: fields.icon,
      color: fields.color,
      trackerProject: fields.trackerProject
    },
    externalVisibility: record.externalVisibility,
    effectiveExternalVisibility: record.effectiveExternalVisibility,
    sharedDirectories: record.sharedDirectories as string[]
  }
}


const worktreeDetails = (ctx: CliContext, worktree: Worktree & { children: string[] }) => {
  const pairs: [string, string][] = [
    ['id', worktree.id],
    ['name', worktree.name],
    ['display name', worktree.displayName ?? '-'],
    ['kind', worktree.kind],
    ['branch', worktree.branch ?? '-'],
    ['path', worktree.path],
    ['status', worktree.status],
    ['comment', worktree.comment || '-'],
    ['pinned', worktree.pinned ? 'yes' : 'no'],
    ['unread', worktree.unread ? 'yes' : 'no'],
    ['parent', worktree.parentId ?? '-'],
    ['primary', worktree.isMain ? 'yes' : 'no'],
    ['created by', worktree.createdBy],
    ['base', worktree.baseRef ?? '-']
  ]
  if (worktree.linkedPR) pairs.push(['linked PR', `#${worktree.linkedPR.number} ${worktree.linkedPR.title} (${worktree.linkedPR.url})`])
  if (worktree.linkedIssue) pairs.push(['linked issue', `#${worktree.linkedIssue.number} ${worktree.linkedIssue.title} (${worktree.linkedIssue.url})`])
  if (worktree.pushTarget) pairs.push(['push target', `${worktree.pushTarget.remoteName}/${worktree.pushTarget.branchName}`])
  pairs.push(['children', worktree.children.join(', ') || '-'])
  return ctx.format.record(pairs)
}

/** The lines after a create's record: actual create selections and setup/issue/agent receipts. */
function createNotes(result: WorktreeCreateReceipt, agent: string | undefined): string[] {
  const lines = [...result.warnings]
  if (result.baseFallback) lines.push(result.baseFallback.message)
  if (result.worktree.linkedPR) {
    lines.push(`pull request: #${result.worktree.linkedPR.number} ${result.worktree.linkedPR.title} (${result.worktree.linkedPR.url})`)
  } else if (result.worktree.linkedIssue) {
    lines.push(`issue: #${result.worktree.linkedIssue.number} ${result.worktree.linkedIssue.title} (${result.worktree.linkedIssue.url})`)
  }
  if (result.worktree.pushTarget) lines.push(`push target: ${result.worktree.pushTarget.remoteName}/${result.worktree.pushTarget.branchName}`)
  const receipt = result.creationReceipt
  if (receipt?.sparsePaths.length) lines.push(`sparse checkout: ${receipt.sparsePaths.join(', ')}`)
  if (receipt?.preparedCheckout) lines.push('checkout: claimed the exact prepared repo/base checkout')
  if (receipt?.defaultTabs?.length) lines.push(`default tabs: ${receipt.defaultTabs.map((tab) => `${tab.title} (${tab.session})`).join(', ')}`)
  if (receipt?.sharedDirectories?.length) lines.push(`shared directories: ${receipt.sharedDirectories.join(', ')}`)
  if (receipt?.main.status === 'fast-forwarded') lines.push(`main: fast-forwarded to ${receipt.main.to}`)
  else if (receipt?.main.status === 'already-current') lines.push('main: already at the selected base')
  else if (receipt?.main.status === 'not-updated') lines.push(`main: left unchanged (${receipt.main.reason ?? 'not safe to update'})`)
  const { setup } = result
  if (setup.ran === 'terminal') lines.push(`setup: running in the Setup terminal ${setup.sessionId}`)
  else if (setup.ran === 'daemon') {
    lines.push(setup.timedOut ? 'setup: timed out in the daemon' : setup.exitCode === 0 ? 'setup: ran in the daemon (exit 0)' : `setup: failed in the daemon (exit ${setup.exitCode ?? 'signal'})`)
  }
  const issueCommand = result.issueCommand
  if (issueCommand?.ran === 'terminal') lines.push(`issue command: running in the Issue terminal ${issueCommand.sessionId}`)
  else if (issueCommand?.ran === 'daemon') {
    lines.push(issueCommand.timedOut ? 'issue command: timed out in the daemon' : issueCommand.exitCode === 0 ? 'issue command: ran in the daemon (exit 0)' : `issue command: failed in the daemon (exit ${issueCommand.exitCode ?? 'signal'})`)
  } else if (issueCommand?.ran === 'skipped') lines.push('issue command: skipped')
  if (result.agentSessionId) {
    lines.push(`agent: started ${agent ?? 'agent'} in session ${result.agentSessionId}`)
    const summary = receipt?.agentLaunch?.launchSettings?.summary
    if (summary) lines.push(`agent launch: ${summary}`)
  } else if (result.agentPending) lines.push(`agent: ${agent ?? 'agent'} starts when setup finishes`)
  return lines
}

const named: CliModule['commands'] = {
  async list(args, ctx) {
    const repo = stringFlag(args, 'repo')
    const group = stringFlag(args, 'group')
    const worktrees = (await ctx.call('quirky.worktree/list', {
      ...(repo ? { repo } : {}),
      ...(group ? { group } : {})
    })) as Worktree[]
    ctx.out.result(worktrees, () =>
      worktrees.length
        ? ctx.format.table(
            ['ID', 'NAME', 'BRANCH', 'STATUS', 'PATH'],
            worktrees.map((wt) => [wt.id, wt.name, wt.branch ?? (wt.kind === 'folder' ? '-' : '(detached)'), wt.status, wt.path])
          )
        : 'no worktrees'
    )
  },
  async origins(_args, ctx) {
    const origins = (await ctx.call('quirky.worktree/origins', {})) as WorkspaceOriginView[]
    ctx.out.result(origins, () =>
      origins.length
        ? ctx.format.table(
            ['WORKTREE', 'AUTOMATION', 'OTHER CLIENT'],
            origins.map((origin) => [
              origin.worktreeId,
              origin.automation === null ? 'unknown' : origin.automation ? 'yes' : 'no',
              origin.otherClient === null ? 'unknown' : origin.otherClient ? 'yes' : 'no'
            ])
          )
        : 'no workspace origins'
    )
  },
  async 'host-list'(_args, ctx) {
    const result = await ctx.call('quirky.worktree/availableHosts') as {
      hosts: Array<{ id: string; label: string; available: boolean; capabilities: string[] }>
    }
    ctx.out.result(result, () => result.hosts.length
      ? ctx.format.table(
          ['HOST ID', 'LABEL', 'AVAILABLE', 'CAPABILITIES'],
          result.hosts.map((host) => [host.id, host.label, host.available ? 'yes' : 'no', host.capabilities.join(', ') || '-'])
        )
      : 'no authenticated remote hosts')
  },

  async set(args, ctx) {
    const [worktree] = args.positionals as [string]
    const pinned = toggle(args, ctx, 'pin', 'unpin')
    const unread = toggle(args, ctx, 'unread', 'read')
    const parent = stringFlag(args, 'parent-worktree')
    const projectGroupId = stringFlag(args, 'project-group')
    const noParent = args.flags['no-parent'] === true
    const noProjectGroup = args.flags['no-project-group'] === true
    if (parent !== undefined && noParent) throw ctx.usage('--parent-worktree and --no-parent cannot be used together')
    if (projectGroupId !== undefined && noProjectGroup) throw ctx.usage('--project-group and --no-project-group cannot be used together')
    const changes: Record<string, unknown> = {
      ...(stringFlag(args, 'display-name') !== undefined ? { displayName: stringFlag(args, 'display-name') } : {}),
      ...(stringFlag(args, 'comment') !== undefined ? { comment: stringFlag(args, 'comment') } : {}),
      ...(stringFlag(args, 'workspace-status') !== undefined ? { status: stringFlag(args, 'workspace-status') } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(unread !== undefined ? { unread } : {}),
      ...(parent !== undefined ? { parent } : {}),
      ...(noParent ? { noParent: true } : {}),
      ...(projectGroupId !== undefined ? { projectGroupId } : {}),
      ...(noProjectGroup ? { projectGroupId: null } : {})
    }
    if (Object.keys(changes).length === 0) {
      throw ctx.usage(
        'nothing to set; pass at least one of --display-name, --comment, --workspace-status, --pin, --unpin, --unread, --read, --parent-worktree, --no-parent, --project-group, --no-project-group'
      )
    }
    const updated = (await ctx.call('quirky.worktree/set', { worktree, ...changes })) as Worktree
    ctx.out.result(updated, () => worktreeRecord(ctx, updated))
  },

  async 'create-group'(args, ctx) {
    const [selector, name] = args.positionals as [string, string]
    const worktree = (await ctx.call('quirky.worktree/resolve', { selector })) as Worktree
    const result = (await ctx.call('quirky.worktree/createGroup', {
      worktree: selector,
      name,
      expectedInstanceId: worktree.instanceId,
      expectedProjectGroupId: worktree.projectGroupId
    })) as { group: ProjectGroup; worktree: Worktree; assigned: boolean; reason?: string }
    ctx.out.result(result, () => result.assigned
      ? `created group ${result.group.name} and moved ${result.worktree.name}`
      : `created group ${result.group.name} but did not move ${result.worktree.name}: ${result.reason}`)
  },

  async show(args, ctx) {
    const [worktree] = args.positionals as [string]
    const shown = (await ctx.call('quirky.worktree/show', { worktree })) as Worktree & { children: string[] }
    ctx.out.result(shown, () => worktreeDetails(ctx, shown))
  },

  async create(args, ctx) {
    const positionals = args.positionals as string[]
    if (positionals.length > 2) throw ctx.usage(`unexpected argument "${positionals[2]}"`)
    const flagRepo = stringFlag(args, 'repo')
    const flagName = stringFlag(args, 'name')
    const positionalRepo = positionals.length === 2 ? positionals[0] : undefined
    const positionalName = positionals.length === 2 ? positionals[1] : positionals[0]
    if (positionalRepo !== undefined && flagRepo !== undefined) throw ctx.usage('pass the project either as an argument or with --repo, not both')
    if (positionalName !== undefined && flagName !== undefined) throw ctx.usage('pass the name either as an argument or with --name, not both')
    const parent = stringFlag(args, 'parent-worktree')
    const noParent = args.flags['no-parent'] === true
    if (parent !== undefined && noParent) throw ctx.usage('--parent-worktree and --no-parent cannot be used together')
    const submitPrompt = toggle(args, ctx, 'submit-prompt', 'draft-prompt')
    const selection = launchOptions(args, ctx)
    const sparsePaths = sparsePathsFlag(args, ctx)
    const defaultTabs = jsonFlag(args, ctx, 'default-tabs')

    const optional: [string, unknown][] = [
      ['repo', positionalRepo ?? flagRepo],
      ['name', positionalName ?? flagName],
      ['group', stringFlag(args, 'group')],
      ['base', stringFlag(args, 'base')],
      ['github', stringFlag(args, 'github')],
      ['branch', stringFlag(args, 'branch')],
      ['branchName', stringFlag(args, 'branch-name')],
      ['displayName', stringFlag(args, 'display-name')],
      ['comment', stringFlag(args, 'comment')],
      ['parent', parent],
      ['setup', stringFlag(args, 'setup')],
      ['issueCommand', stringFlag(args, 'issue-command')],
      ['trustSetupHash', stringFlag(args, 'trust-setup-hash')],
      ['trustIssueCommandHash', stringFlag(args, 'trust-issue-command-hash')],
      ['agent', stringFlag(args, 'agent')],
      ['prompt', stringFlag(args, 'prompt')],
      ['model', selection.model],
      ['options', selection.options],
      ['sparsePaths', sparsePaths],
      ['environmentRecipe', stringFlag(args, 'environment-recipe')],
      ['defaultTabs', defaultTabs],
      ['host', stringFlag(args, 'host')],
    ]
    const params: Record<string, unknown> = { createdBy: 'cli', ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)) }
    if (noParent) params.noParent = true
    if (submitPrompt !== undefined) params.submitPrompt = submitPrompt
    if (args.flags['trust-setup'] === true) params.trustSetup = true
    if (args.flags['trust-issue-command'] === true) params.trustIssueCommand = true
    if (args.flags['no-fallback'] === true) params.allowLocalBaseFallback = false
    if (args.flags['keep-main'] === true) params.keepMain = true
    if (args.flags.activate === true) params.activate = true
    const onRuntime = stringFlag(args, 'on-runtime')
    if (onRuntime !== undefined) {
      if (stringFlag(args, 'host') !== undefined) throw ctx.usage('--on-runtime and --host cannot be used together')
      if (typeof params.repo !== 'string' || params.repo.trim() === '' || params.group !== undefined) {
        throw ctx.usage('--on-runtime requires an explicit remote Git project selector with --repo, not --group')
      }
      if (params.activate === true || args.flags.window !== undefined) {
        throw ctx.usage('remote worktrees cannot be activated in a local UI window')
      }
      const remoteParams = { ...params }
      delete remoteParams.createdBy
      const remote = (await ctx.call('quirky.worktree/createRemote', { runtime: onRuntime, ...remoteParams })) as RemoteWorktreeCreateReceipt
      ctx.out.result(remote, () => [
        `created ${remote.result.worktree.name} on owner runtime ${remote.runtime.name} (${remote.runtime.id})`,
        `remote worktree: ${remote.result.worktree.id}`,
        `remote path: ${remote.result.worktree.path}`
      ].join('\n'))
      return
    }

    const result = (await ctx.call('quirky.worktree/create', params)) as WorktreeCreateReceipt
    ctx.out.result(result, () => [worktreeRecord(ctx, result.worktree), ...createNotes(result, stringFlag(args, 'agent'))].join('\n'))
  },
  async prefetch(args, ctx) {
    const [repo] = args.positionals as [string]
    if (!repo) throw ctx.usage('a project selector is required')
    const base = stringFlag(args, 'base')
    const result = await ctx.call('quirky.worktree/prefetchCreate', { repo, ...(base === undefined ? {} : { base }) }) as {
      prepared: boolean
      base: string
      reason?: string
    }
    ctx.out.result(result, () => result.prepared
      ? `prepared a locked checkout of ${result.base}`
      : `checkout not prepared: ${result.reason ?? 'preparation is unavailable'}`)
  },

  async rm(args, ctx) {
    const [selector] = args.positionals as [string]
    // the worktree is gone after the remove, so its name and project are read first
    const known = (await ctx.call('quirky.worktree/resolve', { selector }).catch(() => null)) as Pick<Worktree, 'name' | 'repoId'> | null
    const flags: [string, string][] = [
      ['force', 'force'],
      ['with-descendants', 'withDescendants'],
      ['skip-archive', 'skipArchive'],
      ['allow-failed-archive-hook', 'allowFailedArchiveHook']
    ]
    const params: Record<string, unknown> = { worktree: selector }
    for (const [flag, param] of flags) if (args.flags[flag] === true) params[param] = true
    const result = (await ctx.call('quirky.worktree/remove', params)) as WorktreeRemoveResult
    const kept = result.keptBranch
    const repoWords = kept && known && !ctx.out.json ? await repoSelectorFor(ctx, known.repoId) : known?.repoId
    ctx.out.result(result, () => {
      const lines = [`removed ${known?.name ?? selector}`]
      if (kept) {
        lines.push(`kept branch ${kept.name} at ${kept.head} (not merged); delete it with: quirky wt delete-branch ${repoWords ?? '<repo>'} ${kept.name} --head ${kept.head}`)
      }
      return lines.join('\n')
    })
  },

  async options(args, ctx) {
    const groupBy = stringFlag(args, 'group-by')
    const sortBy = stringFlag(args, 'sort-by')
    const projectOrderBy = stringFlag(args, 'project-order-by')
    const compact = toggle(args, ctx, 'compact', 'detailed')
    const showBranch = toggle(args, ctx, 'show-branch', 'hide-branch')
    const showComment = toggle(args, ctx, 'show-comment', 'hide-comment')
    const showSleeping = toggle(args, ctx, 'show-sleeping', 'hide-sleeping')
    const hideCliCreated = toggle(args, ctx, 'hide-cli-created', 'show-cli-created')
    const hideDefaultBranch = toggle(args, ctx, 'hide-default-branch', 'show-default-branch')
    const hideDetached = toggle(args, ctx, 'hide-detached', 'show-detached')
    const hideArchived = toggle(args, ctx, 'hide-archived', 'show-archived')
    const hideOtherClients = toggle(args, ctx, 'hide-other-clients', 'show-other-clients')
    const externalVisibilityDefault = stringFlag(args, 'external-visibility-default')
    const filterRepoIds = jsonFlag(args, ctx, 'filter-repo-ids')
    const showProperties = jsonFlag(args, ctx, 'show-properties')
    const patch: Record<string, unknown> = {
      ...(groupBy === undefined ? {} : { groupBy }),
      ...(sortBy === undefined ? {} : { sortBy }),
      ...(projectOrderBy === undefined ? {} : { projectOrderBy }),
      ...(compact === undefined ? {} : { compact }),
      ...(showBranch === undefined ? {} : { showBranch }),
      ...(showComment === undefined ? {} : { showComment }),
      ...(showSleeping === undefined ? {} : { showSleeping }),
      ...(hideCliCreated === undefined ? {} : { hideCliCreated }),
      ...(hideDefaultBranch === undefined ? {} : { hideDefaultBranch }),
      ...(hideDetached === undefined ? {} : { hideDetached }),
      ...(hideArchived === undefined ? {} : { hideArchived }),
      ...(hideOtherClients === undefined ? {} : { hideOtherClients }),
      ...(externalVisibilityDefault === undefined ? {} : { externalVisibilityDefault }),
      ...(filterRepoIds === undefined ? {} : { filterRepoIds }),
      ...(showProperties === undefined ? {} : { showProperties })
    }
    const options = (await ctx.call(
      Object.keys(patch).length > 0 ? 'quirky.worktree/setOptions' : 'quirky.worktree/options',
      patch
    )) as StockWorktreeOptions
    ctx.out.result(options, () => ctx.format.record([
      ['group by', options.groupBy],
      ['sort by', options.sortBy],
      ['project order', options.projectOrderBy],
      ['compact', options.compact ? 'yes' : 'no'],
      ['show properties', options.showProperties.join(', ')],
      ['show sleeping', options.showSleeping ? 'yes' : 'no'],
      ['hide CLI-created', options.hideCliCreated ? 'yes' : 'no'],
      ['hide default branch', options.hideDefaultBranch ? 'yes' : 'no'],
      ['hide detached', options.hideDetached ? 'yes' : 'no'],
      ['hide archived', options.hideArchived ? 'yes' : 'no'],
      ['hide other desktop clients', options.hideOtherClients ? 'yes' : 'no'],
      ['external default', options.externalVisibilityDefault],
      ['project filter', options.filterRepoIds.join(', ') || 'all']
    ]))
  },

  async reorder(args, ctx) {
    const worktrees = jsonFlag(args, ctx, 'worktrees')
    if (!Array.isArray(worktrees) || worktrees.length === 0 || !worktrees.every((id) => typeof id === 'string')) {
      throw ctx.usage('--worktrees must be a non-empty JSON array of worktree IDs in the desired order')
    }
    const result = await ctx.call('quirky.worktree/reorder', { worktrees })
    ctx.out.result(result, () => `ordered ${worktrees.length} sibling worktrees`)
  },
  async 'reorder-projects'(args, ctx) {
    const projects = jsonFlag(args, ctx, 'projects')
    if (!Array.isArray(projects) || projects.length === 0 || !projects.every((id) => typeof id === 'string')) {
      throw ctx.usage('--projects must be a non-empty JSON array of project IDs in the desired order')
    }
    const result = await ctx.call('quirky.worktree/reorderProjects', { projects })
    ctx.out.result(result, () => `ordered ${projects.length} projects`)
  },

  async 'project-show'(args, ctx) {
    const [repo] = args.positionals as [string]
    const value = await ctx.call('quirky.worktree/projectMetadata', { repo })
    const metadata = projectMetadataResult(value)
    if (!metadata) throw ctx.fail('project metadata response was incomplete')
    ctx.out.result(metadata, () => ctx.format.record([
      ['project', metadata.repoId],
      ['display name', metadata.identity.displayName ?? '-'],
      ['icon', metadata.identity.icon ?? '-'],
      ['color', metadata.identity.color ?? '-'],
      ['tracker project', metadata.identity.trackerProject ?? '-'],
      ['external visibility', metadata.externalVisibility],
      ['effective visibility', metadata.effectiveExternalVisibility],
      ['shared directories', metadata.sharedDirectories.join(', ') || '-']
    ]))
  },

  async 'project-set'(args, ctx) {
    const [repo] = args.positionals as [string]
    const displayName = stringFlag(args, 'display-name')
    const icon = stringFlag(args, 'project-icon')
    const color = stringFlag(args, 'project-color')
    const trackerProject = stringFlag(args, 'tracker-project')
    const externalVisibility = stringFlag(args, 'external-worktree-visibility')
    const sharedDirectories = jsonFlag(args, ctx, 'shared-directories')
    const suppressInbox = toggle(args, ctx, 'suppress-inbox', 'show-inbox')
    const identity: Record<string, string> = {
      ...(displayName === undefined ? {} : { displayName }),
      ...(icon === undefined ? {} : { icon }),
      ...(color === undefined ? {} : { color }),
      ...(trackerProject === undefined ? {} : { trackerProject })
    }
    const hasMetadata = Object.keys(identity).length > 0 || externalVisibility !== undefined || sharedDirectories !== undefined
    if (!hasMetadata && suppressInbox === undefined) throw ctx.usage('pass a project identity field, visibility policy, shared-directory list, or inbox suppression flag')
    let result: unknown
    if (hasMetadata) {
      result = await ctx.call('quirky.worktree/setProjectMetadata', {
        repo,
        ...(Object.keys(identity).length > 0 ? { identity } : {}),
        ...(externalVisibility === undefined ? {} : { externalVisibility }),
        ...(sharedDirectories === undefined ? {} : { sharedDirectories })
      })
    }
    if (suppressInbox !== undefined) {
      result = await ctx.call('quirky.worktree/suppressExternalInbox', { repo, suppressed: suppressInbox })
    }
    ctx.out.result(result, () => `updated project ${repo}`)
  },

  async 'external-inbox'(_args, ctx) {
    const inbox = await ctx.call('quirky.worktree/externalInbox')
    ctx.out.result(inbox, () => JSON.stringify(inbox, null, 2))
  },

  async 'status-list'(_args, ctx) {
    const statuses = await ctx.call('quirky.worktree/statusDefinitions')
    ctx.out.result(statuses, () => ctx.format.table(
      ['ID', 'LABEL', 'COLOR', 'ICON'],
      (statuses as Array<{ id: string; label: string; color: string; icon?: string }>).map((status) => [status.id, status.label, status.color, status.icon ?? '-'])
    ))
  },

  async 'status-set'(args, ctx) {
    const statuses = jsonFlag(args, ctx, 'statuses')
    if (!Array.isArray(statuses)) throw ctx.usage('--statuses must be a JSON array of {id,label,color,icon?} rows')
    const updated = await ctx.call('quirky.worktree/setStatusDefinitions', { statuses })
    ctx.out.result(updated, () => `saved ${(updated as unknown[]).length} workspace statuses`)
  },

  async references(args, ctx) {
    const [worktree] = args.positionals as [string]
    const references = await ctx.call('quirky.worktree/references', { worktree }) as Array<{ id: string; url: string; label: string }>
    ctx.out.result(references, () => references.length
      ? ctx.format.table(['ID', 'LABEL', 'URL'], references.map((reference) => [reference.id, reference.label, reference.url]))
      : 'no linked references')
  },

  async 'link-reference'(args, ctx) {
    const [worktree] = args.positionals as [string]
    const url = stringFlag(args, 'url')
    if (url === undefined) throw ctx.usage('--url is required')
    const label = stringFlag(args, 'label')
    const reference = await ctx.call('quirky.worktree/linkReference', { worktree, url, ...(label === undefined ? {} : { label }) })
    ctx.out.result(reference, () => `linked ${label ?? url}`)
  },

  async 'unlink-reference'(args, ctx) {
    const [worktree, reference] = args.positionals as [string, string]
    const result = await ctx.call('quirky.worktree/unlinkReference', { worktree, reference })
    ctx.out.result(result, () => `unlinked ${reference}`)
  },

  async archive(args, ctx) {
    const [worktree] = args.positionals as [string]
    const archivedAt = args.flags.off === true ? null : Date.now()
    const result = await ctx.call('quirky.worktree/archive', { worktree, archivedAt })
    ctx.out.result(result, () => archivedAt === null ? `unarchived ${worktree}` : `archived ${worktree}`)
  },

  async back(args, ctx) {
    const result = await ctx.call('quirky.worktree/navigationBack', windowParams(args, ctx))
    ctx.out.result(result, () => `navigated back to ${(result as { worktreeId: string }).worktreeId}`)
  },

  async forward(args, ctx) {
    const result = await ctx.call('quirky.worktree/navigationForward', windowParams(args, ctx))
    ctx.out.result(result, () => `navigated forward to ${(result as { worktreeId: string }).worktreeId}`)
  },

  async previous(args, ctx) {
    const result = await ctx.call('quirky.worktree/navigationMove', { direction: 'previous', ...windowParams(args, ctx) })
    ctx.out.result(result, () => `opened previous workspace ${(result as { worktreeId: string }).worktreeId}`)
  },

  async next(args, ctx) {
    const result = await ctx.call('quirky.worktree/navigationMove', { direction: 'next', ...windowParams(args, ctx) })
    ctx.out.result(result, () => `opened next workspace ${(result as { worktreeId: string }).worktreeId}`)
  },

  async index(args, ctx) {
    const [raw] = args.positionals as [string]
    const index = Number(raw)
    const result = await ctx.call('quirky.worktree/navigationIndex', { index, ...windowParams(args, ctx) })
    ctx.out.result(result, () => `opened workspace ${index}: ${(result as { worktreeId: string }).worktreeId}`)
  },

  async 'open-in'(args, ctx) {
    const [worktree] = args.positionals as [string]
    const target = stringFlag(args, 'target') ?? 'terminal'
    const result = await ctx.call('quirky.worktree/openIn', { worktree, target, ...windowParams(args, ctx) })
    ctx.out.result(result, () => `opened ${worktree} in ${target}`)
  },

  async 'sleep-preview'(args, ctx) {
    const [worktree] = args.positionals as [string]
    const withDescendants = args.flags['with-descendants'] === true
    const preview = (await ctx.call('quirky.worktree/sleepPreview', {
      worktree,
      ...(withDescendants ? { withDescendants: true } : {}),
      ...windowParams(args, ctx)
    })) as { worktrees: Array<{ name: string; sleeping: boolean; allowed: boolean; blockers: { code: string; detail: string }[] }> }
    ctx.out.result(preview, () => ctx.format.table(
      ['WORKTREE', 'SLEEPING', 'ALLOWED', 'BLOCKERS'],
      preview.worktrees.map((row) => [
        row.name,
        row.sleeping ? 'yes' : 'no',
        row.allowed ? 'yes' : 'no',
        row.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join('; ') || '-'
      ])
    ))
  },

  async sleep(args, ctx) {
    const [worktree] = args.positionals as [string]
    const withDescendants = args.flags['with-descendants'] === true
    const result = (await ctx.call('quirky.worktree/sleep', {
      worktree,
      ...(withDescendants ? { withDescendants: true } : {}),
      ...windowParams(args, ctx)
    })) as { worktrees: WorktreeSleepState[] }
    ctx.out.result(result, () => `slept ${result.worktrees.map((row) => row.worktreeId).join(', ')}`)
  },

  async wake(args, ctx) {
    const [worktree] = args.positionals as [string]
    const withDescendants = args.flags['with-descendants'] === true
    const result = (await ctx.call('quirky.worktree/wake', {
      worktree,
      ...(withDescendants ? { withDescendants: true } : {})
    })) as { worktrees: WorktreeSleepState[] }
    ctx.out.result(result, () => `woke ${result.worktrees.map((row) => row.worktreeId).join(', ')}`)
  },

  async 'cleanup-preview'(_args, ctx) {
    const preview = (await ctx.call('quirky.worktree/cleanupPreview')) as { candidates: CleanupCandidate[] }
    ctx.out.result(preview, () => preview.candidates.length === 0
      ? 'no idle cleanup candidates'
      : ctx.format.table(
          ['ID', 'NAME', 'ELIGIBLE', 'IGNORED', 'BLOCKERS'],
          preview.candidates.map((row) => [
            row.worktreeId,
            row.name,
            row.eligible ? 'yes' : 'no',
            row.ignored ? 'yes' : 'no',
            row.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join('; ') || '-'
          ])
        ))
  },

  async 'cleanup-ignore'(args, ctx) {
    const [worktreeId] = args.positionals as [string]
    const fingerprint = stringFlag(args, 'fingerprint')
    if (!fingerprint) throw ctx.usage('--fingerprint is required from a current cleanup preview')
    const result = await ctx.call('quirky.worktree/cleanupIgnore', { worktreeId, fingerprint })
    ctx.out.result(result, () => `ignored ${worktreeId}`)
  },

  async 'cleanup-restore'(_args, ctx) {
    const result = await ctx.call('quirky.worktree/cleanupRestoreIgnored') as { restored: number }
    ctx.out.result(result, () => `restored ${result.restored} cleanup suggestions`)
  },

  async 'cleanup-remove'(args, ctx) {
    if (args.flags.confirm !== true) throw ctx.usage('--confirm is required after reviewing the cleanup preview')
    const selection = jsonFlag(args, ctx, 'selection')
    if (!Array.isArray(selection) || selection.length === 0 || !selection.every((row) =>
      typeof row === 'object' && row !== null && 'worktreeId' in row && typeof row.worktreeId === 'string' &&
      'fingerprint' in row && typeof row.fingerprint === 'string'
    )) {
      throw ctx.usage('--selection must be a non-empty JSON array of {worktreeId,fingerprint} rows from cleanup-preview')
    }
    const result = await ctx.call('quirky.worktree/cleanupRemove', {
      selection: selection as CleanupSelection[],
      confirmed: true
    }) as { results: CleanupRemovalResult[] }
    ctx.out.result(result, () => result.results.map((row) =>
      row.removed ? `removed ${row.worktreeId}` : `kept ${row.worktreeId}: ${row.error ?? 'not removed'}`
    ).join('\n'))
    if (result.results.some((row) => !row.removed)) throw ctx.fail('one or more selected cleanup worktrees were not removed')
  },

  async 'delete-branch'(args, ctx) {
    const [repo, branch] = args.positionals as [string, string]
    const head = stringFlag(args, 'head')
    if (head === undefined) throw ctx.usage('--head is required: the commit the branch must still point at')
    const result = await ctx.call('quirky.worktree/deleteBranch', { repo, branch, head })
    ctx.out.result(result, () => `deleted branch ${branch}`)
  }
}

/** The name of a project when no other project shares it, else its ID: what the user can paste back as a repo selector. */
async function repoSelectorFor(ctx: CliContext, repoId: string): Promise<string> {
  try {
    const repos = (await ctx.call('quirky.repo/list')) as { id: string; name: string }[]
    const repo = repos.find((candidate) => candidate.id === repoId)
    return repo && repos.filter((candidate) => candidate.name === repo.name).length === 1 ? repo.name : repoId
  } catch {
    return repoId
  }
}

// the CLI looks a module command up by its full contribution ID, the module contract by its name
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.worktree/${name}`, run]))
}
