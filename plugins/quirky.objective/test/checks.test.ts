import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, RunOptions } from '@quirky/protocol'
import type { ObjectivePayload } from '../src/contract'
import type { ObjectiveStore } from '../src/store'
import { baselineProblems, captureContentIdentity, runCriterionCheck, runEnrollmentGate, type ObjectiveRuntime } from '../src/checks'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

type CheckRow = {
  attemptId: string; watcherId: string; revision: number; kind: 'criterion' | 'gate'; targetKey: string
  contentIdentity: string; command: string; status: 'passed' | 'failed' | 'stale'; exitCode: number | null
  timedOut: boolean; stdoutTail: string; stderrTail: string; checkedAtMs: number
}
type OverrunRow = {
  attemptId: string; watcherId: string; revision: number | null; taskKey: string | null
  observedPaths: string[]; outsidePaths: string[]; unreportedPaths: string[]; code: string; recordedAtMs: number
}
type ProcessCall = { argv: string[]; options?: RunOptions }
type ProcessHook = (argv: readonly string[], options: RunOptions | undefined) => { stopped?: 'timeout' } | void

function rig(afterRun?: ProcessHook) {
  const root = mkdtempSync(join(tmpdir(), 'objective-checks-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-checks-data-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const calls: ProcessCall[] = []
  const checkRows: CheckRow[] = []
  const overrunRows: OverrunRow[] = []
  const payload: ObjectivePayload = {
    objectiveText: 'Implement the objective', tier: 'express', landingBar: 'files-on-disk', lanesEnabled: true,
    maxConcurrency: 1, writeTerritory: ['src/**'], roleAgents: {}, gates: [], worktree: 'id:fixture'
  }
  const enrollment = { watcherId: 'watcher-checks', workspacePath: root, kindPayload: payload }
  const store = {
    recordCheck(row: CheckRow) { checkRows.push(row) },
    checks(watcherId: string) { return checkRows.filter(row => row.watcherId === watcherId) },
    recordOverrun(row: OverrunRow) { overrunRows.push(row) },
    overruns(watcherId: string) { return overrunRows.filter(row => row.watcherId === watcherId) }
  } as unknown as ObjectiveStore
  const process = {
    async run(argv: readonly string[], options?: RunOptions) {
      calls.push({ argv: [...argv], options })
      const result = Bun.spawnSync([...argv], {
        cwd: options?.cwd,
        env: {
          ...globalThis.process.env, ...(options?.env ?? {}),
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
        },
        stdin: options?.input,
        stdout: 'pipe', stderr: 'pipe'
      })
      const override = afterRun?.(argv, options)
      const stdout = result.stdout
      const stderr = result.stderr
      return {
        stdout, stdoutText: stdout.toString(), stderr: stderr.toString(), exitCode: result.exitCode,
        signal: null, durationMs: 0,
        ...(override ?? {})
      }
    }
  }
  const context = { dataDir, process } as unknown as PluginContext
  const runtime: ObjectiveRuntime = {
    context, store, enrollment,
    captureContentIdentity: () => captureContentIdentity(context, root, dataDir, enrollment.watcherId)
  }
  async function runChecked(argv: string[], options?: RunOptions): Promise<string> {
    const result = await context.process.run(argv, options)
    if (result.exitCode !== 0 || result.signal !== null || result.stopped || result.spawnError) {
      throw new Error(`${argv.join(' ')} failed: ${result.stderr}`)
    }
    return result.stdoutText
  }
  async function initGit(): Promise<void> {
    await runChecked(['git', 'init', '-q'], { cwd: root })
    await runChecked(['git', 'config', 'user.name', 'Fixture'], { cwd: root })
    await runChecked(['git', 'config', 'user.email', 'fixture@example.test'], { cwd: root })
    await runChecked(['git', 'config', 'commit.gpgsign', 'false'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), '*.ignored\n')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'tracked.ignored'), 'initial\n')
    writeFileSync(join(root, 'src', 'base.ts'), 'base\n')
    await runChecked(['git', 'add', '-f', '.gitignore', 'src/tracked.ignored', 'src/base.ts'], { cwd: root })
    await runChecked(['git', 'commit', '-m', 'baseline'], { cwd: root })
  }
  return { root, dataDir, calls, checkRows, overrunRows, payload, enrollment, store, context, runtime, runChecked, initGit }
}

