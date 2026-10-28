import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuntime } from '@quirky/protocol/node'
import { daemonUrl } from '../../../apps/desktop/src/bun/page'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { eventually, startWorkerAcceptance, type WorkerAcceptance } from '../../quirky.orchestration/test/workers/acceptance-support'
import type { DebugReport, FleetSnapshot, WatcherDetail } from '../src/control-contracts'
import type { Attempt, EnrollmentResult, Inspection } from '../src/contracts'

export const fleetWorkerFixturePluginId = 'acme.heimdall-fleet-worker-fixture'
export const fleetWorkerFixtureKindId = 'fleet-worker-fixture'
const ACTION_KIND = 'fleet-worker-dispatch'
const CAPABILITY = 'fleet-worker.dispatch'
const DEFAULT_FENCE_HOLD_MS = 120_000

type CliResult = { code: number; stdout: string; stderr: string }
type WorkerCompletion = { kind: string; report: { status: string; [key: string]: unknown }; [key: string]: unknown }

export type FleetWorkerHandle = {
  watcherId: string
  runId: string
  dispatchId: string
  taskId: string
  sessionId: string
  processIncarnation: string
  pid: number
}

export type WorkerProcessState = {
  sessionId: string
  processIncarnation: string
  pid: number
  ptyAlive: boolean
  processAlive: boolean
}

export type FleetWorkerEvidence = {
  fleet: FleetSnapshot
  detail: WatcherDetail | null
  debug: DebugReport | null
  cli: { list: CliResult; show: CliResult; debug: CliResult }
}

export interface FleetWorkerFixture {
  readonly harness: WorkerAcceptance
  readonly home: string
  readonly uiUrl: string
  call<T>(method: string, params?: Record<string, unknown>): Promise<T>
  enroll(): Promise<string>
  startWorker(watcherId: string): Promise<FleetWorkerHandle>
  establishReadFence(watcherId: string): Promise<void>
  releaseReadFence(watcherId: string): Promise<void>
  reportCompletion(worker: FleetWorkerHandle): Promise<WorkerCompletion>
  readEvidence(watcherId: string): Promise<FleetWorkerEvidence>
  processState(worker: FleetWorkerHandle): Promise<WorkerProcessState>
  cleanup(): Promise<void>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
}

function fixturePluginSource(fenceHoldMs: number): string {
  return `import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const pluginId = ${JSON.stringify(fleetWorkerFixturePluginId)}
const kindId = ${JSON.stringify(fleetWorkerFixtureKindId)}
const actionKind = ${JSON.stringify(ACTION_KIND)}
const capability = ${JSON.stringify(CAPABILITY)}
const fenceHoldMs = ${JSON.stringify(fenceHoldMs)}
const fences = new Map()
const method = name => 'method:' + pluginId + '/' + name

export async function activate(context) {
  context.provide(method('authorize'), async value => {
    const input = value && typeof value === 'object' ? value.input || value : {}
    const payload = input.kindPayload || {}
    if (typeof payload.workspace !== 'string') throw new Error('fixture workspace is required')
    const path = join(context.dataDir, 'workspaces', payload.workspace)
    mkdirSync(path, { recursive: true })
    const workspacePath = realpathSync(path)
    return {
      workspaceKey: 'local::' + workspacePath,
      workspacePath,
      executionHostId: 'local',
      schedulerOwner: 'daemon',
      kindPayload: payload
    }
  })

  context.provide(method('read'), async value => {
    const enrollment = value && typeof value === 'object' ? value.enrollment || value : {}
    const fence = fences.get(enrollment.watcherId)
    if (fence && !fence.entered) {
      fence.entered = true
      await fence.wait
    }
    const payload = enrollment.kindPayload || {}
    return {
      freshness: 'live',
      contentIdentity: 'fleet-worker-fixture-v1',
      observedAtMs: Date.now(),
      world: { workspace: payload.workspace, workerRequest: payload.workerRequest }
    }
  })

  context.provide(method('decide'), value => {
    const journal = Array.isArray(value.journal) ? value.journal : []
    if (journal.some(entry => entry.kind === 'attempt' && entry.action && entry.action.kind === actionKind)) {
      return { action: null, reason: 'fixture-worker-already-dispatched', considered: ['fixture-worker'] }
    }
    return {
      action: {
        kind: actionKind,
        capability,
        visibility: 'external',
        contentIdentity: value.snapshot.contentIdentity,
        evidenceKey: 'fleet-worker-assignment',
        expectedState: { target: 'fleet-worker-task', before: { status: 'ready' } }
      },
      considered: ['fixture-worker']
    }
  })

  context.provide(method('execute'), value => {
    const enrollment = value.enrollment || value.context && value.context.enrollment
    const workerRequest = enrollment && enrollment.kindPayload && enrollment.kindPayload.workerRequest
    if (!workerRequest) throw new Error('fixture worker request is missing')
    return { worker: workerRequest }
  })

  context.provide(method('stop'), () => null)
  context.provide(method('armFence'), value => {
    if (!value || typeof value.watcherId !== 'string') throw new Error('watcherId is required')
    const { promise: wait, resolve } = Promise.withResolvers()
    const fence = { entered: false, released: false, resolve, wait, timer: undefined }
    const release = () => {
      if (fence.released) return
      fence.released = true
      clearTimeout(fence.timer)
      fence.resolve()
    }
    fence.release = release
    fence.timer = setTimeout(release, fenceHoldMs)
    fences.set(value.watcherId, fence)
    return { armed: true, watcherId: value.watcherId }
  })
  context.provide(method('readFenceState'), value => {
    const fence = value && typeof value.watcherId === 'string' ? fences.get(value.watcherId) : undefined
    return { armed: !!fence, entered: !!fence && fence.entered, held: !!fence && fence.entered && !fence.released }
  })
  context.provide(method('releaseFence'), value => {
    const fence = value && typeof value.watcherId === 'string' ? fences.get(value.watcherId) : undefined
    if (!fence) return { released: false }
    fence.release()
    return { released: true }
  })

  await context.call('quirky.heimdall/registerKind', {
    id: kindId,
    displayName: 'Fleet worker projection fixture',
    enrollmentPayloadSchema: {
      type: 'object',
      required: ['workspace', 'workerRequest'],
      properties: {
        workspace: { type: 'string' },
        workerRequest: { type: 'object', additionalProperties: true }
      },
      additionalProperties: false
    },
    hooks: {
      authorize: pluginId + '/authorize',
      read: pluginId + '/read',
      decide: pluginId + '/decide',
      execute: pluginId + '/execute',
      stop: pluginId + '/stop'
    }
  })
}
`
}

