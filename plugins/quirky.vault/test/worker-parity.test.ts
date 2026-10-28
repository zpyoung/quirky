import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { HostedSession, PublicListResult, SearchResponse, SearchResults, SearchStatus } from '../src/types'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'
import { VaultRig } from './support/harness'

type PublicSearchStatus = { status: SearchStatus }

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())

function requireSession(result: PublicListResult, agent: string, sessionId: string): HostedSession {
  const session = result.sessions.find((item) => item.agent === agent && item.sessionId === sessionId)
  if (!session) throw new Error(`missing ${agent} fixture session ${sessionId}`)
  return session
}

function requireSourcePath(session: HostedSession): string {
  const path = session.source.filePath
  if (!path) throw new Error(`missing local source path for ${session.agent}`)
  return path
}

function results(response: SearchResponse): SearchResults {
  if (response.kind !== 'results') throw new Error(`search returned ${response.kind}`)
  return response
}

async function search(vault: VaultRig, query: string, agent: string): Promise<SearchResults> {
  const response = await vault.call<SearchResponse>('search', {
    query,
    freshness: 'wait-until-current',
    filters: { agents: [agent] }
  })
  return results(response)
}

async function expectHit(vault: VaultRig, query: string, agent: string, sessionId: string): Promise<SearchResults> {
  let last: SearchResults | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await search(vault, query, agent)
    if (last.hits.some((hit) => hit.sessionId === sessionId)) return last
  }
  throw new Error(`expected indexed session ${sessionId} for ${agent}`)
}

async function expectNoHit(vault: VaultRig, query: string, agent: string, sessionId: string): Promise<SearchResults> {
  let last: SearchResults | undefined
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await search(vault, query, agent)
    if (!last.hits.some((hit) => hit.sessionId === sessionId)) return last
  }
  throw new Error(`unexpected indexed session ${sessionId} for ${agent}`)
}

function claudeUser(sessionId: string, cwd: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    timestamp: new Date('2026-10-01T10:00:00.000Z').toISOString(),
    cwd,
    message: { role: 'user', content: text }
  }
}

