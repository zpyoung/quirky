import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { HeimdallDatabase } from './database'
import {
  HeimdallEnrollmentStore,
  isMalformedKindPayloadEnrollment,
  type EnrollmentRearmConfiguration
} from './enrollment-store'
import { HeimdallLedgerStore } from './ledger-store'

let root: string
let database: HeimdallDatabase
let enrollments: HeimdallEnrollmentStore

const REARM_CONFIGURATION: EnrollmentRearmConfiguration = {
  capabilities: { merge: 'on', fixChecks: 'gated' },
  budget: { wallClockActiveMs: 120_000, turns: 4 },
  kindPayload: { pullRequest: 2, base: 'main' }
}

function enrollment(overrides: Partial<WatcherEnrollment> = {}): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/worktree',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/worktree',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { merge: 'gated' },
    budget: { wallClockActiveMs: 60_000, turns: 2 },
    kindPayload: { pullRequest: 1 },
    coordinatorIdentity: { handle: 'heimdall-1', paneKey: 'heimdall-pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...overrides
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-heimdall-enrollment-'))
  database = new HeimdallDatabase(root)
  enrollments = new HeimdallEnrollmentStore(database)
})

afterEach(() => {
  database.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Heimdall enrollment store', () => {
  it('returns malformed kind payload bytes without synthesizing executable payload', () => {
    enrollments.insert(enrollment())
    const rawJson = '{"pullRequest":'
    database
      .connection()
      .prepare('UPDATE heimdall_enrollment SET kind_payload_json = ? WHERE watcher_id = ?')
      .run(rawJson, 'watcher-1')

    const record = enrollments.list()[0]
    if (!record || !isMalformedKindPayloadEnrollment(record)) {
      throw new Error('Expected a malformed enrollment record')
    }
    expect(record).toMatchObject({
      watcherId: 'watcher-1',
      enabled: true,
      malformedKindPayload: { rawJson }
    })
    expect('kindPayload' in record).toBe(false)
    expect(enrollments.get('watcher-1')).toEqual(record)
    expect(enrollments.findLiveByWorkspace('local::/worktree')).toEqual(record)

    const disabled = enrollments.setEnabled('watcher-1', false)
    expect(disabled).toMatchObject({
      enabled: false,
      malformedKindPayload: { rawJson }
    })
    expect('kindPayload' in disabled).toBe(false)
    expect(() => enrollments.rearm('watcher-1', REARM_CONFIGURATION)).toThrow(
      'immutable Heimdall watcher'
    )
    expect(enrollments.findLiveByWorkspace('local::/worktree')).toEqual(disabled)
  })

  it('rearms a live disabled watcher with authorized configuration and stable identity', () => {
    const before = enrollments.insert(enrollment({ enabled: false, orchestrationRunId: 'run-1' }))

    expect(enrollments.rearm('watcher-1', REARM_CONFIGURATION)).toEqual({
      ...before,
      enabled: true,
      capabilities: REARM_CONFIGURATION.capabilities,
      paused: false,
      commandRevision: before.commandRevision + 1,
      budget: REARM_CONFIGURATION.budget,
      kindPayload: REARM_CONFIGURATION.kindPayload
    })
  })

  it('rolls back the rearm when its budget generation append fails', () => {
    const before = enrollments.insert(enrollment({ enabled: false }))
    const ledger = new HeimdallLedgerStore(database)

    expect(() =>
      enrollments.rearm('watcher-1', REARM_CONFIGURATION, () => {
        ledger.append({
          eventId: 'budget-generation',
          watcherId: 'watcher-1',
          atMs: 2,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'budget-generation',
          payload: { reason: 're-enrollment-after-explicit-disarm' }
        })
        throw new Error('generation append failed')
      })
    ).toThrow('generation append failed')
    expect(enrollments.get('watcher-1')).toEqual(before)
    expect(ledger.read('watcher-1').entries).toEqual([])
  })

  it('rejects invalid rearm configuration before changing the disabled watcher', () => {
    const before = enrollments.insert(enrollment({ enabled: false }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately invalid capability mode to exercise rearm's schema rejection path.
    const invalid = {
      ...REARM_CONFIGURATION,
      capabilities: { merge: 'invalid' }
    } as unknown as EnrollmentRearmConfiguration

    expect(() => enrollments.rearm('watcher-1', invalid)).toThrow()
    expect(enrollments.get('watcher-1')).toEqual(before)
  })

  it('rejects rearming an already enabled watcher without changing its configuration', () => {
    const before = enrollments.insert(enrollment())

    expect(() => enrollments.rearm('watcher-1', REARM_CONFIGURATION)).toThrow(
      'immutable Heimdall watcher'
    )
    expect(enrollments.get('watcher-1')).toEqual(before)
  })

  it('rejects rearming a terminal watcher without resurrecting or changing it', () => {
    const before = enrollments.insert(enrollment({ enabled: false, terminalAtMs: 50 }))

    expect(() => enrollments.rearm('watcher-1', REARM_CONFIGURATION)).toThrow(
      'immutable Heimdall watcher'
    )
    expect(enrollments.get('watcher-1')).toEqual(before)
  })

  it('preserves terminal run linkage while allowing live run linkage updates', () => {
    enrollments.insert(enrollment())
    expect(enrollments.setOrchestrationRunId('watcher-1', 'run-original').orchestrationRunId).toBe(
      'run-original'
    )
    const terminal = enrollments.markTerminal('watcher-1', 50)

    expect(() => enrollments.setOrchestrationRunId('watcher-1', 'run-replacement')).toThrow()
    expect(enrollments.get('watcher-1')).toEqual(terminal)
  })

  it('round-trips an owner through insert, and full-replaces it on rearm', () => {
    const owner = { agent: 'claude', model: 'opus', effort: 'high' }
    const before = enrollments.insert(enrollment({ enabled: false, owner }))
    expect(before.owner).toEqual(owner)
    expect(enrollments.get('watcher-1')).toMatchObject({ owner })

    const rearmedOwner = { agent: 'claude', model: 'sonnet' }
    expect(
      enrollments.rearm('watcher-1', { ...REARM_CONFIGURATION, owner: rearmedOwner })
    ).toMatchObject({ owner: rearmedOwner })

    enrollments.setEnabled('watcher-1', false)
    const cleared = enrollments.rearm('watcher-1', REARM_CONFIGURATION)
    expect(cleared.owner).toBeUndefined()
  })

  it('rolls back the terminal update when the post-terminal hook fails', () => {
    const before = enrollments.insert(enrollment())
    let observedTerminalAtMs: number | null = null

    expect(() =>
      enrollments.markTerminal('watcher-1', 50, undefined, () => {
        observedTerminalAtMs = enrollments.get('watcher-1')?.terminalAtMs ?? null
        throw new Error('sitter insert failed')
      })
    ).toThrow('sitter insert failed')

    expect(observedTerminalAtMs).toBe(50)
    expect(enrollments.get('watcher-1')).toEqual(before)
  })
})
