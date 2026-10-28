import { afterEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loopConfig, startLoopRig, type LoopRig } from './rig'
import type { LoopConfig, LoopSnapshot } from '../src/types'

let rig: LoopRig | undefined
afterEach(async () => { await rig?.cleanup(); rig = undefined })

async function create(config: LoopConfig): Promise<LoopSnapshot> {
  return rig!.call<LoopSnapshot>('quirky.loops/create', { worktreeId: rig!.worktree.id, name: 'Safety acceptance', agent: 'claude', config })
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: rig!.cwd, encoding: 'utf8' }).trim()
}

test('L12-L13: both independent signals must pass, and malformed evaluator output never completes', async () => {
  rig = await startLoopRig({ script: () => 'LOOP_DONE' })
  const evaluator = join(rig.home, 'providers', 'bin', 'claude')
  writeFileSync(evaluator, "#!/bin/sh\nprintf '%s\\n' 'VERDICT: met' 'REASON: current evidence matches'\n", { mode: 0o700 })
  const verified = await create(loopConfig('finish with proof', {
    done: { check: { command: 'true', timeoutSeconds: 5, runWhen: 'on-claim' }, evaluator: { condition: 'The assistant printed the done marker.' } },
    caps: { maxIterations: 1 }
  }))
  const completed = await rig.waitForLoop(verified.id, (loop) => loop.state === 'completed')
  expect(completed.recentIterations[0]?.check?.pass).toBe(true)
  expect(completed.recentIterations[0]?.evaluator?.verdict).toBe('met')
  writeFileSync(evaluator, "#!/bin/sh\nprintf '%s\\n' 'not a verdict'\n", { mode: 0o700 })
  const invalid = await create(loopConfig('finish with unverifiable proof', {
    done: { check: { command: 'true', timeoutSeconds: 5, runWhen: 'every-iteration' }, evaluator: { condition: 'The assistant finished.' } }, caps: { maxIterations: 1 }
  }))
  const paused = await rig.waitForLoop(invalid.id, (loop) => loop.state === 'paused')
  expect(paused.pauseReason).toBe('cap-iterations')
  expect(paused.recentIterations[0]?.evaluator).toEqual({ verdict: 'not-met', reason: 'evaluator-unparseable' })
}, 20_000)

