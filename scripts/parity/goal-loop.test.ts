import { expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'

const repoRoot = join(import.meta.dir, '../..')
const stepIds = [
  'worktrees-create', 'agents-launch', 'terminals-roundtrip', 'loop-run-stop',
  'ask-answer-cancel', 'accounts-usage', 'worktrees-remove'
]

type Step = {
  id: string
  status: string
  elapsedMs: number
  evidence: Record<string, any>
  error?: Record<string, unknown>
}

test('goal loop rehearsal proves worktree, terminal, loop, Ask, usage and cleanup behavior', async () => {
  const scope = createProcessScope()
  const env = createIsolatedRuntimeEnvironment(scope.home, { repoRoot })
  mkdirSync(env.TMPDIR!, { recursive: true })
  try {
    const child = scope.spawn([process.execPath, join(import.meta.dir, 'goal-loop.ts'), '--json'], {
      cwd: repoRoot, env, stdout: 'pipe', stderr: 'pipe', timeout: 125_000
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited
    ])
    expect(exitCode, `${stderr}\n${stdout}`).toBe(0)
    const report = JSON.parse(stdout) as {
      schemaVersion: number
      scope: string
      ok: boolean
      providerMode: string
      steps: Step[]
      cleanup: { ok: boolean; error?: string }
      elapsedMs: number
    }
    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: 'goal-12-loop',
      ok: true,
      providerMode: 'local-stand-ins',
      cleanup: { ok: true }
    })
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(report.elapsedMs).toBeLessThanOrEqual(120_000)
    expect(report.steps.map(step => step.id)).toEqual(stepIds)
    expect(report.steps.every(step => step.status === 'passed' && step.elapsedMs >= 0)).toBe(true)
    expect(stdout).not.toContain(scope.home)
    expect(stdout).not.toContain('fixture-token-not-a-credential')

    const evidence = (id: string) => report.steps.find(step => step.id === id)!.evidence
    const worktrees = evidence('worktrees-create').worktrees as Array<Record<string, any>>
    expect(worktrees.map(worktree => worktree.name)).toEqual(['goal-fixture-a', 'goal-fixture-b'])
    expect(new Set(worktrees.map(worktree => worktree.id)).size).toBe(2)
    expect(worktrees.map(worktree => worktree.baseHead === worktree.head)).toEqual([true, true])
    expect(worktrees).toEqual(expect.arrayContaining([
      expect.objectContaining({ base: 'main', parentId: null }),
      expect.objectContaining({ base: 'main', parentId: null })
    ]))
    expect(evidence('worktrees-create').daemonPid).toBeGreaterThan(0)
    expect(evidence('agents-launch').ptyPid).toBeGreaterThan(0)

    const launches = evidence('agents-launch').sessions as Array<Record<string, any>>
    expect(launches.map(session => ({
      prompt: session.prompt,
      worktreeName: session.worktreeName,
      kind: session.kind,
      parentId: session.parentId,
      argvPromptCount: session.argvPromptCount,
      terminalPromptCount: session.terminalPromptCount,
      terminalQuoteCount: session.terminalQuoteCount
    }))).toEqual([
      {
        prompt: 'fixture-initial-a', worktreeName: 'goal-fixture-a', kind: 'terminal', parentId: null,
        argvPromptCount: 1, terminalPromptCount: 1, terminalQuoteCount: 1
      },
      {
        prompt: 'fixture-initial-b', worktreeName: 'goal-fixture-b', kind: 'terminal', parentId: null,
        argvPromptCount: 1, terminalPromptCount: 1, terminalQuoteCount: 1
      }
    ])
    expect(launches.map(session => session.worktreeId)).toEqual(worktrees.map(worktree => worktree.id))
    for (const session of launches) {
      expect(session.id).toBeTruthy()
      expect(session.worktreeId).toBeTruthy()
      expect(session.terminalQuote).toBe(`PROMPT:${session.prompt}:${session.id}`)
    }

    const terminalEvidence = evidence('terminals-roundtrip')
    expect(terminalEvidence).toMatchObject({
      scopedSessionLists: { aContainsOnlyA: true, bContainsOnlyB: true },
      nudge: {
        text: 'fixture-nudge-a', sendReceiptReceived: true, inputLines: ['fixture-nudge-a'],
        ackQuote: 'ACK:fixture-nudge-a', ackCountA: 1, ackCountB: 0
      },
      shell: {
        input: 'fixture-shell-input', sendReceiptReceived: true,
        ackQuote: 'ACK:fixture-shell-input', ackCount: 1
      }
    })

    const loopEvidence = evidence('loop-run-stop')
    expect(loopEvidence).toMatchObject({
      capped: {
        sessionId: expect.any(String),
        prompt: 'fixture-loop-tick', iterationsCompleted: 1, state: 'paused',
        pauseReason: 'cap-iterations', turnStartCount: 1, promptCount: 1,
        outputQuote: expect.stringContaining('fixture-loop-tick'), outputQuoteCount: 1
      },
      ordinaryStop: { state: 'stopped' },
      interrupt: {
        sessionId: expect.any(String),
        state: 'stopped', activeTurnObserved: true,
        interruptRequestCount: 1, extraTurnStartCount: 0
      }
    })
    expect(['interrupted', 'stopped']).toContain((loopEvidence.interrupt as Record<string, any>).turnOutcome)
    const loopSessionIds = [
      (loopEvidence.capped as Record<string, any>).sessionId,
      (loopEvidence.interrupt as Record<string, any>).sessionId
    ]

    const asks = evidence('ask-answer-cancel')
    const answered = asks.answered as Record<string, any>
    expect(answered.askId).toBeTruthy()
    expect(answered.events).toEqual([
      { status: 'registered', askId: answered.askId },
      { status: 'pending', askId: answered.askId }
    ])
    expect(answered.wait).toEqual({ status: 'answered', askId: answered.askId, answers: { continue: { value: true, source: 'input' } }, skipped: [] })
    const cancelled = asks.cancelled as Record<string, any>
    expect(cancelled.askId).toBeTruthy()
    expect(cancelled.askId).not.toBe(answered.askId)
    expect(cancelled.wait).toMatchObject({ status: 'declined', askId: cancelled.askId })

    expect(evidence('accounts-usage')).toMatchObject({
      standIns: true,
      providerAuthenticationExercised: false,
      managedAccounts: [],
      codexConsumeCalls: 0,
      egressAttempts: 0,
      orcaInvocations: 0,
      antigravityArgv: [
        ['--version'],
        ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']
      ],
      providers: {
        codex: {
          status: 'ok',
          session: { usedPercent: 31, resetsAt: 1_893_456_000_000 },
          weekly: { usedPercent: 12, resetsAt: 1_893_456_000_000 },
          resetCreditsAvailable: 1
        },
        antigravity: {
          status: 'ok',
          session: { usedPercent: 25, resetsAt: 1_893_456_000_000 },
          weekly: { usedPercent: 60, resetsAt: 1_893_456_000_000 }
        },
        claude: {
          status: 'unavailable', session: null, weekly: null,
          refreshedStatus: 'unavailable', refreshedSession: null, refreshedWeekly: null
        }
      }
    })

    const removal = evidence('worktrees-remove')
    const createdIds = worktrees.map(worktree => worktree.id)
    expect(removal.removedWorktreeIds).toEqual(createdIds)
    expect(removal.tabsAbsentFromLayout).toBe(true)
    const shellEvidence = terminalEvidence.shell as Record<string, any>
    expect(removal.closedSessionIds).toEqual(expect.arrayContaining([
      ...launches.map(session => session.id), shellEvidence.sessionId, ...loopSessionIds
    ]))
    expect(removal.closedTabIds).toContain(shellEvidence.tabId)
    expect(removal.remainingWorktreeIds).not.toEqual(expect.arrayContaining(createdIds))
    const retainedBranches = removal.retainedBranches as Array<Record<string, any>>
    expect(retainedBranches.every(branch => branch.deletedThroughCli === true && !!branch.name && !!branch.head)).toBe(true)
  } finally {
    await scope.cleanup()
  }
}, 135_000)
