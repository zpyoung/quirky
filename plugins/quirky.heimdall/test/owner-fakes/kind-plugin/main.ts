import type { PluginContext } from '@quirky/protocol'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

type FakeDeviation = { kind: string; naturalKey: string; detail: string; dispatchId?: string; messageId?: string; trigger?: 'idle' | 'silent' }
type FakeState = {
  deviation: FakeDeviation | null
  deviations: Record<string, FakeDeviation | null>
  contentIdentity: string
  executionHostId: string
  schedulerOwner: string
  translatedAction: Record<string, unknown>
  executeResult: { effect: 'landed' | 'not-landed' | 'indeterminate'; reason?: string }
}

type RecordValue = Record<string, unknown>
type TestGlobals = typeof globalThis & {
  __HEIMDALL_OWNER_FAKE__?: FakeState
  __structuredFakes?: { worktree: { id: string; repoId: string; path: string } }
}
const globals = globalThis as TestGlobals

function state(): FakeState {
  const value = globals.__HEIMDALL_OWNER_FAKE__
  if (!value) throw new Error('owner acceptance fixture state is unavailable')
  return value
}

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RecordValue : {}
}

export async function activate(context: PluginContext): Promise<void> {
  const pluginId = context.pluginId


  context.provide(`method:${pluginId}/authorize`, async (params: RecordValue) => {
    const current = state()
    const payload = record(params.kindPayload ?? record(params.input).kindPayload)
    const workspaceKey = typeof payload.workspaceKey === 'string' ? payload.workspaceKey : 'owner-acceptance'
    const worktree = globals.__structuredFakes?.worktree
    if (!worktree) throw new Error('owner acceptance fixture worktree is unavailable')
    return {
      workspaceKey,
      workspacePath: worktree.path,
      executionHostId: current.executionHostId,
      schedulerOwner: current.schedulerOwner,
      repoId: worktree.repoId,
      worktreeId: worktree.id,
      kindPayload: payload
    }
  })
  context.provide(`method:${pluginId}/read`, async () => {
    const current = state()
    return {
      freshness: 'live',
      contentIdentity: current.contentIdentity,
      observedAtMs: Date.now(),
      world: { fixture: 'owner-acceptance' }
    }
  })
  context.provide(`method:${pluginId}/decide`, async (params: RecordValue) => {
    const current = state()
    const enrollment = record(params.enrollment)
    const payload = record(enrollment.kindPayload ?? params.kindPayload)
    const workspaceKey = payload.workspaceKey
    const deviation = typeof workspaceKey === 'string' && Object.hasOwn(current.deviations, workspaceKey)
      ? current.deviations[workspaceKey]
      : current.deviation
    return deviation
      ? { action: null, reason: deviation.detail, detail: deviation.detail, deviation }
      : { action: null, reason: 'fixture has no pending deviation' }
  })
  context.provide(`method:${pluginId}/execute`, async (params: RecordValue) => {
    const current = state()
    const action = record(params.action)
    const enrollment = record(params.enrollment)
    if (action.kind === 'publish' && current.executeResult.effect === 'landed') {
      if (typeof enrollment.workspacePath !== 'string') throw context.error('invalid-params', 'publication workspace is missing')
      appendFileSync(join(enrollment.workspacePath, 'owner-publications.jsonl'), `${JSON.stringify({
        evidenceKey: action.evidenceKey, contentIdentity: action.contentIdentity, note: action.publicationNote
      })}\n`, { mode: 0o600 })
    }
    return current.executeResult
  })
  context.provide(`method:${pluginId}/ownerAction`, async (params: RecordValue) => {
    const customAction = record(params.intervention)
    const operation = customAction.operation
    if (typeof operation !== 'string') throw context.error('invalid-params', 'owner action needs an operation')
    const evidenceKey = customAction.evidenceKey
    return {
      ...state().translatedAction,
      kind: operation,
      capability: operation,
      ...(typeof evidenceKey === 'string' ? { evidenceKey } : {}),
      ...(typeof customAction.note === 'string' ? { publicationNote: customAction.note } : {})
    }
  })

  await context.call('quirky.heimdall/registerKind', {
    id: 'acme.owner-kind',
    displayName: 'Owner acceptance fixture',
    enrollmentPayloadSchema: {
      type: 'object',
      properties: { workspaceKey: { type: 'string' } },
      required: ['workspaceKey'],
      additionalProperties: false
    },
    hooks: {
      authorize: `${pluginId}/authorize`,
      read: `${pluginId}/read`,
      decide: `${pluginId}/decide`,
      execute: `${pluginId}/execute`,
      ownerAction: `${pluginId}/ownerAction`
    }
  })
}
