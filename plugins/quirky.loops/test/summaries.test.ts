import { afterEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type CliArgs, type CliContext, type CliModule, type RpcError } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import type { LoopConfig, LoopSnapshot } from '../src/types'
import { loopConfig, startLoopRig, type LoopRig } from './rig'

let rig: LoopRig | undefined
let releaseRunningTurn: (() => void) | undefined

afterEach(async () => {
  try {
    if (rig) {
      const loops = await rig.call<LoopSnapshot[]>('quirky.loops/list', {})
      for (const loop of loops) {
        if (loop.state === 'running' || loop.state === 'needs-you' || loop.state === 'paused') {
          await rig.call('quirky.loops/stop', { loopId: loop.id, mode: 'now' })
        }
      }
    }
  } finally {
    releaseRunningTurn?.()
    await rig?.cleanup()
    rig = undefined
    releaseRunningTurn = undefined
  }
})

type CreatedLoop = { id: string; worktreeId: string }
type SummaryRow = Record<string, unknown>

const PRIVATE_RUNNING_PROMPT = 'SUMMARY_PRIVATE_RUNNING_PROMPT_7C'
const PRIVATE_NEEDS_YOU_PROMPT = 'SUMMARY_PRIVATE_APPROVAL_PROMPT_7C'
const PRIVATE_PAUSED_PROMPT = 'SUMMARY_PRIVATE_PAUSED_PROMPT_7C'
const PRIVATE_ENDED_PROMPT = 'SUMMARY_PRIVATE_ENDED_PROMPT_7C'
const PRIVATE_QUEUE_FIRST = 'SUMMARY_PRIVATE_QUEUE_FIRST_7C'
const PRIVATE_QUEUE_REMAINDER = 'SUMMARY_PRIVATE_QUEUE_REMAINDER_7C'
const PRIVATE_OUTPUT = 'SUMMARY_PRIVATE_ITERATION_OUTPUT_7C'

function createRepeat(worktreeId: string, body: string, patch: Partial<LoopConfig> = {}): Promise<CreatedLoop> {
  return rig!.call<CreatedLoop>('quirky.loops/create', {
    worktreeId,
    agent: 'claude',
    config: loopConfig(body, patch)
  })
}

function createQueue(worktreeId: string): Promise<CreatedLoop> {
  return rig!.call<CreatedLoop>('quirky.loops/create', {
    worktreeId,
    agent: 'claude',
    preset: 'queue',
    queueItems: [{ body: PRIVATE_QUEUE_FIRST }, { body: PRIVATE_QUEUE_REMAINDER }],
    config: loopConfig('unused queue prompt', {
      promptSource: { kind: 'queue', repeatQueue: false },
      askBeforeNext: true
    })
  })
}

async function failure(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the public loop API call to reject')
}

async function runSummaries(json: boolean): Promise<string[]> {
  const handler = (commands as CliModule['commands']).summaries
  if (!handler) throw new Error('missing loop CLI command summaries')
  const { context, lines } = rig!.cliContext(json)
  await handler({ positionals: [], flags: {} } satisfies CliArgs, context satisfies CliContext)
  return lines
}

