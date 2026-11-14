import { afterEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, RunOptions } from '@quirky/protocol'
import type { ObjectivePayload } from '../src/contract'
import type { PlannerReport } from '../src/plan'
import type { ObjectiveStore, Revision } from '../src/store'
import { captureContentIdentity, type ObjectiveRuntime } from '../src/checks'
import { commitLocalBranch, readLocalGitHead, recordFilesOnDisk } from '../src/landing'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

type CheckRow = {
  attemptId: string; watcherId: string; revision: number; kind: 'criterion' | 'gate'; targetKey: string
  contentIdentity: string; command: string; status: 'passed' | 'failed' | 'stale'; exitCode: number | null
  timedOut: boolean; stdoutTail: string; stderrTail: string; checkedAtMs: number
}
type VerdictRow = {
  attemptId: string; watcherId: string; dispatchId: string; revision: number; role: 'reviewer' | 'integrator'
  contentIdentity: string; verdict: 'approve' | 'block'; criteriaResults: unknown[]; checksRun: unknown[]
  summary: string; digest: string; acceptedAtMs: number
}
type LandingRow = {
  watcherId: string; rung: 'files-on-disk' | 'committed-local-branch'; contentIdentity: string
  attemptId: string; payload: Record<string, unknown>; recordedAtMs: number
}
type Options = { rewriteCommitMessage?: boolean }

