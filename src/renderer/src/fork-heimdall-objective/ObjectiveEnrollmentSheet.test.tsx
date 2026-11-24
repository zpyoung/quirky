// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../shared/constants'
import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  OBJECTIVE_EXISTING_PLAN_MAX_LENGTH,
  objectiveCapabilityModes
} from '../../../shared/fork-heimdall-objective/contract-types'
import { HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY } from '../../../shared/fork-heimdall/capability'
import { defaultWatcherOwnerDraft } from '../fork-heimdall/watcher-owner-draft'
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import { ObjectiveEnrollmentGateFields } from './ObjectiveEnrollmentGateFields'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import {
  isObjectiveLandingBarAvailable,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBarAvailability
} from './objective-enrollment-model'
import {
  buildObjectiveWorkspaceOptions,
  type ObjectiveWorkspaceOption
} from './objective-workspace-options'

afterEach(cleanup)
function draft(overrides: Partial<ObjectiveEnrollmentDraft> = {}): ObjectiveEnrollmentDraft {
  return {
    objectiveText: 'Ship the objective watcher',
    newWorktreeName: '',
    newWorktreeNameEdited: false,
    newWorktreeBaseBranch: undefined,
    existingPlanText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    lanesEnabled: true,
    workspaceKind: 'git',
    writeTerritoryText: 'src/**\ntests/**',
    capabilities: objectiveCapabilityModes('files-on-disk'),
    roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    gates: [],
    activeBudgetHours: 4,
    turns: '40',
    availableAgentIds: ['codex'],
    owner: defaultWatcherOwnerDraft(),
    ...overrides
  }
}
function textareaValue(element: HTMLElement): string {
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error('expected a textarea element')
  }
  return element.value
}
function objectiveWorkspace(): ObjectiveWorkspaceOption {
  return {
    key: 'runtime:hermes:repo:worktree',
    repoId: 'repo',
    repoPath: '/workspace/repo',
    worktreeId: 'worktree',
    workspacePath: '/workspace/repo',
    branch: 'main',
    workspaceKind: 'git',
    label: 'Workspace',
    detail: '/workspace',
    owner: { connectionId: 'hermes', pairingRevision: 22 },
    ownerUnavailable: false,
    parallelExecutionSupported: true,
    roleLaunchSupported: true,
    availableAgentIds: ['codex']
  }
}

function EditableObjectiveFields({
  existingPlanText = ''
}: {
  existingPlanText?: string
}): React.JSX.Element {
  const [currentDraft, setCurrentDraft] = useState(() =>
    draft({ objectiveText: '', existingPlanText })
  )
  return (
    <TooltipProvider delayDuration={400}>
      <ObjectiveEnrollmentFields
        draft={currentDraft}
        selectedWorkspaceKey=""
        workspaces={[]}
        landingAvailability={{ workspaceKind: null, worktreeId: null }}
        agents={[]}
        disabled={false}
        onWorkspaceChange={() => {}}
        onDraftChange={setCurrentDraft}
      />
    </TooltipProvider>
  )
}

const NO_GATES: ObjectiveEnrollmentDraft['gates'] = []

function EditableObjectiveGateFields({
  onSubmit,
  parallelUnsupported = false,
  initialGates = NO_GATES
}: {
  onSubmit: (draft: ObjectiveEnrollmentDraft) => void
  parallelUnsupported?: boolean
  initialGates?: ObjectiveEnrollmentDraft['gates']
}): React.JSX.Element {
  const [currentDraft, setCurrentDraft] = useState(() => draft({ gates: initialGates }))
  const [showValidation, setShowValidation] = useState(false)
  const errors = validateObjectiveEnrollmentDraft(currentDraft, {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    parallelUnsupported
  })
  return (
    <TooltipProvider delayDuration={400}>
      <ObjectiveEnrollmentGateFields
        draft={currentDraft}
        disabled={false}
        parallelUnsupported={parallelUnsupported}
        onDraftChange={setCurrentDraft}
      />
      {showValidation
        ? errors.map((error) => (
            <p key={error.code} role="alert">
              {error.code}
            </p>
          ))
        : null}
      <button
        type="button"
        onClick={() => {
          setShowValidation(true)
          if (errors.length === 0) {
            onSubmit(currentDraft)
          }
        }}
      >
        Start objective
      </button>
    </TooltipProvider>
  )
}

