import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  RpcErrorCode,
  type QuirkyClient,
  type RpcError,
  type Session,
  type SessionStatus,
  type StructuredMessage
} from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import type { StructuredContext, StructuredRunner } from '../runner'
import { FakeWorld } from './fakes/world'

const PLUGIN_DIR = join(import.meta.dir, '..')
const FAKES_DIR = join(PLUGIN_DIR, 'test', 'fakes')
const ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const
type Deferred = { promise: Promise<void>; resolve(): void }

class GuardedRunner implements StructuredRunner {
  readonly started: { session: Session; prompt: string | undefined }[] = []
  readonly entered: { sessionId: string; text: string }[] = []
  readonly delivered: { sessionId: string; text: string }[] = []
  private sendGate: Deferred | null = null

  constructor(private readonly context: StructuredContext) {}

  blockNextSend(): Deferred {
    this.sendGate = Promise.withResolvers<void>()
    return this.sendGate
  }

  async start(session: Session, prompt?: string): Promise<void> {
    this.started.push({ session, prompt })
    if (prompt !== undefined && prompt !== '') this.context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
    this.context.setStatus(session.id, prompt === undefined || prompt === '' ? 'running' : 'working')
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.entered.push({ sessionId, text })
    const gate = this.sendGate
    this.sendGate = null
    if (gate) await gate.promise
    this.delivered.push({ sessionId, text })
    this.context.appendMessage({ sessionId, role: 'user', text, data: { scripted: true } })
    this.context.setStatus(sessionId, 'done')
  }

  async stop(sessionId: string): Promise<void> {
    this.context.setStatus(sessionId, 'exited')
  }

  status(sessionId: string, status: SessionStatus): void {
    this.context.setStatus(sessionId, status)
  }
}

let harness: Harness | undefined
let client: QuirkyClient | undefined
let runner: GuardedRunner | undefined
let home: string | undefined
let priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}
const globals = globalThis as typeof globalThis & {
  __structuredFakes?: FakeWorld
  __QUIRKY_TEST_STRUCTURED_RUNNER__?: (context: StructuredContext) => StructuredRunner
}

function builtinDir(): string {
  const dir = makeTempDir('qs-guarded-')
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.structured'))
  for (const id of ['quirky.session', 'quirky.worktree', 'quirky.ask', 'quirky.agents']) {
    symlinkSync(join(FAKES_DIR, id), join(dir, id))
  }
  return dir
}

async function boot(): Promise<void> {
  const world = new FakeWorld()
  globals.__structuredFakes = world
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context) => (runner = new GuardedRunner(context))
  priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof priorEnv
  home = realpathSync(mkdtempSync('/tmp/qs-guarded-home-'))
  const claudeHome = join(home, 'providers', 'claude')
  const codexHome = join(home, 'providers', 'codex')
  mkdirSync(claudeHome, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.CODEX_HOME = codexHome
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  harness = await startHarness({ home, builtinPluginsDir: builtinDir() })
  client = await harness.connect('cli')
}

afterEach(async () => {
  try {
    await harness?.cleanup()
  } finally {
    harness = undefined
    client = undefined
    runner = undefined
    removeTempDirs()
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
    for (const key of ENV_KEYS) {
      const value = priorEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    priorEnv = {}
    delete globals.__structuredFakes
    delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
  }
})

const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) => client!.callAny(method, params) as Promise<T>
const createIdle = async () => call<Session>('quirky.structured/create', { worktree: 'main', agent: 'claude', prompt: '' })

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected structured/send to reject')
}

const send = (session: string, text: string, expectedAfterSeq: number, requireIdle = true) =>
  call('quirky.structured/send', { session, text, requireIdle, expectedAfterSeq })

const journal = (session: string, params: Record<string, unknown> = {}) =>
  call<StructuredMessage[]>('quirky.structured/messages', { session, ...params })