function rig(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'objective-landing-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-landing-data-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const calls: { argv: string[]; options?: RunOptions }[] = []
  const checkRows: CheckRow[] = []
  const verdictRows: VerdictRow[] = []
  const landingRows: LandingRow[] = []
  const task = {
    taskKey: 'implement', title: 'Implement objective', spec: 'Implement the objective.', deps: [],
    criteria: [{ body: 'The implementation passes its acceptance check.', shellCheckable: true, checkCommand: 'test -f src/main.ts' }],
    territory: ['src/**']
  }
  const plan: PlannerReport = { plan: { tasks: [task] }, assumptions: [] }
  const payload: ObjectivePayload = {
    objectiveText: 'Implement the objective', tier: 'full', landingBar: 'committed-local-branch', lanesEnabled: true,
    maxConcurrency: 1, writeTerritory: ['src/**'], roleAgents: {},
    gates: [{ name: 'ready', command: 'test -f src/main.ts', timeoutSeconds: 45 }], worktree: 'id:fixture'
  }
  const enrollment = { watcherId: 'watcher-landing', workspacePath: root, kindPayload: payload }
  let currentRevision: Revision | null = {
    watcherId: enrollment.watcherId, number: 1, plan, digest: 'plan-digest',
    sourceAttemptId: 'planner-attempt', approvedAtMs: 1
  }
  const issuedRows: {
    attemptId: string; watcherId: string; role: 'reviewer' | 'integrator'; revision: number; contentIdentity: string | null
  }[] = []
  const store = {
    revision(watcherId: string) { return watcherId === enrollment.watcherId ? currentRevision : null },
    issued(watcherId: string) { return issuedRows.filter(row => row.watcherId === watcherId) },
    checks(watcherId: string) { return checkRows.filter(row => row.watcherId === watcherId) },
    verdicts(watcherId: string) { return verdictRows.filter(row => row.watcherId === watcherId) },
    landings(watcherId: string) { return landingRows.filter(row => row.watcherId === watcherId) },
    recordLanding(row: LandingRow) {
      const existing = landingRows.find(value => value.watcherId === row.watcherId && value.rung === row.rung && value.contentIdentity === row.contentIdentity)
      if (!existing) landingRows.push(row)
    }
  } as unknown as ObjectiveStore
  const process = {
    async run(argv: readonly string[], runOptions?: RunOptions) {
      calls.push({ argv: [...argv], options: runOptions })
      const actualArgv = [...argv]
      if (options.rewriteCommitMessage && actualArgv[0] === 'git' && actualArgv[1] === 'commit') {
        const messageIndex = actualArgv.indexOf('-m')
        if (messageIndex >= 0) actualArgv[messageIndex + 1] = 'unexpected commit message'
      }
      const result = Bun.spawnSync(actualArgv, {
        cwd: runOptions?.cwd,
        env: {
          ...globalThis.process.env, ...(runOptions?.env ?? {}),
          GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'
        },
        stdin: runOptions?.input === undefined ? 'ignore' : Buffer.from(runOptions.input),
        stdout: 'pipe', stderr: 'pipe'
      })
      const stdout = result.stdout ?? Buffer.alloc(0)
      const stderr = result.stderr ?? Buffer.alloc(0)
      return {
        stdout, stdoutText: stdout.toString(), stderr: stderr.toString(),
        exitCode: result.exitCode, signal: result.signalCode ?? null, durationMs: 0
      }
    }
  }
  const context = { dataDir, process } as unknown as PluginContext
  const runtime: ObjectiveRuntime = {
    context, store, enrollment,
    captureContentIdentity: () => captureContentIdentity(context, root, dataDir, enrollment.watcherId)
  }
  async function runChecked(argv: string[], runOptions?: RunOptions): Promise<string> {
    const result = await context.process.run(argv, runOptions)
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
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'main.ts'), 'export const value = 1\n')
    writeFileSync(join(root, 'outside.txt'), 'base outside\n')
    await runChecked(['git', 'add', '-A'], { cwd: root })
    await runChecked(['git', 'commit', '-m', 'baseline'], { cwd: root })
  }
  function approveEvidence(contentIdentity: string): void {
    checkRows.push({
      attemptId: 'criterion-pass', watcherId: enrollment.watcherId, revision: 1, kind: 'criterion',
      targetKey: 'implement:0', contentIdentity, command: task.criteria[0]!.checkCommand!, status: 'passed',
      exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '', checkedAtMs: 2
    })
    checkRows.push({
      attemptId: 'gate-pass', watcherId: enrollment.watcherId, revision: 1, kind: 'gate', targetKey: 'ready',
      contentIdentity, command: payload.gates[0]!.command, status: 'passed', exitCode: 0, timedOut: false,
      stdoutTail: '', stderrTail: '', checkedAtMs: 2
    })
    issuedRows.push(
      { attemptId: 'reviewer-attempt', watcherId: enrollment.watcherId, role: 'reviewer', revision: 1, contentIdentity },
      { attemptId: 'integrator-attempt', watcherId: enrollment.watcherId, role: 'integrator', revision: 1, contentIdentity }
    )
    const reviewer = {
      taskKey: 'implement', criterionIndex: 0, result: 'pass', note: 'Verified.'
    }
    verdictRows.push({
      attemptId: 'reviewer-attempt', watcherId: enrollment.watcherId, dispatchId: 'reviewer-dispatch',
      revision: 1, role: 'reviewer', contentIdentity, verdict: 'approve', criteriaResults: [reviewer],
      checksRun: [], summary: 'Approved.', digest: 'reviewer-digest', acceptedAtMs: 3
    })
    verdictRows.push({
      attemptId: 'integrator-attempt', watcherId: enrollment.watcherId, dispatchId: 'integrator-dispatch',
      revision: 1, role: 'integrator', contentIdentity, verdict: 'approve', criteriaResults: [reviewer],
      checksRun: [{ command: 'test -f src/main.ts', exitCode: 0 }], summary: 'Integrated.',
      digest: 'integrator-digest', acceptedAtMs: 4
    })
  }
  return {
    root, dataDir, calls, checkRows, verdictRows, issuedRows, landingRows, task, plan, payload, enrollment,
    store, context, runtime, runChecked, initGit, approveEvidence
  }
}

function actionFor(contentIdentity: string) {
  return { revision: 1, contentIdentity }
}

