import { Database } from 'bun:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QuirkyEvent, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { startAgentsE2E, type CliResult, type E2E, type FakeBehavior } from '../../../quirky.agents/test/support/e2e'

export type { CliResult, FakeBehavior }

/** What a one-shot fake agent does after it has recorded its argv, folder and stdin. */
export type OneShotFake = {
  /** Printed to stdout once stdin is closed. */
  reply?: string
  stderr?: string
  exitCode?: number
  /** Prints this many bytes of `a` instead of `reply`. */
  bytes?: number
  /** Ignores SIGTERM and starts a child that does too, then waits; its pids are recorded. */
  hangs?: boolean
  /** Starts a child, then sleeps this long before replying. */
  slowSeconds?: number
}

export type Recorded = { runs: number; argv: string[]; stdin: string; cwd: string; closed: boolean }

export type AiWorldOptions = {
  fakes?: Record<string, FakeBehavior | true>
  /** `QUIRKY_TEST_GENERATE_TIMEOUT_MS` for the daemon: the one-shot time limit in milliseconds. */
  generateTimeoutMs?: number
  /** Multiplies the agents' delivery timers; 1 by default. */
  timeScale?: number
}

/**
 * A real `quirkyd` with every built-in plugin and a real PTY host, fake agent CLIs, and project
 * `api` (branch main, files `math.ts` and `util.ts`) with the worktree `feat` on branch `zoe/feat`.
 * Everything lives in temporary directories; nothing outside them is read or written.
 */
export type AiWorld = {
  e2e: E2E
  feat: Worktree
  call(method: string, params?: Record<string, unknown>): Promise<any>
  /** Calls `quirky.git/<method>` on feat unless `params.worktree` says otherwise. */
  api(method: string, params?: Record<string, unknown>): Promise<any>
  /** Runs the real CLI with feat as its working directory. */
  cli(args: string[]): Promise<CliResult>
  /** Runs git in feat with the test identity and returns its output untrimmed. */
  git(...args: string[]): string
  /** Runs git in feat and reports its exit code and output instead of throwing. */
  gitTry(...args: string[]): { code: number; out: string }
  gitIn(cwd: string, ...args: string[]): string
  /** Writes `text` at `rel` inside feat, creating folders. */
  write(rel: string, text: string): void
  /** Installs an executable hook of the given name in the project's shared hooks directory. */
  hook(name: string, script: string): void
  /** Adds a bare `origin` with main pushed, so feat can be pushed. */
  addOrigin(): string
  /** Installs `name` as a one-shot agent that records each run, and has the agents plugin detect it. */
  oneShot(name: string, behavior?: OneShotFake): Promise<void>
  recorded(name: string): Recorded
  /** The pid files a `hangs` fake wrote: the agent and its child. */
  pids(name: string): { agent: number; child: number }
  /** Every `quirky.git/aiChanged` event received so far. */
  aiChanged(): QuirkyEvent[]
  /** Raw rows of the plugin's `recipes` table, read from its store file. */
  storedRecipes(): { scope: string; action: string; agent: string | null; args: string | null; template: string | null }[]
  cleanup(): Promise<void>
}

const CLI_MAIN = join(import.meta.dir, '../../../../packages/cli/src/main.ts')
const IDENTITY = ['-c', 'user.name=qg', '-c', 'user.email=qg@example.test', '-c', 'commit.gpgsign=false']

const GIT_ENV = (cwd: string) => ({ PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_EDITOR: 'true' })

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...IDENTITY, ...args], { cwd, env: GIT_ENV(cwd) })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function oneShotScript(rec: string, behavior: OneShotFake): string {
  const body = ['cat > "$R.stdin"', 'echo closed > "$R.eof"']
  if (behavior.hangs) body.push(`trap '' TERM`, 'echo $$ > "$R.pid"', 'sleep 300 &', 'echo $! > "$R.child"', 'wait')
  if (behavior.slowSeconds !== undefined) body.push(`sleep ${behavior.slowSeconds} &`, 'echo $! > "$R.child"', 'echo $$ > "$R.pid"', 'wait')
  if (behavior.stderr !== undefined) body.push('cat "$R.stderr" >&2')
  if (behavior.bytes !== undefined) body.push(`head -c ${behavior.bytes} /dev/zero | tr '\\0' 'a'`)
  else body.push('cat "$R.reply"')
  if (behavior.exitCode !== undefined) body.push(`exit ${behavior.exitCode}`)
  return [
    '#!/bin/sh',
    'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then echo "0.0.0 (fake)"; exit 0; fi',
    `R=${JSON.stringify(rec)}`,
    'echo x >> "$R.runs"',
    `: > "$R.argv"; for a in "$@"; do printf '%s\\0' "$a" >> "$R.argv"; done`,
    'pwd -P > "$R.cwd"',
    ...body,
    ''
  ].join('\n')
}

