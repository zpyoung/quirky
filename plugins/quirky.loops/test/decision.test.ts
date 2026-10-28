import { describe, expect, test } from 'bun:test'
import type { DecisionInput, IterationDetail, LoopConfig, LoopSnapshot } from '../src/types'
import { decideNext } from '../src/decision'

const config = (patch: Partial<LoopConfig> = {}): LoopConfig => ({
  promptSource: { kind: 'repeat', body: 'finish the task' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'continue',
  done: { check: { command: 'test -f result.txt', timeoutSeconds: 300, runWhen: 'every-iteration' } },
  caps: {},
  noProgress: false,
  protectedPaths: [],
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false,
  ...patch
})

const loop = (patch: Partial<LoopSnapshot> = {}): LoopSnapshot => {
  const configValue = patch.config ?? config()
  return {
    id: 'loop-1', name: 'Build', slug: 'build-loop-1', worktreeId: 'wt-1', cwd: '/tmp/work', workspaceKind: 'git',
    agent: 'claude', preset: 'until-done', config: configValue, state: 'running', pauseReason: null, pauseDetail: null,
    sessionId: 'session-1', iterationsCompleted: 0, activeMs: 0, costUsd: 0, phase: null, nextIterationAt: null,
    createdAt: 1, updatedAt: 1, endedAt: null, notesPath: '/tmp/work/.quirky/loops/build/notes.md', warnings: [], recentIterations: [],
    ...patch
  }
}

const attempt = (patch: Partial<IterationDetail> = {}): IterationDetail => {
  const configValue = patch.doneConfig ?? config().done
  return {
    loopId: 'loop-1', n: 1, attempt: 1, sessionId: 'session-1', promptSent: 'finish the task', startedAt: 1, endedAt: 2,
    endReason: 'settled', doneConfig: configValue,
    check: { ran: true, pass: false, exitCode: 1, timedOut: false, stdoutTail: '', stderrTail: '', durationMs: 1 },
    evaluator: null, markers: { done: false }, diff: { added: 0, removed: 0, files: [] }, treeBefore: 'tree-a', treeAfter: 'tree-b',
    protectedPathHits: [], checkpointCommit: null, costUsd: 0, usageLimit: null, outputTail: '',
    ...patch
  }
}

const decide = (patch: Partial<DecisionInput> = {}) => {
  const currentLoop = patch.loop ?? loop()
  return decideNext({ loop: currentLoop, latest: attempt(), history: [attempt()], now: 10, userIdle: true, agentIdle: true, ...patch })
}

describe('decideNext precedence and completion', () => {
  test('stop request wins before every other decision', () => {
    expect(decide({ stopRequested: true, pauseRequested: true, unverifiable: true })).toEqual({ kind: 'stop' })
  })

  test('user pause wins before unverifiable and settlement evidence', () => {
    expect(decide({ pauseRequested: true, unverifiable: true })).toEqual({ kind: 'pause', reason: 'user' })
  })

  test('unverifiable connection waits before evaluating the latest attempt', () => {
    expect(decide({ unverifiable: true })).toEqual({ kind: 'wait', reason: 'unverifiable' })
  })

  test('retries a first crash once in a fresh session', () => {
    expect(decide({ latest: attempt({ attempt: 1, endReason: 'crashed' }) })).toEqual({ kind: 'retry-crashed' })
  })

  test('pauses after the second crash of the same iteration', () => {
    expect(decide({ latest: attempt({ attempt: 2, endReason: 'crashed' }) })).toEqual({ kind: 'pause', reason: 'crashed' })
  })

  test('interrupted, stopped, and unverifiable attempts never use completion evidence', () => {
    expect(decide({ latest: attempt({ endReason: 'interrupted' }) })).toEqual({ kind: 'pause', reason: 'interrupted-by-restart' })
    expect(decide({ latest: attempt({ endReason: 'stopped' }) })).toEqual({ kind: 'pause', reason: 'user' })
    expect(decide({ latest: attempt({ endReason: 'unverifiable' }) })).toEqual({ kind: 'wait', reason: 'unverifiable' })
  })

  test('requires an exact current done config and every configured completion signal', () => {
    const done = { check: { command: 'test -f result.txt', timeoutSeconds: 300, runWhen: 'every-iteration' as const }, evaluator: { condition: 'result is correct' } }
    const current = loop({ config: config({ done }) })
    const evidence = attempt({
      doneConfig: done,
      check: { ran: true, pass: true, exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '', durationMs: 1 },
      evaluator: { verdict: 'met', reason: 'verified' }
    })
    expect(decide({ loop: current, latest: evidence })).toEqual({ kind: 'complete' })
    expect(decide({ loop: current, latest: attempt({ ...evidence, evaluator: { verdict: 'not-met', reason: 'missing' } }) }).kind).not.toBe('complete')
    expect(decide({ loop: loop({ config: config({ done: {} }) }), latest: attempt({ doneConfig: {}, markers: { done: true }, check: null }) }).kind).not.toBe('complete')
    expect(decide({ loop: current, latest: attempt({ ...evidence, check: { ...evidence.check!, error: 'provider error' } }) }).kind).not.toBe('complete')
  })

  test('on-claim check requires the current iteration done marker', () => {
    const done = { check: { command: 'test -f result.txt', timeoutSeconds: 300, runWhen: 'on-claim' as const } }
    const current = loop({ config: config({ done }) })
    const passedCheck = { ran: true, pass: true, exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '', durationMs: 1 }
    expect(decide({ loop: current, latest: attempt({ doneConfig: done, check: passedCheck, markers: { done: false } }) }).kind).not.toBe('complete')
    expect(decide({ loop: current, latest: attempt({ doneConfig: done, check: passedCheck, markers: { done: true } }) })).toEqual({ kind: 'complete' })
  })

  test('verified completion precedes protected paths, markers, and caps', () => {
    const currentConfig = config({ caps: { maxIterations: 1 }, done: { evaluator: { condition: 'done' } } })
    const current = loop({ config: currentConfig, iterationsCompleted: 1 })
    const evidence = attempt({
      doneConfig: currentConfig.done,
      check: null,
      evaluator: { verdict: 'met', reason: 'done' },
      markers: { done: true, blocked: 'wait for me' },
      protectedPathHits: ['secret/key']
    })
    expect(decide({ loop: current, latest: evidence })).toEqual({ kind: 'complete' })
  })

  test('stale done configuration and LOOP_DONE alone never complete', () => {
    const current = loop({ config: config({ done: { check: { command: 'new-check', timeoutSeconds: 300, runWhen: 'every-iteration' } } }) })
    expect(decide({ loop: current, latest: attempt({ markers: { done: true } }) }).kind).not.toBe('complete')
  })

  test('protected paths pause before marker and cap decisions', () => {
    const current = loop({ config: config({ caps: { maxIterations: 1 } }), iterationsCompleted: 1 })
    expect(decide({ loop: current, latest: attempt({ protectedPathHits: ['secret/key'], markers: { done: false, blocked: 'blocked' } }) })).toEqual({ kind: 'pause', reason: 'protected-path', detail: 'secret/key' })
  })

  test('blocked and decide markers pause before caps', () => {
    const current = loop({ config: config({ caps: { maxIterations: 1 } }), iterationsCompleted: 1 })
    expect(decide({ loop: current, latest: attempt({ markers: { done: false, blocked: 'need access' } }) })).toEqual({ kind: 'pause', reason: 'agent-blocked', detail: 'need access' })
    expect(decide({ loop: current, latest: attempt({ markers: { done: false, decide: 'which one?' } }) })).toEqual({ kind: 'pause', reason: 'agent-decide', detail: 'which one?' })
  })
})

describe('decideNext caps, progress, and holds', () => {
  test('iteration and active-time caps apply before no-progress', () => {
    const current = loop({ config: config({ caps: { maxIterations: 2, maxActiveMinutes: 1 }, noProgress: true }), iterationsCompleted: 2, activeMs: 60_000 })
    const repeated = [1, 2, 3].map((n) => attempt({ n, treeBefore: 'same', treeAfter: 'same', diff: { added: 0, removed: 0, files: [] } }))
    expect(decide({ loop: current, latest: repeated[2]!, history: repeated })).toEqual({ kind: 'pause', reason: 'cap-iterations' })
    expect(decide({ loop: loop({ config: config({ caps: { maxActiveMinutes: 1 } }), activeMs: 60_000 }), latest: attempt() })).toEqual({ kind: 'pause', reason: 'cap-time' })
  })

  test('unknown accumulated cost fails closed after a settled turn', () => {
    const current = loop({ config: config({ caps: { maxCostUsd: 1 } }), costUsd: null, iterationsCompleted: 1 })
    expect(decide({ loop: current, latest: attempt({ costUsd: null }) })).toEqual({ kind: 'pause', reason: 'cap-cost', detail: 'usage-unavailable' })
  })

  test('known cost cap pauses at the exact boundary', () => {
    expect(decide({ loop: loop({ config: config({ caps: { maxCostUsd: 2 } }), costUsd: 2 }) })).toEqual({ kind: 'pause', reason: 'cap-cost' })
  })

  test('three unchanged settled Git attempts with identical check evidence trigger no-progress', () => {
    const current = loop({ config: config({ noProgress: true }), iterationsCompleted: 3 })
    const history = [1, 2, 3].map((n) => attempt({ n, treeBefore: 'same', treeAfter: 'same', diff: { added: 0, removed: 0, files: [] } }))
    expect(decide({ loop: current, latest: history[2]!, history })).toEqual({ kind: 'pause', reason: 'no-progress' })
  })

  test('changed tree or changed check output resets no-progress comparison', () => {
    const current = loop({ config: config({ noProgress: true }), iterationsCompleted: 3 })
    const history = [1, 2, 3].map((n) => attempt({ n, treeBefore: 'same', treeAfter: 'same', diff: { added: 0, removed: 0, files: [] } }))
    expect(decide({ loop: current, latest: history[2]!, history: [history[0]!, { ...history[1]!, treeAfter: 'changed' }, history[2]!] }).kind).not.toBe('pause')
    expect(decide({ loop: current, latest: history[2]!, history: [history[0]!, { ...history[1]!, check: { ...history[1]!.check!, stdoutTail: 'different' } }, history[2]!] }).kind).not.toBe('pause')
  })

  test('unchanged folder iterations require actual check evidence', () => {
    const current = loop({ workspaceKind: 'folder', config: config({ noProgress: true }), iterationsCompleted: 3 })
    const empty = [1, 2, 3].map((n) => attempt({ n, treeBefore: null, treeAfter: null, diff: null, check: null }))
    expect(decide({ loop: current, latest: empty[2]!, history: empty }).kind).not.toBe('pause')
    const checked = empty.map((item) => ({ ...item, check: { ran: true, pass: false, exitCode: 1, timedOut: false, stdoutTail: 'waiting', stderrTail: '', durationMs: 1 } }))
    expect(decide({ loop: current, latest: checked[2]!, history: checked })).toEqual({ kind: 'pause', reason: 'no-progress' })
  })

  test('usage-limit reset waits through the explicit reset plus grace interval', () => {
    const current = loop({ config: config({ resumeAtLimitReset: true }) })
    const latest = attempt({ usageLimit: { provider: 'claude', resetsAt: 50 } })
    expect(decide({ loop: current, latest, now: 100 })).toEqual({ kind: 'wait', reason: 'usage-limit-reset', until: 60_050 })
  })

  test('usage limit pauses when reset is unknown or resume-at-reset is disabled', () => {
    expect(decide({ latest: attempt({ usageLimit: { provider: 'codex', resetsAt: null } }) })).toEqual({ kind: 'pause', reason: 'usage-limit', detail: 'codex' })
    expect(decide({ loop: loop(), latest: attempt({ usageLimit: { provider: 'claude', resetsAt: 50 } }) })).toEqual({ kind: 'pause', reason: 'usage-limit', detail: new Date(50).toISOString() })
    expect(decide({ loop: loop({ config: config({ resumeAtLimitReset: true }) }), latest: attempt({ usageLimit: { provider: 'codex', resetsAt: Number.MAX_VALUE } }), now: 0 })).toEqual({ kind: 'pause', reason: 'usage-limit', detail: 'codex' })
  })

  test('ask-before-next precedes user and agent idle holds', () => {
    const current = loop({ config: config({ askBeforeNext: true }) })
    expect(decide({ loop: current, latest: attempt(), userIdle: false, agentIdle: false })).toEqual({ kind: 'pause', reason: 'ask-before-next' })
  })

  test('resume clears the held iteration so ask-before-next pauses only after a new turn', () => {
    const current = loop({ config: config({ askBeforeNext: true }), iterationsCompleted: 3 })
    const history = [1, 2, 3].map((n) => attempt({ n }))
    expect(decide({ loop: current, latest: null, history })).toEqual({ kind: 'start-iteration', freshSession: false })
    expect(decide({ loop: current, latest: attempt({ n: 4 }), history: [...history, attempt({ n: 4 })] })).toEqual({ kind: 'pause', reason: 'ask-before-next' })
  })

  test('waits for user then agent idle before starting the next iteration', () => {
    expect(decide({ userIdle: false })).toEqual({ kind: 'wait', reason: 'user-idle' })
    expect(decide({ agentIdle: false })).toEqual({ kind: 'wait', reason: 'agent-idle' })
  })

  test('starts with configured session freshness when all holds are clear', () => {
    expect(decide({ latest: null })).toEqual({ kind: 'start-iteration', freshSession: false })
    expect(decide({ loop: loop({ config: config({ sessionPolicy: 'fresh' }) }), latest: null })).toEqual({ kind: 'start-iteration', freshSession: true })
  })
})
