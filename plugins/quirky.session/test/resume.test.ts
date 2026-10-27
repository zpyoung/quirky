import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { QuirkyClient, RpcErrorCode, type QuirkyEvent, type RpcError, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { makeTempHome, waitFor } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import {
  call,
  createSession,
  makeBuiltinDir,
  restartDaemon,
  SESSION_PLUGINS,
  startPluginHarness,
  writeV1Sessions,
  type V1Session
} from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let folder: string

beforeEach(async () => {
  resetFakeAgents()
  folder = makeTempDir('qs-')
  process.env.QUIRKY_TEST_REAL_WORKTREE = folder
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_REAL_WORKTREE
  await h.cleanup()
  removeTempDirs()
})

const start = (agent: string, extra: Record<string, unknown> = {}) =>
  createSession(client, { worktree: 'id:wt_real', agent, ...extra })
const resume = (params: Record<string, unknown>) => call<Session>(client, 'quirky.session/resume', params)
const setProviderSession = (params: Record<string, unknown>) => call<Session>(client, 'quirky.session/setProviderSession', params)
const spawnedArgv = (sessionId: string) => {
  const request = h.pty.requests.find((r) => r.type === 'create' && r.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request.argv[3]!
}
const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected a failure')
}
/** Runs `work` against a daemon that imported `sessions` from a v1 home, which have no launch record. */
async function withV1Sessions(sessions: V1Session[], work: (client: QuirkyClient) => Promise<void>): Promise<void> {
  await h.cleanup()
  const home = makeTempHome()
  h = await startPluginHarness({ real: [], fakes: ['quirky.worktree'] }, { home })
  await h.daemon.stop()
  writeV1Sessions(home, sessions)
  const again = await restartDaemon(h, { builtinPluginsDir: makeBuiltinDir(home, SESSION_PLUGINS, 'builtin-all') })
  try {
    await work(again.client)
  } finally {
    await again.stop()
  }
}

const creates = () => h.pty.requests.filter((r) => r.type === 'create').length

describe('SC-30: the provider session is stored only if it is valid', () => {
  test('SC-30: a normal ID and a 512-character ID are stored, with an optional transcript', async () => {
    const session = await start('codex')
    const stored = await setProviderSession({ session: session.id, id: '0199a-thread' })
    expect(stored).toMatchObject({ id: session.id, providerSession: { id: '0199a-thread', transcriptPath: null } })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toEqual(stored)

    const long = 'a'.repeat(512)
    expect((await setProviderSession({ session: session.id, id: long, transcriptPath: '/t/rollout.jsonl' })).providerSession).toEqual({
      id: long,
      transcriptPath: '/t/rollout.jsonl'
    })
    await waitFor(() => events.find((e) => e.type === 'quirky.session/changed' && (e.data as { session: Session }).session.providerSession?.id === long))
  })

  test('SC-30: an empty, too long, dash-leading or control-character ID is refused with the rule it breaks', async () => {
    const session = await start('codex')
    await setProviderSession({ session: session.id, id: 'keep' })
    const refused: [string, string][] = [
      ['', "provider session id can't be empty"],
      ['a'.repeat(513), "provider session id can't be longer than 512 characters"],
      ['-x', "provider session id can't start with '-'"],
      ['a\nb', "provider session id can't contain control characters"],
      ['a\u0085b', "provider session id can't contain control characters"],
      ['a\u007fb', "provider session id can't contain control characters"]
    ]
    for (const [id, message] of refused) {
      const error = await failure(setProviderSession({ session: session.id, id }))
      expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message })
    }
    expect((await call<Session>(client, 'quirky.session/get', { session: session.id })).providerSession?.id).toBe('keep')
  })

  test('an unknown session is NotFound', async () => {
    expect(await failure(setProviderSession({ session: 's_nope', id: 'x' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  })
})

describe('SC-31: resume replays the launch record, in the original folder', () => {
  test('SC-31: the command comes from the recorded launch, not today\'s defaults, and the new session records it', async () => {
    fakeAgents().args = '--model haiku'
    const first = await start('claude')
    await setProviderSession({ session: first.id, id: 'abc' })
    fakeAgents().args = '--dangerously-skip-permissions'

    const elsewhere = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', cwd: '/fake/other' })
    let resumed: Session
    try {
      resumed = await call<Session>(elsewhere, 'quirky.session/resume', { session: first.id })
    } finally {
      elsewhere.close()
    }

    expect(resumed).toMatchObject({
      agent: 'claude',
      title: 'Claude 2',
      kind: 'terminal',
      status: 'running',
      worktreeId: 'wt_real',
      cwd: folder,
      resumedFrom: first.id,
      launch: { command: 'claude', args: '--model haiku', env: {} },
      providerSession: { id: 'abc', transcriptPath: null },
      promptDelivery: null
    })
    expect(resumed.id).not.toBe(first.id)
    const argv = spawnedArgv(resumed.id)
    expect(argv).toContain(`claude --model haiku '--settings' '${h.home}/hooks/claude-settings.json' --resume abc`)
    expect(argv).not.toContain('--dangerously-skip-permissions')
    const request = h.pty.requests.find((r) => r.type === 'create' && r.sessionId === resumed.id)
    expect(request).toMatchObject({ cwd: folder })

    const call1 = fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params
    expect(call1).toMatchObject({
      agent: 'claude',
      cwd: folder,
      record: { command: 'claude', args: '--model haiku', env: {} },
      providerSession: { id: 'abc', transcriptPath: null },
      fork: false,
      hookArgs: ['--settings', `${h.home}/hooks/claude-settings.json`]
    })
    expect(await call(client, 'quirky.session/get', { session: first.id })).toMatchObject({
      launch: { command: 'claude', args: '--model haiku', env: {} },
      resumedFrom: null
    })

    const again = await resume({ session: resumed.id })
    expect(again).toMatchObject({ resumedFrom: resumed.id, launch: { command: 'claude', args: '--model haiku', env: {} } })
    expect(spawnedArgv(again.id)).toContain('claude --model haiku')
    expect(spawnedArgv(again.id)).not.toContain('--dangerously-skip-permissions')
  })

  test('SC-31: a session with no launch record resumes with the catalog command and records that', async () => {
    await withV1Sessions([{ id: 's_v1', agent: 'claude', title: 'Claude', worktreeId: 'wt_real', cwd: folder }], async (v1) => {
      const old = await call<Session>(v1, 'quirky.session/get', { session: 's_v1' })
      expect(old).toMatchObject({ launch: null, providerSession: null, promptDelivery: null, resumedFrom: null })
      const resumed = await call<Session>(v1, 'quirky.session/resume', { session: 's_v1', providerSession: 'abc' })
      expect(resumed).toMatchObject({
        cwd: folder,
        resumedFrom: 's_v1',
        launch: { command: 'claude', args: '', env: {} },
        providerSession: { id: 'abc', transcriptPath: null }
      })
      expect(fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params.record).toBeNull()
      expect(spawnedArgv(resumed.id)).toContain(`claude '--settings'`)
      expect(spawnedArgv(resumed.id)).toEndWith('--resume abc')
    })
  })

  test('a given provider session and transcript override the stored ones', async () => {
    const first = await start('codex')
    await setProviderSession({ session: first.id, id: 'old', transcriptPath: '/old.jsonl' })
    const resumed = await resume({ session: first.id, providerSession: 'new', transcriptPath: '/new.jsonl' })
    expect(resumed.providerSession).toEqual({ id: 'new', transcriptPath: '/new.jsonl' })
    expect(fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params.providerSession).toEqual({
      id: 'new',
      transcriptPath: '/new.jsonl'
    })
    const keepsTranscript = await resume({ session: first.id, transcriptPath: '/other.jsonl' })
    expect(keepsTranscript.providerSession).toEqual({ id: 'old', transcriptPath: '/other.jsonl' })
    const noTranscript = await resume({ session: first.id, providerSession: 'new' })
    expect(noTranscript.providerSession).toEqual({ id: 'new', transcriptPath: null })
  })

  test('the stored transcript is passed along when only the session ID is stored with one', async () => {
    const first = await start('codex')
    await setProviderSession({ session: first.id, id: 'old', transcriptPath: '/old.jsonl' })
    await resume({ session: first.id })
    expect(fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params.providerSession).toEqual({
      id: 'old',
      transcriptPath: '/old.jsonl'
    })
  })

  test('hook arguments are recomputed for the new session and are not part of the stored launch', async () => {
    const first = await start('claude')
    const resumed = await resume({ session: first.id, providerSession: 'abc' })
    expect(resumed.launch).toEqual({ command: 'claude', args: '', env: {} })
    expect(JSON.stringify(resumed.launch)).not.toContain('settings')
    expect(spawnedArgv(resumed.id)).toContain('--settings')
  })

  test('a resumed session emits changed and shows up in the list', async () => {
    const first = await start('claude')
    const resumed = await resume({ session: first.id, providerSession: 'abc' })
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([first.id, resumed.id])
    await waitFor(() => events.find((e) => e.type === 'quirky.session/changed' && (e.data as { session: Session }).session.id === resumed.id))
  })

  test('a failed spawn leaves no new record', async () => {
    const first = await start('claude')
    h.pty.failRequests('create', 'no such shell')
    const error = await failure(resume({ session: first.id, providerSession: 'abc' }))
    expect(error.message).toContain('could not start claude: no such shell')
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([first.id])
  })
})

describe('SC-34: fork', () => {
  test('SC-34: fork opens a copy that has no provider session yet', async () => {
    const first = await start('claude')
    await setProviderSession({ session: first.id, id: 'S' })
    const forked = await resume({ session: first.id, fork: true })
    expect(spawnedArgv(forked.id)).toContain('--resume S --fork-session')
    expect(forked).toMatchObject({ resumedFrom: first.id, providerSession: null })
    expect(fakeAgents().calls.find((c) => c.method === 'prepareResume')!.params.fork).toBe(true)
  })

  test('SC-34: an agent that can not fork is refused', async () => {
    const first = await start('opencode')
    await setProviderSession({ session: first.id, id: 'S' })
    const before = creates()
    expect(await failure(resume({ session: first.id, fork: true }))).toMatchObject({
      message: "opencode can't fork from Quirky yet"
    })
    expect(creates()).toBe(before)
  })
})

describe('SC-35: resume and fork are refused where they can not work', () => {
  test('SC-35: a plain shell', async () => {
    const shell = await start('shell')
    const before = creates()
    expect((await failure(resume({ session: shell.id, providerSession: 'x' }))).message).toBe(`session ${shell.id} is a shell, not an agent`)
    expect((await failure(resume({ session: shell.id, fork: true }))).message).toBe(`session ${shell.id} is a shell, not an agent`)
    expect(creates()).toBe(before)
  })

  test('SC-35: an agent with no resume', async () => {
    const aider = await start('aider')
    const before = creates()
    expect((await failure(resume({ session: aider.id, providerSession: 'x' }))).message).toBe("aider can't resume sessions")
    expect((await failure(resume({ session: aider.id, fork: true }))).message).toBe("aider can't resume sessions")
    expect(creates()).toBe(before)
  })

  test('SC-35: no provider session anywhere', async () => {
    const codex = await start('codex')
    const before = creates()
    expect((await failure(resume({ session: codex.id }))).message).toBe(
      `session ${codex.id} has no provider session; pass --provider-session`
    )
    expect(creates()).toBe(before)
  })

  test('SC-35: a folder that was deleted', async () => {
    const claude = await start('claude')
    await setProviderSession({ session: claude.id, id: 'abc' })
    rmSync(folder, { recursive: true, force: true })
    const before = creates()
    expect((await failure(resume({ session: claude.id }))).message).toBe(`the session's folder ${folder} no longer exists`)
    expect(creates()).toBe(before)
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([claude.id])
  })

  test('SC-35: a bad provider session ID given to resume is refused with its rule', async () => {
    const claude = await start('claude')
    const before = creates()
    for (const id of ['', '-x', 'a\nb', 'a'.repeat(513)]) {
      expect(await failure(resume({ session: claude.id, providerSession: id }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
    expect(creates()).toBe(before)
  })

  test('a structured session can not be resumed', async () => {
    const structured = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_real',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect((await failure(resume({ session: structured.id, providerSession: 'x' }))).message).toBe(
      `session ${structured.id} is not a terminal session`
    )
  })

  test('an unknown session is NotFound', async () => {
    expect(await failure(resume({ session: 's_nope' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('an agent that quirky.agents no longer knows is refused with its message', async () => {
    await withV1Sessions([{ id: 's_gone', agent: 'vanished', worktreeId: 'wt_real', cwd: folder }], async (v1) => {
      const error = await failure(v1.callAny('quirky.session/resume', { session: 's_gone', providerSession: 'x' }))
      expect(error.message).toBe('unknown agent: vanished')
    })
  })
})
