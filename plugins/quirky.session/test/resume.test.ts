import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { QuirkyClient, RpcErrorCode, type LaunchSettings, type QuirkyEvent, type RpcError, type Session, type StructuredMessage } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import type { Harness } from '../../../packages/daemon/test/helpers'
import { makeTempHome, waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import { CLAUDE_SETTINGS } from './fakes/quirky.agent-status/main'
import { createClaudeRunner, type ClaudeQueryParams } from '../../quirky.structured/claude-runner'
import { createCodexRunner } from '../../quirky.structured/codex-runner'
import type { StructuredRunner, StructuredRunnerFactory } from '../../quirky.structured/runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment } from '../../quirky.structured/test/fakes/codex-app-server'
import { FakeQuery } from '../../quirky.structured/test/fakes/fake-query'
import {
  call,
  createSession,
  makeBuiltinDir,
  restartDaemon,
  SESSION_PLUGINS,
  startPluginHarness,
  writeV1Sessions,
  type V1Session,
  type PluginSet
} from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]
let folder: string

const globals = globalThis as typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }
const STRUCTURED_SESSION_PLUGINS: PluginSet = {
  real: ['quirky.session', 'quirky.structured', 'quirky.ask'],
  fakes: ['quirky.worktree', 'quirky.agents', 'quirky.agent-status']
}

function structuredRunnerFactory(
  home: string,
  executable: string,
  claudeQueries: FakeQuery[]
): StructuredRunnerFactory {
  return (context) => {
    const claude = createClaudeRunner(
      { ...context, resolveClaudePath: async () => '/fake/claude' },
      {
        query: (params: ClaudeQueryParams) => {
          const query = new FakeQuery(params)
          claudeQueries.push(query)
          return query
        }
      }
    )
    const codex = createCodexRunner(
      { ...context, resolveCodexPath: async () => executable },
      { env: isolatedProviderEnvironment(home) }
    )
    const runners = new Map<string, StructuredRunner>()
    const runnerFor = (sessionId: string): StructuredRunner => {
      const runner = runners.get(sessionId)
      if (!runner) throw new Error(`no structured runner for ${sessionId}`)
      return runner
    }
    return {
      start(session, prompt, options) {
        const runner = session.agent === 'codex' ? codex : claude
        runners.set(session.id, runner)
        return runner.start(session, prompt, options)
      },
      send(sessionId, text) {
        return runnerFor(sessionId).send(sessionId, text)
      },
      stop(sessionId) {
        return runnerFor(sessionId).stop(sessionId)
      }
    }
  }
}

