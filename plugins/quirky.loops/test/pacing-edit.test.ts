import { afterEach, expect, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import { commands } from '../cli'
import type { LoopConfig, LoopPreset, LoopSnapshot } from '../src/types'
import { loopConfig, startLoopRig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

function createLoop(workspace: LoopRig, config: LoopConfig, preset?: LoopPreset): Promise<LoopSnapshot> {
  return workspace.call<LoopSnapshot>('quirky.loops/create', {
    worktreeId: workspace.worktree.id,
    agent: 'claude',
    ...(preset === undefined ? {} : { preset }),
    config
  })
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RpcError) return error
    throw new Error('expected an RPC error', { cause: error })
  }
  throw new Error('expected the public loop API call to reject')
}

async function cliFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    return
  }
  throw new Error('expected the loop CLI command to reject')
}


test('until-done loops can change pacing without changing their preset or repeat prompt', async () => {
  rig = await startLoopRig({ script: () => 'iteration settled' })

  const invalidUntilDoneInterval = await failure(createLoop(rig, loopConfig('invalid until-done interval', {
    pacing: { kind: 'interval', minutes: 1, anchor: 'from-end' }
  })))
  expect(invalidUntilDoneInterval.code).toBe(RpcErrorCode.InvalidParams)
  const invalidIntervalOnIdle = await failure(createLoop(rig, loopConfig('invalid interval on-idle'), 'interval'))
  expect(invalidIntervalOnIdle.code).toBe(RpcErrorCode.InvalidParams)
  expect(rig.starts).toHaveLength(0)
  expect(rig.sends).toHaveLength(0)

  const body = 'Repeat this exact until-done prompt.'
  const created = await createLoop(rig, loopConfig(body, { caps: { maxIterations: 1 } }))
  const firstPause = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
  expect(firstPause).toMatchObject({
    preset: 'until-done',
    pauseReason: 'cap-iterations',
    iterationsCompleted: 1,
    config: { promptSource: { kind: 'repeat', body } }
  })
  expect(rig.sends[0]?.text.endsWith(body)).toBe(true)

  const changedPreset = await failure(rig.call('quirky.loops/edit', {
    loopId: created.id,
    patch: { preset: 'interval' }
  }))
  expect(changedPreset.code).toBe(RpcErrorCode.InvalidParams)

  const changedPromptSource = await failure(rig.call('quirky.loops/edit', {
    loopId: created.id,
    patch: { promptSource: { kind: 'queue', repeatQueue: false } }
  }))
  expect(changedPromptSource.code).toBe(RpcErrorCode.InvalidParams)

  const interval = { kind: 'interval', minutes: 1, anchor: 'from-end' } as const
  const intervalEdited = await rig.call<LoopSnapshot>('quirky.loops/edit', {
    loopId: created.id,
    patch: { pacing: interval }
  })
  expect(intervalEdited).toMatchObject({
    preset: 'until-done',
    config: { promptSource: { kind: 'repeat', body }, pacing: interval }
  })

  const { context } = rig.cliContext()
  const editCommand = (commands as CliModule['commands']).edit
  if (!editCommand) throw new Error('missing loop CLI edit command')
  await cliFailure(editCommand({
    positionals: [created.id],
    flags: { every: 2 }
  } satisfies CliArgs, context satisfies CliContext))
  expect((await rig.snapshot(created.id)).config.pacing).toEqual(interval)

  await rig.call('quirky.loops/resume', { loopId: created.id, addIterations: 1 })
  const waiting = await rig.waitForLoop(created.id, (snapshot) =>
    snapshot.state === 'running' && snapshot.phase === 'waiting' && snapshot.nextIterationAt !== null
  )
  expect(waiting.nextIterationAt).toBeGreaterThan(Date.now())
  expect(rig.sends).toHaveLength(1)

  const onIdleEdited = await rig.call<LoopSnapshot>('quirky.loops/edit', {
    loopId: created.id,
    patch: { pacing: { kind: 'on-idle' } }
  })
  expect(onIdleEdited).toMatchObject({
    preset: 'until-done',
    config: { promptSource: { kind: 'repeat', body }, pacing: { kind: 'on-idle' } }
  })

  const secondPause = await rig.waitForLoop(created.id, (snapshot) =>
    snapshot.state === 'paused' && snapshot.iterationsCompleted === 2
  )
  expect(secondPause.pauseReason).toBe('cap-iterations')
  expect(secondPause.config.caps.maxIterations).toBe(2)
  expect(secondPause.config.promptSource).toEqual({ kind: 'repeat', body })
  expect(rig.sends).toHaveLength(2)
  expect(rig.sends[1]?.text.endsWith(body)).toBe(true)
}, 30_000)

test('interval loops can switch to on-idle for an immediate resumed turn and back', async () => {
  rig = await startLoopRig({ script: () => 'iteration settled' })
  const body = 'Repeat this exact interval prompt.'
  const interval = { kind: 'interval', minutes: 1, anchor: 'from-end' } as const
  const created = await createLoop(rig, loopConfig(body, {
    pacing: interval,
    caps: { maxIterations: 1 }
  }), 'interval')

  const firstPause = await rig.waitForLoop(created.id, (snapshot) => snapshot.state === 'paused')
  expect(firstPause).toMatchObject({
    preset: 'interval',
    pauseReason: 'cap-iterations',
    iterationsCompleted: 1,
    config: { promptSource: { kind: 'repeat', body }, pacing: interval }
  })
  expect(rig.sends[0]?.text.endsWith(body)).toBe(true)

  const onIdleEdited = await rig.call<LoopSnapshot>('quirky.loops/edit', {
    loopId: created.id,
    patch: { pacing: { kind: 'on-idle' } }
  })
  expect(onIdleEdited).toMatchObject({
    preset: 'interval',
    config: { promptSource: { kind: 'repeat', body }, pacing: { kind: 'on-idle' } },
    nextIterationAt: null
  })

  await rig.call('quirky.loops/resume', { loopId: created.id, addIterations: 1 })
  const secondPause = await rig.waitForLoop(created.id, (snapshot) =>
    snapshot.state === 'paused' && snapshot.iterationsCompleted === 2
  )
  expect(secondPause).toMatchObject({
    preset: 'interval',
    pauseReason: 'cap-iterations',
    config: { promptSource: { kind: 'repeat', body }, pacing: { kind: 'on-idle' } }
  })
  expect(secondPause.config.caps.maxIterations).toBe(2)
  expect(rig.sends).toHaveLength(2)
  expect(rig.sends[1]?.text.endsWith(body)).toBe(true)

  const intervalEdited = await rig.call<LoopSnapshot>('quirky.loops/edit', {
    loopId: created.id,
    patch: { pacing: interval }
  })
  expect(intervalEdited).toMatchObject({
    preset: 'interval',
    config: { promptSource: { kind: 'repeat', body }, pacing: interval }
  })
  expect(intervalEdited.nextIterationAt).toBeGreaterThan(Date.now())
  expect(rig.sends).toHaveLength(2)
}, 30_000)