type LandingRig = { landingRows: LandingRow[]; enrollment: { watcherId: string } }
function landingFor(r: LandingRig, rung: LandingRow['rung'], contentIdentity: string): void {
  r.landingRows.push({
    watcherId: r.enrollment.watcherId, rung, contentIdentity, attemptId: `landing-${rung}`,
    payload: { revision: 1 }, recordedAtMs: 10
  })
}

test('records files-on-disk landing only when content identity matches and required checks and verdicts pass', async () => {
  const r = rig()
  await r.initGit()
  const contentIdentity = await r.runtime.captureContentIdentity()
  const action = actionFor(contentIdentity)

  const missingEvidence = await recordFilesOnDisk(r.runtime, action, 'landing-attempt')
  expect(missingEvidence.effect).toBe('not-landed')
  expect(r.landingRows).toHaveLength(0)

  r.approveEvidence(contentIdentity)
  const integratorIssue = r.issuedRows.find(row => row.role === 'integrator')!
  integratorIssue.contentIdentity = 'objective-tree:stale-dispatch'
  expect((await recordFilesOnDisk(r.runtime, action, 'wrong-dispatch-tree')).effect).toBe('not-landed')
  integratorIssue.contentIdentity = contentIdentity
  r.verdictRows.push({
    attemptId: 'reviewer-block', watcherId: r.enrollment.watcherId, dispatchId: 'reviewer-block-dispatch',
    revision: 1, role: 'reviewer', contentIdentity, verdict: 'block', criteriaResults: [], checksRun: [],
    summary: 'A blocking verdict cannot be overridden by approval.', digest: 'block-digest', acceptedAtMs: 5
  })
  r.issuedRows.push({
    attemptId: 'reviewer-block', watcherId: r.enrollment.watcherId, role: 'reviewer', revision: 1, contentIdentity
  })
  expect((await recordFilesOnDisk(r.runtime, action, 'blocked-attempt')).effect).toBe('not-landed')
  expect(r.landingRows).toHaveLength(0)
  r.verdictRows.pop()

  expect(await recordFilesOnDisk(r.runtime, action, 'landing-attempt')).toEqual({ effect: 'landed' })
  expect(r.landingRows).toHaveLength(1)
  expect(r.landingRows[0]).toMatchObject({ rung: 'files-on-disk', contentIdentity, attemptId: 'landing-attempt' })

  writeFileSync(join(r.root, 'src', 'main.ts'), 'changed after evidence\n')
  expect(await recordFilesOnDisk(r.runtime, action, 'stale-landing')).toEqual({
    effect: 'not-landed', reason: 'landing-evidence-stale'
  })
  expect(r.landingRows).toHaveLength(1)
})

