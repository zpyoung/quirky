import { expect, test } from 'bun:test'
import type { PluginContext } from '@quirky/protocol'
import { inspectWorkspaceRemoval, workspaceKindForEnrollment } from '../src/workspace-lifecycle'
import type { Enrollment } from '../src/contracts'

const enrollment: Enrollment = {
  watcherId: 'watcher-1', kind: 'demo', workspaceKey: 'local::/workspace/demo',
  workspacePath: '/workspace/demo', executionHostId: 'local', schedulerOwner: 'daemon',
  repoId: 'repo_demo', worktreeId: 'worktree_demo', kindPayload: null,
  enabled: true, paused: false, commandRevision: 0, capabilities: {},
  budget: { wallClockActiveMs: null, turns: null }, coordinator: { handle: 'coordinator', paneKey: 'pane' },
  orchestrationRunId: 'run_demo', createdAtMs: 1, terminalAtMs: null, parkReason: null, haltReason: null
}

function changed(worktreeId = 'worktree_demo', repoId = 'repo_demo') {
  return { type: 'quirky.worktree/changed', data: { repoId, worktreeId } }
}

test('a successful authoritative inventory absence confirms removal', async () => {
  const calls: unknown[] = []
  const context = { call: async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    return [{ id: 'another-worktree', kind: 'git' }]
  } } as unknown as PluginContext

  await expect(inspectWorkspaceRemoval(context, enrollment, changed())).resolves.toBe('confirmed-removed')
  expect(calls).toEqual([{ method: 'quirky.worktree/list', params: { repo: 'repo_demo' } }])
})

test('a still-registered workspace is not removed even when its path may be missing', async () => {
  const context = { call: async () => [{ id: 'worktree_demo', kind: 'git' }] } as unknown as PluginContext
  await expect(inspectWorkspaceRemoval(context, enrollment, changed())).resolves.toBe('still-registered')
})

test('failed or malformed inventory is unverifiable rather than evidence of removal', async () => {
  const failing = { call: async () => { throw new Error('inventory unavailable') } } as unknown as PluginContext
  const malformed = { call: async () => ({ rows: [] }) } as unknown as PluginContext
  await expect(inspectWorkspaceRemoval(failing, enrollment, changed())).resolves.toBe('unverifiable')
  await expect(inspectWorkspaceRemoval(malformed, enrollment, changed())).resolves.toBe('unverifiable')
})

test('only the matching worktree removal signal may trigger an inventory check', async () => {
  let calls = 0
  const context = { call: async () => { calls++; return [] } } as unknown as PluginContext
  await expect(inspectWorkspaceRemoval(context, enrollment, changed('different'))).resolves.toBe('unrelated')
  await expect(inspectWorkspaceRemoval(context, enrollment, { type: 'quirky.repo/changed', data: { repoId: 'repo_demo' } })).resolves.toBe('unrelated')
  expect(calls).toBe(0)
})

test('folder-group removal checks the registered group inventory', async () => {
  let received: Record<string, unknown> | undefined
  const groupEnrollment = { ...enrollment, repoId: 'group:group_demo' }
  const context = { call: async (_method: string, params: Record<string, unknown>) => {
    received = params
    return []
  } } as unknown as PluginContext
  await expect(inspectWorkspaceRemoval(context, groupEnrollment, changed('worktree_demo', 'group:group_demo'))).resolves.toBe('confirmed-removed')
  expect(received).toEqual({ group: 'group_demo' })
})
test('folder enrollment without a public worktree identity is not inferred removed', async () => {
  const folder = { ...enrollment, worktreeId: null }
  let calls = 0
  const context = { call: async () => { calls++; return [] } } as unknown as PluginContext
  await expect(inspectWorkspaceRemoval(context, folder, changed())).resolves.toBe('unrelated')
  expect(await workspaceKindForEnrollment(context, enrollment)).toBeNull()
  expect(calls).toBe(1)
})
