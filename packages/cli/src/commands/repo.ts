import { resolve } from 'node:path'
import type { Repo } from '@quirky/protocol'
import { formatRecord, formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

const repoRecord = (repo: Repo) => formatRecord([['id', repo.id], ['name', repo.name], ['path', repo.path]])

export const repoAdd: Command = {
  name: 'repo add',
  summary: 'add a git repository',
  positionals: [{ name: 'path', description: 'path to the git repository', required: true }],
  flags: {},
  methods: ['repo.add'],
  plugin: null,
  async run(args, ctx) {
    const [path] = takePositionals(args, ['path'])
    const repo = await ctx.rpc.call('repo.add', { path: resolve(ctx.cwd, path) })
    ctx.out.result(repo, () => repoRecord(repo))
  }
}

export const repoList: Command = {
  name: 'repo list',
  summary: 'list repositories',
  positionals: [],
  flags: {},
  methods: ['repo.list'],
  plugin: null,
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
  summary: 'remove a repository from Quirky',
  positionals: [{ name: 'repoId', description: 'the repository to remove', required: true }],
  flags: {},
  methods: ['repo.remove'],
  plugin: null,
  async run(args, ctx) {
    const [repoId] = takePositionals(args, ['repoId'])
    const result = await ctx.rpc.call('repo.remove', { repoId })
    ctx.out.result(result, () => `removed ${repoId}`)
  }
}
