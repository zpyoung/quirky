import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, QuirkyClient, type AgentStatusSummary, type QuirkyEvent, type RpcError, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempHome, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import {
  makeTempDir,
  readMarker,
  removeTempDirs,
  waitForFile,
  writeModulePlugin
} from '../../../packages/daemon/test/plugins/fixtures'
import { fakeAccountPreparationCalls, resetFakeAccountPreparation } from './fakes/quirky.accounts/main'
import { CLAUDE_SETTINGS, resetPointerState, setPointerQuiet, setPointerState } from './fakes/quirky.agent-status/main'
import { call, code, createSession, restartDaemon, SESSION_PLUGINS, startPluginHarness, storedSessions } from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  resetFakeAgents()
  resetPointerState()
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_VANISHED_WORKTREES
  fakeAgents().gate = null
  await h.cleanup()
  resetFakeAccountPreparation()
  removeTempDirs()
})

function spawned(sessionId: string) {
  const request = h.pty.requests.find((r) => r.type === 'create' && r.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request
}

const eventsOf = (type: string) => events.filter((e) => e.type === type)
const changedTo = (status: string) =>
  events.find((e) => e.type === 'quirky.session/changed' && (e.data as { session: Session }).session.status === status)

const exportPath = () => `export PATH="${h.home}/bin:$PATH"; `


describe('session identity and pointer delivery', () => {
  test('returns a live terminal identity without exposing its launch token', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const token = spawned(session.id).env.QUIRKY_SESSION_TOKEN
    expect(token).toEqual(expect.any(String))

    expect(identity).toMatchObject({
      sessionId: session.id,
      live: true,
      runtimeEpoch: expect.any(String),
      processIncarnation: expect.any(String),
      source: 'terminal_launch',
      kind: 'terminal',
      providerId: null,
      worktreeId: session.worktreeId
    })
    expect(JSON.stringify(identity)).not.toContain(token)
    const db = new Database(join(h.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      db.query('UPDATE sessions SET launch = ? WHERE id = ?').run(
        JSON.stringify({ command: 'shell', args: '', env: { SAFE_ENV: 'kept', QUIRKY_SESSION_TOKEN: token } }),
        session.id
      )
    } finally {
      db.close()
    }
    const stored = await call<Session>(client, 'quirky.session/get', { session: session.id })
    expect(stored.launch?.env).toEqual({ SAFE_ENV: 'kept' })
    expect(JSON.stringify(stored)).not.toContain(token)
  })

  test('replays one pointer operation without a second terminal submit and rejects payload mismatch', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'pointer-op-1',
      text: 'Run `quirky orchestration check`.'
    }

    const first = call(client, 'quirky.session/pointer', params)
    await waitFor(() => h.pty.inputs.some((input) => input.sessionId === session.id))
    const replay = call(client, 'quirky.session/pointer', params)
    const [result, repeated] = await Promise.all([first, replay])

    expect(repeated).toEqual(result)
    expect(result).toEqual({
      operationId: params.operationId,
      result: { status: 'submitted', transport: 'terminal_enter' }
    })
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text)).toHaveLength(2)
    await expect(
      call(client, 'quirky.session/pointer', { ...params, text: 'different command' })
    ).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  })

  test('singleflights distinct pointer operations for the exact recipient', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const first = call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'flight-one',
      text: 'first'
    })
    await waitFor(() => h.pty.inputs.some((input) => input.sessionId === session.id))
    const second = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'flight-two',
      text: 'second'
    })
    expect(second).toEqual({
      operationId: 'flight-two',
      result: { status: 'deferred', reason: 'flight_active' }
    })
    await first
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id)).toHaveLength(2)
  })

  test('allows a live working agent to take the pointer at submit time', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const pointer = call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'working-submit-op',
      text: 'check'
    })
    await waitFor(() => h.pty.inputs.some((input) => input.sessionId === session.id))
    setPointerState('working')

    expect(await pointer).toEqual({
      operationId: 'working-submit-op',
      result: { status: 'submitted', transport: 'terminal_enter' }
    })
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text).at(-1)).toBe('\r')
  })

  test('does not retype a pointer after post-write submission becomes uncertain', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'post-write-unknown-op',
      text: 'check'
    }
    const pointer = call(client, 'quirky.session/pointer', params)
    await waitFor(() => h.pty.inputs.some((input) => input.sessionId === session.id))
    setPointerState('blocked')

    const uncertain = {
      operationId: params.operationId,
      result: { status: 'outcome_unknown', attemptedPhase: 'write_attempted', retryEnter: false }
    }
    expect(await pointer).toEqual(uncertain)
    expect(await call(client, 'quirky.session/pointer', params)).toEqual(uncertain)
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id)).toHaveLength(1)
  })

  test('does not write while busy, non-quiescent, blocked or changed', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    setPointerState('working')
    const busy = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'busy-op',
      text: 'check'
    })
    expect(busy).toEqual({
      operationId: 'busy-op',
      result: { status: 'deferred', reason: 'not_idle' }
    })
    expect(h.pty.inputs).toEqual([])
    setPointerState('idle')
    setPointerQuiet(false)
    const unsettled = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'quiet-op',
      text: 'check'
    })
    expect(unsettled).toEqual({
      operationId: 'quiet-op',
      result: { status: 'deferred', reason: 'not_quiescent' }
    })
    expect(h.pty.inputs).toEqual([])
    setPointerQuiet(true)
    setPointerState('blocked')
    const blocked = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'blocked-op',
      text: 'check'
    })
    expect(blocked).toEqual({
      operationId: 'blocked-op',
      result: { status: 'deferred', reason: 'blocked_dialog' }
    })
    expect(h.pty.inputs).toEqual([])

    setPointerState('idle')
    const changed = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: 'replaced-process',
      operationId: 'changed-op',
      text: 'check'
    })
    expect(changed).toEqual({
      operationId: 'changed-op',
      result: { status: 'released', reason: 'recipient_changed' }
    })
    expect(h.pty.inputs).toEqual([])
  })

  test('reserves a structured pointer until its live lease is idle', async () => {
    const session = (await call(client, 'quirky.structured/pointerSession', {
      worktree: 'id:wt_main',
      status: 'working'
    })) as Session
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'structured-pointer-op',
      text: 'check'
    }

    const busy = await call(client, 'quirky.session/pointer', params)
    expect(busy).toEqual({
      operationId: params.operationId,
      result: { status: 'deferred', reason: 'not_idle' }
    })
    expect(await call(client, 'quirky.structured/pointerSends')).toEqual([])

    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'waiting' })
    const blocked = await call(client, 'quirky.session/pointer', params)
    expect(blocked).toEqual({
      operationId: params.operationId,
      result: { status: 'deferred', reason: 'blocked_dialog' }
    })
    expect(await call(client, 'quirky.structured/pointerSends')).toEqual([])

    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'running' })
    const submitted = await call(client, 'quirky.session/pointer', params)
    expect(submitted).toEqual({
      operationId: params.operationId,
      result: { status: 'submitted', transport: 'structured_session' }
    })
    expect(await call(client, 'quirky.structured/pointerSends')).toEqual([
      expect.objectContaining({
        session: session.id,
        text: params.text,
        operationId: params.operationId,
        expectedIncarnation: identity.processIncarnation
      })
    ])
    expect(await call(client, 'quirky.session/pointer', params)).toEqual(submitted)
    expect(await call(client, 'quirky.structured/pointerSends')).toHaveLength(1)

    expect(
      await call(client, 'quirky.session/close', { session: session.id, expectedIncarnation: identity.processIncarnation })
    ).toEqual({
      ok: true,
      closed: true,
      sessionId: session.id,
      processIncarnation: identity.processIncarnation
    })
  })

  test('does not resend a deferred structured worker-start operation after idle', async () => {
    const session = (await call(client, 'quirky.structured/pointerSession', {
      worktree: 'id:wt_main',
      status: 'working'
    })) as Session
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'structured-deferred-worker-start',
      text: 'initial task prompt',
      purpose: 'worker_start'
    }

    const deferred = await call(client, 'quirky.session/pointer', params)
    expect(deferred).toEqual({
      operationId: params.operationId,
      result: { status: 'deferred', reason: 'not_idle' }
    })
    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'running' })
    expect(await call(client, 'quirky.session/pointer', params)).toEqual(deferred)
    expect(await call(client, 'quirky.structured/pointerSends')).toEqual([])
    await call(client, 'quirky.session/close', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation
    })
  })

  test('sends Cursor mailbox pointer text without Enter and fences purpose reuse', async () => {
    fakeAgents().pick = 'cursor'
    const session = await createSession(client, { worktree: 'id:wt_main' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })

    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'cursor-op',
      text: 'Run `quirky orchestration check`.'
    }
    const result = await call(client, 'quirky.session/pointer', params)

    expect(result).toEqual({
      operationId: params.operationId,
      result: { status: 'text_only', reason: 'cursor_no_auto_enter' }
    })
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id)).toHaveLength(1)
    expect(h.pty.inputs.find((input) => input.sessionId === session.id)!.text).not.toContain('\r')
    await expect(
      call(client, 'quirky.session/pointer', { ...params, purpose: 'worker_start' })
    ).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  })

  test('submits Cursor worker-start prompts with Enter', async () => {
    fakeAgents().pick = 'cursor'
    const session = await createSession(client, { worktree: 'id:wt_main' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })

    const result = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'cursor-worker-start-op',
      text: 'start this worker',
      purpose: 'worker_start'
    })

    expect(result).toEqual({
      operationId: 'cursor-worker-start-op',
      result: { status: 'submitted', transport: 'terminal_enter' }
    })
    const writes = h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text)
    expect(writes).toHaveLength(2)
    expect(writes[1]).toBe('\r')
  })
  test('transports a maximum worker spec with preamble overhead without truncation', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const text = `Worker preamble:\n${'x'.repeat(1_214_464)}`

    const result = await call(client, 'quirky.session/pointer', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'large-worker-start-op',
      text,
      purpose: 'worker_start'
    })

    expect(result).toEqual({
      operationId: 'large-worker-start-op',
      result: { status: 'submitted', transport: 'terminal_enter' }
    })
    const writes = h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text)
    expect(writes[0]?.length).toBe(text.length + 12)
    expect(writes[0]?.startsWith('\u001b[200~')).toBe(true)
    expect(writes[0]?.endsWith('\u001b[201~')).toBe(true)
    expect(writes[1]).toBe('\r')
  })

  test('does not replay a deferred worker-start operation after the recipient goes idle', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'deferred-worker-start-op',
      text: 'initial task prompt',
      purpose: 'worker_start'
    }
    setPointerState('working')
    const deferred = await call(client, 'quirky.session/pointer', params)
    expect(deferred).toEqual({
      operationId: params.operationId,
      result: { status: 'deferred', reason: 'not_idle' }
    })

    setPointerState('idle')
    expect(await call(client, 'quirky.session/pointer', params)).toEqual(deferred)
    expect(h.pty.inputs).toEqual([])
  })
  test('closes only the expected live process incarnation', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const identity = await call(client, 'quirky.session/identity', { session: session.id })

    const stale = await call(client, 'quirky.session/close', {
      session: session.id,
      expectedIncarnation: 'replaced-process'
    })
    expect(stale).toEqual({ ok: false, reason: 'recipient_changed' })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ id: session.id })
    expect(h.pty.requests.some((request) => request.type === 'forget' && request.sessionId === session.id)).toBe(false)

    const closed = await call(client, 'quirky.session/close', {
      session: session.id,
      expectedIncarnation: identity.processIncarnation
    })
    expect(closed).toEqual({
      ok: true,
      closed: true,
      sessionId: session.id,
      processIncarnation: identity.processIncarnation
    })
    expect(await code(call(client, 'quirky.session/get', { session: session.id }))).toBe(RpcErrorCode.NotFound)
  })

  test('does not repeat Enter after a persisted uncertain write attempt', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    setPointerState('idle')
    const identity = await call(client, 'quirky.session/identity', { session: session.id })
    const params = {
      session: session.id,
      expectedIncarnation: identity.processIncarnation,
      operationId: 'uncertain-op',
      text: 'check'
    }
    await call(client, 'quirky.session/pointer', params)
    const writes = h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text)

    const db = new Database(join(h.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      db.query(
        "UPDATE session_pointer_operations SET phase = 'write_attempted', result_json = NULL WHERE operation_id = ?"
      ).run(params.operationId)
    } finally {
      db.close()
    }

    const retried = await call(client, 'quirky.session/pointer', params)
    expect(retried).toEqual({
      operationId: params.operationId,
      result: { status: 'outcome_unknown', attemptedPhase: 'write_attempted', retryEnter: false }
    })
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id).map((input) => input.text)).toEqual(writes)
  })
})
describe('quirky.session/create', () => {
  test('starts a shell with the documented env and emits changed', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', cols: 100, rows: 30 })
    expect(session).toMatchObject({
      kind: 'terminal',
      agent: 'shell',
      title: 'Shell',
      status: 'running',
      worktreeId: 'wt_main',
      cwd: '/fake/alpha',
      exitCode: null
    })
    expect(session.id).toMatch(/^s_[0-9a-f]+$/)

    const request = spawned(session.id)
    expect(request).toMatchObject({ cwd: '/fake/alpha', argv: ['/bin/zsh', '-l'], cols: 100, rows: 30 })
    expect(request.env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      QUIRKY_HOME: h.home,
      QUIRKY_SESSION_ID: session.id,
      QUIRKY_WORKTREE_ID: 'wt_main',
      QUIRKY_HOOK_URL: `http://127.0.0.1:${h.runtime.port}/hook`,
      QUIRKY_HOOK_TOKEN: h.runtime.hookToken
    })
    expect(request.env.PATH.startsWith(`${h.home}/bin:`)).toBe(true)
    await waitFor(() => events.find((e) => e.type === 'quirky.session/changed'))
    expect(await call(client, 'quirky.session/list', { worktree: 'id:wt_main' })).toHaveLength(1)
  })

  test('asks the host for the shell-ready wrapper for a zsh shell session and not for an agent', async () => {
    const shell = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(spawned(shell.id).shellReady).toBe(true)
    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(spawned(claude.id).shellReady).toBe(false)
  })

  test('uses a 80x24 terminal unless told otherwise', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(spawned(session.id)).toMatchObject({ cols: 80, rows: 24 })
  })

  test('agents run under the login shell with the command quirky.agents prepared and the launch-hook args', async () => {
    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'do the thing' })
    expect(claude.title).toBe('Claude')
    expect(spawned(claude.id).argv).toEqual([
      '/bin/zsh',
      '-l',
      '-c',
      `${exportPath()}exec claude '--settings' '${JSON.stringify(CLAUDE_SETTINGS)}' 'do the thing'`
    ])
    const codex = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    expect(spawned(codex.id).argv[3]).toBe(
      `${exportPath()}exec codex '-c' 'notify=["${h.home}/bin/quirky-hook","codex"]'`
    )
    const gemini = await createSession(client, { worktree: 'id:wt_main', agent: 'gemini', prompt: 'x' })
    expect(spawned(gemini.id).argv[3]).toBe(`${exportPath()}exec gemini 'x'`)
    const opencode = await createSession(client, { worktree: 'id:wt_main', agent: 'opencode', prompt: 'x' })
    expect(spawned(opencode.id).argv[3]).toBe(`${exportPath()}exec opencode 'x'`)
    expect([claude.title, codex.title, gemini.title, opencode.title]).toEqual(['Claude', 'Codex', 'Gemini', 'OpenCode'])
  })

  test('SC-8: a launch without an agent starts what quirky.agents picks', async () => {
    fakeAgents().pick = 'codex'
    const codex = await createSession(client, { worktree: 'id:wt_main' })
    expect(codex).toMatchObject({ agent: 'codex', title: 'Codex' })
    expect(spawned(codex.id).argv[3]).toStartWith(`${exportPath()}exec codex`)

    fakeAgents().pick = 'shell'
    const shell = await createSession(client, { worktree: 'id:wt_main' })
    expect(shell).toMatchObject({ agent: 'shell', title: 'Shell', launch: null, promptDelivery: null })
    expect(spawned(shell.id).argv).toEqual(['/bin/zsh', '-l'])
  })

  test('SC-10: a disabled agent can not be launched by name and leaves no session', async () => {
    fakeAgents().disabled.add('claude')
    const error = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' }).catch((e: RpcError) => e)
    expect(error).toMatchObject({ code: expect.any(Number) })
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('numbers titles per worktree when one is taken', async () => {
    const create = async (agent: 'shell' | 'claude', worktree = 'id:wt_main') =>
      (await createSession(client, { worktree, agent })).title
    expect(await create('shell')).toBe('Shell')
    expect(await create('shell')).toBe('Shell 2')
    expect(await create('claude')).toBe('Claude')
    expect(await create('claude')).toBe('Claude 2')
    expect(await create('shell')).toBe('Shell 3')
    const sessions = await call<Session[]>(client, 'quirky.session/list', { worktree: 'id:wt_main' })
    await call(client, 'quirky.session/close', { session: sessions.find((s) => s.title === 'Shell')!.id })
    expect(await create('shell')).toBe('Shell')
    expect(await create('shell', 'id:wt_other')).toBe('Shell')
  })

  test('shell sessions in zsh get the ZDOTDIR wrapper and the user dir to hand back to', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const env = spawned(session.id).env
    expect(env.ZDOTDIR).toBe(join(h.home, 'shell', 'zsh'))
    expect(env.QUIRKY_ORIG_ZDOTDIR).toBe((process.env.ZDOTDIR || process.env.HOME) as string)
    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(spawned(claude.id).env.ZDOTDIR).toBe(process.env.ZDOTDIR as string)
  })

  test('rejects unknown worktrees and agents', async () => {
    expect(await code(createSession(client, { worktree: 'id:wt_nope', agent: 'shell' }))).toBe(RpcErrorCode.NotFound)
    const unknown = await createSession(client, { worktree: 'id:wt_main', agent: 'vim' }).catch((e: RpcError) => e)
    expect(unknown).toMatchObject({ code: RpcErrorCode.NotFound })
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('a failed spawn leaves no record', async () => {
    h.pty.failRequests('create', 'no such shell')
    const error = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' }).catch((e: RpcError) => e)
    expect((error as RpcError).code).toBe(RpcErrorCode.Internal)
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('SC-22: sessions run under the login shell with the launch environment', async () => {
    await h.cleanup()
    removeTempDirs()
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.env', contributes: { 'launch-hook': [{ id: 'vars', agents: ['claude'] }] } },
      { activate: `context.provide('launch-hook:acme.env/vars', () => ({ env: { FOO: '1' } }))` }
    )
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    client = await h.connect('cli')

    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'hi' })
    const request = spawned(claude.id)
    expect(request.cwd).toBe('/fake/alpha')
    expect(request.argv).toEqual([
      '/bin/zsh',
      '-l',
      '-c',
      `${exportPath()}exec claude '--settings' '${JSON.stringify(CLAUDE_SETTINGS)}' 'hi'`
    ])
    expect(request.env).toMatchObject({
      FOO: '1',
      QUIRKY_HOME: h.home,
      QUIRKY_SESSION_ID: claude.id,
      QUIRKY_WORKTREE_ID: 'wt_main',
      QUIRKY_HOOK_URL: `http://127.0.0.1:${h.runtime.port}/hook`,
      QUIRKY_HOOK_TOKEN: h.runtime.hookToken
    })
    expect(request.env.PATH.startsWith(`${h.home}/bin:`)).toBe(true)

    const codex = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    expect(spawned(codex.id).argv[3]).toContain(`'-c' 'notify=[`)
    expect(spawned(codex.id).env.FOO).toBeUndefined()
  })

  test('a launch hook removing an env name removes it from the session', async () => {
    await h.cleanup()
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.drop', contributes: { 'launch-hook': [{ id: 'drop', agents: ['shell'] }] } },
      { activate: `context.provide('launch-hook:acme.drop/drop', () => ({ env: { HOME: null, FOO: '2' } }))` }
    )
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    client = await h.connect('cli')
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const env = spawned(session.id).env
    expect('HOME' in env).toBe(false)
    expect(env.FOO).toBe('2')
  })

  test('closing a session while its launch hooks are pending never spawns its terminal', async () => {
    await h.cleanup()
    const home = makeTempHome()
    const workDir = makeTempDir()
    const marker = join(workDir, 'marker.log')
    const release = join(workDir, 'release')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.slow', contributes: { 'launch-hook': [{ id: 'wait', agents: ['claude'] }] } },
      {
        activate: `context.provide('launch-hook:acme.slow/wait', async () => {
          record('hook waiting')
          ${waitForFile(release)}
          return { env: {}, args: [] }
        })`
      }
    )
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    try {
      client = await h.connect('cli')
      const creating = createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
      const failure = creating.then(
        () => null,
        (error: RpcError) => error
      )
      await waitFor(() => readMarker(marker).includes('hook waiting') || undefined)
      const [pending] = await call<Session[]>(client, 'quirky.session/list', { worktree: 'id:wt_main' })
      expect(pending).toMatchObject({ status: 'starting' })

      await call(client, 'quirky.session/close', { session: pending!.id })
      writeFileSync(release, '')

      const error = await failure
      expect(error?.code).toBe(RpcErrorCode.Conflict)
      expect(h.pty.requests.some((r) => r.type === 'create' && r.sessionId === pending!.id)).toBe(false)
      expect(h.pty.sessions.has(pending!.id)).toBe(false)
      expect(await call(client, 'quirky.session/list')).toEqual([])
    } finally {
      writeFileSync(release, '')
    }
  })
})

