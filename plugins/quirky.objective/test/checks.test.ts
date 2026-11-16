import { afterEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginContext, RunOptions, RunResult } from '@quirky/protocol'
import type { ObjectivePayload } from '../src/contract'

import {
  baselineProblems,
  captureContentIdentity,
  captureTaskBaseline,
  readIndexSuppressionFlags,
  runCriterionCheck,
  runEnrollmentGate,
  type ObjectiveRuntime
} from '../src/checks'
import { captureFolderObservation, isTaskBaseline, type TaskBaseline } from '../src/folder-workspace'
import type { Issued, ObjectiveStore } from '../src/store'
type FolderTaskBaseline = Extract<TaskBaseline, { kind: 'folder' }>

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
type ProcessHook = (argv: readonly string[], options: RunOptions | undefined) => Partial<RunResult> | void

type FolderRuntimeFixture = {
  context: PluginContext
  root: string
  dataDir: string
  enrollment: { watcherId: string }
  runtime: ObjectiveRuntime
}

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
        stdin: options?.input === undefined ? 'ignore' : Buffer.from(options.input),
        stdout: 'pipe', stderr: 'pipe'
      })
      const override = afterRun?.(argv, options)
      const stdout = result.stdout ?? Buffer.alloc(0)
      const stderr = result.stderr ?? Buffer.alloc(0)
      return {
        stdout, stdoutText: stdout.toString(), stderr: stderr.toString(), exitCode: result.exitCode,
        signal: result.signalCode ?? null, durationMs: 0,
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

function folderRuntime(r: FolderRuntimeFixture): ObjectiveRuntime {
  return {
    ...r.runtime,
    workspaceKind: 'folder',
    captureContentIdentity: () => captureContentIdentity(
      r.context, r.root, r.dataDir, r.enrollment.watcherId, 'folder'
    )
  }
}

async function captureFolderBaseline(runtime: ObjectiveRuntime): Promise<FolderTaskBaseline> {
  const baseline = await captureTaskBaseline(runtime)
  if (baseline.kind !== 'folder') throw new Error('folder runtime returned a Git baseline')
  return baseline
}

function folderIssue(
  r: Pick<FolderRuntimeFixture, 'root' | 'enrollment'>,
  baseline: FolderTaskBaseline,
  role: 'implementer' | 'reviewer' | 'integrator',
  attemptId: string
): Issued {
  return {
    attemptId, watcherId: r.enrollment.watcherId, role, revision: 1,
    taskKey: role === 'implementer' ? 'implement' : null,
    reportPath: join(r.root, '.quirky', 'objective', r.enrollment.watcherId, `${attemptId}.json`),
    issuedAtMs: 1, baseline, baselineTree: null, contentIdentity: baseline.contentIdentity
  }
}

type SuppressionFlagCase = {
  flag: 'assume-unchanged' | 'skip-worktree'
  path: string
  create(root: string, path: string): void
  remove(root: string, path: string): void
}

const suppressionFlagCases: SuppressionFlagCase[] = [
  {
    flag: 'assume-unchanged',
    path: 'outside\nassumed-deletion-link',
    create: (root, path) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      symlinkSync('missing-target', join(root, path))
    },
    remove: (root, path) => unlinkSync(join(root, path))
  },
  {
    flag: 'skip-worktree',
    path: 'outside\tskipped-deletion.ts',
    create: (root, path) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), 'tracked outside territory\n')
    },
    remove: (root, path) => unlinkSync(join(root, path))
  }
]

type ChecksFixture = {
  root: string
  dataDir: string
  context: PluginContext
  enrollment: { watcherId: string }
  runtime: ObjectiveRuntime
  runChecked(argv: string[], options?: RunOptions): Promise<string>
}

async function addSuppressedTrackedPath(
  r: ChecksFixture,
  scenario: SuppressionFlagCase
): Promise<void> {
  scenario.create(r.root, scenario.path)
  await r.runChecked(['git', 'add', '--', scenario.path], { cwd: r.root })
  await r.runChecked(['git', 'commit', '-m', `track ${scenario.flag} path`], { cwd: r.root })
  await r.runChecked(['git', 'update-index', `--${scenario.flag}`, '--', scenario.path], { cwd: r.root })
}

