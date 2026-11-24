import { describe, expect, it, vi } from 'vitest'
import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  abortStagedQuirkydMigrationCatalogByReferenceDurably,
  abortStagedQuirkydMigrationCatalogDurably,
  commitStagedQuirkydMigrationCatalogDurably,
  stageQuirkydMigrationCatalogDurably
} from './quirkyd-migration-catalog-import'

describe('durable quirkyd migration catalog import', () => {
  it('does not acknowledge staging until its dormant manifest is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const staged = { state: 'staged' } as QuirkydMigrationCatalogState
    const stage = vi.fn().mockReturnValue(staged)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const args = {
      store: {
        stageQuirkydMigrationCatalog: stage,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as QuirkydMigrationManifest
    }

    await expect(stageQuirkydMigrationCatalogDurably(args)).rejects.toBe(diskError)
    await expect(stageQuirkydMigrationCatalogDurably(args)).resolves.toBe(staged)
    expect(stage).toHaveBeenCalledTimes(2)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('publishes a committed catalog only after its receipt is durable', async () => {
    const diskError = new Error('disk full')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const committed = { state: 'committed' } as QuirkydMigrationCatalogState
    const commit = vi.fn().mockReturnValue(committed)
    const flush = vi.fn().mockRejectedValueOnce(diskError).mockResolvedValueOnce(undefined)
    const onDurableCommit = vi.fn()
    const args = {
      store: {
        commitStagedQuirkydMigrationCatalog: commit,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as QuirkydMigrationManifest,
      onDurableCommit
    }

    await expect(commitStagedQuirkydMigrationCatalogDurably(args)).rejects.toBe(diskError)
    expect(onDurableCommit).not.toHaveBeenCalled()
    await expect(commitStagedQuirkydMigrationCatalogDurably(args)).resolves.toBe(committed)
    expect(onDurableCommit).toHaveBeenCalledOnce()
  })

  it('reflushes an already-absent abort after the first flush failed', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const aborted = { state: 'absent', aborted: true } as QuirkydMigrationCatalogAbortResult
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
    const unchanged = { state: 'absent', aborted: false } as QuirkydMigrationCatalogAbortResult
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedQuirkydMigrationCatalog: abort,
        flushPendingOrThrowAsync: flush
      },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the durable wrappers only pass these values through to the stubbed store.
      manifest: {} as QuirkydMigrationManifest
    }

    await expect(abortStagedQuirkydMigrationCatalogDurably(args)).rejects.toThrow('disk full')
    await expect(abortStagedQuirkydMigrationCatalogDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('answers an abort by reference absent only once its flush succeeds', async () => {
    const reference = { migrationId: 'migration-1', manifestSha256: 'a'.repeat(64) }
    const aborted: QuirkydMigrationCatalogReferenceAbortResult = {
      ...reference,
      state: 'absent',
      aborted: true
    }
    const unchanged: QuirkydMigrationCatalogReferenceAbortResult = { ...aborted, aborted: false }
    const abort = vi.fn().mockReturnValueOnce(aborted).mockReturnValueOnce(unchanged)
    const flush = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const args = {
      store: {
        abortStagedQuirkydMigrationCatalogByReference: abort,
        flushPendingOrThrowAsync: flush
      },
      reference
    }

    await expect(abortStagedQuirkydMigrationCatalogByReferenceDurably(args)).rejects.toThrow(
      'disk full'
    )
    await expect(abortStagedQuirkydMigrationCatalogByReferenceDurably(args)).resolves.toEqual({
      ...unchanged,
      durableAbsent: true
    })
    expect(flush).toHaveBeenCalledTimes(2)
  })
})
