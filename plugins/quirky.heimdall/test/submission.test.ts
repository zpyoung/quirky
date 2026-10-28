import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { OrchestrationSubmission, PluginCaller, PluginContext } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { HostPowerService } from '../../../packages/daemon/src/host-power'
import { createKernelService } from '../src/service'
import type { Enrollment, JudgmentQuestionRequest, KindRegistration, Snapshot } from '../src/contracts'

const roots: string[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  for (const root of roots.splice(0).reverse()) rmSync(root, { recursive: true, force: true })
})

const submission: OrchestrationSubmission = {
  runId: 'run_demo', taskId: 'task_demo', dispatchId: 'dispatch_demo', type: 'worker_done',
  subject: 'Done', body: 'Finished', payload: { outcome: 'succeeded' }
}
const judgmentQuestion: JudgmentQuestionRequest = {
  id: 'stall-cause',
  questionId: 'heimdall.stall-cause',
  subjectId: 'dispatch_demo',
  question: { type: 'noul', instructions: 'Is the worker waiting for help?' }
}
const enrollment: Enrollment = {
  watcherId: 'watcher_demo', kind: 'demo', workspaceKey: 'local::/workspace/demo',
  workspacePath: '/workspace/demo', executionHostId: 'local', schedulerOwner: 'daemon',
  kindPayload: {}, enabled: true, paused: false, commandRevision: 0, capabilities: {},
  budget: { wallClockActiveMs: null, turns: null }, coordinator: { handle: 'coordinator', paneKey: 'pane' },
  orchestrationRunId: 'run_demo', createdAtMs: 1, terminalAtMs: null, parkReason: null, haltReason: null
}
const descriptor: KindRegistration = {
  id: 'demo', displayName: 'Demo', enrollmentPayloadSchema: { type: 'object', additionalProperties: true },
  hooks: {
    authorize: 'demo.kind/authorize', read: 'demo.kind/read', decide: 'demo.kind/decide', execute: 'demo.kind/execute',
    preflight: 'demo.kind/preflight',
    submission: 'demo.kind/submission',
    judgmentQuestions: 'demo.kind/judgmentQuestions'
  }
}

function fixture(submissionReply: () => unknown | Promise<unknown> = () => ({ kind: 'accepted' })) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-submission-'))
  roots.push(root)
  const home = root
  const dataDir = join(home, 'plugin-data', 'quirky.heimdall')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  let rejectHook = false
  let hookCalls = 0
  let actionPreflightCalls = 0
  const methods = ['authorize', 'read', 'decide', 'execute', 'preflight', 'submission', 'judgmentQuestions'].map((name) => ({
    kind: 'method', status: 'effective', plugin: 'demo.kind', id: `method:demo.kind/${name}`
  }))
  const context = {
    pluginId: 'quirky.heimdall', dir: root, dataDir, home,
    hostPower: new HostPowerService(() => {}, null).forPlugin('quirky.heimdall', () => false),
    log() {}, provide() {}, emit() { return false }, subscribe() { return () => {} },
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === 'plugin.contributions') return methods
      if (method === 'quirky.orchestration/serviceRunShow') return {
        run: { id: params.runId },
        workers: [{
          taskId: submission.taskId,
          dispatchId: submission.dispatchId,
          sessionId: 'session_demo',
          processIncarnation: 'process_demo',
          state: 'live',
          lastContactAtMs: 3,
          assignmentActive: true
        }],
        questions: []
      }
      if (method === 'demo.kind/submission') {
        hookCalls++
        if (rejectHook) throw new Error('hook unavailable')
        return await submissionReply()
      }
      if (method === 'demo.kind/judgmentQuestions') return [judgmentQuestion]
      if (method === 'demo.kind/preflight') {
        actionPreflightCalls++
        return { verdict: 'allow' }
      }
      throw new Error(`unexpected method ${method}`)
    },
    openStore(migrations: Parameters<PluginContext['openStore']>[0]) {
      const opened = openPluginStore({ home, pluginId: 'quirky.heimdall', migrations, isActive: () => true })
      closers.push(opened.close)
      return opened.store
    },
    getSetting() { return undefined }, storedSettingValue() { return undefined },
    error(_kind: never, message: string) { return new Error(message) }, pty: {}, notify() {}, launch: {}
  } as unknown as PluginContext
  const service = createKernelService(context)
  return {
    service,
    hooksCalled: () => hookCalls,
    actionPreflightCalls: () => actionPreflightCalls,
    unavailable() { rejectHook = true },
    async ready(registration: KindRegistration = descriptor, seedAttempt = true) {
      await service.start()
      await service.registerKind(registration, { role: 'plugin', pluginId: 'demo.kind' })
      service.store.save(enrollment)
      if (seedAttempt) {
        service.store.append(enrollment.watcherId, {
          eventId: 'active-worker-attempt', atMs: 2, class: 'fact', origin: 'owner', kind: 'attempt', resolved: false,
          attemptId: 'attempt_demo', fingerprint: 'fingerprint', action: { kind: 'dispatch' },
          state: 'running', requestId: 'request_demo', dispatchId: submission.dispatchId
        })
      }
    }
  }
}

