import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
import { fixtureId, startControlHarness, type ControlHarness } from './control-fixture'
import type { CommandRequest, CommandResult, FleetSnapshot, WatcherDetail, WatcherCommand } from '../src/control-contracts'
import type { EnrollmentResult } from '../src/contracts'

let t: ControlHarness
beforeAll(async () => { t = await startControlHarness() })
afterAll(async () => { await t?.cleanup() })
const call = <T>(method: string, params: Record<string, unknown> = {}) => t.client.callAny(`quirky.heimdall/${method}`, params) as Promise<T>
const detail = (watcherId: string) => call<WatcherDetail>('detail', { target: { watcherId } })
async function enroll(workspace: string, payload: Record<string, unknown> = {}, budget?: { wallClockActiveMs: number | null; turns: number | null }): Promise<string> {
  const result = await call<EnrollmentResult>('enroll', {
    kind: 'objective', kindPayload: { workspace, objectiveText: `Objective ${workspace}`, repoId: 'fixture-repo', maxConcurrency: 3, ...payload },
    capabilities: { 'fixture.write': 'gated' }, ...(budget ? { budget } : {})
  })
  if (result.kind !== 'enrolled') throw new Error(`Fixture enrollment failed: ${JSON.stringify(result)}`)
  return result.enrollment.watcherId
}
async function command(watcherId: string, value: WatcherCommand): Promise<CommandResult> {
  const current = await detail(watcherId)
  return call('command', { target: current.target, expectedOwner: current.ownerFence, command: value, ...(value.kind === 'delete' ? { yes: true } : {}) })
}
async function cli(args: string[]) {
  const process = spawnCli(['heimdall', ...args], { home: t.h.home })
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
    return { stdout, stderr, code }
  } finally { if (process.exitCode === null) process.kill() }
}

