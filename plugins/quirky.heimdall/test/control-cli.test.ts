import { describe, expect, test } from 'bun:test'
import type { CliContext, CliModule } from '@quirky/protocol'
import type { CommandResult, FleetSnapshot, WatcherDetail } from '../src/control-contracts'
import type { Enrollment, Inspection } from '../src/contracts'
import { commands } from '../src/control-cli'


const row: Enrollment = {
  watcherId: 'watcher-1',
  kind: 'objective',
  workspaceKey: 'host::/work/project',
  workspacePath: '/work/project',
  executionHostId: 'host',
  schedulerOwner: 'local',
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  kindPayload: { objectiveText: 'Ship the API' },
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
    const { ctx, lines } = contextFor((method) => {
      if (method !== 'quirky.heimdall/fleet') throw new Error(`unexpected method ${method}`)
      return snapshot
    }, true)

    await invoke('list', [], { kind: 'objective', worktree: 'worktree-1' }, ctx)

    expect(JSON.parse(lines[0]!).map((item: FleetSnapshot['rows'][number]) => item.target.watcherId)).toEqual(['watcher-1'])
  })
  test('resolves a worktree selector before applying the list filter', async () => {
    const snapshot = {
      ...fleet,
      rows: [
        { target: watcher.target, enrollment: row, workspaceName: 'project', branch: 'main', status: watcher.status, name: watcher.name },
        { target: { watcherId: 'other' }, enrollment: { ...row, watcherId: 'other', kind: 'hosted-review', worktreeId: 'worktree-2' }, workspaceName: 'other', branch: null, status: watcher.status, name: 'review' }
      ]
    } as FleetSnapshot
    const { ctx, lines } = contextFor((method) => {
      if (method === 'quirky.heimdall/fleet') return snapshot
      if (method === 'quirky.worktree/resolve') return { id: 'worktree-1' }
      throw new Error(`unexpected method ${method}`)
    }, true)

    await invoke('list', [], { worktree: 'active' }, ctx)

    expect(JSON.parse(lines[0]!).map((item: FleetSnapshot['rows'][number]) => item.target.watcherId)).toEqual(['watcher-1'])
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
    await expect(invoke('set-concurrency', ['watcher-1', '1.5'], {}, concurrency.ctx)).rejects.toMatchObject({ name: 'UsageError' })
    expect(concurrency.calls).toHaveLength(0)

    const budget = commandContext({ kind: 'applied', appliedAtMs: 200 })
    await expect(invoke('budget', ['watcher-1'], { hours: 'Infinity' }, budget.ctx)).rejects.toMatchObject({ name: 'UsageError' })
    expect(budget.calls.some(call => call.method === 'quirky.heimdall/command')).toBe(false)
  })


  test('rejects an unsupported owner agent before enrollment', async () => {
    const { ctx, calls } = contextFor(() => { throw new Error('must not call enrollment') })

    await expect(invoke('create', ['objective'], {
      spec: JSON.stringify({ kindPayload: { objectiveText: 'Ship the API' }, owner: { agent: 'codex' } })
    }, ctx)).rejects.toMatchObject({ name: 'UsageError' })
    expect(calls).toHaveLength(0)
  })


})
