import type { PluginContext, Worktree } from '@quirky/protocol'
import { isPlainRecord } from './state'

const STOCK_TITLE = 'Source Control'
const WORKTREE_VIEW_ID = 'view:quirky.session/worktree'
const STRUCTURED_VIEW_ID = 'view:quirky.session/structured'
const WORKTREE_ID_PATTERN = /^wt_[0-9a-f]{12}$/

export type DirtyResult = {
  worktreeId: string | null
  count: number
  capped: boolean
  title: string
  dirty: boolean
  available: boolean
  error?: string
}

type StatusResult = { entries: unknown[]; capped: boolean }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function canonicalIdFromSelector(selector: string): string | null {
  const candidate = selector.startsWith('id:') ? selector.slice(3) : selector
  return WORKTREE_ID_PATTERN.test(candidate) ? candidate : null
}

function unavailable(worktreeId: string | null, error: unknown): DirtyResult {
  return {
    worktreeId,
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    dirty: false,
    available: false,
    error: messageOf(error)
  }
}

function noActiveWorkspace(): DirtyResult {
  return {
    worktreeId: null,
    count: 0,
    capped: false,
    title: STOCK_TITLE,
    dirty: false,
    available: true
  }
}

async function layoutSelector(context: PluginContext): Promise<string | null> {
  const state = await context.call('ui.state')
  if (!isPlainRecord(state) || !isPlainRecord(state.layout)) {
    throw new Error('ui.state returned an invalid layout')
  }
  const view = state.layout.view
  if (view === null) return null
  if (!isPlainRecord(view) || typeof view.id !== 'string') throw new Error('ui.state returned an invalid view')
  if (view.id === WORKTREE_VIEW_ID) {
    if (!isPlainRecord(view.input)) return null
    const selector = view.input.worktree
    return typeof selector === 'string' && selector.length > 0 ? selector : null
  }
  if (view.id === STRUCTURED_VIEW_ID) {
    if (!isPlainRecord(view.input) || typeof view.input.session !== 'string' || view.input.session.length === 0) return null
    const session = await context.call('quirky.session/get', { session: view.input.session })
    if (!isPlainRecord(session) || typeof session.worktreeId !== 'string' || session.worktreeId.length === 0) {
      throw new Error('quirky.session/get returned no canonical workspace identity')
    }
    return `id:${session.worktreeId}`
  }
  return null
}

async function resolveWorktree(context: PluginContext, selector: string): Promise<Worktree> {
  const value = await context.call('quirky.worktree/resolve', { selector })
  if (!isPlainRecord(value) || typeof value.id !== 'string' || typeof value.path !== 'string') {
    throw new Error('quirky.worktree/resolve returned an invalid workspace')
  }
  return value as unknown as Worktree
}

function statusTitle(count: number, capped: boolean): string {
  if (count === 0) return STOCK_TITLE
  const number = `${count}${capped ? '+' : ''}`
  const label = count === 1 && !capped ? 'change' : 'changes'
  return `${STOCK_TITLE} — ${number} uncommitted ${label}`
}

function panelRowCount(entries: unknown[]): number {
  let count = 0
  for (const entry of entries) {
    if (!isPlainRecord(entry)) throw new Error('quirky.git/status returned an invalid panel row')
    if (!entry.submoduleRoot) count += 1
  }
  return count
}

/** Reads a requested workspace or derives the omitted selector from canonical daemon UI layout. */
export async function readDirty(
  context: PluginContext,
  params: { worktree?: string | null }
): Promise<DirtyResult> {
  let selector: string | null
  try {
    selector = params.worktree === undefined ? await layoutSelector(context) : params.worktree
  } catch (error) {
    return unavailable(null, error)
  }
  if (selector === null) return noActiveWorkspace()

  let worktree: Worktree
  try {
    worktree = await resolveWorktree(context, selector)
  } catch (error) {
    return unavailable(canonicalIdFromSelector(selector), error)
  }

  try {
    const status = await context.call('quirky.git/status', { worktree: `id:${worktree.id}` })
    if (!isPlainRecord(status) || !Array.isArray(status.entries) || typeof status.capped !== 'boolean') {
      throw new Error('quirky.git/status returned an invalid status snapshot')
    }
    const { entries, capped } = status as unknown as StatusResult
    const count = panelRowCount(entries)
    return {
      worktreeId: worktree.id,
      count,
      capped,
      title: statusTitle(count, capped),
      dirty: count > 0,
      available: true
    }
  } catch (error) {
    return unavailable(worktree.id, error)
  }
}
