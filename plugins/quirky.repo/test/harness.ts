import { randomUUID } from 'node:crypto'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QuirkyClient, type CliContext, type ClientRole } from '@quirky/protocol'
import { pathToFileURL } from 'node:url'
import { rpcUrl } from '@quirky/protocol/node'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { fakeAsks } from './fakes/quirky.ask/main'
import { fakeSessionState, type FakeSessionState } from './fakes/quirky.session/main'

const PLUGINS_ROOT = resolve(import.meta.dir, '..', '..')
const FAKES_DIR = join(import.meta.dir, 'fakes')

type RepoGroupCreateBarrierState = {
  armed: boolean
  claimed: boolean
  markEntered(): void
  released: Promise<void>
}

export type RepoGroupCreateBarrier = {
  id: string
  entered: Promise<void>
  arm(): void
  release(): void
  dispose(): void
}

const repoGroupCreateBarriers = new Map<string, RepoGroupCreateBarrierState>()

export function createRepoGroupCreateBarrier(): RepoGroupCreateBarrier {
  const id = randomUUID()
  const { promise: entered, resolve: markEntered } = Promise.withResolvers<void>()
  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  const state: RepoGroupCreateBarrierState = { armed: false, claimed: false, markEntered, released }
  repoGroupCreateBarriers.set(id, state)

  return {
    id,
    entered,
    arm: () => { state.armed = true },
    release,
    dispose: () => {
      release()
      repoGroupCreateBarriers.delete(id)
    }
  }
}

export async function awaitRepoGroupCreateBarrier(id: string): Promise<void> {
  const barrier = repoGroupCreateBarriers.get(id)
  if (!barrier) throw new Error('repo group-create test barrier is no longer active')
  if (!barrier.armed || barrier.claimed) return
  barrier.claimed = true
  barrier.markEntered()
  await barrier.released
}

function installRepoGroupCreateBarrierPlugin(builtinPluginsDir: string, barrierId: string): void {
  const pluginDir = join(builtinPluginsDir, 'quirky.repo')
  mkdirSync(pluginDir, { recursive: true })
  symlinkSync(join(PLUGINS_ROOT, 'quirky.repo', 'quirky-plugin.json'), join(pluginDir, 'quirky-plugin.json'))
  symlinkSync(join(PLUGINS_ROOT, 'quirky.repo', 'cli.ts'), join(pluginDir, 'cli.ts'))

  const realMain = pathToFileURL(join(PLUGINS_ROOT, 'quirky.repo', 'main.ts')).href
  const harnessModule = JSON.stringify(import.meta.url)
  writeFileSync(join(pluginDir, 'main.ts'), [
    `import { activate as activateRepo } from ${JSON.stringify(realMain)}`,
    `import { awaitRepoGroupCreateBarrier } from ${harnessModule}`,
    'export function activate(context) {',
    '  activateRepo(new Proxy(context, {',
    '    get(target, property) {',
    `      if (property !== 'provide') return Reflect.get(target, property, target)`,
    '      return (contributionId, implementation) => {',
    `        if (contributionId !== 'method:quirky.repo/groupCreate') return target.provide(contributionId, implementation)`,
    '        return target.provide(contributionId, async (...args) => {',
    '          const group = await implementation(...args)',
    `          await awaitRepoGroupCreateBarrier(${JSON.stringify(barrierId)})`,
    '          return group',
    '        })',
    '      }',
    '    }',
    '  }))',
    '}'
  ].join('\n'))
}

export type PluginHarness = {
  h: Harness
  client: QuirkyClient
  /** The in-memory git installed as the `@quirky/git` seam, or null when real git is in use. */
  git: FakeGit | null
  sessions: FakeSessionState
  builtinPluginsDir: string
  /** Stops this daemon and its PTY host, then starts another on the same home and plugins. */
  restart(): Promise<{ h: Harness; client: QuirkyClient }>
  /** A client whose initial authenticated hello carries the given connection identity. */
  connectAs(identity: { cwd?: string; worktreeId?: string; sessionId?: string; desktopClientId?: string }, role?: ClientRole): Promise<QuirkyClient>
  cleanup(): Promise<void>
}

