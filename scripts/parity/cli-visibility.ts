import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CliCheckContext } from './cli-checks'

export type ExternalVisibilityStepName = 'baseline' | 'show' | 'hide' | 'inherit' | 'restored'
export type ExternalVisibilityExpectation = {
  step: ExternalVisibilityStepName
  global: 'show' | 'hide'
  project: 'show' | 'hide' | 'inherit'
  effective: 'show' | 'hide'
}
export const EXTERNAL_VISIBILITY_STEPS: readonly ExternalVisibilityExpectation[] = [
  { step: 'baseline', global: 'hide', project: 'inherit', effective: 'hide' },
  { step: 'show', global: 'hide', project: 'show', effective: 'show' },
  { step: 'hide', global: 'show', project: 'hide', effective: 'hide' },
  { step: 'inherit', global: 'show', project: 'inherit', effective: 'show' },
  { step: 'restored', global: 'hide', project: 'inherit', effective: 'hide' }
]
export type ExternalVisibilityStepEvidence = ExternalVisibilityExpectation & {
  externalVisible: boolean
  inboxHidden: boolean
}

type ObjectValue = Record<string, unknown>

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function assertEqual(actual: unknown, expected: unknown, step: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${step}: ${label} mismatch (expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)})`)
  }
}

function assertOneRow(rows: ObjectValue[], id: string, step: string, label: string): ObjectValue {
  const matches = rows.filter(row => row.id === id)
  if (matches.length !== 1) {
    throw new Error(`${step}: ${label} ${id} expected exactly one worktree row, found ${matches.length}`)
  }
  return matches[0]!
}

function assertProjectMetadata(
  value: unknown,
  repoId: string,
  externalVisibility: ExternalVisibilityExpectation['project'],
  effectiveVisibility: ExternalVisibilityExpectation['effective'],
  label: string
): void {
  const project = object(value, `${label} project`)
  assertEqual(project.repoId, repoId, label, `${label}.repoId`)
  assertEqual(project.externalVisibility, externalVisibility, label, `${label}.externalVisibility`)
  assertEqual(project.effectiveExternalVisibility, effectiveVisibility, label, `${label}.effectiveExternalVisibility`)
}

function pathIsUnder(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate))
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

function assertExternalPathSafe(home: string, worktreesRoot: string, candidate: string): void {
  if (!pathIsUnder(home, candidate)) {
    throw new Error(`repo-set: external Git worktree path escaped the owned home: ${candidate}`)
  }
  if (pathIsUnder(worktreesRoot, candidate)) {
    throw new Error(`repo-set: external Git worktree path is inside the Quirky worktrees root: ${candidate}`)
  }
}

function assertOptionDefault(value: unknown, expected: 'show' | 'hide', label: string): void {
  const options = object(value, `${label} result`)
  assertEqual(options.externalVisibilityDefault, expected, label, `${label}.externalVisibilityDefault`)
}

export function assertExternalVisibilityStep(input: {
  expected: ExternalVisibilityExpectation
  repoId: string
  externalWorktreeId: string
  externalPath: string
  quirkyWorktreeId: string
  project: unknown
  worktrees: unknown
  inbox: unknown
  setResult?: unknown
}): ExternalVisibilityStepEvidence {
  const { expected, repoId, externalWorktreeId, externalPath, quirkyWorktreeId } = input
  const step = expected.step
  assertProjectMetadata(input.project, repoId, expected.project, expected.effective, `${step} project`)

  const setResultRequired = expected.step === 'show' || expected.step === 'hide' || expected.step === 'inherit'
  if (input.setResult === undefined) {
    if (setResultRequired) throw new Error(`${step}: setResult is required for a project visibility change`)
  } else {
    assertProjectMetadata(input.setResult, repoId, expected.project, expected.effective, `${step} setResult`)
  }

  const worktrees = array(input.worktrees, `${step} worktrees`).map((row, index) => object(row, `${step} worktrees[${index}]`))
  const external = assertOneRow(worktrees, externalWorktreeId, step, 'external worktree')
  assertEqual(external.path, externalPath, step, `external worktree ${externalWorktreeId}.path`)
  assertEqual(external.kind, 'git', step, `external worktree ${externalWorktreeId}.kind`)
  assertEqual(external.isMain, false, step, `external worktree ${externalWorktreeId}.isMain`)
  assertEqual(external.createdBy, 'external', step, `external worktree ${externalWorktreeId}.createdBy`)
  const shouldBeVisible = expected.effective === 'show'
  assertEqual(external.externalVisible, shouldBeVisible, step, `external worktree ${externalWorktreeId}.externalVisible`)
  assertEqual(external.externalVisibility, expected.effective, step, `external worktree ${externalWorktreeId}.externalVisibility`)

  const quirky = assertOneRow(worktrees, quirkyWorktreeId, step, 'Quirky worktree')
  assertEqual(quirky.externalVisible, true, step, `Quirky worktree ${quirkyWorktreeId}.externalVisible`)
  if (quirky.createdBy === 'external') {
    throw new Error(`${step}: Quirky worktree ${quirkyWorktreeId}.createdBy must not be external`)
  }

  const primaryRows = worktrees.filter(row => row.isMain === true)
  if (primaryRows.length !== 1) {
    throw new Error(`${step}: expected exactly one primary worktree row, found ${primaryRows.length}`)
  }
  const primary = primaryRows[0]!
  assertEqual(primary.externalVisible, true, step, `primary worktree row ${String(primary.id)}.externalVisible`)

  const inbox = object(input.inbox, `${step} inbox`)
  assertEqual(inbox.defaultVisibility, expected.global, step, 'inbox.defaultVisibility')
  const inboxProjects = array(inbox.projects, `${step} inbox.projects`)
    .map((project, index) => object(project, `${step} inbox.projects[${index}]`))
  const repoProjects = inboxProjects.filter(project => project.repoId === repoId)
  if (expected.effective === 'show') {
    if (repoProjects.length > 0) {
      throw new Error(`${step}: inbox projects lists repoId ${repoId} while external visibility is show`)
    }
    return { ...expected, externalVisible: shouldBeVisible, inboxHidden: false }
  }

  if (repoProjects.length !== 1) {
    throw new Error(`${step}: inbox projects should contain repoId ${repoId} exactly once while hidden; found ${repoProjects.length}`)
  }
  if (inboxProjects.length !== 1) {
    throw new Error(`${step}: inbox projects contains other repo IDs while repoId ${repoId} is hidden`)
  }
  const inboxProject = repoProjects[0]!
  assertEqual(inboxProject.externalVisibility, expected.project, step, `inbox project ${repoId}.externalVisibility`)
  assertEqual(inboxProject.effectiveExternalVisibility, expected.effective, step, `inbox project ${repoId}.effectiveExternalVisibility`)
  const hiddenWorktreeIds = array(inboxProject.hiddenWorktreeIds, `${step} inbox project ${repoId}.hiddenWorktreeIds`)
  if (hiddenWorktreeIds.length !== 1 || hiddenWorktreeIds[0] !== externalWorktreeId) {
    throw new Error(`${step}: inbox project ${repoId}.hiddenWorktreeIds expected only ${externalWorktreeId}`)
  }
  return { ...expected, externalVisible: shouldBeVisible, inboxHidden: true }
}

export function assertExternalWorktreeRemoved(input: {
  repoId: string
  externalWorktreeId: string
  worktrees: unknown
  inbox: unknown
}): void {
  const worktrees = array(input.worktrees, 'removed worktrees')
    .map((row, index) => object(row, `removed worktrees[${index}]`))
  if (worktrees.some(row => row.id === input.externalWorktreeId)) {
    throw new Error(`repo-set: removed external worktree ${input.externalWorktreeId} remains in worktree list`)
  }

  const inbox = object(input.inbox, 'removed external inbox')
  const projects = array(inbox.projects, 'removed external inbox.projects')
    .map((project, index) => object(project, `removed external inbox.projects[${index}]`))
  if (projects.some(project => project.repoId === input.repoId)) {
    throw new Error(`repo-set: removed external worktree for repo ${input.repoId} remains in external inbox`)
  }
}
function worktreeIdAtPath(value: unknown, path: string): string {
  const rows = array(value, 'repo-set baseline worktree list')
    .map((row, index) => object(row, `repo-set baseline worktree list[${index}]`))
  const matches = rows.filter(row => row.path === path)
  if (matches.length !== 1) {
    throw new Error(`baseline: expected one worktree row at ${path}, found ${matches.length}`)
  }
  const id = matches[0]!.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`baseline: worktree row at ${path} has no valid ID`)
  }
  return id
}


async function readVisibilityStep(
  context: CliCheckContext,
  expected: ExternalVisibilityExpectation,
  repoId: string,
  externalWorktreeId: string,
  externalPath: string,
  quirkyWorktreeId: string,
  receiptPrefix: string,
  setResult?: unknown
): Promise<ExternalVisibilityStepEvidence> {
  const project = await context.call(`${receiptPrefix}-project`, ['worktree', 'project-show', repoId])
  const worktrees = await context.call(`${receiptPrefix}-list`, ['worktree', 'list', '--repo', `id:${repoId}`])
  const inbox = await context.call(`${receiptPrefix}-inbox`, ['worktree', 'external-inbox'])
  return assertExternalVisibilityStep({
    expected,
    repoId,
    externalWorktreeId,
    externalPath,
    quirkyWorktreeId,
    project,
    worktrees,
    inbox,
    ...(setResult === undefined ? {} : { setResult })
  })
}

export async function runRepoVisibilityCheck(context: CliCheckContext): Promise<void> {
  context.check('repo-set')
  const repoId = requiredState(context.state.repoId, 'repoId')
  const quirkyWorktreeId = requiredState(context.state.worktreeId, 'worktreeId')
  const repoPath = realpathSync(context.world.paths.repository)
  const externalParent = join(context.world.home, 'external-worktrees')
  mkdirSync(externalParent, { mode: 0o700 })
  const externalCandidate = join(realpathSync(externalParent), 'cli-parity-external')
  const home = realpathSync(context.world.home)
  const worktreesRoot = realpathSync(context.world.paths.worktreesRoot)
  assertExternalPathSafe(home, worktreesRoot, externalCandidate)
  if (existsSync(externalCandidate)) {
    throw new Error(`repo-set: external Git worktree path already exists: ${externalCandidate}`)
  }

  execFileSync('git', ['worktree', 'add', '--detach', externalCandidate, 'main'], {
    cwd: repoPath,
    env: context.world.env,
    timeout: 10_000,
    encoding: 'utf8'
  })
  const externalPath = realpathSync(externalCandidate)
  assertExternalPathSafe(home, worktreesRoot, externalPath)

  const baselineProject = await context.call('repo-set-baseline-project', ['worktree', 'project-show', repoId])
  const baselineWorktrees = await context.call('repo-set-baseline-list', ['worktree', 'list', '--repo', `id:${repoId}`])
  const baselineInbox = await context.call('repo-set-baseline-inbox', ['worktree', 'external-inbox'])
  const externalWorktreeId = worktreeIdAtPath(baselineWorktrees, externalPath)
  const baseline = assertExternalVisibilityStep({
    expected: EXTERNAL_VISIBILITY_STEPS[0]!,
    repoId,
    externalWorktreeId,
    externalPath,
    quirkyWorktreeId,
    project: baselineProject,
    worktrees: baselineWorktrees,
    inbox: baselineInbox
  })

  const showResult = await context.call('repo-set', [
    'worktree', 'project-set', `path:${repoPath}`, '--external-worktree-visibility', 'show'
  ])
  const show = await readVisibilityStep(
    context, EXTERNAL_VISIBILITY_STEPS[1]!, repoId, externalWorktreeId, externalPath,
    quirkyWorktreeId, 'repo-set-show', showResult
  )

  const invalid = await context.refuse('repo-set-invalid', [
    'worktree', 'project-set', repoId, '--external-worktree-visibility', 'visible'
  ], { expectedExit: 2 })
  if (invalid.code !== 'usage') throw new Error(`repo-set invalid visibility refusal expected usage, received ${invalid.code}`)
  const usagePrefix = '--external-worktree-visibility must be one of show, hide, inherit'
  if (!invalid.message.startsWith(usagePrefix)) {
    throw new Error(`repo-set invalid visibility refusal message did not start with ${usagePrefix}`)
  }
  const invalidProject = await context.call('repo-set-invalid-project', ['worktree', 'project-show', repoId])
  assertProjectMetadata(invalidProject, repoId, 'show', 'show', 'repo-set invalid project readback')

  const globalShow = await context.call('repo-set-global-show', [
    'worktree', 'options', '--external-visibility-default', 'show'
  ])
  assertOptionDefault(globalShow, 'show', 'repo-set global show')

  const hideResult = await context.call('repo-set-hide', [
    'worktree', 'project-set', repoId, '--external-worktree-visibility', 'hide'
  ])
  const hide = await readVisibilityStep(
    context, EXTERNAL_VISIBILITY_STEPS[2]!, repoId, externalWorktreeId, externalPath,
    quirkyWorktreeId, 'repo-set-hide', hideResult
  )

  const inheritResult = await context.call('repo-set-inherit', [
    'worktree', 'project-set', repoId, '--external-worktree-visibility', 'inherit'
  ])
  const inherit = await readVisibilityStep(
    context, EXTERNAL_VISIBILITY_STEPS[3]!, repoId, externalWorktreeId, externalPath,
    quirkyWorktreeId, 'repo-set-inherit', inheritResult
  )

  const globalHide = await context.call('repo-set-global-hide', [
    'worktree', 'options', '--external-visibility-default', 'hide'
  ])
  assertOptionDefault(globalHide, 'hide', 'repo-set global hide')
  const restored = await readVisibilityStep(
    context, EXTERNAL_VISIBILITY_STEPS[4]!, repoId, externalWorktreeId, externalPath,
    quirkyWorktreeId, 'repo-set-restored'
  )

  execFileSync('git', ['worktree', 'remove', '--force', externalPath], {
    cwd: repoPath,
    env: context.world.env,
    timeout: 10_000,
    encoding: 'utf8'
  })
  const removedList = await context.call('repo-set-removed-list', ['worktree', 'list', '--repo', `id:${repoId}`])
  const removedInbox = await context.call('repo-set-removed-inbox', ['worktree', 'external-inbox'])
  assertExternalWorktreeRemoved({ repoId, externalWorktreeId, worktrees: removedList, inbox: removedInbox })
  if (existsSync(externalPath)) {
    throw new Error(`repo-set: removed external worktree ${externalWorktreeId} still exists at ${externalPath}`)
  }

  context.prove('repo-set', {
    repoId,
    externalWorktreeId,
    selector: 'path',
    steps: [baseline, show, hide, inherit, restored],
    invalidValue: { code: invalid.code },
    removed: true
  })
}

function requiredState(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`repo-set requires check state.${name}`)
  return value
}