/** Holds `deliver` until the returned function is called. */
function holdDelivery(): () => void {
  let release!: () => void
  fakeAgents().gate = new Promise<void>((resolve) => (release = resolve))
  return release
}

const deliveries = () => fakeAgents().calls.filter((c) => c.method === 'deliver').map((c) => c.params)
const changedWith = (sessionId: string, promptDelivery: string) => () =>
  events.find(
    (e) =>
      e.type === 'quirky.session/changed' &&
      (e.data as { session: Session }).session.id === sessionId &&
      (e.data as { session: Session }).session.promptDelivery === promptDelivery
  )

describe('SC-28: create returns at spawn unless asked to wait', () => {
  test('SC-28: a pasted prompt is pending when create returns, and changed carries the outcome later', async () => {
    const release = holdDelivery()
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'review it' })
    expect(session).toMatchObject({ agent: 'goose', status: 'running', promptDelivery: 'pending' })
    expect(spawned(session.id).argv[3]).not.toContain('review it')
    await waitFor(() => deliveries()[0])
    expect(deliveries()).toEqual([{ sessionId: session.id, agent: 'goose', text: 'review it', submit: true }])
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ promptDelivery: 'pending' })

    release()
    const event = await waitFor(changedWith(session.id, 'pasted'))
    expect(event).toBeDefined()
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ promptDelivery: 'pasted', status: 'running' })
  })

  test('a draft is delivered without Enter, for any agent', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'half', submitPrompt: false })
    expect(session.promptDelivery).toBe('pending')
    await waitFor(changedWith(session.id, 'pasted'))
    expect(deliveries()).toEqual([{ sessionId: session.id, agent: 'claude', text: 'half', submit: false }])
  })

  test('the outcomes unconfirmed and not-delivered are recorded as quirky.agents reports them', async () => {
    fakeAgents().outcome = 'unconfirmed'
    const first = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a' })
    await waitFor(changedWith(first.id, 'unconfirmed'))
    fakeAgents().outcome = 'not-delivered'
    const second = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'b' })
    await waitFor(changedWith(second.id, 'not-delivered'))
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.promptDelivery)).toEqual(['unconfirmed', 'not-delivered'])
  })

  test('a deliver call that fails records not-delivered', async () => {
    fakeAgents().outcome = 'reject'
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a' })
    expect(session.promptDelivery).toBe('pending')
    await waitFor(changedWith(session.id, 'not-delivered'))
  })

  test('waitForPrompt returns only after the delivery settled', async () => {
    const release = holdDelivery()
    let returned = false
    const creating = createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a', waitForPrompt: true }).then((s) => {
      returned = true
      return s
    })
    await waitFor(() => deliveries()[0])
    await Bun.sleep(30)
    expect(returned).toBe(false)
    release()
    const session = await creating
    expect(session).toMatchObject({ promptDelivery: 'pasted', status: 'running' })
  })

  test('waitForPrompt returns the not-delivered outcome too', async () => {
    fakeAgents().outcome = 'not-delivered'
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a', waitForPrompt: true })
    expect(session.promptDelivery).toBe('not-delivered')
  })

  test('a prompt that takes the command line is never delivered by paste', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'x', waitForPrompt: true })
    expect(session.promptDelivery).toBe('command-line')
    expect(deliveries()).toEqual([])
  })

  test('a prompt containing NUL is refused before anything starts', async () => {
    const eventsBefore = eventsOf('quirky.session/changed').length
    expect(await code(createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a\u0000b' }))).toBe(RpcErrorCode.InvalidParams)
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    expect(await call(client, 'quirky.session/list')).toEqual([])
    expect(eventsOf('quirky.session/changed')).toHaveLength(eventsBefore)
  })

  test('a delivery still pending when the daemon restarts becomes not-delivered at startup', async () => {
    holdDelivery()
    const pending = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a' })
    const done = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'b' })
    expect(pending.promptDelivery).toBe('pending')

    const again = await restartDaemon(h)
    try {
      const sessions = await call<Session[]>(again.client, 'quirky.session/list')
      expect(sessions.find((s) => s.id === pending.id)).toMatchObject({ promptDelivery: 'not-delivered', status: 'running' })
      expect(sessions.find((s) => s.id === done.id)).toMatchObject({ promptDelivery: 'command-line' })
    } finally {
      await again.stop()
    }
  })

  test('a session closed before its delivery settles is not brought back', async () => {
    const release = holdDelivery()
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'goose', prompt: 'a' })
    await call(client, 'quirky.session/close', { session: session.id })
    release()
    await Bun.sleep(40)
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })
})

