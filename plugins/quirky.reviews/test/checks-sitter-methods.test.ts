import { describe, expect, test } from 'bun:test'
import { createReviewsEnv } from '../src/env'
import type { JsonRecord, ReviewMethodTable } from '../src/contracts'
import { checksMethods } from '../src/checks/methods'

type CallRecord = { method: string; params: JsonRecord | undefined }
type CallHandler = (method: string, params: JsonRecord | undefined) => unknown | Promise<unknown>

type SitterRowOptions = {
  watcherId?: string
  worktreeId?: string
  kind?: string
  enabled?: boolean
  paused?: boolean
  terminalAtMs?: number | null
  parkReason?: string | null
  state?: string
  fenceRevision?: number
}

const caller = { role: 'plugin' } as never

function unitEnv(respond: CallHandler) {
  const calls: CallRecord[] = []
  const env = createReviewsEnv({
    openStore: () => ({ get: () => undefined, run: () => {} }),
    emit: () => {},
    error: (_kind: string, message: string) => new Error(message),
    call: async (method: string, params?: JsonRecord) => {
      const recorded = params === undefined ? undefined : structuredClone(params)
      calls.push({ method, params: recorded })
      if (method === 'quirky.worktree/resolve') {
        const selector = typeof params?.selector === 'string' ? params.selector : 'current'
        return { id: selector, kind: 'git', repoId: 'fixture-repo', path: `/worktrees/${selector}` }
      }
      return respond(method, params)
    }
  } as never)
  return { calls, methods: checksMethods(env) }
}

async function invoke(methods: ReviewMethodTable, method: string, params: JsonRecord): Promise<unknown> {
  return methods[method]!(params as never, caller)
}