test('commits only inside-territory files with the attempt trailer and leaves outside dirty and staged files untouched', async () => {
  const r = rig()
  await r.initGit()
  const unusualPath = 'src/a [literal]*\nname.ts'
  writeFileSync(join(r.root, 'src', 'main.ts'), 'export const value = 2\n')
  writeFileSync(join(r.root, unusualPath), 'special path\n')
  writeFileSync(join(r.root, 'outside-rename.txt'), 'tracked rename source\n')
  await r.runChecked(['git', 'add', 'outside-rename.txt'], { cwd: r.root })
  await r.runChecked(['git', 'commit', '-m', 'add rename source'], { cwd: r.root })
  renameSync(join(r.root, 'outside-rename.txt'), join(r.root, 'src', 'moved-source.ts'))
  await r.runChecked(['git', 'add', '-A'], { cwd: r.root })
  writeFileSync(join(r.root, 'outside-staged.txt'), 'staged outside\n')
  await r.runChecked(['git', 'add', 'outside-staged.txt'], { cwd: r.root })
  writeFileSync(join(r.root, 'outside.txt'), 'unstaged outside\n')
  writeFileSync(join(r.root, 'outside-untracked.txt'), 'untracked outside\n')
  const contentIdentity = await r.runtime.captureContentIdentity()
  landingFor(r, 'files-on-disk', contentIdentity)
  const head = await readLocalGitHead(r.context, r.root)
  expect(head.branch).not.toBeNull()
  expect(head.headSha).not.toBeNull()

  const result = await commitLocalBranch(r.runtime, {
    revision: 1, contentIdentity, branch: head.branch!, headSha: head.headSha!
  }, 'commit-attempt-7')
  expect(result).toEqual({ effect: 'landed' })
  const addCall = r.calls.find(call => call.argv[0] === 'git' && call.argv[1] === 'add' && call.argv.includes('--pathspec-from-file=-'))
  const commitCall = r.calls.find(call => call.argv[0] === 'git' && call.argv[1] === 'commit' && call.argv.includes('--pathspec-from-file=-'))
  expect(addCall?.argv).toContain('--pathspec-file-nul')
  expect(commitCall?.argv).toContain('--pathspec-file-nul')
  expect(addCall?.options?.env?.GIT_LITERAL_PATHSPECS).toBe('1')
  expect(commitCall?.options?.env?.GIT_LITERAL_PATHSPECS).toBe('1')
  expect(new TextDecoder().decode(addCall?.options?.input as Uint8Array).split('\0').filter(Boolean).sort())
    .toEqual(['src/main.ts', 'src/moved-source.ts', unusualPath].sort())

  const committed = (await r.runChecked(['git', 'diff-tree', '--no-commit-id', '-r', '-z', '--name-only', 'HEAD^', 'HEAD'], { cwd: r.root }))
    .split('\0').filter(Boolean).sort()
  expect(committed).toEqual(['src/main.ts', 'src/moved-source.ts', unusualPath].sort())
  const body = await r.runChecked(['git', 'log', '-1', '--format=%B'], { cwd: r.root })
  expect(body.split(/\r?\n/)).toContain('Quirky-Objective-Attempt: commit-attempt-7')
  expect(await r.runChecked(['git', 'diff', '--cached', '--name-only'], { cwd: r.root })).toBe('outside-rename.txt\noutside-staged.txt\n')
  expect(await r.runChecked(['git', 'diff', '--name-only'], { cwd: r.root })).toBe('outside.txt\n')
  expect(await r.runChecked(['git', 'ls-files', '--others', '--exclude-standard'], { cwd: r.root })).toBe('outside-untracked.txt\n')
  expect(r.landingRows.find(row => row.rung === 'committed-local-branch')).toMatchObject({
    contentIdentity, attemptId: 'commit-attempt-7',
    payload: { committedPaths: ['src/main.ts', 'src/moved-source.ts', unusualPath].sort(), outsideTerritoryPaths: ['outside-rename.txt', 'outside-staged.txt', 'outside-untracked.txt', 'outside.txt'].sort() }
  })

  const clean = rig()
  await clean.initGit()
  writeFileSync(join(clean.root, 'outside.txt'), 'outside-only change\n')
  await clean.runChecked(['git', 'add', 'outside.txt'], { cwd: clean.root })
  const cleanIdentity = await clean.runtime.captureContentIdentity()
  landingFor(clean, 'files-on-disk', cleanIdentity)
  const cleanHead = await readLocalGitHead(clean.context, clean.root)
  expect(await commitLocalBranch(clean.runtime, {
    revision: 1, contentIdentity: cleanIdentity, branch: cleanHead.branch!, headSha: cleanHead.headSha!
  }, 'clean-attempt')).toEqual({ effect: 'landed' })
  expect(await clean.runChecked(['git', 'rev-list', '--count', 'HEAD'], { cwd: clean.root })).toBe('1\n')
  expect(clean.landingRows.find(row => row.rung === 'committed-local-branch')?.payload).toMatchObject({
    committedPaths: [], outsideTerritoryPaths: ['outside.txt']
  })

  const recovered = rig()
  await recovered.initGit()
  writeFileSync(join(recovered.root, 'src', 'main.ts'), 'commit before landing record\n')
  const recoveredIdentity = await recovered.runtime.captureContentIdentity()
  landingFor(recovered, 'files-on-disk', recoveredIdentity)
  const beforeRecovery = await readLocalGitHead(recovered.context, recovered.root)
  await recovered.runChecked(['git', 'add', 'src/main.ts'], { cwd: recovered.root })
  await recovered.runChecked([
    'git', 'commit', '-m', 'Implement the objective\n\nQuirky-Objective-Attempt: recovery-attempt'
  ], { cwd: recovered.root })
  expect(await commitLocalBranch(recovered.runtime, {
    revision: 1, contentIdentity: recoveredIdentity, branch: beforeRecovery.branch!,
    headSha: beforeRecovery.headSha!
  }, 'recovery-attempt')).toEqual({ effect: 'landed' })
  expect(await recovered.runChecked(['git', 'rev-list', '--count', 'HEAD'], { cwd: recovered.root })).toBe('2\n')
  expect(recovered.landingRows.find(row => row.rung === 'committed-local-branch')?.payload).toMatchObject({
    committedPaths: []
  })
}, 30_000)

