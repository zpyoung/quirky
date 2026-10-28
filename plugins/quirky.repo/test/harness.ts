import { mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { QuirkyClient, type CliContext, type ClientRole } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import { formatRecord, formatTable } from '../../../packages/cli/src/output'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { fakeAsks } from './fakes/quirky.ask/main'
import { fakeSessionState, type FakeSessionState } from './fakes/quirky.session/main'

const PLUGINS_ROOT = resolve(import.meta.dir, '..', '..')
const FAKES_DIR = join(import.meta.dir, 'fakes')

export type PluginHarness = {
  h: Harness
  client: QuirkyClient
  /** The in-memory git installed as the `@quirky/git` seam, or null when real git is in use. */
  git: FakeGit | null
  sessions: FakeSessionState
  builtinPluginsDir: string
  /** Stops this daemon and its PTY host, then starts another on the same home and plugins. */
  restart(): Promise<{ h: Harness; client: QuirkyClient }>
  /** A client whose hello carries the given identity, as the CLI's does inside a session. */
  connectAs(identity: { cwd?: string; worktreeId?: string; sessionId?: string }, role?: ClientRole): Promise<QuirkyClient>
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
}

/**
 * A daemon whose built-in directory holds links to the real plugins named in `options.plugins` plus
 * a fake `quirky.session`, with the `@quirky/git` seam and the fake session state reset.
 */
export async function startPluginHarness(options: PluginHarnessOptions = {}): Promise<PluginHarness> {
  const builtinPluginsDir = makeTempDir('qp-')
  mkdirSync(builtinPluginsDir, { recursive: true })
  for (const id of options.plugins ?? ['quirky.repo', 'quirky.worktree']) {
    symlinkSync(join(PLUGINS_ROOT, id), join(builtinPluginsDir, id))
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
      await h.cleanup()
      removeTempDirs()
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
