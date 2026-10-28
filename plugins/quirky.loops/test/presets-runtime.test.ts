import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from '../../../packages/daemon/test/helpers'
import type { IterationDetail, LoopConfig, LoopSnapshot, QueueOperation } from '../src/types'
import { startLoopRig, loopConfig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

function configForQueue(repeatQueue: boolean, patch: Partial<LoopConfig> = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...loopConfig('unused queue body', {
      ...patch,
      promptSource: { kind: 'queue', repeatQueue },
    }),
  }
  if (patch.sessionPolicy === undefined) delete config.sessionPolicy
  return config
}

function configForInterval(
  body: string,
  minutes: number,
  anchor: 'from-end' | 'wall-clock',
  patch: Partial<LoopConfig> = {}
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...loopConfig(body, {
      ...patch,
      pacing: { kind: 'interval', minutes, anchor },
    }),
  }
  if (patch.sessionPolicy === undefined) delete config.sessionPolicy
  return config
}

async function createLoop(
  workspace: LoopRig,
  preset: 'queue' | 'interval',
  config: Record<string, unknown>,
  queueItems?: { body: string }[]
): Promise<LoopSnapshot> {
  return workspace.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: workspace.worktree.id,
    agent: 'claude',
    preset,
    config,
    ...(queueItems === undefined ? {} : { queueItems }),
  })
}

function queueOperation(workspace: LoopRig, loopId: string, op: QueueOperation): Promise<LoopSnapshot> {
  return workspace.call<LoopSnapshot>('quirky.loops/queue', { loopId, op })
}

function hasRpcCode(error: unknown): error is { code: number } {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number'
}

async function failure(promise: Promise<unknown>): Promise<{ code: number }> {
  try {
    await promise
  } catch (error) {
    if (hasRpcCode(error)) return { code: error.code }
    throw error
  }
  throw new Error('expected the public loop API call to reject')
}

async function waitForSends(workspace: LoopRig, count: number, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => (workspace.sends.length >= count ? true : undefined), timeoutMs)
}

function latestAttempt(workspace: LoopRig, loopId: string): Promise<IterationDetail[]> {
  return workspace.call<IterationDetail[]>('quirky.loops/iterations', { loopId })
}

