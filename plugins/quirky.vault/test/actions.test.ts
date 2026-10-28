import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import type { HostedSession, PublicListResult, SearchResponse } from '../src/types'
import { VaultRig } from './support/harness'
import { TrashVolume } from './support/trash-volume'
import { writeJsonlFixture } from './fixtures/scanner-fixtures'

let rig: VaultRig | undefined
let trashVolume: TrashVolume | undefined
let previousProcessHome: string | undefined
let processHomeOverridden = false

type DeleteResult = { deleted: boolean; trashed: number; alreadyMissing: boolean }

afterEach(async () => {
  try {
    await rig?.cleanup()
  } finally {
    rig = undefined
    try {
      trashVolume?.cleanup()
    } finally {
      trashVolume = undefined
      if (processHomeOverridden) {
        if (previousProcessHome === undefined) delete process.env.QUIRKY_HOME
        else process.env.QUIRKY_HOME = previousProcessHome
        previousProcessHome = undefined
        processHomeOverridden = false
      }
    }
  }
})

const start = async () => (rig = await VaultRig.start())
const startWithVolumeTmpdir = async (volume: TrashVolume) => {
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = volume.tmpDir
  try {
    const vault = await start()
    previousProcessHome = process.env.QUIRKY_HOME
    processHomeOverridden = true
    process.env.QUIRKY_HOME = vault.home
    return vault
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
  }
}

const claudeSession = async (vault: VaultRig): Promise<HostedSession> => {
  const list = await vault.call<PublicListResult>('list', { agents: ['claude'], unlimited: true })
  const session = list.sessions[0]
  if (!session) throw new Error('Claude fixture was not discovered')
  return session
}

const agentSession = async (vault: VaultRig, agent: string): Promise<HostedSession> => {
  const list = await vault.call<PublicListResult>('list', { agents: [agent], unlimited: true })
  const session = list.sessions[0]
  if (!session) throw new Error(`${agent} fixture was not discovered`)
  return session
}

type EventWait = { promise: Promise<void>; cancel(): void }

function waitForEvent(vault: VaultRig, predicate: (event: QuirkyEvent) => boolean, description: string): EventWait {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let settled = false
  let unsubscribe = () => {}
  // This integration wait observes a real Worker event; the guard prevents a missing event from leaking its listener.
  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    unsubscribe()
    reject(new Error(`timed out waiting for ${description}`))
  }, 30_000)
  unsubscribe = vault.client.onEvent((event: QuirkyEvent) => {
    if (settled || !predicate(event)) return
    settled = true
    clearTimeout(timeout)
    unsubscribe()
    resolve()
  })
  return {
    promise,
    cancel() {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      unsubscribe()
    }
  }
}

function waitForScan(vault: VaultRig, filePath: string): EventWait {
  return waitForEvent(vault, (event) => {
    if (event.type !== 'quirky.vault/scanProgress') return false
    const data = event.data as { phase?: unknown; current?: unknown }
    return data.phase === 'reading' && data.current === filePath
  }, `scan progress for ${filePath}`)
}


function largeTranscript(sessionId: string, cwd: string): Record<string, unknown>[] {
  const base = Date.UTC(2026, 9, 1, 10, 0, 0)
  return Array.from({ length: 16_000 }, (_, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    return {
      type: role,
      sessionId,
      timestamp: new Date(base + index * 1_000).toISOString(),
      cwd,
      message: { role, content: `${'owned concurrent source context '.repeat(12)} ${index}` }
    }
  })
}