function updateOpenCodePart(path: string, text: string): void {
  const database = new Database(path)
  try {
    const partId = 'opencode-fixture-session-msg-0-part-0'
    const row = database.query('SELECT data FROM part WHERE id = ?').get(partId) as { data: string } | null
    if (!row) throw new Error('OpenCode fixture message part was missing')
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

test('real daemon API reconciles JSONL, JSON, sidecar and SQLite changes while skipping unchanged files', async () => {
  const vault = await start()
  const jsonlId = 'worker-parity-jsonl'
  const jsonlPath = await writeJsonlFixture(vault.sourceHome, 'claude', jsonlId, [
    claudeUser(jsonlId, vault.sourceHome, 'jsonloldmarker')
  ])
  const listed = await vault.call<PublicListResult>('list', { host: 'local', unlimited: true })
  const codex = requireSession(listed, 'codex', 'codex-session')
  const gemini = requireSession(listed, 'gemini', 'gemini-session')
  const opencode = requireSession(listed, 'opencode', 'opencode-fixture-session')
  const geminiPath = requireSourcePath(gemini)
  const opencodePath = requireSourcePath(opencode)
  writeFileSync(geminiPath, readFileSync(geminiPath, 'utf8').replace('vault-fixture-gemini-marker', 'geminioriginalcontentmarker'))
  updateOpenCodePart(opencodePath, 'opencodeoriginalcontentmarker')

  await vault.call('setSearchEnabled', { enabled: true })
  await expectHit(vault, 'jsonloldmarker', 'claude', jsonlId)
  await expectHit(vault, 'geminioriginalcontentmarker', 'gemini', 'gemini-session')
  await expectHit(vault, 'vault-fixture-codex-marker', 'codex', 'codex-session')
  await expectHit(vault, 'opencodeoriginalcontentmarker', 'opencode', 'opencode-fixture-session')

  appendFileSync(jsonlPath, `${JSON.stringify(claudeUser(jsonlId, vault.sourceHome, 'jsonlappendmarker'))}\n`)
  await expectHit(vault, 'jsonlappendmarker', 'claude', jsonlId)

  await writeJsonlFixture(vault.sourceHome, 'claude', jsonlId, [
    claudeUser(jsonlId, vault.sourceHome, 'jsonlrewritemarker')
  ])
  await expectNoHit(vault, 'jsonloldmarker', 'claude', jsonlId)
  await expectNoHit(vault, 'jsonlappendmarker', 'claude', jsonlId)
  await expectHit(vault, 'jsonlrewritemarker', 'claude', jsonlId)

  await writeJsonlFixture(vault.sourceHome, 'claude', jsonlId, [
    claudeUser(jsonlId, vault.sourceHome, 'jsonltruncatemarker')
  ])
  await expectNoHit(vault, 'jsonlrewritemarker', 'claude', jsonlId)
  await expectHit(vault, 'jsonltruncatemarker', 'claude', jsonlId)

  const inodeReplacement = `${jsonlPath}.replacement`
  writeFileSync(inodeReplacement, `${JSON.stringify(claudeUser(jsonlId, vault.sourceHome, 'jsonlinodereplacementmarker'))}\n`)
  renameSync(inodeReplacement, jsonlPath)
  await expectNoHit(vault, 'jsonltruncatemarker', 'claude', jsonlId)
  const replacement = await expectHit(vault, 'jsonlinodereplacementmarker', 'claude', jsonlId)
  const unchanged = await search(vault, 'jsonlinodereplacementmarker', 'claude')
  expect(unchanged.generation).toBe(replacement.generation)

  const codexIndexPath = join(vault.sourceHome, '.codex', 'session_index.jsonl')
  writeFileSync(codexIndexPath, `${JSON.stringify({ id: 'codex-session', thread_name: 'Codex parity sidecar title' })}\n`)
  const codexTitle = await expectHit(vault, 'vault-fixture-codex-marker', 'codex', 'codex-session')
  expect(codexTitle.hits.find((hit) => hit.sessionId === 'codex-session')?.title).toBe('Codex parity sidecar title')

  const geminiDocument = JSON.parse(readFileSync(geminiPath, 'utf8')) as {
    messages: { content: { text?: string }[] }[]
  }
  const geminiPrompt = geminiDocument.messages[0]?.content[0]
  if (!geminiPrompt) throw new Error('Gemini fixture did not contain a first prompt')
  geminiPrompt.text = 'geminiupdatedmarker'
  writeFileSync(geminiPath, JSON.stringify(geminiDocument))
  const updatedGeminiBytes = readFileSync(geminiPath, 'utf8')
  expect(updatedGeminiBytes).toContain('geminiupdatedmarker')
  expect(updatedGeminiBytes).not.toContain('geminioriginalcontentmarker')
  await expectNoHit(vault, 'geminioriginalcontentmarker', 'gemini', 'gemini-session')
  await expectHit(vault, 'geminiupdatedmarker', 'gemini', 'gemini-session')

  updateOpenCodePart(opencodePath, 'opencodeupdatedmarker')
  await expectNoHit(vault, 'opencodeoriginalcontentmarker', 'opencode', 'opencode-fixture-session')
  await expectHit(vault, 'opencodeupdatedmarker', 'opencode', 'opencode-fixture-session')

  const sqliteReplacement = `${opencodePath}.replacement`
  copyFileSync(opencodePath, sqliteReplacement)
  updateOpenCodePart(sqliteReplacement, 'opencodeinodereplacementmarker')
  renameSync(sqliteReplacement, opencodePath)
  await expectNoHit(vault, 'opencodeupdatedmarker', 'opencode', 'opencode-fixture-session')
  await expectHit(vault, 'opencodeinodereplacementmarker', 'opencode', 'opencode-fixture-session')
}, 180_000)

test('real API holdout resets on a changed same-mtime signature and schema rebuild retains originals', async () => {
  const vault = await start()
  const listed = await vault.call<PublicListResult>('list', { host: 'local', unlimited: true })
  const gemini = requireSession(listed, 'gemini', 'gemini-session')
  const sourcePath = requireSourcePath(gemini)
  const geminiDocument = JSON.parse(readFileSync(sourcePath, 'utf8')) as {
    messages: { content: { text?: string }[] }[]
  }
  const firstPrompt = geminiDocument.messages[0]?.content[0]
  if (!firstPrompt) throw new Error('Gemini fixture did not contain a first prompt')
  firstPrompt.text = 'geminioriginalcontentmarker'
  writeFileSync(sourcePath, JSON.stringify(geminiDocument))
  const originalBytes = readFileSync(sourcePath)
  const sourceStat = statSync(sourcePath)

  await vault.call('setSearchEnabled', { enabled: true })
  await expectHit(vault, 'geminioriginalcontentmarker', 'gemini', 'gemini-session')

  const heldOutMtime = new Date(sourceStat.mtimeMs - 10_000)
  writeFileSync(sourcePath, '{ invalid json document')
  utimesSync(sourcePath, heldOutMtime, heldOutMtime)
  for (let attempt = 0; attempt < 3; attempt++) {
    await search(vault, 'geminioriginalcontentmarker', 'gemini')
  }
  const heldOut = await vault.call<PublicSearchStatus>('searchStatus', {})
  expect(heldOut.status.filesFailed).toBeGreaterThan(0)
  expect(heldOut.status.filesDue).toBe(0)

  writeFileSync(sourcePath, originalBytes.toString('utf8').replace('geminioriginalcontentmarker', 'geminiholdoutrecoveredmarker'))
  utimesSync(sourcePath, heldOutMtime, heldOutMtime)
  await expectNoHit(vault, 'geminioriginalcontentmarker', 'gemini', 'gemini-session')
  await expectHit(vault, 'geminiholdoutrecoveredmarker', 'gemini', 'gemini-session')
  expect((await vault.call<PublicSearchStatus>('searchStatus', {})).status.filesFailed).toBe(0)

  await vault.call('setSearchEnabled', { enabled: false })
  const indexPath = join(vault.home, 'plugin-data', 'quirky.vault', 'session-search.sqlite')
  const index = new Database(indexPath)
  try {
    index.exec('PRAGMA user_version = 999')
  } finally {
    index.close()
  }
  await vault.call('setSearchEnabled', { enabled: true })
  await expectHit(vault, 'geminiholdoutrecoveredmarker', 'gemini', 'gemini-session')
  expect(readFileSync(sourcePath, 'utf8')).toContain('geminiholdoutrecoveredmarker')
  expect((await vault.call<PublicSearchStatus>('searchStatus', {})).status.filesIndexed).toBeGreaterThan(0)
}, 180_000)

test('real API preserves healthy answers through unavailable roots and removes only proven missing files', async () => {
  const vault = await start()
  const missingId = 'worker-parity-missing'
  const healthyId = 'worker-parity-healthy'
  const retainedId = 'worker-parity-root-retained'
  const missingPath = await writeJsonlFixture(vault.sourceHome, 'claude', missingId, [
    claudeUser(missingId, vault.sourceHome, 'knownmissingmarker')
  ])
  await writeJsonlFixture(vault.sourceHome, 'claude', healthyId, [
    claudeUser(healthyId, vault.sourceHome, 'healthyrootmarker')
  ])
  const retainedPath = await writeJsonlFixture(vault.sourceHome, 'claude', retainedId, [
    claudeUser(retainedId, vault.sourceHome, 'unavailablerootmarker')
  ])
  await vault.call('setSearchEnabled', { enabled: true })
  await expectHit(vault, 'knownmissingmarker', 'claude', missingId)
  await expectHit(vault, 'healthyrootmarker', 'claude', healthyId)
  await expectHit(vault, 'unavailablerootmarker', 'claude', retainedId)

  rmSync(missingPath)
  const staleAvailability = results(await vault.call<SearchResponse>('search', {
    query: 'knownmissingmarker', filters: { agents: ['claude'] }
  }))
  expect(staleAvailability.hits.find((hit) => hit.sessionId === missingId)?.source.presence).toBe('missing')
  await expectNoHit(vault, 'knownmissingmarker', 'claude', missingId)

  const rootPath = join(vault.sourceHome, '.claude', 'projects')
  const movedRoot = `${rootPath}.temporarily-unavailable`
  renameSync(rootPath, movedRoot)
  try {
    const retained = await expectHit(vault, 'unavailablerootmarker', 'claude', retainedId)
    expect(retained.hits.find((hit) => hit.sessionId === retainedId)?.source.presence).toBe('unverifiable')
    const gemini = await expectHit(vault, 'vault-fixture-gemini-marker', 'gemini', 'gemini-session')
    expect(gemini.hits.some((hit) => hit.sessionId === 'gemini-session')).toBe(true)
    const status = await vault.call<PublicSearchStatus>('searchStatus', {})
    expect(status.status.degradedRoots.some((root) => root.root === rootPath)).toBe(true)
  } finally {
    renameSync(movedRoot, rootPath)
  }
  expect(existsSync(retainedPath)).toBe(true)
}, 180_000)

test('Claude and OMP child IDs resolve directly after Worker restart and reject an outside symlink swap', async () => {
  const vault = await start()
  const claudeParentId = 'worker-parity-claude-parent'
  const ompParentId = 'worker-parity-omp-parent'
  const claudeChildId = 'agent-worker-parity-claude-child'
  const ompChildId = 'worker-parity-omp-child'
  const claudeParentPath = await writeJsonlFixture(vault.sourceHome, 'claude', claudeParentId, [
    claudeUser(claudeParentId, vault.sourceHome, 'Claude parent prompt')
  ])
  const claudeChildPath = join(dirname(claudeParentPath), claudeParentId, 'subagents', `${claudeChildId}.jsonl`)
  mkdirSync(dirname(claudeChildPath), { recursive: true })
  writeFileSync(claudeChildPath, `${JSON.stringify(claudeUser('claude-child-provider-id', vault.sourceHome, 'Claude child prompt'))}\n`)

  const ompParentPath = await writeJsonlFixture(vault.sourceHome, 'omp', ompParentId, [
    { type: 'session', version: 3, id: ompParentId, title: 'OMP parity parent', timestamp: '2026-10-01T10:00:00.000Z', cwd: vault.sourceHome },
    { type: 'message', timestamp: '2026-10-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OMP parent prompt' }] } }
  ])
  const ompChildPath = join(dirname(ompParentPath), ompParentId, `${ompChildId}.jsonl`)
  mkdirSync(dirname(ompChildPath), { recursive: true })
  writeFileSync(ompChildPath, [
    JSON.stringify({ type: 'session', version: 3, id: 'omp-child-provider-id', title: 'OMP parity child', timestamp: '2026-10-01T10:00:02.000Z', cwd: vault.sourceHome }),
    JSON.stringify({ type: 'message', timestamp: '2026-10-01T10:00:03.000Z', message: { role: 'user', content: [{ type: 'text', text: 'OMP child prompt' }] } })
  ].join('\n') + '\n')

  const fakeProvider = join(vault.home, 'vault-parity-fake-provider')
  writeFileSync(fakeProvider, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  for (const agent of ['claude', 'omp']) {
    await vault.client.callAny('quirky.agents/configure', { agent, command: fakeProvider, args: '--vault-parity', env: {} })
  }

  const listed = await vault.call<PublicListResult>('list', { host: 'local', agents: ['claude', 'omp'], unlimited: true })
  const claudeParent = requireSession(listed, 'claude', claudeParentId)
  const ompParent = requireSession(listed, 'omp', ompParentId)
  const claudeChild = (await vault.call<HostedSession[]>('subagents', { id: claudeParent.id })).find((session) => session.subagent)
  const ompChild = (await vault.call<HostedSession[]>('subagents', { id: ompParent.id })).find((session) => session.subagent)
  if (!claudeChild || !ompChild) throw new Error('both source layouts must list their owned children')
  expect(claudeChild.source.filePath).toBe(claudeChildPath)
  expect(ompChild.source.filePath).toBe(ompChildPath)

  await vault.client.callAny('plugin.disable', { id: 'quirky.vault' })
  await vault.client.callAny('plugin.enable', { id: 'quirky.vault' })

  for (const [child, expectedPrompt] of [[claudeChild, 'Claude child prompt'], [ompChild, 'OMP child prompt']] as const) {
    const metadata = await vault.call<HostedSession | null>('get', { id: child.id })
    expect(metadata?.sourceId).toBe(child.sourceId)
    const prompt = await vault.call<{ prompt: string | null }>('firstPrompt', { id: child.id })
    expect(prompt.prompt).toBe(expectedPrompt)
    const prepared = await vault.call<{ command: string }>('prepareResume', { id: child.id })
    expect(prepared.command).toContain(fakeProvider)
    if (child.agent === 'claude') expect(prepared.command).toContain(child.sessionId)
    else expect(prepared.command).toContain(child.source.filePath!)
  }

  for (const child of [claudeChild, ompChild]) {
    const childPath = child.source.filePath!
    const backupPath = `${childPath}.owned-backup`
    const outsidePath = join(vault.home, `${child.agent}-outside-child.jsonl`)
    writeFileSync(outsidePath, `${JSON.stringify(claudeUser('outside-child', vault.sourceHome, 'outside sentinel'))}\n`)
    renameSync(childPath, backupPath)
    symlinkSync(outsidePath, childPath)
    try {
      expect(await vault.call<HostedSession | null>('get', { id: child.id })).toBeNull()
      await expect(vault.client.callAny('quirky.vault/prepareResume', { id: child.id })).rejects.toBeDefined()
      expect(readFileSync(outsidePath, 'utf8')).toContain('outside sentinel')
    } finally {
      unlinkSync(childPath)
      renameSync(backupPath, childPath)
    }
  }
}, 180_000)