describe('queue preset runtime API', () => {
  test('P01: queue creation continues by default and completes after each item is delivered once', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(rig, 'queue', configForQueue(false), [{ body: 'task A' }, { body: 'task B' }])

    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    const items = completed.queueItems
    const attempts = await latestAttempt(rig, created.id)

    expect(created.config.sessionPolicy).toBe('continue')
    expect(completed.iterationsCompleted).toBe(2)
    expect(items.map(({ body, position, state }) => ({ body, position, state }))).toEqual([
      { body: 'task A', position: 0, state: 'done' },
      { body: 'task B', position: 1, state: 'done' },
    ])
    expect(attempts.map(({ n }) => n)).toEqual([1, 2])
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['task A', 'task B'])
    expect(new Set(rig.sends.map(({ sessionId }) => sessionId)).size).toBe(1)
  }, 30_000)

  test('P03: paused queue mutations retain identities and apply final positions before the next send', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { askBeforeNext: true }),
      [{ body: 'A' }, { body: 'B' }, { body: 'C' }]
    )
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('ask-before-next')
    const [a, b, c] = paused.queueItems
    expect([a?.state, b?.state, c?.state]).toEqual(['done', 'pending', 'pending'])

    await queueOperation(rig, created.id, { kind: 'add', body: 'D', position: 1 })
    const inserted = await rig.snapshot(created.id)
    const d = inserted.queueItems.find((item) => item.body === 'D')
    expect(d).toBeDefined()
    await queueOperation(rig, created.id, { kind: 'edit', id: d!.id, body: 'E' })
    await queueOperation(rig, created.id, { kind: 'move', id: c!.id, position: 1 })
    const finalQueue = await queueOperation(rig, created.id, { kind: 'remove', id: b!.id })

    expect(finalQueue.queueItems.map(({ id, body, position }) => ({ id, body, position }))).toEqual([
      { id: a!.id, body: 'A', position: 0 },
      { id: c!.id, body: 'C', position: 1 },
      { id: d!.id, body: 'E', position: 2 },
    ])
    await rig.call('quirky.loops/resume', { loopId: created.id })
    const pausedAfterC = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.state === 'paused' && snapshot.iterationsCompleted === 2
    )
    expect(pausedAfterC.pauseReason).toBe('ask-before-next')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['A', 'C'])
    await rig.call('quirky.loops/resume', { loopId: created.id })
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['A', 'C', 'E'])
    expect(completed.queueItems.map((item) => item.id)).toEqual([a!.id, c!.id, d!.id])
  }, 30_000)

  test('P03: completed rows remain editable, movable, and removable', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { askBeforeNext: true }),
      [{ body: 'completed row' }, { body: 'pending row' }]
    )
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    const completed = paused.queueItems[0]!
    const pending = paused.queueItems[1]!

    await queueOperation(rig, created.id, { kind: 'edit', id: completed.id, body: 'edited done row' })
    await queueOperation(rig, created.id, { kind: 'move', id: completed.id, position: 1 })
    const finalQueue = await queueOperation(rig, created.id, { kind: 'remove', id: completed.id })

    expect(finalQueue.queueItems).toEqual([{ ...pending, position: 0 }])
    await rig.call('quirky.loops/resume', { loopId: created.id })
    await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['completed row', 'pending row'])
  }, 30_000)

  test('P04: in-flight rows conflict while insertion may shift them without changing the claimed prompt', async () => {
    const hold = Promise.withResolvers<void>()
    rig = await startLoopRig({
      script: async () => {
        await hold.promise
        return 'iteration settled'
      },
      onStop: () => hold.resolve(),
    })
    const created = await createLoop(rig, 'queue', configForQueue(false), [{ body: 'exact claimed body' }, { body: 'later B' }])
    await waitForSends(rig, 1)
    const active = await rig.waitForLoop(created.id, (snapshot) => snapshot.queueItems.some((item) => item.state === 'in-flight'))
    const claimed = active.queueItems.find((item) => item.state === 'in-flight')!

    for (const op of [
      { kind: 'edit', id: claimed.id, body: 'replacement' },
      { kind: 'move', id: claimed.id, position: 1 },
      { kind: 'remove', id: claimed.id },
    ] satisfies QueueOperation[]) {
      expect((await failure(queueOperation(rig, created.id, op))).code).toBe(RpcErrorCode.Conflict)
      expect((await rig.snapshot(created.id)).queueItems.find((item) => item.id === claimed.id)).toMatchObject({
        body: 'exact claimed body',
        state: 'in-flight',
      })
    }

    const withInsertion = await queueOperation(rig, created.id, { kind: 'add', body: 'inserted first', position: 0 })
    expect(withInsertion.queueItems.find((item) => item.id === claimed.id)).toMatchObject({
      body: 'exact claimed body',
      state: 'in-flight',
      position: 1,
    })
    expect((await failure(queueOperation(rig, created.id, { kind: 'move', id: 'missing-item', position: 0 }))).code).toBe(RpcErrorCode.NotFound)
    expect((await failure(queueOperation(rig, created.id, { kind: 'add', body: 'bad position', position: 10 }))).code).toBe(RpcErrorCode.InvalidParams)

    hold.resolve()
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    expect(rig.sends[0]?.text.endsWith('exact claimed body')).toBe(true)
    expect(completed.queueItems.find((item) => item.id === claimed.id)?.state).toBe('done')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual([
      'exact claimed body',
      'inserted first',
      'later B',
    ])
  }, 30_000)

  test('P05: repeat and ask-before-next claim one item per explicit resume and reset only at the next cycle', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(true, { askBeforeNext: true, caps: { maxIterations: 5 } }),
      [{ body: 'A' }, { body: 'B' }]
    )
    let paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('ask-before-next')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['A'])
    expect(paused.queueItems.map((item) => item.state)).toEqual(['done', 'pending'])

    for (let expectedCount = 2; expectedCount <= 5; expectedCount += 1) {
      if (expectedCount === 3) {
        expect(paused.queueItems.map((item) => item.state)).toEqual(['done', 'done'])
      }
      await rig.call('quirky.loops/resume', { loopId: created.id })
      await waitForSends(rig, expectedCount)
      paused = await rig.waitForLoop(
        created.id,
        (snapshot) => snapshot.state === 'paused' && snapshot.iterationsCompleted >= expectedCount
      )
      expect(rig.sends).toHaveLength(expectedCount)
      if (expectedCount < 5) expect(paused.pauseReason).toBe('ask-before-next')
    }

    expect(paused.pauseReason).toBe('cap-iterations')
    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['A', 'B', 'A', 'B', 'A'])
    expect(paused.queueItems.map(({ body, state }) => ({ body, state }))).toEqual([
      { body: 'A', state: 'done' },
      { body: 'B', state: 'pending' },
    ])
  }, 60_000)

  test('P05: an empty repeat queue after removal exhausts without done signals', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(rig, 'queue', configForQueue(true, { askBeforeNext: true }), [{ body: 'only A' }])
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    const completedItem = paused.queueItems[0]!
    expect(completedItem.state).toBe('done')

    const emptied = await queueOperation(rig, created.id, { kind: 'remove', id: completedItem.id })
    expect(emptied.queueItems).toEqual([])
    await rig.call('quirky.loops/resume', { loopId: created.id })
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')

    expect(completed.iterationsCompleted).toBe(1)
    expect(completed.queueItems).toEqual([])
    expect(rig.sends.map(({ text }) => text.endsWith('only A'))).toEqual([true])
  }, 30_000)


  test('P06: exhausted queues pause before asking and can accept work before resume', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, {
        askBeforeNext: true,
        done: { check: { command: 'false', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      }),
      [{ body: 'A' }]
    )
    const exhausted = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'queue-exhausted'
    )
    expect(exhausted.iterationsCompleted).toBe(1)
    expect(exhausted.queueItems[0]?.state).toBe('done')
    expect(rig.sends).toHaveLength(1)

    await queueOperation(rig, created.id, { kind: 'add', body: 'B' })
    await rig.call('quirky.loops/resume', { loopId: created.id })
    const exhaustedAgain = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'queue-exhausted' && snapshot.iterationsCompleted === 2
    )
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends[1]?.text.endsWith('B')).toBe(true)
    expect(exhaustedAgain.queueItems.map((item) => item.state)).toEqual(['done', 'done'])
  }, 30_000)

  test('P06: an exhausted queue without done signals completes without a spurious approval', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { askBeforeNext: true }),
      [{ body: 'only item' }]
    )
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')

    expect(completed.pauseReason).toBeNull()
    expect(completed.iterationsCompleted).toBe(1)
    expect(completed.queueItems[0]?.state).toBe('done')
    expect(rig.sends.map(({ text }) => text.endsWith('only item'))).toEqual([true])
  }, 30_000)

  test('P06/P12: an independent passing check completes an exhausted queue', async () => {
    rig = await startLoopRig({
      script: ({ session }) => {
        writeFileSync(join(session.cwd, 'verified.txt'), 'verified\n')
        return 'iteration settled'
      },
    })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, {
        askBeforeNext: true,
        done: { check: { command: 'test -f verified.txt', timeoutSeconds: 5, runWhen: 'every-iteration' } },
      }),
      [{ body: 'verify work' }]
    )
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')

    expect(completed.iterationsCompleted).toBe(1)
    expect(completed.queueItems[0]?.state).toBe('done')
    expect((await latestAttempt(rig, created.id))[0]?.check?.pass).toBe(true)
    expect(rig.sends).toHaveLength(1)
  }, 30_000)

  test('P07: a crashed attempt retries the same claim and consumes it only after settlement', async () => {
    let turns = 0
    rig = await startLoopRig({
      script: () => {
        turns += 1
        if (turns === 1) throw new Error('scripted provider crash')
        return 'iteration settled'
      },
    })
    const created = await createLoop(rig, 'queue', configForQueue(false), [{ body: 'retry A' }, { body: 'next B' }])
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed', 20_000)
    const attempts = await latestAttempt(rig, created.id)
    const aAttempts = attempts.filter((attempt) => attempt.queueItemId === created.queueItems[0]?.id)

    expect(rig.sends.map(({ text }) => text.slice(text.lastIndexOf('\n\n') + 2))).toEqual(['retry A', 'retry A', 'next B'])
    expect(aAttempts.map(({ attempt, endReason }) => ({ attempt, endReason }))).toEqual([
      { attempt: 1, endReason: 'crashed' },
      { attempt: 2, endReason: 'settled' },
    ])
    expect(completed.queueItems.map((item) => item.state)).toEqual(['done', 'done'])
    expect(completed.iterationsCompleted).toBe(2)
  }, 30_000)

  test('P07/P11: restart retains an in-flight claim for explicit retry with the same body', async () => {
    const hold = Promise.withResolvers<void>()
    let sends = 0
    rig = await startLoopRig({
      script: async () => {
        sends += 1
        if (sends === 1) await hold.promise
        return 'iteration settled'
      },
      onStop: () => hold.resolve(),
    })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { sessionPolicy: 'continue' }),
      [{ body: 'same claimed body' }]
    )
    await waitForSends(rig, 1)
    const claimed = await rig.waitForLoop(created.id, (snapshot) => snapshot.queueItems.some((item) => item.state === 'in-flight'))
    const item = claimed.queueItems[0]!
    await rig.restart()
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')

    expect(paused.pauseReason).toBe('interrupted-by-restart')
    expect(paused.queueItems[0]).toMatchObject({ id: item.id, body: 'same claimed body', state: 'in-flight' })
    expect((await latestAttempt(rig, created.id)).at(-1)?.endReason).toBe('interrupted')
    // The driver polls once per second; wait through one poll to catch an unintended restart send.
    await Bun.sleep(1200)
    expect(rig.sends).toHaveLength(1)

    await rig.call('quirky.loops/resume', { loopId: created.id })
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    const attempts = await latestAttempt(rig, created.id)
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends.every(({ text }) => text.endsWith('same claimed body'))).toBe(true)
    expect(attempts.map(({ attempt, endReason, queueItemId }) => ({ attempt, endReason, queueItemId }))).toEqual([
      { attempt: 1, endReason: 'interrupted', queueItemId: item.id },
      { attempt: 2, endReason: 'settled', queueItemId: item.id },
    ])
    expect(completed.queueItems[0]?.state).toBe('done')
  }, 30_000)

  test('P07: stopping an in-flight attempt never consumes its queue item', async () => {
    const hold = Promise.withResolvers<void>()
    rig = await startLoopRig({
      script: async () => {
        await hold.promise
        return 'must not settle'
      },
      onStop: () => hold.resolve(),
    })
    const created = await createLoop(rig, 'queue', configForQueue(false), [{ body: 'stopped A' }, { body: 'untouched B' }])
    await waitForSends(rig, 1)
    const stopped = await rig.call<LoopSnapshot>('quirky.loops/stop', { loopId: created.id, mode: 'now' })
    const attempts = await latestAttempt(rig, created.id)

    expect(stopped.state).toBe('stopped')
    expect(stopped.iterationsCompleted).toBe(0)
    expect(stopped.queueItems.map((item) => item.state)).toEqual(['in-flight', 'pending'])
    expect(attempts.at(-1)?.endReason).toBe('stopped')
    expect(rig.sends).toHaveLength(1)
  }, 30_000)
})

