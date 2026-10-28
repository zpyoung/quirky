import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { QuirkyClient, type ClientRole, type QuirkyEvent } from '@quirky/protocol'
import { rpcUrl, type RuntimeInfo } from '@quirky/protocol/node'
import { startDaemon, type DaemonHandle, type DaemonOptions } from '../src/daemon'
import { Store } from '../src/store'
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

/** Disables unrelated agent-config writes before a fixture daemon activates built-ins. */
export function makeHomeWithoutAutoHooks(prefix = 'qd-'): string {
  const home = makeTempHome(prefix)
  const store = new Store(join(home, 'quirky.db'))
  try {
    store.setSettingValue('setting:quirky.agent-status/hooks', false)
  } finally {
    store.close()
  }
  return home
}

const sharedBuiltinDirs = new Map<string, string>()

/**
 * The same built-ins as `dir`, from one directory per distinct set of links for the whole test
 * process. Under `bun test` every import of a plugin from a new path keeps about four file
 * descriptors open until the process exits, so a fresh built-in directory per daemon start runs the
 * single-process suite out of descriptors. A directory that holds anything but symlinks, or nothing,
 * is returned as is.
 */
export function sharedBuiltinDir(dir: string): string {
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return dir
  }
  if (names.length === 0 || names.some((name) => !lstatSync(join(dir, name)).isSymbolicLink())) return dir
  const links = names.map((name) => [name, resolve(dir, readlinkSync(join(dir, name)))] as const)
  const key = links.map(([name, target]) => `${name}>${target}`).join('\n')
  let shared = sharedBuiltinDirs.get(key)
  if (shared === undefined) {
    const root = mkdtempSync(join(tmpdir(), `qbi-${process.pid}-`))
    if (sharedBuiltinDirs.size === 0) process.once('exit', () => { for (const d of sharedBuiltinDirs.values()) rmSync(join(d, '..'), { recursive: true, force: true }) })
    shared = join(root, 'builtin')
    mkdirSync(shared, { recursive: true })
    for (const [name, target] of links) symlinkSync(target, join(shared, name))
    sharedBuiltinDirs.set(key, shared)
  }
  return shared
}

export async function startHarness(options: Partial<DaemonOptions> = {}): Promise<Harness> {
  const ownsHome = options.home === undefined
  const home = options.home ?? makeTempHome()
  const pty = startFakePtyHost(home)
  const notifications: { title: string; body: string }[] = []
  let daemon: DaemonHandle
  try {
    daemon = await startDaemon({
      home,
      port: 0,
      shell: '/bin/zsh',
      notifier: ({ title, body }) => notifications.push({ title, body }),
      cliEntry: '/opt/quirky/cli/main.ts',
      uiDir: join(home, 'no-ui'),
      builtinPluginsDir: null,
      ...options,
      ...(options.builtinPluginsDir ? { builtinPluginsDir: sharedBuiltinDir(options.builtinPluginsDir) } : {})
    })
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      pty.stop()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (ownsHome) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], 'startHarness failed and rollback was incomplete', { cause: error })
    }
    throw error
  }
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
      let failed = false
      let firstError: unknown
      const attempt = async (action: () => void | Promise<void>) => {
        try {
          await action()
        } catch (error) {
          if (!failed) firstError = error
          failed = true
        }
      }
      for (const client of clients) await attempt(() => client.close())
      await attempt(() => daemon.stop())
      await attempt(() => pty.stop())
      await attempt(() => rmSync(home, { recursive: true, force: true }))
      if (failed) throw firstError
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
  check: () => T | undefined | null | false | Promise<T | undefined | null | false>,
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
