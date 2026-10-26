import { resolve } from 'node:path'
import type { CliContext, CliModule, Repo } from '@quirky/protocol'

const repoRecord = (ctx: CliContext, repo: Repo) =>
  ctx.format.record([
    ['id', repo.id],
    ['name', repo.name],
    ['path', repo.path]
  ])

const named: CliModule['commands'] = {
  async add(args, ctx) {
    const [path] = args.positionals as [string]
    const repo = (await ctx.call('quirky.repo/add', { path: resolve(ctx.cwd, path) })) as Repo
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
    const result = await ctx.call('quirky.repo/remove', { repo })
    ctx.out.result(result, () => `removed ${repo}`)
  }
}

// the CLI looks a module command up by its full contribution ID, the module contract by its name
export const commands: CliModule['commands'] = {
  ...named,
  ...Object.fromEntries(Object.entries(named).map(([name, run]) => [`cli-command:quirky.repo/${name}`, run]))
}