describe('interval preset runtime API', () => {
  test('P08: interval starts immediately, persists a from-end deadline, and stops while waiting', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(rig, 'interval', configForInterval('repeat this prompt', 1, 'from-end'))
    const waiting = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.iterationsCompleted === 1 && snapshot.nextIterationAt !== null
    )
    const attempt = (await latestAttempt(rig, created.id))[0]!

    expect(created.config.sessionPolicy).toBe('continue')
    expect(rig.sends).toHaveLength(1)
    expect(attempt.startedAt).toBeGreaterThanOrEqual(created.createdAt)
    expect(waiting.nextIterationAt).toBe(attempt.endedAt! + 60_000)
    expect(waiting.skippedTicks).toBe(0)
    expect(waiting.state).toBe('running')

    const stopped = await rig.call<LoopSnapshot>('quirky.loops/stop', { loopId: created.id, mode: 'now' })
    expect(stopped.state).toBe('stopped')
    expect(rig.sends).toHaveLength(1)
  }, 30_000)

  test('P09: wall-clock ticks are skipped once per ended attempt and persist across restart', async () => {
    rig = await startLoopRig({ script: async () => {
      // Cross the first wall-clock tick using the real daemon clock; no public test clock override exists.
      await Bun.sleep(61_000)
      return 'iteration settled'
    } })
    const created = await createLoop(rig, 'interval', configForInterval('repeat on an epoch tick', 1, 'wall-clock'))
    const waiting = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.iterationsCompleted === 1 && snapshot.nextIterationAt !== null,
      90_000
    )
    const attempt = (await latestAttempt(rig, created.id))[0]!
    const startTick = Math.floor((attempt.startedAt - created.createdAt) / 60_000)
    const endTick = Math.floor((attempt.endedAt! - created.createdAt) / 60_000)
    const expectedSkippedTicks = endTick - startTick
    const nextIterationAt = created.createdAt + Math.max(1, endTick + 1) * 60_000

    expect(expectedSkippedTicks).toBeGreaterThanOrEqual(1)
    expect(waiting.skippedTicks).toBe(expectedSkippedTicks)
    expect(waiting.nextIterationAt).toBe(nextIterationAt)
    expect((await rig.snapshot(created.id)).skippedTicks).toBe(expectedSkippedTicks)

    await rig.restart()
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('interrupted-by-restart')
    expect(paused.nextIterationAt).toBe(nextIterationAt)
    expect(paused.skippedTicks).toBe(expectedSkippedTicks)
    // The driver polls once per second; wait through one poll to catch an unintended restart send.
    await Bun.sleep(1200)
    expect(rig.sends).toHaveLength(1)
  }, 100_000)

  test('P10: approval resume keeps the edited deadline and sends one fresh-session turn when it is due', async () => {
    const hold = Promise.withResolvers<void>()
    let turns = 0
    rig = await startLoopRig({
      script: async () => {
        turns += 1
        if (turns === 1) return 'iteration settled'
        await hold.promise
        return 'must not settle'
      },
      onStop: () => hold.resolve(),
    })
    const created = await createLoop(
      rig,
      'interval',
      configForInterval('repeat after approval', 1, 'from-end', { askBeforeNext: true, sessionPolicy: 'fresh' })
    )
    const paused = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'ask-before-next'
    )
    const firstAttempt = (await latestAttempt(rig, created.id))[0]!
    expect(rig.sends).toHaveLength(1)
    expect(paused.nextIterationAt).toBe(firstAttempt.endedAt! + 60_000)

    await rig.call('quirky.loops/edit', {
      loopId: created.id,
      patch: { pacing: { kind: 'interval', minutes: 1, anchor: 'wall-clock' } },
    })
    const expectedDeadline =
      created.createdAt + (Math.floor((firstAttempt.endedAt! - created.createdAt) / 60_000) + 1) * 60_000
    await rig.call('quirky.loops/resume', { loopId: created.id })
    const waiting = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.state === 'running' && snapshot.nextIterationAt !== null
    )

    expect(waiting.config.sessionPolicy).toBe('fresh')
    expect(waiting.config.pacing).toEqual({ kind: 'interval', minutes: 1, anchor: 'wall-clock' })
    expect(waiting.nextIterationAt).toBe(expectedDeadline)
    expect(waiting.nextIterationAt).toBeGreaterThan(Date.now())
    expect(rig.sends).toHaveLength(1)
    expect((await failure(rig.call('quirky.loops/resume', { loopId: created.id }))).code).toBe(RpcErrorCode.Conflict)

    // A one-minute interval is intentionally exercised through the public daemon API.
    await waitForSends(rig, 2, 75_000)
    expect(rig.sends[1]?.text.endsWith('repeat after approval')).toBe(true)
    expect(rig.sends[0]?.sessionId).not.toBe(rig.sends[1]?.sessionId)

    const stopped = await rig.call<LoopSnapshot>('quirky.loops/stop', { loopId: created.id, mode: 'now' })
    expect(stopped.state).toBe('stopped')
    const attempts = await latestAttempt(rig, created.id)
    expect(attempts.at(-1)?.startedAt).toBeGreaterThanOrEqual(expectedDeadline)
    expect(attempts.at(-1)?.endReason).toBe('stopped')
    expect(rig.sends).toHaveLength(2)
  }, 90_000)



  test('P11: list, get, and daemon reload preserve a paused queue and interval metadata', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      {
        ...configForQueue(false, { pacing: { kind: 'interval', minutes: 1, anchor: 'from-end' } }),
        promptSource: { kind: 'queue', repeatQueue: false },
      },
      [{ body: 'first' }, { body: 'second' }]
    )
    const waiting = await rig.waitForLoop(
      created.id,
      (snapshot) => snapshot.iterationsCompleted === 1 && snapshot.nextIterationAt !== null
    )
    const ids = waiting.queueItems.map((item) => item.id)
    const nextIterationAt = waiting.nextIterationAt
    expect(waiting.queueItems.map((item) => item.state)).toEqual(['done', 'pending'])

    await rig.restart()
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    const listed = await rig.call<LoopSnapshot[]>('quirky.loops/list', {})
    const shown = await rig.call<LoopSnapshot>('quirky.loops/get', { loopId: created.id })

    expect(paused.pauseReason).toBe('interrupted-by-restart')
    expect(listed.find((snapshot) => snapshot.id === created.id)?.queueItems.map((item) => item.id)).toEqual(ids)
    expect(shown.queueItems.map((item) => ({ id: item.id, position: item.position, state: item.state }))).toEqual([
      { id: ids[0], position: 0, state: 'done' },
      { id: ids[1], position: 1, state: 'pending' },
    ])
    expect(shown.nextIterationAt).toBe(nextIterationAt)
    expect(shown.skippedTicks).toBe(0)
    expect(shown.iterationsCompleted).toBe(1)
    // The driver polls once per second; wait through one poll to catch an unintended restart send.
    await Bun.sleep(1200)
    expect(rig.sends).toHaveLength(1)
  }, 30_000)
})

