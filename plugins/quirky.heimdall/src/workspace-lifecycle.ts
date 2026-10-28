import { join } from 'node:path'
import { isRecord as record } from './json'
import { lstatSync, realpathSync } from 'node:fs'
import type { PluginContext } from '@quirky/protocol'
import type { Enrollment, KernelStore, TerminalSummary } from './contracts'
import { budgetUsage, openBudgetIntervals } from './budget'
import type { WorkspaceKind } from './lease'

export type WorkspaceRemovalCheck = 'confirmed-removed' | 'still-registered' | 'unverifiable' | 'unrelated'


function inventoryParams(repoId: string): Record<string, unknown> | null {
  if (repoId.startsWith('group:')) {
    const group = repoId.slice('group:'.length)
    return group.length > 0 ? { group } : null
  }
  return repoId.length > 0 ? { repo: repoId } : null
}

function parseInventory(value: unknown): Array<{ id: string; kind: WorkspaceKind }> | null {
  if (!Array.isArray(value)) return null
  const rows: Array<{ id: string; kind: WorkspaceKind }> = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!record(item) || typeof item.id !== 'string' || item.id.length === 0 ||
      (item.kind !== 'git' && item.kind !== 'folder') || ids.has(item.id)) return null
    ids.add(item.id)
    rows.push({ id: item.id, kind: item.kind })
  }
  return rows
}

async function inventory(context: PluginContext, repoId: string): Promise<Array<{ id: string; kind: WorkspaceKind }> | null> {
  const params = inventoryParams(repoId)
  if (!params) return null
  try {
    return parseInventory(await context.call('quirky.worktree/list', params))
  } catch {
    return null
  }
}

/** Resolve a registered workspace's kind only from a successful scoped inventory. */
export async function workspaceKindForEnrollment(context: PluginContext, enrollment: Enrollment): Promise<WorkspaceKind | null> {
  if (typeof enrollment.worktreeId === 'string' && enrollment.worktreeId.length > 0) {
    if (typeof enrollment.repoId !== 'string' || enrollment.repoId.length === 0) return null
    const rows = await inventory(context, enrollment.repoId)
    return rows?.find((row) => row.id === enrollment.worktreeId)?.kind ?? null
  }
  try {
    const workspace = realpathSync.native(enrollment.workspacePath)
    if (!lstatSync(workspace).isDirectory()) return null
    const dotGit = lstatSync(join(workspace, '.git'))
    return !dotGit.isSymbolicLink() && (dotGit.isDirectory() || dotGit.isFile()) ? 'git' : null
  } catch (error) {
    const code = record(error) ? error.code : undefined
    if (code !== 'ENOENT') return null
    try {
      return lstatSync(realpathSync.native(enrollment.workspacePath)).isDirectory() ? 'folder' : null
    } catch {
      return null
    }
  }
}

/** A worktree changed event is only a hint; successful registered inventory absence is authority. */
export async function inspectWorkspaceRemoval(
  context: PluginContext,
  enrollment: Enrollment,
  event: { type: string; data?: unknown }
): Promise<WorkspaceRemovalCheck> {
  if (event.type !== 'quirky.worktree/changed' || !record(event.data) ||
    typeof event.data.repoId !== 'string' || typeof event.data.worktreeId !== 'string' ||
    typeof enrollment.repoId !== 'string' || typeof enrollment.worktreeId !== 'string' ||
    event.data.repoId !== enrollment.repoId || event.data.worktreeId !== enrollment.worktreeId) return 'unrelated'
  const rows = await inventory(context, enrollment.repoId)
  if (!rows) return 'unverifiable'
  return rows.some((row) => row.id === enrollment.worktreeId) ? 'still-registered' : 'confirmed-removed'
}

/** Closes known billing at its last checkpoint, then terminates only the watcher record. */
export function terminalizeRemovedEnrollment(
  store: KernelStore,
  enrollment: Enrollment,
  now: () => number = Date.now
): TerminalSummary | null {
  if (store.readOnly) return null
  const current = store.get(enrollment.watcherId)
  if (!current || current.terminalAtMs !== null || current.orchestrationRunId !== enrollment.orchestrationRunId ||
    current.workspaceKey !== enrollment.workspaceKey || current.repoId !== enrollment.repoId ||
    current.worktreeId !== enrollment.worktreeId) return null
  const atMs = now()
  const terminal: Enrollment = { ...current, enabled: false, terminalAtMs: atMs, haltReason: 'workspace-removed' }
  const journal = store.journal(current.watcherId)
  store.transaction(() => {
    for (const interval of openBudgetIntervals(journal)) {
      store.append(current.watcherId, {
        eventId: `interval-close:${interval.intervalId}`,
        atMs,
        class: 'fact',
        origin: 'owner',
        kind: 'interval-close',
        resolved: true,
        intervalId: interval.intervalId,
        generation: interval.generation,
        reason: 'workspace-removed',
        checkpointAtMs: interval.checkpointAtMs
      })
    }
    store.save(terminal)
    store.append(current.watcherId, {
      eventId: `terminal:${current.watcherId}`,
      atMs,
      class: 'fact',
      origin: 'owner',
      kind: 'terminal',
      resolved: true,
      state: 'removed',
      reason: 'workspace-removed'
    })
  })
  const summary: TerminalSummary = {
    watcherId: terminal.watcherId,
    kind: terminal.kind,
    state: 'removed',
    reason: 'workspace-removed',
    atMs,
    budget: budgetUsage(store.journal(terminal.watcherId), atMs, terminal.budget)
  }
  store.terminal(terminal, summary)
  return summary
}

