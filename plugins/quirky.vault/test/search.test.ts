import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HISTORY_AGENTS } from '../src/agents'
import { createSearch } from '../src/search/index'
import type { Discovery, SearchResponse, SearchResults, SearchStatus, SourceCandidate, VaultMessage, VaultScanner, VaultSearch, VaultSession } from '../src/types'

/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions: the above copyright
 * notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

type FixtureMessage = Omit<VaultMessage, 'timestamp'> & { timestamp?: number | null }

type FixtureInput = {
  id: string
  title?: string
  cwd?: string | null
  agent?: string
  messages: FixtureMessage[]
  updatedAt?: number
  createdAt?: number
  sidecarTitle?: string
}

type Fixture = {
  home: string
  sources: string
  dataDir: string
  controls: { rootPresence: 'present' | 'missing' | 'unverifiable'; failures: Set<string>; parseCount: number }
  scanner: VaultScanner
  search: VaultSearch
}
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.search.close()
    rmSync(item.home, { recursive: true, force: true })
  }
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'quirky-vault-search-'))
  const sources = join(home, 'sources')
  const dataDir = join(home, 'plugin-data')
  mkdirSync(sources, { recursive: true })
  const controls = { rootPresence: 'present' as 'present' | 'missing' | 'unverifiable', failures: new Set<string>(), parseCount: 0 }
  const scanner: VaultScanner = {
    async discover(): Promise<Discovery> {
      if (controls.rootPresence !== 'present') {
        return {
          candidates: [],
          roots: [{ agent: 'claude', path: sources, presence: controls.rootPresence, reason: 'fixture root unavailable' }],
          issues: []
        }
      }
      const candidates: SourceCandidate[] = readdirSync(sources)
        .filter(name => name.endsWith('.jsonl'))
        .sort()
        .map(name => {
          const filePath = join(sources, name)
          const stat = statSync(filePath)
          const raw = readFileSync(filePath, 'utf8')
          const header = JSON.parse(raw.split('\n', 1)[0]!) as { id: string; agent?: string }
          const sidecarPath = filePath.replace(/\.jsonl$/, '.title')
          const sidecars = readFileIfPresent(sidecarPath)
          const signature = createHash('sha256').update(raw).update(sidecars ?? '').digest('hex')
          return {
            agent: header.agent ?? 'claude', filePath, root: sources, signature,
            mtimeMs: stat.mtimeMs, size: stat.size, codexHome: null, sessionId: header.id,
            ...(sidecars === null ? {} : { sidecars: [sidecarPath] })
          }
        })
      return { candidates, roots: [{ agent: 'claude', path: sources, presence: 'present' }], issues: [] }
    },
    async parse(candidate, onMessage): Promise<VaultSession | null> {
      controls.parseCount += 1
      if (controls.failures.has(candidate.filePath)) throw new Error('fixture parse failure')
      const lines = readFileSync(candidate.filePath, 'utf8').split('\n').filter(Boolean)
      const header = JSON.parse(lines[0]!) as { id: string; title?: string; cwd?: string | null; agent?: string; createdAt?: number; updatedAt?: number }
      const sidecarTitle = readFileIfPresent(candidate.filePath.replace(/\.jsonl$/, '.title'))
      const messages = lines.slice(1).map(line => JSON.parse(line) as VaultMessage)
      for (const message of messages) onMessage?.(message)
      const now = Date.now()
      return {
        id: header.id, agent: header.agent ?? 'claude', sessionId: header.id,
        title: sidecarTitle ?? header.title ?? header.id, cwd: header.cwd ?? null, branch: null, model: null,
        filePath: candidate.filePath, codexHome: null, createdAt: header.createdAt ?? now,
        updatedAt: header.updatedAt ?? now, modifiedAt: candidate.mtimeMs,
        messageCount: messages.length, totalTokens: null, previewMessages: [],
        queuedMessageCount: 0, subagentTranscriptCount: 0, presence: 'present'
      }
    },
    async list() { return { sessions: [], issues: [], scannedFiles: 0, scannedAt: Date.now(), hasMore: false, total: 0 } },
    async get() { return null },
    async firstPrompt() { return null },
    async subagents() { return [] },
    async deleteTargets() { return [] },
    invalidate() {},
    close() {}
  }
  const search = createSearch({ dataDir, scanner })
  const item = { home, sources, dataDir, controls, scanner, search }
  fixtures.push(item)
  return item
}