describe('preset safety precedence', () => {
  test('P12: iteration caps pause before queue advancement, approval, and interval pacing', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, {
        askBeforeNext: true,
        caps: { maxIterations: 1 },
        pacing: { kind: 'interval', minutes: 1, anchor: 'from-end' },
      }),
      [{ body: 'capped A' }, { body: 'pending B' }]
    )
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')

    expect(paused.pauseReason).toBe('cap-iterations')
    expect(paused.queueItems.map((item) => item.state)).toEqual(['done', 'pending'])
    expect(rig.sends).toHaveLength(1)
  }, 30_000)

  test('P12: protected-path evidence pauses before approval and does not consume the next item', async () => {
    rig = await startLoopRig({
      script: ({ session }) => {
        writeFileSync(join(session.cwd, 'private.txt'), 'changed\n')
        return 'iteration settled'
      },
    })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { askBeforeNext: true, protectedPaths: ['private.txt'] }),
      [{ body: 'change protected path' }, { body: 'pending next' }]
    )
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')

    expect(paused.pauseReason).toBe('protected-path')
    expect(paused.queueItems.map((item) => item.state)).toEqual(['done', 'pending'])
    expect(rig.sends).toHaveLength(1)
  }, 30_000)

  test('P12: blocked markers pause before ask-before-next without claiming another row', async () => {
    rig = await startLoopRig({ script: () => 'LOOP_BLOCKED: waiting on a decision' })
    const created = await createLoop(
      rig,
      'queue',
      configForQueue(false, { askBeforeNext: true }),
      [{ body: 'blocked A' }, { body: 'pending B' }]
    )
    const paused = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')

    expect(paused.pauseReason).toBe('agent-blocked')
    expect(paused.queueItems.map((item) => item.state)).toEqual(['done', 'pending'])
    expect(rig.sends).toHaveLength(1)
  }, 30_000)
})