async function rewriteIndexWithoutWorkspaceChange(r: ChecksFixture) {
  const basePath = join(r.root, 'src', 'base.ts')
  writeFileSync(basePath, 'temporary index rewrite\n')
  await r.runChecked(['git', 'add', '--', 'src/base.ts'], { cwd: r.root })
  writeFileSync(basePath, 'base\n')
  return readFileSync(join(r.root, '.git', 'index'))
}

function runtimeWithCaptureDirectory(
  r: ChecksFixture,
  dataDir: string
): ObjectiveRuntime {
  return {
    ...r.runtime,
    captureContentIdentity: () => captureContentIdentity(r.context, r.root, dataDir, r.enrollment.watcherId)
  }
}

function rewriteIndexDuringCheck(root: string) {
  const basePath = join(root, 'src', 'base.ts')
  writeFileSync(basePath, 'temporary index rewrite\n')
  const result = Bun.spawnSync(['git', 'add', '--', 'src/base.ts'], {
    cwd: root,
    env: { ...globalThis.process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  writeFileSync(basePath, 'base\n')
  return readFileSync(join(root, '.git', 'index'))
}

function coldCaptureDirectory(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-checks-cold-data-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

test('detects suppressed tracked deletions after real-index reloads and cold captures for implementers and reviewers', async () => {
  for (const scenario of suppressionFlagCases) {
    for (const capture of ['real-index-reload', 'cold-capture'] as const) {
      for (const role of ['implementer', 'reviewer'] as const) {
        const r = rig()
        await r.initGit()
        await addSuppressedTrackedPath(r, scenario)
        const baselineTree = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
        scenario.remove(r.root, scenario.path)

        const runtime = capture === 'cold-capture'
          ? runtimeWithCaptureDirectory(r, coldCaptureDirectory())
          : r.runtime
        const bytesToPreserve = capture === 'real-index-reload'
          ? await rewriteIndexWithoutWorkspaceChange(r)
          : readFileSync(join(r.root, '.git', 'index'))
        const reportPath = join(r.root, '.quirky', 'objective', r.enrollment.watcherId, 'review.json')
        const issued = {
          attemptId: `deleted-${scenario.flag}-${capture}-${role}`,
          watcherId: r.enrollment.watcherId,
          role,
          revision: 1,
          taskKey: role === 'implementer' ? 'implement' : null,
          reportPath,
          issuedAtMs: 1,
          baselineTree
        }

        const expected = role === 'reviewer'
          ? `reviewer-modified-workspace:${scenario.path}`
          : `observed-change-outside-write-territory:${scenario.path}`
        expect(await baselineProblems(runtime, issued, role === 'implementer' ? [] : undefined)).toEqual([expected])
        expect(readFileSync(join(r.root, '.git', 'index'))).toEqual(bytesToPreserve)
      }
    }
  }
}, 30_000)

test('deleting suppressed tracked paths during a shell check leaves stale evidence after reloads and cold captures', async () => {
  for (const scenario of suppressionFlagCases) {
    for (const capture of ['real-index-reload', 'cold-capture'] as const) {
      let root = ''
      let captureDir = ''
      let bytesToPreserve = Buffer.alloc(0)
      const r = rig(argv => {
        if (argv[0] !== 'sh') return
        scenario.remove(root, scenario.path)
        if (capture === 'real-index-reload') bytesToPreserve = rewriteIndexDuringCheck(root)
        else captureDir = coldCaptureDirectory()
      })
      root = r.root
      await r.initGit()
      await addSuppressedTrackedPath(r, scenario)
      captureDir = r.dataDir
      const contentIdentity = await r.runtime.captureContentIdentity()
      bytesToPreserve = readFileSync(join(r.root, '.git', 'index'))
      const runtime: ObjectiveRuntime = {
        ...r.runtime,
        captureContentIdentity: () => captureContentIdentity(r.context, r.root, captureDir, r.enrollment.watcherId)
      }

      expect(await runCriterionCheck(runtime, {
        revision: 1,
        taskKey: 'check',
        criterionIndex: 0,
        command: 'true',
        contentIdentity
      }, `deleted-${scenario.flag}-${capture}`)).toEqual({
        effect: 'not-landed',
        reason: 'check-evidence-stale'
      })
      expect(r.checkRows.find(row => row.attemptId === `deleted-${scenario.flag}-${capture}`)).toMatchObject({
        status: 'stale',
        exitCode: 0,
        contentIdentity
      })
      expect(r.checkRows.find(row => row.attemptId === `deleted-${scenario.flag}-${capture}`)?.status).not.toBe('passed')
      expect(readFileSync(join(r.root, '.git', 'index'))).toEqual(bytesToPreserve)
    }
  }
}, 30_000)

test('detects deletions of sparse-included entries while retaining absent sparse-excluded blobs', async () => {
  const r = rig()
  await r.initGit()
  mkdirSync(join(r.root, 'docs'), { recursive: true })
  writeFileSync(join(r.root, 'docs', 'sparse-only.ts'), 'outside sparse cone\n')
  await r.runChecked(['git', 'add', '--', 'docs/sparse-only.ts'], { cwd: r.root })
  await r.runChecked(['git', 'commit', '-m', 'add sparse file'], { cwd: r.root })
  await r.runChecked(['git', 'sparse-checkout', 'init', '--cone', '--sparse-index'], { cwd: r.root })
  await r.runChecked(['git', 'sparse-checkout', 'set', 'src'], { cwd: r.root })
  await r.runChecked(['git', 'update-index', '--skip-worktree', '--', 'src/base.ts'], { cwd: r.root })

  const excludedPath = join(r.root, 'docs', 'sparse-only.ts')
  const includedPath = join(r.root, 'src', 'base.ts')
  expect(existsSync(excludedPath)).toBe(false)
  expect(existsSync(includedPath)).toBe(true)
  const indexPath = join(r.root, '.git', 'index')
  const bytesToPreserve = readFileSync(indexPath)
  const headTree = (await r.runChecked(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: r.root })).trim()
  unlinkSync(includedPath)

  const identity = await r.runtime.captureContentIdentity()
  expect(identity).not.toBe(`objective-tree:${headTree}`)
  const capturedTree = identity.slice('objective-tree:'.length)
  const capturedPaths = (await r.runChecked(['git', 'ls-tree', '-r', '-z', '--name-only', capturedTree], { cwd: r.root }))
    .split('\0')
  expect(capturedPaths).not.toContain('src/base.ts')
  expect(capturedPaths).toContain('docs/sparse-only.ts')
  expect(readFileSync(indexPath)).toEqual(bytesToPreserve)
}, 30_000)

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
}, 30_000)

test('captures flagged tracked edits for territory, reviewer, and check evidence without changing the real index', async () => {
  const cases: {
    flag: 'assume-unchanged' | 'skip-worktree'
    path: string
    create(root: string): void
    change(root: string, version: number): void
  }[] = [
    {
      flag: 'assume-unchanged',
      path: 'outside\nassumed-link',
      create: root => symlinkSync('first-target', join(root, 'outside\nassumed-link')),
      change: (root, version) => {
        const path = join(root, 'outside\nassumed-link')
        unlinkSync(path)
        symlinkSync(`target-${version}`, path)
      }
    },
    {
      flag: 'skip-worktree',
      path: 'outside\tskipped.ts',
      create: root => writeFileSync(join(root, 'outside\tskipped.ts'), 'initial\n'),
      change: (root, version) => writeFileSync(join(root, 'outside\tskipped.ts'), `changed-${version}\n`)
    }
  ]

  for (const { flag, path, create, change } of cases) {
    const r = rig()
    await r.initGit()
    create(r.root)
    await r.runChecked(['git', 'add', '--', path], { cwd: r.root })
    await r.runChecked(['git', 'commit', '-m', 'track flagged path'], { cwd: r.root })
    await r.runChecked(['git', 'update-index', `--${flag}`, '--', path], { cwd: r.root })

    const indexPath = join(r.root, '.git', 'index')
    const originalIndex = readFileSync(indexPath)
    expect(await readIndexSuppressionFlags(r.context, r.root)).toEqual(flag === 'assume-unchanged'
      ? { assumeUnchanged: [path], skipWorktree: [] }
      : { assumeUnchanged: [], skipWorktree: [path] })
    const realIndexEntry = flag === 'assume-unchanged' ? `h ${path}` : `S ${path}`
    const expectRealIndexUnchanged = async () => {
      expect(readFileSync(indexPath)).toEqual(originalIndex)
      const entries = (await r.runChecked(['git', 'ls-files', '-v', '-z'], { cwd: r.root })).split('\0')
      expect(entries).toContain(realIndexEntry)
    }

    const baselineIdentity = await r.runtime.captureContentIdentity()
    expect(await r.runtime.captureContentIdentity()).toBe(baselineIdentity)
    await expectRealIndexUnchanged()
    const baselineTree = baselineIdentity.slice('objective-tree:'.length)
    change(r.root, 1)
    const implementerAttempt = {
      attemptId: `flagged-${flag}-implementer`, watcherId: r.enrollment.watcherId, role: 'implementer' as const,
      revision: 1, taskKey: 'implement', reportPath: 'report.json', issuedAtMs: 1, baselineTree
    }
    expect(await baselineProblems(r.runtime, implementerAttempt, [])).toEqual([
      `observed-change-outside-write-territory:${path}`
    ])

    const reviewerBaseline = (await r.runtime.captureContentIdentity()).slice('objective-tree:'.length)
    change(r.root, 2)
    const reviewerAttempt = {
      ...implementerAttempt, attemptId: `flagged-${flag}-reviewer`, role: 'reviewer' as const,
      baselineTree: reviewerBaseline, reportPath: join(r.root, 'report.json')
    }
    expect(await baselineProblems(r.runtime, reviewerAttempt)).toEqual([`reviewer-modified-workspace:${path}`])

    const checkIdentity = await r.runtime.captureContentIdentity()
    change(r.root, 3)
    expect(await runEnrollmentGate(r.runtime, {
      revision: 1, gateName: `flagged-${flag}`, command: 'true', timeoutSeconds: 5, contentIdentity: checkIdentity
    }, `flagged-${flag}-stale-check`)).toEqual({ effect: 'not-landed', reason: 'check-evidence-stale' })
    expect(r.checkRows.find(row => row.attemptId === `flagged-${flag}-stale-check`)).toMatchObject({
      status: 'stale', exitCode: null
    })
    expect(r.calls.filter(call => call.argv[0] === 'sh')).toHaveLength(0)
    await expectRealIndexUnchanged()
    expect(reviewerBaseline).not.toBe(baselineTree)
  }
}, 30_000)

test('preserves absent sparse-checkout entries during identity capture', async () => {
  const r = rig()
  await r.initGit()
  mkdirSync(join(r.root, 'docs'), { recursive: true })
  writeFileSync(join(r.root, 'docs', 'sparse-only.ts'), 'outside sparse cone\n')
  await r.runChecked(['git', 'add', '--', 'docs/sparse-only.ts'], { cwd: r.root })
  await r.runChecked(['git', 'commit', '-m', 'add sparse file'], { cwd: r.root })
  await r.runChecked(['git', 'sparse-checkout', 'init', '--cone', '--sparse-index'], { cwd: r.root })
  await r.runChecked(['git', 'sparse-checkout', 'set', 'src'], { cwd: r.root })

  const sparsePath = join(r.root, 'docs', 'sparse-only.ts')
  expect(existsSync(sparsePath)).toBe(false)
  const indexPath = join(r.root, '.git', 'index')
  const originalIndex = readFileSync(indexPath)
  const tree = (await r.runChecked(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: r.root })).trim()
  expect((await r.runtime.captureContentIdentity())).toBe(`objective-tree:${tree}`)
  expect(readFileSync(indexPath)).toEqual(originalIndex)
  const entries = (await r.runChecked(['git', 'ls-files', '-v', '--sparse', '-z'], { cwd: r.root })).split('\0')
  expect(entries).toContain('S docs/')
  const treePaths = (await r.runChecked(['git', 'ls-tree', '-r', '-z', '--name-only', tree], { cwd: r.root })).split('\0')
  expect(treePaths).toContain('docs/sparse-only.ts')

  mkdirSync(join(r.root, 'docs'), { recursive: true })
  writeFileSync(sparsePath, 'physically present out-of-cone edit\n')
  const changedIdentity = await r.runtime.captureContentIdentity()
  expect(changedIdentity).not.toBe(`objective-tree:${tree}`)
  const changedTree = changedIdentity.slice('objective-tree:'.length)
  expect(await r.runChecked(['git', 'show', `${changedTree}:docs/sparse-only.ts`], { cwd: r.root }))
    .toBe('physically present out-of-cone edit\n')
  expect(readFileSync(indexPath)).toEqual(originalIndex)
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
test('compares immutable folder dispatch baselines against observed territory for implementers reviewers and integrators', async () => {
  const r = rig()
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'base.txt'), 'dispatch-time source\n')
  writeFileSync(join(r.root, 'outside-before.txt'), 'pre-existing outside change\n')
  const runtime = folderRuntime(r)
  const baseline = await captureFolderBaseline(runtime)
  expect(isTaskBaseline(baseline)).toBe(true)
  expect(baseline).toMatchObject({ kind: 'folder', version: 1 })
  expect(baseline.contentIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/)
  expect(await captureFolderObservation(r.root)).toEqual(baseline)
  expect(await runtime.captureContentIdentity()).toBe(baseline.contentIdentity)
  expect(r.calls).toEqual([])

  const implementer = folderIssue(r, baseline, 'implementer', 'folder-outside-attempt')
  writeFileSync(join(r.root, 'src', 'result.txt'), 'ready\n')
  writeFileSync(join(r.root, 'outside.txt'), 'changed outside territory\n')
  const outsideObservation = await captureFolderBaseline(runtime)
  expect(await baselineProblems(runtime, implementer, ['src/result.txt'], outsideObservation))
    .toEqual(['observed-change-outside-write-territory:outside.txt'])
  expect(r.overrunRows.at(-1)).toMatchObject({
    attemptId: implementer.attemptId,
    observedPaths: ['outside.txt', 'src/result.txt'],
    outsidePaths: ['outside.txt'],
    unreportedPaths: [],
    code: 'observed-change-outside-write-territory'
  })

  const unreported = folderIssue(r, outsideObservation, 'implementer', 'folder-unreported-attempt')
  writeFileSync(join(r.root, 'src', 'omitted.txt'), 'not reported\n')
  const unreportedObservation = await captureFolderBaseline(runtime)
  expect(await baselineProblems(runtime, unreported, [], unreportedObservation))
    .toEqual(['unreported-observed-change:src/omitted.txt'])
  expect(r.overrunRows.at(-1)).toMatchObject({
    observedPaths: ['src/omitted.txt'], outsidePaths: [], unreportedPaths: ['src/omitted.txt'],
    code: 'unreported-observed-change'
  })

  const reviewerBaseline = unreportedObservation
  const reviewer = folderIssue(r, reviewerBaseline, 'reviewer', 'folder-review-attempt')
  mkdirSync(dirname(reviewer.reportPath), { recursive: true })
  writeFileSync(reviewer.reportPath, '{"verdict":"approve"}\n')
  expect(await baselineProblems(runtime, reviewer, undefined, await captureFolderBaseline(runtime))).toEqual([])
  unlinkSync(reviewer.reportPath)
  writeFileSync(join(r.root, 'reviewer-outside.txt'), 'reviewer wrote outside its report\n')
  expect(await baselineProblems(runtime, reviewer, undefined, await captureFolderBaseline(runtime)))
    .toEqual(['reviewer-modified-workspace:reviewer-outside.txt'])
  expect(r.overrunRows.at(-1)).toMatchObject({
    observedPaths: ['reviewer-outside.txt'], outsidePaths: ['reviewer-outside.txt'],
    code: 'reviewer-modified-workspace'
  })

  const integratorBaseline = await captureFolderBaseline(runtime)
  const integrator = folderIssue(r, integratorBaseline, 'integrator', 'folder-integrator-attempt')
  writeFileSync(join(r.root, 'src', 'integrated.txt'), 'inside territory\n')
  expect(await baselineProblems(runtime, integrator, undefined, await captureFolderBaseline(runtime))).toEqual([])
  const nextIntegrator = await captureFolderBaseline(runtime)
  writeFileSync(join(r.root, 'outside-integrator.txt'), 'outside territory\n')
  expect(await baselineProblems(runtime, {
    ...integrator,
    attemptId: 'folder-integrator-outside-attempt',
    baseline: nextIntegrator,
    contentIdentity: nextIntegrator.contentIdentity
  }, undefined, await captureFolderBaseline(runtime)))
    .toEqual(['observed-change-outside-write-territory:outside-integrator.txt'])
  expect(r.calls).toEqual([])
}, 30_000)

