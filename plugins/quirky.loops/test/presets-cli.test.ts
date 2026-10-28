import { afterEach, describe, expect, test } from 'bun:test'
import type { CliArgs, CliContext, CliModule } from '@quirky/protocol'
import type { LoopSnapshot } from '../src/types'
import { commands } from '../cli'
import { loopConfig, startLoopRig, type LoopRig } from './rig'

let rig: LoopRig | undefined
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const run = async (name: string, positionals: string[], flags: Record<string, unknown> = {}, json = false) => {
  const { context, lines } = rig!.cliContext(json)
  const handler = (commands as CliModule['commands'])[name]
  if (!handler) throw new Error(`missing loop CLI command ${name}`)
  await handler({ positionals, flags } satisfies CliArgs, context satisfies CliContext)
  return lines
}

async function expectFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    return
  }
  throw new Error('expected the CLI command to reject')
}

describe('quirky loop preset CLI', () => {
  test('rejects contradictory preset flags before creating a loop', async () => {
    rig = await startLoopRig()
    const cases: Record<string, unknown>[] = [
      { agent: 'claude', preset: 'queue' },
      { agent: 'claude', preset: 'queue', 'queue-item': ['task A'], prompt: 'repeat prompt' },
      { agent: 'claude', preset: 'queue', 'queue-item': ['   '] },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt' },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt', every: 0 },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt', every: 1.5 },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt', every: 5, anchor: 'soon' },
      { agent: 'claude', preset: 'until-done', prompt: 'repeat prompt', every: 5 },
      { agent: 'claude', preset: 'until-done', prompt: 'repeat prompt', 'queue-item': ['task A'] },
      { agent: 'claude', prompt: 'repeat prompt', anchor: 'from-end' },
      { agent: 'claude', preset: 'queue', 'queue-item': ['task A'], every: 5 },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt', every: 5, 'queue-item': ['task A'] },
      { agent: 'claude', preset: 'until-done', prompt: 'repeat prompt', 'repeat-queue': false },
      { agent: 'claude', preset: 'interval', prompt: 'repeat prompt', every: 5, 'repeat-queue': false }
    ]

    for (const flags of cases) await expectFailure(run('create', [], flags))
    expect(rig.starts).toHaveLength(0)
    expect(rig.sends).toHaveLength(0)
    expect(await rig.call<LoopSnapshot[]>('quirky.loops/list', {})).toEqual([])
  }, 30_000)

  test('queue CLI CRUD changes the actual next task and each resume approves one iteration', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    await run('create', [], {
      agent: 'claude',
      preset: 'queue',
      'queue-item': ['task A', 'task B', 'task C'],
      'repeat-queue': true,
      'ask-before-next': true
    })
    let loop = (await rig.call<LoopSnapshot[]>('quirky.loops/list', {}))[0]!
    expect(loop.preset).toBe('queue')
    expect(loop.name).toBe('claude queue')
    expect(loop.config.sessionPolicy).toBe('continue')
    expect(loop.config.promptSource).toEqual({ kind: 'queue', repeatQueue: true })

    const firstApproval = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(firstApproval.pauseReason).toBe('ask-before-next')
    expect(rig.sends).toHaveLength(1)
    expect(rig.sends[0]?.text).toContain('task A')
    const initialIds = Object.fromEntries(firstApproval.queueItems.map((item: { id: string; body: string }) => [item.body, item.id])) as Record<string, string>
    await expectFailure(run('queue', [loop.id]))
    await expectFailure(run('queue', [loop.id, 'skip', 'task']))
    await expectFailure(run('queue', [loop.id, 'add']))
    await expectFailure(run('queue', [loop.id, 'add', 'bad position'], { position: -1 }))
    await expectFailure(run('queue', [loop.id, 'add', 'past end'], { position: 4 }))
    await expectFailure(run('queue', [loop.id, 'edit', initialIds['task B']!]))
    await expectFailure(run('queue', [loop.id, 'move', initialIds['task C']!, '3']))
    await expectFailure(run('queue', [loop.id, 'remove', initialIds['task B']!, 'extra']))
    expect((await rig.snapshot(loop.id)).queueItems).toEqual(firstApproval.queueItems)
    await run('queue', [loop.id, 'add', 'task tail'])
    const appendedQueue = await rig.snapshot(loop.id)
    expect(appendedQueue.queueItems.at(-1)).toMatchObject({ position: 3, body: 'task tail', state: 'pending' })
    const tailId = appendedQueue.queueItems.at(-1)!.id
    await run('queue', [loop.id, 'remove', tailId])
    expect((await rig.snapshot(loop.id)).queueItems).toEqual(firstApproval.queueItems)

    await run('edit', [loop.id], { 'repeat-queue': false })
    expect((await rig.snapshot(loop.id)).config.promptSource).toEqual({ kind: 'queue', repeatQueue: false })
    await expectFailure(run('edit', [loop.id], { prompt: 'not a queue setting' }))

    await run('queue', [loop.id, 'add', 'task D'], { position: 0 })
    const addedQueue = await rig.snapshot(loop.id)
    const insertedId = addedQueue.queueItems.find((item: { body: string }) => item.body === 'task D')!.id
    await run('queue', [loop.id, 'edit', insertedId, 'task E'])
    await run('queue', [loop.id, 'move', initialIds['task C']!, '0'])
    await run('queue', [loop.id, 'remove', initialIds['task B']!])

    let snapshot = await rig.snapshot(loop.id)
    expect(snapshot.queueItems.map((item: { id: string; position: number; body: string; state: string }) => ({
      id: item.id,
      position: item.position,
      body: item.body,
      state: item.state
    }))).toEqual([
      { id: initialIds['task C'], position: 0, body: 'task C', state: 'pending' },
      { position: 1, body: 'task E', state: 'pending', id: expect.any(String) },
      { id: initialIds['task A'], position: 2, body: 'task A', state: 'done' }
    ])
    const shown = (await run('show', [loop.id])).join('\n')
    expect(shown).toContain('task C')
    expect(shown).toContain('task E')
    expect(shown.indexOf('task C')).toBeLessThan(shown.indexOf('task E'))
    expect(shown.indexOf('task E')).toBeLessThan(shown.indexOf('task A'))
    expect(shown).toContain('pending')
    expect(shown).toContain('done')

    await run('resume', [loop.id])
    snapshot = await rig.waitForLoop(loop.id, (current) => current.state === 'paused' && current.iterationsCompleted === 2)
    expect(snapshot.pauseReason).toBe('ask-before-next')
    expect(rig.sends[1]?.text).toContain('task C')
    await run('resume', [loop.id])
    const completed = await rig.waitForLoop(loop.id, (current) => current.state === 'completed')
    expect(completed.iterationsCompleted).toBe(3)
    expect(rig.sends[2]?.text).toContain('task E')
    expect(rig.sends).toHaveLength(3)
  }, 30_000)

  test('interval edits preserve omitted pacing fields and show its durable waiting deadline', async () => {
    rig = await startLoopRig({ script: () => 'iteration settled' })
    await run('create', [], {
      agent: 'claude',
      preset: 'interval',
      prompt: 'repeat on the interval',
      every: 60,
      anchor: 'from-end',
      'ask-before-next': true
    })
    let loop = (await rig.call<LoopSnapshot[]>('quirky.loops/list', {}))[0]!
    expect(loop.name).toBe('claude interval')
    expect(loop.config.sessionPolicy).toBe('continue')
    const approval = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(approval.pauseReason).toBe('ask-before-next')
    expect(rig.sends).toHaveLength(1)

    await run('edit', [loop.id], { every: 90, 'ask-before-next': false })
    loop = await rig.snapshot(loop.id)
    expect(loop.config.pacing).toEqual({ kind: 'interval', minutes: 90, anchor: 'from-end' })
    expect(loop.config.askBeforeNext).toBe(false)

    await run('resume', [loop.id])
    const waiting = await rig.waitForLoop(loop.id, (snapshot) => snapshot.nextIterationAt !== null)
    expect(waiting.nextIterationAt).toBeGreaterThan(Date.now())
    expect(rig.sends).toHaveLength(1)

    const visible = (await run('show', [loop.id])).join('\n')
    const deadline = new Date(waiting.nextIterationAt!).toISOString()
    expect(visible).toContain(deadline)
    expect((await run('list', [])).join('\n')).toContain(deadline)

    await run('edit', [loop.id], { anchor: 'wall-clock' })
    loop = await rig.snapshot(loop.id)
    expect(loop.config.pacing).toEqual({ kind: 'interval', minutes: 90, anchor: 'wall-clock' })
    expect(loop.nextIterationAt).not.toBeNull()
    expect((await run('show', [loop.id])).join('\n')).toContain(new Date(loop.nextIterationAt!).toISOString())
    expect(rig.sends).toHaveLength(1)
  }, 30_000)
})

