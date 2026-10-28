import { afterEach, describe, expect, test } from 'bun:test'
import { type CliArgs, type CliContext, type CliModule } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
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

async function failure(promise: Promise<unknown>): Promise<Error & { code?: number }> {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: number }
  }
  throw new Error('expected the CLI command to reject')
}

describe('quirky loop CLI', () => {
  test('create defaults to a fresh on-idle repeat loop with no caps; list and show have text and JSON output', async () => {
    rig = await startLoopRig({ script: () => 'LOOP_BLOCKED: stop the fixture' })
    const noLoops = await run('list', [])
    expect(noLoops[0]).toBe('No loops.')

    const createdText = await run('create', [], { agent: 'claude', prompt: 'Add the requested test.' })
    expect(createdText[0]).toContain('Started loop ')
    expect(createdText[0]).toContain(': running.')
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    expect(loop.config).toEqual(loopConfig('Add the requested test.'))
    expect(loop.config.caps).toEqual({})
    expect(loop.config.sessionPolicy).toBe('fresh')
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')

    const listed = await run('list', [])
    expect(listed.join('\n')).toContain(loop.id)
    expect(listed.join('\n')).toContain('paused: agent-blocked')
    expect((await run('show', [loop.id])).join('\n')).toContain(`id: ${loop.id}`)
    expect((await run('get', [loop.id]))[0]).toContain(`id: ${loop.id}`)
    const json = await run('show', [loop.id], {}, true)
    expect(JSON.parse(json[0]!)).toMatchObject({ id: loop.id, config: loop.config })
    expect((await run('iterations', [loop.id])).join('\n')).toContain('Iteration 1')
  })

  test('create maps every until-done, safety and launch flag into the shared config', async () => {
    const hold = Promise.withResolvers<void>()
    rig = await startLoopRig({
      script: async () => { await hold.promise; return 'LOOP_BLOCKED: stop the fixture' },
      onStop: () => hold.resolve()
    })
    const output = await run('create', [], {
      agent: 'claude',
      name: 'flag coverage',
      prompt: 'Check all flags.',
      session: 'continue',
      check: 'test -f missing.txt',
      'check-timeout': 5,
      'check-when': 'on-claim',
      evaluator: 'the task is complete',
      'max-iterations': 7,
      'max-minutes': 4,
      'max-cost': 2.5,
      'no-progress': true,
      'checkpoint-commits': true,
      'ask-before-next': true,
      'resume-at-reset': true,
      'protected-path': ['secret/**', '*.pem'],
      model: 'opus',
      option: ['effort=high']
    })
    expect(output[0]).toContain('Started loop ')
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    expect(loop).toMatchObject({
      name: 'flag coverage',
      model: 'opus',
      options: { effort: 'high' },
      config: {
        promptSource: { kind: 'repeat', body: 'Check all flags.' },
        pacing: { kind: 'on-idle' },
        sessionPolicy: 'continue',
        done: {
          check: { command: 'test -f missing.txt', timeoutSeconds: 5, runWhen: 'on-claim' },
          evaluator: { condition: 'the task is complete' }
        },
        caps: { maxIterations: 7, maxActiveMinutes: 4, maxCostUsd: 2.5 },
        noProgress: true,
        checkpointCommits: true,
        askBeforeNext: true,
        resumeAtLimitReset: true,
        protectedPaths: ['secret/**', '*.pem']
      }
    })
    hold.resolve()
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
  })

  test('create maps the existing model and effort shorthand into loop launch options', async () => {
    rig = await startLoopRig({ script: () => 'LOOP_BLOCKED: fixture stop' })
    await run('create', [], {
      agent: 'claude',
      prompt: 'Use the requested model.',
      model: 'opus',
      effort: 'high',
      'max-iterations': 1
    })
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    expect(loop.model).toBe('opus')
    expect(loop.options).toEqual({ effort: 'high' })
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
  })

  test('pause, steer, edit and resume preserve omitted nested config; removal and conflicts are explicit', async () => {
    rig = await startLoopRig({ script: () => 'LOOP_BLOCKED: fixture stop' })
    await run('create', [], {
      agent: 'claude',
      prompt: 'Original prompt.',
      'max-iterations': 1,
      check: 'false',
      'check-timeout': 5,
      evaluator: 'the task is complete',
      'no-progress': true,
      'protected-path': 'secret/**'
    })
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    await run('steer', [loop.id, 'Use banana next.'])

    expect((await failure(run('edit', [loop.id], { check: 'true', 'no-check': true }))).message).toContain('cannot be combined')
    expect((await failure(run('edit', [loop.id], {}))).message).toContain('Nothing to edit')
    await run('edit', [loop.id], { prompt: 'Updated prompt.' })
    let edited = await rig.call<any>('quirky.loops/get', { loopId: loop.id })
    expect(edited.config.promptSource.body).toBe('Updated prompt.')
    expect(edited.config.done.check.command).toBe('false')
    expect(edited.config.noProgress).toBe(true)
    expect(edited.config.protectedPaths).toEqual(['secret/**'])

    await run('edit', [loop.id], {
      'no-check': true,
      'no-evaluator': true,
      'no-max-iterations': true,
      'no-max-minutes': true,
      'no-max-cost': true,
      'no-protected-paths': true
    })
    edited = await rig.call<any>('quirky.loops/get', { loopId: loop.id })
    expect(edited.config.done).toEqual({})
    expect(edited.config.caps).toEqual({})
    expect(edited.config.protectedPaths ?? []).toEqual([])
    await run('resume', [loop.id])
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(rig.sends[1]?.text).toContain('Use banana next.')
    await run('stop', [loop.id], { now: true })
    expect((await rig.call<any>('quirky.loops/get', { loopId: loop.id })).state).toBe('stopped')
  })

  test('pause holds the running iteration until it settles', async () => {
    const hold = Promise.withResolvers<void>()
    rig = await startLoopRig({ script: async () => { await hold.promise; return 'iteration finished' }, onStop: () => hold.resolve() })
    await run('create', [], { agent: 'claude', prompt: 'Pause after this turn.', 'max-iterations': 4 })
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    await waitFor(() => rig!.sends.length >= 1 || undefined, 10_000)
    expect((await run('pause', [loop.id]))[0]).toContain('Pausing loop')
    hold.resolve()
    const paused = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    expect(paused.pauseReason).toBe('user')
    await run('stop', [loop.id])
  })

  test('resume adds iterations, iterations stays readable, and stop --now ends a paused loop', async () => {
    rig = await startLoopRig({ script: () => 'iteration finished' })
    await run('create', [], { agent: 'claude', prompt: 'Continue twice.', 'max-iterations': 1 })
    const loop = (await rig.call<any[]>('quirky.loops/list', {}))[0]
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')
    const resumed = await run('resume', [loop.id], { 'add-iterations': 1 })
    expect(resumed[0]).toContain('Resumed loop')
    const pausedAgain = await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused' && snapshot.iterationsCompleted === 2)
    expect(pausedAgain.config.caps.maxIterations).toBe(2)
    expect((await run('iterations', [loop.id])).join('\n')).toContain('Iteration 2')
    const stopped = await run('stop', [loop.id], { now: true })
    expect(stopped[0]).toContain('Stopping loop')
  })

  test('CLI validates required input and check flag dependencies before calling create', async () => {
    rig = await startLoopRig()
    expect((await failure(run('create', [], { agent: 'claude' }))).message).toContain('--prompt')
    expect((await failure(run('create', [], { agent: 'claude', prompt: ' ' }))).message).toContain('non-empty')
    expect((await failure(run('create', [], { agent: 'claude', prompt: 'ok', 'check-timeout': 601 }))).message).toContain('--check-timeout requires --check')
    expect(rig.starts).toHaveLength(0)
  })
})