test('captures dispatch baseline and rejects outside-territory or unreported writes without blaming pre-existing dirty files', async () => {
  const r = rig()
  await r.initGit()
  writeFileSync(join(r.root, 'outside-before.txt'), 'already dirty\n')
  writeFileSync(join(r.root, 'src', 'base.ts'), 'pre-existing tracked edit before dispatch\n')
  writeFileSync(join(r.root, 'src', 'preexisting.ts'), 'already dirty in territory\n')
  mkdirSync(join(r.root, '.quirky', 'objective', r.enrollment.watcherId), { recursive: true })
  writeFileSync(join(r.root, '.quirky', 'objective', r.enrollment.watcherId, 'report.json'), '{}\n')
  const indexPath = join(r.root, '.git', 'index')
  const originalIndex = createHash('sha256').update(readFileSync(indexPath)).digest('hex')

  const baselineIdentity = await r.runtime.captureContentIdentity()
  const concurrentIdentities = await Promise.all([
    r.runtime.captureContentIdentity(),
    r.runtime.captureContentIdentity(),
    r.runtime.captureContentIdentity()
  ])
  expect(concurrentIdentities).toEqual([baselineIdentity, baselineIdentity, baselineIdentity])
  const baselineTree = baselineIdentity.slice('objective-tree:'.length)
  expect(baselineTree).toMatch(/^[0-9a-f]+$/)
  expect(readFileSync(join(r.root, '.git', 'info', 'exclude'), 'utf8')).toContain('/.quirky/objective/')
  expect(createHash('sha256').update(readFileSync(indexPath)).digest('hex')).toBe(originalIndex)

  writeFileSync(join(r.root, 'src', 'base.ts'), 'further tracked edit after dispatch\n')
  writeFileSync(join(r.root, 'src', 'reported.ts'), 'reported after dispatch\n')
  const cleanAttempt = {
    attemptId: 'reported-attempt', watcherId: r.enrollment.watcherId, role: 'implementer' as const,
    revision: 1, taskKey: 'implement', reportPath: 'report.json', issuedAtMs: 1, baselineTree
  }
  expect(await baselineProblems(r.runtime, cleanAttempt, ['src/reported.ts', 'src/base.ts'])).toEqual([])
  expect(r.overrunRows).toHaveLength(0)

  const nextBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
  writeFileSync(join(r.root, 'src', 'omitted.ts'), 'omitted from filesModified\n')
  const omittedAttempt = { ...cleanAttempt, attemptId: 'omitted-attempt', baselineTree: nextBaseline }
  expect(await baselineProblems(r.runtime, omittedAttempt, [])).toEqual(['unreported-observed-change:src/omitted.ts'])
  expect(r.overrunRows.at(-1)).toMatchObject({
    attemptId: 'omitted-attempt', observedPaths: ['src/omitted.ts'], outsidePaths: [],
    unreportedPaths: ['src/omitted.ts'], code: 'unreported-observed-change'
  })

  const lastBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
  writeFileSync(join(r.root, 'docs-private.txt'), 'outside territory\n')
  const outsideAttempt = { ...cleanAttempt, attemptId: 'outside-attempt', baselineTree: lastBaseline }
  expect(await baselineProblems(r.runtime, outsideAttempt, ['docs-private.txt'])).toEqual([
    'observed-change-outside-write-territory:docs-private.txt'
  ])
  expect(r.overrunRows.at(-1)).toMatchObject({
    attemptId: 'outside-attempt', observedPaths: ['docs-private.txt'], outsidePaths: ['docs-private.txt'],
    unreportedPaths: [], code: 'observed-change-outside-write-territory'
  })
  expect(createHash('sha256').update(readFileSync(indexPath)).digest('hex')).toBe(originalIndex)
  const reportPath = join(r.root, '.quirky', 'objective', r.enrollment.watcherId, 'report.json')
  const reviewerBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
  writeFileSync(reportPath, '{"review":"done"}\n')
  const reviewerAttempt = {
    attemptId: 'reviewer-attempt', watcherId: r.enrollment.watcherId, role: 'reviewer' as const,
    revision: 1, taskKey: null, reportPath, issuedAtMs: 2, baselineTree: reviewerBaseline
  }
  expect(await baselineProblems(r.runtime, reviewerAttempt)).toEqual([])
  writeFileSync(join(r.root, 'src', 'reviewer-write.ts'), 'reviewer is read only\n')
  expect(await baselineProblems(r.runtime, reviewerAttempt)).toEqual(['reviewer-modified-workspace:src/reviewer-write.ts'])

  const integratorBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
  const integratorAttempt = {
    attemptId: 'integrator-attempt', watcherId: r.enrollment.watcherId, role: 'integrator' as const,
    revision: 1, taskKey: null, reportPath: join(r.root, 'report.json'), issuedAtMs: 3, baselineTree: integratorBaseline
  }
  writeFileSync(join(r.root, 'src', 'integrator-write.ts'), 'integrator territory change\n')
  expect(await baselineProblems(r.runtime, integratorAttempt)).toEqual([])
  const integratorNextBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
  writeFileSync(join(r.root, 'docs-integrator.txt'), 'integrator outside territory\n')
  expect(await baselineProblems(r.runtime, { ...integratorAttempt, attemptId: 'integrator-outside', baselineTree: integratorNextBaseline }))
    .toEqual(['observed-change-outside-write-territory:docs-integrator.txt'])

  const beforeIgnoredEdit = await r.runtime.captureContentIdentity()
  writeFileSync(join(r.root, 'src', 'tracked.ignored'), 'changed but ignored\n')
  expect(await r.runtime.captureContentIdentity()).not.toBe(beforeIgnoredEdit)
})

