import { describe, expect, test } from 'bun:test'
import type { PluginCaller, PluginContext, RuntimePeer, RuntimePeerCall, RuntimePeerReply, RuntimePeerStatus } from '@quirky/protocol'
import type { CommandRequest, ControlPlane, DebugReport, FleetService, FleetSnapshot, KernelControlHost, OwnerFence, WatcherCommand, WatcherDetail, WatcherTarget } from '../src/control-contracts'
import type { Enrollment, Inspection, JournalEntry, RunnerStatus, TickTrace } from '../src/contracts'
import { registerControlApi } from '../src/control-api'
import { createRemoteFleetTransport } from '../src/remote-fleet'

const peer: RuntimePeer = {
  id: 'peer-build',
  label: 'Build host',
  endpoint: 'https://secret-user:secret-password@peer.invalid',
  fingerprint: 'private-peer-fingerprint',
  pairingRevision: 4
}
const status: RuntimePeerStatus = {
  fingerprint: peer.fingerprint,
  incarnation: 'daemon-start-1',
  capabilities: ['quirky.heimdall/remoteFleet', 'quirky.heimdall/remoteDetail', 'quirky.heimdall/remoteDebugReport', 'quirky.heimdall/remoteCommand']
}

const runnerStatus = (state: RunnerStatus['state']): RunnerStatus => ({
  state,
  nextPulseAtMs: null,
  consecutiveErrors: 2,
  consecutiveGateHolds: 1
})

function enrollment(watcherId: string, revision = 7): Enrollment {
  return {
    watcherId,
    kind: 'objective',
    workspaceKey: `host::/work/${watcherId}`,
    workspacePath: `/work/${watcherId}`,
    executionHostId: 'remote-host',
    schedulerOwner: 'remote-runtime',
    kindPayload: { name: watcherId },
    enabled: true,
    paused: false,
    commandRevision: revision,
    capabilities: { implement: 'on' },
    budget: { wallClockActiveMs: 600_000, turns: 10 },
    coordinator: { handle: 'coord', paneKey: 'pane' },
    orchestrationRunId: 'run_remote',
    createdAtMs: 10,
    terminalAtMs: null,
    parkReason: null,
    haltReason: null
  }
}

function row(watcherId: string, remote = false) {
  const item = enrollment(watcherId)
  return {
    target: { watcherId },
    ownerFence: { executionHostId: item.executionHostId, schedulerOwner: item.schedulerOwner, workspaceKey: item.workspaceKey, revision: item.commandRevision },
    enrollment: item,
    status: runnerStatus('watching'),
    name: watcherId,
    workspaceName: watcherId,
    branch: null,
    phase: 'implement',
    ownerContact: 'live' as const,
    observedAtMs: 100,
    lastSuccessfulTickAtMs: 90,
    budget: { activeMs: 321, turns: 3, exhausted: null },
    runningWorkers: 2,
    maxConcurrency: 3,
    openEscalations: [],
    pendingQuestion: false,
    ...(remote ? { credential: 'must-not-be-copied' } : {})
  }
}

const localSnapshot = (): FleetSnapshot => ({
  generatedAtMs: 100,
  rows: [row('local-watcher')],
  actionHistory: [],
  buckets: { needsYou: 0, lostContact: 0, active: 1, inactive: 0 },
  activeCount: 1,
  attentionCount: 0
})
const remoteSnapshot = (): FleetSnapshot => ({
  generatedAtMs: 99,
  rows: [row('remote-watcher', true)],
  actionHistory: [],
  buckets: { needsYou: 0, lostContact: 0, active: 1, inactive: 0 },
  activeCount: 1,
  attentionCount: 0
})

function detail(watcherId: string): WatcherDetail {
  const item = enrollment(watcherId)
  const inspection: Inspection = {
    readOnly: false,
    enrollment: item,
    status: runnerStatus('watching'),
    journal: [],
    traces: [] as TickTrace[],
    summary: null,
    budget: { activeMs: 321, turns: 3, exhausted: null }
  }
  return {
    ...inspection,
    target: { watcherId },
    ownerFence: { executionHostId: item.executionHostId, schedulerOwner: item.schedulerOwner, workspaceKey: item.workspaceKey, revision: item.commandRevision },
    ownerContact: 'live',
    observedAtMs: 100,
    name: watcherId,
    workers: [],
    openEscalations: [],
    pendingControls: []
  }
}

