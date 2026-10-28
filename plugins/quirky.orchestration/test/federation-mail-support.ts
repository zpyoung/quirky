import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import type { WorkerAcceptance } from './workers/acceptance-support'

export const federationMailOwnerPluginId = 'acme.federation-mail-owner-fixture'

const pluginSource = `import { randomUUID } from 'node:crypto'

const pluginId = ${JSON.stringify(federationMailOwnerPluginId)}
let verdict = 'rejected'
const method = name => 'method:' + pluginId + '/' + name
const mutation = () => ({ requestId: randomUUID(), contractVersion: 1 })

export async function activate(context) {
  context.provide(method('submissionPreflight'), async (submission, caller) => {
    if (caller.role !== 'plugin' || caller.pluginId !== 'quirky.orchestration') {
      throw new Error('fixture preflight requires the authenticated orchestration plugin caller')
    }
    if (submission.type !== 'worker_done' || verdict === 'accepted') return { kind: 'accepted' }
    return { kind: 'rejected', code: 'mail_fixture_rejected', reason: 'the installed owner fixture rejects this report' }
  })

  context.provide(method('setVerdict'), value => {
    if (!value || (value.kind !== 'accepted' && value.kind !== 'rejected')) throw new Error('kind must be accepted or rejected')
    verdict = value.kind
    return { kind: verdict }
  })

  context.provide(method('start'), async value => {
    const created = await context.call('quirky.orchestration/serviceRunCreate', {
      ...mutation(),
      key: 'federation-mail-' + randomUUID(),
      objective: 'Actual federation mail owner acceptance'
    })
    const runId = created.run.id
    await context.call('quirky.orchestration/serviceRegisterSubmissionPreflight', {
      ...mutation(),
      runId,
      method: pluginId + '/submissionPreflight'
    })
    const receipt = await context.call('quirky.orchestration/serviceWorkerStart', {
      ...mutation(),
      runId,
      on: value.peerId,
      worktree: 'new-top-level',
      repo: value.repoId,
      name: value.worktreeName,
      agent: 'claude',
      taskTitle: value.taskTitle,
      spec: value.spec,
      timeoutMs: 30000
    })
    return { runId, receipt }
  })

  context.provide(method('sendGuidance'), value => context.call('quirky.orchestration/serviceSend', {
    ...mutation(), runId: value.runId, dispatchId: value.dispatchId, body: value.body
  }))

  context.provide(method('reply'), value => context.call('quirky.orchestration/serviceReply', {
    ...mutation(), runId: value.runId, messageId: value.messageId, body: value.body
  }))

  context.provide(method('show'), value => context.call('quirky.orchestration/serviceRunShow', { runId: value.runId }))
}
`

export type FederationMailOwnerStartResult = {
  runId: string
  receipt: { runId: string; taskId: string; dispatchId: string; state: string; [key: string]: unknown }
}
export type FederationMailOwnerRunView = {
  run: { id: string }
  workers: Array<{ dispatchId: string; assignmentActive: boolean; state: string; [key: string]: unknown }>
  questions: Array<{ messageId: string; status: string; [key: string]: unknown }>
}
export type FederationMailOwnerReplyResult = { duplicate: boolean; [key: string]: unknown }

export interface FederationMailOwnerFixture {
  readonly pluginId: string
  start(input: { peerId: string; repoId: string; worktreeName: string; taskTitle: string; spec: string }): Promise<FederationMailOwnerStartResult>
  setVerdict(kind: 'accepted' | 'rejected'): Promise<void>
  sendGuidance(input: { runId: string; dispatchId: string; body: string }): Promise<unknown>
  reply(input: { runId: string; messageId: string; body: string }): Promise<FederationMailOwnerReplyResult>
  show(runId: string): Promise<FederationMailOwnerRunView>
  cleanup(): void
}

/** Installs a real kernel-authenticated service Run owner with a controllable submission policy. */
export async function installFederationMailOwnerFixture(home: WorkerAcceptance): Promise<FederationMailOwnerFixture> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-federation-mail-owner-'))
  const pluginPath = writePlugin(root, {
    id: federationMailOwnerPluginId,
    name: 'Federation mail owner fixture',
    version: '1.0.0',
    main: 'main.ts',
    activation: 'startup',
    dependencies: ['quirky.orchestration'],
    contributes: {
      method: ['submissionPreflight', 'setVerdict', 'start', 'sendGuidance', 'reply', 'show'].map((id) => ({
        id,
        params: { type: 'object', additionalProperties: true },
        result: {},
      })),
    },
  }, { 'main.ts': pluginSource })
  try {
    await home.fixture.call('plugin.install', { path: pluginPath, yes: true })
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    home.fixture.call(`${federationMailOwnerPluginId}/${method}`, params) as Promise<T>
  return {
    pluginId: federationMailOwnerPluginId,
    start: (input) => call<FederationMailOwnerStartResult>('start', input),
    setVerdict: async (kind) => { await call('setVerdict', { kind }) },
    sendGuidance: (input) => call('sendGuidance', input),
    reply: (input) => call<FederationMailOwnerReplyResult>('reply', input),
    show: (runId) => call<FederationMailOwnerRunView>('show', { runId }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