test('ignores root Heimdall lease churn against immutable folder baselines while observing nearby paths', async () => {
  const r = rig()
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'base.txt'), 'baseline source\n')
  writeFileSync(join(r.root, 'outside-before.txt'), 'pre-existing outside change\n')
  const runtime = folderRuntime(r)
  const baseline = await captureFolderBaseline(runtime)
  expect(baseline.entries.map(entry => entry.path)).toContain('outside-before.txt')
  const issued = folderIssue(r, baseline, 'implementer', 'folder-heimdall-lease-attempt')
  expect(issued.baseline).toBe(baseline)

  const leaseDirectory = join(r.root, '.orca', 'heimdall', 'lease', 'epoch-1')
  const holderPath = join(leaseDirectory, 'holder.json')
  const tempPath = join(leaseDirectory, '.holder-temp.tmp')
  const leaseChanges: (() => void)[] = [
    () => {
      mkdirSync(leaseDirectory, { recursive: true })
      writeFileSync(holderPath, '{"holder":"owner-a","epoch":1}\n')
    },
    () => writeFileSync(tempPath, '{"holder":"owner-a","epoch":2}\n'),
    () => renameSync(tempPath, holderPath),
    () => writeFileSync(holderPath, '{"holder":"owner-a","released":true}\n'),
    () => unlinkSync(holderPath)
  ]
  for (const change of leaseChanges) {
    change()
    const observation = await captureFolderObservation(r.root)
    expect(observation).toEqual(baseline)
    expect(await baselineProblems(runtime, issued, [], observation)).toEqual([])
    expect(r.overrunRows).toEqual([])
  }

  const nearbyPaths = [
    '.orca/config.json',
    '.orca/heimdall/lease-other/file',
    'src/.orca/heimdall/lease/file'
  ]
  for (const path of nearbyPaths) {
    const absolutePath = join(r.root, path)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, 'observed\n')
  }
  const observation = await captureFolderObservation(r.root)
  expect(observation.entries.map(entry => entry.path)).toEqual(expect.arrayContaining(nearbyPaths))
  expect(await baselineProblems(runtime, issued, [], observation)).toEqual([
    'observed-change-outside-write-territory:.orca/config.json',
    'observed-change-outside-write-territory:.orca/heimdall/lease-other/file',
    'unreported-observed-change:src/.orca/heimdall/lease/file'
  ])
  expect(r.overrunRows).toHaveLength(1)
  expect(r.overrunRows[0]).toMatchObject({
    observedPaths: nearbyPaths,
    outsidePaths: nearbyPaths.slice(0, 2),
    unreportedPaths: [nearbyPaths[2]],
    code: 'observed-change-outside-write-territory'
  })
  expect(r.calls).toEqual([])
}, 30_000)