function readFileIfPresent(path: string): string | null {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function writeSession(root: string, input: FixtureInput): string {
  const filePath = join(root, `${input.id}.jsonl`)
  const now = Date.now()
  const header = {
    id: input.id, agent: input.agent ?? 'claude', title: input.title ?? input.id,
    cwd: input.cwd ?? '/work/example', createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now
  }
  const messages = input.messages.map(message => ({ ...message, timestamp: message.timestamp ?? null }))
  writeFileSync(filePath, [JSON.stringify(header), ...messages.map(message => JSON.stringify(message))].join('\n') + '\n')
  const titlePath = filePath.replace(/\.jsonl$/, '.title')
  if (input.sidecarTitle === undefined) rmSync(titlePath, { force: true })
  else writeFileSync(titlePath, input.sidecarTitle)
  return filePath
}

async function enableAndIndex(item: Fixture, historyDays: number | null = null) {
  await item.search.apply({ enabled: true, historyDays })
  await item.search.reconcile({ full: true })
}

function isResults(value: SearchResponse): SearchResults {
  expect(value.kind).toBe('results')
  if (value.kind !== 'results') throw new Error(`expected results, got ${value.kind}`)
  return value
}

test('search off stays DB-free and returns the exact disabled envelope', async () => {
  const item = fixture()
  writeSession(item.sources, { id: 'private', messages: [{ role: 'user', text: 'secretmarker' }] })

  expect(item.search.status().enabled).toBe(false)
  expect(await item.search.search({ query: 'secretmarker' })).toEqual({ kind: 'unavailable', reason: 'disabled' })
  expect(readdirSync(item.home)).toEqual(['sources'])
  expect(await item.search.search({ query: 'secretmarker', freshness: 'wait-until-current' })).toEqual({ kind: 'unavailable', reason: 'disabled' })
  expect(readdirSync(item.home)).toEqual(['sources'])
})

test('real Bun FTS indexes conversation chunks but caps tool output and scopes roles', async () => {
  const item = fixture()
  const longText = `${'ordinary '.repeat(1000)} tailconversationmarker`
  writeSession(item.sources, {
    id: 'role-cap', messages: [
      { role: 'user', text: longText },
      { role: 'assistant', text: 'assistantreplymarker', timestamp: 20 },
      { role: 'tool', text: `${'x'.repeat(3072)} tooltailmarker`, timestamp: 30 },
      { role: 'system', text: 'systemonlymarker', timestamp: 40 }
    ]
  })
  await enableAndIndex(item)

  expect(isResults(await item.search.search({ query: 'tailconversationmarker' })).hits.map(hit => hit.sessionId)).toEqual(['role-cap'])
  expect(isResults(await item.search.search({ query: 'assistantreplymarker', scope: 'conversation' })).hits[0]?.evidence?.role).toBe('assistant')
  expect(isResults(await item.search.search({ query: 'tooltailmarker' })).hits).toHaveLength(0)
  expect(isResults(await item.search.search({ query: 'systemonlymarker' })).hits).toHaveLength(0)
  expect(isResults(await item.search.search({ query: 'assistantreplymarker', scope: 'conversation' })).hits[0]?.evidence?.timestamp).toBe(20)
})

test('phrase ladder repairs scoped typos, rejects raw FTS syntax, and uses safe rowid subselect snippets', async () => {
  const item = fixture()
  writeSession(item.sources, { id: 'a', cwd: '/work/alpha', updatedAt: 300, messages: [{ role: 'user', text: 'terminal fix phrase marker' }] })
  writeSession(item.sources, { id: 'b', cwd: '/work/beta', updatedAt: 200, messages: [{ role: 'assistant', text: 'terminal tool path' }] })
  writeSession(item.sources, { id: 'c', cwd: '/work/alpha', updatedAt: 100, messages: [{ role: 'tool', text: 'other searchable body' }] })
  await enableAndIndex(item)

  const phrase = isResults(await item.search.search({ query: '"terminal fix"' }))
  expect(phrase.hits.map(hit => hit.sessionId)).toEqual(['a'])
  expect(phrase.hits[0]?.evidence?.snippet).toContain('[[terminal fix]]')
  const byMessage = isResults(await item.search.search({ query: 'terminal', limit: 20 }))
  expect(byMessage.hits.find(hit => hit.sessionId === 'a')?.evidence?.snippet).toContain('phrase marker')
  expect(byMessage.hits.find(hit => hit.sessionId === 'b')?.evidence?.snippet).toContain('tool path')
  const repaired = isResults(await item.search.search({ query: 'terminl' }))
  expect(repaired.hits.map(hit => hit.sessionId)).toEqual(['a', 'b'])
  expect(repaired.repairedTerms).toEqual({ terminl: 'terminal' })
  expect(isResults(await item.search.search({ query: 'repo:alpha' })).hits.map(hit => hit.sessionId)).toEqual(['a', 'c'])
  expect(isResults(await item.search.search({ query: 'foo OR bar' })).hits).toEqual([])
  expect(isResults(await item.search.search({ query: '"unterminated FTS (' })).hits).toEqual([])
  expect(isResults(await item.search.search({ query: 'path:beta repo:beta' })).hits.map(hit => hit.sessionId)).toEqual(['b'])
  const filtered = isResults(await item.search.search({
    query: 'terminal',
    filters: { agents: ['claude'], scopePaths: ['/work/beta'], since: '1970-01-01T00:00:00Z', sort: 'newest' }
  }))
  expect(filtered.hits.map(hit => hit.sessionId)).toEqual(['b'])
  expect(isResults(await item.search.search({ query: 'terminal', filters: { agents: [] } })).hits).toEqual([])
})

test('literal transcript marks and escape-looking sequences cannot forge evidence delimiters', async () => {
  const item = fixture()
  writeSession(item.sources, {
    id: 'brackets', messages: [{ role: 'user', text: 'needlemarker [[spoofed]] \uE0020 \uE0021 \uE0022' }]
  })
  await enableAndIndex(item)

  const hit = isResults(await item.search.search({ query: 'needlemarker' })).hits[0]!
  expect(hit.evidence?.snippet).toContain('[[needlemarker]]')
  expect(hit.evidence?.snippet).not.toContain('[[spoofed]]')
  expect(hit.evidence?.snippet).toContain('\uE0020spoofed\uE0021')
  expect(hit.evidence?.snippet).toContain('\uE00220 \uE00221 \uE00222')
})

test('forks collapse only after two matching opening messages and pages bind generation and incarnation', async () => {
  const item = fixture()
  const sharedPrefix: FixtureMessage[] = [
    { role: 'user', text: 'needlemarker shared opening prompt' },
    { role: 'assistant', text: 'shared opening answer' },
    { role: 'user', text: 'shared third turn' },
    { role: 'assistant', text: 'shared fourth turn' },
    { role: 'user', text: 'shared fifth turn' },
    { role: 'assistant', text: 'shared sixth turn' },
    { role: 'user', text: 'shared seventh turn' },
    { role: 'assistant', text: 'shared eighth turn' }
  ]
  writeSession(item.sources, { id: 'fork-old', updatedAt: 100, messages: [...sharedPrefix, { role: 'user', text: 'fork-old ending' }] })
  writeSession(item.sources, { id: 'fork-new', updatedAt: 200, messages: [...sharedPrefix, { role: 'user', text: 'fork-new ending' }] })
  writeSession(item.sources, { id: 'one-turn', updatedAt: 300, messages: [sharedPrefix[0]!] })
  writeSession(item.sources, {
    id: 'fork-divergent', updatedAt: 350,
    messages: [...sharedPrefix.slice(0, 2), { role: 'user', text: 'needlemarker divergent third turn' }]
  })
  writeSession(item.sources, { id: 'fourth', updatedAt: 400, messages: [{ role: 'user', text: 'needlemarker distinct' }] })
  await enableAndIndex(item)

  const firstPage = isResults(await item.search.search({ query: 'needlemarker', limit: 1, filters: { sort: 'newest' } }))
  expect(firstPage.page.hasMore).toBe(true)
  const secondPage = isResults(await item.search.search({ query: 'needlemarker', limit: 1, filters: { sort: 'newest' }, cursor: firstPage.page.cursor! }))
  expect(secondPage.hits[0]?.sessionId).not.toBe(firstPage.hits[0]?.sessionId)
  const all = isResults(await item.search.search({ query: 'needlemarker', limit: 20 }))
  const forkHit = all.hits.find(hit => hit.sessionId === 'fork-new')
  expect(forkHit?.duplicateCount).toBe(2)
  expect(all.hits.some(hit => hit.sessionId === 'fork-old')).toBe(false)
  expect(all.hits.find(hit => hit.sessionId === 'one-turn')?.duplicateCount).toBe(1)
  expect(all.hits.find(hit => hit.sessionId === 'fork-divergent')?.duplicateCount).toBe(1)

  const priorCursor = firstPage.page.cursor!
  writeSession(item.sources, { id: 'late', updatedAt: 500, messages: [{ role: 'user', text: 'needlemarker new source' }] })
  await item.search.reconcile({ full: true })
  expect(await item.search.search({ query: 'needlemarker', limit: 1, filters: { sort: 'newest' }, cursor: priorCursor })).toEqual({ kind: 'stale-cursor' })
  expect(await item.search.search({ query: 'needlemarker', cursor: 'not-a-cursor' })).toEqual({ kind: 'malformed-cursor' })
  expect(await item.search.search({ query: 'other', cursor: priorCursor })).toEqual({ kind: 'stale-cursor' })
})

test('changed source and sidecar replace normalized rows; retention purges only the derived copy', async () => {
  const item = fixture()
  const filePath = writeSession(item.sources, { id: 'mutable', title: 'old title', sidecarTitle: 'old sidecar', messages: [{ role: 'user', text: 'oldsourceword' }] })
  await enableAndIndex(item)
  expect(isResults(await item.search.search({ query: 'oldsourceword' })).hits[0]?.title).toBe('old sidecar')

  writeFileSync(filePath.replace(/\.jsonl$/, '.title'), 'new sidecar')
  writeSession(item.sources, { id: 'mutable', title: 'new title', sidecarTitle: 'new sidecar', messages: [{ role: 'user', text: 'newsourceword' }] })
  await item.search.reconcile({ full: true })
  expect(isResults(await item.search.search({ query: 'oldsourceword' })).hits).toHaveLength(0)
  expect(isResults(await item.search.search({ query: 'newsourceword' })).hits[0]?.title).toBe('new sidecar')
  rmSync(filePath)
  expect(isResults(await item.search.search({ query: 'newsourceword' })).hits[0]?.source.presence).toBe('missing')

  const oldPath = writeSession(item.sources, {
    id: 'expired', createdAt: Date.now() - 5 * 86400000, updatedAt: Date.now() - 5 * 86400000,
    messages: [{ role: 'user', text: 'retentionmarker' }]
  })
  utimesSync(oldPath, new Date(Date.now() - 5 * 86400000), new Date(Date.now() - 5 * 86400000))
  await item.search.apply({ enabled: true, historyDays: 1 })
  await item.search.reconcile({ full: true })
  expect(isResults(await item.search.search({ query: 'retentionmarker' })).hits).toHaveLength(0)
  expect(readFileSync(oldPath, 'utf8')).toContain('retentionmarker')
})

test('inode replacement and shrink reindex the original source', async () => {
  const item = fixture()
  const filePath = writeSession(item.sources, { id: 'identity', messages: [{ role: 'user', text: 'oldlongmarker '.repeat(100) }] })
  await enableAndIndex(item)
  expect(isResults(await item.search.search({ query: 'oldlongmarker' })).hits).toHaveLength(1)

  const originalParseCount = item.controls.parseCount
  const replacement = `${filePath}.replacement`
  writeFileSync(replacement, readFileSync(filePath))
  renameSync(replacement, filePath)
  await item.search.reconcile({ full: true })
  expect(item.controls.parseCount).toBe(originalParseCount + 1)

  writeSession(item.sources, { id: 'identity', messages: [{ role: 'user', text: 'shortnewmarker' }] })
  await item.search.reconcile({ full: true })
  expect(isResults(await item.search.search({ query: 'oldlongmarker' })).hits).toHaveLength(0)
  expect(isResults(await item.search.search({ query: 'shortnewmarker' })).hits).toHaveLength(1)
})

test('three same-mtime failures are held out and unverifiable roots do not erase indexed results', async () => {
  const item = fixture()
  const filePath = writeSession(item.sources, { id: 'unstable', messages: [{ role: 'user', text: 'stablemarker' }] })
  await enableAndIndex(item)
  item.controls.failures.add(filePath)
  writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}\n`)
  for (let attempt = 0; attempt < 3; attempt++) await item.search.reconcile({ full: true })
  const failed = item.search.status()
  expect(failed.filesFailed).toBe(1)

  item.controls.rootPresence = 'unverifiable'
  await item.search.reconcile({ full: true })
  const result = isResults(await item.search.search({ query: 'stablemarker' }))
  expect(result.hits[0]?.source.presence).toBe('unverifiable')
  expect(item.search.status().degradedRoots).toContainEqual({ root: item.sources, reason: 'fixture root unavailable' })
})

test('unknown scopes never widen, apply serializes consent, and clear removes only closed derived files', async () => {
  const item = fixture()
  writeSession(item.sources, { id: 'scoped', messages: [{ role: 'user', text: 'scopeword' }] })
  await enableAndIndex(item)
  expect(await item.search.search({ query: 'scopeword', within: { worktree: 'missing-worktree' } })).toEqual({ kind: 'unavailable', reason: 'scope-unknown' })
  expect(await item.search.search({ query: 'scopeword', filters: { agents: ['not-a-history-agent'] } })).toEqual({ kind: 'unavailable', reason: 'unsupported-agent' })
  expect(await item.search.search({ query: 'scopeword', host: 'remote-host' })).toEqual({ kind: 'unavailable', reason: 'no-service' })

  const dbPath = join(item.dataDir, 'session-search.sqlite')
  expect(readdirSync(item.dataDir)).toContain('session-search.sqlite')
  await expect(item.search.clear()).rejects.toThrow()
  await item.search.apply({ enabled: false, historyDays: null })
  expect(await item.search.search({ query: 'scopeword' })).toEqual({ kind: 'unavailable', reason: 'disabled' })
  expect(readdirSync(item.dataDir)).toContain('session-search.sqlite')
  const inspect = new Database(dbPath, { readonly: true })
  expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'").get()).toEqual({ name: 'messages_fts' })
  expect(inspect.prepare('SELECT count(*) AS rows FROM messages_fts WHERE messages_fts MATCH ?').get('"scopeword"')).toEqual({ rows: 1 })
  inspect.close()
  await item.search.clear()
  expect(readdirSync(item.dataDir)).toEqual([])
})

test('freshness waits are bounded, status reports real counts, and source IDs stay deterministic', async () => {
  const item = fixture()
  writeSession(item.sources, { id: 'one', agent: 'claude', messages: [{ role: 'user', text: 'freshmarker' }] })
  await enableAndIndex(item)
  const status: SearchStatus = item.search.status()
  expect(status.enabled).toBe(true)
  expect(status.filesIndexed).toBe(1)
  expect(status.messagesIndexed).toBeGreaterThan(0)
  expect(status.sessionsByAgent.claude).toBe(1)
  expect(status.supportedAgents).toEqual([...HISTORY_AGENTS])
  const result = isResults(await item.search.search({ query: 'freshmarker', freshness: 'wait-until-current' }))
  expect(result.hits[0]?.id).toBe('one')
  expect(result.truncated.freshness).toBe(false)
  const capped = isResults(await item.search.search({ query: `freshmarker ${'padding '.repeat(100)}` }))
  expect(capped.hits.map(hit => hit.sessionId)).toEqual(['one'])
  expect(capped.truncated.query).toBe(true)
})