describe('SC-21: defaults come from the caller identity', () => {
  const connect = (hello: { cwd?: string; sessionId?: string; worktreeId?: string }) =>
    QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', ...hello })

  test('a call without a worktree uses the caller worktree over its cwd', async () => {
    const inside = await connect({ cwd: '/fake/other/src', worktreeId: 'wt_main' })
    try {
      const session = await createSession(inside, { agent: 'shell' })
      expect(session.worktreeId).toBe('wt_main')
      expect(spawned(session.id).cwd).toBe('/fake/alpha')
    } finally {
      inside.close()
    }
  })

  test('a call without a worktree falls back to the worktree containing the cwd', async () => {
    const inside = await connect({ cwd: '/fake/other/src' })
    try {
      expect((await createSession(inside, { agent: 'shell' })).worktreeId).toBe('wt_other')
    } finally {
      inside.close()
    }
  })

  test('a call without a worktree from nowhere is NotFound', async () => {
    expect(await code(createSession(client, { agent: 'shell' }))).toBe(RpcErrorCode.NotFound)
  })

  test('selectors name the worktree', async () => {
    expect((await createSession(client, { worktree: 'branch:other', agent: 'shell' })).worktreeId).toBe('wt_other')
    expect((await createSession(client, { worktree: 'wt_other', agent: 'shell' })).worktreeId).toBe('wt_other')
    expect(await code(createSession(client, { worktree: 'main', agent: 'shell' }))).toBe(RpcErrorCode.Conflict)
  })
})