test('rejects missing corrupt mismatched and cross-kind folder baseline authority', async () => {
  const r = rig()
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'base.txt'), 'baseline\n')
  const runtime = folderRuntime(r)
  const baseline = await captureFolderBaseline(runtime)
  const issued = folderIssue(r, baseline, 'implementer', 'folder-valid-authority')
  const missing = { ...issued, attemptId: 'folder-missing-authority', baseline: undefined }
  expect(await baselineProblems(runtime, missing, [], baseline)).toEqual(['invalid-baseline-tree'])

  const corruptBaseline = {
    ...baseline,
    contentIdentity: `objective-folder-v1:${'0'.repeat(64)}`
  } as FolderTaskBaseline
  expect(isTaskBaseline(corruptBaseline)).toBe(false)
  expect(await baselineProblems(runtime, {
    ...issued, attemptId: 'folder-corrupt-authority', baseline: corruptBaseline
  }, [], baseline)).toEqual(['invalid-baseline-tree'])

  expect(await baselineProblems(runtime, {
    ...issued, attemptId: 'folder-git-baseline', baseline: { kind: 'git', treeOid: 'a'.repeat(40) }
  }, [], baseline)).toEqual(['invalid-baseline-tree'])
  expect(await baselineProblems(runtime, {
    ...issued, attemptId: 'folder-fake-git-oid', baselineTree: 'b'.repeat(40)
  }, [], baseline)).toEqual(['invalid-baseline-tree'])

  const unavailableRuntime: ObjectiveRuntime = {
    ...runtime,
    enrollment: { ...runtime.enrollment, workspacePath: join(r.root, 'missing-workspace') }
  }
  expect(await baselineProblems(unavailableRuntime, {
    ...issued, attemptId: 'folder-unavailable-observation'
  }, [])).toEqual(['baseline-comparison-failed'])
  expect(r.overrunRows.at(-1)).toMatchObject({
    observedPaths: [], outsidePaths: [], unreportedPaths: [], code: 'baseline-comparison-failed'
  })
  expect(r.overrunRows.map(row => row.code)).toEqual([
    'invalid-baseline-tree', 'invalid-baseline-tree', 'invalid-baseline-tree', 'invalid-baseline-tree',
    'baseline-comparison-failed'
  ])
  expect(r.calls).toEqual([])
}, 30_000)

