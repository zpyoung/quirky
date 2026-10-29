import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { QuirkyClient, type Session, type WorkspaceSleepState } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { PtyClient } from '../../../packages/daemon/src/pty-client'
import { startDaemon, type DaemonHandle } from '../../../packages/daemon/src/daemon'
import { makeTempHome, waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { fakeAgents, resetFakeAgents } from './fakes/quirky.agents/main'
import { call, createSession, makeBuiltinDir, SESSION_PLUGINS } from './support'
import { setWorktreeOverride } from './fakes/quirky.worktree/main'

const PTY_ENTRY = join(import.meta.dir, '../../../packages/pty-host/src/main.ts')
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

function commandWithHistoryScrollback(marker: string, continuation: string): string {
  const script = `printf '%s\\n' ${quote(marker)}; i=0; while [ "$i" -lt 32 ]; do printf 'WORKSPACE_SLEEP_SCROLLBACK_FILLER\\n'; i=$((i + 1)); done; ${continuation}`
  return `sh -c ${quote(script)}`
}

let home: string
let daemon: DaemonHandle | null
let client: QuirkyClient | null
let pty: PtyClient | null

async function startRealDaemon(): Promise<void> {
  daemon = await startDaemon({
    home,
    port: 0,
    shell: '/bin/zsh',
    notifier: () => {},
    cliEntry: '/opt/quirky/cli/main.ts',
    uiDir: join(home, 'no-ui'),
    builtinPluginsDir: makeBuiltinDir(home, SESSION_PLUGINS),
    ptyHostEntry: PTY_ENTRY
  })
  client = await QuirkyClient.connect(rpcUrl(daemon.runtime), { role: 'cli' })
  if (pty === null) {
    pty = new PtyClient({ home })
    await pty.connect()
  }
}

function writeExecutable(name: string, body: string): string {
  const path = join(home, 'bin', name)
  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function history(sessionId: string): Promise<string> {
  const page = await pty!.request('history', { sessionId, lines: 100 })
  return page.lines.join('\n')
}

beforeEach(async () => {
  resetFakeAgents()
  setWorktreeOverride('wt_main', null)
  home = makeTempHome('qsl-')
  daemon = null
  client = null
  pty = null
  await startRealDaemon()
})

afterEach(async () => {
  client?.close()
  setWorktreeOverride('wt_main', null)
  if (daemon) await daemon.stop()
  if (pty) {
    await pty.request('shutdown', {}).catch(() => {})
    pty.close()
  }
  rmSync(home, { recursive: true, force: true })
})

describe('workspace sleep and wake', () => {
  test('retains shell history and stops descendants across daemon restart; sleep and wake are idempotent', async () => {
    const pidFile = join(home, 'sleep-child.pid')
    const shell = await createSession(client!, {
      worktree: 'floating',
      agent: 'shell',
      cwd: home,
      command: commandWithHistoryScrollback('SLEEP_HISTORY_MARKER', `(exec sleep 600) & echo $! > ${quote(pidFile)}; wait`)
    })
    await waitFor(() => existsSync(pidFile), 5000)
    await waitForAsync(async () => (await history(shell.id)).includes('SLEEP_HISTORY_MARKER'), 5000)
    const childPid = Number(await Bun.file(pidFile).text())

    const asleep = await call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    expect(asleep).toMatchObject({ worktreeId: 'floating', state: 'asleep', sessions: [{ sessionId: shell.id, state: 'stopped', error: null }] })
    expect(isAlive(childPid)).toBe(false)
    expect(await history(shell.id)).toContain('SLEEP_HISTORY_MARKER')
    expect(await pty!.request('list', {})).toContainEqual(expect.objectContaining({ sessionId: shell.id, state: 'restorable', alive: false }))

    client!.close()
    await daemon!.stop()
    daemon = null
    client = null
    await startRealDaemon()

    const afterRestart = await call<WorkspaceSleepState[]>(client!, 'quirky.session/workspaceSleepStates', {})
    expect(afterRestart).toContainEqual(expect.objectContaining({ worktreeId: 'floating', state: 'asleep' }))
    expect(await history(shell.id)).toContain('SLEEP_HISTORY_MARKER')
    const awake = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })
    expect(awake).toMatchObject({ worktreeId: 'floating', state: 'awake', sessions: [{ sessionId: shell.id, state: 'restored', error: null }] })
    expect(await history(shell.id)).toContain('SLEEP_HISTORY_MARKER')
    expect((await call(client!, 'quirky.session/list', { worktree: 'floating' })).filter((entry: { status: string }) => entry.status !== 'exited')).toHaveLength(1)
    expect(await call(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })).toEqual(awake)

    const sleptAgain = await call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    expect(sleptAgain.state).toBe('asleep')
    expect(await call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })).toEqual(sleptAgain)
  })

  test('resumes an agent with its stored provider conversation identity', async () => {
    const pidFile = join(home, 'claude.pid')
    writeExecutable('claude', `echo "$$" > '${pidFile}'; exec sleep 600`)
    const agent = await createSession(client!, { worktree: 'floating', agent: 'claude', cwd: home })
    await waitFor(() => existsSync(pidFile), 5000)
    await call(client!, 'quirky.session/setProviderSession', { session: agent.id, id: 'provider-thread-42' })

    await call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    const awake = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })

    expect(awake.state).toBe('awake')
    expect(fakeAgents().calls.findLast((entry) => entry.method === 'prepareResume')?.params.providerSession).toEqual({
      id: 'provider-thread-42',
      transcriptPath: null
    })
    const resumed = (await call(client!, 'quirky.session/list', { worktree: 'floating' })).find((entry: { resumedFrom: string | null }) => entry.resumedFrom === agent.id)
    expect(resumed).toMatchObject({ agent: 'claude', resumedFrom: agent.id, providerSession: { id: 'provider-thread-42' } })
  })

  test('normal structured resume propagates its provider identity while using workspace admission', async () => {
    const original = (await call(client!, 'quirky.structured/pointerSession', {
      worktree: 'floating',
      cwd: home,
      status: 'running'
    })) as Session
    await call(client!, 'quirky.session/setProviderSession', {
      session: original.id,
      id: 'structured-thread-ordinary',
    })

    const resumed = await call<Session>(client!, 'quirky.session/resume', { session: original.id })

    expect(resumed).toMatchObject({
      kind: 'structured',
      resumedFrom: original.id,
      providerSession: { id: 'structured-thread-ordinary', transcriptPath: null }
    })
    const listed = (await call<Session[]>(client!, 'quirky.session/list', { worktree: 'floating' })).find(
      (session) => session.resumedFrom === original.id
    )
    expect(listed).toMatchObject({ providerSession: { id: 'structured-thread-ordinary' } })
  })

  test('workspace wake admits the structured provider update without deadlocking', async () => {
    const original = (await call(client!, 'quirky.structured/pointerSession', {
      worktree: 'floating',
      cwd: home,
      status: 'running'
    })) as Session
    await call(client!, 'quirky.session/setProviderSession', {
      session: original.id,
      id: 'structured-thread-wake',
    })
    await call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })

    const awake = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })

    expect(awake).toMatchObject({ state: 'awake', sessions: [{ sessionId: original.id, state: 'restored' }] })
    const resumed = (await call<Session[]>(client!, 'quirky.session/list', { worktree: 'floating' })).find(
      (session) => session.resumedFrom === original.id
    )
    expect(resumed).toMatchObject({ providerSession: { id: 'structured-thread-wake', transcriptPath: null } })
  })

  test('rejects a nonresumable live agent before changing its process or workspace state', async () => {
    const pidFile = join(home, 'aider.pid')
    writeExecutable('aider', `echo "$$" > '${pidFile}'; exec sleep 600`)
    const session = await createSession(client!, { worktree: 'floating', agent: 'aider', cwd: home })
    await waitFor(() => existsSync(pidFile), 5000)
    const pid = Number(await Bun.file(pidFile).text())

    await expect(call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })).rejects.toMatchObject({ code: expect.any(Number) })

    expect(isAlive(pid)).toBe(true)
    expect(await call(client!, 'quirky.session/workspaceSleepStates', {})).toEqual([])
    expect((await call(client!, 'quirky.session/get', { session: session.id })).status).toBe('running')
  })


  test('does not wake an old session into a replacement worktree at the same path', async () => {
    const checkout = join(home, 'checkout')
    const pidFile = join(home, 'old-worktree.pid')
    mkdirSync(checkout)
    setWorktreeOverride('wt_main', { path: checkout, instanceId: 'instance:wt_main-original' })
    const old = await createSession(client!, {
      worktree: 'id:wt_main',
      cwd: checkout,
      agent: 'shell',
      command: commandWithHistoryScrollback('OLD_WORKTREE_HISTORY', `echo "$$" > ${quote(pidFile)}; exec sleep 600`)
    })
    await waitFor(() => existsSync(pidFile), 5000)
    await waitForAsync(async () => (await history(old.id)).includes('OLD_WORKTREE_HISTORY'), 5000)
    const oldPid = Number(await Bun.file(pidFile).text())
    expect((await call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'id:wt_main' })).state).toBe('asleep')
    expect(isAlive(oldPid)).toBe(false)

    rmSync(checkout, { recursive: true, force: true })
    mkdirSync(checkout)
    setWorktreeOverride('wt_main', { path: checkout, instanceId: 'instance:wt_main-replacement' })
    const projected = await call<WorkspaceSleepState[]>(client!, 'quirky.session/workspaceSleepStates', {})
    expect(projected).toContainEqual(
      expect.objectContaining({
        worktreeId: 'wt_main',
        state: 'partial',
        sessions: [expect.objectContaining({ sessionId: old.id, error: expect.stringContaining('instance') })]
      })
    )

    const wake = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'id:wt_main' })
    expect(wake).toMatchObject({ state: 'partial', sessions: [{ sessionId: old.id, state: 'stopped' }] })
    expect(await pty!.request('list', {})).toContainEqual(
      expect.objectContaining({ sessionId: old.id, state: 'restorable', alive: false })
    )
    expect(await history(old.id)).toContain('OLD_WORKTREE_HISTORY')

    const fresh = await createSession(client!, {
      worktree: 'id:wt_main',
      cwd: checkout,
      agent: 'shell',
      command: 'exec sleep 600'
    })
    expect(fresh.status).toBe('running')
    expect(fresh.id).not.toBe(old.id)
  })
  test('retains a partial stop and retries the live session without losing history', async () => {
    const pidFile = join(home, 'partial-stop.pid')
    const first = await createSession(client!, { worktree: 'floating', agent: 'shell', cwd: home, command: 'exec sleep 600' })
    const second = await createSession(client!, {
      worktree: 'floating',
      cwd: home,
      agent: 'shell',
      command: commandWithHistoryScrollback('PARTIAL_STOP_HISTORY', `echo "$$" > ${quote(pidFile)}; exec sleep 600`)
    })
    await waitFor(() => existsSync(pidFile), 5000)
    await waitForAsync(async () => (await history(second.id)).includes('PARTIAL_STOP_HISTORY'), 5000)
    const childPid = Number(await Bun.file(pidFile).text())
    // Narrow the generic wire method only for this one transport fault; all other requests delegate unchanged.
    const originalRequest = PtyClient.prototype.request
    const callOriginal = originalRequest as unknown as (
      this: PtyClient,
      type: string,
      params: object,
      options?: object
    ) => Promise<unknown>
    let failStop = true
    PtyClient.prototype.request = (function (this: PtyClient, type: string, params: object, options?: object) {
      const requestSessionId =
        typeof params === 'object' && params !== null && 'sessionId' in params ? params.sessionId : null
      if (failStop && type === 'stopWithHistory' && requestSessionId === second.id) {
        failStop = false
        return Promise.reject(new Error('simulated PTY stop transport failure'))
      }
      return callOriginal.call(this, type, params, options)
    }) as typeof originalRequest
    try {
      const partial = await call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
      expect(partial).toMatchObject({
        state: 'partial',
        sessions: [
          { sessionId: first.id, state: 'stopped', error: null },
          { sessionId: second.id, state: 'pending', error: 'simulated PTY stop transport failure' }
        ]
      })
      expect(isAlive(childPid)).toBe(true)

      const retried = await call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
      expect(retried).toMatchObject({
        state: 'asleep',
        sessions: [
          { sessionId: first.id, state: 'stopped' },
          { sessionId: second.id, state: 'stopped' }
        ]
      })
      expect(isAlive(childPid)).toBe(false)
      expect(await history(second.id)).toContain('PARTIAL_STOP_HISTORY')
    } finally {
      PtyClient.prototype.request = originalRequest
    }
  })

  test('retains a partial wake error and retries with the original provider identity', async () => {
    const cwd = join(home, 'agent-cwd')
    mkdirSync(cwd)
    writeExecutable('claude', 'exec sleep 600')
    const agent = await createSession(client!, { worktree: 'floating', agent: 'claude', cwd })
    await call(client!, 'quirky.session/setProviderSession', { session: agent.id, id: 'provider-retry-9' })
    await call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    rmSync(cwd, { recursive: true, force: true })

    const failedWake = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })
    expect(failedWake).toMatchObject({ state: 'partial', sessions: [{ sessionId: agent.id, state: 'stopped', error: expect.stringContaining('folder') }] })
    mkdirSync(cwd)
    const retried = await call<WorkspaceSleepState>(client!, 'quirky.session/wakeWorkspace', { worktree: 'floating' })

    expect(retried).toMatchObject({ state: 'awake', sessions: [{ sessionId: agent.id, state: 'restored', error: null }] })
    const resumed = (await call<Session[]>(client!, 'quirky.session/list', { worktree: 'floating' }))
      .find((session) => session.resumedFrom === agent.id && session.status !== 'exited')
    expect(resumed?.providerSession?.id).toBe('provider-retry-9')
  })


  test('reconciles interrupted sleeping and waking records to actionable partial states after restart', async () => {
    await call(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    const db = new Database(join(home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      db.query('UPDATE workspace_sleep SET state = ? WHERE worktree_id = ?').run('sleeping', 'floating')
    } finally {
      db.close()
    }

    client!.close()
    await daemon!.stop()
    client = null
    daemon = null
    await startRealDaemon()
    expect(await call(client!, 'quirky.session/workspaceSleepStates', {})).toContainEqual(
      expect.objectContaining({ worktreeId: 'floating', state: 'partial' })
    )

    const reopened = new Database(join(home, 'plugin-data', 'quirky.session', 'store.db'))
    try {
      reopened.query('UPDATE workspace_sleep SET state = ? WHERE worktree_id = ?').run('waking', 'floating')
    } finally {
      reopened.close()
    }
    client!.close()
    await daemon!.stop()
    client = null
    daemon = null
    await startRealDaemon()
    expect(await call(client!, 'quirky.session/workspaceSleepStates', {})).toContainEqual(
      expect.objectContaining({ worktreeId: 'floating', state: 'partial' })
    )
  })
  test('serializes a concurrent create with sleep so no live session is omitted', async () => {
    const creation = createSession(client!, { worktree: 'floating', agent: 'shell', cwd: home, command: 'exec sleep 600' }).then(
      (session) => ({ session, error: null }),
      (error) => ({ session: null, error })
    )
    const sleeping = call<WorkspaceSleepState>(client!, 'quirky.session/sleepWorkspace', { worktree: 'floating' })
    const [created, state] = await Promise.all([creation, sleeping])
    const active = (await call(client!, 'quirky.session/list', { worktree: 'floating' })).filter((session: { status: string }) => session.status !== 'exited')

    expect(active).toHaveLength(0)
    if (created.session) expect(state.sessions.map(({ sessionId }) => sessionId)).toContain(created.session.id)
    else expect(created.error).toMatchObject({ code: expect.any(Number) })
  })
})
