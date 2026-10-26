import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QuirkyClient, type ClientRole, type QuirkyEvent } from '@quirky/protocol'
import { rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle, type DaemonOptions } from '../src/daemon'
import { startFakePtyHost, type FakePtyHost } from './fixtures/fake-pty-host'

export type Harness = {
  home: string
  daemon: DaemonHandle
  runtime: RuntimeInfo
  pty: FakePtyHost
  notifications: { title: string; body: string }[]
  clients: QuirkyClient[]
  connect(role?: ClientRole, name?: string): Promise<QuirkyClient>
  /** A client that records every event it receives. */
  connectWithEvents(role?: ClientRole): Promise<{ client: QuirkyClient; events: QuirkyEvent[] }>
  cleanup(): Promise<void>
}

/** The repo's `plugins/` directory, for tests that want the real built-in plugins. */
export function builtinsDir(): string {
  return resolve(import.meta.dir, '../../../plugins')
}

export function makeTempHome(prefix = 'qd-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function startHarness(options: Partial<DaemonOptions> = {}): Promise<Harness> {
  const home = options.home ?? makeTempHome()
  const pty = startFakePtyHost(home)
  const notifications: { title: string; body: string }[] = []
  const daemon = await startDaemon({
    home,
    port: 0,
    shell: '/bin/zsh',
    notifier: (title, body) => notifications.push({ title, body }),
    cliEntry: '/opt/quirky/cli/main.ts',
    uiDir: join(home, 'no-ui'),
    builtinPluginsDir: null,
    ...options
  })
  const clients: QuirkyClient[] = []
  const harness: Harness = {
    home,
    daemon,
    runtime: daemon.runtime,
    pty,
    notifications,
    clients,
    async connect(role = 'cli', name) {
      const client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role, name })
      clients.push(client)
      return client
    },
    async connectWithEvents(role = 'ui') {
      const events: QuirkyEvent[] = []
      const client = await harness.connect(role)
      client.onEvent((event) => events.push(event))
      await client.call('events.subscribe', {})
      return { client, events }
    },
    async cleanup() {
      for (const client of clients) client.close()
      await daemon.stop()
      pty.stop()
      rmSync(home, { recursive: true, force: true })
    }
  }
  return harness
}

export async function waitFor<T>(
  check: () => T | undefined | null | false,
  timeoutMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(10)
  }
}

export async function waitForAsync<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 2000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('waitForAsync timed out')
    await Bun.sleep(10)
  }
}

export function writeUiFixture(dir: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>quirky</title><div id="root"></div>')
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")')
  writeFileSync(join(dir, 'assets', 'app.css'), 'body{margin:0}')
}
