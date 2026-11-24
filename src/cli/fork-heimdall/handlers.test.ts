import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import {
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import type { WatcherFleetEntry } from '../../shared/fork-heimdall/fleet-types'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import type { HandlerContext } from '../dispatch'
import { HEIMDALL_HANDLERS } from './handlers'

const callMock = vi.fn()
const temporaryDirectories: string[] = []
const originalWorkspaceId = process.env.QUIRKY_WORKSPACE_ID
const WATCHER_ID = 'watcher-1'
const TARGET = { watcherId: WATCHER_ID, connectionId: 'ssh:builder', pairingRevision: 7 }
const LOCAL_TARGET = { watcherId: 'local-watcher', connectionId: null, pairingRevision: null }
const OWNER_FENCE = {
  executionHostId: 'ssh:builder',
  schedulerOwner: 'ssh_bridge',
  workspaceKey: 'ssh:builder::/repo',
  revision: 4
} satisfies WatcherFleetEntry['ownerFence']
const COMMAND_CAPABILITIES = [
  HEIMDALL_COMMANDS_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_DELETE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
]

function fleetRow(overrides: Partial<WatcherFleetEntry> = {}): WatcherFleetEntry {
  return {
    target: TARGET,
    ownerFence: OWNER_FENCE,
    observedAtMs: 10,
    contact: 'live',
    readOnlyReason: null,
    capabilityNotes: [],
    paused: false,
    entry: {
      name: 'watcher',
      enrollment: {
        watcherId: WATCHER_ID,
        kind: 'objective',
        workspaceKey: 'ssh:builder::/repo',
        executionHostId: 'ssh:builder',
        repoId: 'repo-1',
        worktreeId: null,
        workspacePath: '/repo',
        schedulerOwner: 'ssh_bridge',
        enabled: true,
        paused: false,
        commandRevision: 0,
        capabilities: {},
        budget: { wallClockActiveMs: 7_200_000, turns: 9 },
        kindPayload: { workspaceKind: 'git' },
        coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      status: {
        watcherId: WATCHER_ID,
        enabled: true,
        state: 'watching',
        phase: 'poll',
        reason: null,
        parkReason: null,
        budget: { activeMs: 20, turns: 2, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: 9,
        nextPulseAtMs: 11
      }
    },
    ...overrides
  }
}

function workspaceFleetRow(
  watcherId: string,
  target: WatcherFleetEntry['target'],
  enrollmentOverrides: Partial<WatcherFleetEntry['entry']['enrollment']>
): WatcherFleetEntry {
  const base = fleetRow()
  const enrollment = {
    ...base.entry.enrollment,
    ...enrollmentOverrides,
    watcherId
  }
  return {
    ...base,
    target,
    ownerFence: {
      ...base.ownerFence,
      executionHostId: enrollment.executionHostId,
      workspaceKey: enrollment.workspaceKey
    },
    entry: {
      ...base.entry,
      enrollment,
      status: { ...base.entry.status, watcherId }
    }
  }
}

function fleetSnapshotResponse(entries: WatcherFleetEntry[]) {
  return { id: 'fleet-1', ok: true, result: { generatedAtMs: 10, entries } }
}

function fleetResponse(row = fleetRow()) {
  return fleetSnapshotResponse([row])
}

function detailResponse(row = fleetRow(), ledgerEntries: unknown[] = []) {
  return {
    id: 'detail-1',
    ok: true,
    result: {
      watcher: row,
      ledger: { entries: ledgerEntries },
      traces: [],
      workers: [
        {
          dispatchId: 'dispatch-1',
          task: 'Inspect current state',
          dispatchedAtMs: 1,
          lastContactAtMs: null,
          liveness: 'unverifiable',
          reason: 'Owner contact could not be verified',
          question: null
        }
      ]
    }
  }
}

function context(
  flags: [string, string | boolean][],
  overrides: { cwd?: string; json?: boolean; isRemote?: boolean } = {}
): HandlerContext {
  return {
    flags: new Map(flags),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers under test call only client.call; RuntimeClient's other members are unused.
    client: {
      call: callMock,
      ...(overrides.isRemote === undefined ? {} : { isRemote: overrides.isRemote })
    } as unknown as HandlerContext['client'],
    cwd: overrides.cwd ?? '/repo',
    json: overrides.json ?? false
  }
}

function primeCommand(row = fleetRow(), capabilities: string[] = COMMAND_CAPABILITIES): void {
  callMock
    .mockResolvedValueOnce({ id: 'status-1', ok: true, result: { capabilities } })
    .mockResolvedValueOnce(fleetResponse(row))
}

beforeEach(() => {
  callMock.mockReset()
  process.exitCode = undefined
  delete process.env.QUIRKY_WORKSPACE_ID
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalWorkspaceId === undefined) {
    delete process.env.QUIRKY_WORKSPACE_ID
  } else {
    process.env.QUIRKY_WORKSPACE_ID = originalWorkspaceId
  }

  process.exitCode = undefined
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('quirky heimdall read handlers', () => {
  it('lists fleet rows and distinguishes unverifiable owner contact from worker exit', async () => {
    const row = fleetRow({ contact: 'unverifiable' })
    callMock.mockResolvedValueOnce(fleetResponse(row))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall list'](context([]))

    expect(callMock).toHaveBeenCalledWith(HEIMDALL_CHANNELS.fleet, {})
    expect(log).toHaveBeenCalledWith(expect.stringContaining('owner contact unverifiable'))
    expect(log.mock.calls.join('\n')).toContain('phase poll')
    expect(log.mock.calls.join('\n')).toContain('not paused')
    expect(log.mock.calls.join('\n')).not.toContain('exited')
  })
  it('filters the JSON fleet envelope by watcher kind', async () => {
    const objective = fleetRow()
    const hostedBase = fleetRow()
    const hosted = fleetRow({
      target: { ...TARGET, watcherId: 'hosted-watcher' },
      entry: {
        ...hostedBase.entry,
        enrollment: {
          ...hostedBase.entry.enrollment,
          watcherId: 'hosted-watcher',
          kind: 'hosted-review'
        }
      }
    })
    callMock.mockResolvedValueOnce(fleetSnapshotResponse([objective, hosted]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall list'](context([['kind', 'objective']], { json: true }))

    const output = String(log.mock.calls[0]?.[0])
    expect(output).toContain('"ok": true')
    expect(output).toContain('"watcherId": "watcher-1"')
    expect(output).not.toContain('"watcherId": "hosted-watcher"')
  })

  it('resolves a local current worktree before filtering by execution host', async () => {
    const worktreeId = 'repo-1::/repo'
    const local = workspaceFleetRow('local-watcher', LOCAL_TARGET, {
      executionHostId: 'local',
      workspaceKey: 'local::/repo',
      repoId: 'repo-1',
      worktreeId,
      workspacePath: '/repo'
    })
    const ssh = workspaceFleetRow(
      'ssh-watcher',
      { watcherId: 'ssh-watcher', connectionId: null, pairingRevision: null },
      {
        executionHostId: 'ssh:builder',
        workspaceKey: 'ssh:builder::/repo',
        repoId: 'repo-1',
        worktreeId,
        workspacePath: '/repo'
      }
    )
    callMock
      .mockResolvedValueOnce({
        id: 'worktrees-1',
        ok: true,
        result: { worktrees: [{ id: worktreeId, path: '/repo' }] }
      })
      .mockResolvedValueOnce({
        id: 'worktree-1',
        ok: true,
        result: { worktree: { id: worktreeId, repoId: 'repo-1', path: '/repo', hostId: 'local' } }
      })
      .mockResolvedValueOnce(fleetSnapshotResponse([local, ssh]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall list'](context([['worktree', 'active']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.show', {
      worktree: `id:${worktreeId}`
    })
    expect(log.mock.calls.join('\n')).toContain('local-watcher')
    expect(log.mock.calls.join('\n')).not.toContain('ssh-watcher')
  })

  it('resolves the current folder workspace selector before filtering', async () => {
    process.env.QUIRKY_WORKSPACE_ID = 'folder:folder-1'
    const folder = workspaceFleetRow(
      'folder-watcher',
      { ...LOCAL_TARGET, watcherId: 'folder-watcher' },
      {
        executionHostId: 'local',
        workspaceKey: 'local::/folder',
        repoId: 'folder-repo',
        worktreeId: 'folder:folder-1',
        workspacePath: '/folder'
      }
    )
    callMock
      .mockResolvedValueOnce({
        id: 'worktree-1',
        ok: true,
        result: {
          worktree: {
            id: 'folder:folder-1',
            repoId: 'folder-repo',
            path: '/folder',
            hostId: 'local'
          }
        }
      })
      .mockResolvedValueOnce(fleetSnapshotResponse([folder, fleetRow()]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall list'](context([['worktree', 'active']]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.show', {
      worktree: 'folder:folder-1'
    })
    expect(log.mock.calls.join('\n')).toContain('folder-watcher')
    expect(log.mock.calls.join('\n')).not.toContain('watcher-1')
  })

  it.each([
    ['execution host', { hostId: toRuntimeExecutionHostId('remote-environment') }],
    ['routed owner', { hostId: 'local', runtimeOwnerEnvironmentId: 'remote-environment' }]
  ])('filters a paired runtime workspace by its %s identity', async (_identity, worktreeOwner) => {
    const remoteId = 'repo-remote::/remote'
    const remoteTarget = {
      watcherId: 'remote-watcher',
      connectionId: 'remote-environment',
      pairingRevision: 12
    }
    const wrongRuntime = workspaceFleetRow(
      'wrong-runtime-watcher',
      {
        watcherId: 'wrong-runtime-watcher',
        connectionId: 'other-environment',
        pairingRevision: 12
      },
      {
        executionHostId: 'local',
        workspaceKey: 'local::/remote',
        repoId: 'repo-remote',
        worktreeId: remoteId,
        workspacePath: '/remote'
      }
    )
    const remote = workspaceFleetRow('remote-watcher', remoteTarget, {
      executionHostId: 'local',
      workspaceKey: 'local::/remote',
      repoId: 'repo-remote',
      worktreeId: remoteId,
      workspacePath: '/remote'
    })
    const local = workspaceFleetRow('local-watcher', LOCAL_TARGET, {
      executionHostId: 'local',
      workspaceKey: 'local::/remote',
      repoId: 'repo-remote',
      worktreeId: remoteId,
      workspacePath: '/remote'
    })
    callMock
      .mockResolvedValueOnce({
        id: 'worktree-1',
        ok: true,
        result: {
          worktree: {
            id: remoteId,
            repoId: 'repo-remote',
            path: '/remote',
            ...worktreeOwner
          }
        }
      })
      .mockResolvedValueOnce(fleetSnapshotResponse([local, remote, wrongRuntime]))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall list'](
      context([['worktree', `id:${remoteId}`]], { isRemote: true })
    )

    expect(callMock).toHaveBeenNthCalledWith(1, 'worktree.show', { worktree: `id:${remoteId}` })
    expect(log.mock.calls.join('\n')).toContain('remote-watcher')
    expect(log.mock.calls.join('\n')).not.toContain('local-watcher')
    expect(log.mock.calls.join('\n')).not.toContain('wrong-runtime-watcher')
  })

  it('shows the selected remote watcher, latest open escalations, and unverifiable worker liveness', async () => {
    const row = fleetRow({ contact: 'unverifiable' })
    const approvalScope = {
      actionKind: 'write',
      contentIdentity: 'content-1',
      evidenceKey: 'evidence-1'
    }
    callMock.mockResolvedValueOnce(fleetResponse(row)).mockResolvedValueOnce(
      detailResponse(row, [
        {
          kind: 'escalation',
          escalationId: 'approval-stale',
          escalationKind: 'awaiting-approval',
          status: 'open',
          foldCount: 1,
          approvalScope
        },
        {
          kind: 'escalation',
          escalationId: 'approval-stale',
          escalationKind: 'awaiting-approval',
          status: 'acknowledged',
          foldCount: 2,
          approvalScope
        },
        {
          kind: 'escalation',
          escalationId: 'approval-current',
          escalationKind: 'awaiting-approval',
          status: 'open',
          foldCount: 1,
          approvalScope
        },
        {
          kind: 'escalation',
          escalationId: 'worker-question',
          escalationKind: 'worker-question',
          status: 'open',
          foldCount: 1
        }
      ])
    )
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall show'](context([['watcher-id', WATCHER_ID]]))

    expect(callMock).toHaveBeenNthCalledWith(2, HEIMDALL_CHANNELS.detail, TARGET)
    expect(log.mock.calls.join('\n')).toContain(
      'approval-current (awaiting-approval, open, approvable)'
    )
    expect(log.mock.calls.join('\n')).toContain('worker-question (worker-question, open)')
    expect(log.mock.calls.join('\n')).not.toContain('approval-stale')
    expect(log.mock.calls.join('\n')).toContain('Worker dispatch-1: unverifiable')
    expect(log.mock.calls.join('\n')).not.toContain('Worker dispatch-1: exited')
  })

  it('reads objective detail through the fleet row target', async () => {
    const row = fleetRow()
    const objective = {
      contract: {
        objectiveText: 'Repair the queue',
        landingBar: 'committed-local-branch'
      },
      revisions: [
        {
          id: 'revision-2',
          number: 2,
          status: 'approved',
          digest: 'digest-2',
          createdByDispatchId: null,
          createdAtMs: 11,
          approvedAtMs: 12,
          nodeCount: 1
        }
      ],
      nodes: [
        {
          taskKey: 'repair-queue',
          title: 'Repair queue drain',
          revisionId: 'revision-2',
          orchestrationTaskId: null,
          dispatchId: null,
          state: 'succeeded',
          criteria: []
        }
      ],
      verdicts: [],
      landing: [{ rung: 'files-on-disk', contentIdentity: 'content-2', atMs: 12 }],
      asOfMs: 12
    }
    callMock
      .mockResolvedValueOnce(fleetResponse(row))
      .mockResolvedValueOnce({ id: 'objective-1', ok: true, result: objective })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall objective'](context([['watcher-id', WATCHER_ID]]))

    expect(callMock).toHaveBeenNthCalledWith(2, HEIMDALL_CHANNELS.objectiveDetail, TARGET)
    const output = log.mock.calls.join('\n')
    expect(output).toContain('Objective: Repair the queue')
    expect(output).toContain('Landing target: committed-local-branch')
    expect(output).toContain('Revision 2 [approved]: 1 tasks')
    expect(output).toContain('- repair-queue [succeeded] Repair queue drain')
    expect(output).toContain('Landed at files-on-disk (content-2)')
  })

  it('requests a remote debug report using the fleet target and prints bare report JSON', async () => {
    const report = { schemaVersion: 3, watcherId: WATCHER_ID }
    callMock
      .mockResolvedValueOnce(fleetResponse())
      .mockResolvedValueOnce({ id: 'debug-1', ok: true, result: report })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall debug'](context([['watcher-id', WATCHER_ID]], { json: true }))

    expect(callMock).toHaveBeenNthCalledWith(2, HEIMDALL_CHANNELS.debugReport, TARGET)
    expect(log).toHaveBeenCalledWith(JSON.stringify(report, null, 2))
  })

  it('writes a remote debug report to a cwd-relative path without printing it', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'quirky-heimdall-debug-'))
    temporaryDirectories.push(cwd)
    const report = { schemaVersion: 3, watcherId: WATCHER_ID }
    callMock
      .mockResolvedValueOnce(fleetResponse())
      .mockResolvedValueOnce({ id: 'debug-2', ok: true, result: report })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall debug'](
      context(
        [
          ['watcher-id', WATCHER_ID],
          ['out', 'report.json']
        ],
        { cwd }
      )
    )

    expect(await readFile(join(cwd, 'report.json'), 'utf8')).toBe(
      `${JSON.stringify(report, null, 2)}\n`
    )
    expect(log).not.toHaveBeenCalled()
  })
  it('rejects a missing debug watcher id before contacting the runtime', async () => {
    await expect(HEIMDALL_HANDLERS['heimdall debug'](context([]))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Missing required --watcher-id'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects --out without a path before contacting the runtime', async () => {
    await expect(
      HEIMDALL_HANDLERS['heimdall debug'](
        context([
          ['watcher-id', WATCHER_ID],
          ['out', true]
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: '--out requires a value; it was passed with none.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('quirky heimdall mutation handlers', () => {
  it.each([
    ['pause', { kind: 'pause' }],
    ['resume', { kind: 'resume' }],
    ['disarm', { kind: 'disarm' }],
    ['rm', { kind: 'delete' }]
  ])('routes %s through the selected owner fence', async (verb, command) => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS[`heimdall ${verb}`](context([['watcher-id', WATCHER_ID]]))

    expect(callMock).toHaveBeenNthCalledWith(1, 'status.get')
    expect(callMock).toHaveBeenNthCalledWith(2, HEIMDALL_CHANNELS.fleet, {})
    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command
    })
  })

  it('gates mutations on status capabilities before reading the fleet', async () => {
    callMock.mockResolvedValueOnce({ id: 'status-1', ok: true, result: { capabilities: [] } })

    await expect(
      HEIMDALL_HANDLERS['heimdall pause'](context([['watcher-id', WATCHER_ID]]))
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    expect(callMock).toHaveBeenCalledOnce()
    expect(callMock).toHaveBeenCalledWith('status.get')
  })

  it('requires delete support before contacting the fleet', async () => {
    callMock.mockResolvedValueOnce({
      id: 'status-1',
      ok: true,
      result: { capabilities: [HEIMDALL_COMMANDS_RUNTIME_CAPABILITY] }
    })

    await expect(
      HEIMDALL_HANDLERS['heimdall rm'](context([['watcher-id', WATCHER_ID]]))
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })

    expect(callMock).toHaveBeenCalledOnce()
  })

  it('approves the requested latest unresolved scope among concurrent approvals', async () => {
    const row = fleetRow()
    const earlierScope = { actionKind: 'write', contentIdentity: 'old', evidenceKey: 'old-key' }
    const currentScope = {
      actionKind: 'write',
      contentIdentity: 'current',
      evidenceKey: 'current-key',
      preparedCommitSha: 'abc123'
    }
    const ledgerEntries = [
      {
        kind: 'escalation',
        escalationId: 'approval-1',
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 1,
        approvalScope: earlierScope
      },
      {
        kind: 'escalation',
        escalationId: 'approval-1',
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 2,
        approvalScope: currentScope
      },
      {
        kind: 'escalation',
        escalationId: 'approval-2',
        escalationKind: 'awaiting-approval',
        status: 'open',
        foldCount: 1,
        approvalScope: { actionKind: 'write', contentIdentity: 'other', evidenceKey: 'other-key' }
      },
      {
        kind: 'escalation',
        escalationId: 'resolved-approval',
        escalationKind: 'awaiting-approval',
        status: 'resolved',
        foldCount: 1,
        approvalScope: { actionKind: 'write', contentIdentity: 'resolved', evidenceKey: 'done' }
      }
    ]
    primeCommand(row)
    callMock.mockResolvedValueOnce(detailResponse(row, ledgerEntries)).mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall approve'](
      context([
        ['watcher-id', WATCHER_ID],
        ['escalation-id', 'approval-1']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.detail, TARGET)
    expect(callMock).toHaveBeenNthCalledWith(4, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'approve', scope: currentScope }
    })
  })

  it.each([
    ['missing', []],
    [
      'resolved',
      [
        {
          kind: 'escalation',
          escalationId: 'requested',
          escalationKind: 'awaiting-approval',
          status: 'resolved',
          foldCount: 1,
          approvalScope: { actionKind: 'write', contentIdentity: 'content', evidenceKey: 'key' }
        }
      ]
    ],
    [
      'wrong kind',
      [
        {
          kind: 'escalation',
          escalationId: 'requested',
          escalationKind: 'worker-question',
          status: 'open',
          foldCount: 1
        }
      ]
    ]
  ])('refuses approval for a %s escalation id', async (_name, ledgerEntries) => {
    callMock.mockReset()
    primeCommand()
    callMock.mockResolvedValueOnce(detailResponse(fleetRow(), ledgerEntries))

    await expect(
      HEIMDALL_HANDLERS['heimdall approve'](
        context([
          ['watcher-id', WATCHER_ID],
          ['escalation-id', 'requested']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    expect(callMock).toHaveBeenCalledTimes(3)
  })

  it('answers worker questions with the requested message and text', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall answer'](
      context([
        ['watcher-id', WATCHER_ID],
        ['message-id', 'question-1'],
        ['body', '  Use the new API  ']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'answer-question', messageId: 'question-1', body: 'Use the new API' }
    })
  })

  it('answers the exact requested escalation and enforces the shared text bound', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall answer-escalation'](
      context([
        ['watcher-id', WATCHER_ID],
        ['escalation-id', 'owner-deviation:watcher-1:stall:dispatch-1'],
        ['body', 'Use the new API']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: {
        kind: 'answer-escalation',
        escalationId: 'owner-deviation:watcher-1:stall:dispatch-1',
        body: 'Use the new API'
      }
    })

    await expect(
      HEIMDALL_HANDLERS['heimdall answer-escalation'](
        context([
          ['watcher-id', WATCHER_ID],
          ['escalation-id', 'escalation-1'],
          ['body', 'x'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH + 1)]
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('sends stop-worker with the dispatch id', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall stop-worker'](
      context([
        ['watcher-id', WATCHER_ID],
        ['dispatch-id', 'dispatch-1']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'stop-worker', dispatchId: 'dispatch-1' }
    })
  })

  it('merges an hours-only budget update with the current turns limit', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall budget'](
      context([
        ['watcher-id', WATCHER_ID],
        ['hours', '1.5']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: 5_400_000, turns: 9 } }
    })
  })

  it('rounds decimal budget hours that are not exact in binary floating point', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall budget'](
      context([
        ['watcher-id', WATCHER_ID],
        ['hours', '1.1']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: 3_960_000, turns: 9 } }
    })
  })

  it('maps none to no limit and merges an omitted hours dimension', async () => {
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall budget'](
      context([
        ['watcher-id', WATCHER_ID],
        ['turns', '5']
      ])
    )
    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: 7_200_000, turns: 5 } }
    })

    callMock.mockReset()
    process.exitCode = undefined
    primeCommand()
    callMock.mockResolvedValueOnce({
      id: 'command-2',
      ok: true,
      result: { status: 'applied', appliedAtMs: 21 }
    })
    await HEIMDALL_HANDLERS['heimdall budget'](
      context([
        ['watcher-id', WATCHER_ID],
        ['hours', 'none']
      ])
    )
    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'adjust-budget', budget: { wallClockActiveMs: null, turns: 9 } }
    })
  })

  it('clamps folder concurrency and targets the selected row', async () => {
    const row = fleetRow({
      entry: {
        ...fleetRow().entry,
        enrollment: {
          ...fleetRow().entry.enrollment,
          kindPayload: { workspaceKind: 'folder' }
        }
      }
    })
    primeCommand(row)
    callMock.mockResolvedValueOnce({
      id: 'command-1',
      ok: true,
      result: { status: 'applied', appliedAtMs: 20 }
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall set-concurrency'](
      context([
        ['watcher-id', WATCHER_ID],
        ['max-concurrency', '3']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(3, HEIMDALL_CHANNELS.command, {
      target: TARGET,
      expectedOwner: OWNER_FENCE,
      command: { kind: 'set-concurrency', maxConcurrency: 1 }
    })
    expect(log).toHaveBeenCalledWith('Set Heimdall watcher watcher-1 concurrency to 1.')
  })

  it('sets exitCode and emits the standard JSON envelope for refused and indeterminate results', async () => {
    for (const result of [
      { status: 'refused', reason: 'owner-unreachable', detail: 'Owner is unreachable' },
      { status: 'indeterminate', detail: 'The owner may still apply this command' }
    ]) {
      callMock.mockReset()
      process.exitCode = undefined
      primeCommand()
      const response = { id: 'command-1', ok: true, result }
      callMock.mockResolvedValueOnce(response)
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})

      await HEIMDALL_HANDLERS['heimdall pause'](
        context([['watcher-id', WATCHER_ID]], { json: true })
      )

      expect(process.exitCode).toBe(1)
      expect(log).toHaveBeenCalledWith(JSON.stringify(response, null, 2))
      log.mockRestore()
    }
  })

  it.each([
    [
      { status: 'refused', reason: 'owner-unreachable', detail: 'Owner is unreachable' },
      'Watcher command refused (owner-unreachable): Owner is unreachable'
    ],
    [
      { status: 'indeterminate', detail: 'The owner may still apply this command' },
      'Watcher command is indeterminate: The owner may still apply this command'
    ]
  ])('prints actionable text for a failed command', async (result, expectedText) => {
    primeCommand()
    callMock.mockResolvedValueOnce({ id: 'command-1', ok: true, result })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await HEIMDALL_HANDLERS['heimdall pause'](context([['watcher-id', WATCHER_ID]]))

    expect(process.exitCode).toBe(1)
    expect(log).toHaveBeenCalledWith(expectedText)
  })

  it('clamps invalid concurrency values locally', async () => {
    await expect(
      HEIMDALL_HANDLERS['heimdall set-concurrency'](
        context([
          ['watcher-id', WATCHER_ID],
          ['max-concurrency', '1025']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})
