import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  QuirkydManagedStopRequestSchema,
  type QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'
import { acquireQuirkydInstanceLock } from './quirkyd-instance-lock'
import { quirkydManagedStopRequestPath } from './quirkyd-managed-stop-request'
import {
  completeQuirkydManagedStop,
  type QuirkydManagedStopCompletionOptions
} from './quirkyd-managed-stop-completion'
import { quirkydStopReceiptPath } from './quirkyd-completed-stop-receipt'
import type { QuirkydProcessIncarnation } from './quirkyd-process-start-time'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const RECORDED: QuirkydProcessIncarnation = {
  linuxStartTicks: '4242',
  bootId: 'boot-a'
}
// The WSL2 smoke saw btime move by 157 s against a 1.5 s tolerance.
const DRIFTED_STARTED_AT_MS = 5_000 + 157_000

function running(
  recorded: QuirkydProcessIncarnation | null,
  { requestCarriesIncarnation = false, identity = 'uid-1000' } = {}
): QuirkydManagedStopRequest {
  const root = mkdtempSync(join(tmpdir(), 'quirkyd-stop-identity-'))
  roots.push(root)
  const lock = acquireQuirkydInstanceLock(root, {
    identity: () => identity,
    startedAtMs: () => 5_000,
    incarnation: () => recorded
  })
  const { pid, startedAtMs, nonce } = lock.record
  return {
    schemaVersion: 1,
    transactionId: '0b9f6a3e-9e2c-4c8e-8f58-4c0f6b1d2e3a',
    version: '1.0.0',
    runtimeId: 'runtime-1',
    instance: {
      pid,
      startedAtMs,
      ...(requestCarriesIncarnation && recorded ? recorded : {}),
      nonce,
      lockPath: lock.path
    }
  }
}

/** Alive for `aliveFor` observations, then gone. */
function linuxHost(
  actual: QuirkydProcessIncarnation | null,
  aliveFor = Number.POSITIVE_INFINITY
): QuirkydManagedStopCompletionOptions {
  let observations = 0
  return {
    platform: 'linux',
    probeProcess: () => (observations++ < aliveFor ? 'alive' : 'missing'),
    startedAtMs: () => DRIFTED_STARTED_AT_MS,
    incarnation: () => actual,
    sleep: async () => {},
    attempts: 3,
    now: () => new Date('2026-10-01T00:00:00.000Z')
  }
}

const requestWritten = (request: QuirkydManagedStopRequest): boolean =>
  existsSync(quirkydManagedStopRequestPath(request.instance))

describe('managed stop instance identity', () => {
  it.each([
    ['the lock', false],
    ['the request', true]
  ])(
    'keeps a drifted-btime instance live by its ticks from %s, writes the request, then proves exit',
    async (_source, requestCarriesIncarnation) => {
      const request = running(RECORDED, { requestCarriesIncarnation })
      expect(await completeQuirkydManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
      expect(requestWritten(request)).toBe(true)
      expect(existsSync(quirkydStopReceiptPath(request, 'completed'))).toBe(true)
    }
  )

  it.each([
    ['different start ticks', { ...RECORDED, linuxStartTicks: '9999' }],
    ['a different boot', { ...RECORDED, bootId: 'boot-b' }]
  ])('proves exit for a PID now naming a process with %s', async (_name, actual) => {
    const request = running(RECORDED)
    expect(await completeQuirkydManagedStop(request, linuxHost(actual))).toBe('exited')
    expect(requestWritten(request)).toBe(false)
  })

  it('stays live, never exited, while the incarnation cannot be read', async () => {
    const request = running(RECORDED)
    expect(await completeQuirkydManagedStop(request, linuxHost(null))).toBe('live')
    expect(requestWritten(request)).toBe(true)
  })

  it('answers unverifiable, not exited, for an older lock whose wall-clock time drifted', async () => {
    const request = running(null)
    expect(await completeQuirkydManagedStop(request, linuxHost(RECORDED))).toBe('unverifiable')
    expect(existsSync(quirkydStopReceiptPath(request, 'completed'))).toBe(false)
  })

  it.each([
    ['another non-root uid', 1001, 'exited'],
    ['root', 0, 'unverifiable'],
    ['the same uid', 1000, 'unverifiable']
  ] as const)(
    'for an older lock whose wall-clock time disagrees, a PID owned by %s is %s',
    async (_owner, ownerUid, verdict) => {
      const request = running(null, { identity: '1000' })
      const host = { ...linuxHost(RECORDED), ownerUid: () => ownerUid }
      expect(await completeQuirkydManagedStop(request, host)).toBe(verdict)
      expect(existsSync(quirkydStopReceiptPath(request, 'completed'))).toBe(verdict === 'exited')
      expect(requestWritten(request)).toBe(false)
    }
  )

  it('takes no owner proof from a lock that no longer names the instance', async () => {
    const request = running(null, { identity: '1000' })
    const lock = JSON.parse(readFileSync(request.instance.lockPath, 'utf8'))
    writeFileSync(request.instance.lockPath, JSON.stringify({ ...lock, nonce: 'successor' }))
    const host = { ...linuxHost(RECORDED), ownerUid: () => 1001 }
    expect(await completeQuirkydManagedStop(request, host)).toBe('unverifiable')
  })

  it('stays readable by peers on either side of the change', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    // The instance shape slots before this change parse: the incarnation is dropped, not refused.
    const olderInstance = z.object({
      pid: z.number().int().positive(),
      startedAtMs: z.number().finite().nonnegative().nullable(),
      nonce: z.string().min(1),
      lockPath: z.string().min(1)
    })
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    expect(olderInstance.parse(request.instance)).toEqual(withoutIncarnation)
    // And a newer slot reads what an older client wrote, taking the incarnation from the lock.
    const fromOlderClient = QuirkydManagedStopRequestSchema.parse({
      ...request,
      instance: withoutIncarnation
    })
    expect(fromOlderClient.instance).not.toHaveProperty('linuxStartTicks')
    expect(await completeQuirkydManagedStop(fromOlderClient, linuxHost(RECORDED, 2))).toBe('exited')
    expect(
      JSON.parse(readFileSync(quirkydManagedStopRequestPath(request.instance), 'utf8'))
    ).toEqual(fromOlderClient)
  })

  it('matches its own receipt when an older client retries without the incarnation', async () => {
    const request = running(RECORDED, { requestCarriesIncarnation: true })
    expect(await completeQuirkydManagedStop(request, linuxHost(RECORDED, 2))).toBe('exited')
    const { linuxStartTicks: _ticks, bootId: _boot, ...withoutIncarnation } = request.instance
    const retried = { ...request, instance: withoutIncarnation }
    expect(await completeQuirkydManagedStop(retried, linuxHost(RECORDED, 0))).toBe('exited')
  })
})
