import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { PtyClient } from '../src/client'
import { type CreateParams, SessionManager } from '../src/session'
import { startPtyServer, type PtyServer, type PtyServerOptions } from '../src/server'

const ENTRY = new URL('../src/main.ts', import.meta.url).pathname

const cleanups: Array<() => Promise<void> | void> = []
const scopes = new Map<string, ProcessScope>()

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

