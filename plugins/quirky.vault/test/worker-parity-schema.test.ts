import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { PublicListResult, SearchResponse, SearchResults } from '../src/types'
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

test('schema mismatch rebuilds only the derived index and preserves source bytes', async () => {
  rig = await VaultRig.start()
  const listing = await rig.call<PublicListResult>('list', { host: 'local', agents: ['claude'], unlimited: true })
  const session = listing.sessions.find((item) => item.agent === 'claude' && item.sessionId === 'claude-fixture-session')
  const sourcePath = session?.source.filePath
  if (!sourcePath) throw new Error('Claude source path was missing')
  const sourceBytes = readFileSync(sourcePath)

  await rig.call('setSearchEnabled', { enabled: true })
  const initial = results(await rig.call<SearchResponse>('search', {
    query: 'vault-fixture-claude-marker',
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  }))
  expect(initial.hits.some((hit) => hit.sessionId === 'claude-fixture-session')).toBe(true)

  await rig.call('setSearchEnabled', { enabled: false })
  const databasePath = join(rig.home, 'plugin-data', 'quirky.vault', 'session-search.sqlite')
  const database = new Database(databasePath)
  try {
    database.exec('PRAGMA user_version = 999')
  } finally {
    database.close()
  }
  await rig.call('setSearchEnabled', { enabled: true })

  const rebuilt = results(await rig.call<SearchResponse>('search', {
    query: 'vault-fixture-claude-marker',
    freshness: 'wait-until-current',
    filters: { agents: ['claude'] }
  }))
  expect(rebuilt.hits.some((hit) => hit.sessionId === 'claude-fixture-session')).toBe(true)
  expect(readFileSync(sourcePath)).toEqual(sourceBytes)
}, 120_000)
