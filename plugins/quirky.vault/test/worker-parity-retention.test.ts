import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, utimesSync } from 'node:fs'
import type { SearchResponse, SearchResults } from '../src/types'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

function results(response: SearchResponse): SearchResults {
  if (response.kind !== 'results') throw new Error(`search returned ${response.kind}`)
  return response
}

test('real API retention removes old derived answers and keeps the original transcript bytes', async () => {
  rig = await VaultRig.start()
  const id = 'worker-parity-retention'
  const marker = 'retentionoriginalmarker'
  const filePath = await writeJsonlFixture(rig.sourceHome, 'claude', id, [
    {
      type: 'user',
      sessionId: id,
      timestamp: '2000-01-01T00:00:00.000Z',
      cwd: rig.sourceHome,
      message: { role: 'user', content: marker }
    }
  ])
  const oldTime = new Date('2000-01-01T00:00:00.000Z')
  utimesSync(filePath, oldTime, oldTime)
  const sourceBefore = readFileSync(filePath)

  await rig.call('setSearchEnabled', { enabled: true })
  const initiallyIndexed = results(await rig.call<SearchResponse>('search', {
    query: marker,
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  }))
  expect(initiallyIndexed.hits.some((hit) => hit.sessionId === id)).toBe(true)

  await rig.call('setSearchEnabled', { enabled: true, historyDays: 1 })
  const afterRetention = results(await rig.call<SearchResponse>('search', {
    query: marker,
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  }))
  expect(afterRetention.hits.some((hit) => hit.sessionId === id)).toBe(false)
  expect(existsSync(filePath)).toBe(true)
  expect(readFileSync(filePath)).toEqual(sourceBefore)
}, 120_000)
