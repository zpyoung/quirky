import { setDefaultTimeout } from 'bun:test'
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcError, type Ask, type QuirkyClient, type QuirkyEvent, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { runCli, spawnCli, type CliResult } from '../../../../packages/cli/test/fixtures/fake-daemon'
import { waitForAsync } from '../../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../../packages/daemon/test/plugins/fixtures'
import { git, isolateGitConfig, makeRepo } from '../../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../../quirky.repo/test/harness'
import { makeOrigin, makeProject } from '../../../quirky.worktree/test/fixtures/repos'


/**
 * Per test file: isolates git's config and lifts the test timeout, because each scenario starts a
 * daemon and runs real git many times.
 */
export function isolateScenarioGit(): ReturnType<typeof isolateGitConfig> {
  setDefaultTimeout(60_000)
  return isolateGitConfig()
}

/** The files project `api` and its origin start with; scenarios edit them from here. */
export const BASE_FILES: Record<string, string> = {
  'README.md': 'one\ntwo\n',
  'math.ts': 'a\nb\nc\nd\ne\n',
  'old.ts': 'export const a = 1\nexport const b = 2\n',
  'a.ts': 'one\n',
  'b.ts': 'bee\n',
  'c.ts': 'sea\n'
}

export type Failure = { code: number; message: string; data: { reason?: string } & Record<string, unknown> }

export type Scenario = {
  t: PluginHarness
  client: QuirkyClient
  /** Project api: a clone of the bare `origin` (branch main). */
  repo: Repo
  repoDir: string
  originDir: string
  /** Worktree feat on branch zoe/feat, created from origin/main. */
  feat: Worktree
  events: QuirkyEvent[]
  /** Calls `quirky.git/<method>` on feat unless `params.worktree` says otherwise. */
  api(method: string, params?: Record<string, unknown>): Promise<any>
  /** The failure of a call that must fail. */
  fails(promise: Promise<unknown>): Promise<Failure>
  /** Runs the real CLI with feat as its working directory. */
  cli(args: string[], options?: { cwd?: string }): Promise<CliResult>
  /** Runs the real CLI and answers the confirm ask it opens with `answer`; stderr carries the question. */
  cliAsk(args: string[], answer: boolean): Promise<CliResult>
  /** Number of durable asks created in this scenario. */
  askCount(): Promise<number>
  /** Another worktree of the project, on a new branch of its own name cut from origin/main. */
  addWorktree(name: string): Promise<Worktree>
  /** Runs git in `cwd` (default feat) and returns the exit code and output without throwing. */
  gitTry(cwd: string | null, ...args: string[]): { code: number; out: string }
  /** Adds submodule vendor/lib to feat, commits it, and edits x.c inside it. */
  addSubmodule(): void
  /** Writes `text` at `rel` inside feat, creating folders. */
  write(rel: string, text: string): void
  /** Runs git in feat (or in `cwd`) and returns its trimmed stdout. */
  gitIn(...args: string[]): string
  /** Reasserts the watcher subscription as a FIFO receipt barrier. Await the mutation first; this does not wait for future asynchronous work. */
  flushEvents(): Promise<void>
  changedEvents(): number
  cleanup(): Promise<void>
}

/**
 * A daemon with real repo, worktree and git plugins on real git, one project with a bare origin,
 * and the worktree feat. Destructive calls use the real `quirky.ask` provider.
 */
export async function startScenario(scratch: () => string, options: { files?: Record<string, string> } = {}): Promise<Scenario> {
  const t = await startPluginHarness({
    plugins: ['quirky.repo', 'quirky.worktree', 'quirky.git', 'quirky.ask'],
    realGit: true
  })
  const { client } = t
  const root = realpathSync(makeTempDir('qs-'))
  await client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const files = options.files ?? BASE_FILES
  const originDir = makeOrigin(join(scratch(), 'origin.git'), { files })
  const repoDir = makeProject(join(scratch(), 'api'), { origin: originDir })
  const repo = (await client.callAny('quirky.repo/add', { path: repoDir })) as Repo
  const made = (await client.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'feat',
    branchName: 'zoe/feat',
    base: 'origin/main',
    setup: 'skip'
  })) as WorktreeCreateResult
  const feat = made.worktree
  const watcher = await t.h.connectWithEvents('cli')
  const inFeat = (...args: string[]) => git(feat.path, ...args)

  return {
    t,
    client,
    repo,
    repoDir,
    originDir,
    feat,
    events: watcher.events,
    api: (method, params = {}) => client.callAny(`quirky.git/${method}`, { worktree: feat.id, ...params }),
    async fails(promise) {
      try {
        await promise
      } catch (error) {
        const rpc = error as RpcError
        return { code: rpc.code, message: rpc.message, data: (rpc.data ?? {}) as Failure['data'] }
      }
      throw new Error('expected the call to fail')
    },
    cli: (args, opts = {}) => runCli(args, { home: t.h.home, cwd: opts.cwd ?? feat.path }),
    write(rel, text) {
      mkdirSync(dirname(join(feat.path, rel)), { recursive: true })
      writeFileSync(join(feat.path, rel), text)
    },
    gitIn: inFeat,
    gitTry(cwd, ...args) {
      const r = Bun.spawnSync(['git', ...args], { cwd: cwd ?? feat.path, env: process.env })
      return { code: r.exitCode, out: `${r.stdout}${r.stderr}`.trim() }
    },
    async cliAsk(args, answer) {
      const listed = await client.callAny('quirky.ask/list', {})
      const existing = new Set((listed as Ask[]).map((ask) => ask.id))
      const proc = spawnCli(args, { home: t.h.home, cwd: feat.path })
      const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      const ask = await waitForAsync(async () => {
        const result = await client.callAny('quirky.ask/list', { pendingOnly: true })
        return (result as Ask[]).find((candidate) => !existing.has(candidate.id))
      })
      await client.callAny('quirky.ask/answer', {
        askId: ask.id,
        answers: { confirm: { value: answer, source: 'input' } }
      })
      const [stdout, stderr, code] = await output
      return { code, stdout, stderr }
    },
    async askCount() {
      const asks = await client.callAny('quirky.ask/list', {})
      return (asks as Ask[]).length
    },
    async addWorktree(name) {
      const made = (await client.callAny('quirky.worktree/create', {
        repo: repo.id,
        name,
        branchName: `zoe/${name}`,
        base: 'origin/main',
        setup: 'skip'
      })) as WorktreeCreateResult
      return made.worktree
    },
    addSubmodule() {
      const lib = makeRepo(join(scratch(), 'lib'), { 'x.c': 'int x;\n' })
      git(feat.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
      git(feat.path, 'commit', '-q', '-m', 'add submodule')
      writeFileSync(join(feat.path, 'vendor/lib/x.c'), 'int y;\n')
    },
    async flushEvents() {
      await watcher.client.call('events.subscribe', {})
    },
    changedEvents: () => watcher.events.filter((event) => event.type === 'quirky.git/changed').length,
    cleanup: () => t.cleanup()
  }
}