export async function startAiWorld(options: AiWorldOptions = {}): Promise<AiWorld> {
  const extraEnv: Record<string, string> = options.generateTimeoutMs === undefined ? {} : { QUIRKY_TEST_GENERATE_TIMEOUT_MS: String(options.generateTimeoutMs) }
  const e2e = await startAgentsE2E({ fakes: options.fakes ?? {}, timeScale: options.timeScale ?? 1, extraEnv })
  const events: QuirkyEvent[] = []
  e2e.client.onEvent((event) => events.push(event))
  await e2e.client.call('events.subscribe', {})
  const call: AiWorld['call'] = (method, params = {}) => e2e.client.callAny(method, params)

  // the daemon's own commits need an identity, and its home is the temporary one
  writeFileSync(join(e2e.userHome, '.gitconfig'), '[user]\n\tname = qg\n\temail = qg@example.test\n')
  const sources: [string, string][] = [
    ['math.ts', Array.from({ length: 40 }, (_, i) => `const m${i + 1} = ${i + 1}`).join('\n') + '\n'],
    ['util.ts', 'export const a = 1\nexport const b = 2\nexport const c = 3\nexport const d = 4\n']
  ]
  for (const [name, text] of sources) writeFileSync(join(e2e.repo, name), text)
  runGit(e2e.repo, ['add', '.'])
  runGit(e2e.repo, ['commit', '-q', '-m', 'add sources'])
  await call('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: join(dirname(e2e.home), 'worktrees') })
  const repo = (await call('quirky.repo/list')).find((entry: { path: string }) => entry.path === e2e.repo)
  const made = (await call('quirky.worktree/create', { repo: repo.id, name: 'feat', branchName: 'zoe/feat', base: 'main', setup: 'skip' })) as WorktreeCreateResult
  const feat = made.worktree

  const processes = new Set<ReturnType<typeof Bun.spawn>>()
  const rec = (name: string) => join(e2e.fakebin, `rec-${name}`)
  const readRec = (name: string, ext: string) => (existsSync(`${rec(name)}.${ext}`) ? readFileSync(`${rec(name)}.${ext}`, 'utf8') : '')
  const pidOf = (name: string, ext: string) => Number(readRec(name, ext).trim())

  return {
    e2e,
    feat,
    call,
    api: (method, params = {}) => call(`quirky.git/${method}`, { worktree: feat.id, ...params }),
    cli: async (args) => {
      const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
        cwd: feat.path,
        env: { PATH: `${e2e.fakebin}:/usr/bin:/bin`, HOME: e2e.userHome, QUIRKY_HOME: e2e.home },
        stdout: 'pipe',
        stderr: 'pipe'
      })
      processes.add(proc)
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text(), proc.exited])
      processes.delete(proc)
      return { code, stdout, stderr }
    },
    git: (...args) => runGit(feat.path, args),
    gitTry(...args) {
      const result = Bun.spawnSync(['git', ...IDENTITY, ...args], { cwd: feat.path, env: GIT_ENV(feat.path) })
      return { code: result.exitCode, out: `${result.stdout}${result.stderr}` }
    },
    gitIn: (cwd, ...args) => runGit(cwd, args),
    write(rel, text) {
      mkdirSync(dirname(join(feat.path, rel)), { recursive: true })
      writeFileSync(join(feat.path, rel), text)
    },
    hook(name, script) {
      const dir = join(runGit(feat.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'hooks')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, name), `#!/bin/sh\n${script}\n`)
      chmodSync(join(dir, name), 0o755)
    },
    addOrigin() {
      const origin = join(dirname(e2e.home), 'origin.git')
      mkdirSync(origin)
      runGit(origin, ['init', '-q', '--bare', '-b', 'main'])
      runGit(e2e.repo, ['remote', 'add', 'origin', origin])
      runGit(e2e.repo, ['push', '-q', 'origin', 'main'])
      return origin
    },
    async oneShot(name, behavior = {}) {
      const path = join(e2e.fakebin, name)
      const isNew = !existsSync(path)
      writeFileSync(path, oneShotScript(rec(name), behavior))
      chmodSync(path, 0o755)
      writeFileSync(`${rec(name)}.reply`, behavior.reply ?? '')
      if (behavior.stderr !== undefined) writeFileSync(`${rec(name)}.stderr`, behavior.stderr)
      if (isNew) await call('quirky.agents/refresh')
    },
    recorded(name) {
      const argv = readRec(name, 'argv')
      return {
        runs: readRec(name, 'runs').split('\n').filter(Boolean).length,
        argv: argv === '' ? [] : argv.slice(0, -1).split('\0'),
        stdin: readRec(name, 'stdin'),
        cwd: readRec(name, 'cwd').trim(),
        closed: readRec(name, 'eof').trim() === 'closed'
      }
    },
    pids: (name) => ({ agent: pidOf(name, 'pid'), child: pidOf(name, 'child') }),
    aiChanged: () => events.filter((event) => event.type === 'quirky.git/aiChanged'),
    storedRecipes() {
      const db = new Database(join(e2e.home, 'plugin-data', 'quirky.git', 'store.db'), { readonly: true })
      try {
        return db.query('SELECT scope, action, agent, args, template FROM recipes ORDER BY scope, action').all() as ReturnType<AiWorld['storedRecipes']>
      } finally {
        db.close()
      }
    },
    async cleanup() {
      for (const proc of processes) proc.kill('SIGKILL')
      await e2e.cleanup()
    }
  }
}
