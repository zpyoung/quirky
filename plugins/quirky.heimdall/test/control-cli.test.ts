import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliContext, CliModule } from '@quirky/protocol'
import type { CommandResult, DebugReport, FleetSnapshot, WatcherDetail } from '../src/control-contracts'
import type { Enrollment, Inspection } from '../src/contracts'
import { commands } from '../src/control-cli'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const row: Enrollment = {
  watcherId: 'watcher-1',
  kind: 'objective',
  workspaceKey: 'host::/work/project',
  workspacePath: '/work/project',
  executionHostId: 'host',
  schedulerOwner: 'local',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  kindPayload: { objective: 'Ship the API' },
  enabled: true,
  paused: false,
  commandRevision: 7,
  capabilities: { merge: 'gated' },
  budget: { wallClockActiveMs: 3_600_000, turns: 40 },
  coordinator: { handle: 'coordinator', paneKey: 'pane' },
  orchestrationRunId: 'run-1',
  createdAtMs: 1,
  terminalAtMs: null,
  parkReason: null,
  haltReason: null
}

const baseInspection: Inspection = {
  readOnly: false,
  enrollment: row,
  status: { state: 'watching', nextPulseAtMs: null, consecutiveErrors: 0, consecutiveGateHolds: 0 },
  journal: [],
  traces: [],
  summary: null,
  budget: { activeMs: 120_000, turns: 2, exhausted: null }
}

const ownerFence = {
  executionHostId: row.executionHostId,
  schedulerOwner: row.schedulerOwner,
  workspaceKey: row.workspaceKey,
  revision: row.commandRevision
}

const watcher: WatcherDetail = {
  ...baseInspection,
  target: { watcherId: row.watcherId },
  ownerFence,
  ownerContact: 'live',
  observedAtMs: 10,
  name: 'Ship the API',
  workers: [{ identity: { dispatchId: 'dispatch-1', sessionId: 'session-1', processIncarnation: 'process-1' }, state: 'live' }],
  openEscalations: [{
    escalationId: 'approval-1',
    escalationKind: 'awaiting-approval',
    status: 'open',
    foldCount: 1,
    approvalScope: { actionKind: 'merge', contentIdentity: 'commit:abc', evidenceKey: 'checks:green', preparedCommitSha: 'abc' }
  }],
  pendingControls: []
}

const fleet: FleetSnapshot = {
  generatedAtMs: 100,
  rows: [],
  actionHistory: [],
  buckets: { needsYou: 0, lostContact: 0, active: 0, inactive: 0 },
  activeCount: 0,
  attentionCount: 0
}

const report: DebugReport = {
  schemaVersion: 2,
  generatedAtMs: 100,
  enrollment: row,
  status: baseInspection.status,
  budget: baseInspection.budget,
  openInterval: null,
  ledger: [],
  traces: [],
  pendingControls: [],
  malformed: null,
  workers: watcher.workers,
  runner: baseInspection.status,
  pointers: { database: '/profile/heimdall.db', workspace: row.workspacePath, leaseHolder: null }
}

type Call = { method: string; params: Record<string, unknown> }

function contextFor(
  response: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
  json = false,
  files: Record<string, string> = {}
) {
  const calls: Call[] = []
  const lines: string[] = []
  const ctx: CliContext = {
    call: async (method, params = {}) => {
      calls.push({ method, params })
      return await response(method, params)
    },
    out: {
      json,
      result: (value, text) => lines.push(json ? JSON.stringify(value) : text()),
      line: (text) => lines.push(text),
      jsonLine: (value) => lines.push(JSON.stringify(value))
    },
    format: {
      table: (headers, rows) => [headers.join(' | '), ...rows.map((entry) => entry.join(' | '))].join('\n'),
      record: (pairs) => pairs.map(([key, value]) => `${key}: ${value}`).join('\n')
    },
    env: {},
    cwd: '/tmp',
    readFile: async (path) => {
      if (!Object.hasOwn(files, path)) throw new Error(`missing fixture file ${path}`)
      return files[path]!
    },
    sleep: async () => {},
    now: () => 0,
    usage: (message) => Object.assign(new Error(message), { name: 'UsageError' }),
    fail: (message) => Object.assign(new Error(message), { name: 'StderrFailure' }),
    reconnect: async () => {}
  }
  return { ctx, calls, lines }
}

