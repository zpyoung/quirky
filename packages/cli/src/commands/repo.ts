import { resolve } from 'node:path'
import type { Repo } from '@quirky/protocol'
import { formatRecord, formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

const repoRecord = (repo: Repo) => formatRecord([['id', repo.id], ['name', repo.name], ['path', repo.path]])

export const repoAdd: Command = {
  name: 'repo add',
  usage: 'repo add <path>',
  summary: 'add a git repository',
  flags: {},
  async run(args, ctx) {
    const [path] = takePositionals(args, ['path'])
    const repo = await ctx.rpc.call('repo.add', { path: resolve(ctx.cwd, path) })
    ctx.out.result(repo, () => repoRecord(repo))
  }
}

export const repoList: Command = {
  name: 'repo list',
  usage: 'repo list',
  summary: 'list repositories',
  flags: {},
  async run(args, ctx) {
    takePositionals(args, [])
    const repos = await ctx.rpc.call('repo.list', {})
    ctx.out.result(repos, () =>
      repos.length ? formatTable(['ID', 'NAME', 'PATH'], repos.map((r) => [r.id, r.name, r.path])) : 'no repos'
    )
  }
}

export const repoRm: Command = {
  name: 'repo rm',
  usage: 'repo rm <repoId>',
  summary: 'remove a repository from Quirky',
  flags: {},
  async run(args, ctx) {
    const [repoId] = takePositionals(args, ['repoId'])
    const result = await ctx.rpc.call('repo.remove', { repoId })
    ctx.out.result(result, () => `removed ${repoId}`)
  }
}