beforeEach(async () => {
  resetFakeAgents()
  folder = makeTempDir('qs-')
  process.env.QUIRKY_TEST_REAL_WORKTREE = folder
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_REAL_WORKTREE
  delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
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
    expect(argv).toContain(`claude --model haiku '--settings' '${JSON.stringify(CLAUDE_SETTINGS)}' --resume abc`)
    expect(argv.match(/'--settings'/g)).toHaveLength(1)
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
      hookArgs: ['--settings', JSON.stringify(CLAUDE_SETTINGS)]
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

  test('SC-21: resume and fork keep the old session\'s launchSettings, and the old record is untouched', async () => {
    const settings: LaunchSettings = {
      agent: 'codex',
      options: { model: { value: 'gpt-5.5', source: 'explicit' }, effort: { value: 'low', source: 'explicit' } },
      summary: 'Codex · GPT-5.5 · Effort: low'
    }
    const first = await start('codex')
    await setProviderSession({ session: first.id, id: 'abc' })
    const db = new Database(join(h.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      db.query('UPDATE sessions SET launch_settings = ? WHERE id = ?').run(JSON.stringify(settings), first.id)
    } finally {
      db.close()
    }

    const resumed = await resume({ session: first.id })
    const forked = await resume({ session: first.id, fork: true })

    expect(resumed.launchSettings).toEqual(settings)
    expect(forked.launchSettings).toEqual(settings)
    expect((await call<Session>(client, 'quirky.session/get', { session: resumed.id })).launchSettings).toEqual(settings)
    expect((await call<Session>(client, 'quirky.session/get', { session: first.id })).launchSettings).toEqual(settings)
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
      const argv = spawnedArgv(resumed.id)
      expect(argv).toContain(`claude '--settings' '${JSON.stringify(CLAUDE_SETTINGS)}'`)
      expect(argv).toEndWith('--resume abc')
      expect(argv.match(/'--settings'/g)).toHaveLength(1)
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
    expect(spawnedArgv(resumed.id).match(/'--settings'/g)).toHaveLength(1)
  })

  test('a resumed session starts without the name of the session it came from, which keeps it', async () => {
    const old = await start('claude', { name: 'reviewer' })
    await setProviderSession({ session: 'reviewer', id: 'abc' })
    const resumed = await resume({ session: 'reviewer' })
    expect(resumed).toMatchObject({ resumedFrom: old.id, name: null })
    expect(await call<Session>(client, 'quirky.session/get', { session: old.id })).toMatchObject({ name: 'reviewer' })
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

  test('structured resume rejects provider and fork overrides without starting a terminal', async () => {
    const structured = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_real',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    const before = creates()
    expect(await failure(resume({ session: structured.id, providerSession: 'native-thread' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'structured sessions do not support providerSession overrides'
    })
    expect(await failure(resume({ session: structured.id, fork: true }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'structured sessions do not support fork'
    })
    expect(creates()).toBe(before)
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

describe('structured provider resume', () => {
  test('resumes Claude and Codex across a daemon restart without creating new provider conversations', async () => {
    await h.cleanup()
    h = await startPluginHarness(STRUCTURED_SESSION_PLUGINS)
    ;({ client, events } = await h.connectWithEvents('cli'))
    const home = h.home
    const fixture = createCodexAppServerFixture(home)
    const claudeQueries: FakeQuery[] = []
    globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = structuredRunnerFactory(home, fixture.executable, claudeQueries)

    const createStructured = (agent: string, prompt: string, model: string, effort: string) =>
      call<Session>(client, 'quirky.structured/create', {
        worktree: 'id:wt_real',
        agent,
        prompt,
        model,
        options: { effort }
      })
    const claude = await createStructured('claude', 'initial Claude turn', 'opus', 'high')
    const codex = await createStructured('codex', 'initial Codex turn', 'gpt-5.5', 'xhigh')
    const [oldClaude, oldCodex] = await waitForAsync(async () => {
      const [claudeSession, codexSession] = await Promise.all([
        call<Session>(client, 'quirky.session/get', { session: claude.id }),
        call<Session>(client, 'quirky.session/get', { session: codex.id })
      ])
      return claudeSession.providerSession?.id && codexSession.providerSession?.id ? [claudeSession, codexSession] : null
    })
    expect(oldClaude).toMatchObject({
      worktreeId: 'wt_real',
      cwd: folder,
      launchSettings: { agent: 'claude', options: { model: { value: 'opus' }, effort: { value: 'high' } } }
    })
    expect(oldCodex).toMatchObject({
      worktreeId: 'wt_real',
      cwd: folder,
      providerSession: { id: 'scripted-thread' },
      launchSettings: { agent: 'codex', options: { model: { value: 'gpt-5.5' }, effort: { value: 'xhigh' } } }
    })
    expect(claudeQueries[0].params.options?.sessionId).toBe(oldClaude.providerSession!.id)
    expect(oldClaude.providerSession!.id).not.toBe(claude.id)
    expect(h.pty.requests.some((request) => request.type === 'create')).toBe(false)

    expect(await failure(call(client, 'quirky.structured/resume', { session: codex.id }))).toMatchObject({
      code: RpcErrorCode.Conflict
    })
    await call(client, 'quirky.structured/stop', { session: claude.id })
    await call(client, 'quirky.structured/stop', { session: codex.id })

    const restarted = await restartDaemon(h, {
      builtinPluginsDir: makeBuiltinDir(home, STRUCTURED_SESSION_PLUGINS, 'structured-resume-builtins')
    })
    try {
      client = restarted.client
      const resumedClaude = await call<Session>(client, 'quirky.structured/resume', { session: claude.id })
      const codexAttempts = await Promise.all([
        call<Session>(client, 'quirky.session/resume', { session: codex.id }).then(
          (session) => ({ session }),
          (error: unknown) => ({ error })
        ),
        call<Session>(client, 'quirky.session/resume', { session: codex.id }).then(
          (session) => ({ session }),
          (error: unknown) => ({ error })
        )
      ])
      const codexSuccess = codexAttempts.find((attempt): attempt is { session: Session } => 'session' in attempt)
      const codexConflict = codexAttempts.find((attempt): attempt is { error: unknown } => 'error' in attempt)
      expect(codexSuccess).toBeDefined()
      expect(codexConflict?.error).toMatchObject({ code: RpcErrorCode.Conflict })
      const resumedCodex = codexSuccess!.session
      await call(client, 'quirky.structured/send', { session: resumedCodex.id, text: 'later Codex turn' })
      const [resumedClaudeRecord, resumedCodexRecord] = await waitForAsync(async () => {
        const [claudeRecord, codexRecord] = await Promise.all([
          call<Session>(client, 'quirky.session/get', { session: resumedClaude.id }),
          call<Session>(client, 'quirky.session/get', { session: resumedCodex.id })
        ])
        return claudeRecord.providerSession?.id && codexRecord.providerSession?.id ? [claudeRecord, codexRecord] : null
      })

      expect(resumedClaudeRecord.id).not.toBe(claude.id)
      expect(resumedCodexRecord.id).not.toBe(codex.id)
      expect(resumedClaudeRecord).toMatchObject({
        kind: 'structured',
        agent: 'claude',
        worktreeId: oldClaude.worktreeId,
        cwd: folder,
        resumedFrom: claude.id,
        launchSettings: oldClaude.launchSettings,
        providerSession: { id: oldClaude.providerSession!.id }
      })
      expect(resumedCodexRecord).toMatchObject({
        kind: 'structured',
        agent: 'codex',
        worktreeId: oldCodex.worktreeId,
        cwd: folder,
        resumedFrom: codex.id,
        launchSettings: oldCodex.launchSettings,
        providerSession: { id: oldCodex.providerSession!.id }
      })
      await waitFor(() => claudeQueries.length === 2)
      const claudeResume = claudeQueries.find((query) => query.params.options?.resume === oldClaude.providerSession!.id)!
      expect(claudeResume.params.options).toMatchObject({ model: 'opus', effort: 'high' })
      expect(claudeResume.params.options).not.toHaveProperty('sessionId')

      await call(client, 'quirky.structured/send', { session: resumedClaude.id, text: 'later Claude turn' })
      await waitForAsync(async () => (claudeResume.written.length === 1 ? true : null))
      expect(claudeResume.written[0]).toMatchObject({
        session_id: oldClaude.providerSession!.id,
        message: { content: 'later Claude turn' }
      })

      const resumeCall = fixture.requests().filter((request) => request.method === 'thread/resume').at(-1)
      expect(resumeCall?.params).toMatchObject({ threadId: oldCodex.providerSession!.id, cwd: folder, model: 'gpt-5.5' })
      await waitForAsync(async () => {
        const messages = await call<StructuredMessage[]>(client, 'quirky.structured/messages', { session: resumedCodex.id })
        return messages.some((message) => message.role === 'assistant' && message.text === 'Codex: later Codex turn')
      })
      expect(fixture.requests().filter((request) => request.method === 'turn/start').at(-1)?.params).toMatchObject({
        threadId: oldCodex.providerSession!.id,
        input: [{ type: 'text', text: 'later Codex turn' }],
        model: 'gpt-5.5',
        effort: 'xhigh'
      })
      expect(h.pty.requests.some((request) => request.type === 'create')).toBe(false)
      await call(client, 'quirky.structured/stop', { session: resumedClaude.id })
      await call(client, 'quirky.structured/stop', { session: resumedCodex.id })
    } finally {
      await restarted.stop()
    }
  })
})