function invoke(name: string, positionals: string[], flags: Record<string, unknown>, ctx: CliContext) {
  const handler = (commands as CliModule['commands'])[`cli-command:quirky.heimdall/${name}`]
  if (!handler) throw new Error(`missing CLI command ${name}`)
  return handler({ positionals, flags }, ctx)
}

function commandContext(result: CommandResult, json = false) {
  return contextFor((method) => {
    if (method === 'quirky.heimdall/detail') return watcher
    if (method === 'quirky.heimdall/command') return result
    throw new Error(`unexpected method ${method}`)
  }, json)
}

describe('Heimdall control CLI', () => {
  test('list filters on kind and worktree while preserving global JSON output', async () => {
    const snapshot = {
      ...fleet,
      rows: [
        { target: watcher.target, enrollment: row, workspaceName: 'project', branch: 'main', status: watcher.status, name: watcher.name },
        { target: { watcherId: 'other' }, enrollment: { ...row, watcherId: 'other', kind: 'hosted-review', worktreeId: 'worktree-2' }, workspaceName: 'other', branch: null, status: watcher.status, name: 'review' }
      ]
    } as FleetSnapshot
    const { ctx, calls, lines } = contextFor((method) => {
      expect(method).toBe('quirky.heimdall/fleet')
      return snapshot
    }, true)

    await invoke('list', [], { kind: 'objective', worktree: 'worktree-1' }, ctx)

    expect(calls).toEqual([{ method: 'quirky.heimdall/fleet', params: {} }])
    expect(JSON.parse(lines[0]!)).toHaveLength(1)
    expect(JSON.parse(lines[0]!)[0].target.watcherId).toBe('watcher-1')
  })
  test('resolves a worktree selector before applying the list filter', async () => {
    const snapshot = {
      ...fleet,
      rows: [
        { target: watcher.target, enrollment: row, workspaceName: 'project', branch: 'main', status: watcher.status, name: watcher.name },
        { target: { watcherId: 'other' }, enrollment: { ...row, watcherId: 'other', kind: 'hosted-review', worktreeId: 'worktree-2' }, workspaceName: 'other', branch: null, status: watcher.status, name: 'review' }
      ]
    } as FleetSnapshot
    const { ctx, calls, lines } = contextFor((method) => {
      if (method === 'quirky.heimdall/fleet') return snapshot
      if (method === 'quirky.worktree/resolve') return { id: 'worktree-1' }
      throw new Error(`unexpected method ${method}`)
    }, true)

    await invoke('list', [], { worktree: 'active' }, ctx)

    expect(calls).toEqual([
      { method: 'quirky.heimdall/fleet', params: {} },
      { method: 'quirky.worktree/resolve', params: { selector: 'active' } }
    ])
    expect(JSON.parse(lines[0]!)).toHaveLength(1)
    expect(JSON.parse(lines[0]!)[0].target.watcherId).toBe('watcher-1')
  })

  test('fetches the exact detail fence before sending pause', async () => {
    const { ctx, calls, lines } = commandContext({ kind: 'applied', appliedAtMs: 200 })

    await invoke('pause', ['watcher-1'], {}, ctx)

    expect(calls).toEqual([
      { method: 'quirky.heimdall/detail', params: { target: { watcherId: 'watcher-1' } } },
      {
        method: 'quirky.heimdall/command',
        params: { target: watcher.target, expectedOwner: ownerFence, command: { kind: 'pause' } }
      }
    ])
    expect(lines[0]).toContain('Applied by the owner')
  })

  test('approves only the exact scope recorded on the selected open escalation', async () => {
    const { ctx, calls } = commandContext({ kind: 'applied', appliedAtMs: 200 })

    await invoke('approve', ['watcher-1', 'approval-1'], {}, ctx)

    expect(calls[1]).toEqual({
      method: 'quirky.heimdall/command',
      params: {
        target: watcher.target,
        expectedOwner: ownerFence,
        command: { kind: 'approve', escalationId: 'approval-1', scope: watcher.openEscalations[0]!.approvalScope }
      }
    })
  })

  test('stop-worker sends the exact process identity recorded in detail', async () => {
    const { ctx, calls } = commandContext({ kind: 'applied', appliedAtMs: 200 })

    await invoke('stop-worker', ['watcher-1', 'dispatch-1'], {}, ctx)

    expect(calls[1]?.params).toEqual({
      target: watcher.target,
      expectedOwner: ownerFence,
      command: { kind: 'stop-worker', identity: watcher.workers[0]!.identity }
    })
  })

  test('refused and indeterminate command results are printed and fail the CLI', async () => {
    for (const result of [
      { kind: 'refused', reason: 'stale-revision', detail: 'reload the watcher' } as const,
      { kind: 'indeterminate', detail: 'owner reply was lost' } as const
    ]) {
      const { ctx, lines } = commandContext(result)
      await expect(invoke('resume', ['watcher-1'], {}, ctx)).rejects.toThrow()
      expect(lines[0]).toContain(result.detail)
    }
  })

  test('rejects invalid numeric controls before sending a command', async () => {
    const concurrency = commandContext({ kind: 'applied', appliedAtMs: 200 })
    await expect(invoke('set-concurrency', ['watcher-1', '1.5'], {}, concurrency.ctx)).rejects.toThrow(/integer/)
    expect(concurrency.calls).toHaveLength(0)

    const budget = commandContext({ kind: 'applied', appliedAtMs: 200 })
    await expect(invoke('budget', ['watcher-1'], { hours: 'Infinity' }, budget.ctx)).rejects.toThrow(/--hours must be/)
    expect(budget.calls.map((call) => call.method)).toEqual(['quirky.heimdall/detail'])
  })

  test('create merges explicit objective flags over the whitelisted spec and delegates to core enrollment', async () => {
    const { ctx, calls } = contextFor((method, params) => {
      expect(method).toBe('quirky.heimdall/enroll')
      expect(params.kind).toBe('objective')
      return { kind: 'enrolled', enrollment: row }
    })

    await invoke('create', ['objective'], {
      spec: JSON.stringify({
        kindPayload: { objective: 'from spec', customPolicy: { enabled: true } },
        budget: { wallClockActiveMs: 1, turns: 2 },
        capabilities: { merge: 'off' }
      }),
      objective: 'from flag',
      hours: '2',
      turns: 'none',
      worktree: 'active',
      territory: ['src/**']
    }, ctx)

    expect(calls[0]?.params).toEqual({
      kind: 'objective',
      kindPayload: {
        objective: 'from flag',
        customPolicy: { enabled: true },
        tier: 'standard',
        landingBar: 'files-on-disk',
        lanesEnabled: true,
        maxConcurrency: 3,
        writeTerritory: ['src/**'],
        worktree: 'active'
      },
      capabilities: { merge: 'off' },
      budget: { wallClockActiveMs: 7_200_000, turns: null },
      ownerInterventionCapability: 'off'
    })

  })
  test('merges validated owner configuration from the spec with explicit CLI flags', async () => {
    const { ctx, calls } = contextFor(() => ({ kind: 'enrolled', enrollment: row }))

    await invoke('create', ['objective'], {
      spec: JSON.stringify({
        kindPayload: { objective: 'Ship the API' },
        owner: { agent: 'claude', model: 'from-spec', effort: 'low' },
        ownerInterventionCapability: 'gated'
      }),
      owner: 'claude',
      'owner-model': 'from-flag',
      'owner-effort': 'high'
    }, ctx)

    expect(calls[0]?.params).toMatchObject({
      owner: { agent: 'claude', model: 'from-flag', effort: 'high' },
      ownerInterventionCapability: 'gated'
    })
  })

  test('rejects an unsupported owner agent before enrollment', async () => {
    const { ctx, calls } = contextFor(() => { throw new Error('must not call enrollment') })

    await expect(invoke('create', ['objective'], {
      spec: JSON.stringify({ kindPayload: { objective: 'Ship the API' }, owner: { agent: 'codex' } })
    }, ctx)).rejects.toThrow(/owner agent must be claude/i)
    expect(calls).toHaveLength(0)
  })


  test('objective prints the real enrollment payload until the kind has a public view', async () => {
    const { ctx, lines } = contextFor((method) => {
      expect(method).toBe('quirky.heimdall/detail')
      return watcher
    })

    await invoke('objective', ['watcher-1'], {}, ctx)

    expect(lines.join('\n')).toContain('Ship the API')
    expect(lines.join('\n')).toContain('objective')
  })

  test('debug always prints bare schema-two JSON and writes identical JSON to --out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heimdall-cli-'))
    temporaryDirectories.push(dir)
    const output = join(dir, 'report.json')
    const { ctx, lines } = contextFor((method) => {
      expect(method).toBe('quirky.heimdall/debugReport')
      return report
    }, true)

    await invoke('debug', ['watcher-1'], { out: output }, ctx)

    expect(JSON.parse(lines[0]!)).toEqual(report)
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(report)
  })
})
