import { isAbsolute, relative, sep } from 'node:path'
import type { PluginCaller } from '@quirky/protocol'
import type { EditorServices } from '../types'
import {
  isHeldBy,
  isMarkdownReviewNote,
  parseNote,
  readMarkdownNotes,
  releaseSnapshots,
  reserveSnapshots,
  sameSnapshot,
  type MarkdownReviewNote,
  type StoredNote
} from './note-store'

type WorkspaceNoteScope = { worktreeId: string; path?: string }
type WorkspaceNotePayload = Record<string, unknown> & { action?: string; worktree?: string; path?: string; holdId?: string; snapshots?: unknown }

async function workspaceNoteScope(host: EditorServices, params: WorkspaceNotePayload, caller: PluginCaller): Promise<WorkspaceNoteScope> {
  if (params.worktree !== undefined && typeof params.worktree !== 'string') {
    throw host.context.error('invalid-params', 'worktree must be a string.')
  }
  const worktree = await host.resolve(params.worktree, caller)
  if (params.path === undefined) return { worktreeId: worktree.id }
  if (typeof params.path !== 'string' || isAbsolute(params.path)) {
    throw host.context.error('invalid-params', 'path must be a worktree-relative path.')
  }
  const absolute = await host.path(worktree.id, params.path, { create: true })
  const path = relative(worktree.path, absolute)
  if (path === '' || path === '.' || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw host.context.error('invalid-params', 'path must name a file inside the worktree.')
  }
  return { worktreeId: worktree.id, path }
}

function workspaceSnapshotList(host: EditorServices, value: unknown, scope: WorkspaceNoteScope): MarkdownReviewNote[] {
  if (!Array.isArray(value)) throw host.context.error('invalid-params', 'snapshots must be an array of Markdown review notes.')
  const snapshots: MarkdownReviewNote[] = []
  const ids = new Set<string>()
  for (const item of value) {
    if (!isMarkdownReviewNote(item)) throw host.context.error('invalid-params', 'snapshots must contain complete persisted Markdown review notes.')
    if (item.worktreeId !== scope.worktreeId) throw host.context.error('invalid-params', 'A Markdown note snapshot belongs to another worktree.')
    if (scope.path !== undefined && item.filePath !== scope.path) throw host.context.error('invalid-params', 'A Markdown note snapshot is outside the requested path.')
    if (ids.has(item.id)) throw host.context.error('invalid-params', 'A Markdown note snapshot can appear only once.')
    ids.add(item.id)
    snapshots.push(item)
  }
  return snapshots
}

function workspaceNotesFor(host: EditorServices, scope: WorkspaceNoteScope): MarkdownReviewNote[] {
  return readMarkdownNotes(host, (note) =>
    note.worktreeId === scope.worktreeId && (scope.path === undefined || note.filePath === scope.path)
  )
}

function settleWorkspaceSnapshots(
  host: EditorServices,
  scope: WorkspaceNoteScope,
  snapshots: MarkdownReviewNote[],
  holdId?: string
): { deletedNoteIds: string[]; retainedNoteIds: string[] } {
  const result = host.store.transaction(() => {
    const deletedNoteIds: string[] = []
    const retainedNoteIds: string[] = []
    for (const snapshot of snapshots) {
      const row = host.store.get<StoredNote>('SELECT id, buffer_id, payload FROM editor_notes WHERE id = ?', snapshot.id)
      if (!row) {
        retainedNoteIds.push(snapshot.id)
        continue
      }
      const current = parseNote(host, row)
      if (row.buffer_id !== snapshot.bufferId || current.worktreeId !== scope.worktreeId ||
        (scope.path !== undefined && current.filePath !== scope.path) ||
        !sameSnapshot(current, snapshot) ||
        (holdId !== undefined && !isHeldBy(scope.worktreeId, snapshot.id, holdId))) {
        retainedNoteIds.push(snapshot.id)
        continue
      }
      const deletion = host.store.run(
        'DELETE FROM editor_notes WHERE id = ? AND buffer_id = ? AND payload = ?',
        snapshot.id,
        snapshot.bufferId,
        row.payload
      )
      if (deletion.changes > 0) deletedNoteIds.push(snapshot.id)
      else retainedNoteIds.push(snapshot.id)
    }
    return { deletedNoteIds, retainedNoteIds }
  })
  if (result.deletedNoteIds.length > 0) host.emit()
  return result
}

/** Lists and settles stored Markdown note snapshots without loading the document renderer. */
export function createWorkspaceNotesMethod(host: EditorServices): (params: Record<string, unknown>, caller: PluginCaller) => Promise<unknown> {
  return async (rawParams, caller) => {
    const params = rawParams as WorkspaceNotePayload
    if (params.action !== 'list' && params.action !== 'reserve' && params.action !== 'release' && params.action !== 'settle') {
      throw host.context.error('invalid-params', 'workspaceNotes action must be list, reserve, release or settle.')
    }
    const scope = await workspaceNoteScope(host, params, caller)
    if (params.action === 'list') return { notes: workspaceNotesFor(host, scope) }
    if (params.action === 'release') {
      if (typeof params.holdId !== 'string' || params.holdId === '') throw host.context.error('invalid-params', 'holdId is required.')
      return { releasedNoteIds: releaseSnapshots(scope.worktreeId, params.holdId) }
    }
    const snapshots = workspaceSnapshotList(host, params.snapshots, scope)
    if (params.action === 'reserve') {
      if (typeof params.holdId !== 'string' || params.holdId === '') throw host.context.error('invalid-params', 'holdId is required.')
      return reserveSnapshots(host, scope.worktreeId, params.holdId, snapshots)
    }
    if (params.holdId !== undefined && (typeof params.holdId !== 'string' || params.holdId === '')) {
      throw host.context.error('invalid-params', 'holdId must be a non-empty string.')
    }
    return settleWorkspaceSnapshots(host, scope, snapshots, params.holdId)
  }
}
