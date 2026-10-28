import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
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

async function search(query: string): Promise<SearchResults> {
  if (!rig) throw new Error('vault rig is not running')
  return results(await rig.call<SearchResponse>('search', {
    query,
    freshness: 'wait-until-current',
    filters: { agents: ['opencode'] }
  }))
}

function updateFirstOpenCodePart(path: string, text: string): void {
  const database = new Database(path)
  try {
    const partId = 'opencode-fixture-session-msg-0-part-0'
    const row = database.query('SELECT data FROM part WHERE id = ?').get(partId) as { data: string } | null
    if (!row) throw new Error('OpenCode fixture user part was missing')
    const data = JSON.parse(row.data) as Record<string, unknown>
    data.text = text
    database.query('UPDATE part SET data = ? WHERE id = ?').run(JSON.stringify(data), partId)
    const updated = database.query('SELECT data FROM part WHERE id = ?').get(partId) as { data: string }
    expect((JSON.parse(updated.data) as Record<string, unknown>).text).toBe(text)
    database.query('UPDATE session SET time_updated = time_updated + 1 WHERE id = ?').run('opencode-fixture-session')
  } finally {
    database.close()
  }
}

test('real API indexes appended SQLite messages, replaces rewritten rows, and drops truncated conversations', async () => {
  rig = await VaultRig.start()
  const listing = await rig.call<PublicListResult>('list', { host: 'local', agents: ['opencode'], unlimited: true })
  const session = listing.sessions.find((item) => item.agent === 'opencode' && item.sessionId === 'opencode-fixture-session')
  const databasePath = session?.source.filePath
  if (!databasePath) throw new Error('OpenCode fixture database path was missing')
  updateFirstOpenCodePart(databasePath, 'opencodeoriginalcontentmarker')

  await rig.call('setSearchEnabled', { enabled: true })
  expect((await search('opencodeoriginalcontentmarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(true)

  const database = new Database(databasePath)
  try {
    const timestamp = Date.now()
    const messageId = 'opencode-parity-appended-message'
    database.query('INSERT INTO message(id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
      .run(messageId, 'opencode-fixture-session', timestamp, timestamp, JSON.stringify({ role: 'user', time: { created: timestamp } }))
    database.query('INSERT INTO part(id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`${messageId}-part`, messageId, 'opencode-fixture-session', timestamp, timestamp, JSON.stringify({ type: 'text', text: 'opencodeappendmarker' }))
    database.query('UPDATE session SET time_updated = time_updated + 1 WHERE id = ?').run('opencode-fixture-session')
  } finally {
    database.close()
  }
  expect((await search('opencodeappendmarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(true)
  expect((await search('opencodeoriginalcontentmarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(true)

  updateFirstOpenCodePart(databasePath, 'opencoderewritemarker')
  expect((await search('opencodeoriginalcontentmarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(false)
  expect((await search('opencoderewritemarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(true)

  const truncated = new Database(databasePath)
  try {
    truncated.query('DELETE FROM part WHERE session_id = ?').run('opencode-fixture-session')
    truncated.query('DELETE FROM message WHERE session_id = ?').run('opencode-fixture-session')
    truncated.query('UPDATE session SET time_updated = time_updated + 1 WHERE id = ?').run('opencode-fixture-session')
  } finally {
    truncated.close()
  }
  expect((await search('opencoderewritemarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(false)
  expect((await search('opencodeappendmarker')).hits.some((hit) => hit.sessionId === 'opencode-fixture-session')).toBe(false)
}, 120_000)
