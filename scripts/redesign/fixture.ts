#!/usr/bin/env bun
/**
 * Starts, seeds and stops a headless Quirky fixture for the redesigning-features skill: a private
 * daemon in a temp home with real Git fixtures and the built renderer served over HTTP, so a run can
 * drive the app in a browser without opening a window or touching the user's own Quirky.
 *
 *   bun scripts/redesign/fixture.ts start <out-dir> [--theme dark|light] [--open <contribution-id>]...
 *   bun scripts/redesign/fixture.ts seed <out-dir> <script-path>
 *   bun scripts/redesign/fixture.ts stop <out-dir>
 *
 * Every invocation prints one JSON object on stdout and diagnostics on stderr. Exit 0 is success, 1 a
 * checked failure the JSON describes, 2 bad arguments or a missing fixture. Errors with no result of
 * their own print `{"error": "<message>"}`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { connectDaemon, isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { createProcessScope } from '../test-support/process-scope.ts'
import { createIsolatedRuntimeEnvironment, prepareCaptureFixtureHome, registerCaptureFixtures } from '../ui-review/fixtures.ts'
import type { FixtureInfo, Theme } from './contracts.ts'

const repoRoot = resolve(dirname(import.meta.dir), '..')

const DAEMON_START_ATTEMPTS = 300
const FIXTURE_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 30_000
const SEED_IDENTITY = { name: 'Redesign Fixture', email: 'redesign-fixture@localhost' }

export type FixtureCommand =
  | { kind: 'start'; out: string; theme: Theme; open: string[] }
  | { kind: 'seed'; out: string; script: string }
  | { kind: 'stop'; out: string }

/** A bad command line; `main` answers it with exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Parses `argv` (the arguments after the script name); paths come back absolute. Throws `UsageError`. */
export function parseFixtureArgs(argv: string[]): FixtureCommand {
  const [kind, ...rest] = argv
  if (kind !== 'start' && kind !== 'seed' && kind !== 'stop') {
    throw new UsageError('first argument must be start, seed or stop')
  }
  let parsed: ReturnType<typeof parseArgs<{ options: { theme: { type: 'string' }; open: { type: 'string'; multiple: true } }; allowPositionals: true }>>
  try {
    parsed = parseArgs({
      args: rest,
      options: { theme: { type: 'string' }, open: { type: 'string', multiple: true } },
      allowPositionals: true,
      strict: true
    })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  const { positionals, values } = parsed
  const arity = kind === 'seed' ? 2 : 1
  if (positionals.length !== arity) {
    const want = kind === 'seed' ? '<out-dir> <script-path>' : '<out-dir>'
    throw new UsageError(`${kind} takes ${want}`)
  }
  const out = resolve(positionals[0]!)
  if (kind !== 'start') {
    if (values.theme !== undefined || values.open !== undefined) throw new UsageError(`${kind} takes no flags`)
    return kind === 'seed' ? { kind, out, script: resolve(positionals[1]!) } : { kind, out }
  }
  const theme = values.theme ?? 'dark'
  if (theme !== 'dark' && theme !== 'light') throw new UsageError('--theme must be dark or light')
  const open = values.open ?? []
  if (open.some((id) => id === '')) throw new UsageError('--open needs a contribution id')
  return { kind, out, theme, open }
}

function suffix(name: string): string {
  return name.toUpperCase().replaceAll('-', '_')
}

/**
 * The only environment a seed script sees: the fixture's isolated runtime environment plus the
 * `REDESIGN_*` pointers and a Git identity. Nothing is copied from the caller's environment, so a
 * seed cannot reach the user's `~/.quirky` or this session's Quirky ids.
 */
export function seedEnvironment(info: FixtureInfo, repoRoot: string): Record<string, string> {
  const env: Record<string, string> = {
    ...createIsolatedRuntimeEnvironment(info.home, { repoRoot }),
    REDESIGN_REPO: info.repos.primary,
    REDESIGN_QUIRKY: `${process.execPath} ${join(repoRoot, 'packages/cli/src/main.ts')}`,
    GIT_AUTHOR_NAME: SEED_IDENTITY.name,
    GIT_AUTHOR_EMAIL: SEED_IDENTITY.email,
    GIT_COMMITTER_NAME: SEED_IDENTITY.name,
    GIT_COMMITTER_EMAIL: SEED_IDENTITY.email
  }
  for (const [name, path] of Object.entries(info.repos.worktrees)) env[`REDESIGN_WORKTREE_${suffix(name)}`] = path
  for (const [name, path] of Object.entries(info.repos.projects)) env[`REDESIGN_PROJECT_${suffix(name)}`] = path
  return env
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function emitError(message: string): void {
  console.error(message)
  emit({ error: message })
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readInfo(out: string): FixtureInfo | undefined {
  const path = join(out, 'fixture.json')
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FixtureInfo) : undefined
}

/** True when `pid` is a live `fixture.ts start` for `out`, so a recycled pid is never signalled. */
function ownsFixture(pid: number, out: string): boolean {
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (ps.status !== 0) return false
  const command = ps.stdout
  return (
    command.includes('scripts/redesign/fixture.ts') &&
    command.includes(' start ') &&
    (command.includes(out) || command.includes(relative(process.cwd(), out)))
  )
}

async function start(command: Extract<FixtureCommand, { kind: 'start' }>): Promise<void> {
  const { out, theme, open } = command
  mkdirSync(out, { recursive: true })
  const uiDir = join(out, 'ui-dist')
  const fixtureJson = join(out, 'fixture.json')
  const scope = createProcessScope()
  let closeClient = () => {}
  let stopping = false

  const stop = async (code: number) => {
    if (stopping) return
    stopping = true
    try {
      closeClient()
    } catch {
      // the daemon may already be gone; cleanup below still has to run
    }
    await scope.cleanup()
    rmSync(fixtureJson, { force: true })
    process.exit(code)
  }
  process.on('SIGTERM', () => void stop(0))
  process.on('SIGINT', () => void stop(0))

  try {
    const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot, uiDir })
    // fd 2 keeps build and daemon output off stdout, which carries only the result JSON
    const build = Bun.spawn([process.execPath, join(repoRoot, 'packages/ui/build.ts')], {
      cwd: repoRoot,
      env: { ...env, QUIRKY_UI_OUT: uiDir },
      stdout: 2,
      stderr: 'inherit'
    })
    if (await build.exited) throw new Error('the renderer build failed')
    const prepared = await prepareCaptureFixtureHome(scope.home, { timeoutMs: FIXTURE_TIMEOUT_MS, env })
    scope.spawn([process.execPath, join(repoRoot, 'packages/daemon/src/main.ts')], {
      cwd: repoRoot,
      env,
      stdin: 'ignore',
      stdout: 2,
      stderr: 'inherit'
    })
    const runtime = await waitForRuntime(scope.home)
    const client = await connectDaemon({ home: scope.home, role: 'cli', name: 'redesign-fixture', autostart: false })
    closeClient = () => client.close()
    const status = (await client.callAny('status.get', {})) as { home?: string }
    if (status.home !== scope.home) throw new Error('the fixture daemon reports a different home')
    const fixtures = await registerCaptureFixtures(client, prepared, { timeoutMs: FIXTURE_TIMEOUT_MS })

    await client.callAny('theme.set', { id: theme })
    // worktree navigation needs a connected UI window, and none exists until the caller's browser loads the url
    for (const id of open) await client.callAny('ui.tool.open', { id })

    const info: FixtureInfo = {
      url: `http://127.0.0.1:${runtime.port}/#token=${encodeURIComponent(runtime.token)}`,
      port: runtime.port,
      home: scope.home,
      pid: process.pid,
      repos: {
        primary: fixtures.primaryWorktree.path,
        worktrees: Object.fromEntries(fixtures.worktrees.filter((worktree) => !worktree.isMain).map((worktree) => [worktree.name, worktree.path])),
        projects: Object.fromEntries(fixtures.projects.map((project) => [project.name, project.path]))
      }
    }
    writeFileSync(fixtureJson, JSON.stringify(info, null, 2))
    console.error('READY', fixtureJson)
    emit({ ready: fixtureJson })
  } catch (error) {
    emitError(error instanceof Error ? error.message : String(error))
    console.error(error)
    await stop(1)
  }
  await new Promise(() => {})
}

