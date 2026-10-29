import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type RpcError } from '@quirky/protocol'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { startLoopRig, loopConfig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

function createLoop(workspace: LoopRig, body: string, config = loopConfig(body), extra: Record<string, unknown> = {}) {
  return workspace.call<any>('quirky.loops/create', {
    worktreeId: workspace.worktree.id,
    agent: 'claude',
    config,
    ...extra
  })
}

function deferred() {
  return Promise.withResolvers<void>()
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the public loop API call to reject')
}

describe('quirky.loops public API', () => {
  test('L01: checked work completes independently and survives the creating client call', async () => {
    rig = await startLoopRig({
      script: ({ session }) => {
        writeFileSync(join(session.cwd, 'result.txt'), 'verified\n')
        return 'LOOP_DONE'
      }
    })
    const focusBefore = await rig.call<Record<string, unknown>>('ui.state')
    const created = await createLoop(rig, 'Create result.txt', loopConfig('Create result.txt', {
      done: { check: { command: 'test -f result.txt', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      caps: { maxIterations: 3 }
    }))

    expect(created).toMatchObject({ state: 'running', agent: 'claude', worktreeId: rig.worktree.id })
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    expect(completed.iterationsCompleted).toBe(1)
    expect(typeof completed.sessionId).toBe('string')
    expect(existsSync(completed.notesPath)).toBe(true)
    expect(readFileSync(join(rig.cwd, 'result.txt'), 'utf8')).toBe('verified\n')
    expect(await rig.call<Record<string, unknown>>('ui.state')).toEqual(focusBefore)
    expect((await rig.call<any[]>('quirky.loops/list', {})).map((item) => item.id)).toContain(created.id)
    expect((await rig.call<any>('quirky.loops/get', { loopId: created.id })).state).toBe('completed')
    expect(await rig.call<any[]>('quirky.loops/iterations', { loopId: created.id })).toHaveLength(1)
    expect(rig.harness.pty.requests.some((request) => request.type === 'create')).toBe(false)
    expect(rig.events.some((event) => event.type === 'quirky.loops/changed')).toBe(true)
  })

  test('L11: LOOP_DONE without independent evidence does not complete', async () => {
    rig = await startLoopRig({ script: () => 'LOOP_DONE' })
    const created = await createLoop(rig, 'Finish without proof', loopConfig('Finish without proof', { caps: { maxIterations: 1 } }))
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('cap-iterations')
    expect(paused.iterationsCompleted).toBe(1)
  })

  test('L02: unsupported providers, presets and unsafe config are rejected before a runner starts', async () => {
    rig = await startLoopRig()
    const config = loopConfig('valid prompt')
    const cases = [
      { worktreeId: rig.worktree.id, agent: 'shell', config },
      { worktreeId: rig.worktree.id, agent: 'claude', config: loopConfig('  ') },
      { worktreeId: rig.worktree.id, agent: 'claude', config: loopConfig('x', { caps: { maxIterations: 0 } }) },
      { worktreeId: rig.worktree.id, agent: 'claude', config: loopConfig('x', { done: { check: { command: 'true', timeoutSeconds: 601, runWhen: 'every-iteration' } } }) },
      { worktreeId: rig.worktree.id, agent: 'claude', preset: 'interval', config }
    ]
    for (const input of cases) {
      expect((await failure(rig.call('quirky.loops/create', input))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect(rig.starts).toHaveLength(0)
    expect(rig.sends).toHaveLength(0)
  })

  test('L03: a second loop may share a worktree and reports the concurrent-loop warning', async () => {
    const hold = deferred()
    rig = await startLoopRig({ script: async () => { await hold.promise; return 'iteration finished' }, onStop: () => hold.resolve() })
    const config = loopConfig('work safely', { caps: { maxIterations: 4 }, askBeforeNext: true })
    const first = await createLoop(rig, 'work safely', config, { name: 'first' })
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    const second = await createLoop(rig, 'work safely', config, { name: 'second' })
    expect(second.warnings).toContain('worktree-has-running-loop')
    await waitFor(() => rig!.sends.length >= 2 || undefined, 10_000)
    hold.resolve()
    const firstPaused = await rig.waitForLoop(first.id, (snapshot) => snapshot.state === 'paused')
    const secondPaused = await rig.waitForLoop(second.id, (snapshot) => snapshot.state === 'paused')
    expect(firstPaused.pauseReason).toBe('ask-before-next')
    expect(secondPaused.pauseReason).toBe('ask-before-next')
  })

  test('L04: fresh retries use distinct sessions and carry failed check output forward', async () => {
    rig = await startLoopRig()
    const created = await createLoop(rig, 'repeat with fresh sessions', loopConfig('repeat with fresh sessions', {
      done: { check: { command: 'printf check-hint; exit 1', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      caps: { maxIterations: 2 },
      sessionPolicy: 'fresh'
    }))
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('cap-iterations')
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends[0]?.text).toContain('iteration 1 of 2')
    expect(rig.sends[1]?.text).toContain('iteration 2 of 2')
    expect(rig.sends[1]?.text).toContain('check-hint')
    expect(new Set(rig.sends.map((send) => send.sessionId)).size).toBe(2)
  })

  test('L04: continue policy reuses the same structured session', async () => {
    rig = await startLoopRig()
    const created = await createLoop(rig, 'continue in one session', loopConfig('continue in one session', {
      sessionPolicy: 'continue',
      caps: { maxIterations: 2 }
    }))
    await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends[0]?.sessionId).toBe(rig.sends[1]?.sessionId)
  })

  test('L06: approval asks move a loop to needs-you and answering resumes observation', async () => {
    let turns = 0
    rig = await startLoopRig({
      script: ({ context, session }) => {
        turns += 1
        if (turns > 1) return 'LOOP_BLOCKED: finished after approval'
        const waiting = context.createAsk?.({
          questions: [{ id: 'go', type: 'confirm', question: 'Continue the loop?' }]
        }, session.id)
        if (!waiting) throw new Error('the structured runner did not expose ask creation')
        void waiting.then(() => context.setStatus(session.id, 'done')).catch(() => {})
        return { text: 'Waiting for the approval', status: 'waiting' }
      }
    })
    const loop = await createLoop(rig, 'approval loop', loopConfig('continue after approval', { caps: { maxIterations: 3 } }))
    const needsYou = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'needs-you')
    expect(needsYou.iterationsCompleted).toBe(0)
    const asks = await rig.call<any[]>('quirky.ask/list', { pendingOnly: true })
    const ask = asks.find((candidate) => candidate.sessionId === needsYou.sessionId)
    expect(ask).toBeDefined()
    expect(ask?.envelope.status).toBe('pending')

    await rig.call('quirky.ask/answer', { askId: ask!.id, answers: { go: { value: true, source: 'input' } } })
    const paused = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('agent-blocked')
    expect(paused.iterationsCompleted).toBe(2)
    const history = await rig.call<any[]>('quirky.loops/iterations', { loopId: loop.id })
    expect(history.map(({ n, endReason }) => ({ n, endReason }))).toEqual([
      { n: 1, endReason: 'settled' },
      { n: 2, endReason: 'settled' }
    ])
  })

  test('L08: pause waits for the current iteration and stop-now does not count an aborted turn', async () => {
    const hold = deferred()
    rig = await startLoopRig({ script: async () => { await hold.promise; return 'iteration finished' }, onStop: () => hold.resolve() })
    const loop = await createLoop(rig, 'pause after this', loopConfig('pause after this', { caps: { maxIterations: 4 } }))
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    await rig.call('quirky.loops/pause', { loopId: loop.id, mode: 'after-iteration' })
    hold.resolve()
    const paused = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('user')
    expect(paused.iterationsCompleted).toBe(1)
    expect((await rig.call<any>('quirky.loops/stop', { loopId: loop.id, mode: 'after-iteration' })).state).toBe('stopped')
    expect((await failure(rig.call('quirky.loops/resume', { loopId: loop.id }))).code).toBe(RpcErrorCode.Conflict)
  })

  test('L08: stop-now interrupts the owned structured session without completing an iteration', async () => {
    const hold = deferred()
    let runnerStopped = false
    rig = await startLoopRig({
      script: async () => { await hold.promise; return 'must not settle' },
      onStop: () => { runnerStopped = true; hold.resolve() }
    })
    const loop = await createLoop(rig, 'stop now', loopConfig('stop now', { caps: { maxIterations: 4 } }))
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    const ownedSessionId = rig.sends[0]!.sessionId
    const stopped = await rig.call<any>('quirky.loops/stop', { loopId: loop.id, mode: 'now' })
    expect(stopped.state).toBe('stopped')
    expect(stopped.iterationsCompleted).toBe(0)
    const ownedState = await waitForAsync(async () => {
      try {
        const current = await rig!.call<any>('quirky.session/get', { session: ownedSessionId })
        return current.status === 'exited' ? 'exited' : undefined
      } catch (error) {
        if ((error as RpcError).code === RpcErrorCode.NotFound) return 'removed'
        throw error
      }
    }, 10_000)
    expect(['exited', 'removed']).toContain(ownedState)
    expect(runnerStopped).toBe(true)
    expect(rig.sends).toHaveLength(1)
  })

  test('L09: steering, config edits and added iterations apply to the next send', async () => {
    rig = await startLoopRig({
      script: ({ session, text }) => {
        if (text.includes('updated prompt')) writeFileSync(join(session.cwd, 'done.txt'), 'ready\n')
        return 'iteration finished'
      }
    })
    const loop = await createLoop(rig, 'old prompt', loopConfig('old prompt', {
      done: { check: { command: 'false', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      caps: { maxIterations: 1 }
    }))
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    await rig.call('quirky.loops/steer', { loopId: loop.id, text: 'Use banana in the change.' })
    await rig.call('quirky.loops/edit', {
      loopId: loop.id,
      patch: {
        promptSource: { kind: 'repeat', body: 'updated prompt' },
        done: { check: { command: 'test -f done.txt', timeoutSeconds: 5, runWhen: 'every-iteration' } }
      }
    })
    await rig.call('quirky.loops/resume', { loopId: loop.id, addIterations: 1 })
    const completed = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'completed')
    expect(completed.config.caps.maxIterations).toBe(2)
    expect(rig.sends[1]?.text).toContain('updated prompt')
    expect(rig.sends[1]?.text.match(/Use banana in the change\./g)).toHaveLength(1)
    expect((await rig.call<any[]>('quirky.loops/iterations', { loopId: loop.id })).length).toBe(2)
  })

  test('L10: daemon restart pauses an in-flight attempt and preserves its history until explicit resume', async () => {
    const hold = deferred()
    rig = await startLoopRig({
      script: async () => { await hold.promise; return 'interrupted attempt' },
      onStop: () => hold.resolve()
    })
    const loop = await createLoop(rig, 'survive restart', loopConfig('survive restart', {
      sessionPolicy: 'continue',
      caps: { maxIterations: 3 }
    }))
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    await rig.restart()
    const paused = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('interrupted-by-restart')
    expect((await rig.call<any[]>('quirky.loops/iterations', { loopId: loop.id })).at(-1)?.endReason).toBe('interrupted')
    const sendsAtRestart = rig.sends.length
    // The default driver poll is one second; allow one full poll to prove no restart auto-resume.
    await Bun.sleep(1200)
    expect(rig.sends).toHaveLength(sendsAtRestart)
    expect(rig.harness.notifications.filter((notification) => notification.title.startsWith('Loop '))).toHaveLength(0)
    await rig.call('quirky.loops/resume', { loopId: loop.id })
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.iterationsCompleted >= 1 || snapshot.state === 'paused')
    expect(rig.sends.length).toBeGreaterThan(sendsAtRestart)
  })

  test('newer plugin store schemas remain readable but reject loop mutations without recovery writes', async () => {
    rig = await startLoopRig()
    const loop = await createLoop(rig, 'hold at the cap', loopConfig('hold at the cap', { caps: { maxIterations: 1 } }))
    const paused = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    const details = await rig.call<any[]>('quirky.loops/iterations', { loopId: loop.id })
    const notesBefore = readFileSync(paused.notesPath, 'utf8')
    const notesMtime = statSync(paused.notesPath).mtimeMs
    const updatedAt = paused.updatedAt

    await rig.restart(() => {
      const database = new Database(join(rig!.home, 'plugin-data', 'quirky.loops', 'store.db'))
      try {
        database.exec('PRAGMA user_version = 9000')
      } finally {
        database.close()
      }
    })
    expect((await rig.call<any[]>('quirky.loops/list', {}))[0].id).toBe(loop.id)
    expect((await rig.call<any>('quirky.loops/get', { loopId: loop.id })).updatedAt).toBe(updatedAt)
    expect(await rig.call<any[]>('quirky.loops/iterations', { loopId: loop.id })).toEqual(details)
    expect((await rig.call<any>('quirky.loops/get', { loopId: loop.id })).state).toBe('paused')
    expect((await failure(rig.call('quirky.loops/edit', { loopId: loop.id, patch: { name: 'cannot change' } }))).code).not.toBe(RpcErrorCode.NotFound)
    expect((await failure(rig.call('quirky.loops/resume', { loopId: loop.id }))).code).not.toBe(RpcErrorCode.NotFound)
    expect((await failure(createLoop(rig, 'cannot start'))).code).not.toBe(RpcErrorCode.NotFound)
    expect(readFileSync(paused.notesPath, 'utf8')).toBe(notesBefore)
    expect(statSync(paused.notesPath).mtimeMs).toBe(notesMtime)
    expect(rig.sends).toHaveLength(1)
  })
  test('disabling the loops plugin stops only its owned structured session', async () => {
    const hold = deferred()
    let runnerStopped = false
    rig = await startLoopRig({
      script: async () => { await hold.promise; return 'must not continue' },
      onStop: () => { runnerStopped = true; hold.resolve() }
    })
    const unrelated = await rig.call<any>('quirky.structured/create', { agent: 'claude', prompt: '' })
    await createLoop(rig, 'remain daemon-owned until disable', loopConfig('remain daemon-owned until disable', { caps: { maxIterations: 4 } }))
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    const ownedSessionId = rig.sends[0]!.sessionId

    await rig.call('plugin.disable', { id: 'quirky.loops' })
    const ownedState = await waitForAsync(async () => {
      try {
        const current = await rig!.call<any>('quirky.session/get', { session: ownedSessionId })
        return current.status === 'exited' ? 'exited' : undefined
      } catch (error) {
        if ((error as RpcError).code === RpcErrorCode.NotFound) return 'removed'
        throw error
      }
    }, 10_000)
    expect(['exited', 'removed']).toContain(ownedState)
    expect(runnerStopped).toBe(true)
    expect((await rig.call<any>('quirky.session/get', { session: unrelated.id })).status).toBe('running')
    const sendsAtDisable = rig.sends.length
    // One default driver poll proves the disabled owner cannot submit another iteration.
    await Bun.sleep(1200)
    expect(rig.sends).toHaveLength(sendsAtDisable)
  })

})