function debugReport(watcherId: string): DebugReport {
  return {
    schemaVersion: 2,
    generatedAtMs: 100,
    enrollment: enrollment(watcherId),
    status: runnerStatus('watching'),
    budget: { activeMs: 321, turns: 3, exhausted: null },
    openInterval: null,
    ledger: [] as JournalEntry[],
    traces: [],
    pendingControls: [],
    malformed: null,
    workers: [],
    runner: runnerStatus('watching'),
    pointers: { database: '/remote/store.db', workspace: '/remote/work', leaseHolder: null }
  }
}

function harness() {
  let peerRevision = peer.pairingRevision
  let liveStatus = status
  let failFleet = false
  let loseCommandResponse = false
  let commandCalls = 0
  const calls: RuntimePeerCall[] = []
  const controlRequests: CommandRequest[] = []
  const events: unknown[] = []
  const context = {
    pluginId: 'quirky.heimdall',
    dir: '/plugin',
    dataDir: '/plugin/data',
    home: '/isolated/home',
    log: () => {},
    emit: (_event: string, data: unknown) => { events.push(data); return true },
    provide: () => {},
    subscribe: () => () => {},
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'quirky.orchestration/peerList') return { peers: [{ ...peer, pairingRevision: peerRevision }] }
      if (method === 'quirky.orchestration/peerStatus') return liveStatus
      if (method !== 'quirky.orchestration/peerCall') throw new Error(`unexpected transport method ${method}`)
      const call = params as unknown as RuntimePeerCall
      calls.push(call)
      if (call.method === 'quirky.heimdall/remoteFleet' && failFleet) throw new Error('remote fleet read lost')
      let result: unknown
      if (call.method === 'quirky.heimdall/remoteFleet') result = remoteSnapshot()
      else if (call.method === 'quirky.heimdall/remoteDetail') result = detail(String((call.params.target as Record<string, unknown>).watcherId))
      else if (call.method === 'quirky.heimdall/remoteDebugReport') {
        result = {
          ...debugReport(String((call.params.target as Record<string, unknown>).watcherId)),
          pairedEndpoint: peer.endpoint,
          pairedFingerprint: peer.fingerprint
        }
      }
      else if (call.method === 'quirky.heimdall/remoteCommand') {
        commandCalls++
        controlRequests.push(call.params as unknown as CommandRequest)
        if (loseCommandResponse) throw new Error('connection dropped after command dispatch')
        result = { kind: 'applied', appliedAtMs: 123 }
      } else throw new Error(`unexpected peer method ${call.method}`)
      const currentPeer = { ...peer, pairingRevision: peerRevision }
      const reply: RuntimePeerReply = { peer: currentPeer, status: liveStatus, result }
      return reply
    }
  } as unknown as PluginContext
  const controls: ControlPlane = {
    command: async (request) => {
      controlRequests.push(request)
      return { kind: 'applied', appliedAtMs: 123 }
    },
    pending: () => []
  }
  const local = {
    fleet: async () => localSnapshot(),
    detail: async (target: WatcherTarget) => detail(target.watcherId),
    debugReport: async (target: WatcherTarget) => debugReport(target.watcherId)
  }
  const service = createRemoteFleetTransport(context, local, controls, () => 150)
  return {
    service,
    context,
    calls,
    controlRequests,
    events,
    get commandCalls() { return commandCalls },
    setPeerRevision(value: number) { peerRevision = value },
    setStatus(value: RuntimePeerStatus) { liveStatus = value },
    failFleet(value: boolean) { failFleet = value },
    loseCommandResponse(value: boolean) { loseCommandResponse = value }
  }
}