test('folder checks and tiered review retain content-bound evidence without Git', async () => {
  let checkRoot = ''
  const r = rig(argv => {
    if (argv[0] !== 'sh') return
    const report = join(checkRoot, '.quirky', 'objective', 'watcher-checks', 'temporary-report.json')
    mkdirSync(dirname(report), { recursive: true })
    writeFileSync(report, '{"temporary":true}\n')
    unlinkSync(report)
  })
  checkRoot = r.root
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'result.txt'), 'ready for the folder checks\n')
  const runtime = folderRuntime(r)
  const contentIdentity = await runtime.captureContentIdentity()
  expect(contentIdentity).toMatch(/^objective-folder-v1:[0-9a-f]{64}$/)

  const contentCommand = 'grep -q ready src/result.txt'
  expect(await runCriterionCheck(runtime, {
    revision: 1, taskKey: 'implement', criterionIndex: 0, command: contentCommand, contentIdentity
  }, 'folder-content-check')).toEqual({ effect: 'landed' })
  const existsCommand = 'test -f src/result.txt'
  expect(await runCriterionCheck(runtime, {
    revision: 1, taskKey: 'implement', criterionIndex: 1, command: existsCommand, contentIdentity
  }, 'folder-exists-check')).toEqual({ effect: 'landed' })
  const gateCommand = 'test -f src/result.txt'
  expect(await runEnrollmentGate(runtime, {
    revision: 1, gateName: 'ready', command: gateCommand, timeoutSeconds: 37, contentIdentity
  }, 'folder-gate-pass')).toEqual({ effect: 'landed' })
  expect(r.checkRows.filter(row => row.attemptId.startsWith('folder-'))).toMatchObject([
    { attemptId: 'folder-content-check', contentIdentity, status: 'passed', exitCode: 0 },
    { attemptId: 'folder-exists-check', contentIdentity, status: 'passed', exitCode: 0 },
    { attemptId: 'folder-gate-pass', contentIdentity, status: 'passed', exitCode: 0 }
  ])
  expect(r.calls.filter(call => call.argv[0] === 'sh').map(call => call.options)).toEqual([
    { cwd: r.root, timeoutMs: 300_000, maxOutputBytes: 1_048_576, overflow: 'truncate' },
    { cwd: r.root, timeoutMs: 300_000, maxOutputBytes: 1_048_576, overflow: 'truncate' },
    { cwd: r.root, timeoutMs: 37_000, maxOutputBytes: 1_048_576, overflow: 'truncate' }
  ])
  expect(existsSync(join(r.root, '.quirky', 'objective', 'watcher-checks', 'temporary-report.json'))).toBe(false)
  expect(r.checkRows.find(row => row.attemptId === 'folder-gate-pass')?.contentIdentity).toBe(contentIdentity)
  expect(r.calls.some(call => call.argv[0] === 'git')).toBe(false)
  expect(existsSync(join(r.root, '.git'))).toBe(false)

  const failedCommand = 'grep -q absent src/result.txt'
  expect(await runEnrollmentGate(runtime, {
    revision: 1, gateName: 'content-missing', command: failedCommand, timeoutSeconds: 5, contentIdentity
  }, 'folder-gate-fail')).toEqual({ effect: 'not-landed', reason: 'check-failed' })
  expect(r.checkRows.find(row => row.attemptId === 'folder-gate-fail')).toMatchObject({
    contentIdentity, command: failedCommand, status: 'failed', exitCode: 1, timedOut: false
  })

  const timed = rig(argv => argv[0] === 'sh' ? { stopped: 'timeout' } : undefined)
  mkdirSync(join(timed.root, 'src'), { recursive: true })
  writeFileSync(join(timed.root, 'src', 'result.txt'), 'ready\n')
  const timedRuntime = folderRuntime(timed)
  const timedIdentity = await timedRuntime.captureContentIdentity()
  expect(await runEnrollmentGate(timedRuntime, {
    revision: 1, gateName: 'timeout', command: 'true', timeoutSeconds: 5, contentIdentity: timedIdentity
  }, 'folder-gate-timeout')).toEqual({ effect: 'not-landed', reason: 'check-timed-out' })
  expect(timed.checkRows.find(row => row.attemptId === 'folder-gate-timeout')).toMatchObject({
    status: 'failed', timedOut: true
  })

  const processFailure = rig(argv => argv[0] === 'sh'
    ? { spawnError: { code: 'ENOENT', message: 'cannot start shell' } }
    : undefined)
  mkdirSync(join(processFailure.root, 'src'), { recursive: true })
  writeFileSync(join(processFailure.root, 'src', 'result.txt'), 'ready\n')
  const failedRuntime = folderRuntime(processFailure)
  const failedIdentity = await failedRuntime.captureContentIdentity()
  expect(await runEnrollmentGate(failedRuntime, {
    revision: 1, gateName: 'spawn-failure', command: 'true', timeoutSeconds: 5, contentIdentity: failedIdentity
  }, 'folder-gate-spawn-failure')).toEqual({ effect: 'not-landed', reason: 'check-failed' })
  expect(processFailure.checkRows.find(row => row.attemptId === 'folder-gate-spawn-failure')).toMatchObject({
    status: 'failed', timedOut: false
  })

  let raceRoot = ''
  const raced = rig(argv => {
    if (argv[0] === 'sh') writeFileSync(join(raceRoot, 'src', 'result.txt'), 'changed during check\n')
  })
  raceRoot = raced.root
  mkdirSync(join(raced.root, 'src'), { recursive: true })
  writeFileSync(join(raced.root, 'src', 'result.txt'), 'ready\n')
  const racedRuntime = folderRuntime(raced)
  const racedIdentity = await racedRuntime.captureContentIdentity()
  expect(await runEnrollmentGate(racedRuntime, {
    revision: 1, gateName: 'stale', command: 'true', timeoutSeconds: 5, contentIdentity: racedIdentity
  }, 'folder-gate-stale')).toEqual({ effect: 'not-landed', reason: 'check-evidence-stale' })
  expect(raced.checkRows.find(row => row.attemptId === 'folder-gate-stale')).toMatchObject({
    contentIdentity: racedIdentity, status: 'stale', exitCode: 0, timedOut: false
  })
  expect(r.calls.some(call => call.argv[0] === 'git')).toBe(false)
  expect(timed.calls.some(call => call.argv[0] === 'git')).toBe(false)
  expect(processFailure.calls.some(call => call.argv[0] === 'git')).toBe(false)
  expect(raced.calls.some(call => call.argv[0] === 'git')).toBe(false)
}, 30_000)
