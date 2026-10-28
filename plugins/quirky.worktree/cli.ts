import type { CliArgs, CliContext, CliModule, ProjectGroup, Worktree, WorktreeCreateResult, WorktreeRemoveResult } from '@quirky/protocol'

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

/** `--on` and `--off` as one boolean: true, false, or undefined when neither was given; both is a usage error. */
function toggle(args: CliArgs, ctx: CliContext, on: string, off: string): boolean | undefined {
  const wantsOn = args.flags[on] === true
  const wantsOff = args.flags[off] === true
  if (wantsOn && wantsOff) throw ctx.usage(`--${on} and --${off} cannot be used together`)
  return wantsOn ? true : wantsOff ? false : undefined
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

/** The lines after a create's record: warnings, fallback, setup and issue-command outcomes, then the agent. */
function createNotes(result: WorktreeCreateResult, agent: string | undefined): string[] {
  const lines = [...result.warnings]
  if (result.baseFallback) lines.push(result.baseFallback.message)
  if (result.worktree.linkedPR) {
    lines.push(`pull request: #${result.worktree.linkedPR.number} ${result.worktree.linkedPR.title} (${result.worktree.linkedPR.url})`)
  } else if (result.worktree.linkedIssue) {
    lines.push(`issue: #${result.worktree.linkedIssue.number} ${result.worktree.linkedIssue.title} (${result.worktree.linkedIssue.url})`)
  }
  if (result.worktree.pushTarget) lines.push(`push target: ${result.worktree.pushTarget.remoteName}/${result.worktree.pushTarget.branchName}`)
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
  if (result.agentSessionId) lines.push(`agent: started ${agent ?? 'agent'} in session ${result.agentSessionId}`)
  else if (result.agentPending) lines.push(`agent: ${agent ?? 'agent'} starts when setup finishes`)
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
      ['agent', stringFlag(args, 'agent')],
      ['prompt', stringFlag(args, 'prompt')]
    ]
    const params: Record<string, unknown> = { createdBy: 'cli', ...Object.fromEntries(optional.filter(([, value]) => value !== undefined)) }
    if (noParent) params.noParent = true
    if (args.flags['trust-setup'] === true) params.trustSetup = true
    if (args.flags['trust-issue-command'] === true) params.trustIssueCommand = true
    if (args.flags['no-fallback'] === true) params.allowLocalBaseFallback = false
    if (args.flags.activate === true) params.activate = true

    const result = (await ctx.call('quirky.worktree/create', params)) as WorktreeCreateResult
    ctx.out.result(result, () => [worktreeRecord(ctx, result.worktree), ...createNotes(result, stringFlag(args, 'agent'))].join('\n'))
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