function pluginManifest() {
  const methodNames = ['authorize', 'read', 'decide', 'execute', 'stop', 'armFence', 'readFenceState', 'releaseFence']
  return {
    id: fleetWorkerFixturePluginId,
    name: 'Heimdall fleet worker fixture',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'startup',
    dependencies: ['quirky.heimdall'],
    contributes: {
      method: methodNames.map(id => ({
        id,
        params: { type: 'object', additionalProperties: true },
        result: {}
      }))
    }
  }
}

export async function startFleetWorkerFixture(options: { fenceHoldMs?: number } = {}): Promise<FleetWorkerFixture> {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'heimdall-fleet-worker-plugin-'))
  const fenceHoldMs = options.fenceHoldMs ?? DEFAULT_FENCE_HOLD_MS
  const pluginPath = writePlugin(pluginRoot, pluginManifest(), { 'main.ts': fixturePluginSource(fenceHoldMs) })
  let harness: WorkerAcceptance | undefined
  let cleanupPromise: Promise<void> | undefined
  const heldFences = new Set<string>()

  const stop = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      const errors: unknown[] = []
      const step = async (action: () => void | Promise<void>) => {
        try { await action() } catch (error) { errors.push(error) }
      }
      if (harness) {
        for (const watcherId of heldFences) {
          await step(async () => {
            await harness!.fixture.call(`${fleetWorkerFixturePluginId}/releaseFence`, { watcherId })
          })
        }
        await step(() => harness!.cleanup())
        harness = undefined
      }
      await step(() => rmSync(pluginRoot, { recursive: true, force: true }))
      if (errors.length > 0) throw errors[0]
    })()
    return cleanupPromise
  }

  try {
    harness = await startWorkerAcceptance()
    await harness.fixture.call('plugin.install', { path: pluginPath, yes: true })
    const runtime = readRuntime(harness.fixture.home)
    if (!runtime) throw new Error('the fleet worker fixture daemon did not publish runtime information')

    const call = <T>(method: string, params: Record<string, unknown> = {}) =>
      harness!.fixture.call(method, params) as Promise<T>

    return {
      harness,
      home: harness.fixture.home,
      uiUrl: daemonUrl(runtime),
      call,
      async enroll() {
        const result = await call<EnrollmentResult>('quirky.heimdall/enroll', {
          kind: fleetWorkerFixtureKindId,
          kindPayload: {
            workspace: `fleet-worker-${randomUUID()}`,
            workerRequest: {
              spec: 'Complete the fixture assignment by reporting worker_done through the inherited CLI authority.',
              worktree: `path:${harness!.fixture.repo}`,
              agent: 'claude',
              mode: 'terminal',
              taskTitle: 'Heimdall fleet worker projection',
              timeoutMs: 20_000
            }
          },
          capabilities: { [CAPABILITY]: 'on' },
          budget: { wallClockActiveMs: null, turns: null }
        })
        if (result.kind !== 'enrolled' && result.kind !== 're-armed') {
          throw new Error(`fleet worker fixture enrollment failed: ${JSON.stringify(result)}`)
        }
        return result.enrollment.watcherId
      },
      async startWorker(watcherId) {
        const result = await eventually(async () => {
          const inspections = await call<Inspection[]>('quirky.heimdall/inspect', { watcherId })
          const inspection = inspections.find(value => value.enrollment.watcherId === watcherId)
          if (!inspection) return null
          const attemptRow = inspection.journal
            .filter((entry): entry is Attempt => {
              if (entry.kind !== 'attempt') return false
              const action = entry.action
              return typeof action === 'object' && action !== null && !Array.isArray(action) &&
                'kind' in action && action.kind === ACTION_KIND
            })
            .at(-1)
          if (attemptRow?.state === 'settled' && attemptRow.effect !== 'landed') {
            throw new Error(`fixture worker dispatch ${String(attemptRow.effect)}: ${String(attemptRow.reason)}`)
          }
          const dispatchId = attemptRow?.dispatchId
          const runId = inspection.enrollment.orchestrationRunId
          if (typeof dispatchId !== 'string' || typeof runId !== 'string') return null
          const shown = await call<unknown>('quirky.orchestration/workerShow', { dispatchId })
          if (typeof shown !== 'object' || shown === null || Array.isArray(shown) || !('dispatch' in shown) || !('worker' in shown)) return null
          const dispatch = shown.dispatch
          const workerInfo = shown.worker
          if (typeof dispatch !== 'object' || dispatch === null || Array.isArray(dispatch) ||
            typeof workerInfo !== 'object' || workerInfo === null || Array.isArray(workerInfo) ||
            !('runId' in dispatch) || !('taskId' in dispatch) || !('sessionId' in workerInfo)) return null
          if (dispatch.runId !== runId) throw new Error('fixture worker dispatch belongs to a different Run')
          const sessionId = workerInfo.sessionId
          const taskId = dispatch.taskId
          if (typeof sessionId !== 'string' || typeof taskId !== 'string') return null
          const detail = await call<WatcherDetail | null>('quirky.heimdall/detail', { target: { watcherId } })
          const worker = detail?.workers.find(candidate => candidate.identity.dispatchId === dispatchId)
          const processIncarnation = worker?.identity.processIncarnation
          if (!worker || worker.identity.sessionId !== sessionId || typeof processIncarnation !== 'string' ||
            worker.state !== 'live' || worker.assignmentActive !== true) return null
          const started = harness!.events(sessionId).find(event => event.type === 'started' && event.sessionId === sessionId)
          const pid = started?.pid
          if (typeof pid !== 'number' || !await harness!.ptyAlive(sessionId)) return null
          return { watcherId, runId, dispatchId, taskId, sessionId, processIncarnation, pid }
        }, value => value !== null, 'attested Heimdall Run worker', 90_000)
        if (!result) throw new Error('attested Heimdall Run worker was not observed')
        return result
      },
      async establishReadFence(watcherId) {
        heldFences.add(watcherId)
        await call(`${fleetWorkerFixturePluginId}/armFence`, { watcherId })
        await eventually(
          () => call<unknown>(`${fleetWorkerFixturePluginId}/readFenceState`, { watcherId }),
          value => typeof value === 'object' && value !== null && !Array.isArray(value) &&
            'held' in value && value.held === true,
          'fixture read hook to acknowledge its pre-mailbox fence',
          30_000
        )
      },
      async releaseReadFence(watcherId) {
        await call(`${fleetWorkerFixturePluginId}/releaseFence`, { watcherId })
        heldFences.delete(watcherId)
      },
      async reportCompletion(worker) {
        return harness!.callAs<WorkerCompletion>(worker.sessionId, 'send', [
          '--type', 'worker_done',
          '--task-id', worker.taskId,
          '--dispatch-id', worker.dispatchId,
          '--outcome', 'succeeded',
          '--subject', 'Heimdall fleet activity fixture completed',
          '--body', 'The actual launched worker reports success through its inherited CLI authority.'
        ])
      },
      async readEvidence(watcherId) {
        const target = { target: { watcherId } }
        const [fleet, detail, debug, list, show, cliDebug] = await Promise.all([
          call<FleetSnapshot>('quirky.heimdall/fleet'),
          call<WatcherDetail | null>('quirky.heimdall/detail', target),
          call<DebugReport | null>('quirky.heimdall/debugReport', target),
          harness!.fixture.cli(['heimdall', 'list']),
          harness!.fixture.cli(['heimdall', 'show', watcherId]),
          harness!.fixture.cli(['heimdall', 'debug', watcherId])
        ])
        return { fleet, detail, debug, cli: { list, show, debug: cliDebug } }
      },
      async processState(worker) {
        return {
          sessionId: worker.sessionId,
          processIncarnation: worker.processIncarnation,
          pid: worker.pid,
          ptyAlive: await harness!.ptyAlive(worker.sessionId),
          processAlive: processIsAlive(worker.pid)
        }
      },
      cleanup: stop
    }
  } catch (error) {
    try { await stop() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fleet worker fixture setup and cleanup failed')
    }
    throw error
  }
}
