import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, QuirkyClient, type QuirkyEvent, type Session } from '@quirky/protocol'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { call, code, createSession, SESSION_PLUGINS, startPluginHarness } from './support'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  h = await startPluginHarness(SESSION_PLUGINS)
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(async () => {
  await h.cleanup()
  removeTempDirs()
})

function spawned(sessionId: string) {
  const request = h.pty.requests.find((r) => r.type === 'create' && r.sessionId === sessionId)
  if (!request || request.type !== 'create') throw new Error('no create request')
  return request
}

describe('quirky.session/create title', () => {
  test('uses the given title and numbers a repeat like the default titles', async () => {
    const first = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', title: 'Setup' })
    const second = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', title: 'Setup' })
    expect([first.title, second.title]).toEqual(['Setup', 'Setup 2'])
  })

  test('without a title the agent default still applies', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
    expect(session.title).toBe('Shell')
  })
})

describe('quirky.session/create command', () => {
  test('spawns the command under the login shell instead of an interactive shell', async () => {
    const session = await createSession(client, {
      worktree: 'id:wt_main',
      agent: 'shell',
      command: "echo 'hi there'; exit 4"
    })
    const request = spawned(session.id)
    expect(request.argv.slice(0, 3)).toEqual(['/bin/zsh', '-l', '-c'])
    expect(request.argv[3]).toBe(`export PATH="${h.home}/bin:$PATH"; exec echo 'hi there'; exit 4`)
    expect(request.cwd).toBe('/fake/alpha')
    expect(session).toMatchObject({ kind: 'terminal', agent: 'shell', status: 'running' })
  })

  test('the session exits with the exit code the PTY host reports', async () => {
    const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell', command: 'true' })
    h.pty.exit(session.id, 5)
    await waitFor(() =>
      events.find(
        (e) =>
          e.type === 'quirky.session/changed' &&
          (e.data as { session: Session }).session.id === session.id &&
          (e.data as { session: Session }).session.status === 'exited'
      )
    )
    expect(await call<Session>(client, 'quirky.session/get', { session: session.id })).toMatchObject({
      status: 'exited',
      exitCode: 5
    })
  })

  test('is rejected for a non-shell agent before any record is created', async () => {
    expect(
      await code(createSession(client, { worktree: 'id:wt_main', agent: 'claude', command: 'ls' }))
    ).toBe(RpcErrorCode.InvalidParams)
    expect(await call<Session[]>(client, 'quirky.session/list')).toEqual([])
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
  })
})
