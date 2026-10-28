import { afterEach, describe, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import type { LoopConfig, LoopSnapshot } from '../src/types'
import { loopConfig, startLoopRig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

function queueConfig(repeatQueue = false, patch: Partial<LoopConfig> = {}): LoopConfig {
  return loopConfig('unused repeat prompt', {
    promptSource: { kind: 'queue', repeatQueue },
    ...patch
  })
}

function withoutSession(config: LoopConfig): Omit<LoopConfig, 'sessionPolicy'> {
  const { sessionPolicy, ...withoutSessionPolicy } = config
  void sessionPolicy
  return withoutSessionPolicy
}

function createQueue(workspace: LoopRig, bodies: string[], config: unknown = queueConfig()) {
  return workspace.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: workspace.worktree.id,
    agent: 'claude',
    preset: 'queue',
    queueItems: bodies.map((body) => ({ body })),
    config
  })
}

function isRpcError(error: unknown): error is RpcError {
  return error instanceof RpcError
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    if (isRpcError(error)) return error
    throw new Error('expected an RPC error', { cause: error })
  }
  throw new Error('expected the public loop API call to reject')
}

describe('quirky.loops preset API', () => {
  test('rejects malformed and contradictory queue or interval configs before starting a provider', async () => {
    rig = await startLoopRig()
    const input = (preset: string, config: unknown, extra: Record<string, unknown> = {}) => ({
      worktreeId: rig!.worktree.id,
      agent: 'claude',
      preset,
      config,
      ...extra
    })
    const cases = [
      input('queue', loopConfig('repeat prompt'), { queueItems: [{ body: 'task A' }] }),
      input('queue', { ...queueConfig(), promptSource: { kind: 'queue', repeatQueue: 'false' } }, { queueItems: [{ body: 'task A' }] }),
      input('queue', queueConfig(), { queueItems: [{ body: '   ' }] }),
      input('queue', queueConfig(), { queueItems: [] }),
      input('queue', queueConfig()),
      input('interval', loopConfig('repeat prompt')),
      input('interval', loopConfig('repeat prompt', { pacing: { kind: 'interval', minutes: 0, anchor: 'from-end' } })),
      input('interval', loopConfig('repeat prompt', { pacing: { kind: 'interval', minutes: 1.5, anchor: 'from-end' } })),
      input('interval', { ...loopConfig('repeat prompt'), pacing: { kind: 'interval', minutes: 5, anchor: 'other' } })
    ]

    for (const params of cases) {
      expect((await failure(rig.call('quirky.loops/create', params))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect(rig.starts).toHaveLength(0)
    expect(rig.sends).toHaveLength(0)
    expect(await rig.call('quirky.loops/list', {})).toEqual([])
  })
  test('API defaults session policy by preset and allows interval pacing on a queue preset', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const untilDone = await rig.call<LoopSnapshot>('quirky.loops/create', {
      worktreeId: rig.worktree.id,
      agent: 'claude',
      config: withoutSession(loopConfig('one until-done iteration', { caps: { maxIterations: 1 } }))
    })
    const untilDonePaused = await rig.waitForLoop(untilDone.id, (snapshot) => snapshot.state === 'paused')
    expect(untilDonePaused.config.sessionPolicy).toBe('fresh')

    const queue = await createQueue(
      rig,
      ['interval queue task A', 'interval queue task B'],
      withoutSession(queueConfig(false, { pacing: { kind: 'interval', minutes: 60, anchor: 'from-end' } }))
    )
    const queueWaiting = await rig.waitForLoop(queue.id, (snapshot) => snapshot.nextIterationAt !== null)
    expect(queueWaiting.preset).toBe('queue')
    expect(queueWaiting.config.sessionPolicy).toBe('continue')
    expect(queueWaiting.config.pacing).toEqual({ kind: 'interval', minutes: 60, anchor: 'from-end' })
    expect(rig.sends).toHaveLength(2)
    expect(rig.sends[1]?.text).toContain('interval queue task A')
    const interval = await rig.call<LoopSnapshot>('quirky.loops/create', {
      worktreeId: rig.worktree.id,
      agent: 'claude',
      preset: 'interval',
      config: withoutSession(loopConfig('interval default', {
        pacing: { kind: 'interval', minutes: 60, anchor: 'from-end' }
      }))
    })
    const intervalWaiting = await rig.waitForLoop(interval.id, (snapshot) => snapshot.nextIterationAt !== null)
    expect(intervalWaiting.config.sessionPolicy).toBe('continue')
    expect(rig.sends).toHaveLength(3)
  })


  test('queue API mutations preserve item identity and order, reject malformed operations, and honor approval resumes', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    const created = await createQueue(rig, ['task A', 'task B'], queueConfig(false, { askBeforeNext: true }))
    const approved = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
    expect(approved.pauseReason).toBe('ask-before-next')
    expect(rig.sends[0]?.text).toContain('task A')

    const [a, b] = approved.queueItems
    expect(a).toMatchObject({ position: 0, body: 'task A', state: 'done' })
    expect(b).toMatchObject({ position: 1, body: 'task B', state: 'pending' })

    const malformed = await failure(rig.call('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'add', body: 'task D', position: 1, id: 'not-valid-for-add' }
    }))
    expect(malformed.code).toBe(RpcErrorCode.InvalidParams)
    const invalidPosition = await failure(rig.call('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'move', id: b!.id, position: 10 }
    }))
    expect(invalidPosition.code).toBe(RpcErrorCode.InvalidParams)
    const missingItem = await failure(rig.call('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'remove', id: 'missing-item' }
    }))
    expect(missingItem.code).toBe(RpcErrorCode.NotFound)
    expect((await rig.snapshot(created.id)).queueItems).toEqual(approved.queueItems)

    const added = await rig.call<LoopSnapshot>('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'add', body: 'task C', position: 1 }
    })
    const c = added.queueItems.find((item) => item.body === 'task C')!
    await rig.call('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'edit', id: c.id, body: 'task C updated' }
    })
    await rig.call('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'move', id: b!.id, position: 0 }
    })
    const mutated = await rig.call<LoopSnapshot>('quirky.loops/queue', {
      loopId: created.id,
      op: { kind: 'remove', id: a!.id }
    })
    expect(mutated.queueItems).toEqual([
      { ...b, position: 0 },
      { ...c, position: 1, body: 'task C updated' }
    ])

    await rig.call('quirky.loops/resume', { loopId: created.id })
    const secondApproval = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused' && snapshot.iterationsCompleted === 2)
    expect(secondApproval.pauseReason).toBe('ask-before-next')
    expect(rig.sends[1]?.text).toContain('task B')

    await rig.call('quirky.loops/resume', { loopId: created.id })
    const completed = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'completed')
    expect(completed.iterationsCompleted).toBe(3)
    expect(rig.sends.map((send) => send.text)).toEqual([
      expect.stringContaining('task A'),
      expect.stringContaining('task B'),
      expect.stringContaining('task C updated')
    ])
  })
})