/**
 * Leaves the branch checked out at `cwd` (default feat) with one commit of `ours` and a branch
 * `branch` (cut from the same point) with one commit of `theirs`; a `null` value deletes the file.
 * Merging or rebasing one onto the other then conflicts on every file both sides touched.
 */
export function diverge(
  s: Scenario,
  theirs: Record<string, string | null>,
  ours: Record<string, string | null>,
  options: { branch?: string; cwd?: string } = {}
): void {
  const cwd = options.cwd ?? s.feat.path
  const run = (...args: string[]) => git(cwd, ...args)
  const mine = run('rev-parse', '--abbrev-ref', 'HEAD')
  const commit = (changes: Record<string, string | null>, message: string) => {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) run('rm', '-q', path)
      else {
        mkdirSync(dirname(join(cwd, path)), { recursive: true })
        writeFileSync(join(cwd, path), text)
        run('add', path)
      }
    }
    run('commit', '-q', '-m', message)
  }
  run('checkout', '-q', '-b', options.branch ?? 'other')
  commit(theirs, 'theirs')
  run('checkout', '-q', mine)
  commit(ours, 'ours')
}

/** Installs an executable hook of the given name in the project's shared hooks directory. */
export function installHook(s: Scenario, name: string, script: string): void {
  const dir = join(s.gitIn('rev-parse', '--git-common-dir'), 'hooks')
  const file = join(dir.startsWith('/') ? dir : join(s.feat.path, dir), name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
}

/** The `error` document `--json` prints for a failed command. */
export function jsonError(result: CliResult): { code: string; message: string; reason?: string; data?: Record<string, any> } {
  return JSON.parse(result.stdout).error
}

/** A second clone of the scenario's origin, for moving the remote under feat. */
export type Peer = {
  dir: string
  /** Runs git in the clone and returns its trimmed stdout. */
  git(...args: string[]): string
  /** Commits `files` on the clone's current branch and returns the new sha. */
  commit(files: Record<string, string>, message?: string): string
  /** Pushes the clone's HEAD to `branch` on origin. */
  push(branch: string, ...flags: string[]): void
}

/** Clones the scenario's origin into `dir`, on a branch of its own tracking `branch` when given. */
export function addPeer(s: Scenario, dir: string, branch?: string): Peer {
  const run = (...args: string[]) => git(dir, ...args)
  mkdirSync(dirname(dir), { recursive: true })
  git(dirname(dir), 'clone', '-q', s.originDir, dir)
  for (const [key, value] of [['user.name', 'Peer'], ['user.email', 'peer@example.com'], ['commit.gpgsign', 'false']]) run('config', key!, value!)
  if (branch) run('checkout', '-q', '-B', branch, `origin/${branch}`)
  return {
    dir,
    git: run,
    commit(files, message = 'peer') {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }
      run('add', '-A')
      run('commit', '-q', '-m', message)
      return run('rev-parse', 'HEAD')
    },
    push: (target, ...flags) => void run('push', '-q', ...flags, 'origin', `HEAD:refs/heads/${target}`)
  }
}

/** Commits `files` in feat and returns the new sha. */
export function commitInFeat(s: Scenario, files: Record<string, string>, message = 'feat work'): string {
  for (const [path, text] of Object.entries(files)) s.write(path, text)
  s.gitIn('add', '-A')
  s.gitIn('commit', '-q', '-m', message)
  return s.gitIn('rev-parse', 'HEAD')
}

/** The sha of `branch` in the scenario's bare origin, or null when it has none. */
export function originHead(s: Scenario, branch: string): string | null {
  const result = Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: s.originDir, env: process.env })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}