describe('Heimdall operators through daemon API and real CLI', () => {
  test('empty fleet becomes a pushed held row, exact approval executes once, and debug is bounded schema2 JSON', async () => {
    const initial = await call<FleetSnapshot>('fleet')
    expect(initial).toMatchObject({ rows: [], activeCount: 0, attentionCount: 0 })
    const events: { data?: FleetSnapshot }[] = []
    const unsubscribe = t.client.onEvent(event => { if (event.type === 'quirky.heimdall/fleetChanged') events.push(event as { data?: FleetSnapshot }) })
    await t.client.call('events.subscribe', {})
    const id = await enroll('approve', { mode: 'approval' })
    const held = await waitForAsync(async () => {
      const value = await detail(id)
      return value.openEscalations.some(e => e.approvalScope) ? value : undefined
    }, 5000)
    expect(held.status).toMatchObject({ state: 'held', reason: 'awaiting-approval' })
    const scope = held.openEscalations.find(e => e.approvalScope)!
    const stale = await command(id, { kind: 'approve', escalationId: scope.escalationId, scope: { ...scope.approvalScope!, evidenceKey: 'wrong-evidence' } })
    expect(stale.kind).toBe('refused')
    const approved = await cli(['approve', id, scope.escalationId, '--json'])
    expect(approved.code).toBe(0)
    expect(JSON.parse(approved.stdout)).toMatchObject({ kind: 'applied', appliedAtMs: expect.any(Number) })
    const acted = await waitForAsync(async () => {
      const value = await detail(id)
      return value.journal.some(e => e.kind === 'attempt' && e.effect === 'landed') ? value : undefined
    }, 5000)
    expect(acted.openEscalations.filter(e => e.approvalScope)).toEqual([])
    expect((await call<FleetSnapshot>('fleet')).actionHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ watcherId: id, actionKind: 'fixture-action', state: 'settled', effect: 'landed', reason: 'fixture action confirmed' })
    ]))
    const report = await cli(['debug', id, '--out', join(t.root, 'debug.json')])
    expect(report.code).toBe(0)
    const debug = JSON.parse(report.stdout)
    expect(debug).toMatchObject({ schemaVersion: 2, enrollment: { watcherId: id }, pendingControls: [], pointers: { workspace: acted.enrollment.workspacePath } })
    expect(JSON.parse(readFileSync(join(t.root, 'debug.json'), 'utf8'))).toEqual(debug)
    expect(debug.ledger.length).toBeLessThanOrEqual(200)
    expect(debug.traces.length).toBeLessThanOrEqual(20)
    expect(events.some(event => (event.data?.generatedAtMs ?? 0) > initial.generatedAtMs && event.data?.rows.some(row => row.target.watcherId === id && row.status.state === 'held'))).toBe(true)
    if (typeof unsubscribe === 'function') unsubscribe()
    const effects = join(t.h.home, 'plugin-data', fixtureId, 'effects.log')
    expect(existsSync(effects)).toBe(true)
    expect(readFileSync(effects, 'utf8').trim().split('\n')).toEqual([id])
  }, 15000)

  test('pause/resume use a fresh fence, disarm cannot resume, and delete removes diagnostics without worker stop', async () => {
    const id = await enroll('lifecycle')
    const original = await detail(id)
    const request: CommandRequest = { target: original.target, expectedOwner: original.ownerFence, command: { kind: 'pause' } }
    expect(await call('command', request as unknown as Record<string, unknown>)).toMatchObject({ kind: 'applied' })
    expect((await detail(id)).enrollment).toMatchObject({ paused: true, commandRevision: original.enrollment.commandRevision + 1 })
    expect(await call('command', { ...request, command: { kind: 'resume' } })).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
    expect((await cli(['resume', id, '--json'])).code).toBe(0)
    expect((await detail(id)).enrollment.paused).toBe(false)
    expect((await cli(['disarm', id, '--json'])).code).toBe(0)
    const refused = await cli(['resume', id, '--json'])
    expect(refused.code).not.toBe(0)
    expect(await command(id, { kind: 'delete' })).toMatchObject({ kind: 'applied' })
    expect((await call<FleetSnapshot>('fleet')).rows.some(row => row.target.watcherId === id)).toBe(false)
    expect(await call('detail', { target: { watcherId: id } })).toBeNull()
  }, 15000)

  test('exhausted budget refuses resume until raised, objective cap changes and invalid cap does not mutate', async () => {
    const id = await enroll('budget', {}, { wallClockActiveMs: 0, turns: 40 })
    await waitForAsync(async () => (await detail(id)).status?.state === 'parked', 5000)
    expect(await command(id, { kind: 'resume' })).toMatchObject({ kind: 'refused', reason: 'invalid-state' })
    expect((await detail(id)).enrollment).toMatchObject({ enabled: false, budget: { wallClockActiveMs: 0, turns: 40 } })
    expect((await cli(['budget', id, '--hours', '2', '--turns', 'none', '--json'])).code).toBe(0)
    expect((await detail(id)).enrollment).toMatchObject({ enabled: false, budget: { wallClockActiveMs: 7200000, turns: null } })
    expect(await command(id, { kind: 'resume' })).toMatchObject({ kind: 'applied' })
    expect((await cli(['set-concurrency', id, '2', '--json'])).code).toBe(0)
    expect((await detail(id)).enrollment.kindPayload).toMatchObject({ maxConcurrency: 2 })
    const revision = (await detail(id)).ownerFence.revision
    expect((await cli(['set-concurrency', id, '0'])).code).not.toBe(0)
    expect((await detail(id)).ownerFence.revision).toBe(revision)
  }, 15000)

  test('detail preserves operator-edit and plan-rejection explanations without an approval card', async () => {
    const id = await enroll('reason')
    await t.client.callAny(`${fixtureId}/configure`, { workspace: 'reason', reason: 'retry-needs-new-evidence', detail: 'Merge train paused by operator edits: .memsearch/' })
    await call('reconcile', { watcherId: id })
    const held = await waitForAsync(async () => {
      const value = await detail(id)
      return value.traces.some(trace => trace.decision && 'detail' in trace.decision && trace.decision.detail?.includes('.memsearch/')) ? value : undefined
    }, 5000)
    expect(held.openEscalations).toEqual([])
    await t.client.callAny(`${fixtureId}/configure`, { workspace: 'reason', reason: 'plan-rejected', detail: 'Plan review rejected: missing rollback proof' })
    await call('reconcile', { watcherId: id })
    const rejected = await detail(id)
    expect(rejected.traces.some(trace => trace.decision && 'detail' in trace.decision && trace.decision.detail === 'Plan review rejected: missing rollback proof')).toBe(true)
    const shown = await cli(['show', id])
    expect(shown.code).toBe(0)
    expect(shown.stdout).toContain(id)
    const listed = await cli(['list', '--kind', 'objective', '--json'])
    expect(listed.code).toBe(0)
    expect(listed.stdout).toContain(id)
  }, 15000)

  test('CLI enrollment preserves typed owner configuration with explicit flags winning over spec', async () => {
    const created = await cli(['create', 'objective', '--spec', JSON.stringify({
      kindPayload: { workspace: 'owner-cli', objectiveText: 'Typed owner configuration' },
      owner: { agent: 'claude', model: 'from-spec', effort: 'high' },
      capabilities: { 'owner-intervention': 'on' }
    }), '--owner', 'claude', '--owner-model', 'from-flag', '--json'])
    expect(created.code).toBe(0)
    const result = JSON.parse(created.stdout)
    const current = await detail(result.enrollment.watcherId)
    expect(current.enrollment.owner).toEqual({ agent: 'claude', model: 'from-flag', effort: 'high' })
    expect(current.enrollment.ownerInterventionCapability).toBe('on')
  }, 15000)

  test('real CLI enrollment persists objective inputs, merged roles and gates, capability defaults, and limits', async () => {
    const objectiveFile = join(t.root, 'objective.md')
    const planFile = join(t.root, 'plan.md')
    writeFileSync(objectiveFile, 'Ship the objective from a file')
    writeFileSync(planFile, 'Persist this existing plan')

    const defaults = await cli([
      'create', 'objective',
      '--spec', JSON.stringify({ kindPayload: { workspace: 'cli-objective-defaults' } }),
      '--objective-file', objectiveFile,
      '--plan-file', planFile,
      '--json'
    ])
    expect(defaults.code).toBe(0)
    const defaultsId = JSON.parse(defaults.stdout).enrollment.watcherId as string
    const defaultDetail = await detail(defaultsId)
    expect(defaultDetail.enrollment.kindPayload).toMatchObject({
      workspace: 'cli-objective-defaults',
      objectiveText: 'Ship the objective from a file',
      existingPlan: 'Persist this existing plan',
      tier: 'standard',
      landingBar: 'files-on-disk',
      lanesEnabled: true,
      maxConcurrency: 3,
      writeTerritory: ['**'],
      worktree: 'active'
    })
    expect(defaultDetail.name).toBe('Ship the objective from a file')
    expect(defaultDetail.enrollment.capabilities).toEqual({
      plan: 'gated',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'on'
    })
    expect(defaultDetail.enrollment.budget).toEqual({ wallClockActiveMs: 14_400_000, turns: 40 })

    const overridden = await cli([
      'create', 'objective',
      '--spec', JSON.stringify({
        kindPayload: {
          workspace: 'cli-objective-overrides',
          landingBar: 'committed-local-branch',
          roleAgents: { planner: 'spec-planner', implementer: 'spec-implementer', reviewer: 'spec-reviewer' },
          gates: [{ name: 'spec-gate', command: 'make spec', timeoutSeconds: 61 }]
        },
        capabilities: { plan: 'on', implement: 'off', 'owner-intervention': 'on' },
        budget: { wallClockActiveMs: null, turns: 17 },
        owner: { agent: 'claude', model: 'from-spec', effort: 'low' }
      }),
      '--objective', 'Inline objective wins for the objective text',
      '--plan-file', planFile,
      '--role-agent', 'implementer=flag-implementer',
      '--role-agent', 'reviewer=agent=with-equals',
      '--gate', 'explicit=make check TARGET=x',
      '--territory', 'src/**',
      '--territory', 'test/**',
      '--no-lanes',
      '--cap', 'plan=off',
      '--cap', 'implement=on',
      '--cap', 'owner-intervention=gated',
      '--hours', '2',
      '--turns', 'none',
      '--owner', 'claude',
      '--owner-model', 'from-flag',
      '--owner-effort', 'high',
      '--json'
    ])
    expect(overridden.code).toBe(0)
    const overriddenId = JSON.parse(overridden.stdout).enrollment.watcherId as string
    const overriddenDetail = await detail(overriddenId)
    expect(overriddenDetail.enrollment.kindPayload).toMatchObject({
      workspace: 'cli-objective-overrides',
      objectiveText: 'Inline objective wins for the objective text',
      existingPlan: 'Persist this existing plan',
      landingBar: 'committed-local-branch',
      lanesEnabled: false,
      writeTerritory: ['src/**', 'test/**'],
      roleAgents: { planner: 'spec-planner', implementer: 'flag-implementer', reviewer: 'agent=with-equals' },
      gates: [{ name: 'explicit', command: 'make check TARGET=x', timeoutSeconds: 1800 }],
      worktree: 'active'
    })
    expect(overriddenDetail.enrollment.capabilities).toEqual({
      plan: 'off',
      implement: 'on',
      review: 'on',
      check: 'on',
      land: 'gated'
    })
    expect(overriddenDetail.enrollment.capabilities).not.toHaveProperty('owner-intervention')
    expect(overriddenDetail.enrollment.ownerInterventionCapability).toBe('gated')
    expect(overriddenDetail.enrollment.budget).toEqual({ wallClockActiveMs: 7_200_000, turns: null })
    expect(overriddenDetail.enrollment.owner).toEqual({ agent: 'claude', model: 'from-flag', effort: 'high' })

    const specGateCreated = await cli([
      'create', 'objective',
      '--spec', JSON.stringify({
        kindPayload: {
          workspace: 'cli-spec-gate',
          objectiveText: 'Persist a spec-defined objective',
          gates: [{ name: 'custom-check', command: 'make verify', timeoutSeconds: 123 }]
        },
        budget: { wallClockActiveMs: null, turns: null }
      }),
      '--json'
    ])
    expect(specGateCreated.code).toBe(0)
    const specGateId = JSON.parse(specGateCreated.stdout).enrollment.watcherId as string
    const specGateDetail = await detail(specGateId)
    expect(specGateDetail.enrollment.kindPayload).toMatchObject({
      gates: [{ name: 'custom-check', command: 'make verify', timeoutSeconds: 123 }]
    })
    expect(specGateDetail.enrollment.budget).toEqual({ wallClockActiveMs: null, turns: null })
  }, 15000)

  test('real CLI hosted-review defaults and branch-update/merge-method enum strings persist', async () => {
    const cases = [
      { workspace: 'cli-hosted-defaults', branchUpdate: undefined, mergeMethod: 'default', expectedBranchUpdate: 'merge-base-update', expectedMergeMethod: null },
      { workspace: 'cli-hosted-merge', branchUpdate: 'rebase', mergeMethod: 'merge', expectedBranchUpdate: 'rebase', expectedMergeMethod: 'merge' },
      { workspace: 'cli-hosted-squash', branchUpdate: 'merge-base-update', mergeMethod: 'squash', expectedBranchUpdate: 'merge-base-update', expectedMergeMethod: 'squash' },
      { workspace: 'cli-hosted-rebase', branchUpdate: 'rebase', mergeMethod: 'rebase', expectedBranchUpdate: 'rebase', expectedMergeMethod: 'rebase' }
    ] as const
    for (const entry of cases) {
      const flags = [
        'create', 'hosted-review',
        '--spec', JSON.stringify({ kindPayload: { workspace: entry.workspace } }),
        ...(entry.branchUpdate === undefined ? [] : ['--branch-update', entry.branchUpdate]),
        '--merge-method', entry.mergeMethod,
        '--json'
      ]
      const created = await cli(flags)
      expect(created.code).toBe(0)
      const watcherId = JSON.parse(created.stdout).enrollment.watcherId as string
      const current = await detail(watcherId)
      expect(current.enrollment.kindPayload).toMatchObject({
        branchUpdateMode: entry.expectedBranchUpdate,
        mergeMethod: entry.expectedMergeMethod,
        worktree: 'active'
      })
      expect(current.enrollment.capabilities).toEqual({
        updateBranch: 'off',
        resolveConflicts: 'off',
        fixChecks: 'off',
        merge: 'off'
      })
      expect(current.enrollment.budget).toEqual({ wallClockActiveMs: 14_400_000, turns: null })
    }
  }, 15000)

  test('invalid create flags do not add enrollments or accept legacy objective payload names', async () => {
    const before = await call<FleetSnapshot>('fleet')
    const originalIds = before.rows.map(row => row.target.watcherId).sort()
    const invalidInvocations = [
      ['create', 'objective', '--spec', JSON.stringify({ kindPayload: { workspace: 'invalid-legacy-objective', objective: 'Not the required objectiveText' } }), '--json'],
      ['create', 'objective', '--spec', JSON.stringify({ kindPayload: { workspace: 'invalid-role-agent' } }), '--objective', 'Valid text', '--role-agent', 'implementer=', '--json'],
      ['create', 'objective', '--spec', JSON.stringify({ kindPayload: { workspace: 'invalid-gate' } }), '--objective', 'Valid text', '--gate', 'verify=', '--json'],
      ['create', 'objective', '--spec', JSON.stringify({ kindPayload: { workspace: 'invalid-owner-capability', objectiveText: 'Valid text' }, capabilities: { 'owner-intervention': 'on' }, ownerInterventionCapability: 'off' }), '--json'],
      ['create', 'hosted-review', '--spec', JSON.stringify({ kindPayload: { workspace: 'invalid-branch-update' } }), '--branch-update', 'none', '--json'],
    ]
    for (const args of invalidInvocations) expect((await cli(args)).code).not.toBe(0)
    const after = await call<FleetSnapshot>('fleet')
    expect(after.rows.map(row => row.target.watcherId).sort()).toEqual(originalIds)
  }, 15000)


  test('pause fences a real blocked kind read before the old decision can execute', async () => {
    const created = await call<{ enrollment: { watcherId: string } }>('enroll', {
      kind: 'objective', kindPayload: { workspace: 'fenced-read' }, capabilities: { 'fixture.write': 'on' }
    })
    const id = created.enrollment.watcherId
    await waitForAsync(async () => (await detail(id)).traces.some(trace => trace.exitPath === 'watching'), 5000)
    await t.client.callAny(`${fixtureId}/configure`, { workspace: 'fenced-read', blockRead: true, mode: 'approval' })
    const pulse = call('reconcile', { watcherId: id })
    await waitForAsync(async () => {
      const world = await t.client.callAny(`${fixtureId}/configure`, { workspace: 'fenced-read' }) as { readStarted?: boolean }
      return world.readStarted
    }, 5000)
    const current = await detail(id)
    const paused = call<CommandResult>('command', { target: current.target, expectedOwner: current.ownerFence, command: { kind: 'pause' } })
    await waitForAsync(async () => (await detail(id)).pendingControls.includes('pause'), 5000)
    await t.client.callAny(`${fixtureId}/configure`, { workspace: 'fenced-read', releaseRead: true })
    expect(await paused).toMatchObject({ kind: 'applied' })
    await pulse
    expect((await detail(id)).enrollment.paused).toBe(true)
    const effects = join(t.h.home, 'plugin-data', fixtureId, 'effects.log')
    expect(existsSync(effects) ? readFileSync(effects, 'utf8').split('\n').includes(id) : false).toBe(false)
  }, 15000)

  test('invalid deletion returns a refusal without creating a confirmation ask', async () => {
    const id = await enroll('invalid-delete')
    const current = await detail(id)
    const pending = () => t.client.callAny('quirky.ask/list', { pendingOnly: true }) as Promise<{ id: string }[]>
    const before = new Set((await pending()).map(ask => ask.id))
    try {
      expect(await call('command', {
        target: current.target, expectedOwner: current.ownerFence,
        command: { kind: 'delete', budget: { wallClockActiveMs: null, turns: null } }
      })).toMatchObject({ kind: 'refused', reason: 'invalid-command' })
      expect((await pending()).map(ask => ask.id).filter(askId => !before.has(askId))).toEqual([])
      expect((await detail(id)).enrollment.commandRevision).toBe(current.enrollment.commandRevision)
    } finally {
      for (const ask of await pending()) {
        if (!before.has(ask.id)) await t.client.callAny('quirky.ask/cancel', { askId: ask.id })
      }
    }
  })

  test('daemon delete confirmation is exact and single-use; cancellation never removes history', async () => {
    const id = await enroll('confirm-delete')
    const current = await detail(id)
    const request = { target: current.target, expectedOwner: current.ownerFence, command: { kind: 'delete' } }
    const askForDelete = async (): Promise<string> => {
      try { await call('command', request) } catch (error) {
        expect(error).toBeInstanceOf(RpcError)
        if (!(error instanceof RpcError)) throw error
        expect(error.code).toBe(RpcErrorCode.ConfirmationRequired)
        const data = error.data
        if (data && typeof data === 'object' && 'askId' in data && typeof data.askId === 'string') return data.askId
        throw new Error('Confirmation response omitted its exact ask identity')
      }
      throw new Error('Unconfirmed deletion ran')
    }
    const cancelled = await askForDelete()
    await t.client.callAny('quirky.ask/cancel', { askId: cancelled })
    await expect(call('command', { ...request, confirmation: cancelled })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
    expect((await detail(id)).enrollment.commandRevision).toBe(current.enrollment.commandRevision)
    const accepted = await askForDelete()
    await t.client.callAny('quirky.ask/answer', { askId: accepted, answers: { confirm: { value: true, source: 'input' } } })
    expect(await call('command', { ...request, confirmation: accepted })).toMatchObject({ kind: 'applied' })
    expect(await call('detail', { target: { watcherId: id } })).toBeNull()
    expect(await call('debugReport', { target: { watcherId: id } })).toBeNull()
    await expect(call('command', { ...request, confirmation: accepted })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  })

  test('foreign targets and unverifiable workers fail closed through public command API', async () => {
    const id = await enroll('authority')
    const current = await detail(id)
    expect(await call('command', { target: { watcherId: id, connectionId: 'foreign-host' }, expectedOwner: current.ownerFence, command: { kind: 'pause' } })).toMatchObject({ kind: 'refused', reason: 'owner-unreachable' })
    expect(await command(id, { kind: 'stop-worker', identity: { dispatchId: 'not-owned', sessionId: 'unknown', processIncarnation: 'unknown' } })).toMatchObject({ kind: 'refused', reason: 'worker-unverifiable' })
    expect((await detail(id)).enrollment.paused).toBe(false)
  })
})
