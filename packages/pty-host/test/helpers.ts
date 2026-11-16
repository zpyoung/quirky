import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { PtyClient } from '../src/client'
import { type CreateParams, SessionManager } from '../src/session'
import { startPtyServer, type PtyServer, type PtyServerOptions } from '../src/server'
import { createProcessRunner } from '@quirky/process'
import type { ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'

const ENTRY = new URL('../src/main.ts', import.meta.url).pathname

const cleanups: Array<() => Promise<void> | void> = []
const scopes = new Map<string, ProcessScope>()

let nextRunnerId = 0

export type HeldRunnerOptions = {
  hold?: boolean
  result?: RunResult
  error?: unknown
  never?: boolean
}

export type HeldRunner = {
  runner: Pick<ProcessRunner, 'run'>
  calls: Array<{ argv: readonly string[]; options?: RunOptions }>
  readonly inFlight: number
  readonly highestInFlight: number
  release(): void
}

/** Holds process-table calls until release, then returns the selected outcome or runs them for real. */
export function heldRunner(options: HeldRunnerOptions = {}): HeldRunner {
  const real = createProcessRunner({ owner: `pty-host-test-${nextRunnerId++}` })
  onCleanup(() => real.dispose())
  const calls: HeldRunner['calls'] = []
  const waiting: Array<() => void> = []
  const never = Promise.withResolvers<RunResult>().promise
  let released = !options.hold
  let inFlight = 0
  let highestInFlight = 0

  const outcome = (argv: readonly string[], runOptions?: RunOptions): Promise<RunResult> => {
    if (options.never) return never
    if (options.error !== undefined) return Promise.reject(options.error)
    if (options.result !== undefined) return Promise.resolve(options.result)
    return real.run(argv, runOptions)
  }

  const run: ProcessRunner['run'] = (argv, runOptions) => {
    calls.push({ argv: [...argv], options: runOptions })
    inFlight++
    highestInFlight = Math.max(highestInFlight, inFlight)
    const { promise, resolve, reject } = Promise.withResolvers<RunResult>()
    const start = () => {
      void Promise.resolve().then(() => outcome(argv, runOptions)).then(
        (value) => { inFlight--; resolve(value) },
        (error) => { inFlight--; reject(error) }
      )
    }
    if (released) start()
    else waiting.push(start)
    return promise
  }

  return {
    runner: { run },
    calls,
    get inFlight() { return inFlight },
    get highestInFlight() { return highestInFlight },
    release() {
      released = true
      for (const start of waiting.splice(0)) start()
    }
  }
}

export type ProcessKillTarget = { pid: number; signal?: NodeJS.Signals | number }

export function recordProcessKillTargets(): {
  targets: ProcessKillTarget[]
  clear(): void
  restore(): void
} {
  const targets: ProcessKillTarget[] = []
  const original = process.kill
  let recording = true
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (recording) targets.push({ pid, signal })
    return original.call(process, pid, signal)
  }) as typeof process.kill
  const restore = () => {
    if (!recording) return
    recording = false
    process.kill = original
  }
  onCleanup(restore)
  return {
    targets,
    clear() {
      targets.length = 0
    },
    restore
  }
}

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn)
}

export async function runCleanups(): Promise<void> {
  let failed = false
  let firstError: unknown
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()!()
    } catch (error) {
      if (!failed) firstError = error
      failed = true
    }
  }
  if (failed) throw firstError
}

export function scopeForHome(home: string): ProcessScope {
  let scope = scopes.get(home)
  if (!scope) {
    scope = createProcessScope(home)
    scopes.set(home, scope)
    onCleanup(async () => {
      scopes.delete(home)
      await scope!.cleanup()
    })
  }
  return scope
}

export function trackSessionProcesses(manager: SessionManager, scope: ProcessScope): void {
  const create = manager.create.bind(manager)
  manager.create = async (params: CreateParams) => {
    const result = await create({ ...params, env: { ...params.env, ...scope.env } })
    scope.track(result.pid)
    return result
  }
}
export async function createScopedSession(client: PtyClient, home: string, params: CreateParams) {
  const scope = scopeForHome(home)
  const result = await client.request('create', { ...params, env: { ...params.env, ...scope.env } })
  scope.track(result.pid)
  return result
}

/** Unix socket paths are capped near 104 bytes on macOS, so the home must be short. */
export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'qpty-'))
  onCleanup(() => rmSync(home, { recursive: true, force: true }))
  return home
}

export type TestHost = { home: string; server: PtyServer; connect: () => Promise<PtyClient> }

export function startHost(options: Partial<PtyServerOptions> = {}): TestHost {
  const home = options.home ?? tempHome()
  const scope = scopeForHome(home)
  const server = startPtyServer({ ...options, home })
  trackSessionProcesses(server.manager, scope)
  onCleanup(() => server.stop())
  const connect = async () => {
    const client = await PtyClient.connect(server.socketPath)
    onCleanup(() => client.close())
    await client.hello(server.token)
    return client
  }
  return { home, server, connect }
}

export async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5000,
  what = 'condition'
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const part of parts) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}

export const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** Runs the real host entry on `home`; its scope owns the host and its process tree. */
export function startProcess(home: string) {
  const scope = scopeForHome(home)
  return scope.spawn([process.execPath, ENTRY], {
    env: { ...process.env, QUIRKY_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe'
  })
}

/** Waits for the host on `home` to listen, then returns an authenticated client and the token. */
export async function ready(home: string): Promise<{ client: PtyClient; token: string }> {
  const token = await waitFor(
    () => (existsSync(join(home, 'pty.sock')) && existsSync(join(home, 'pty.token')) ? readFileSync(join(home, 'pty.token'), 'utf8') : ''),
    10000,
    'host to listen'
  )
  for (let attempt = 0; ; attempt++) {
    try {
      const c = await PtyClient.connect(join(home, 'pty.sock'))
      onCleanup(() => c.close())
      await c.hello(token)
      return { client: c, token }
    } catch (error) {
      if (attempt > 100) throw error
      await Bun.sleep(50)
    }
  }
}