describe('quirky.session/close', () => {
  test('forgets the session and emits removed', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    await call(client, 'quirky.session/close', { session: session.id })
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
    expect(await call(client, 'quirky.session/list')).toEqual([])
    await waitFor(() => events.find((e) => e.type === 'quirky.session/removed'))
    expect(eventsOf('quirky.session/removed')[0]).toMatchObject({ data: { sessionId: session.id } })
  })

  test('keeps the session when the pty host fails to forget it, and succeeds on retry', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.failRequests('forget', 'pty host connection lost')
    expect(await code(call(client, 'quirky.session/close', { session: session.id }))).toBe(RpcErrorCode.Internal)
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([session.id])
    expect(eventsOf('quirky.session/removed')).toHaveLength(0)

    h.pty.failRequests('forget', null)
    await call(client, 'quirky.session/close', { session: session.id })
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('still removes a session the pty host no longer knows', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.sessions.delete(session.id)
    await call(client, 'quirky.session/close', { session: session.id })
    expect(await call(client, 'quirky.session/list')).toEqual([])
    await waitFor(() => events.find((e) => e.type === 'quirky.session/removed'))
  })

  test('an unknown session is NotFound', async () => {
    expect(await code(call(client, 'quirky.session/close', { session: 's_nope' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.session/get', { session: 's_nope' }))).toBe(RpcErrorCode.NotFound)
  })
})

describe('registered sessions', () => {
  test('a structured session is a record with no terminal, closed without touching the pty host', async () => {
    const session = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect(session).toMatchObject({ kind: 'structured', agent: 'claude', title: 'Claude', status: 'starting', worktreeId: 'wt_main' })
    await waitFor(() => changedTo('starting'))
    const second = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect(second.title).toBe('Claude 2')
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)

    await call(client, 'quirky.session/close', { session: session.id })
    expect(h.pty.requests.some((r) => r.type === 'forget')).toBe(false)
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([second.id])
    await waitFor(() => events.find((e) => e.type === 'quirky.session/removed'))
  })

  test('only structured sessions can be registered', async () => {
    expect(
      await code(call(client, 'quirky.session/register', { worktree: 'id:wt_main', agent: 'claude', kind: 'terminal', title: 'x' }))
    ).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('quirky.session/setStatus', () => {
  test('records the status, emits changed only when it differs, and bumps activity', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await waitFor(() => changedTo('running'))
    const before = eventsOf('quirky.session/changed').length
    const working = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'working' })
    expect(working).toMatchObject({ id: session.id, status: 'working' })
    expect(working.lastActivityAt).toBeGreaterThanOrEqual(session.lastActivityAt)
    await waitFor(() => eventsOf('quirky.session/changed').length === before + 1 || undefined)

    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'working' })
    await Bun.sleep(40)
    expect(eventsOf('quirky.session/changed')).toHaveLength(before + 1)
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ status: 'working' })
  })

  test('stores an agent status summary, emits changed only when the summary or status differs, and omitted leaves it', async () => {
    const summary: AgentStatusSummary = {
      state: 'working',
      display: 'working',
      label: 'Working',
      detail: 'Editing',
      progress: null,
      stateStartedAt: 1,
      evidenceAt: 2,
      restoredUnconfirmed: false
    }
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(session.agentStatus).toBeNull()
    await waitFor(() => changedTo('running'))
    const count = () => eventsOf('quirky.session/changed').length
    const before = count()

    const stored = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'running', agentStatus: summary })
    expect(stored.agentStatus).toEqual(summary)
    await waitFor(() => count() === before + 1 || undefined)

    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'running', agentStatus: { ...summary } })
    await Bun.sleep(40)
    expect(count()).toBe(before + 1)

    const kept = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'running' })
    expect(kept.agentStatus).toEqual(summary)
    await Bun.sleep(40)
    expect(count()).toBe(before + 1)

    const next = { ...summary, display: 'monitoring', label: 'Monitoring background tasks' }
    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'running', agentStatus: next })
    await waitFor(() => count() === before + 2 || undefined)
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ agentStatus: next })

    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'running', agentStatus: null })
    await waitFor(() => count() === before + 3 || undefined)
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ agentStatus: null })
  })

  test('exit clears the agent status summary', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    const summary = { state: 'done', display: 'done', label: 'Done', detail: '', progress: null, stateStartedAt: 1, evidenceAt: 2, restoredUnconfirmed: false }
    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'done', agentStatus: summary })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ agentStatus: summary })
    const exited = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'exited', exitCode: 0, agentStatus: summary })
    expect(exited).toMatchObject({ status: 'exited', agentStatus: null })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ agentStatus: null })
  })

  test('a summary that is not an object or null is InvalidParams', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    for (const agentStatus of ['working', 3, [1]]) {
      expect(await code(call(client, 'quirky.session/setStatus', { session: session.id, status: 'running', agentStatus }))).toBe(
        RpcErrorCode.InvalidParams
      )
    }
  })

  test('exited records the exit code once', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'exited', exitCode: 7 })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ status: 'exited', exitCode: 7 })
    await call(client, 'quirky.session/setStatus', { session: session.id, status: 'exited', exitCode: 9 })
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ exitCode: 7 })
  })

  test('an unknown session is NotFound and a bad status is InvalidParams', async () => {
    expect(await code(call(client, 'quirky.session/setStatus', { session: 's_nope', status: 'working' }))).toBe(RpcErrorCode.NotFound)
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(await code(call(client, 'quirky.session/setStatus', { session: session.id, status: 'sleeping' }))).toBe(
      RpcErrorCode.InvalidParams
    )
  })
})

