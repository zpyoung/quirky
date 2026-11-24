import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  LedgerActor,
  LedgerEntryType,
  LedgerImportRecord,
  LedgerMutationContext,
  LedgerRecord,
  LedgerRuntimeIdentity
} from '../../shared/ledger'
import { parseLedgerImportSources } from './ledger-import-parser'
import { createLedgerResponse } from './ledger-store-response'
import { reconcileLedgerImports } from './ledger-store-import'
import { LedgerStore } from './ledger-store'

const runtime: LedgerRuntimeIdentity = { runtimeId: 'local', profileId: 'default' }
const owner = { tier: 'project' as const, id: 'project-a' }
const actor: LedgerActor = { kind: 'agent', model: null, providerSessionId: null, tool: 'codex' }
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'quirky-ledger-import-'))
  temporaryDirectories.push(directory)
  return directory
}

function emptyRecord(): LedgerRecord {
  return {
    ledgerId: 'ledger-1',
    tier: 'project',
    revision: 0,
    owner,
    formerOwner: null,
    runtime,
    entryCount: 0,
    nextSequence: 1,
    staleAfterDays: 90,
    sourceEquivalences: [],
    entries: [],
    importAnchors: {},
    metadataHistory: []
  }
}

function importRecord(
  type: LedgerEntryType,
  legacyId: string,
  content: Record<string, unknown>
): LedgerImportRecord {
  const sourcePath =
    type === 'bug' ? 'BUGS.md' : type === 'test-gap' ? 'TEST_BACKLOG.md' : 'DEFERRED.md'
  return {
    anchor: JSON.stringify(['project', owner.id, null, sourcePath, legacyId]),
    type,
    content,
    sourcePath,
    sourceBase: { kind: 'project', id: owner.id },
    legacyId
  }
}

const context = (records: LedgerImportRecord[]): LedgerMutationContext => ({
  channel: 'cli',
  actor,
  owner,
  importRecords: records
})