test('refuses detached HEAD with branch-not-attached and distinguishes commit-hook-failed from indeterminate', async () => {
  const detached = rig()
  await detached.initGit()
  writeFileSync(join(detached.root, 'src', 'main.ts'), 'detached workspace change\n')
  const detachedIdentity = await detached.runtime.captureContentIdentity()
  landingFor(detached, 'files-on-disk', detachedIdentity)
  const attachedHead = await readLocalGitHead(detached.context, detached.root)
  await detached.runChecked(['git', 'checkout', '--detach'], { cwd: detached.root })
  expect(await commitLocalBranch(detached.runtime, {
    revision: 1, contentIdentity: detachedIdentity, branch: attachedHead.branch!, headSha: attachedHead.headSha!
  }, 'detached-attempt')).toEqual({ effect: 'not-landed', reason: 'branch-not-attached' })

  const hookFailure = rig()
  await hookFailure.initGit()
  writeFileSync(join(hookFailure.root, 'src', 'main.ts'), 'commit should be rejected by hook\n')
  const hookIdentity = await hookFailure.runtime.captureContentIdentity()
  landingFor(hookFailure, 'files-on-disk', hookIdentity)
  const hookHead = await readLocalGitHead(hookFailure.context, hookFailure.root)
  const hooksPath = await hookFailure.runChecked(['git', 'rev-parse', '--git-path', 'hooks'], { cwd: hookFailure.root })
  const hookDir = hooksPath.startsWith('/') ? hooksPath : join(hookFailure.root, hooksPath.trim())
  mkdirSync(hookDir, { recursive: true })
  const preCommit = join(hookDir, 'pre-commit')
  writeFileSync(preCommit, '#!/bin/sh\nexit 1\n')
  chmodSync(preCommit, 0o755)
  expect(await commitLocalBranch(hookFailure.runtime, {
    revision: 1, contentIdentity: hookIdentity, branch: hookHead.branch!, headSha: hookHead.headSha!
  }, 'hook-failed-attempt')).toEqual({ effect: 'not-landed', reason: 'commit-hook-failed' })

  const indeterminate = rig({ rewriteCommitMessage: true })
  await indeterminate.initGit()
  writeFileSync(join(indeterminate.root, 'src', 'main.ts'), 'commit with unexpected trailer\n')
  const indeterminateIdentity = await indeterminate.runtime.captureContentIdentity()
  landingFor(indeterminate, 'files-on-disk', indeterminateIdentity)
  const indeterminateHead = await readLocalGitHead(indeterminate.context, indeterminate.root)
  expect(await commitLocalBranch(indeterminate.runtime, {
    revision: 1, contentIdentity: indeterminateIdentity, branch: indeterminateHead.branch!, headSha: indeterminateHead.headSha!
  }, 'indeterminate-attempt')).toEqual({ effect: 'indeterminate', reason: 'commit-state-indeterminate' })
  expect(indeterminate.landingRows.some(row => row.rung === 'committed-local-branch')).toBe(false)
}, 30_000)