describe('quirky.session/setUnread', () => {
  test('stores the reason, returns the session, and emits changed only when the value changes', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(session.unread ?? null).toBeNull()
    await waitFor(() => changedTo('running'))
    const count = () => eventsOf('quirky.session/changed').length
    const before = count()

    const marked = await call<Session>(client, 'quirky.session/setUnread', { session: session.id, unread: 'agent' })
    expect(marked.unread).toBe('agent')
    await waitFor(() => count() === before + 1 || undefined)
    expect((eventsOf('quirky.session/changed').at(-1) as unknown as { data: { session: Session } }).data.session.unread).toBe('agent')

    await call(client, 'quirky.session/setUnread', { session: session.id, unread: 'agent' })
    await Bun.sleep(40)
    expect(count()).toBe(before + 1)

    await call(client, 'quirky.session/setUnread', { session: session.id, unread: 'bell' })
    await waitFor(() => count() === before + 2 || undefined)
    expect(await call(client, 'quirky.session/get', { session: session.id })).toMatchObject({ unread: 'bell' })

    const cleared = await call<Session>(client, 'quirky.session/setUnread', { session: session.id, unread: null })
    expect(cleared.unread).toBeNull()
    await waitFor(() => count() === before + 3 || undefined)

    await call(client, 'quirky.session/setUnread', { session: session.id, unread: null })
    await Bun.sleep(40)
    expect(count()).toBe(before + 3)
  })

  test('an unknown session is NotFound and a bad reason is InvalidParams', async () => {
    expect(await code(call(client, 'quirky.session/setUnread', { session: 's_nope', unread: 'agent' }))).toBe(RpcErrorCode.NotFound)
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    expect(await code(call(client, 'quirky.session/setUnread', { session: session.id, unread: 'loud' }))).toBe(RpcErrorCode.InvalidParams)
  })

  test('a status update leaves the reason alone', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await call(client, 'quirky.session/setUnread', { session: session.id, unread: 'notification' })
    const after = await call<Session>(client, 'quirky.session/setStatus', { session: session.id, status: 'working' })
    expect(after.unread).toBe('notification')
  })
})

describe('quirky.session/list', () => {
  test('lists all sessions, or those of one worktree selector', async () => {
    const main = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const other = await createSession(client, { worktree: 'id:wt_other', agent: 'shell' })
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([main.id, other.id])
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'name:other' })).map((s) => s.id)).toEqual([other.id])
    expect(await code(call(client, 'quirky.session/list', { worktree: 'name:nope' }))).toBe(RpcErrorCode.NotFound)
  })

  test('a worktree that no longer resolves can still be listed while sessions point at it', async () => {
    const session = await createSession(client, { worktree: 'id:wt_other', agent: 'shell' })
    process.env.QUIRKY_TEST_VANISHED_WORKTREES = 'wt_other'
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'id:wt_other' })).map((s) => s.id)).toEqual([session.id])
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'wt_other' })).map((s) => s.id)).toEqual([session.id])
    expect(await code(call(client, 'quirky.session/list', { worktree: 'name:other' }))).toBe(RpcErrorCode.NotFound)
    expect(await code(call(client, 'quirky.session/list', { worktree: 'id:wt_never' }))).toBe(RpcErrorCode.NotFound)
  })
})

describe('exit and reconciliation', () => {
  test('pty exit marks the session exited with its code', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.exit(session.id, 3)
    const event = await waitFor(() => changedTo('exited'))
    expect(event).toMatchObject({ data: { session: { id: session.id, exitCode: 3 } } })
    expect((await call<Session[]>(client, 'quirky.session/list'))[0]).toMatchObject({ status: 'exited', exitCode: 3 })
  })

  test('a pty host that lost a session marks it exited after the connection comes back', async () => {
    const lost = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const kept = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    h.pty.sessions.delete(lost.id)
    h.pty.dropConnections()
    await waitFor(() => events.find((e) => e.type === 'quirky.session/changed' && (e.data as { session: Session }).session.id === lost.id && (e.data as { session: Session }).session.status === 'exited'), 5000)
    const sessions = await call<Session[]>(client, 'quirky.session/list')
    expect(sessions.find((s) => s.id === lost.id)).toMatchObject({ status: 'exited', exitCode: null })
    expect(sessions.find((s) => s.id === kept.id)).toMatchObject({ status: 'running' })
  })

  test('a daemon restart marks sessions the host no longer has as exited and leaves live ones', async () => {
    const lost = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const kept = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const structured = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    await call(client, 'quirky.session/setStatus', { session: structured.id, status: 'working' })
    h.pty.sessions.delete(lost.id)
    const again = await restartDaemon(h)
    try {
      const sessions = await call<Session[]>(again.client, 'quirky.session/list')
      expect(sessions.find((s) => s.id === lost.id)).toMatchObject({ status: 'exited' })
      expect(sessions.find((s) => s.id === kept.id)).toMatchObject({ status: 'running' })
      expect(sessions.find((s) => s.id === structured.id)).toMatchObject({ status: 'exited' })
    } finally {
      await again.stop()
    }
  })
})

const hostInfo = (sessionId: string) => h.pty.sessions.get(sessionId)!.info
const sessionOf = (sessionId: string) => call<Session>(client, 'quirky.session/get', { session: sessionId })
const shellSession = () => createSession(client, { worktree: 'id:wt_main', agent: 'shell' })

/** Makes the fake host hold `sessionId` as the real host does after its own restart or a reboot. */
function storeInHost(sessionId: string, exitCause: 'host-lost' | 'host-restart') {
  const info = hostInfo(sessionId)
  Object.assign(info, { state: 'restorable', alive: false, pid: 0, exitCode: null, exitSignal: null, exitCause })
}

const restoreRequests = (sessionId: string) =>
  h.pty.requests.filter((r) => r.type === 'create' && r.sessionId === sessionId && r.restore === true)

