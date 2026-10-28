import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSearch } from '../src/search/index'
import type { Discovery, SearchResponse, SearchResults, SourceCandidate, VaultMessage, VaultScanner, VaultSearch, VaultSession } from '../src/types'

type Fixture = {
  home: string
  sources: string
  movedSources: string
  controls: { rootPresence: 'present' | 'missing' | 'unverifiable' }
  search: VaultSearch
}
const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.search.close()
    rmSync(fixture.home, { recursive: true, force: true })
  }
})

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'quirky-vault-source-availability-'))
  const sources = join(home, 'sources')
  const movedSources = join(home, 'moved-sources')
  mkdirSync(sources, { recursive: true })
  const controls = { rootPresence: 'present' as Fixture['controls']['rootPresence'] }
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
        .map(name => {
          const filePath = join(sources, name)
          const stat = lstatSync(filePath)
          const raw = readFileSync(filePath, 'utf8')
          const input = JSON.parse(raw) as { id: string }
          return {
            agent: 'claude', filePath, root: sources,
            signature: createHash('sha256').update(raw).digest('hex'),
            mtimeMs: stat.mtimeMs, size: stat.size, codexHome: null, sessionId: input.id
          }
        })
      return { candidates, roots: [{ agent: 'claude', path: sources, presence: 'present' }], issues: [] }
    },
    async parse(candidate: SourceCandidate, onMessage): Promise<VaultSession | null> {
      const input = JSON.parse(readFileSync(candidate.filePath, 'utf8')) as { id: string; text: string }
      const message: VaultMessage = { role: 'user', text: input.text, timestamp: null }
      onMessage?.(message)
      const now = Date.now()
      return {
        id: input.id, agent: 'claude', sessionId: input.id, title: input.id, cwd: null,
        branch: null, model: null, filePath: candidate.filePath, codexHome: null,
        createdAt: now, updatedAt: now, modifiedAt: candidate.mtimeMs,
        messageCount: 1, totalTokens: null, previewMessages: [], queuedMessageCount: 0,
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
  const item: Fixture = {
    home, sources, movedSources, controls,
    search: createSearch({ dataDir: join(home, 'plugin-data'), scanner })
  }
  fixtures.push(item)
  return item
}

function writeSession(root: string, id: string, text: string): string {
  const path = join(root, `${id}.jsonl`)
  writeFileSync(path, JSON.stringify({ id, text }) + '\n')
  return path
}

async function enableAndIndex(item: Fixture): Promise<void> {
  await item.search.apply({ enabled: true, historyDays: null })
  await item.search.reconcile({ full: true })
}

function results(response: SearchResponse): SearchResults {
  expect(response.kind).toBe('results')
  if (response.kind !== 'results') throw new Error(`expected results, got ${response.kind}`)
  return response
}

test('a moved unavailable root retains indexed hits as unverifiable', async () => {
  const item = fixture()
  writeSession(item.sources, 'retained-root', 'rootavailabilitymarker')
  await enableAndIndex(item)

  renameSync(item.sources, item.movedSources)
  item.controls.rootPresence = 'missing'
  await item.search.reconcile({ full: true })

  const result = results(await item.search.search({ query: 'rootavailabilitymarker' }))
  expect(result.hits.map(hit => hit.sessionId)).toContain('retained-root')
  expect(result.hits.find(hit => hit.sessionId === 'retained-root')?.source.presence).toBe('unverifiable')
  expect(item.search.status().filesIndexed).toBe(1)
})

test('a missing file in a healthy root is reported missing and purged', async () => {
  const item = fixture()
  const missingPath = writeSession(item.sources, 'gone-source', 'missingfilemarker')
  writeSession(item.sources, 'healthy-source', 'healthyrootmarker')
  await enableAndIndex(item)

  rmSync(missingPath)
  const beforeReconcile = results(await item.search.search({ query: 'missingfilemarker' }))
  expect(beforeReconcile.hits[0]?.source.presence).toBe('missing')

  await item.search.reconcile({ full: true })
  expect(results(await item.search.search({ query: 'missingfilemarker' })).hits).toHaveLength(0)
  expect(item.search.status().filesIndexed).toBe(1)
})