test('L14-L15: current git changes are measured and a protected path prevents checkpointing', async () => {
  rig = await startLoopRig({ script: ({ session }) => {
    mkdirSync(join(session.cwd, 'secret'), { recursive: true })
    writeFileSync(join(session.cwd, 'secret', 'token'), 'protected change\n')
    return 'not finished'
  } })
  const originalHead = git('rev-parse', 'HEAD')
  const originalIndex = readFileSync(join(rig.cwd, '.git', 'index'))
  const loop = await create(loopConfig('touch a protected path', { protectedPaths: ['secret/**'], checkpointCommits: true, caps: { maxIterations: 3 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused')
  expect(paused.pauseReason).toBe('protected-path')
  expect(paused.recentIterations[0]?.protectedPathHits).toEqual(['secret/token'])
  expect(paused.recentIterations[0]?.diff?.files).toContain('secret/token')
  expect(paused.recentIterations[0]?.checkpointCommit).toBeNull()
  expect(git('rev-parse', 'HEAD')).toBe(originalHead)
  expect(readFileSync(join(rig.cwd, '.git', 'index'))).toEqual(originalIndex)
}, 15_000)

test('L16: checkpoints leave unrelated pre-staged work outside the iteration commit', async () => {
  rig = await startLoopRig({ script: ({ session }) => {
    writeFileSync(join(session.cwd, 'iteration.txt'), 'agent-owned change\n')
    return 'not finished'
  } })
  writeFileSync(join(rig.cwd, 'unrelated.txt'), 'person-owned staged work\n')
  git('add', 'unrelated.txt')
  const loop = await create(loopConfig('checkpoint the current turn', { checkpointCommits: true, caps: { maxIterations: 1 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused')
  const checkpoint = paused.recentIterations[0]?.checkpointCommit
  expect(checkpoint).toBe(git('rev-parse', 'HEAD'))
  expect(git('show', '--format=', '--name-only', 'HEAD')).toBe('iteration.txt')
  expect(git('diff', '--cached', '--name-only')).toBe('unrelated.txt')
  expect(git('show', 'HEAD:iteration.txt')).toBe('agent-owned change')
}, 15_000)

test('L17: three unchanged failed-check turns pause for no progress through the public API', async () => {
  rig = await startLoopRig({ script: () => 'still working' })
  const loop = await create(loopConfig('repeat without changes', {
    noProgress: true, done: { check: { command: 'printf unchanged; exit 1', timeoutSeconds: 5, runWhen: 'every-iteration' } }, caps: { maxIterations: 5 }
  }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused', 15_000)
  expect(paused.pauseReason).toBe('no-progress')
  expect(paused.iterationsCompleted).toBe(3)
  expect(paused.recentIterations.map((iteration) => iteration.check?.stdoutTail)).toEqual(['unchanged', 'unchanged', 'unchanged'])
}, 20_000)

test('L18: measurable cumulative native USD reaches its cost cap instead of staying unavailable', async () => {
  rig = await startLoopRig({ script: ({ context, session }) => {
    context.appendMessage({ sessionId: session.id, role: 'result', text: 'native usage', data: { total_cost_usd: 0.75 } })
    return 'not finished'
  } })
  const loop = await create(loopConfig('work within a budget', { caps: { maxCostUsd: 0.5 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused')
  expect(paused.pauseReason).toBe('cap-cost')
  expect(paused.pauseDetail).toBeNull()
  expect(paused.costUsd).toBe(0.75)
  expect(paused.recentIterations[0]?.costUsd).toBe(0.75)
}, 15_000)

test('L19: reset-aware loops hold for the remaining grace then continue without a manual resume', async () => {
  let turns = 0
  let releaseAt = 0
  rig = await startLoopRig({ script: ({ context, session }) => {
    turns++
    if (turns === 1) {
      releaseAt = Date.now() + 1_500
      context.appendMessage({ sessionId: session.id, role: 'system', text: 'native usage limit', data: {
        type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: releaseAt - 60_000 }
      } })
    } else expect(Date.now()).toBeGreaterThanOrEqual(releaseAt)
    return 'not finished'
  } })
  const loop = await create(loopConfig('continue after usage reset', { resumeAtLimitReset: true, caps: { maxIterations: 2 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused', 15_000)
  expect(paused.pauseReason).toBe('cap-iterations')
  expect(paused.iterationsCompleted).toBe(2)
  expect(paused.recentIterations[0]?.usageLimit?.provider).toBe('claude')
  expect(turns).toBe(2)
}, 20_000)

test('L07: two provider crashes retry the same iteration once and then pause without counting either attempt', async () => {
  rig = await startLoopRig({ script: () => ({ error: new Error('native turn crashed') }) })
  const loop = await create(loopConfig('retry a crashed turn', { caps: { maxIterations: 3 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused')
  expect(paused.pauseReason).toBe('crashed')
  expect(paused.iterationsCompleted).toBe(0)
  const history = await rig.call<{ n: number; attempt: number; endReason: string; sessionId: string }[]>('quirky.loops/iterations', { loopId: loop.id })
  expect(history.map(({ n, attempt, endReason }) => ({ n, attempt, endReason }))).toEqual([
    { n: 1, attempt: 1, endReason: 'crashed' },
    { n: 1, attempt: 2, endReason: 'crashed' }
  ])
  expect(history[0]?.sessionId).not.toBe(history[1]?.sessionId)
}, 15_000)

test('L21: operator notes survive a fresh-session resume without being overwritten', async () => {
  rig = await startLoopRig({ script: () => 'continue working' })
  const loop = await create(loopConfig('preserve durable notes', { caps: { maxIterations: 1 } }))
  const paused = await rig.waitForLoop(loop.id, (current) => current.state === 'paused')
  const notes = readFileSync(paused.notesPath, 'utf8') + 'Operator guidance preserved across fresh sessions.\n'
  writeFileSync(paused.notesPath, notes)
  await rig.call('quirky.loops/resume', { loopId: loop.id, addIterations: 1 })
  const resumed = await rig.waitForLoop(loop.id, (current) => current.state === 'paused' && current.iterationsCompleted === 2)
  expect(resumed.pauseReason).toBe('cap-iterations')
  expect(readFileSync(resumed.notesPath, 'utf8')).toBe(notes)
  expect(resumed.recentIterations[0]?.sessionId).not.toBe(resumed.recentIterations[1]?.sessionId)
}, 15_000)
