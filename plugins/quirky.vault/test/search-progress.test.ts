import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSearch } from '../src/search/index'
import type { Discovery, SearchResponse, SearchResults, SourceCandidate, VaultMessage, VaultScanner, VaultSearch, VaultSession } from '../src/types'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void }
type PendingRead = {
  started: Deferred<void>
  released: Deferred<void>
  abortCount: number
  completed: boolean
  wasReleased: boolean
}
type Fixture = {
  home: string
  sources: string
  dataDir: string
  sourceFile: string
  controls: { nextRead: PendingRead | null }
  search: VaultSearch
}

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const item of fixtures.splice(0)) {
    await item.search.close()
    rmSync(item.home, { recursive: true, force: true })
  }
})


function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'quirky-vault-search-progress-'))
  const sources = join(home, 'sources')
  const dataDir = join(home, 'plugin-data')
  const sourceFile = join(sources, 'progress-session.jsonl')
  mkdirSync(sources, { recursive: true })
  const controls = { nextRead: null as PendingRead | null }
  const scanner: VaultScanner = {
    async discover(): Promise<Discovery> {
      const raw = readFileSync(sourceFile, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const header = JSON.parse(lines[0]!) as { id: string }
      const stat = statSync(sourceFile)
      const candidate: SourceCandidate = {
        agent: 'claude', filePath: sourceFile, root: sources,
        signature: createHash('sha256').update(raw).digest('hex'),
        mtimeMs: stat.mtimeMs, size: stat.size, codexHome: null, sessionId: header.id
      }
      return { candidates: [candidate], roots: [{ agent: 'claude', path: sources, presence: 'present' }], issues: [] }
    },
    async parse(candidate, onMessage, signal): Promise<VaultSession | null> {
      const raw = readFileSync(candidate.filePath, 'utf8')
      const lines = raw.split('\n').filter(Boolean)
      const header = JSON.parse(lines[0]!) as { id: string; title: string; cwd: string; createdAt: number; updatedAt: number }
      const messages = lines.slice(1).map(line => JSON.parse(line) as VaultMessage)
      for (const message of messages) onMessage?.(message)

      const pending = controls.nextRead
      if (pending) {
        controls.nextRead = null
        pending.started.resolve(undefined)
        await waitForRead(pending, signal)
        pending.completed = true
      }

      return {
        id: header.id, agent: 'claude', sessionId: header.id, title: header.title,
        cwd: header.cwd, branch: null, model: null, filePath: candidate.filePath, codexHome: null,
        createdAt: header.createdAt, updatedAt: header.updatedAt, modifiedAt: candidate.mtimeMs,
        messageCount: messages.length, totalTokens: null, previewMessages: [], queuedMessageCount: 0,
        subagentTranscriptCount: 0, presence: 'present'
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
  const item = { home, sources, dataDir, sourceFile, controls, search: createSearch({ dataDir, scanner }) }
  fixtures.push(item)
  return item
}

function armRead(item: Fixture): PendingRead {
  const started = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const read: PendingRead = {
    started: { promise: started.promise, resolve: started.resolve },
    released: { promise: released.promise, resolve: released.resolve },
    abortCount: 0, completed: false, wasReleased: false
  }
  item.controls.nextRead = read
  return read
}

function releaseRead(read: PendingRead): void {
  read.wasReleased = true
  read.released.resolve(undefined)
}

function waitForRead(read: PendingRead, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  const cleanup = () => signal?.removeEventListener('abort', onAbort)
  const onAbort = () => {
    if (settled) return
    settled = true
    read.abortCount += 1
    cleanup()
    reject(Object.assign(new Error('Controlled source read aborted'), { name: 'AbortError' }))
  }
  read.released.promise.then(() => {
    if (settled) return
    settled = true
    cleanup()
    resolve()
  })
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  return promise
}

function writeSession(item: Fixture, messages: VaultMessage[]): void {
  const now = Date.now()
  const header = { id: 'progress-session', title: 'Progress session', cwd: '/work/progress', createdAt: now, updatedAt: now }
  writeFileSync(item.sourceFile, [JSON.stringify(header), ...messages.map(message => JSON.stringify(message))].join('\n') + '\n')
}

async function indexInitialSession(item: Fixture): Promise<void> {
  writeSession(item, [{ role: 'user', text: 'originalonlymarker', timestamp: 1 }])
  await item.search.apply({ enabled: true, historyDays: null })
  await item.search.reconcile({ full: true })
}

function asResults(response: SearchResponse): SearchResults {
  expect(response.kind).toBe('results')
  if (response.kind !== 'results') throw new Error(`expected results, got ${response.kind}`)
  return response
}

test('fresh search returns during a gated parse without aborting it, then indexes the completed source', async () => {
  const item = fixture()
  await indexInitialSession(item)
  writeSession(item, [
    { role: 'user', text: 'newuseronlymarker', timestamp: 2 },
    { role: 'assistant', text: 'newassistantonlymarker', timestamp: 3 }
  ])

  const pendingRead = armRead(item)
  const reconcile = item.search.reconcile({ full: true })
  await pendingRead.started.promise

  const response = asResults(await item.search.search({ query: 'originalonlymarker', freshness: 'wait-until-current' }))
  expect(response.truncated.freshness).toBe(true)
  expect(response.hits).toHaveLength(1)
  expect(response.hits[0]?.id).toBe('progress-session')
  expect(pendingRead.wasReleased).toBe(false)
  expect(pendingRead.completed).toBe(false)
  expect(pendingRead.abortCount).toBe(0)

  releaseRead(pendingRead)
  await item.search.reconcile({ full: true })
  await reconcile

  const current = item.search.status()
  expect(pendingRead.completed).toBe(true)
  expect(pendingRead.abortCount).toBe(0)
  expect(current.filesIndexed).toBe(1)
  expect(current.filesDue).toBe(0)
  expect(current.messagesIndexed).toBe(2)
  expect(current.sessionsByAgent.claude).toBe(1)
  const newMessage = asResults(await item.search.search({ query: 'newassistantonlymarker' }))
  expect(newMessage.hits).toHaveLength(1)
  expect(newMessage.hits[0]?.id).toBe('progress-session')
  expect(newMessage.hits[0]?.messageCount).toBe(2)
  const oldMessage = asResults(await item.search.search({ query: 'originalonlymarker' }))
  expect(oldMessage.hits).toEqual([])
}, 30_000)

test('explicit disable and close abort pending reads while retaining the source and derived index', async () => {
  for (const action of ['disable', 'close'] as const) {
    const item = fixture()
    await indexInitialSession(item)
    writeSession(item, [{ role: 'user', text: 'pendingnewsourceonlymarker', timestamp: 4 }])

    const pendingRead = armRead(item)
    const reconcile = item.search.reconcile({ full: true })
    await pendingRead.started.promise
    if (action === 'disable') await item.search.apply({ enabled: false, historyDays: null })
    else await item.search.close()
    await reconcile

    expect(pendingRead.abortCount).toBe(1)
    expect(pendingRead.completed).toBe(false)
    expect(existsSync(item.sourceFile)).toBe(true)
    expect(readFileSync(item.sourceFile, 'utf8')).toContain('pendingnewsourceonlymarker')
    expect(await item.search.search({ query: 'originalonlymarker' })).toEqual({ kind: 'unavailable', reason: 'disabled' })

    const databasePath = join(item.dataDir, 'session-search.sqlite')
    expect(existsSync(databasePath)).toBe(true)
    const database = new Database(databasePath)
    try {
      const sessions = database.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }
      const messages = database.prepare('SELECT count(*) AS count FROM messages').get() as { count: number }
      const file = database.prepare('SELECT state FROM files WHERE path = ?').get(item.sourceFile) as { state: string } | null
      const indexedOriginal = database.prepare('SELECT count(*) AS count FROM messages_fts WHERE messages_fts MATCH ?').get('originalonlymarker') as { count: number }
      const uncommittedNew = database.prepare('SELECT count(*) AS count FROM messages_fts WHERE messages_fts MATCH ?').get('pendingnewsourceonlymarker') as { count: number }
      expect(sessions.count).toBe(1)
      expect(messages.count).toBe(1)
      expect(file?.state).toBe('due')
      expect(indexedOriginal.count).toBe(1)
      expect(uncommittedNew.count).toBe(0)
    } finally {
      database.close()
    }
  }
}, 30_000)
