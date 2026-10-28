import { RpcErrorCode, type Worktree } from '@quirky/protocol'
import type { DaemonEnv } from './env'
import type { Note } from './notes'

export type MarkdownNoteSnapshot = {
  id: string
  bufferId: string
  worktreeId: string
  filePath: string
  source: 'markdown'
  selectedText?: string
  startLine?: number
  endLine?: number
  lineNumber: number
  body: string
  createdAt: number
  updatedAt?: number
  sentAt?: number
  side: 'modified'
}

export type MarkdownShelfNote = Note & {
  source: 'markdown'
  markdownSnapshot: MarkdownNoteSnapshot
}

type ReservationResult = { reservedNoteIds: string[]; unavailableNoteIds: string[] }

const isMissingMethod = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound

function validateSnapshot(value: unknown, worktreeId: string, path?: string): MarkdownNoteSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid Markdown note.')
  }
  const note = value as Record<string, unknown>
  const positiveInteger = (item: unknown) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 1
  const optionalString = (key: string) => !(key in note) || typeof note[key] === 'string'
  const optionalNumber = (key: string) => !(key in note) || (typeof note[key] === 'number' && Number.isFinite(note[key]))
  const optionalLine = (key: string) => !(key in note) || positiveInteger(note[key])
  if (typeof note.id !== 'string' || note.id === '' || typeof note.bufferId !== 'string' || note.bufferId === '' ||
    note.worktreeId !== worktreeId || typeof note.filePath !== 'string' || note.filePath === '' ||
    (path !== undefined && note.filePath !== path) || note.source !== 'markdown' ||
    !positiveInteger(note.lineNumber) || typeof note.body !== 'string' ||
    typeof note.createdAt !== 'number' || !Number.isFinite(note.createdAt) || note.side !== 'modified' ||
    !optionalString('selectedText') || !optionalLine('startLine') || !optionalLine('endLine') ||
    !optionalNumber('updatedAt') || !optionalNumber('sentAt')) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid Markdown note snapshot.')
  }
  return value as MarkdownNoteSnapshot
}

function stringIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
    throw new Error(`quirky.editor/workspaceNotes returned invalid ${field}.`)
  }
  return value as string[]
}
function assertPartition(requested: readonly string[], first: readonly string[], second: readonly string[], action: string): void {
  const expected = new Set(requested)
  const accounted = new Set<string>()
  for (const id of [...first, ...second]) {
    if (!expected.has(id) || accounted.has(id)) {
      throw new Error(`quirky.editor/workspaceNotes returned inconsistent ${action} IDs.`)
    }
    accounted.add(id)
  }
  if (accounted.size !== expected.size) throw new Error(`quirky.editor/workspaceNotes returned incomplete ${action} IDs.`)
}

export async function listMarkdownNotes(env: DaemonEnv, worktree: Worktree, path?: string): Promise<MarkdownShelfNote[]> {
  let result: unknown
  try {
    result = await env.context.call('quirky.editor/workspaceNotes', {
      worktree: `id:${worktree.id}`,
      action: 'list',
      ...(path === undefined ? {} : { path })
    })
  } catch (error) {
    if (isMissingMethod(error)) return []
    throw error
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid list result.')
  }
  const payload = result as { notes?: unknown }
  if (!Array.isArray(payload.notes)) throw new Error('quirky.editor/workspaceNotes returned no notes array.')
  return payload.notes.map((value) => {
    const snapshot = validateSnapshot(value, worktree.id, path)
    const startLine = snapshot.startLine ?? snapshot.lineNumber
    const line = snapshot.endLine ?? snapshot.lineNumber
    return {
      id: `markdown:${snapshot.id}`,
      worktreeId: snapshot.worktreeId,
      path: snapshot.filePath,
      startLine,
      line,
      body: snapshot.body,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt ?? null,
      source: 'markdown',
      markdownSnapshot: snapshot
    }
  })
}

export async function reserveMarkdownNotes(
  env: DaemonEnv,
  worktree: Worktree,
  holdId: string,
  notes: readonly MarkdownShelfNote[]
): Promise<ReservationResult> {
  if (notes.length === 0) return { reservedNoteIds: [], unavailableNoteIds: [] }
  const snapshots = notes.map((note) => note.markdownSnapshot)
  let result: unknown
  try {
    result = await env.context.call('quirky.editor/workspaceNotes', {
      worktree: `id:${worktree.id}`,
      action: 'reserve',
      holdId,
      snapshots
    })
  } catch (error) {
    if (isMissingMethod(error)) return { reservedNoteIds: [], unavailableNoteIds: snapshots.map((note) => note.id) }
    throw error
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid reservation result.')
  }
  const payload = result as { reservedNoteIds?: unknown; unavailableNoteIds?: unknown }
  const reservedNoteIds = stringIds(payload.reservedNoteIds, 'reserved note IDs')
  const unavailableNoteIds = stringIds(payload.unavailableNoteIds, 'unavailable note IDs')
  assertPartition(snapshots.map((note) => note.id), reservedNoteIds, unavailableNoteIds, 'reservation')
  return { reservedNoteIds, unavailableNoteIds }
}

export async function settleMarkdownNotes(
  env: DaemonEnv,
  worktree: Worktree,
  holdId: string | undefined,
  notes: readonly MarkdownShelfNote[]
): Promise<{ sent: string[]; kept: string[] }> {
  if (notes.length === 0) return { sent: [], kept: [] }
  const snapshots = notes.map((note) => note.markdownSnapshot)
  let result: unknown
  try {
    result = await env.context.call('quirky.editor/workspaceNotes', {
      worktree: `id:${worktree.id}`,
      action: 'settle',
      ...(holdId === undefined ? {} : { holdId }),
      snapshots
    })
  } catch (error) {
    if (isMissingMethod(error)) return { sent: [], kept: notes.map((note) => note.id) }
    throw error
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid settlement result.')
  }
  const payload = result as { deletedNoteIds?: unknown; retainedNoteIds?: unknown }
  const deletedNoteIds = stringIds(payload.deletedNoteIds, 'deleted note IDs')
  const retainedNoteIds = stringIds(payload.retainedNoteIds, 'retained note IDs')
  assertPartition(snapshots.map((note) => note.id), deletedNoteIds, retainedNoteIds, 'settlement')
  return {
    sent: deletedNoteIds.map((id) => `markdown:${id}`),
    kept: retainedNoteIds.map((id) => `markdown:${id}`)
  }
}

export async function releaseMarkdownNotes(env: DaemonEnv, worktree: Worktree, holdId: string): Promise<void> {
  let result: unknown
  try {
    result = await env.context.call('quirky.editor/workspaceNotes', {
      worktree: `id:${worktree.id}`,
      action: 'release',
      holdId
    })
  } catch (error) {
    if (isMissingMethod(error)) return
    throw error
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('quirky.editor/workspaceNotes returned an invalid release result.')
  }
  const payload = result as { releasedNoteIds?: unknown }
  stringIds(payload.releasedNoteIds, 'released note IDs')
}

export function isMarkdownShelfNote(note: Note): note is MarkdownShelfNote {
  return note.source === 'markdown' && note.markdownSnapshot !== undefined
}
