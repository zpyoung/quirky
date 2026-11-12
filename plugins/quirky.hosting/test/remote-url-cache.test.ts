import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginContext, Worktree } from '@quirky/protocol'
import { createEnv, type HostingEnv } from '../src/env'

const execFileAsync = promisify(execFile)
const ORIGIN = 'https://github.com/test-owner/test-repo.git'
const ENVIRONMENT_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const

let root = ''
let main = ''
let linked = ''
let env: HostingEnv | undefined
let remoteSpawns = 0
let spawnDelayMs = 0
const savedEnvironment = new Map<string, string | undefined>()

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`)
}

function worktree(path: string): Worktree {
  return { id: 'wt_000000000000', repoId: 'repo_00', path, kind: 'git' } as unknown as Worktree
}

function createContext(): PluginContext {
  const store = { get: () => undefined, run: () => undefined, all: () => [] }
  return {
    pluginId: 'quirky.hosting',
    openStore: () => store,
    error: (_kind: string, message: string) => new Error(message),
    log: () => undefined
  } as unknown as PluginContext
}

function createCountingEnv(): HostingEnv {
  return createEnv(createContext(), {
    exec: async (file, args, options) => {
      if (args[0] === 'remote') remoteSpawns += 1
      if (spawnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, spawnDelayMs))
      return execFileAsync(file, args, { ...options, encoding: 'utf8' })
    }
  })
}

beforeEach(() => {
  for (const key of ENVIRONMENT_KEYS) savedEnvironment.set(key, process.env[key])
  root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-remote-cache-')))
  const gitConfig = join(root, 'gitconfig')
  writeFileSync(gitConfig, '')
  process.env.GIT_CONFIG_GLOBAL = gitConfig
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  delete process.env.GIT_DIR
  delete process.env.GIT_WORK_TREE
  delete process.env.GIT_INDEX_FILE
  main = join(root, 'main')
  linked = join(root, 'linked')
  mkdirSync(main, { recursive: true })
  git(main, 'init', '--quiet', '--initial-branch', 'main')
  git(main, 'config', 'user.name', 'Fixture')
  git(main, 'config', 'user.email', 'fixture@example.test')
  git(main, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(main, 'README.md'), 'fixture\n')
  git(main, 'add', 'README.md')
  git(main, 'commit', '--quiet', '-m', 'fixture')
  git(main, 'remote', 'add', 'origin', ORIGIN)
  git(main, 'worktree', 'add', '--quiet', '-b', 'feature', linked)
  remoteSpawns = 0
  spawnDelayMs = 0
  env = createCountingEnv()
})

afterEach(async () => {
  await env?.dispose()
  env = undefined
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

function subject(): HostingEnv {
  if (!env) throw new Error('env was not created')
  return env
}

describe('remote URL cache', () => {
  test('repeated lookups spawn git remote get-url once per remote', async () => {
    const first = await subject().remoteUrls(worktree(main))
    expect(first).toEqual({ origin: ORIGIN, upstream: null })
    expect(remoteSpawns).toBe(2)
    for (let index = 0; index < 5; index += 1) {
      expect(await subject().remoteUrls(worktree(main))).toEqual(first)
    }
    expect(remoteSpawns).toBe(2)
  })

  test('concurrent lookups share one spawn', async () => {
    spawnDelayMs = 50
    const results = await Promise.all(Array.from({ length: 8 }, () => subject().remoteUrls(worktree(main))))
    for (const result of results) expect(result).toEqual({ origin: ORIGIN, upstream: null })
    expect(remoteSpawns).toBe(2)
  })

  test('set-url on the main checkout is visible on the next lookup', async () => {
    await subject().remoteUrls(worktree(main))
    git(main, 'remote', 'set-url', 'origin', 'https://github.com/other-owner/other-repo.git')
    expect((await subject().remoteUrls(worktree(main))).origin).toBe('https://github.com/other-owner/other-repo.git')
  })

  test('a same-length set-url is still visible on the next lookup', async () => {
    await subject().remoteUrls(worktree(main))
    git(main, 'remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repa.git')
    expect((await subject().remoteUrls(worktree(main))).origin).toBe('https://github.com/test-owner/test-repa.git')
  })

  test('a changed remote in the common config is visible from a linked worktree', async () => {
    expect((await subject().remoteUrls(worktree(linked))).origin).toBe(ORIGIN)
    git(linked, 'remote', 'set-url', 'origin', 'https://github.com/other-owner/other-repo.git')
    expect((await subject().remoteUrls(worktree(linked))).origin).toBe('https://github.com/other-owner/other-repo.git')
    expect((await subject().remoteUrls(worktree(main))).origin).toBe('https://github.com/other-owner/other-repo.git')
  })

  test('linked worktree lookups are cached', async () => {
    await subject().remoteUrls(worktree(linked))
    await subject().remoteUrls(worktree(linked))
    expect(remoteSpawns).toBe(2)
  })

  test('adding upstream is visible on the next lookup for both checkouts', async () => {
    for (const path of [main, linked]) {
      const upstream = `https://github.com/upstream-owner/${path === main ? 'a' : 'b'}.git`
      expect((await subject().remoteUrls(worktree(path))).upstream).toBeNull()
      git(path, 'remote', 'add', 'upstream', upstream)
      expect((await subject().remoteUrls(worktree(path))).upstream).toBe(upstream)
      git(path, 'remote', 'remove', 'upstream')
    }
  })

  test('a missing remote is cached as null and invalidated when it is added', async () => {
    expect((await subject().remoteUrls(worktree(main))).upstream).toBeNull()
    const spawnsAfterFirst = remoteSpawns
    expect((await subject().remoteUrls(worktree(main))).upstream).toBeNull()
    expect(remoteSpawns).toBe(spawnsAfterFirst)
    git(main, 'remote', 'add', 'upstream', 'https://github.com/upstream-owner/repo.git')
    expect((await subject().remoteUrls(worktree(main))).upstream).toBe('https://github.com/upstream-owner/repo.git')
  })

  test('a path with no resolvable git config is not cached', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    await subject().remoteUrls(worktree(plain))
    await subject().remoteUrls(worktree(plain))
    expect(remoteSpawns).toBe(4)
  })

  test('separate env instances do not share cached lookups', async () => {
    await subject().remoteUrls(worktree(main))
    const other = createCountingEnv()
    try {
      await other.remoteUrls(worktree(main))
      expect(remoteSpawns).toBe(4)
    } finally {
      await other.dispose()
    }
  })

  test('a cached value expires after the backstop TTL', async () => {
    const realNow = Date.now
    let now = realNow()
    Date.now = () => now
    try {
      await subject().remoteUrls(worktree(main))
      expect(remoteSpawns).toBe(2)
      now += 6_000
      await subject().remoteUrls(worktree(main))
      expect(remoteSpawns).toBe(4)
    } finally {
      Date.now = realNow
    }
  })
})
