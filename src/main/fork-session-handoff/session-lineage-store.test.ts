import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ForkSessionHandoffLineageRecord } from '../../shared/fork-session-handoff/session-lineage-types'
import {
  FORK_SESSION_HANDOFF_LINEAGE_CAP,
  ForkSessionHandoffLineageStore,
  getForkSessionHandoffLineageFilePath
} from './session-lineage-store'

function recordFixture(
  index = 1,
  overrides: Partial<ForkSessionHandoffLineageRecord> = {}
): ForkSessionHandoffLineageRecord {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    createdAt: index,
    relationship: 'continues',
    parent: {
      paneKey: `parent-${index}`,
      agent: 'claude',
      providerSessionId: `provider-parent-${index}`,
      transcriptPath: `/tmp/parent-${index}.jsonl`,
      worktreeId: `worktree-${index}`,
      title: `Parent ${index}`
    },
    child: {
      paneKey: null,
      agent: 'codex',
      providerSessionId: null,
      transcriptPath: null,
      worktreeId: `worktree-${index}`,
      title: null,
      tabId: `tab-${index}`
    },
    ...overrides
  }
}

describe('ForkSessionHandoffLineageStore', () => {
  let userDataPath: string

  beforeEach(async () => {
    userDataPath = await mkdtemp(path.join(os.tmpdir(), 'quirky-lineage-'))
  })

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true })
  })

  it('round-trips records through the versioned file', async () => {
    const store = new ForkSessionHandoffLineageStore(userDataPath)
    const record = recordFixture()

    await store.record(record)

    await expect(new ForkSessionHandoffLineageStore(userDataPath).list()).resolves.toEqual([record])
    const persisted = JSON.parse(
      await readFile(getForkSessionHandoffLineageFilePath(userDataPath), 'utf8')
    )
    expect(persisted).toEqual({ version: 1, records: [record] })
  })

  it('recovers corrupt and schema-invalid files as an empty collection', async () => {
    const filePath = getForkSessionHandoffLineageFilePath(userDataPath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{not json', 'utf8')
    await expect(new ForkSessionHandoffLineageStore(userDataPath).list()).resolves.toEqual([])

    await writeFile(filePath, JSON.stringify({ version: 2, records: [recordFixture()] }), 'utf8')
    await expect(new ForkSessionHandoffLineageStore(userDataPath).list()).resolves.toEqual([])

    await writeFile(
      filePath,
      JSON.stringify({ version: 1, records: [{ ...recordFixture(), relationship: 'invalid' }] }),
      'utf8'
    )
    await expect(new ForkSessionHandoffLineageStore(userDataPath).list()).resolves.toEqual([])
  })

  it('recovers a corrupt file on the next record write', async () => {
    const filePath = getForkSessionHandoffLineageFilePath(userDataPath)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, 'corrupt', 'utf8')
    const store = new ForkSessionHandoffLineageStore(userDataPath)

    await store.record(recordFixture())

    await expect(new ForkSessionHandoffLineageStore(userDataPath).list()).resolves.toEqual([
      recordFixture()
    ])
  })

  it('prunes to the newest records on load and compacts the file', async () => {
    const filePath = getForkSessionHandoffLineageFilePath(userDataPath)
    await mkdir(path.dirname(filePath), { recursive: true })
    const records = Array.from({ length: FORK_SESSION_HANDOFF_LINEAGE_CAP + 3 }, (_, index) =>
      recordFixture(index + 1)
    )
    await writeFile(filePath, JSON.stringify({ version: 1, records }), 'utf8')

    const listed = await new ForkSessionHandoffLineageStore(userDataPath).list()

    expect(listed).toHaveLength(FORK_SESSION_HANDOFF_LINEAGE_CAP)
    expect(listed[0].createdAt).toBe(4)
    const persisted = JSON.parse(await readFile(filePath, 'utf8'))
    expect(persisted.records).toHaveLength(FORK_SESSION_HANDOFF_LINEAGE_CAP)
  })

  it('finishes atomic writes at the destination without leaving the sibling temporary file', async () => {
    const filePath = getForkSessionHandoffLineageFilePath(userDataPath)

    await new ForkSessionHandoffLineageStore(userDataPath).record(recordFixture())

    await expect(readFile(filePath, 'utf8')).resolves.toContain(
      '00000000-0000-4000-8000-000000000001'
    )
    await expect(readFile(`${filePath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes concurrent writes without losing records', async () => {
    const store = new ForkSessionHandoffLineageStore(userDataPath)

    await Promise.all([store.record(recordFixture(1)), store.record(recordFixture(2))])

    await expect(store.list()).resolves.toEqual([recordFixture(1), recordFixture(2)])
  })

  it('enriches only missing child identity fields and is idempotent', async () => {
    const store = new ForkSessionHandoffLineageStore(userDataPath)
    await store.record(recordFixture())

    await store.enrich({
      recordId: recordFixture().id,
      paneKey: 'child-pane',
      providerSessionId: 'child-provider'
    })
    await store.enrich({
      recordId: recordFixture().id,
      paneKey: 'replacement-pane',
      providerSessionId: 'replacement-provider'
    })

    const [record] = await store.list()
    expect(record.child.paneKey).toBe('child-pane')
    expect(record.child.providerSessionId).toBe('child-provider')
  })
})