export type PluginHarnessOptions = {
  /** Built-in plugin IDs to link from `plugins/`; defaults to the repo and worktree plugins. */
  plugins?: string[]
  /** Fake `@quirky/git` (default) or real git. */
  realGit?: boolean
  /** Link the fake `quirky.session` (default true). */
  fakeSession?: boolean
  /** Link the fake `quirky.ask` that destructive-call confirmations open asks on (default false). */
  fakeAsk?: boolean
  home?: string
  /** Installs a test-only wrapper around the real repo groupCreate provider. */
  repoGroupCreateBarrier?: RepoGroupCreateBarrier
}

/**
 * A daemon whose built-in directory holds links to the real plugins named in `options.plugins` plus
 * a fake `quirky.session`, with the `@quirky/git` seam and the fake session state reset.
 */
export async function startPluginHarness(options: PluginHarnessOptions = {}): Promise<PluginHarness> {
  const builtinPluginsDir = makeTempDir('qp-')
  mkdirSync(builtinPluginsDir, { recursive: true })
  for (const id of options.plugins ?? ['quirky.repo', 'quirky.worktree']) {
    if (id === 'quirky.repo' && options.repoGroupCreateBarrier) {
      installRepoGroupCreateBarrierPlugin(builtinPluginsDir, options.repoGroupCreateBarrier.id)
    } else {
      symlinkSync(join(PLUGINS_ROOT, id), join(builtinPluginsDir, id))
    }
  }
  if (options.fakeAsk) symlinkSync(join(FAKES_DIR, 'quirky.ask'), join(builtinPluginsDir, 'quirky.ask'))
  fakeAsks().clear()
  if (options.fakeSession !== false) symlinkSync(join(FAKES_DIR, 'quirky.session'), join(builtinPluginsDir, 'quirky.session'))

  const git = options.realGit ? null : createFakeGit()
  useTestGit(git)
  const sessions = fakeSessionState()
  sessions.sessions = []
  sessions.closed = []
  sessions.closeError = null

  let h = await startHarness({ builtinPluginsDir, ...(options.home ? { home: options.home } : {}) })
  const client = await h.connect('cli')
  const harness: PluginHarness = {
    h,
    client,
    git,
    sessions,
    builtinPluginsDir,
    async restart() {
      const { home } = h
      for (const open of h.clients) open.close()
      await h.daemon.stop()
      h.pty.stop()
      h = await startHarness({ builtinPluginsDir, home })
      harness.h = h
      harness.client = await h.connect('cli')
      return { h, client: harness.client }
    },
    async connectAs(identity, role = 'cli') {
      const connected = await QuirkyClient.connect(rpcUrl(h.runtime), { role, ...identity })
      h.clients.push(connected)
      return connected
    },
    async cleanup() {
      useTestGit(null)
      options.repoGroupCreateBarrier?.release()
      try {
        await h.cleanup()
      } finally {
        options.repoGroupCreateBarrier?.dispose()
        removeTempDirs()
      }
    }
  }
  return harness
}

/** A `CliContext` over a connected client that records the lines the command prints. */
export function testCliContext(
  client: QuirkyClient,
  options: {
    cwd?: string
    json?: boolean
    env?: Record<string, string | undefined>
    /** Methods the link would send with `yes: true`, as `--yes` does for destructive ones. */
    yes?: string[]
  } = {}
): { ctx: CliContext; lines: string[] } {
  const lines: string[] = []
  const json = options.json ?? false
  const ctx: CliContext = {
    requestBase: crypto.randomUUID(),
    call: (method, params = {}) => client.callAny(method, options.yes?.includes(method) ? { ...params, yes: true } : params),
    out: {
      json,
      result: (value, text) => lines.push(json ? JSON.stringify(value) : text()),
      line: (text) => lines.push(text),
      jsonLine: (value) => lines.push(JSON.stringify(value))
    },
    format: { table: formatTable, record: (pairs) => formatRecord(pairs) },
    env: options.env ?? {},
    cwd: options.cwd ?? '/',
    readFile: async () => '',
    sleep: (ms) => Bun.sleep(ms),
    now: () => Date.now(),
    usage: (message) => new Error(`usage: ${message}`),
    fail: (message) => new Error(message),
    reconnect: async () => {}
  }
  return { ctx, lines }
}
