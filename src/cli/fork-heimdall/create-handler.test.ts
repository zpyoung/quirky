import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
  heimdallEnrollmentRefusalError
} from '../../shared/fork-heimdall/enrollment-refusal-error'
import {
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import type { HandlerContext } from '../dispatch'
import { reportCliError } from '../format'
import { RuntimeRpcFailureError } from '../runtime-client'
import { HEIMDALL_CREATE_HANDLERS } from './create-handler'

const callMock = vi.fn()
let previousExitCode: typeof process.exitCode
const previousWorkspaceId = process.env.QUIRKY_WORKSPACE_ID

beforeEach(() => {
  previousExitCode = process.exitCode
  process.exitCode = undefined
})

afterEach(() => {
  callMock.mockReset()
  vi.restoreAllMocks()
  process.exitCode = previousExitCode
  if (previousWorkspaceId === undefined) {
    delete process.env.QUIRKY_WORKSPACE_ID
  } else {
    process.env.QUIRKY_WORKSPACE_ID = previousWorkspaceId
  }
})

function response(result: unknown) {
  return { id: 'request-1', ok: true as const, result, _meta: { runtimeId: 'runtime-1' } }
}

function context(
  flags: [string, string | boolean][],
  runtimeCapabilities: string[] = [],
  worktree: {
    id: string
    repoId: string
    hostId?: string
    runtimeOwnerEnvironmentId?: string
  } = { id: 'folder:folder-1', repoId: 'folder-repo' },
  repoKind = 'git',
  repoExecutionHostId?: string,
  isRemote = false
): HandlerContext {
  callMock.mockReset()
  callMock.mockImplementation(async (method: string) => {
    if (method === 'status.get') {
      return response({ capabilities: runtimeCapabilities })
    }
    if (method === 'worktree.list') {
      return response({ worktrees: [{ id: worktree.id, path: '/client-machine/work' }] })
    }
    if (method === 'worktree.show') {
      return response({ worktree })
    }
    if (method === 'repo.show') {
      return response({
        repo: {
          kind: repoKind,
          ...(repoExecutionHostId === undefined ? {} : { executionHostId: repoExecutionHostId })
        }
      })
    }
    if (method === HEIMDALL_CHANNELS.enroll) {
      return response({ status: 'enrolled', entry: { enrollment: { watcherId: 'watcher-1' } } })
    }
    throw new Error(`Unexpected RPC ${method}`)
  })
  return {
    flags: new Map(flags),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler tests call only RuntimeClient.call; the fake models remote status, workspace resolution, and enrollment responses.
    client: { call: callMock, isRemote } as unknown as HandlerContext['client'],
    cwd: '/client-machine/work',
    json: true
  }
}

describe('Heimdall create handlers', () => {
  it('resolves an active folder workspace before enrolling the objective', async () => {
    process.env.QUIRKY_WORKSPACE_ID = 'folder:folder-1'
    const ctx = context(
      [['objective', 'Ship the report export']],
      [
        HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
        HEIMDALL_OBJECTIVE_ROLE_LAUNCH_RUNTIME_CAPABILITY
      ]
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await HEIMDALL_CREATE_HANDLERS['heimdall create objective'](ctx)
    expect(logSpy).toHaveBeenCalledOnce()

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', { worktree: 'folder:folder-1' })
    expect(callMock).not.toHaveBeenCalledWith('repo.show', expect.anything())
    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.enroll, {
      input: {
        kind: 'objective',
        repoId: 'folder-repo',
        worktreeId: 'folder:folder-1',
        capabilities: { plan: 'gated', implement: 'on', review: 'on', check: 'on', land: 'on' },
        budget: { wallClockActiveMs: 14_400_000, turns: 40 },
        kindPayload: {
          objectiveText: 'Ship the report export',
          tier: 'standard',
          landingBar: 'files-on-disk',
          lanesEnabled: true,
          maxConcurrency: 1,
          workspaceKind: 'folder',
          writeTerritory: ['**'],
          roleAgents: {},
          sitterOverrides: {}
        }
      },
      owner: null
    })
  })

  it('resolves legacy folder repositories without sending a Git worktree id', async () => {
    const ctx = context(
      [['objective', 'Keep the notes searchable']],
      [HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY],
      { id: 'folder-repo::/notes', repoId: 'folder-repo' },
      'folder'
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await HEIMDALL_CREATE_HANDLERS['heimdall create objective'](ctx)

    const enroll = callMock.mock.calls.find(([method]) => method === HEIMDALL_CHANNELS.enroll)
    expect(enroll?.[1]).toMatchObject({
      input: {
        repoId: 'folder-repo',
        worktreeId: null,
        kindPayload: { workspaceKind: 'folder', maxConcurrency: 1 }
      }
    })
    expect(logSpy).toHaveBeenCalledOnce()
  })

  it('checks capability errors before workspace RPCs and never falls back locally', async () => {
    const invalid = context([
      ['objective', 'Ship it'],
      ['cap', 'plan=on\u0000extra=off']
    ])
    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create objective'](invalid)).rejects.toThrow(
      /unknown objective capability "extra"/
    )
    expect(callMock).not.toHaveBeenCalled()
    const unknownAgent = context([
      ['objective', 'Ship it'],
      ['role-agent', 'planner=not-a-tui-agent']
    ])
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](unknownAgent)
    ).rejects.toThrow(/kindPayload\.roleAgents\.planner/)
    expect(callMock).not.toHaveBeenCalled()

    const owner = context([
      ['objective', 'Ship it'],
      ['owner', 'claude']
    ])
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](owner)
    ).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })

  it('rejects active on a paired runtime instead of interpreting the client cwd there', async () => {
    const remote = context([['objective', 'Ship it']], [], undefined, 'git', undefined, true)
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](remote)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })

  it('refuses explicit workspaces owned by SSH or another runtime', async () => {
    const remoteWorktree = context(
      [
        ['objective', 'Ship it'],
        ['worktree', 'id:repo-1::/remote']
      ],
      [],
      { id: 'repo-1::/remote', repoId: 'repo-1', hostId: 'ssh:builder' }
    )
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](remoteWorktree)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('local execution host')
    })
    expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'id:repo-1::/remote' })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())

    const remoteRepo = context(
      [
        ['objective', 'Ship it'],
        ['worktree', 'id:repo-1::/repo']
      ],
      [],
      { id: 'repo-1::/repo', repoId: 'repo-1' },
      'git',
      'runtime:other'
    )
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](remoteRepo)
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('local execution host')
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
    const routedWorkspace = context(
      [
        ['objective', 'Ship it'],
        ['worktree', 'id:repo-1::/routed']
      ],
      [],
      {
        id: 'repo-1::/routed',
        repoId: 'repo-1',
        hostId: 'local',
        runtimeOwnerEnvironmentId: 'remote-env'
      }
    )
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create objective'](routedWorkspace)
    ).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })

  it('creates hosted-review enrollment with its gated identity payload and explicit flags', async () => {
    const ctx = context(
      [
        ['worktree', 'branch:feature/report'],
        ['cap', 'fixChecks=gated'],
        ['branch-update', 'rebase'],
        ['merge-method', 'squash']
      ],
      [
        HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
        HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY
      ],
      { id: 'repo-1::/repo/feature', repoId: 'repo-1' }
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await HEIMDALL_CREATE_HANDLERS['heimdall create hosted-review'](ctx)

    expect(callMock).toHaveBeenCalledWith('worktree.show', { worktree: 'branch:feature/report' })
    expect(callMock).toHaveBeenCalledWith('repo.show', { repo: 'repo-1' })
    const enroll = callMock.mock.calls.find(([method]) => method === HEIMDALL_CHANNELS.enroll)
    expect(enroll?.[1]).toMatchObject({
      input: {
        kind: 'hosted-review',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/repo/feature',
        capabilities: {
          updateBranch: 'off',
          resolveConflicts: 'off',
          fixChecks: 'gated',
          merge: 'off'
        },
        budget: { wallClockActiveMs: 14_400_000, turns: null },
        kindPayload: { branchUpdateMode: 'rebase', mergeMethod: 'squash' }
      },
      owner: null
    })
    expect(logSpy).toHaveBeenCalledOnce()
  })

  it('rejects hosted-review folders and unsupported legacy hosted-review payloads', async () => {
    const folder = context([], [HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY])
    await expect(HEIMDALL_CREATE_HANDLERS['heimdall create hosted-review'](folder)).rejects.toThrow(
      /hosted-review watchers require a Git worktree/
    )
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
    const legacy = context(
      [
        ['worktree', 'id:repo-1::/repo/feature'],
        [
          'spec',
          JSON.stringify({
            kindPayload: {
              branch: 'feature/report',
              provider: 'github',
              reviewNumber: 17,
              reviewUrl: 'https://github.com/acme/repo/pull/17'
            }
          })
        ]
      ],
      [],
      { id: 'repo-1::/repo/feature', repoId: 'repo-1' }
    )
    await expect(
      HEIMDALL_CREATE_HANDLERS['heimdall create hosted-review'](legacy)
    ).rejects.toMatchObject({
      code: 'incompatible_runtime',
      message: expect.stringContaining('host-derived hosted-review enrollment')
    })
    expect(callMock).not.toHaveBeenCalledWith(HEIMDALL_CHANNELS.enroll, expect.anything())
  })

  it('surfaces thrown refusal fields through CLI JSON and text errors', async () => {
    const refusalError = heimdallEnrollmentRefusalError({
      status: 'refused',
      reason: 'duplicate-workspace',
      existingWatcherId: 'existing-1'
    })
    const refusal = refusalError.data
    const failure = new RuntimeRpcFailureError({
      id: 'enroll-1',
      ok: false,
      error: {
        code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE,
        message: refusalError.message,
        data: refusal
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    process.env.QUIRKY_WORKSPACE_ID = 'folder:folder-1'
    const ctx = context([['objective', 'Ship it']])
    callMock.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return response({ capabilities: [] })
      }
      if (method === 'worktree.list') {
        return response({ worktrees: [{ id: 'folder:folder-1', path: '/client-machine/work' }] })
      }
      if (method === 'worktree.show') {
        return response({ worktree: { id: 'folder:folder-1', repoId: 'folder-repo' } })
      }
      if (method === HEIMDALL_CHANNELS.enroll) {
        throw failure
      }
      throw new Error(`Unexpected RPC ${method}`)
    })
    const error = await HEIMDALL_CREATE_HANDLERS['heimdall create objective'](ctx).catch(
      (cause: unknown) => cause
    )
    expect(error).toBe(failure)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    reportCliError(error, true)
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: { code: HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE, data: refusal }
    })
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).not.toHaveProperty('result')
    reportCliError(error, false)
    expect(errorSpy).toHaveBeenCalledWith(refusalError.message)
  })
})
