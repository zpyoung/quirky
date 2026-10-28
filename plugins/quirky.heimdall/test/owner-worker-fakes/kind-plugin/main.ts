import type { PluginContext } from '@quirky/protocol'

type JsonRecord = Record<string, unknown>
type Deviation = { kind: 'check-failed'; naturalKey: string; detail: string }

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : {}
}

let deviation: Deviation = {
  kind: 'check-failed',
  naturalKey: 'owner-worker:dispatch',
  detail: 'Create an owned native worker for the owner-worker acceptance flow.'
}
let contentIdentity = 'owner-worker-snapshot-1'

export async function activate(context: PluginContext): Promise<void> {
  const pluginId = context.pluginId
  context.provide(`method:${pluginId}/configure`, (params: JsonRecord) => {
    const naturalKey = params.naturalKey
    const detail = params.detail
    if (typeof naturalKey !== 'string' || naturalKey.length === 0 || typeof detail !== 'string' || detail.length === 0) {
      throw context.error('invalid-params', 'naturalKey and detail are required')
    }
    deviation = { kind: 'check-failed', naturalKey, detail }
    contentIdentity = `owner-worker-snapshot:${naturalKey}`
    return { naturalKey, contentIdentity }
  })

  context.provide(`method:${pluginId}/authorize`, async (params: JsonRecord) => {
    const input = record(params.input)
    const payload = record(input.kindPayload)
    if (typeof payload.worktreeId !== 'string' || payload.worktreeId.length === 0) {
      throw context.error('invalid-params', 'kindPayload.worktreeId is required')
    }
    const raw = record(await context.call('quirky.worktree/show', { worktree: payload.worktreeId }))
    const nested = record(raw.worktree)
    const worktree = Object.keys(nested).length > 0 ? nested : raw
    if (typeof worktree.id !== 'string' || typeof worktree.path !== 'string' || typeof worktree.repoId !== 'string') {
      throw new Error('the public worktree lookup returned an invalid workspace')
    }
    return {
      workspaceKey: `owner-worker::${worktree.id}`,
      workspacePath: worktree.path,
      executionHostId: 'local',
      schedulerOwner: 'daemon',
      repoId: worktree.repoId,
      worktreeId: worktree.id,
      kindPayload: payload
    }
  })

  context.provide(`method:${pluginId}/read`, (params: JsonRecord) => ({
    freshness: 'live',
    contentIdentity,
    observedAtMs: Date.now(),
    world: { worktreeId: record(record(params.enrollment).kindPayload).worktreeId }
  }))
  context.provide(`method:${pluginId}/decide`, () => ({
    action: null,
    reason: deviation.detail,
    detail: deviation.detail,
    deviation
  }))
  context.provide(`method:${pluginId}/ownerAction`, (params: JsonRecord) => {
    const intervention = record(params.intervention)
    const snapshot = record(params.snapshot)
    return {
      kind: 'dispatch-worker',
      capability: 'dispatch-worker',
      visibility: 'local',
      contentIdentity: snapshot.contentIdentity,
      evidenceKey: typeof intervention.evidenceKey === 'string' ? intervention.evidenceKey : 'owner-worker:dispatch'
    }
  })
  context.provide(`method:${pluginId}/execute`, (params: JsonRecord) => {
    const action = record(params.action)
    if (action.kind !== 'dispatch-worker') return { effect: 'not-landed', reason: 'unexpected-owner-action' }
    const payload = record(record(params.enrollment).kindPayload)
    if (typeof payload.worktreeId !== 'string') throw new Error('the owned worker request has no workspace')
    return {
      worker: {
        spec: '[hold] Keep this native worker live until Heimdall stops this exact attempt.',
        taskTitle: 'Owner worker acceptance target',
        worktree: payload.worktreeId,
        agent: 'codex',
        mode: 'structured'
      }
    }
  })

  await context.call('quirky.heimdall/registerKind', {
    id: 'acme.owner-worker-kind',
    displayName: 'Owner worker acceptance kind',
    enrollmentPayloadSchema: {
      type: 'object',
      properties: { worktreeId: { type: 'string' } },
      required: ['worktreeId'],
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