async function waitForRuntime(home: string) {
  for (let attempt = 0; attempt < DAEMON_START_ATTEMPTS; attempt++) {
    const runtime = readRuntime(home)
    if (runtime && (await isDaemonAlive(runtime, 500))) return runtime
    await Bun.sleep(100)
  }
  throw new Error('the fixture daemon did not start')
}

function seed(command: Extract<FixtureCommand, { kind: 'seed' }>): number {
  const info = readInfo(command.out)
  if (!info) {
    emitError(`no fixture.json in ${command.out}`)
    return 2
  }
  const env = { ...seedEnvironment(info, repoRoot), REDESIGN_FIXTURE_JSON: join(command.out, 'fixture.json') }
  const result = spawnSync('bash', [command.script], {
    cwd: info.repos.primary,
    env,
    stdio: ['ignore', process.stderr.fd, process.stderr.fd]
  })
  const exitCode = result.status ?? 1
  emit({ seeded: exitCode === 0, exitCode })
  return exitCode === 0 ? 0 : 1
}

async function stopFixture(command: Extract<FixtureCommand, { kind: 'stop' }>): Promise<number> {
  const info = readInfo(command.out)
  if (!info || !isRunning(info.pid)) {
    emit({ stopped: false })
    return 0
  }
  if (!ownsFixture(info.pid, command.out)) {
    rmSync(join(command.out, 'fixture.json'), { force: true })
    emit({ stopped: false, stale: true })
    return 0
  }
  process.kill(info.pid, 'SIGTERM')
  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline && (isRunning(info.pid) || existsSync(info.home))) await Bun.sleep(100)
  if (existsSync(info.home)) {
    console.error(`${info.home} still exists ${STOP_TIMEOUT_MS} ms after SIGTERM`)
    emit({ stopped: false })
    return 1
  }
  emit({ stopped: true })
  return 0
}

async function main(argv: string[]): Promise<number | undefined> {
  let command: FixtureCommand
  try {
    command = parseFixtureArgs(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    emitError(error.message)
    return 2
  }
  if (command.kind === 'start') return start(command).then(() => undefined)
  return command.kind === 'seed' ? seed(command) : stopFixture(command)
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2))
  if (code !== undefined) process.exit(code)
}
