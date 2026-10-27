import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, QuirkyClient, type QuirkyEvent, type RpcError, type Session } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { makeTempHome, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import {
  makeTempDir,
  readMarker,
  removeTempDirs,
  waitForFile,
  writeModulePlugin
} from '../../../packages/daemon/test/plugins/fixtures'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import { call, code, createSession, restartDaemon, SESSION_PLUGINS, startPluginHarness } from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  resetFakeAgents()
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  delete process.env.QUIRKY_TEST_VANISHED_WORKTREES
  fakeAgents().gate = null
  await h.cleanup()
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
      `${exportPath()}exec claude '--settings' '${h.home}/hooks/claude-settings.json' 'do the thing'`
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
    expect(fakeAgents().calls.find((c) => c.method === 'pick')?.params).toEqual({})

    fakeAgents().pick = 'shell'
    const shell = await createSession(client, { worktree: 'id:wt_main' })
    expect(shell).toMatchObject({ agent: 'shell', title: 'Shell', launch: null, promptDelivery: null })
    expect(spawned(shell.id).argv).toEqual(['/bin/zsh', '-l'])
    expect(fakeAgents().calls.filter((c) => c.method === 'prepareLaunch')).toHaveLength(1)
  })

  test('an agent named in the call skips pick, and a shell never reaches prepareLaunch', async () => {
    await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    const methods = fakeAgents().calls.map((c) => c.method)
    expect(methods).toEqual(['get', 'prepareLaunch'])
  })

  test('the session records what it launched with and starts with no provider session', async () => {
    fakeAgents().args = '--model haiku'
    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'hi' })
    const expected = {
      launch: { command: 'claude', args: '--model haiku', env: {} },
      providerSession: null,
      promptDelivery: 'command-line',
      resumedFrom: null
    }
    expect(claude).toMatchObject(expected)
    expect(await call(client, 'quirky.session/get', { session: claude.id })).toMatchObject(expected)
    const shell = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(shell).toMatchObject({ launch: null, providerSession: null, promptDelivery: null, resumedFrom: null })
    const bare = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' })
    expect(bare.promptDelivery).toBeNull()
  })

  test('SC-10: a disabled agent can not be launched by name and leaves no session', async () => {
    fakeAgents().disabled.add('claude')
    const error = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' }).catch((e: RpcError) => e)
    expect((error as RpcError).message).toBe('agent claude is disabled')
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('hook arguments and environment reach prepareLaunch, and its environment reaches the process', async () => {
    await createSession(client, { worktree: 'id:wt_main', agent: 'claude', prompt: 'hi' })
    const params = fakeAgents().calls.find((c) => c.method === 'prepareLaunch')!.params
    expect(params).toMatchObject({
      agent: 'claude',
      cwd: '/fake/alpha',
      prompt: 'hi',
      submitPrompt: true,
      hookArgs: ['--settings', `${h.home}/hooks/claude-settings.json`],
      hookEnv: {}
    })
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
    expect(unknown).toMatchObject({ code: RpcErrorCode.NotFound, message: 'unknown agent: vim' })
    expect(await call(client, 'quirky.session/list')).toEqual([])
  })

  test('a failed spawn leaves no record and says which agent did not start', async () => {
    h.pty.failRequests('create', 'no such shell')
    const error = await createSession(client, { worktree: 'id:wt_main', agent: 'codex' }).catch((e: RpcError) => e)
    expect((error as RpcError).code).toBe(RpcErrorCode.Internal)
    expect((error as RpcError).message).toContain('could not start codex: no such shell')
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
      `${exportPath()}exec claude '--settings' '${h.home}/hooks/claude-settings.json' 'hi'`
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
      expect(error?.message).toContain('closed before its terminal started')
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
    expect(await call<Session[]>(client, 'quirky.session/list')).toEqual([
      {
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
        restorable: false,
        launch: null,
        providerSession: null,
        promptDelivery: null,
        resumedFrom: null
      }
    ])
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
    expect((error as RpcError).message).toBe(`session ${session.id} ended normally and can't be restored`)
  })

  test('a session killed on request is a conflict that says so', async () => {
    const session = await shellSession()
    h.pty.exit(session.id, 137, { exitSignal: 'SIGKILL', exitCause: 'killed' })
    await waitFor(() => changedTo('exited'))
    const error = await restore(session.id).catch((e: RpcError) => e)
    expect((error as RpcError).code).toBe(RpcErrorCode.Conflict)
    expect((error as RpcError).message).toBe(`session ${session.id} was killed and can't be restored`)
  })

  test('a restorable session starts a shell as the same session and clears its exit details', async () => {
    const claude = await createSession(client, { worktree: 'id:wt_main', agent: 'claude' })
    h.pty.exit(claude.id, null, { exitSignal: 'SIGHUP', exitCause: 'host-restart' })
    await waitFor(() => changedTo('exited'))
    const before = eventsOf('quirky.session/changed').length

    const restored = await restore(claude.id)
    expect(restored).toMatchObject({
      id: claude.id,
      status: 'running',
      agent: 'shell',
      exitCode: null,
      exitSignal: null,
      exitCause: null,
      restorable: false
    })
    expect(await sessionOf(claude.id)).toEqual(restored)
    const [request] = restoreRequests(claude.id)
    expect(request).toMatchObject({
      restore: true,
      shellReady: true,
      argv: ['/bin/zsh', '-l'],
      cwd: '/fake/alpha',
      cols: 80,
      rows: 24
    })
    expect((request as { env: Record<string, string> }).env).toMatchObject({
      QUIRKY_SESSION_ID: claude.id,
      ZDOTDIR: join(h.home, 'shell', 'zsh')
    })
    await waitFor(() => eventsOf('quirky.session/changed').length > before || undefined)
    expect(eventsOf('quirky.session/changed').at(-1)).toMatchObject({ data: { session: { id: claude.id, status: 'running' } } })
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
    expect((error as RpcError).message).toContain('no such shell')
    expect(await sessionOf(session.id)).toMatchObject({ status: 'exited', restorable: true })

    h.pty.failRequests('create', null)
    expect(await restore(session.id)).toMatchObject({ status: 'running', restorable: false })
  })

  test('an unknown session is NotFound', async () => {
    expect(await code(restore('s_nope'))).toBe(RpcErrorCode.NotFound)
  })
})