test('runs shell check and gate commands through context.process.run and stores tails by content identity', async () => {
  const r = rig()
  await r.initGit()
  const contentIdentity = await r.runtime.captureContentIdentity()
  const checkCommand = `printf '%05000d' 0; printf '%05000d' 0 >&2`
  const check = await runCriterionCheck(r.runtime, {
    revision: 4, taskKey: 'compile', criterionIndex: 2, command: checkCommand, contentIdentity
  }, 'check-attempt')
  expect(check).toEqual({ effect: 'landed' })
  const checkRow = r.checkRows.find(row => row.attemptId === 'check-attempt')
  expect(checkRow).toMatchObject({
    revision: 4, kind: 'criterion', targetKey: 'compile:2', contentIdentity, command: checkCommand,
    status: 'passed', exitCode: 0, timedOut: false
  })
  expect(checkRow?.stdoutTail).toBe('0'.repeat(4096))
  expect(checkRow?.stderrTail).toBe('0'.repeat(4096))
  const shellCall = r.calls.find(call => call.argv[0] === 'sh')
  expect(shellCall?.argv).toEqual(['sh', '-c', checkCommand])
  expect(shellCall?.options).toMatchObject({
    cwd: r.root, timeoutMs: 300_000, maxOutputBytes: 1_048_576, overflow: 'truncate'
  })

  const gateCommand = 'printf gate-out; printf gate-err >&2'
  const gate = await runEnrollmentGate(r.runtime, {
    revision: 4, gateName: 'ready', command: gateCommand, timeoutSeconds: 37, contentIdentity
  }, 'gate-attempt')
  expect(gate).toEqual({ effect: 'landed' })
  expect(r.checkRows.find(row => row.attemptId === 'gate-attempt')).toMatchObject({
    kind: 'gate', targetKey: 'ready', contentIdentity, command: gateCommand, status: 'passed',
    stdoutTail: 'gate-out', stderrTail: 'gate-err'
  })
  expect(r.calls.find(call => call.argv[0] === 'sh' && call.argv[2] === gateCommand)?.options).toMatchObject({
    cwd: r.root, timeoutMs: 37_000, maxOutputBytes: 1_048_576, overflow: 'truncate'
  })
  const timed = rig(argv => argv[0] === 'sh' ? { stopped: 'timeout' as const } : undefined)
  await timed.initGit()
  const timedIdentity = await timed.runtime.captureContentIdentity()
  expect(await runCriterionCheck(timed.runtime, {
    revision: 4, taskKey: 'compile', criterionIndex: 3, command: 'true', contentIdentity: timedIdentity
  }, 'timed-check')).toEqual({ effect: 'not-landed', reason: 'check-timed-out' })
  expect(timed.checkRows.find(row => row.attemptId === 'timed-check')).toMatchObject({
    status: 'failed', timedOut: true, exitCode: 0
  })
})

test('discards raced check results as stale when workspace content identity changes mid-run', async () => {
  const before = rig()
  await before.initGit()
  const staleIdentity = await before.runtime.captureContentIdentity()
  writeFileSync(join(before.root, 'src', 'changed-before-check.ts'), 'changed before execution\n')
  expect(await runEnrollmentGate(before.runtime, {
    revision: 1, gateName: 'stale-before', command: 'true', timeoutSeconds: 5, contentIdentity: staleIdentity
  }, 'stale-before-attempt')).toEqual({ effect: 'not-landed', reason: 'check-evidence-stale' })
  expect(before.checkRows.find(row => row.attemptId === 'stale-before-attempt')).toMatchObject({
    status: 'stale', exitCode: null, timedOut: false, stdoutTail: '', stderrTail: ''
  })
  expect(before.calls.filter(call => call.argv[0] === 'sh')).toHaveLength(0)
  let root = ''
  const r = rig((argv) => {
    if (argv[0] === 'sh') writeFileSync(join(root, 'src', 'raced.ts'), 'changed while check ran\n')
  })
  root = r.root
  await r.initGit()
  const contentIdentity = await r.runtime.captureContentIdentity()
  const result = await runEnrollmentGate(r.runtime, {
    revision: 1, gateName: 'race', command: 'true', timeoutSeconds: 5, contentIdentity
  }, 'raced-attempt')
  expect(result).toEqual({ effect: 'not-landed', reason: 'check-evidence-stale' })
  expect(r.checkRows.find(row => row.attemptId === 'raced-attempt')).toMatchObject({
    status: 'stale', exitCode: 0, timedOut: false, contentIdentity
  })
  expect(r.checkRows.find(row => row.attemptId === 'raced-attempt')?.status).not.toBe('passed')
  expect(r.checkRows.find(row => row.attemptId === 'raced-attempt')?.status).not.toBe('failed')
  expect(r.calls.filter(call => call.argv[0] === 'sh')).toHaveLength(1)
})
