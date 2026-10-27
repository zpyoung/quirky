import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { createProcessScope, type ProcessScope } from '../../../../scripts/test-support/process-scope'
import { isDaemonAlive, readRuntime, rpcUrl } from '@quirky/protocol/node'

const REPO_ROOT = resolve(import.meta.dir, '../../../..')
const DAEMON_MAIN = join(REPO_ROOT, 'packages/daemon/src/main.ts')
const CLI_MAIN = join(REPO_ROOT, 'packages/cli/src/main.ts')
const FAKE_AGENT = join(import.meta.dir, 'fake-agent.ts')

/** What a fake agent CLI does once started; see `fake-agent.ts` for the timing rules. */
export type FakeBehavior = {
  raw?: boolean
  steps?: { afterMs: number; write: string }[]
  exitAfterMs?: number
  exitCode?: number
  /** Answers a bare `--version` with `stdout` (default `0.0.0 (fake)`) and exits with `exitCode` (default 0) at once. */
  version?: { stdout?: string; exitCode?: number }
}

export type FakeEvent =
  | { type: 'start'; argv: string[]; env: Record<string, string>; cwd: string; pid: number; at: number }
  | { type: 'version'; argv: string[]; at: number }
  | { type: 'input'; b64: string; at: number }
  | { type: 'exit'; at: number }

export type StartOptions = {
  /** Fake agents to install, by the command name they answer to; `true` means default behavior. */
  fakes?: Record<string, FakeBehavior | true>
  /** Value of `QUIRKY_AGENT_SEARCH_DIRS`; empty by default so no real agent CLI is found. */
  searchDirs?: string
  /** Value of `QUIRKY_TEST_AGENT_TIME_SCALE`. */
  timeScale?: number
  extraEnv?: Record<string, string>
}

export type CliResult = { code: number; stdout: string; stderr: string }

export type E2E = {
  processScope: ProcessScope
  /** `QUIRKY_HOME` of the daemon under test. */
  home: string
  /** The `HOME` of the daemon and everything it launches. */
  userHome: string
  fakebin: string
  /** A real git repository already added to Quirky. */
  repo: string
  client: QuirkyClient
  cli(args: string[]): Promise<CliResult>
  addFake(name: string, behavior?: FakeBehavior | true): void
  removeFake(name: string): void
  fakeLog(name: string): FakeEvent[]
  /** Resolves with the log once `predicate` holds for it; rejects after `timeoutMs`. */
  waitForFakeLog(name: string, predicate: (events: FakeEvent[]) => boolean, timeoutMs: number): Promise<FakeEvent[]>
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** Pid of the PTY host the daemon started, or 0 if it never reported one. */
  ptyHostPid(): number
  /** Stops the daemon, the PTY host and every fake still running, then removes the temp dirs. Safe to call twice. */
  cleanup(): Promise<void>
}


async function waitUntil<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}


function gitInit(repo: string): void {
  mkdirSync(repo, { recursive: true })
  const env = { PATH: '/usr/bin:/bin', HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-c', 'user.name=qa', '-c', 'user.email=qa@example.test', '-c', 'commit.gpgsign=false', ...args], {
      cwd: repo,
      env,
      stdout: 'pipe',
      stderr: 'pipe'
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), 'fixture\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
}

/**
 * Starts a real `quirkyd` (and so a real PTY host) in short temp dirs under `/tmp`, with fake agent
 * CLIs first on `PATH` and a fake login shell that keeps the system `/etc/profile` from putting
 * real agent CLIs ahead of them. Nothing from the real home directory is read or written.
 */
