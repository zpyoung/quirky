import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyClient } from '../src/client'
import { startPtyServer, type PtyServer, type PtyServerOptions } from '../src/server'

const cleanups: Array<() => Promise<void> | void> = []

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn)
}

export async function runCleanups(): Promise<void> {
  while (cleanups.length > 0) await cleanups.pop()!()
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
  const server = startPtyServer({ ...options, home })
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