function sitterRow(options: SitterRowOptions = {}): JsonRecord {
  const watcherId = options.watcherId ?? 'watcher-1'
  const worktreeId = options.worktreeId ?? 'wt-1'
  return {
    target: { watcherId, connectionId: null, pairingRevision: null },
    ownerFence: {
      executionHostId: 'host-1', schedulerOwner: 'scheduler-1', workspaceKey: `workspace-${worktreeId}`,
      revision: options.fenceRevision ?? 11
    },
    enrollment: {
      watcherId, kind: options.kind ?? 'hosted-review', enabled: options.enabled ?? true, paused: options.paused ?? false,
      commandRevision: 6, worktreeId, capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
      budget: { wallClockActiveMs: 3_600_000, turns: null }, kindPayload: { worktree: `id:${worktreeId}` },
      createdAtMs: 100, terminalAtMs: options.terminalAtMs ?? null, parkReason: options.parkReason ?? null, haltReason: null
    },
    status: { state: options.state ?? 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
    name: `PR sitter ${worktreeId}`, workspaceName: worktreeId, branch: 'feature', phase: 'watch', ownerContact: 'live',
    observedAtMs: 1_000, lastSuccessfulTickAtMs: 900,
    budget: { activeMs: 100, turns: 1, exhausted: null }, openEscalations: [], pendingQuestion: false
  }
}

function fleetSnapshot(rows: JsonRecord[]): JsonRecord {
  return {
    generatedAtMs: 1_000, rows, actionHistory: [],
    buckets: { needsYou: 0, lostContact: 0, active: rows.length, inactive: 0 }, activeCount: rows.length, attentionCount: 0
  }
}

function detailFor(row: JsonRecord, openEscalations: JsonRecord[] = []): JsonRecord {
  return {
    target: row.target, ownerFence: row.ownerFence, enrollment: row.enrollment, status: row.status,
    budget: row.budget, ownerContact: row.ownerContact, observedAtMs: row.observedAtMs,
    openEscalations, pendingControls: [], journal: []
  }
}

function heimdallCalls(calls: CallRecord[]): CallRecord[] {
  return calls.filter(({ method }) => method.startsWith('quirky.heimdall/'))
}

async function rejectedBy(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown
  try { await promise } catch (error) { caught = error }
  expect(caught).toBeInstanceOf(Error)
  if (!(caught instanceof Error)) throw new Error('Expected an RPC refusal')
  expect(caught.message).toContain(message)
}

const capabilities = { updateBranch: 'on', resolveConflicts: 'gated', fixChecks: 'off', merge: 'gated' }
const approvalScope = {
  actionKind: 'merge', contentIdentity: 'head:abc123', evidenceKey: 'checks:failed-build', preparedCommitSha: 'c'.repeat(40)
}

function escalation(scope: JsonRecord = approvalScope): JsonRecord {
  return { escalationId: 'escalation-1', escalationKind: 'approval', status: 'open', foldCount: 1, reason: 'Approve merge', approvalScope: scope }
}

describe('Checks PR Sitter methods', () => {
  test('checksSitterGet treats Heimdall method-not-found as quietly unavailable', async () => {
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') throw Object.assign(new Error('method not found'), { code: -32601 })
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterGet', { worktree: 'wt-1' })).toEqual({
      available: false, sitter: null, detail: null, activeCount: 0, otherActiveCount: 0
    })
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet'])
  })

  test('checksSitterGet treats a legacy {ok:true} fleet mock as quietly unavailable', async () => {
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return { ok: true }
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterGet', { worktree: 'wt-1' })).toEqual({
      available: false, sitter: null, detail: null, activeCount: 0, otherActiveCount: 0
    })
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet'])
  })

  test('checksSitterGet counts only active hosted-review rows and selects the requested worktree', async () => {
    const other = sitterRow({ watcherId: 'watcher-other', worktreeId: 'wt-other' })
    const selected = sitterRow({ watcherId: 'watcher-selected', worktreeId: 'wt-selected' })
    const rows = [
      other, selected,
      sitterRow({ watcherId: 'watcher-disabled', worktreeId: 'wt-disabled', enabled: false }),
      sitterRow({ watcherId: 'watcher-paused', worktreeId: 'wt-paused', paused: true, state: 'parked' }),
      sitterRow({ watcherId: 'watcher-terminal', worktreeId: 'wt-terminal', terminalAtMs: 900 }),
      sitterRow({ watcherId: 'watcher-objective', worktreeId: 'wt-objective', kind: 'objective' })
    ]
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot(rows)
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterGet', { worktree: 'wt-selected' })).toMatchObject({
      available: true, sitter: selected, detail: null, activeCount: 2, otherActiveCount: 1
    })
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet'])
  })

  test('checksSitterGet requests detail only when includeDetail is explicitly true', async () => {
    const row = sitterRow({ watcherId: 'watcher-detail', worktreeId: 'wt-detail' })
    const detail = detailFor(row)
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot([row])
      if (method === 'quirky.heimdall/detail') return detail
      throw new Error(`Unexpected call: ${method}`)
    })

    await invoke(methods, 'checksSitterGet', { worktree: 'wt-detail' })
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet'])

    calls.length = 0
    expect(await invoke(methods, 'checksSitterGet', { worktree: 'wt-detail', includeDetail: true })).toMatchObject({ detail })
    expect(heimdallCalls(calls)).toEqual([
      { method: 'quirky.heimdall/fleet', params: undefined },
      { method: 'quirky.heimdall/detail', params: { target: row.target } }
    ])
  })

  test('checksSitterArm sends the exact enrollment payload and converts hours to rounded milliseconds', async () => {
    const enrollment = { watcherId: 'watcher-new', kind: 'hosted-review' }
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/enroll') return { kind: 'enrolled', enrollment }
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterArm', {
      worktree: 'wt-arm', capabilities, branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all', budgetHours: 1.234567
    })).toEqual({ ok: true, kind: 'enrolled', enrollment })
    expect(heimdallCalls(calls)).toEqual([{
      method: 'quirky.heimdall/enroll',
      params: {
        kind: 'hosted-review',
        kindPayload: { worktree: 'id:wt-arm', branchUpdateMode: 'merge-base-update', mergeMethod: 'squash', mergeCheckScope: 'all' },
        capabilities, budget: { wallClockActiveMs: 4_444_441, turns: null }, owner: null, ownerInterventionCapability: 'off'
      }
    }])
  })

  test('checksSitterArm rejects Heimdall enrollment refusals with their detail', async () => {
    const detail = 'The PR sitter updates a branch by merging its base; rebase is not supported.'
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/enroll') return { kind: 'refused', reason: 'unsupported-branch-update-mode', detail }
      throw new Error(`Unexpected call: ${method}`)
    })

    await rejectedBy(invoke(methods, 'checksSitterArm', {
      worktree: 'wt-arm', capabilities, branchUpdateMode: 'rebase', mergeMethod: null, mergeCheckScope: 'all', budgetHours: 2
    }), detail)
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/enroll'])
  })

  test('checksSitterApprove reads a fresh fence and submits the open escalation scope', async () => {
    const row = sitterRow({ watcherId: 'watcher-approval', worktreeId: 'wt-approval', fenceRevision: 27 })
    const approval = escalation()
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot([row])
      if (method === 'quirky.heimdall/detail') return detailFor(row, [approval])
      if (method === 'quirky.heimdall/command') return { kind: 'applied', appliedAtMs: 1_500 }
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterApprove', {
      worktree: 'wt-approval', watcherId: 'watcher-approval', escalationId: 'escalation-1', expectedScope: approvalScope
    })).toEqual({ ok: true, kind: 'applied', appliedAtMs: 1_500 })
    expect(heimdallCalls(calls)).toEqual([
      { method: 'quirky.heimdall/fleet', params: undefined },
      { method: 'quirky.heimdall/detail', params: { target: row.target } },
      {
        method: 'quirky.heimdall/command',
        params: { target: row.target, expectedOwner: row.ownerFence, command: { kind: 'approve', escalationId: 'escalation-1', scope: approvalScope } }
      }
    ])
  })

  test('checksSitterApprove rejects each fieldwise stale approval scope, including preparedCommitSha', async () => {
    const row = sitterRow({ watcherId: 'watcher-stale', worktreeId: 'wt-stale' })
    const changedScopes: JsonRecord[] = [
      { ...approvalScope, actionKind: 'update-branch' },
      { ...approvalScope, contentIdentity: 'head:changed' },
      { ...approvalScope, evidenceKey: 'checks:changed' },
      { ...approvalScope, preparedCommitSha: 'd'.repeat(40) },
      { actionKind: 'merge', contentIdentity: 'head:abc123', evidenceKey: 'checks:failed-build' }
    ]

    for (const expectedScope of changedScopes) {
      const env = unitEnv((method) => {
        if (method === 'quirky.heimdall/fleet') return fleetSnapshot([row])
        if (method === 'quirky.heimdall/detail') return detailFor(row, [escalation()])
        throw new Error(`Unexpected call: ${method}`)
      })
      await rejectedBy(invoke(env.methods, 'checksSitterApprove', {
        worktree: 'wt-stale', watcherId: 'watcher-stale', escalationId: 'escalation-1', expectedScope
      }), 'The approval scope changed; inspect the current escalation before approving.')
      expect(heimdallCalls(env.calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet', 'quirky.heimdall/detail'])
    }
  })

  test('checksSitterApprove rejects refused and indeterminate owner commands', async () => {
    const row = sitterRow({ watcherId: 'watcher-outcome', worktreeId: 'wt-outcome' })
    const outcomes = [
      { kind: 'refused', detail: 'Owner refused approval.' },
      { kind: 'indeterminate', detail: 'Approval may or may not have applied.' }
    ]

    for (const outcome of outcomes) {
      const { calls, methods } = unitEnv((method) => {
        if (method === 'quirky.heimdall/fleet') return fleetSnapshot([row])
        if (method === 'quirky.heimdall/detail') return detailFor(row, [escalation()])
        if (method === 'quirky.heimdall/command') return outcome
        throw new Error(`Unexpected call: ${method}`)
      })
      await rejectedBy(invoke(methods, 'checksSitterApprove', {
        worktree: 'wt-outcome', watcherId: 'watcher-outcome', escalationId: 'escalation-1', expectedScope: approvalScope
      }), outcome.detail)
      expect(heimdallCalls(calls).at(-1)?.method).toBe('quirky.heimdall/command')
    }
  })

  test('checksSitterStop disarms the selected sitter using its current owner fence', async () => {
    const other = sitterRow({ watcherId: 'watcher-other', worktreeId: 'wt-other' })
    const selected = sitterRow({ watcherId: 'watcher-stop', worktreeId: 'wt-stop', fenceRevision: 38 })
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot([other, selected])
      if (method === 'quirky.heimdall/command') return { kind: 'applied', appliedAtMs: 1_600 }
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterStop', { worktree: 'wt-stop', watcherId: 'watcher-stop' })).toEqual({
      ok: true, kind: 'applied', appliedAtMs: 1_600
    })
    expect(heimdallCalls(calls)).toEqual([
      { method: 'quirky.heimdall/fleet', params: undefined },
      { method: 'quirky.heimdall/command', params: { target: selected.target, expectedOwner: selected.ownerFence, command: { kind: 'disarm' } } }
    ])
  })

  test('checksSitterStopAll disarms active, paused, and parked hosted-review rows only', async () => {
    const active = sitterRow({ watcherId: 'watcher-active', worktreeId: 'wt-active' })
    const paused = sitterRow({ watcherId: 'watcher-paused', worktreeId: 'wt-paused', enabled: false, paused: true, state: 'parked' })
    const parked = sitterRow({ watcherId: 'watcher-parked', worktreeId: 'wt-parked', enabled: false, parkReason: 'budget-wall-clock', state: 'parked' })
    const rows = [
      active, paused, parked,
      sitterRow({ watcherId: 'watcher-terminal-time', worktreeId: 'wt-terminal-time', terminalAtMs: 900 }),
      sitterRow({ watcherId: 'watcher-terminal-state', worktreeId: 'wt-terminal-state', state: 'terminal' }),
      sitterRow({ watcherId: 'watcher-objective', worktreeId: 'wt-objective', kind: 'objective' })
    ]
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot(rows)
      if (method === 'quirky.heimdall/command') return { kind: 'applied', appliedAtMs: 1_700 }
      throw new Error(`Unexpected call: ${method}`)
    })

    expect(await invoke(methods, 'checksSitterStopAll', {})).toMatchObject({
      total: 3, stopped: 3, refusedCount: 0, indeterminateCount: 0, warning: null
    })
    const commands = heimdallCalls(calls).filter(({ method }) => method === 'quirky.heimdall/command')
    expect(commands.map(({ params }) => (params?.target as JsonRecord).watcherId).sort()).toEqual([
      'watcher-active', 'watcher-parked', 'watcher-paused'
    ])
    for (const command of commands) expect(command.params?.command).toEqual({ kind: 'disarm' })
  })

  test('checksSitterStopAll reports refused, indeterminate, and thrown command failures', async () => {
    const rows = [
      sitterRow({ watcherId: 'watcher-applied', worktreeId: 'wt-applied' }),
      sitterRow({ watcherId: 'watcher-refused', worktreeId: 'wt-refused' }),
      sitterRow({ watcherId: 'watcher-thrown', worktreeId: 'wt-thrown' }),
      sitterRow({ watcherId: 'watcher-indeterminate', worktreeId: 'wt-indeterminate' }),
      sitterRow({ watcherId: 'watcher-after-throw', worktreeId: 'wt-after-throw' })
    ]
    const { calls, methods } = unitEnv((method, params) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot(rows)
      if (method === 'quirky.heimdall/command') {
        const watcherId = (params?.target as JsonRecord).watcherId
        if (watcherId === 'watcher-refused') return { kind: 'refused', detail: 'Owner refused stop.' }
        if (watcherId === 'watcher-indeterminate') return { kind: 'indeterminate', detail: 'Stop may or may not have applied.' }
        if (watcherId === 'watcher-thrown') throw new Error('RPC disconnected')
        return { kind: 'applied', appliedAtMs: 1_800 }
      }
      throw new Error(`Unexpected call: ${method}`)
    })

    const result = await invoke(methods, 'checksSitterStopAll', {}) as JsonRecord
    expect(result).toMatchObject({ total: 5, stopped: 2, refusedCount: 1, indeterminateCount: 2 })
    expect(result.warning).toContain('refused')
    expect(result.warning).toContain('2 stop commands may or may not have applied')
    expect(heimdallCalls(calls).filter(({ method }) => method === 'quirky.heimdall/command')).toHaveLength(5)
  })

  test('checksSitterDebugReport rejects a missing report instead of returning success', async () => {
    const row = sitterRow({ watcherId: 'watcher-debug', worktreeId: 'wt-debug' })
    const { calls, methods } = unitEnv((method) => {
      if (method === 'quirky.heimdall/fleet') return fleetSnapshot([row])
      if (method === 'quirky.heimdall/debugReport') return null
      throw new Error(`Unexpected call: ${method}`)
    })

    let caught: unknown
    try {
      await invoke(methods, 'checksSitterDebugReport', { worktree: 'wt-debug', watcherId: 'watcher-debug' })
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(Error)
    expect(heimdallCalls(calls).map(({ method }) => method)).toEqual(['quirky.heimdall/fleet', 'quirky.heimdall/debugReport'])
    expect(heimdallCalls(calls).at(-1)?.params).toEqual({ target: row.target })
  })
})
