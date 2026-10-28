import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import type { Enrollment, JournalAppend, JournalEntry, KernelStore, KindRegistry } from '../src/contracts'
import { createOwnerDriver } from '../src/owner/driver'

for (const assignmentActive of [false, true]) {
  test(`a live worker with assignmentActive=${assignmentActive} ${assignmentActive ? 'can' : 'cannot'} park an unowned watcher for an idle question`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'owner-driver-'))
    let enrollment: Enrollment = {
      watcherId: 'watcher', kind: 'fixture', enabled: true, paused: false, commandRevision: 0,
      workspaceKey: 'workspace', workspacePath: root, executionHostId: 'local', schedulerOwner: 'daemon',
      kindPayload: {}, capabilities: {}, budget: { wallClockActiveMs: null, turns: null },
      coordinator: { handle: 'coordinator', paneKey: 'pane' }, orchestrationRunId: 'run',
      createdAtMs: 0, terminalAtMs: null, parkReason: null, haltReason: null, owner: null
    }
    const entries: JournalEntry[] = []
    const append = (_id: string, value: JournalAppend): JournalEntry => {
      const entry: JournalEntry = { ...value, seq: entries.length + 1, eventId: `event-${entries.length + 1}`, watcherId: 'watcher', atMs: 0 }
      entries.push(entry)
      return entry
    }
    append('watcher', { kind: 'attempt', class: 'fact', origin: 'owner', resolved: false, attemptId: 'attempt', state: 'running', dispatchId: 'worker' })
    append('watcher', { kind: 'owner-worker-sample', class: 'fact', origin: 'owner', resolved: true, dispatchId: 'worker', waiting: true, activityStamp: 'incarnation:0', contact: 'live', idleSinceMs: 0 })
    const store = {
      readOnly: false, get: () => enrollment, list: () => [enrollment], journal: () => entries,
      save: (value: Enrollment) => { enrollment = value }, transaction: <T>(work: () => T): T => work(),
      append
    } as unknown as KernelStore
    const context = {
      call: async (method: string) => {
        if (method === 'quirky.orchestration/serviceRunShow') return {
          run: { id: 'run' }, questions: [], workers: [{ dispatchId: 'worker', sessionId: 'session', processIncarnation: 'incarnation', assignmentActive, state: 'live', lastContactAtMs: 240_000 }]
        }
        if (method === 'quirky.orchestration/workerShow') return {
          observation: { status: 'live', exactWorker: true, agentWait: { waiting: true }, session: { id: 'session', lastActivityAt: 0 } }
        }
        if (method === 'quirky.orchestration/workerRead') return { sourceExact: true, content: 'Which option should I use?' }
        throw new Error(`Unexpected owner scan call ${method}`)
      }
    } as unknown as PluginContext
    const registry = { get: () => undefined } as unknown as KindRegistry
    const driver = createOwnerDriver({ context, store, registry, reportDirectory: join(root, 'reports'), now: () => 240_000, wake: () => {} })
    try {
      await driver.step(enrollment, { freshness: 'live', contentIdentity: 'snapshot', observedAtMs: 240_000, world: {} })
      expect(enrollment.enabled).toBe(!assignmentActive)
      expect(enrollment.parkReason).toBe(assignmentActive ? 'worker-escalation' : null)
      if (assignmentActive) expect(entries.find(entry => entry.kind === 'escalation')?.body).toBe('Which option should I use?')
      else expect(entries.filter(entry => entry.kind === 'escalation')).toEqual([])
    } finally {
      await driver.shutdown()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