describe('vault session actions', () => {
  test('inspection returns on-demand first prompt and parent-owned subagents', async () => {
    const vault = await start()
    const session = await claudeSession(vault)
    const fetched = await vault.call<HostedSession | null>('get', { id: session.id })
    const prompt = await vault.call<{ prompt: string | null }>('firstPrompt', { id: session.id })

    const subagents = await vault.call<HostedSession[]>('subagents', { id: session.id })
    expect(fetched).toMatchObject({ id: session.id, sourceId: session.sourceId, hostId: 'local', agent: 'claude' })
    expect(prompt.prompt).toEqual(expect.any(String))
    expect(subagents).toEqual([])
  })

  test('open and reveal actions use the terminal public API with the selected source path', async () => {
    const vault = await start()
    const session = await claudeSession(vault)
    const log = join(vault.home, 'open-external.jsonl')
    const previousLog = process.env.QUIRKY_TEST_OPEN_LOG
    process.env.QUIRKY_TEST_OPEN_LOG = log
    try {
      expect(await vault.call('openSource', { id: session.id, mode: 'view' })).toMatchObject({ ok: true })
      expect(await vault.call('openSource', { id: session.id, mode: 'open' })).toMatchObject({ ok: true })
      expect(await vault.call('openSource', { id: session.id, mode: 'reveal' })).toMatchObject({ ok: true })
      expect(await vault.call('openWorkingDirectory', { id: session.id })).toMatchObject({ ok: true })
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { target: string; reveal: boolean })
      expect(calls).toEqual([
        expect.objectContaining({ target: session.source.filePath, reveal: false }),
        expect.objectContaining({ target: session.source.filePath, reveal: false }),
        expect.objectContaining({ target: session.source.filePath, reveal: true }),
        expect.objectContaining({ target: session.cwd, reveal: false })
      ])
    } finally {
      if (previousLog === undefined) delete process.env.QUIRKY_TEST_OPEN_LOG
      else process.env.QUIRKY_TEST_OPEN_LOG = previousLog
    }
  })

  test('optional handoff and live-pane integrations report unavailable instead of simulating an action', async () => {
    const vault = await start()
    const session = await claudeSession(vault)

    expect(await vault.call<{ available: boolean; reason: string }>('handoff', { id: session.id })).toMatchObject({ available: false, reason: expect.any(String) })
    expect(await vault.call<{ available: boolean; reason: string }>('jump', { id: session.id, target: 'pane' })).toMatchObject({ available: false, reason: expect.any(String) })
  })

  test('unsupported source deletion reports a conflict without changing original bytes or source home', async () => {
    const vault = await start()
    const session = await agentSession(vault, 'codex')
    const filePath = session.source.filePath
    if (!filePath) throw new Error('Codex source fixture path was redacted')
    const originalBytes = readFileSync(filePath)

    await expect(vault.call('deleteSession', { id: session.id, yes: true })).rejects.toMatchObject({
      code: RpcErrorCode.Conflict
    })
    expect(readFileSync(filePath)).toEqual(originalBytes)
    expect(existsSync(vault.sourceHome)).toBe(true)
  })

  test.skipIf(process.platform !== 'darwin')(
    'APFS Trash rejects symlink swaps and invalidates concurrent scans/indexes while preserving unrelated originals',
    async () => {
      const volume = trashVolume = TrashVolume.create()
      const vault = await startWithVolumeTmpdir(volume)

      const claude = await claudeSession(vault)
      const claudePath = claude.source.filePath
      if (!claudePath) throw new Error('Claude source fixture path was redacted')
      const claudeBytes = readFileSync(claudePath)
      const codex = await agentSession(vault, 'codex')
      const unrelatedSourcePath = codex.source.filePath
      if (!unrelatedSourcePath) throw new Error('Codex source fixture path was redacted')
      const unrelatedSourceBytes = readFileSync(unrelatedSourcePath)

      const grok = await agentSession(vault, 'grok')
      const grokPath = grok.source.filePath
      if (!grokPath) throw new Error('Grok source fixture path was redacted')
      const grokDirectory = dirname(grokPath)
      const grokSummaryBytes = readFileSync(grokPath)
      const grokHistoryPath = join(grokDirectory, 'chat_history.jsonl')
      const grokHistoryBytes = readFileSync(grokHistoryPath)
      const siblingPath = join(dirname(grokDirectory), 'unrelated-sibling.txt')
      const siblingBytes = Buffer.from('unrelated sibling source data\n')
      writeFileSync(siblingPath, siblingBytes)

      volume.assertSafeDeletionTarget(claudePath, vault.sourceHome, vault.home)
      volume.assertSafeDeletionTarget(grokDirectory, vault.sourceHome, vault.home)
      expect(existsSync(claudePath)).toBe(true)
      expect(existsSync(grokDirectory)).toBe(true)

      const sentinelPath = join(vault.home, 'outside-sentinel.txt')
      const sentinelBytes = Buffer.from('outside data must survive a symlink swap\n')
      writeFileSync(sentinelPath, sentinelBytes)
      unlinkSync(claudePath)
      symlinkSync(sentinelPath, claudePath)
      const swapped = await vault.call<DeleteResult>('deleteSession', { id: claude.id, yes: true }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      if ('result' in swapped) {
        expect(swapped.result).toMatchObject({ deleted: false, trashed: 0, alreadyMissing: false })
      } else {
        expect(swapped.error).toMatchObject({ code: RpcErrorCode.Conflict })
      }
      expect(lstatSync(claudePath).isSymbolicLink()).toBe(true)
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes)
      unlinkSync(claudePath)
      writeFileSync(claudePath, claudeBytes)

      await vault.call('setSearchEnabled', { enabled: true })
      const beforeDelete = await vault.call<SearchResponse>('search', {
        query: 'vault-fixture-claude-marker',
        freshness: 'wait-until-current',
        filters: { agents: ['claude'] }
      })
      expect(beforeDelete.kind).toBe('results')
      if (beforeDelete.kind === 'results') {
        expect(beforeDelete.hits.some((hit) => hit.id === claude.id)).toBe(true)
      }

      const largeId = 'delete-race-large-source'
      const largeCwd = join(vault.home, 'large-source-workspace')
      mkdirSync(largeCwd, { recursive: true })
      const largePath = await writeJsonlFixture(vault.sourceHome, 'claude', largeId, largeTranscript(largeId, largeCwd))
      const pendingId = 'delete-race-index-pending'
      await writeJsonlFixture(vault.sourceHome, 'claude', pendingId, [
        {
          type: 'user',
          sessionId: pendingId,
          timestamp: '2026-10-20T00:00:00.000Z',
          cwd: largeCwd,
          message: { role: 'user', content: 'pending index work' }
        },
        {
          type: 'assistant',
          sessionId: pendingId,
          timestamp: '2026-10-20T00:00:01.000Z',
          cwd: largeCwd,
          message: { role: 'assistant', content: 'pending index response' }
        }
      ])
      const scanProgress = waitForScan(vault, largePath)
      let listSettled = false
      let searchSettled = false
      const inFlightList = vault.call<PublicListResult>('list', { agents: ['claude'], force: true, unlimited: true }).then(
        (value) => {
          listSettled = true
          return { value }
        },
        (error: unknown) => {
          listSettled = true
          return { error }
        }
      )
      const inFlightSearch = vault.call<SearchResponse>('search', {
        query: 'vault-fixture-claude-marker',
        freshness: 'wait-until-current',
        filters: { agents: ['claude'] }
      }).then(
        (value) => {
          searchSettled = true
          return { value }
        },
        (error: unknown) => {
          searchSettled = true
          return { error }
        }
      )
      let raceResults: { scanned: PublicListResult; indexed: SearchResponse; deleted: DeleteResult } | undefined
      try {
        await scanProgress.promise
        expect(listSettled).toBe(false)
        expect(searchSettled).toBe(false)
        const inFlightDelete = vault.call<DeleteResult>('deleteSession', { id: claude.id, yes: true }).then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
        const [listOutcome, searchOutcome, deleteOutcome] = await Promise.all([
          inFlightList,
          inFlightSearch,
          inFlightDelete
        ])
        if ('error' in listOutcome) throw listOutcome.error
        if ('error' in searchOutcome) throw searchOutcome.error
        if ('error' in deleteOutcome) throw deleteOutcome.error
        raceResults = { scanned: listOutcome.value, indexed: searchOutcome.value, deleted: deleteOutcome.value }
      } finally {
        scanProgress.cancel()
      }
      if (!raceResults) throw new Error('the concurrent deletion work did not settle')
      const { scanned, indexed, deleted } = raceResults

      expect(scanned.scannedFiles).toBeGreaterThan(0)
      expect(indexed.kind).toBe('results')
      expect(deleted).toMatchObject({ deleted: true, trashed: 1, alreadyMissing: false })
      expect(existsSync(claudePath)).toBe(false)
      expect(readFileSync(volume.trashPathFor(basename(claudePath)))).toEqual(claudeBytes)
      expect(readFileSync(sentinelPath)).toEqual(sentinelBytes)
      const afterDeleteList = await vault.call<PublicListResult>('list', { agents: ['claude'], force: true, unlimited: true })
      expect(afterDeleteList.sessions.some((session) => session.id === claude.id)).toBe(false)
      const afterDeleteSearch = await vault.call<SearchResponse>('search', {
        query: 'vault-fixture-claude-marker',
        freshness: 'wait-until-current',
        filters: { agents: ['claude'] }
      })
      expect(afterDeleteSearch.kind).toBe('results')
      if (afterDeleteSearch.kind === 'results') {
        expect(afterDeleteSearch.hits.some((hit) => hit.id === claude.id)).toBe(false)
      }
      expect(readFileSync(unrelatedSourcePath)).toEqual(unrelatedSourceBytes)
      expect(existsSync(vault.sourceHome)).toBe(true)

      const trashAfterClaude = volume.listTrashEntries()
      const repeatedClaudeResult = await vault.call<DeleteResult>('deleteSession', { id: claude.id, yes: true })
      expect(repeatedClaudeResult).toMatchObject({ deleted: true, trashed: 0, alreadyMissing: true })
      expect(volume.listTrashEntries().sort()).toEqual(trashAfterClaude.sort())

      const grokResult = await vault.call<DeleteResult>('deleteSession', { id: grok.id, yes: true })
      const trashedGrokDirectory = volume.trashPathFor(basename(grokDirectory))
      expect(grokResult).toMatchObject({ deleted: true, trashed: 1, alreadyMissing: false })
      expect(existsSync(grokDirectory)).toBe(false)
      expect(existsSync(trashedGrokDirectory)).toBe(true)
      expect(readFileSync(join(trashedGrokDirectory, basename(grokPath)))).toEqual(grokSummaryBytes)
      expect(readFileSync(join(trashedGrokDirectory, basename(grokHistoryPath)))).toEqual(grokHistoryBytes)
      expect(readFileSync(siblingPath)).toEqual(siblingBytes)
      expect(readFileSync(unrelatedSourcePath)).toEqual(unrelatedSourceBytes)
      expect(existsSync(vault.sourceHome)).toBe(true)

      const trashAfterGrok = volume.listTrashEntries()
      const repeatedGrokResult = await vault.call<DeleteResult>('deleteSession', { id: grok.id, yes: true })
      expect(repeatedGrokResult).toMatchObject({ deleted: true, trashed: 0, alreadyMissing: true })
      expect(volume.listTrashEntries().sort()).toEqual(trashAfterGrok.sort())
    },
    120_000
  )
})