const orchestrationCaller: PluginCaller = { role: 'plugin', pluginId: 'quirky.orchestration' }

test('registered submission hooks are owner-namespaced and dispatched separately from action preflight', async () => {
  const f = fixture(() => ({ kind: 'rejected', code: 'policy', reason: 'review required' }))
  try {
    await f.ready()
    const result = await f.service.submissionPreflight(submission, orchestrationCaller)
    expect(result).toEqual({ kind: 'rejected', code: 'policy', reason: 'review required' })
    expect(f.service.store.journal(enrollment.watcherId).filter((entry) => entry.kind === 'attempt').at(-1))
      .toMatchObject({ state: 'running', dispatchId: submission.dispatchId })
    expect(f.hooksCalled()).toBe(1)
    expect(f.actionPreflightCalls()).toBe(0)
    await expect(f.service.registerKind({
      ...descriptor,
      hooks: { ...descriptor.hooks, submission: 'other.kind/submission' }
    }, { role: 'plugin', pluginId: 'demo.kind' })).rejects.toThrow()
  } finally {
    await f.service.shutdown()
  }
})
test('judgment question hooks use the owner namespace and return validated requests', async () => {
  const f = fixture()
  try {
    await f.ready()
    const kind = f.service.registry.get('demo')
    const current = f.service.store.get(enrollment.watcherId)
    if (!kind?.judgmentQuestions || !current) throw new Error('registered judgment question hook was unavailable')
    const snapshot: Snapshot = { freshness: 'live', contentIdentity: 'state-1', observedAtMs: 3, world: {} }
    await expect(kind.judgmentQuestions(current, snapshot, [])).resolves.toEqual([judgmentQuestion])
    await expect(f.service.registerKind({
      ...descriptor,
      hooks: { ...descriptor.hooks, judgmentQuestions: 'other.kind/questions' }
    }, { role: 'plugin', pluginId: 'demo.kind' })).rejects.toThrow()
  } finally {
    await f.service.shutdown()
  }
})

test('reports with no registered hook preserve ordinary acceptance', async () => {
  const f = fixture()
  const withoutHook: KindRegistration = { ...descriptor, hooks: {
    authorize: descriptor.hooks.authorize,
    read: descriptor.hooks.read,
    decide: descriptor.hooks.decide,
    execute: descriptor.hooks.execute,
    preflight: descriptor.hooks.preflight
  } }
  try {
    await f.ready(withoutHook)
    await expect(f.service.submissionPreflight(submission, orchestrationCaller)).resolves.toEqual({ kind: 'accepted' })
    expect(f.hooksCalled()).toBe(0)
  } finally {
    await f.service.shutdown()
  }
})

test('a stale dispatch never invokes kind submission logic', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.service.store.append(enrollment.watcherId, {
      eventId: 'settled-worker-attempt', atMs: 3, class: 'fact', origin: 'owner', kind: 'attempt', resolved: true,
      attemptId: 'attempt_demo', fingerprint: 'fingerprint', action: { kind: 'dispatch' },
      state: 'settled', effect: 'landed', dispatchId: submission.dispatchId
    })
    const result = await f.service.submissionPreflight(submission, orchestrationCaller)
    expect(result).toMatchObject({ kind: 'rejected', code: 'stale-dispatch' })
    expect(f.hooksCalled()).toBe(0)
  } finally {
    await f.service.shutdown()
  }
})
test('owner-scoped Run inventory proves early dispatch before Heimdall journals its receipt', async () => {
  const f = fixture()
  try {
    await f.ready(descriptor, false)
    expect(f.service.store.journal(enrollment.watcherId).some((entry) => entry.kind === 'attempt')).toBe(false)
    await expect(f.service.submissionPreflight(submission, orchestrationCaller)).resolves.toEqual({ kind: 'accepted' })
    expect(f.hooksCalled()).toBe(1)
  } finally {
    await f.service.shutdown()
  }
})

test('unavailable registered hooks fail closed and callers must be kernel-authenticated orchestration', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.unavailable()
    await expect(f.service.submissionPreflight(submission, orchestrationCaller)).resolves.toMatchObject({ kind: 'rejected', code: 'hook-unavailable' })
    await expect(f.service.submissionPreflight(submission, { role: 'plugin', pluginId: 'spoofed' })).rejects.toThrow()
    expect(f.service.store.journal(enrollment.watcherId).filter((entry) => entry.kind === 'attempt').at(-1))
      .toMatchObject({ state: 'running', dispatchId: submission.dispatchId })
    expect(f.hooksCalled()).toBe(1)
  } finally {
    await f.service.shutdown()
  }
})