describe('guarded structured sends', () => {
  test('an empty-prompt structured session is idle and accepts its first guarded turn', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    expect(runner!.started[0]).toMatchObject({ session: { id: session.id }, prompt: '' })
    await send(session.id, 'loop iteration', 0)
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['loop iteration'])
    expect((await journal(session.id)).map((message) => [message.seq, message.role, message.text])).toEqual([
      [1, 'user', 'loop iteration']
    ])
  })

  test('working, waiting and exited states veto guarded prompts with agent-busy evidence', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    for (const status of ['working', 'waiting', 'exited'] as const) {
      runner!.status(session.id, status)
      const error = await failure(send(session.id, `must not send while ${status}`, 0))
      expect(error.code).toBe(RpcErrorCode.Conflict)
      expect(error.data).toMatchObject({ reason: 'agent-busy' })
    }
    expect(runner!.delivered).toEqual([])
  })

  test('a stale journal sequence refuses prompt bytes after a prior external send', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    await call('quirky.structured/send', { session: session.id, text: 'external user turn' })

    const error = await failure(send(session.id, 'stale loop iteration', 0))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'stale-evidence' })
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['external user turn'])
    expect((await journal(session.id)).map((message) => message.text)).toEqual(['external user turn'])
  })

  test('external and guarded sends share a per-session queue across the journal check', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    const gate = runner!.blockNextSend()
    const external = call('quirky.structured/send', { session: session.id, text: 'external race' })
    await waitFor(() => runner?.entered.length === 1 ? runner : undefined)
    const guarded = failure(send(session.id, 'must be vetoed after the race', 0))
    gate.resolve()
    await external
    const error = await guarded
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'stale-evidence' })
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['external race'])
  })

  test('messages keep default ordering and can read bounded tails after a sequence cursor', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    for (const text of ['one', 'two', 'three', 'four']) {
      await call('quirky.structured/send', { session: session.id, text })
    }
    expect((await journal(session.id)).map((message) => message.seq)).toEqual([1, 2, 3, 4])
    expect((await journal(session.id, { afterSeq: 1, limit: 1 })).map((message) => message.seq)).toEqual([2])
    expect((await journal(session.id, { limit: 2, tail: true })).map((message) => message.seq)).toEqual([3, 4])
    expect((await journal(session.id, { afterSeq: 1, limit: 2, tail: true })).map((message) => message.seq)).toEqual([3, 4])
  })

  test('guard options reject invalid sequence values before any runner bytes are sent', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    expect((await failure(call('quirky.structured/send', { session: session.id, text: 'x', expectedAfterSeq: -1 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call('quirky.structured/send', { session: session.id, text: 'x', requireIdle: 'yes' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect(runner!.delivered).toEqual([])
  })

  test('a stale loop guard with an operation id writes no prompt bytes', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    await call('quirky.structured/send', { session: session.id, text: 'external user turn' })

    const error = await failure(
      call('quirky.structured/send', {
        session: session.id,
        text: 'stale loop iteration',
        requireIdle: true,
        expectedAfterSeq: 0,
        operationId: 'stale-guard-op'
      })
    )
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'stale-evidence' })
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['external user turn'])
  })

  test('a completed guarded operation replays after its journal sequence advances', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    const params = {
      session: session.id,
      text: 'loop iteration',
      requireIdle: true,
      expectedAfterSeq: 0,
      operationId: 'completed-guard-op'
    }

    expect(await call('quirky.structured/send', params)).toMatchObject({ ok: true })
    expect(await call('quirky.structured/send', params)).toMatchObject({ ok: true })
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['loop iteration'])
  })

  test('reusing an operation id with changed loop guards is refused', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    const params = {
      session: session.id,
      text: 'loop iteration',
      requireIdle: true,
      expectedAfterSeq: 0,
      operationId: 'changed-guard-op'
    }

    await call('quirky.structured/send', params)
    const error = await failure(call('quirky.structured/send', { ...params, expectedAfterSeq: 1 }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['loop iteration'])
  })

  test('an exact incarnation guard does not bypass a stale journal sequence', async () => {
    await boot()
    const session = await createIdle()
    await waitFor(() => runner?.started.length === 1 ? runner : undefined)
    const identity = await call<{ processIncarnation: string }>('quirky.session/identity', { session: session.id })
    await call('quirky.structured/send', { session: session.id, text: 'external user turn' })

    const error = await failure(
      call('quirky.structured/send', {
        session: session.id,
        text: 'stale loop iteration',
        requireIdle: true,
        expectedAfterSeq: 0,
        expectedIncarnation: identity.processIncarnation,
        operationId: 'incarnation-stale-op'
      })
    )
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.data).toMatchObject({ reason: 'stale-evidence' })
    expect(runner!.delivered.map((entry) => entry.text)).toEqual(['external user turn'])
  })

})