describe('the session store migration', () => {
  test('keeps rows from before the exit columns, not restorable', async () => {
    await h.cleanup()
    const home = makeTempHome()
    const dir = join(home, 'plugin-data', 'quirky.session')
    mkdirSync(dir, { recursive: true })
    const db = new Database(join(dir, 'store.db'), { create: true })
    db.exec(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, agent TEXT NOT NULL, worktree_id TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
      exit_code INTEGER, repo_id TEXT)`)
    db.query("INSERT INTO sessions VALUES ('s_old', 'terminal', 'shell', 'wt_main', '/fake/alpha', 'Shell', 'exited', 1, 1, 5, 'repo_alpha')").run()
    db.exec('PRAGMA user_version = 1')
    db.close()
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    client = await h.connect('cli')
    const sessions = await call<Session[]>(client, 'quirky.session/list')
    expect(sessions.map(({ id }) => id)).toEqual(['s_old'])
    expect(sessions[0]).toMatchObject({
      id: 's_old',
      kind: 'terminal',
      agent: 'shell',
      worktreeId: 'wt_main',
      cwd: '/fake/alpha',
      title: 'Shell',
      status: 'exited',
      createdAt: 1,
      lastActivityAt: 1,
      exitCode: 5,
      exitSignal: null,
      exitCause: null,
      restorable: false
    })
  })

})

describe('exit details', () => {
  test('a process that exits on its own records its code and cause', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 3)
    await waitFor(() => changedTo('exited'))
    expect(await sessionOf(session.id)).toMatchObject({
      status: 'exited',
      exitCode: 3,
      exitSignal: null,
      exitCause: 'exited',
      restorable: false
    })
  })

  test('a death by signal records the signal beside 128+n', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 143, { exitSignal: 'SIGTERM' })
    await waitFor(() => changedTo('exited'))
    expect(await sessionOf(session.id)).toMatchObject({ exitCode: 143, exitSignal: 'SIGTERM', exitCause: 'exited', restorable: false })
  })

  test('a requested kill records cause killed', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    await waitFor(() => changedTo('exited'))
    expect(await sessionOf(session.id)).toMatchObject({ exitCode: 137, exitSignal: 'SIGKILL', exitCause: 'killed', restorable: false })
  })

  test('an exit caused by the host restarting leaves the session restorable', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, null, { exitSignal: 'SIGHUP', exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    expect(await sessionOf(session.id)).toMatchObject({
      status: 'exited',
      exitCode: null,
      exitSignal: 'SIGHUP',
      exitCause: 'host-restart',
      restorable: true
    })
  })
})

describe('reconcile with the host listing', () => {
  test('each record follows what the host reports for it', async () => {
    const running = await shellSession()
    const exited = await shellSession()
    const lost = await shellSession()
    const restarted = await shellSession()
    const absent = await shellSession()
    const late = await shellSession()
    h.pty.exit(late.id, 0)
    await waitFor(() => changedTo('exited'))
    expect((await sessionOf(late.id)).restorable).toBe(false)

    Object.assign(hostInfo(exited.id), { state: 'exited', alive: false, exitCode: 9, exitSignal: null, exitCause: 'exited' })
    storeInHost(lost.id, 'host-lost')
    storeInHost(restarted.id, 'host-restart')
    h.pty.sessions.delete(absent.id)
    storeInHost(late.id, 'host-restart')

    h.pty.dropConnections()
    await waitForAsync(async () => (await sessionOf(absent.id)).status === 'exited', 5000)
    await waitForAsync(async () => (await sessionOf(late.id)).restorable, 5000)

    expect(await sessionOf(running.id)).toMatchObject({ status: 'running', exitCause: null, restorable: false })
    expect(await sessionOf(exited.id)).toMatchObject({ status: 'exited', exitCode: 9, exitCause: 'exited', restorable: false })
    expect(await sessionOf(lost.id)).toMatchObject({ status: 'exited', exitCode: null, exitCause: 'host-lost', restorable: true })
    expect(await sessionOf(restarted.id)).toMatchObject({ status: 'exited', exitCode: null, exitCause: 'host-restart', restorable: true })
    expect(await sessionOf(absent.id)).toMatchObject({ status: 'exited', exitCode: null, exitCause: 'host-lost', restorable: false })
    expect(await sessionOf(late.id)).toMatchObject({ status: 'exited', exitCause: 'host-restart', restorable: true })
  })

  test('a daemon restart finds sessions the host stored while it was away restorable', async () => {
    const session = await shellSession()
    storeInHost(session.id, 'host-lost')
    const again = await restartDaemon(h)
    try {
      expect(await call<Session>(again.client, 'quirky.session/get', { session: session.id })).toMatchObject({
        status: 'exited',
        exitCause: 'host-lost',
        restorable: true
      })
    } finally {
      await again.stop()
    }
  })
})

describe('quirky.session/restore', () => {
  const restore = (sessionId: string) => call<Session>(client, 'quirky.session/restore', { session: sessionId })

  test('a running session comes back unchanged and nothing is sent to the host', async () => {
    const session = await shellSession()
    const before = h.pty.requests.length
    expect(await restore(session.id)).toEqual(session)
    expect(h.pty.requests.slice(before).filter((r) => r.type === 'create')).toEqual([])
  })

  test('a session that ended normally is a conflict', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 0)
    await waitFor(() => changedTo('exited'))
    const error = await restore(session.id).catch((e: RpcError) => e)
    expect((error as RpcError).code).toBe(RpcErrorCode.Conflict)
  })

  test('a session killed on request cannot be restored', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    await waitFor(() => changedTo('exited'))
    const error = await restore(session.id).catch((e: RpcError) => e)
    expect((error as RpcError).code).toBe(RpcErrorCode.Conflict)
  })

  test('a restorable shell starts the same shell session and clears its exit details', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, null, { exitSignal: 'SIGHUP', exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    const before = eventsOf('quirky.session/changed').length

    const restored = await restore(session.id)
    expect(restored).toMatchObject({
      id: session.id,
      status: 'running',
      agent: 'shell',
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    })
    expect(await sessionOf(session.id)).toEqual(restored)
    const [request] = restoreRequests(session.id)
    expect(request).toMatchObject({
      restore: true,
      shellReady: true,
      argv: ['/bin/zsh', '-l'],
      cwd: '/fake/alpha',
      cols: 80,
      rows: 24
    })
    expect((request as { env: Record<string, string> }).env).toMatchObject({
      QUIRKY_SESSION_ID: session.id,
      ZDOTDIR: join(h.home, 'shell', 'zsh')
    })
    await waitFor(() => eventsOf('quirky.session/changed').length > before || undefined)
    expect(eventsOf('quirky.session/changed').at(-1)).toMatchObject({ data: { session: { id: session.id, status: 'running' } } })
  })
  test('a cold agent restore refuses a missing provider identity without replacing the agent with a shell', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    h.pty.emit(session.id, 'retained history')
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))

    const error = await restore(session.id).catch((cause: RpcError) => cause)
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: expect.stringContaining('provider session') })
    expect(await sessionOf(session.id)).toMatchObject({ status: 'exited', agent: 'codex', restorable: true, providerSession: null })
    expect(restoreRequests(session.id)).toEqual([])
    expect(Buffer.from(h.pty.sessions.get(session.id)!.buffer).toString()).toContain('retained history')
  })

  test('cold restore replays the captured provider ID, launch snapshot and cwd in the same session', async () => {
    const created = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    const providerSession = { id: 'codex-provider-17', transcriptPath: '/transcripts/codex-17.jsonl' }
    await call(client, 'quirky.session/setProviderSession', { session: created.id, ...providerSession })
    const launch = { command: 'codex', args: '--model snapshot-model --effort high', env: { CODEX_HOME: '/captured/codex-home', CODEX_PROFILE: 'original' } }
    const launchSettings = {
      agent: 'codex',
      options: { model: { value: 'snapshot-model', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
      summary: 'Codex · snapshot-model · effort: high'
    }
    const db = new Database(join(h.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      db.query('UPDATE sessions SET launch = ?, launch_settings = ? WHERE id = ?').run(JSON.stringify(launch), JSON.stringify(launchSettings), created.id)
    } finally {
      db.close()
    }
    const original = await sessionOf(created.id)
    fakeAgents().args = '--dangerously-skip-permissions'
    h.pty.exit(created.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    const writesBefore = h.pty.inputs.length

    const restored = await restore(created.id)

    expect(restored).toMatchObject({
      id: created.id,
      status: 'running',
      agent: 'codex',
      restorable: false,
      providerSession,
      launch,
      launchSettings
    })
    expect(restored.cwd).toBe(original.cwd)
    const [request] = restoreRequests(created.id)
    expect(request).toMatchObject({ restore: true, cwd: original.cwd })
    expect(request?.type === 'create' ? request.argv.join(' ') : '').toContain('--model snapshot-model --effort high --resume codex-provider-17')
    expect((request as { env: Record<string, string> }).env).toMatchObject({
      QUIRKY_SESSION_ID: created.id,
      CODEX_HOME: '/captured/codex-home',
      CODEX_PROFILE: 'original'
    })
    expect(h.pty.inputs.length).toBe(writesBefore)
    expect(fakeAgents().calls.filter((entry) => entry.method === 'prepareResume').at(-1)?.params).toMatchObject({
      agent: 'codex',
      cwd: original.cwd,
      record: launch,
      providerSession,
      fork: false
    })
    expect((await call<Session[]>(client, 'quirky.session/list')).map((entry) => entry.id)).toEqual([created.id])
  })
  test('cold Codex restore re-applies provider account preparation before resolving the captured conversation', async () => {
    await h.cleanup()
    resetFakeAccountPreparation()
    h = await startPluginHarness({ ...SESSION_PLUGINS, fakes: [...SESSION_PLUGINS.fakes, 'quirky.accounts'] })
    ;({ client, events } = await h.connectWithEvents('cli'))

    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    const providerSession = { id: 'codex-account-provider', transcriptPath: null }
    h.pty.emit(session.id, 'retained history')
    await call(client, 'quirky.session/setProviderSession', { session: session.id, ...providerSession })
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    expect(Buffer.from(h.pty.sessions.get(session.id)!.buffer).toString()).toContain('retained history')
    const restored = await restore(session.id)
    const accountResume = fakeAccountPreparationCalls().find((entry) => entry.resume !== undefined)
    expect(accountResume).toMatchObject({
      agent: 'codex',
      sessionId: session.id,
      cwd: session.cwd,
      resume: { sourceSessionId: session.id, providerSession }
    })
    expect(fakeAgents().calls.find((entry) => entry.method === 'prepareResume')?.params).toMatchObject({
      agent: 'codex',
      providerSession,
      hookEnv: { CODEX_HOME: '/account/codex-home' }
    })
    const request = restoreRequests(session.id)[0]
    expect(request?.type === 'create' ? request.env.CODEX_HOME : undefined).toBe('/account/codex-home')
    expect(restored.providerSession).toEqual(providerSession)
  })


  test('an unsupported cold agent restore refuses before spawning and keeps history restorable', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'aider' })
    h.pty.emit(session.id, 'retained history')
    await call(client, 'quirky.session/setProviderSession', { session: session.id, id: 'aider-provider-session' })
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))

    const error = await restore(session.id).catch((cause: RpcError) => cause)
    expect(error).toMatchObject({ code: RpcErrorCode.Conflict, message: "aider can't resume sessions" })
    expect(await sessionOf(session.id)).toMatchObject({ status: 'exited', agent: 'aider', restorable: true })
    expect(restoreRequests(session.id)).toEqual([])
    expect(Buffer.from(h.pty.sessions.get(session.id)!.buffer).toString()).toContain('retained history')
  })

  test('concurrent cold agent restores share one provider launch and warm restores never launch again', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await call(client, 'quirky.session/setProviderSession', { session: session.id, id: 'claude-provider-18' })
    const beforeWarm = h.pty.requests.length
    const warm = await restore(session.id)
    expect(warm).toEqual(session)
    expect(h.pty.requests.slice(beforeWarm).filter((request) => request.type === 'create')).toEqual([])
    expect(fakeAgents().calls.filter((entry) => entry.method === 'prepareResume')).toEqual([])

    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    const [first, second] = await Promise.all([restore(session.id), restore(session.id)])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ id: session.id, agent: 'claude', status: 'running', providerSession: { id: 'claude-provider-18' } })
    expect(restoreRequests(session.id)).toHaveLength(1)
    expect(fakeAgents().calls.filter((entry) => entry.method === 'prepareResume')).toHaveLength(1)
    expect(h.pty.inputs.filter((input) => input.sessionId === session.id)).toEqual([])
  })


  test('two restores at once send the host one create', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    const [first, second] = await Promise.all([restore(session.id), restore(session.id)])
    expect(first).toEqual(second)
    expect(first.status).toBe('running')
    expect(restoreRequests(session.id)).toHaveLength(1)
  })

  test('a failed spawn leaves the session exited and restorable, and a retry works', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, null, { exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))

    h.pty.failRequests('create', 'no such shell')
    const error = await restore(session.id).catch((e: RpcError) => e)
    expect(error).toMatchObject({ code: expect.any(Number) })
    expect(await sessionOf(session.id)).toMatchObject({ status: 'exited', restorable: true })

    h.pty.failRequests('create', null)
    expect(await restore(session.id)).toMatchObject({ status: 'running', restorable: false })
  })

  test('an unknown session is NotFound', async () => {
    expect(await code(restore('s_nope'))).toBe(RpcErrorCode.NotFound)
  })
})

describe('a start cwd', () => {
  test('SC-23: the session and its process start in the folder given, not the worktree path', async () => {
    const dir = makeTempDir('qs-cwd-')
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', cwd: dir })
    expect(session).toMatchObject({ worktreeId: 'wt_main', cwd: dir })
    expect(spawned(session.id).cwd).toBe(dir)
    expect((await call<Session>(client, 'quirky.session/get', { session: session.id })).cwd).toBe(dir)
  })

  test('an agent process starts in the folder given', async () => {
    const dir = makeTempDir('qs-cwd-')
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', cwd: dir })
    expect(spawned(session.id).cwd).toBe(dir)
  })

  test('without cwd the worktree path is used', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(session.cwd).toBe('/fake/alpha')
  })

  test('a relative path, a missing folder and a file are invalid-params', async () => {
    const dir = makeTempDir('qs-cwd-')
    writeFileSync(join(dir, 'a-file'), 'x')
    for (const cwd of ['relative/dir', join(dir, 'missing'), join(dir, 'a-file'), '']) {
      const error = (await createSession(client, { worktree: 'id:wt_main', agent: 'shell', cwd }).catch((e: RpcError) => e)) as RpcError
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
    }
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })
})

describe('the floating worktree', () => {
  const realHome = process.env.HOME
  let home: string
  beforeEach(() => {
    home = makeTempDir('qs-home-')
    process.env.HOME = home
  })
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
  })

  const asFloating = () => QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', worktreeId: 'floating', sessionId: 's_float' })

  test('SC-55: selector floating starts a session in $HOME without asking quirky.worktree', async () => {
    const session = await createSession(client, { worktree: 'floating', agent: 'shell' })
    expect(session).toMatchObject({ kind: 'terminal', worktreeId: 'floating', cwd: home, title: 'Shell', status: 'running' })
    expect(spawned(session.id)).toMatchObject({ cwd: home })
    expect(spawned(session.id).env.QUIRKY_WORKTREE_ID).toBe('floating')
    expect(storedSessions(h.home)).toEqual([{ id: session.id, repo_id: null }])
  })

  test('the cwd param decides where a floating session starts', async () => {
    const dir = makeTempDir('qs-cwd-')
    const session = await createSession(client, { worktree: 'floating', agent: 'shell', cwd: dir })
    expect(session).toMatchObject({ worktreeId: 'floating', cwd: dir })
    expect(spawned(session.id).cwd).toBe(dir)
  })

  test('titles are numbered within the floating workspace only', async () => {
    await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const first = await createSession(client, { worktree: 'floating', agent: 'shell' })
    const second = await createSession(client, { worktree: 'floating', agent: 'shell' })
    expect([first.title, second.title]).toEqual(['Shell', 'Shell 2'])
  })

  test('an agent session can be floating', async () => {
    const claude = await createSession(client, { worktree: 'floating', agent: 'claude', prompt: 'hi' })
    expect(claude).toMatchObject({ agent: 'claude', worktreeId: 'floating', cwd: home, title: 'Claude' })
  })

  test('list with worktree floating lists the floating sessions only', async () => {
    const main = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const floating = await createSession(client, { worktree: 'floating', agent: 'shell' })
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'floating' })).map((s) => s.id)).toEqual([floating.id])
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'id:wt_main' })).map((s) => s.id)).toEqual([main.id])
    expect(await call<Session[]>(client, 'quirky.session/list')).toHaveLength(2)
  })

  test('a call from a floating session defaults to floating, with selector current or none', async () => {
    const inside = await asFloating()
    try {
      const omitted = await createSession(inside, { agent: 'shell' })
      const current = await createSession(inside, { worktree: 'current', agent: 'shell' })
      expect([omitted.worktreeId, current.worktreeId]).toEqual(['floating', 'floating'])
      expect(omitted.cwd).toBe(home)
      expect((await call<Session[]>(inside, 'quirky.session/list', { worktree: 'current' })).map((s) => s.id).sort()).toEqual(
        [omitted.id, current.id].sort()
      )
    } finally {
      inside.close()
    }
  })

  test('a call from a floating session can still name a real worktree', async () => {
    const inside = await asFloating()
    try {
      expect((await createSession(inside, { worktree: 'id:wt_other', agent: 'shell' })).worktreeId).toBe('wt_other')
    } finally {
      inside.close()
    }
  })

  test('a structured session can be registered in the floating workspace', async () => {
    const session = await call<Session>(client, 'quirky.session/register', {
      worktree: 'floating',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect(session).toMatchObject({ kind: 'structured', worktreeId: 'floating', cwd: home, title: 'Claude' })
    expect((await call<Session[]>(client, 'quirky.session/list', { worktree: 'floating' })).map((s) => s.id)).toEqual([session.id])
  })

  test('an unset HOME rejects a floating session without a cwd', async () => {
    delete process.env.HOME
    const error = (await createSession(client, { worktree: 'floating', agent: 'shell' }).catch((e: RpcError) => e)) as RpcError
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('session names', () => {
  const setName = (session: string, name: string | null) => call<Session>(client, 'quirky.session/setName', { session, name })
  const exitAndWait = async (sessionId: string) => {
    h.pty.exit(sessionId, 0)
    await waitForAsync(async () => (await sessionOf(sessionId)).status === 'exited', 5000)
  }
  const changedSessions = () =>
    events.flatMap((e) => (e.type === 'quirky.session/changed' ? [(e.data as { session: Session }).session] : []))
  const failureOf = async (promise: Promise<unknown>) => ((await promise.then(() => null, (e: RpcError) => e)) as RpcError | null)!

  test('a new session has no name', async () => {
    expect((await shellSession()).name).toBeNull()
  })

  test('SC-33: naming stores the name in lowercase, emits changed, and null clears it', async () => {
    const session = await shellSession()
    const before = changedSessions().length
    const named = await setName(session.id, 'Builder')
    expect(named).toMatchObject({ id: session.id, name: 'builder' })
    expect((await sessionOf(session.id)).name).toBe('builder')
    await waitFor(() => (changedSessions().length > before ? true : undefined))
    expect(changedSessions().at(-1)).toMatchObject({ id: session.id, name: 'builder' })

    expect((await setName(session.id, null)).name).toBeNull()
    expect((await sessionOf(session.id)).name).toBeNull()
  })

  test('naming a session with its own name changes nothing and emits nothing', async () => {
    const session = await shellSession()
    await setName(session.id, 'builder')
    await Bun.sleep(30)
    const count = changedSessions().length
    expect((await setName(session.id, 'BUILDER')).name).toBe('builder')
    await Bun.sleep(30)
    expect(changedSessions()).toHaveLength(count)
  })

  test('SC-34: a refused name leaves the session as it was', async () => {
    const session = await shellSession()
    await setName(session.id, 'keeper')
    const refused = ['', 'a'.repeat(65), 'has space', 'build/1', '-lead', 's_reviewer', 'S_Reviewer']
    for (const name of refused) {
      const error = await failureOf(setName(session.id, name))
      expect(error, name).toMatchObject({ code: RpcErrorCode.InvalidParams })
    }
    expect((await sessionOf(session.id)).name).toBe('keeper')
    expect((await setName(session.id, 'a'.repeat(64))).name).toBe('a'.repeat(64))
    expect((await setName(session.id, '0.a_b-c')).name).toBe('0.a_b-c')
  })

  test('a name that is not a string is invalid-params', async () => {
    const session = await shellSession()
    expect(await code(call(client, 'quirky.session/setName', { session: session.id, name: 7 }))).toBe(RpcErrorCode.InvalidParams)
    expect(await code(call(client, 'quirky.session/setName', { session: session.id }))).toBe(RpcErrorCode.InvalidParams)
  })

  test('SC-35: a running session keeps its name; an exited one loses it to the next session that asks', async () => {
    const a = await shellSession()
    const b = await shellSession()
    await setName(a.id, 'reviewer')

    const taken = await failureOf(setName(b.id, 'Reviewer'))
    expect(taken).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'name-taken' } })
    expect((await sessionOf(b.id)).name).toBeNull()

    await exitAndWait(a.id)
    expect((await sessionOf(a.id)).name).toBe('reviewer')
    const before = changedSessions().length
    expect((await setName(b.id, 'reviewer')).name).toBe('reviewer')
    expect((await sessionOf(a.id)).name).toBeNull()
    expect((await sessionOf(a.id)).status).toBe('exited')
    await waitFor(() => changedSessions().slice(before).find((moved) => moved.id === a.id && moved.name === null))
  })

  test('a starting session that holds a name counts as running', async () => {
    const structured = await call<Session>(client, 'quirky.session/register', {
      worktree: 'id:wt_main',
      agent: 'claude',
      kind: 'structured',
      title: 'Claude'
    })
    expect(structured.status).toBe('starting')
    await setName(structured.id, 'reviewer')
    const other = await shellSession()
    expect(await code(setName(other.id, 'reviewer'))).toBe(RpcErrorCode.Conflict)
  })

  test('SC-32: get, close and every other session parameter accept the name, in any case', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'Reviewer' })
    expect(session.name).toBe('reviewer')
    expect(await sessionOf('reviewer')).toMatchObject({ id: session.id })
    expect(await sessionOf('REVIEWER')).toMatchObject({ id: session.id })
    expect((await call<Session>(client, 'quirky.session/setStatus', { session: 'reviewer', status: 'working' })).id).toBe(session.id)
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => [s.id, s.name])).toEqual([[session.id, 'reviewer']])

    await call(client, 'quirky.session/close', { session: 'reviewer' })
    expect(await call(client, 'quirky.session/list')).toEqual([])
    expect(h.pty.requests.some((r) => r.type === 'forget' && r.sessionId === session.id)).toBe(true)
  })

  test('an argument that is neither an ID nor a name is NotFound', async () => {
    const error = await failureOf(sessionOf('nobody'))
    expect(error).toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('an ID is looked up as an ID even when a name could match', async () => {
    const a = await shellSession()
    const b = await shellSession()
    await setName(a.id, 'builder')
    expect((await sessionOf(b.id)).id).toBe(b.id)
    expect((await sessionOf(a.id)).id).toBe(a.id)
  })

  test('SC-36: an exited session still resolves by its name', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
    await exitAndWait(session.id)
    expect(await sessionOf('reviewer')).toMatchObject({ id: session.id, status: 'exited', name: 'reviewer' })
  })

  test('a name held by several records resolves to the running one, else the most recently created', async () => {
    const old = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'twin' })
    const recent = await shellSession()
    await exitAndWait(old.id)
    await exitAndWait(recent.id)
    const store = new Database(join(h.home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      store.query("UPDATE sessions SET name = 'twin' WHERE id = ?").run(recent.id)
      expect((await sessionOf('twin')).id).toBe(recent.id)
      store.query("UPDATE sessions SET status = 'running', created_at = created_at - 1000 WHERE id = ?").run(old.id)
    } finally {
      store.close()
    }
    expect((await sessionOf('twin')).id).toBe(old.id)
  })

  test('create takes a name, refuses a bad or taken one before creating anything, and moves an exited holder', async () => {
    const first = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
    const spawns = () => h.pty.requests.filter((r) => r.type === 'create').length
    const spawned = spawns()

    expect(await code(createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'bad name' }))).toBe(RpcErrorCode.InvalidParams)
    const taken = await failureOf(createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'REVIEWER' }))
    expect(taken).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'name-taken' } })
    expect(spawns()).toBe(spawned)
    expect(await call<Session[]>(client, 'quirky.session/list')).toHaveLength(1)
    expect(storedSessions(h.home)).toHaveLength(1)

    await exitAndWait(first.id)
    const second = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
    expect(second.name).toBe('reviewer')
    expect((await sessionOf(first.id)).name).toBeNull()
  })

  test('SC-35: a launch that fails leaves the exited holder named; a successful one moves the name', async () => {
    const holder = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
    await exitAndWait(holder.id)

    fakeAgents().disabled.add('claude')
    const failed = await failureOf(createSession(client, { worktree: 'id:wt_main', agent: 'claude', name: 'reviewer' }))
    expect(failed).not.toBeNull()
    expect(await sessionOf(holder.id)).toMatchObject({ status: 'exited', name: 'reviewer' })
    expect((await call<Session[]>(client, 'quirky.session/list')).map((s) => s.id)).toEqual([holder.id])
    expect((await sessionOf('reviewer')).id).toBe(holder.id)
    expect(changedSessions().at(-1)).toMatchObject({ id: holder.id, name: 'reviewer' })

    fakeAgents().disabled.delete('claude')
    const next = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', name: 'reviewer' })
    expect(next.name).toBe('reviewer')
    expect((await sessionOf(holder.id)).name).toBeNull()
  })

  test('a failed launch does not give a name back over a rename made while it was in flight', async () => {
    await h.cleanup()
    const home = makeTempHome()
    const workDir = makeTempDir()
    const marker = join(workDir, 'marker.log')
    const release = join(workDir, 'release')
    writeModulePlugin(
      join(home, 'plugins'),
      marker,
      { id: 'acme.slow', contributes: { 'launch-hook': [{ id: 'wait', agents: ['claude'] }] } },
      {
        activate: `context.provide('launch-hook:acme.slow/wait', async () => {
          record('hook waiting')
          ${waitForFile(release)}
          return { env: {}, args: [] }
        })`
      }
    )
    h = await startPluginHarness(SESSION_PLUGINS, { home })
    try {
      ;({ client, events } = await h.connectWithEvents('cli'))
      const holder = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
      await exitAndWait(holder.id)

      const creating = failureOf(createSession(client, { worktree: 'id:wt_main', agent: 'claude', name: 'reviewer' }))
      await waitFor(() => readMarker(marker).includes('hook waiting') || undefined)
      expect((await sessionOf(holder.id)).name).toBeNull()
      const starting = (await call<Session[]>(client, 'quirky.session/list')).find((s) => s.id !== holder.id)!

      await setName(holder.id, 'renamed')
      const before = changedSessions().length
      await call(client, 'quirky.session/close', { session: starting.id })
      writeFileSync(release, '')

      expect(await creating).toMatchObject({ code: RpcErrorCode.Conflict })
      expect(await sessionOf(holder.id)).toMatchObject({ status: 'exited', name: 'renamed' })
      expect(changedSessions().slice(before).filter((s) => s.id === holder.id)).toEqual([])
    } finally {
      writeFileSync(release, '')
    }
  })

  test('SC-37: names survive a daemon restart', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', name: 'reviewer' })
    const again = await restartDaemon(h)
    try {
      expect(await call<Session>(again.client, 'quirky.session/get', { session: 'reviewer' })).toMatchObject({
        id: session.id,
        name: 'reviewer'
      })
    } finally {
      await again.stop()
    }
  })
})
