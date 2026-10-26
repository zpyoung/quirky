import { flagBoolean, flagString } from '../args'
import { formatRecord, formatTable } from '../output'
import { takePositionals } from './support'
import type { Command } from './types'

export const wtList: Command = {
  name: 'wt list',
  summary: 'list worktrees',
  positionals: [],
  flags: {
    repo: { type: 'string', description: 'only worktrees of this repository' }
  },
  methods: ['worktree.list'],
  plugin: null,
  async run(args, ctx) {
    takePositionals(args, [])
    const repoId = flagString(args, 'repo')
    const worktrees = await ctx.rpc.call('worktree.list', repoId ? { repoId } : {})
    ctx.out.result(worktrees, () =>
      worktrees.length
        ? formatTable(
            ['ID', 'NAME', 'BRANCH', 'PATH'],
            worktrees.map((wt) => [wt.id, wt.name, wt.branch ?? '(detached)', wt.path])
          )
        : 'no worktrees'
    )
  }
}

export const wtCreate: Command = {
  name: 'wt create',
  summary: 'create a worktree and branch',
  positionals: [{ name: 'repoId', description: 'the repository', required: true }, { name: 'name', description: 'name for the worktree and branch', required: true }],
  flags: {
    base: { type: 'string', description: 'ref to branch from' }
  },
  methods: ['worktree.create'],
  plugin: null,
  async run(args, ctx) {
    const [repoId, name] = takePositionals(args, ['repoId', 'name'])
    const baseRef = flagString(args, 'base')
    const worktree = await ctx.rpc.call('worktree.create', { repoId, name, ...(baseRef ? { baseRef } : {}) })
    ctx.out.result(worktree, () =>
      formatRecord([['id', worktree.id], ['name', worktree.name], ['branch', worktree.branch], ['path', worktree.path]])
    )
  }
}

export const wtRm: Command = {
  name: 'wt rm',
  summary: 'remove a worktree',
  positionals: [{ name: 'worktreeId', description: 'the worktree to remove', required: true }],
  flags: {
    force: { type: 'boolean', description: 'remove even with uncommitted changes' }
  },
  methods: ['worktree.remove'],
  plugin: null,
  async run(args, ctx) {
    const [worktreeId] = takePositionals(args, ['worktreeId'])
    const force = flagBoolean(args, 'force')
    const result = await ctx.rpc.call('worktree.remove', { worktreeId, ...(force ? { force } : {}) })
    ctx.out.result(result, () => `removed ${worktreeId}`)
  }
}