describe('ledger store import', () => {
  it('persists legacy fields and anchors and recognizes them after reload', () => {
    const base = { kind: 'project' as const, id: owner.id }
    const parsed = parseLedgerImportSources(
      [
        {
          path: 'BUGS.md',
          content: [
            '## BUG-21: Bold labels',
            '- **Title**: Bold labels',
            '- **File**: src/import.ts:21',
            '- **Description**: Parse labels whose colon follows the bold text',
            '- **Severity**: HIGH'
          ].join('\n')
        },
        {
          path: 'TEST_BACKLOG.md',
          content: [
            '## TEST-32: Import history',
            'Title: Import history',
            'File under test: src/import.ts:32',
            'Reason skipped: Waiting for the importer fix',
            'Priority:P3'
          ].join('\n')
        },
        {
          path: 'DEFERRED.md',
          content: [
            '## DEF-32: Deferred import',
            'Title: Deferred import',
            'Why deferred: Depends on the importer fix',
            'Priority:LOW',
            'Status:RESOLVED'
          ].join('\n')
        }
      ],
      base
    )

    expect(parsed.skipped).toEqual([])

    const directory = temporaryDirectory()
    const firstStore = new LedgerStore({ directory, runtime })
    const first = firstStore.executeQueued({ operation: 'import' }, context(parsed.records))
    expect(first.importResult).toEqual({
      created: ['bug-1', 'test-gap-2', 'deferred-3'],
      updated: [],
      alreadyPresent: [],
      skipped: []
    })

    if (!first.ledger) {
      throw new Error('Expected the imported ledger')
    }
    const ledgerId = first.ledger.ledgerId
    const reloadedStore = new LedgerStore({ directory, runtime })
    const reloaded = reloadedStore.getLedger(ledgerId)
    if (!reloaded) {
      throw new Error('Expected the imported ledger to reload')
    }
    expect(reloaded.entries.map((entry) => ({ id: entry.id, content: entry.content }))).toEqual([
      { id: 'bug-1', content: parsed.records[0].content },
      { id: 'test-gap-2', content: parsed.records[1].content },
      { id: 'deferred-3', content: parsed.records[2].content }
    ])
    expect(reloaded.entries[1].history[0].after?.content.priority).toBe('p3')
    expect(reloaded.entries[2].history[0].after?.content.status).toBe('resolved')
    expect(
      parsed.records.map((record) => {
        const anchor = reloaded.importAnchors[record.anchor]
        return { entryId: anchor?.entryId, legacyId: anchor?.legacyId }
      })
    ).toEqual([
      { entryId: 'bug-1', legacyId: 'BUG-21' },
      { entryId: 'test-gap-2', legacyId: 'TEST-32' },
      { entryId: 'deferred-3', legacyId: 'DEF-32' }
    ])

    const second = reloadedStore.executeQueued({ operation: 'import' }, context(parsed.records))
    expect(second.importResult).toEqual({
      created: [],
      updated: [],
      alreadyPresent: ['bug-1', 'test-gap-2', 'deferred-3'],
      skipped: []
    })
    const afterReimport = new LedgerStore({ directory, runtime }).getLedger(ledgerId)
    if (!afterReimport) {
      throw new Error('Expected the reimported ledger to reload')
    }
    expect(afterReimport.entries.map((entry) => entry.id)).toEqual([
      'bug-1',
      'test-gap-2',
      'deferred-3'
    ])
    expect(
      parsed.records.map((record) => afterReimport.importAnchors[record.anchor].legacyId)
    ).toEqual(['BUG-21', 'TEST-32', 'DEF-32'])
  })

  it('continues after a pre-commit failure and retries only the failed row', () => {
    const records = [
      importRecord('bug', 'BUG-1', {
        title: 'First',
        file: { path: 'src/first.ts', base: { kind: 'project', id: owner.id } },
        description: 'First record',
        severity: 'medium'
      }),
      importRecord('test-gap', 'TEST-2', {
        title: 'Fails once',
        file_under_test: { path: 'src/second.ts', base: { kind: 'project', id: owner.id } },
        reason_skipped: 'Commit failure'
      }),
      importRecord('deferred', 'DEF-3', {
        title: 'Still runs',
        why_deferred: 'After the failed row',
        priority: 'low'
      })
    ]
    let durable = emptyRecord()
    let failBeforeCommit = true
    const dependencies = {
      now: () => '2026-09-14T00:00:00.000Z',
      commit: (next: LedgerRecord): void => {
        if (failBeforeCommit && Object.hasOwn(next.importAnchors, records[1].anchor)) {
          failBeforeCommit = false
          throw new Error('injected pre-commit failure')
        }
        next.entryCount = next.entries.length
        durable = structuredClone(next)
      },
      response: (record: LedgerRecord | null, extra: Parameters<typeof createLedgerResponse>[2]) =>
        createLedgerResponse(record, runtime, extra),
      hasRecord: (ledgerId: string) => ledgerId === durable.ledgerId
    }

    const first = reconcileLedgerImports(durable, context(records), dependencies)
    expect(first.importResult).toEqual({
      created: ['bug-1', 'deferred-2'],
      updated: [],
      alreadyPresent: [],
      skipped: [
        {
          anchor: records[1].anchor,
          sourcePath: records[1].sourcePath,
          reason: expect.stringContaining('Error: injected pre-commit failure')
        }
      ]
    })
    expect(durable.entries.map((entry) => entry.id)).toEqual(['bug-1', 'deferred-2'])
    expect(durable.importAnchors[records[1].anchor]).toBeUndefined()

    const retry = reconcileLedgerImports(durable, context(records), dependencies)
    expect(retry.importResult).toEqual({
      created: ['test-gap-3'],
      updated: [],
      alreadyPresent: ['bug-1', 'deferred-2'],
      skipped: []
    })
    expect(durable.entries.map((entry) => entry.id)).toEqual(['bug-1', 'deferred-2', 'test-gap-3'])
    expect(Object.keys(durable.importAnchors).sort()).toEqual(
      records.map((record) => record.anchor).sort()
    )
  })
})