export async function startAgentsE2E(options: StartOptions = {}): Promise<E2E> {
  const root = realpathSync(mkdtempSync('/tmp/qa-'))
  const home = join(root, 'q')
  let scope: ProcessScope
  try {
    mkdirSync(home, { recursive: true })
    scope = createProcessScope(home)
  } catch (error) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'agents E2E scope startup and cleanup failed')
    }
    throw error
  }
  const userHome = join(root, 'home')
  const fakebin = join(root, 'fakebin')
  const shells = join(root, 'shells')
  const repo = join(root, 'repo')
  let client: QuirkyClient | undefined
  let hostPid = 0
  let cleaning: Promise<void> | undefined

  const cleanup = (): Promise<void> => {
    cleaning ??= (async () => {
      const errors: unknown[] = []
      const step = async (run: () => void | Promise<void>) => {
        try {
          await run()
        } catch (error) {
          errors.push(error)
        }
      }
      await step(() => {
        try {
          client?.close()
        } finally {
          client = undefined
        }
      })
      await step(() => scope.cleanup())
      await step(() => rmSync(root, { recursive: true, force: true }))
      if (errors.length > 0) throw errors[0]
    })()
    return cleaning
  }

  try {
    for (const dir of [userHome, fakebin, shells]) mkdirSync(dir, { recursive: true })

    const fakeShell = join(shells, 'sh')
    writeFileSync(fakeShell, '#!/bin/sh\n[ "$1" = "-l" ] && shift\nexec /bin/sh "$@"\n')
    chmodSync(fakeShell, 0o755)

    const logPath = (name: string) => join(fakebin, `${name}.log.jsonl`)
    const addFake = (name: string, behavior: FakeBehavior | true = true) => {
      const path = join(fakebin, name)
      writeFileSync(path, `#!${process.execPath}\nimport ${JSON.stringify(FAKE_AGENT)}\n`)
      chmodSync(path, 0o755)
      rmSync(logPath(name), { force: true })
      if (behavior === true) rmSync(`${path}.json`, { force: true })
      else writeFileSync(`${path}.json`, JSON.stringify(behavior))
    }
    const removeFake = (name: string) => {
      unlinkSync(join(fakebin, name))
      rmSync(join(fakebin, `${name}.json`), { force: true })
    }
    const fakeLog = (name: string): FakeEvent[] => {
      const path = logPath(name)
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeEvent)
    }
    for (const [name, behavior] of Object.entries(options.fakes ?? {})) addFake(name, behavior)

    const env: Record<string, string> = {
      QUIRKY_HOME: home,
      HOME: userHome,
      SHELL: fakeShell,
      PATH: `${fakebin}:/usr/bin:/bin`,
      QUIRKY_AGENT_SEARCH_DIRS: options.searchDirs ?? '',
      QUIRKY_PORT: '0',
      QUIRKY_TEST_AGENT_TIME_SCALE: String(options.timeScale ?? 1),
      ...options.extraEnv
    }

    const daemonLog = join(root, 'daemon.log')
    const daemon = scope.spawn([process.execPath, DAEMON_MAIN], {
      env: { ...env, ...scope.env },
      stdout: Bun.file(daemonLog),
      stderr: Bun.file(daemonLog)
    })
    const runtime = await waitUntil(async () => {
      if (daemon.exitCode !== null) throw new Error(`quirkyd exited ${daemon.exitCode}: ${readFileSync(daemonLog, 'utf8')}`)
      const info = readRuntime(home)
      return info && (await isDaemonAlive(info)) ? info : undefined
    }, 20_000, 'quirkyd to start')
    client = await QuirkyClient.connect(rpcUrl(runtime), { role: 'cli', name: 'agents-e2e' })
    hostPid = ((await client.call('status.get', {})) as { ptyHost: { pid: number } }).ptyHost.pid

    gitInit(repo)
    const harness: E2E = {
      processScope: scope,
      home,
      userHome,
      fakebin,
      repo,
      client,
      async cli(args) {
        const proc = scope.spawn([process.execPath, CLI_MAIN, ...args], {
          cwd: repo,
          env: { PATH: env.PATH!, HOME: userHome, QUIRKY_HOME: home, ...scope.env },
          stdout: 'pipe',
          stderr: 'pipe'
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout as ReadableStream).text(),
          new Response(proc.stderr as ReadableStream).text(),
          proc.exited
        ])
        return { code, stdout, stderr }
      },
      addFake,
      removeFake,
      fakeLog,
      async waitForFakeLog(name, predicate, timeoutMs) {
        return waitUntil(() => {
          const events = fakeLog(name)
          return predicate(events) ? events : undefined
        }, timeoutMs, `fake ${name} log`)
      },
      call: (method, params = {}) => client!.callAny(method, params),
      ptyHostPid: () => hostPid,
      cleanup
    }
    const added = await harness.cli(['repo', 'add', repo])
    if (added.code !== 0) throw new Error(`quirky repo add failed: ${added.stderr || added.stdout}`)
    return harness
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'agents E2E startup and cleanup failed')
    }
    throw error
  }
}
