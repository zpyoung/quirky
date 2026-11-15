import { expect, test } from 'bun:test'
import {
  assertExternalVisibilityStep,
  assertExternalWorktreeRemoved,
  EXTERNAL_VISIBILITY_STEPS,
  type ExternalVisibilityExpectation
} from './cli-visibility'
import { runProjectChecks } from './cli-checks'
import { runCliParity } from './cli-run'

const repoId = 'repo-fixture'
const externalWorktreeId = 'wt-external'
const externalPath = '/owned-home/external-worktrees/cli-parity-external'
const quirkyWorktreeId = 'wt-quirky'
const primaryWorktreeId = 'wt-primary'

type VisibilityInput = Parameters<typeof assertExternalVisibilityStep>[0]
type WorktreeRow = Record<string, unknown>
type InboxProject = Record<string, unknown>
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!isObjectRecord(value)) throw new Error('Expected a fixture object')
  return value
}

function worktreeRows(input: VisibilityInput): WorktreeRow[] {
  const rows = input.worktrees
  if (!Array.isArray(rows) || !rows.every(isObjectRecord)) throw new Error('Expected fixture worktree rows')
  return rows
}

function inboxProjects(input: VisibilityInput): InboxProject[] {
  const projects = objectRecord(input.inbox).projects
  if (!Array.isArray(projects) || !projects.every(isObjectRecord)) throw new Error('Expected fixture inbox projects')
  return projects
}


const expectedSteps: ExternalVisibilityExpectation[] = [
  { step: 'baseline', global: 'hide', project: 'inherit', effective: 'hide' },
  { step: 'show', global: 'hide', project: 'show', effective: 'show' },
  { step: 'hide', global: 'show', project: 'hide', effective: 'hide' },
  { step: 'inherit', global: 'show', project: 'inherit', effective: 'show' },
  { step: 'restored', global: 'hide', project: 'inherit', effective: 'hide' }
]

function fixture(expected: ExternalVisibilityExpectation): VisibilityInput {
  const isHidden = expected.effective === 'hide'
  const project = {
    repoId,
    externalVisibility: expected.project,
    effectiveExternalVisibility: expected.effective
  }
  return {
    expected,
    repoId,
    externalWorktreeId,
    externalPath,
    quirkyWorktreeId,
    project,
    worktrees: [
      {
        id: externalWorktreeId,
        path: externalPath,
        kind: 'git',
        isMain: false,
        createdBy: 'external',
        externalVisible: !isHidden,
        externalVisibility: expected.effective
      },
      {
        id: quirkyWorktreeId,
        path: '/owned-home/worktrees/cli-parity',
        kind: 'git',
        isMain: false,
        createdBy: 'cli',
        externalVisible: true,
        externalVisibility: 'show'
      },
      {
        id: primaryWorktreeId,
        path: '/owned-home/repository',
        kind: 'git',
        isMain: true,
        createdBy: 'repository',
        externalVisible: true,
        externalVisibility: expected.effective
      }
    ],
    inbox: {
      defaultVisibility: expected.global,
      projects: isHidden
        ? [{
            repoId,
            hiddenWorktreeIds: [externalWorktreeId],
            externalVisibility: expected.project,
            effectiveExternalVisibility: expected.effective
          }]
        : []
    },
    ...(expected.step === 'show' || expected.step === 'hide' || expected.step === 'inherit'
      ? { setResult: project }
      : {})
  }
}

function expectedStep(step: ExternalVisibilityExpectation['step']): ExternalVisibilityExpectation {
  const value = EXTERNAL_VISIBILITY_STEPS.find(candidate => candidate.step === step)
  if (!value) throw new Error(`Missing ${step} visibility expectation`)
  return value
}