describe('paired Heimdall fleet transport', () => {
  test('merges local and paired snapshots without publishing peer secrets', async () => {
    const h = harness()
    try {
      const snapshot = await h.service.fleet()
      const remote = snapshot.rows.find((candidate) => candidate.target.watcherId === 'remote-watcher')!
      expect(snapshot.rows.map((candidate) => candidate.target.watcherId).sort()).toEqual(['local-watcher', 'remote-watcher'])
      expect(remote.target).toEqual({ watcherId: 'remote-watcher', connectionId: peer.id, pairingRevision: peer.pairingRevision })
      expect(remote.ownerLabel).toBe(peer.label)
      expect(remote.ownerIncarnation).toBe(status.incarnation)
      expect(remote.budget.activeMs).toBe(321)
      const published = JSON.stringify(snapshot)
      expect(published).not.toContain('secret-password')
      expect(published).not.toContain(peer.fingerprint)
      expect(published).not.toContain('must-not-be-copied')
    } finally {
      h.service.dispose()
    }
  })

  test('keeps last-confirmed remote activity as unreachable after a read failure', async () => {
    const h = harness()
    try {
      const before = await h.service.fleet()
      h.failFleet(true)
      const after = await h.service.fleet()
      const previous = before.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      const stale = after.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      expect(stale.ownerContact).toBe('unverifiable')
      expect(stale.status.state).toBe('unreachable')
      expect(stale.observedAtMs).toBe(previous.observedAtMs)
      expect(stale.budget).toEqual(previous.budget)
      expect(stale.runningWorkers).toBe(previous.runningWorkers)
      expect(stale.lastSuccessfulTickAtMs).toBe(previous.lastSuccessfulTickAtMs)
    } finally {
      h.service.dispose()
    }
  })

  test('invalidates the previous pairing revision instead of showing its cached watchers', async () => {
    const h = harness()
    try {
      await h.service.fleet()
      h.setPeerRevision(peer.pairingRevision + 1)
      h.failFleet(true)
      const snapshot = await h.service.fleet()
      expect(snapshot.rows.some((candidate) => candidate.target.connectionId === peer.id)).toBe(false)
    } finally {
      h.service.dispose()
    }
  })

  test('refuses remote controls after the pairing revision changes', async () => {
    const h = harness()
    try {
      const snapshot = await h.service.fleet()
      const remote = snapshot.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      h.setPeerRevision(peer.pairingRevision + 1)
      const result = await h.service.command({
        target: remote.target,
        expectedOwner: remote.ownerFence,
        command: { kind: 'pause' }
      }, remote.ownerIncarnation)
      expect(result).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
      expect(h.commandCalls).toBe(0)
    } finally {
      h.service.dispose()
    }
  })
  test('routes detail and owner-fenced commands through the pinned peer once', async () => {
    const h = harness()
    try {
      const snapshot = await h.service.fleet()
      const rowFromPeer = snapshot.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      const remoteDetail = await h.service.detail(rowFromPeer.target)
      expect(remoteDetail?.target).toEqual(rowFromPeer.target)
      expect(remoteDetail?.ownerLabel).toBe(peer.label)
      const report = await h.service.debugReport(rowFromPeer.target)
      expect(report?.schemaVersion).toBe(2)
      expect(JSON.stringify(report)).not.toContain('secret-password')
      expect(JSON.stringify(report)).not.toContain(peer.fingerprint)
      const request: CommandRequest = {
        target: rowFromPeer.target,
        expectedOwner: rowFromPeer.ownerFence,
        command: { kind: 'pause' }
      }
      const result = await h.service.command(request, rowFromPeer.ownerIncarnation)
      expect(result).toEqual({ kind: 'applied', appliedAtMs: 123 })
      expect(h.commandCalls).toBe(1)
      const dispatched = h.calls.find((call) => call.method === 'quirky.heimdall/remoteCommand')!
      expect(dispatched.peerId).toBe(peer.id)
      expect(dispatched.pairingRevision).toBe(peer.pairingRevision)
      expect(dispatched.requestId).toBeTruthy()
      expect(dispatched.params).toMatchObject({ target: { watcherId: 'remote-watcher' }, expectedOwner: rowFromPeer.ownerFence, expectedIncarnation: rowFromPeer.ownerIncarnation, command: { kind: 'pause' } })
    } finally {
      h.service.dispose()
    }
  })

  test('refuses remote controls when the daemon incarnation changed since the owner snapshot', async () => {
    const h = harness()
    try {
      const snapshot = await h.service.fleet()
      const rowFromPeer = snapshot.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      h.setStatus({ ...status, incarnation: 'daemon-start-2' })
      const result = await h.service.command({ target: rowFromPeer.target, expectedOwner: rowFromPeer.ownerFence, command: { kind: 'pause' } }, rowFromPeer.ownerIncarnation)
      expect(result).toMatchObject({ kind: 'refused', reason: 'owner-conflict' })
      expect(h.commandCalls).toBe(0)
    } finally {
      h.service.dispose()
    }
  })

  test('reports a dropped command response as indeterminate without retrying', async () => {
    const h = harness()
    try {
      const snapshot = await h.service.fleet()
      const rowFromPeer = snapshot.rows.find((candidate) => candidate.target.connectionId === peer.id)!
      h.loseCommandResponse(true)
      const result = await h.service.command({ target: rowFromPeer.target, expectedOwner: rowFromPeer.ownerFence, command: { kind: 'pause' } }, rowFromPeer.ownerIncarnation)
      expect(result.kind).toBe('indeterminate')
      expect(h.commandCalls).toBe(1)
    } finally {
      h.service.dispose()
    }
  })
})

