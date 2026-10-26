import type { CliContext, CliModule, Worktree } from '@quirky/protocol'

const worktreeRecord = (ctx: CliContext, worktree: Worktree) =>
  ctx.format.record([
    ['id', worktree.id],
    ['name', worktree.name],
    ['branch', worktree.branch ?? '-'],
    ['path', worktree.path]
  ])

const named: CliModule['commands'] = {
  async list(args, ctx) {
    const repo = args.flags.repo
    const worktrees = (await ctx.call('quirky.worktree/list', typeof repo === 'string' && repo ? { repo } : {})) as Worktree[]
    ctx.out.result(worktrees, () =>
      worktrees.length
        ? ctx.format.table(
            ['ID', 'NAME', 'BRANCH', 'PATH'],
            worktrees.map((wt) => [wt.id, wt.name, wt.branch ?? '(detached)', wt.path])
          )
        : 'no worktrees'
    )
  },

  async create(args, ctx) {
    const [repo, name] = args.positionals as [string, string]
    const base = args.flags.base
    const worktree = (await ctx.call('quirky.worktree/create', {
      repo,
      name,
      ...(typeof base === 'string' && base ? { baseRef: base } : {})
    })) as Worktree
    ctx.out.result(worktree, () => worktreeRecord(ctx, worktree))
  },

  async rm(args, ctx) {
    const [worktree] = args.positionals as [string]
    const result = await ctx.call('quirky.worktree/remove', { worktree, ...(args.flags.force === true ? { force: true } : {}) })
    ctx.out.result(result, () => `removed ${worktree}`)
  }
}

// the CLI looks a module command up by its full contribution ID, the module contract by its name
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.worktree/${name}`, run]))
}