function expectErrorContaining(action: () => unknown, fragments: string[]): void {
  let thrown: unknown
  try {
    action()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  if (!(thrown instanceof Error)) throw new Error('Expected action to throw')
  for (const fragment of fragments) expect(thrown.message).toContain(fragment)
}

function expectStepMismatch(
  expected: ExternalVisibilityExpectation,
  mismatch: string,
  mutate: (input: VisibilityInput) => void
): void {
  const input = fixture(expected)
  mutate(input)
  expectErrorContaining(() => assertExternalVisibilityStep(input), [expected.step, mismatch])
}

test('asserts each row of the external visibility matrix', () => {
  expect(EXTERNAL_VISIBILITY_STEPS).toEqual(expectedSteps)

  for (const expected of EXTERNAL_VISIBILITY_STEPS) {
    expect(assertExternalVisibilityStep(fixture(expected))).toEqual({
      ...expected,
      externalVisible: expected.effective === 'show',
      inboxHidden: expected.effective === 'hide'
    })
  }
})

test('rejects every named project, worktree-row and inbox mismatch', () => {
  const show = expectedStep('show')
  const baseline = expectedStep('baseline')
  const hide = expectedStep('hide')
  const mismatches: Array<{
    expected: ExternalVisibilityExpectation
    mismatch: string
    mutate: (input: VisibilityInput) => void
  }> = [
    {
      expected: show,
      mismatch: 'externalVisibility',
      mutate: input => {
        const project = objectRecord(input.project)
        project.externalVisibility = 'hide'
      }
    },
    {
      expected: show,
      mismatch: 'effectiveExternalVisibility',
      mutate: input => {
        const project = objectRecord(input.project)
        project.effectiveExternalVisibility = 'hide'
      }
    },
    {
      expected: show,
      mismatch: 'externalVisibility',
      mutate: input => {
        const result = objectRecord(input.setResult)
        result.externalVisibility = 'hide'
      }
    },
    {
      expected: show,
      mismatch: 'effectiveExternalVisibility',
      mutate: input => {
        const result = objectRecord(input.setResult)
        result.effectiveExternalVisibility = 'hide'
      }
    },
    {
      expected: show,
      mismatch: 'setResult',
      mutate: input => { delete input.setResult }
    },
    {
      expected: baseline,
      mismatch: externalWorktreeId,
      mutate: input => { input.worktrees = worktreeRows(input).filter(row => row.id !== externalWorktreeId) }
    },
    {
      expected: baseline,
      mismatch: externalWorktreeId,
      mutate: input => {
        const rows = worktreeRows(input)
        rows.push({ ...rows[0]! })
      }
    },
    {
      expected: baseline,
      mismatch: 'path',
      mutate: input => {
        const rows = worktreeRows(input)
        rows[0]!.path = '/wrong/path'
      }
    },
    {
      expected: baseline,
      mismatch: 'isMain',
      mutate: input => {
        const rows = worktreeRows(input)
        rows[0]!.isMain = true
      }
    },
    {
      expected: baseline,
      mismatch: 'createdBy',
      mutate: input => {
        const rows = worktreeRows(input)
        rows[0]!.createdBy = 'cli'
      }
    },
    {
      expected: baseline,
      mismatch: 'externalVisible',
      mutate: input => {
        const rows = worktreeRows(input)
        rows[0]!.externalVisible = true
      }
    },
    {
      expected: baseline,
      mismatch: 'externalVisibility',
      mutate: input => {
        const rows = worktreeRows(input)
        rows[0]!.externalVisibility = 'show'
      }
    },
    {
      expected: baseline,
      mismatch: quirkyWorktreeId,
      mutate: input => {
        const row = worktreeRows(input).find(candidate => candidate.id === quirkyWorktreeId)!
        row.externalVisible = false
      }
    },
    {
      expected: baseline,
      mismatch: primaryWorktreeId,
      mutate: input => {
        const row = worktreeRows(input).find(candidate => candidate.id === primaryWorktreeId)!
        row.externalVisible = false
      }
    },
    {
      expected: baseline,
      mismatch: 'defaultVisibility',
      mutate: input => {
        const inbox = objectRecord(input.inbox)
        inbox.defaultVisibility = 'show'
      }
    },
    {
      expected: show,
      mismatch: 'repoId',
      mutate: input => { inboxProjects(input).push({ repoId }) }
    },
    {
      expected: hide,
      mismatch: 'repoId',
      mutate: input => {
        const inbox = objectRecord(input.inbox)
        inbox.projects = []
      }
    },
    {
      expected: hide,
      mismatch: 'repoId',
      mutate: input => {
        const inbox = objectRecord(input.inbox)
        inbox.projects = [{ repoId: 'other-repo' }]
      }
    },
    {
      expected: hide,
      mismatch: 'repoId',
      mutate: input => { inboxProjects(input).push({ repoId: 'other-repo' }) }
    }
  ]

  for (const { expected, mismatch, mutate } of mismatches) {
    expectStepMismatch(expected, mismatch, mutate)
  }
})

test('proves external-worktree removal and rejects either remaining reference', () => {
  const input = fixture(expectedStep('baseline'))
  input.worktrees = worktreeRows(input).filter(row => row.id !== externalWorktreeId)
  objectRecord(input.inbox).projects = []
  expect(assertExternalWorktreeRemoved({
    repoId,
    externalWorktreeId,
    worktrees: input.worktrees,
    inbox: input.inbox
  })).toBeUndefined()

  expectErrorContaining(() => assertExternalWorktreeRemoved({
    repoId,
    externalWorktreeId,
    worktrees: fixture(expectedStep('baseline')).worktrees,
    inbox: { defaultVisibility: 'hide', projects: [] }
  }), [externalWorktreeId])

  expectErrorContaining(() => assertExternalWorktreeRemoved({
    repoId,
    externalWorktreeId,
    worktrees: [],
    inbox: { defaultVisibility: 'hide', projects: [{ repoId, hiddenWorktreeIds: [externalWorktreeId] }] }
  }), [repoId])
})

test('runs project checks against a real owned world and records the visibility proof', async () => {
  const report = await runCliParity({ runChecks: runProjectChecks })
  const rows = new Map(report.rows.map(row => [row.id, row]))
  for (const id of ['repo-add', 'repo-list', 'repo-set', 'repo-set-base-ref', 'repo-show']) {
    expect(rows.get(id), id).toMatchObject({ status: 'passed', executed: true })
  }
  expect(rows.get('repo-set')!.catalogRefs).toContain('command:worktree project-set')
  expect(rows.get('repo-set')!.catalogRefs).toContain('method:quirky.worktree/setProjectMetadata')
  expect(rows.get('repo-set-base-ref')!.catalogRefs).toContain('command:repo set')

  const receipt = report.receipts.find(item => item.id === 'repo-set')
  expect(receipt).toBeTruthy()
  expect(receipt!.evidence).toEqual({
    repoId: expect.any(String),
    externalWorktreeId: expect.any(String),
    selector: 'path',
    steps: [
      { step: 'baseline', global: 'hide', project: 'inherit', effective: 'hide', externalVisible: false, inboxHidden: true },
      { step: 'show', global: 'hide', project: 'show', effective: 'show', externalVisible: true, inboxHidden: false },
      { step: 'hide', global: 'show', project: 'hide', effective: 'hide', externalVisible: false, inboxHidden: true },
      { step: 'inherit', global: 'show', project: 'inherit', effective: 'show', externalVisible: true, inboxHidden: false },
      { step: 'restored', global: 'hide', project: 'inherit', effective: 'hide', externalVisible: false, inboxHidden: true }
    ],
    invalidValue: { code: 'usage' },
    removed: true
  })

  expect(report.cleanup.ok).toBe(true)
  expect(report.ok).toBe(false)
  expect(report.error).toMatchObject({ kind: 'missing-receipt' })
  expect([
    'catalog', 'repo-add', 'folder-add', 'folder-idempotent', 'repo-list', 'repo-set-base-ref', 'repo-show',
    'worktree-create', 'worktree-list', 'worktree-show', 'worktree-set', 'repo-set'
  ]).not.toContain(report.error!.stage)
}, 150_000)