function deferredPlanFile(): { file: File; resolve: (contents: string) => void } {
  let resolve!: (contents: string) => void
  const contents = new Promise<string>((settle) => {
    resolve = settle
  })
  const file = new File([], 'deferred.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'text', { value: () => contents })
  return { file, resolve }
}

function runtimeState(): Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'runtimeEnvironments'
  | 'detectedAgentIds'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
  | 'runtimeStatusByEnvironmentId'
  | 'settings'
> {
  return {
    repos: [
      {
        id: 'git-repo',
        path: '/workspace/git',
        displayName: 'Git project',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'ssh:build'
      },
      {
        id: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'Folder project',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'runtime:hermes'
      }
    ],
    worktreesByRepo: {
      'git-repo': [
        {
          id: 'git-repo::/workspace/git',
          repoId: 'git-repo',
          path: '/workspace/git',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: true,
          displayName: 'main',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          hostId: 'ssh:build'
        }
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [
      {
        id: 'hermes',
        name: 'Hermes',
        createdAt: 10,
        updatedAt: 20,
        pairingRevision: 22,
        lastUsedAt: null,
        runtimeId: 'runtime-hermes',
        endpoints: [],
        preferredEndpointId: 'ws-hermes'
      }
    ],
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: { build: ['claude'] },
    runtimeDetectedAgentIds: { hermes: ['codex'] },
    runtimeStatusByEnvironmentId: new Map(),
    settings: { ...getDefaultSettings('/tmp'), disabledTuiAgents: [] }
  }
}

describe('objective enrollment contract', () => {
  it('lets the user enter objective text into the controlled field', () => {
    render(<EditableObjectiveFields />)

    const objective = screen.getByRole('textbox', { name: 'Objective' })
    fireEvent.change(objective, { target: { value: 'Ship the visible objective' } })

    expect(textareaValue(objective)).toBe('Ship the visible objective')
  })

  it('renders the gate editor immediately after the parallel-execution fields', () => {
    render(<EditableObjectiveFields />)

    const headings = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent)
    const executionIndex = headings.indexOf('Execution contract')
    const gatesIndex = headings.indexOf('Gates')

    expect(executionIndex).toBeGreaterThanOrEqual(0)
    expect(gatesIndex).toBe(executionIndex + 1)
  })

  it('keeps the prior source plan when an imported file exceeds the pre-read size limit', () => {
    const priorPlan = '# Existing plan'
    const { container } = render(<EditableObjectiveFields existingPlanText={priorPlan} />)
    const source = screen.getByRole('textbox', { name: 'Existing plan source' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    const oversizedFile = new File(
      [new Uint8Array(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH * 4 + 1)],
      'oversized.md',
      { type: 'text/markdown' }
    )

    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, { target: { files: [oversizedFile] } })

    expect(textareaValue(source)).toBe(priorPlan)
    expect(source.getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps concurrent draft edits and cancels a pending import when the plan is removed', async () => {
    const { container } = render(<EditableObjectiveFields existingPlanText="# Existing plan" />)
    const objective = screen.getByRole('textbox', { name: 'Objective' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    const firstImport = deferredPlanFile()

    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, { target: { files: [firstImport.file] } })
    fireEvent.change(objective, { target: { value: 'Latest objective text' } })
    await act(async () => {
      firstImport.resolve('# Imported plan')
      await Promise.resolve()
    })

    expect(textareaValue(objective)).toBe('Latest objective text')
    expect(textareaValue(screen.getByRole('textbox', { name: 'Existing plan source' }))).toBe(
      '# Imported plan'
    )

    const staleImport = deferredPlanFile()
    fireEvent.change(fileInput!, { target: { files: [staleImport.file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove plan' }))
    await act(async () => {
      staleImport.resolve('# Stale plan')
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add existing plan' }))

    expect(textareaValue(screen.getByRole('textbox', { name: 'Existing plan source' }))).toBe('')
  })

  it('rejects source plans only after the shared character limit', () => {
    const availability: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: 'worktree'
    }

    expect(
      validateObjectiveEnrollmentDraft(
        draft({ existingPlanText: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH) }),
        availability
      ).some((error) => error.code === 'existing-plan-too-long')
    ).toBe(false)
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ existingPlanText: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH + 1) }),
        availability
      ).some((error) => error.code === 'existing-plan-too-long')
    ).toBe(true)
  })
  it('blocks plan-off when the form cannot establish a reusable approved plan', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    expect(
      validateObjectiveEnrollmentDraft(
        draft({
          capabilities: { ...capabilities, plan: 'off' },
          existingPlanText: '# Planner source is not an approved plan'
        }),
        { workspaceKind: 'git', worktreeId: 'worktree' }
      )
    ).toContainEqual({ code: 'plan-off-requires-approved-plan' })
  })

  it('prevalidates the owner rules the RPC cannot describe', () => {
    const errors = validateObjectiveEnrollmentDraft(
      draft({
        workspaceKind: 'folder',
        landingBar: 'merged',
        maxConcurrency: 0,
        writeTerritoryText: '.g*/**\nsrc/**\nsrc/**',
        roleAgents: { planner: 'claude', implementer: '', reviewer: '', integrator: '' }
      }),
      { workspaceKind: 'folder', worktreeId: null }
    )

    expect(errors.map((error) => error.code)).toEqual([
      'landing-bar-requires-git',
      'max-concurrency-invalid',
      'territory-duplicate',
      'territory-invalid',
      'role-agent-unknown'
    ])
  })

  it('treats blank territory as the whole workspace when validating and serializing', () => {
    const blankTerritoryDraft = draft({ writeTerritoryText: ' \n\t' })

    expect(
      validateObjectiveEnrollmentDraft(blankTerritoryDraft, {
        workspaceKind: 'git',
        worktreeId: 'worktree'
      })
    ).toEqual([])
    expect(
      buildObjectiveEnrollmentSubmission(blankTerritoryDraft, objectiveWorkspace()).input
    ).toMatchObject({
      kindPayload: { writeTerritory: [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB] }
    })
  })

  it('offers hosted landing bars immediately for a selected git worktree', () => {
    const folder: ObjectiveLandingBarAvailability = {
      workspaceKind: 'folder',
      worktreeId: null
    }
    const missingWorktree: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: null
    }
    const gitWorktree: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: 'worktree'
    }

    expect(isObjectiveLandingBarAvailable(folder, 'files-on-disk')).toBe(true)
    expect(isObjectiveLandingBarAvailable(folder, 'committed-local-branch')).toBe(false)
    expect(isObjectiveLandingBarAvailable(folder, 'pushed-ref')).toBe(false)
    expect(isObjectiveLandingBarAvailable(missingWorktree, 'hosted-review')).toBe(false)
    expect(isObjectiveLandingBarAvailable(gitWorktree, 'hosted-review')).toBe(true)
    expect(isObjectiveLandingBarAvailable(gitWorktree, 'merged')).toBe(true)
    expect(validateObjectiveEnrollmentDraft(draft({ landingBar: 'merged' }), gitWorktree)).toEqual(
      []
    )
  })

  it('routes SSH Git and an unhydrated runtime folder Repo to their actual hosts', () => {
    const options = buildObjectiveWorkspaceOptions(runtimeState())
    const git = options.find((option) => option.workspaceKind === 'git')
    const folder = options.find((option) => option.workspaceKind === 'folder')

    expect(git).toMatchObject({
      repoId: 'git-repo',
      worktreeId: 'git-repo::/workspace/git',
      owner: undefined,
      availableAgentIds: ['claude']
    })
    expect(folder).toMatchObject({
      repoId: 'folder-repo',
      worktreeId: null,
      owner: { connectionId: 'hermes', pairingRevision: 22 },
      availableAgentIds: ['codex']
    })
  })

  it('requires role-launch support independently of parallel-execution support', () => {
    const runtimeStatusEntries = new Map([
      [
        'hermes',
        {
          status: { capabilities: [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY] },
          connectionGeneration: 1
        }
      ]
    ])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Projection reads only capabilities.
    const runtimeStatusByEnvironmentId = runtimeStatusEntries as never
    const options = buildObjectiveWorkspaceOptions({
      ...runtimeState(),
      runtimeStatusByEnvironmentId
    })
    const runtimeFolder = options.find((option) => option.repoId === 'folder-repo')

    expect(runtimeFolder).toMatchObject({
      parallelExecutionSupported: true,
      roleLaunchSupported: false
    })
  })

  it('treats missing runtime capability status as unsupported for role launch', () => {
    const runtimeFolder = buildObjectiveWorkspaceOptions(runtimeState()).find(
      (option) => option.repoId === 'folder-repo'
    )

    expect(runtimeFolder).toMatchObject({
      parallelExecutionSupported: false,
      roleLaunchSupported: false
    })
  })

  it('uses the canonical local folder-workspace identity for enrollment', () => {
    const options = buildObjectiveWorkspaceOptions({
      ...runtimeState(),
      folderWorkspaces: [
        {
          id: 'notes',
          projectGroupId: 'personal',
          name: 'Notes',
          folderPath: '/workspace/notes',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 1,
          createdAt: 1,
          updatedAt: 1,
          executionHostId: 'local'
        }
      ],
      projectGroups: [
        {
          id: 'personal',
          name: 'Personal',
          parentPath: '/workspace',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    expect(options.find((option) => option.workspacePath === '/workspace/notes')).toMatchObject({
      repoId: 'folder-workspace:personal',
      worktreeId: 'folder:notes',
      workspaceKind: 'folder',
      owner: undefined,
      availableAgentIds: ['claude']
    })
  })

  it('builds the exact enrollment payload and passes the selected owner fence', () => {
    const workspace = objectiveWorkspace()
    const submission = buildObjectiveEnrollmentSubmission(
      draft({
        objectiveText: '  Ship it  ',
        existingPlanText: '  # Supplied plan\n\nShip task A.  ',
        roleAgents: { planner: 'codex', implementer: '', reviewer: '', integrator: '' },
        sitterOverrides: {
          updateBranch: 'gated',
          resolveConflicts: 'inherit',
          fixChecks: 'inherit',
          merge: 'off'
        }
      }),
      workspace
    )

    expect(submission.owner).toEqual({ connectionId: 'hermes', pairingRevision: 22 })
    expect(submission.input).toMatchObject({
      kind: 'objective',
      repoId: 'repo',
      worktreeId: 'worktree',
      budget: { wallClockActiveMs: 14_400_000, turns: 40 },
      kindPayload: {
        objectiveText: 'Ship it',
        maxConcurrency: 1,
        lanesEnabled: true,
        existingPlan: '# Supplied plan\n\nShip task A.',
        workspaceKind: 'git',
        writeTerritory: ['src/**', 'tests/**'],
        roleAgents: { planner: 'codex' },
        sitterOverrides: { updateBranch: 'gated', merge: 'off' }
      }
    })
    expect(
      buildObjectiveEnrollmentSubmission(draft({ existingPlanText: ' \n\t' }), objectiveWorkspace())
        .input.kindPayload
    ).not.toHaveProperty('existingPlan')
  })

  it('strips parallel-only fields when enrolling on an older remote host', () => {
    const workspace = { ...objectiveWorkspace(), parallelExecutionSupported: false }
    const submission = buildObjectiveEnrollmentSubmission(
      draft({ lanesEnabled: true, maxConcurrency: 7 }),
      workspace
    )

    expect(submission.input.kindPayload).toMatchObject({ maxConcurrency: 1 })
    expect(submission.input.kindPayload).not.toHaveProperty('lanesEnabled')
  })

  it('omits owner and its capability from the submission when no owner is configured', () => {
    const submission = buildObjectiveEnrollmentSubmission(draft(), objectiveWorkspace())

    expect(submission.input.owner).toBeUndefined()
    expect(submission.input.ownerInterventionCapability).toBeUndefined()
  })

  it('submits a configured claude owner and its gated intervention capability', () => {
    const submission = buildObjectiveEnrollmentSubmission(
      draft({ owner: { enabled: true, model: 'opus', effort: 'high' } }),
      objectiveWorkspace()
    )

    expect(submission.input.owner).toEqual({ agent: 'claude', model: 'opus', effort: 'high' })
    expect(submission.input.ownerInterventionCapability).toBe('gated')
  })

  it('adds a gate and sends it in the enrollment submission', () => {
    const onSubmit = vi.fn<(draft: ObjectiveEnrollmentDraft) => void>()
    render(<EditableObjectiveGateFields onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add gate' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'lint' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'pnpm lint' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start objective' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const submittedDraft = onSubmit.mock.calls[0]?.[0]
    if (!submittedDraft) {
      throw new Error('expected onSubmit to receive a draft')
    }
    const submission = buildObjectiveEnrollmentSubmission(submittedDraft, objectiveWorkspace())
    expect(submission.input.kindPayload).toMatchObject({
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 1_800 }]
    })
  })

  it('shows the invalid gate name error and blocks submit', () => {
    const onSubmit = vi.fn()
    render(<EditableObjectiveGateFields onSubmit={onSubmit} />)

    fireEvent.click(screen.getByRole('button', { name: 'Add gate' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Lint' } })
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'pnpm lint' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start objective' }))

    expect(screen.getByRole('alert').textContent).toBe('gate-name-invalid')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('disables gate inputs and Add on a parallel-unsupported host, but keeps rows removable', () => {
    const onSubmit = vi.fn()
    render(
      <EditableObjectiveGateFields
        onSubmit={onSubmit}
        parallelUnsupported
        initialGates={[
          { rowKey: 'gate-1', name: 'lint', command: 'pnpm lint', timeoutSecondsText: '' }
        ]}
      />
    )

    expect(screen.getByText(/Gates are unavailable on this host's Quirky version/)).toBeVisible()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Command')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add gate' })).toBeDisabled()
    const removeButton = screen.getByRole('button', { name: 'Remove gate 1' })
    expect(removeButton).toBeEnabled()

    fireEvent.click(removeButton)
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  it('blocks submit with gates-unsupported-host while a gate is present on that host', () => {
    const onSubmit = vi.fn()
    render(
      <EditableObjectiveGateFields
        onSubmit={onSubmit}
        parallelUnsupported
        initialGates={[
          { rowKey: 'gate-1', name: 'lint', command: 'pnpm lint', timeoutSecondsText: '' }
        ]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Start objective' }))

    expect(screen.getByRole('alert').textContent).toBe('gates-unsupported-host')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