describe('quirky loop summaries', () => {
  test('the daemon returns only unfinished compact rows for real running, needs-you, paused, and queued loops', async () => {
    const runningTurn = Promise.withResolvers<void>()
    let runningSessionId: string | undefined
    releaseRunningTurn = () => runningTurn.resolve()
    rig = await startLoopRig({
      script: async ({ text, context, session }) => {
        if (text.includes(PRIVATE_RUNNING_PROMPT)) {
          runningSessionId = session.id
          await runningTurn.promise
          return 'LOOP_BLOCKED: release the summary fixture'
        }
        if (text.includes(PRIVATE_NEEDS_YOU_PROMPT)) {
          const waiting = context.createAsk?.({
            questions: [{ id: 'continue', type: 'confirm', question: 'Continue the summary fixture?' }]
          }, session.id)
          if (!waiting) throw new Error('the structured runner did not expose ask creation')
          void waiting.then(() => context.setStatus(session.id, 'done')).catch(() => {})
          return { text: 'Waiting for the summary fixture approval', status: 'waiting' }
        }
        return PRIVATE_OUTPUT
      },
      onStop: (sessionId) => {
        if (sessionId === runningSessionId) runningTurn.resolve()
      }
    })

    const otherWorktree = await rig.call<{ worktree: { id: string } }>('quirky.worktree/create', {
      repo: rig.worktree.repoId,
      name: 'summary-other'
    })
    expect(otherWorktree.worktree.id).not.toBe(rig.worktree.id)

    const running = await createRepeat(rig.worktree.id, PRIVATE_RUNNING_PROMPT)
    await rig.waitForLoop(running.id, (snapshot) => snapshot.state === 'running')
    await waitFor(() => rig!.sends.some((send) => send.text.includes(PRIVATE_RUNNING_PROMPT)) || undefined, 10_000)
    expect(rig.sends.some((send) => send.text.includes(PRIVATE_RUNNING_PROMPT))).toBe(true)

    const needsYou = await createRepeat(rig.worktree.id, PRIVATE_NEEDS_YOU_PROMPT, { caps: { maxIterations: 4 } })
    await rig.waitForLoop(needsYou.id, (snapshot) => snapshot.state === 'needs-you')

    const paused = await createRepeat(otherWorktree.worktree.id, PRIVATE_PAUSED_PROMPT, {
      caps: { maxIterations: 1 }
    })
    const pausedSnapshot = await rig.waitForLoop(paused.id, (snapshot) => snapshot.state === 'paused')
    expect(pausedSnapshot.config.promptSource).toEqual({ kind: 'repeat', body: PRIVATE_PAUSED_PROMPT })
    expect(JSON.stringify(await rig.call<unknown[]>('quirky.loops/iterations', { loopId: paused.id }))).toContain(PRIVATE_OUTPUT)

    const queued = await createQueue(otherWorktree.worktree.id)
    const queuedSnapshot = await rig.waitForLoop(queued.id, (snapshot) => snapshot.state === 'paused' && snapshot.pauseReason === 'ask-before-next')
    expect(queuedSnapshot.queueItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: PRIVATE_QUEUE_REMAINDER, state: 'pending' })
    ]))

    const ended = await createRepeat(rig.worktree.id, PRIVATE_ENDED_PROMPT, { caps: { maxIterations: 1 } })
    await rig.waitForLoop(ended.id, (snapshot) => snapshot.state === 'paused')
    await rig.call('quirky.loops/stop', { loopId: ended.id, mode: 'now' })
    expect((await rig.snapshot(ended.id)).state).toBe('stopped')
    expect((await rig.call<LoopSnapshot[]>('quirky.loops/list', {})).some((snapshot) => snapshot.id === ended.id)).toBe(true)

    const rows = await rig.call<SummaryRow[]>('quirky.loops/summaries', {})
    const expectedIds = [running.id, needsYou.id, paused.id, queued.id]
    expect(rows.map((row) => row.id).sort()).toEqual(expectedIds.sort())

    const rowById = new Map(rows.map((row) => [String(row.id), row]))
    expect(rowById.get(running.id)).toMatchObject({
      id: running.id,
      worktreeId: rig.worktree.id,
      state: 'running',
      pauseReason: null,
      iterationsCompleted: 0,
      maxIterations: null
    })
    expect(rowById.get(needsYou.id)).toMatchObject({
      id: needsYou.id,
      worktreeId: rig.worktree.id,
      state: 'needs-you',
      pauseReason: null,
      iterationsCompleted: 0,
      maxIterations: 4
    })
    expect(rowById.get(paused.id)).toMatchObject({
      id: paused.id,
      worktreeId: otherWorktree.worktree.id,
      state: 'paused',
      pauseReason: 'cap-iterations',
      iterationsCompleted: 1,
      maxIterations: 1
    })
    expect(rowById.get(queued.id)).toMatchObject({
      id: queued.id,
      worktreeId: otherWorktree.worktree.id,
      state: 'paused',
      pauseReason: 'ask-before-next',
      iterationsCompleted: 1,
      maxIterations: null
    })

    const publicKeys = ['id', 'worktreeId', 'state', 'pauseReason', 'iterationsCompleted', 'maxIterations', 'updatedAt'].sort()
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(publicKeys)
      expect(typeof row.updatedAt).toBe('number')
    }
    const sorted = [...rows].sort((left, right) =>
      Number(right.updatedAt) - Number(left.updatedAt) || String(left.id).localeCompare(String(right.id))
    )
    expect(rows.map((row) => row.id)).toEqual(sorted.map((row) => row.id))

    const serialized = JSON.stringify(rows)
    for (const privateValue of [
      PRIVATE_RUNNING_PROMPT,
      PRIVATE_NEEDS_YOU_PROMPT,
      PRIVATE_PAUSED_PROMPT,
      PRIVATE_ENDED_PROMPT,
      PRIVATE_OUTPUT,
      PRIVATE_QUEUE_FIRST,
      PRIVATE_QUEUE_REMAINDER,
      rig.cwd
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    expect(rowById.has(ended.id)).toBe(false)
  }, 60_000)

  test('the daemon summaries method rejects any parameter beyond the required empty object', async () => {
    rig = await startLoopRig()
    const error = await failure(rig.call('quirky.loops/summaries', { includeEnded: true }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  }, 30_000)

  test('the summaries CLI emits equivalent JSON rows and text that identifies workspace, loop, state, and count/cap', async () => {
    rig = await startLoopRig({ script: () => PRIVATE_OUTPUT })
    const loop = await createRepeat(rig.worktree.id, PRIVATE_PAUSED_PROMPT, { caps: { maxIterations: 1 } })
    await rig.waitForLoop(loop.id, (snapshot) => snapshot.state === 'paused')

    const jsonLines = await runSummaries(true)
    const cliRows = JSON.parse(jsonLines[0]!) as SummaryRow[]
    const apiRows = await rig.call<SummaryRow[]>('quirky.loops/summaries', {})
    expect(cliRows).toEqual(apiRows)
    expect(cliRows).toHaveLength(1)
    expect(cliRows[0]).toMatchObject({
      id: loop.id,
      worktreeId: rig.worktree.id,
      state: 'paused',
      pauseReason: 'cap-iterations',
      iterationsCompleted: 1,
      maxIterations: 1
    })

    const text = (await runSummaries(false)).join('\n')
    expect(text).toContain(loop.id)
    expect(text.includes(rig.worktree.id) || text.includes(rig.worktree.name)).toBe(true)
    expect(text).toContain('paused')
    expect(text).toContain('cap-iterations')
    expect(text).toMatch(/\b1\s*\/\s*1\b/)
  }, 30_000)
})
