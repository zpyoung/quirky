import { afterEach, expect, test } from 'bun:test'
import type { DebugReport, FleetRow, WatcherDetail } from '../src/control-contracts'
import { fleetWorkerFixturePluginId, startFleetWorkerFixture, type FleetWorkerFixture } from './fleet-worker-fixture'

let fixture: FleetWorkerFixture | undefined
afterEach(async () => {
  await fixture?.cleanup()
  fixture = undefined
})

function cliJson<T>(result: { code: number; stdout: string; stderr: string }, label: string): T {
  if (result.code !== 0) throw new Error(`${label} exited ${result.code}: ${result.stderr || result.stdout}`)
  try {
    return JSON.parse(result.stdout) as T
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${result.stdout}`, { cause: error })
  }
}

function rowFor(rows: FleetRow[], watcherId: string): FleetRow {
  const row = rows.find(candidate => candidate.target.watcherId === watcherId)
  if (!row) throw new Error(`fleet omitted watcher ${watcherId}`)
  return row
}

function workerFor(detail: WatcherDetail | null, dispatchId: string) {
  const worker = detail?.workers.find(candidate => candidate.identity.dispatchId === dispatchId)
  if (!worker) throw new Error(`detail omitted worker ${dispatchId}`)
  return worker
}

test('an actual Heimdall-owned worker stays inspectable but stops counting after its CLI report', async () => {
  fixture = await startFleetWorkerFixture()
  const watcherId = await fixture.enroll()
  const worker = await fixture.startWorker(watcherId)

  const before = await fixture.readEvidence(watcherId)
  expect(rowFor(before.fleet.rows, watcherId).runningWorkers).toBe(1)
  expect(workerFor(before.detail, worker.dispatchId)).toMatchObject({
    identity: { dispatchId: worker.dispatchId, sessionId: worker.sessionId, processIncarnation: worker.processIncarnation },
    state: 'live',
    assignmentActive: true
  })

  const initialProcess = await fixture.processState(worker)
  expect(initialProcess).toMatchObject({ ptyAlive: true, processAlive: true })

  await fixture.establishReadFence(watcherId)
  try {
    const completion = await fixture.reportCompletion(worker)
    expect(completion.report.status).toBe('accepted')

    const after = await fixture.readEvidence(watcherId)
    const detailWorker = workerFor(after.detail, worker.dispatchId)
    const debugWorker = after.debug?.workers.find(candidate => candidate.identity.dispatchId === worker.dispatchId)
    expect(rowFor(after.fleet.rows, watcherId).runningWorkers).toBe(0)
    expect(detailWorker).toMatchObject({
      identity: { dispatchId: worker.dispatchId, sessionId: worker.sessionId, processIncarnation: worker.processIncarnation },
      state: 'live',
      assignmentActive: false
    })
    expect(debugWorker).toEqual(detailWorker)

    const cliRows = cliJson<FleetRow[]>(after.cli.list, 'heimdall list')
    expect(rowFor(cliRows, watcherId).runningWorkers).toBe(0)
    const cliDetail = cliJson<WatcherDetail>(after.cli.show, 'heimdall show')
    expect(workerFor(cliDetail, worker.dispatchId)).toEqual(detailWorker)
    const cliDebug = cliJson<DebugReport>(after.cli.debug, 'heimdall debug')
    expect(cliDebug.workers.find(candidate => candidate.identity.dispatchId === worker.dispatchId)).toEqual(detailWorker)

    const process = await fixture.processState(worker)
    expect(process).toMatchObject({ sessionId: worker.sessionId, processIncarnation: worker.processIncarnation, pid: worker.pid, ptyAlive: true, processAlive: true })
    const fence = await fixture.call<unknown>(`${fleetWorkerFixturePluginId}/readFenceState`, { watcherId })
    expect(fence).toMatchObject({ entered: true, held: true })
  } finally {
    await fixture.releaseReadFence(watcherId)
  }
})
