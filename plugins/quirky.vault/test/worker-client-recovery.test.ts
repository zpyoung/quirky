import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerRequestError, VaultWorkerClient } from '../src/worker-client'
import type { SearchResponse, SearchStatus } from '../src/types'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'

const workerEntrypoint = new URL('./fixtures/worker-failure.ts', import.meta.url).href
const FAILURE_MARKER_ENV = 'QUIRKY_VAULT_TEST_WORKER_FAILURE_MARKER'

test('Worker failure rejects pending callers and the next real search succeeds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'qv-worker-recovery-'))
  const sourceHome = join(home, 'source-home')
  const dataDir = join(home, 'plugin-data')
  const failureMarker = join(home, 'first-worker-started')
  const previousMarker = process.env[FAILURE_MARKER_ENV]
  const previousSourceHome = process.env.QUIRKY_VAULT_SOURCE_HOME
  let client: VaultWorkerClient | undefined
  try {
    process.env[FAILURE_MARKER_ENV] = failureMarker
    process.env.QUIRKY_VAULT_SOURCE_HOME = sourceHome
    await writeJsonlFixture(sourceHome, 'claude', 'worker-recovery-session', [
      {
        type: 'user',
        sessionId: 'worker-recovery-session',
        timestamp: '2026-10-01T10:00:00.000Z',
        cwd: sourceHome,
        message: { role: 'user', content: 'workerrecoverymarker' }
      }
    ])

    const held = Promise.withResolvers<void>()
    client = new VaultWorkerClient(workerEntrypoint, (event) => {
      if (event.event === 'scanProgress' && event.data.current === 'worker-fault-pending') held.resolve()
    })
    const pending = client.request('hold')
    await held.promise
    const crash = client.request('crash')
    const outcomes = await Promise.allSettled([pending, crash])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected'])
    for (const outcome of outcomes) {
      if (outcome.status !== 'rejected') throw new Error('failed Worker unexpectedly resolved a pending caller')
      expect(outcome.reason).toBeInstanceOf(WorkerRequestError)
      expect((outcome.reason as WorkerRequestError).kind).toBe('worker-failed')
    }

    const enabled = await client.request<SearchStatus>('applySearch', {
      dataDir,
      policy: { enabled: true, historyDays: null }
    })
    expect(enabled.enabled).toBe(true)
    const response = await client.request<SearchResponse>('search', {
      dataDir,
      request: { query: 'workerrecoverymarker', freshness: 'wait-until-current', filters: { agents: ['claude'] } }
    })
    expect(response.kind).toBe('results')
    if (response.kind !== 'results') throw new Error('recovered Worker did not return search results')
    expect(response.hits.map((hit) => hit.sessionId)).toContain('worker-recovery-session')
  } finally {
    try {
      await client?.close()
    } finally {
      rmSync(home, { recursive: true, force: true })
      if (previousMarker === undefined) delete process.env[FAILURE_MARKER_ENV]
      else process.env[FAILURE_MARKER_ENV] = previousMarker
      if (previousSourceHome === undefined) delete process.env.QUIRKY_VAULT_SOURCE_HOME
      else process.env.QUIRKY_VAULT_SOURCE_HOME = previousSourceHome
    }
  }
}, 60_000)