describe('authenticated Heimdall peer endpoints', () => {
  test('serves local-only state to orchestration and rejects every other caller without recursion', async () => {
    const methods = new Map<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown>()
    let localFleetCalls = 0
    let localDetailCalls = 0
    let localDebugCalls = 0
    let globalFleetCalls = 0
    const fleet = {
      fleet: async () => { globalFleetCalls++; throw new Error('must never recurse') },
      localFleet: async () => { localFleetCalls++; return localSnapshot() },
      localDetail: async (target: WatcherTarget) => { localDetailCalls++; return detail(target.watcherId) },
      localDebugReport: async (target: WatcherTarget) => { localDebugCalls++; return debugReport(target.watcherId) },
      detail: async () => null,
      debugReport: async () => null,
      command: async () => ({ kind: 'indeterminate', detail: 'not used' }),
      publish: async () => {},
      dispose: () => {}
    } as unknown as FleetService
    const controls: ControlPlane = { command: async () => ({ kind: 'applied', appliedAtMs: 1 }), pending: () => [] }
    const host = {
      context: {
        provide: (id: string, handler: unknown) => { methods.set(id.replace('method:quirky.heimdall/', ''), handler as (params: Record<string, unknown>, caller: PluginCaller) => unknown) },
        error: (_kind: string, message: string) => new Error(message),
        log: () => {},
        call: async () => null
      }
    } as unknown as KernelControlHost
    registerControlApi(host, controls, fleet)
    const remoteFleet = methods.get('remoteFleet')!
    const orchestrationCaller = { role: 'plugin', pluginId: 'quirky.orchestration' } as const
    await expect(remoteFleet({}, { role: 'plugin', pluginId: 'quirky.other' })).rejects.toThrow()
    const result = await remoteFleet({}, orchestrationCaller) as FleetSnapshot
    expect(result.rows.map((candidate) => candidate.target.watcherId)).toEqual(['local-watcher'])
    const remoteDetail = methods.get('remoteDetail')!
    const remoteDebug = methods.get('remoteDebugReport')!
    const target = { target: { watcherId: 'local-watcher' } }
    await expect(remoteDetail(target, { role: 'plugin', pluginId: 'quirky.other' })).rejects.toThrow()
    await expect(remoteDebug(target, { role: 'plugin', pluginId: 'quirky.other' })).rejects.toThrow()
    expect(await remoteDetail(target, orchestrationCaller)).toMatchObject({ target: { watcherId: 'local-watcher' } })
    expect(await remoteDebug(target, orchestrationCaller)).toMatchObject({ enrollment: { watcherId: 'local-watcher' } })
    expect(localFleetCalls).toBe(1)
    expect(localDetailCalls).toBe(1)
    expect(localDebugCalls).toBe(1)
    expect(globalFleetCalls).toBe(0)
  })

  test('remote command endpoint passes the complete owner fence to local controls', async () => {
    const methods = new Map<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown>()
    const expectedOwner: OwnerFence = { executionHostId: 'remote-host', schedulerOwner: 'remote-runtime', workspaceKey: 'host::/work/remote-watcher', revision: 7 }
    const currentOwner = { ...expectedOwner, revision: 8 }
    const received: CommandRequest[] = []
    const controls: ControlPlane = {
      command: async (request) => {
        received.push(request)
        if (
          request.expectedOwner.executionHostId !== currentOwner.executionHostId ||
          request.expectedOwner.schedulerOwner !== currentOwner.schedulerOwner ||
          request.expectedOwner.workspaceKey !== currentOwner.workspaceKey
        ) return { kind: 'refused', reason: 'owner-conflict', detail: 'host or workspace changed' }
        if (request.expectedOwner.revision !== currentOwner.revision) return { kind: 'refused', reason: 'stale-revision', detail: 'revision changed' }
        return { kind: 'applied', appliedAtMs: 1 }
      },
      pending: () => []
    }
    const fleet = {
      fleet: async () => localSnapshot(),
      localFleet: async () => localSnapshot(),
      localDetail: async (target: WatcherTarget) => detail(target.watcherId),
      localDebugReport: async (target: WatcherTarget) => debugReport(target.watcherId),
      detail: async () => null,
      debugReport: async () => null,
      command: async () => ({ kind: 'indeterminate', detail: 'not used' }),
      publish: async () => {},
      dispose: () => {}
    } as unknown as FleetService
    const host = {
      context: {
        provide: (id: string, handler: unknown) => { methods.set(id.replace('method:quirky.heimdall/', ''), handler as (params: Record<string, unknown>, caller: PluginCaller) => unknown) },
        error: (_kind: string, message: string) => new Error(message),
        log: () => {},
        call: async () => null
      }
    } as unknown as KernelControlHost
    registerControlApi(host, controls, fleet)
    const remoteCommand = methods.get('remoteCommand')!
    const payload = {
      target: { watcherId: 'remote-watcher' },
      expectedOwner,
      expectedIncarnation: 'daemon-start-1',
      command: { kind: 'pause' } satisfies WatcherCommand,
      requestId: 'request-1'
    }
    const result = await remoteCommand(payload, { role: 'plugin', pluginId: 'quirky.orchestration' })
    expect(result).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
    const wrongHost = { ...payload, expectedOwner: { ...expectedOwner, executionHostId: 'other-host' }, requestId: 'request-2' }
    const hostResult = await remoteCommand(wrongHost, { role: 'plugin', pluginId: 'quirky.orchestration' })
    expect(hostResult).toMatchObject({ kind: 'refused', reason: 'owner-conflict' })
    const wrongWorkspace = { ...payload, expectedOwner: { ...expectedOwner, workspaceKey: 'host::/other-workspace' }, requestId: 'request-3' }
    const workspaceResult = await remoteCommand(wrongWorkspace, { role: 'plugin', pluginId: 'quirky.orchestration' })
    expect(workspaceResult).toMatchObject({ kind: 'refused', reason: 'owner-conflict' })
    expect(received).toEqual([
      { target: payload.target, expectedOwner, command: payload.command },
      { target: wrongHost.target, expectedOwner: wrongHost.expectedOwner, command: payload.command },
      { target: wrongWorkspace.target, expectedOwner: wrongWorkspace.expectedOwner, command: payload.command }
    ])
    await expect(remoteCommand(payload, { role: 'plugin', pluginId: 'quirky.other' })).rejects.toThrow()
  })
  test('describes remote deletion from a live owner-fenced detail without dispatching a command', async () => {
    const methods = new Map<string, (params: Record<string, unknown>, caller: PluginCaller) => unknown>()
    const target = { watcherId: 'remote-watcher', connectionId: peer.id, pairingRevision: peer.pairingRevision }
    const expectedOwner: OwnerFence = {
      executionHostId: 'remote-host',
      schedulerOwner: 'remote-runtime',
      workspaceKey: 'host::/work/remote-watcher',
      revision: 7
    }
    let ownerContact: WatcherDetail['ownerContact'] = 'live'
    const remoteDetail = { ...detail('remote-watcher'), target, ownerFence: expectedOwner }
    const fleet = {
      fleet: async () => localSnapshot(),
      localFleet: async () => localSnapshot(),
      localDetail: async () => null,
      localDebugReport: async () => null,
      detail: async () => ({ ...remoteDetail, ownerContact }),
      debugReport: async () => null,
      command: async () => { throw new Error('description must not dispatch') },
      publish: async () => {},
      dispose: () => {}
    } as unknown as FleetService
    const controls: ControlPlane = { command: async () => { throw new Error('description must not mutate') }, pending: () => [] }
    const host = {
      context: {
        provide: (id: string, handler: unknown) => { methods.set(id.replace('method:quirky.heimdall/', ''), handler as (params: Record<string, unknown>, caller: PluginCaller) => unknown) },
        error: (_kind: string, message: string) => new Error(message),
        log: () => {},
        call: async () => null
      }
    } as unknown as KernelControlHost
    registerControlApi(host, controls, fleet)
    const describe = methods.get('describeCommand')!
    const request = { target, expectedOwner, command: { kind: 'delete' } }
    const description = await describe(request, { role: 'plugin', pluginId: 'quirky.heimdall' })
    expect(description).toBe('Delete watcher “remote-watcher” and its saved history? Worker terminals will continue running.')
    ownerContact = 'unverifiable'
    expect(await describe(request, { role: 'plugin', pluginId: 'quirky.heimdall' })).toBeNull()
  })
})
