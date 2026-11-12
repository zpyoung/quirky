import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import type { IterationDetail, LoopConfig, LoopSnapshot } from '../src/types'
import { startLoopRig, loopConfig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

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

describe('interval preset runtime API', () => {
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
})
