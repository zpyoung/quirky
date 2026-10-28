import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { gitApi } from '@quirky/git'
import type { PluginStore, Repo } from '@quirky/protocol'
import type {
  CleanupBlocker,
  CleanupCandidate,
  CleanupPreview,
  CleanupRemovalResult,
  CleanupSelection,
  WorktreeControl,
  WorktreeSleepPreview,
  WorktreeSleepPreviewRow,
  WorktreeSleepState
} from '../control-types'
import { worktreeIdForPath } from '../../paths'
import type { CallerIdentity } from '../../selector'
import { listGroup, listProject, type ListEnv } from './list'
import { removeWorktree, type RemoveEnv } from './remove'
import { closeWindowView, selectWindow, type SelectedWindow } from './window'

const DAY_MS = 24 * 60 * 60 * 1_000
const CLEANUP_IDLE_MS = 30 * DAY_MS
const LIVE_SESSION_STATUSES: Record<string, true> = { starting: true, running: true, working: true, waiting: true, done: true }

type PublicCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>
type SessionEvidence = { sessions: Record<string, unknown>[] | null; error: string | null; malformed: boolean }
type ReadEvidence = { value: unknown; error: string | null }
type WindowLayoutEvidence = { connId: number; layout: Record<string, unknown> }
type WindowEvidence = { layouts: WindowLayoutEvidence[] | null; connIds: number[]; error: string | null; malformed: boolean }
export type ControlEnv = {
  list: ListEnv
  remove: RemoveEnv
  store: PluginStore
  repos(): Promise<Repo[]>
  call: PublicCall
  find(selector: string, identity: CallerIdentity): Promise<{ worktree: WorktreeControl; all: WorktreeControl[] }>
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
  changed(data: { repoId: string; worktreeId: string }): void
}

type SleepParams = { worktree: string; withDescendants?: boolean; window?: unknown }
type CleanupRemoveParams = { selection: CleanupSelection[]; confirmed: boolean }
type Snapshot = { generatedAt: number; candidates: CleanupCandidate[]; worktrees: WorktreeControl[] }

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function addBlocker(blockers: CleanupBlocker[], code: string, detail: string): void {
  if (!blockers.some((blocker) => blocker.code === code && blocker.detail === detail)) blockers.push({ code, detail })
}

async function readPublic(call: PublicCall, method: string, params: Record<string, unknown> = {}): Promise<ReadEvidence> {
  try {
    return { value: await call(method, params), error: null }
  } catch (error) {
    return { value: null, error: messageOf(error) }
  }
}

async function readSessions(call: PublicCall): Promise<SessionEvidence> {
  const result = await readPublic(call, 'quirky.session/list')
  if (result.error !== null) return { sessions: null, error: result.error, malformed: false }
  if (!Array.isArray(result.value)) return { sessions: null, error: 'quirky.session/list returned a non-list result', malformed: true }
  const sessions: Record<string, unknown>[] = []
  let malformed = false
  for (const value of result.value) {
    const record = recordOf(value)
    if (!record || typeof record.id !== 'string' || typeof record.worktreeId !== 'string' || typeof record.status !== 'string' || typeof record.agent !== 'string') {
      malformed = true
      continue
    }
    sessions.push(record)
  }
  return { sessions, error: null, malformed }
}
type VolatileEvidence = { value: boolean | null; evidence: unknown; detail: string | null }

function collectPaneSessions(value: unknown, sessionIds: string[]): boolean {
  const node = recordOf(value)
  if (!node) return false
  if (node.kind === 'pane') {
    if (typeof node.session !== 'string' || node.session === '') return false
    sessionIds.push(node.session)
    return true
  }
  if (node.kind !== 'split') return false
  return collectPaneSessions(node.first, sessionIds) && collectPaneSessions(node.second, sessionIds)
}

function collectWorkspaceSessions(value: unknown, sessionIds: string[]): boolean {
  const node = recordOf(value)
  if (!node) return false
  if (node.kind === 'split') {
    return collectWorkspaceSessions(node.first, sessionIds) && collectWorkspaceSessions(node.second, sessionIds)
  }
  if (node.kind !== 'group' || !Array.isArray(node.tabs)) return false
  for (const raw of node.tabs) {
    const tab = recordOf(raw)
    if (!tab) return false
    if (tab.kind === 'view') continue
    if (!collectPaneSessions(tab.root, sessionIds)) return false
  }
  return true
}

async function terminalVolatileEvidence(call: PublicCall, worktreeId: string, sessions: SessionEvidence): Promise<VolatileEvidence> {
  const terminal = await readPublic(call, 'quirky.terminal/workspace', { workspace: worktreeId })
  if (terminal.error !== null) {
    return { value: null, evidence: ['terminal-workspace-error', terminal.error], detail: terminal.error }
  }
  const response = recordOf(terminal.value)
  const workspace = recordOf(response?.workspace)
  const sessionIds: string[] = []
  if (!workspace || workspace.id !== worktreeId || !collectWorkspaceSessions(workspace.root, sessionIds)) {
    return { value: null, evidence: ['terminal-workspace-malformed'], detail: 'The terminal owner returned incomplete workspace or pane/session bindings.' }
  }
  if (sessions.sessions === null || sessions.malformed) {
    return { value: null, evidence: ['session-evidence-unknown', sessions.error, sessions.malformed], detail: 'The public session inventory is incomplete.' }
  }
  const byId = new Map<string, Record<string, unknown>>()
  for (const session of sessions.sessions) {
    if (typeof session.id !== 'string' || byId.has(session.id)) {
      return { value: null, evidence: ['duplicate-session-id'], detail: 'The public session inventory had duplicate process identities.' }
    }
    byId.set(session.id, session)
  }
  const bound = new Set(sessionIds)
  let live = false
  const sessionFacts: unknown[] = []
  for (const session of sessions.sessions) {
    if (session.worktreeId !== worktreeId) continue
    if (typeof session.status !== 'string') {
      return { value: null, evidence: ['session-status-unknown', session.id], detail: 'A workspace session had no runtime status.' }
    }
    sessionFacts.push([session.id, session.status, bound.has(session.id as string)])
    if (session.status === 'exited') continue
    if (LIVE_SESSION_STATUSES[session.status] !== true) {
      return { value: null, evidence: ['session-status-unknown', session.id, session.status], detail: `Session ${String(session.id)} has an unknown runtime status.` }
    }
    live = true
  }
  for (const id of bound) {
    const session = byId.get(id)
    if (!session || session.worktreeId !== worktreeId || typeof session.status !== 'string') {
      return { value: null, evidence: ['pane-session-unknown', id], detail: `Terminal pane session ${id} is not bound to a complete live session record.` }
    }
    if (session.status !== 'exited') live = true
  }
  return {
    value: live,
    evidence: ['terminal-workspace', workspace.id, workspace.revision ?? null, [...bound].sort(), sessionFacts],
    detail: null
  }
}

function sessionBlockers(
  worktreeId: string,
  evidence: SessionEvidence,
  unknownCode = 'terminal-liveness-unknown'
): CleanupBlocker[] {
  const blockers: CleanupBlocker[] = []
  if (evidence.sessions === null) {
    addBlocker(blockers, unknownCode, `Could not verify terminal or agent process liveness: ${evidence.error ?? 'session evidence is unavailable'}.`)
    return blockers
  }
  if (evidence.malformed) addBlocker(blockers, unknownCode, 'The public session list contained incomplete runtime identity or status evidence.')
  for (const session of evidence.sessions) {
    if (session.worktreeId !== worktreeId) continue
    const id = String(session.id)
    const status = session.status
    if (status === 'exited') continue
    if (typeof status !== 'string' || LIVE_SESSION_STATUSES[status] !== true) {
      addBlocker(blockers, unknownCode, `Session ${id} has an unknown runtime status and was left untouched.`)
      continue
    }
    if (session.agent === 'shell') {
      addBlocker(blockers, 'running-terminal', `Terminal session ${id} is ${status}.`)
    } else {
      addBlocker(blockers, 'live-agent', `Agent session ${id} (${String(session.agent)}) is ${status}.`)
    }
  }
  return blockers
}

/** The live-session guard also runs from canonical removal immediately before its close-session step. */
export async function worktreeRuntimeBlockers(call: PublicCall, worktreeId: string): Promise<CleanupBlocker[]> {
  return sessionBlockers(worktreeId, await readSessions(call))
}

function descendantsOf(worktrees: WorktreeControl[], rootId: string): WorktreeControl[] {
  const found: WorktreeControl[] = []
  const seen = new Set([rootId])
  const visit = (parentId: string) => {
    for (const worktree of worktrees) {
      if (worktree.parentId !== parentId || seen.has(worktree.id)) continue
      seen.add(worktree.id)
      found.push(worktree)
      visit(worktree.id)
    }
  }
  visit(rootId)
  return found
}

async function sleepTargets(env: ControlEnv, params: SleepParams, identity: CallerIdentity): Promise<WorktreeControl[]> {
  if (typeof params.worktree !== 'string' || params.worktree.trim() === '') {
    throw env.fail('invalid-params', 'worktree must be a non-empty selector')
  }
  if (params.withDescendants !== undefined && typeof params.withDescendants !== 'boolean') {
    throw env.fail('invalid-params', 'withDescendants must be a boolean')
  }
  if (params.window !== undefined && (typeof params.window !== 'number' || !Number.isSafeInteger(params.window) || params.window < 1)) {
    throw env.fail('invalid-params', 'window must be a positive live UI connection ID')
  }
  const { worktree, all } = await env.find(params.worktree, identity)
  return params.withDescendants === true ? [worktree, ...descendantsOf(all, worktree.id)] : [worktree]
}

type SleepInspection = { preview: WorktreeSleepPreview; closeView: boolean; selected: SelectedWindow | null }

async function inspectSleep(env: ControlEnv, targets: WorktreeControl[], window?: unknown): Promise<SleepInspection> {
  const blockersById = new Map(targets.map((worktree) => [worktree.id, [] as CleanupBlocker[]]))
  let selected: SelectedWindow | null = null
  let closeView = false
  let noConnectedWindow = false
  if (window === undefined) {
    const stateEvidence = await readPublic(env.call, 'ui.state')
    const state = recordOf(stateEvidence.value)
    const layout = recordOf(state?.layout)
    noConnectedWindow = stateEvidence.error === null && Array.isArray(state?.windows) &&
      state.windows.length === 0 && layout?.view === null
  }
  if (!noConnectedWindow) {
    try {
      selected = await selectWindow(env, window)
    } catch (error) {
      const message = messageOf(error)
      const code = /multiple windows|ambiguous/i.test(message) ? 'ui-view-ambiguous' : 'ui-view-unknown'
      for (const blockers of blockersById.values()) addBlocker(blockers, code, `Could not inspect the selected workspace view before sleep: ${message}.`)
    }
  }
  if (selected?.view !== null && selected !== null) {
    const view = recordOf(selected.view)
    const input = recordOf(view?.input)
    if (!view || (view.id === 'view:quirky.session/worktree' && !input)) {
      for (const blockers of blockersById.values()) {
        addBlocker(blockers, 'ui-view-unknown', 'The open workspace view does not expose its exact worktree identity.')
      }
    } else {
      const activeId = typeof input?.worktree === 'string' ? input.worktree : null
      const activePath = typeof input?.path === 'string' ? input.path : null
      closeView = targets.some((worktree) =>
        activeId === worktree.id || (activePath !== null && pathIsWithin(worktree.path, activePath))
      )
    }
  }
  return {
    preview: {
      worktrees: targets.map((worktree) => {
        const blockers = blockersById.get(worktree.id) ?? []
        return {
          worktreeId: worktree.id,
          name: worktree.name,
          sleeping: worktree.sleeping,
          allowed: blockers.length === 0,
          blockers
        }
      })
    },
    closeView,
    selected
  }
}

export async function previewSleep(
  env: ControlEnv,
  params: SleepParams,
  identity: CallerIdentity
): Promise<WorktreeSleepPreview> {
  const targets = await sleepTargets(env, params, identity)
  return (await inspectSleep(env, targets, params.window)).preview
}

async function setSleepState(env: ControlEnv, params: SleepParams, identity: CallerIdentity, sleeping: boolean): Promise<{ worktrees: WorktreeSleepState[] }> {
  const targets = await sleepTargets(env, params, identity)
  if (sleeping) {
    const inspection = await inspectSleep(env, targets, params.window)
    const blocked = inspection.preview.worktrees.filter((row) => !row.allowed)
    if (blocked.length > 0) {
      const detail = blocked.map((row) => `${row.name}: ${row.blockers.map((blocker) => blocker.detail).join(' ')}`).join(' ')
      throw env.fail('conflict', `Could not sleep the selected workspace subtree. ${detail}`, { reason: 'sleep-view-unsafe', worktrees: blocked })
    }
    if (inspection.closeView && inspection.selected?.view) {
      await closeWindowView(env, { ...inspection.selected, view: inspection.selected.view })
    }
  }
  const changedAt = Date.now()
  env.store.transaction(() => {
    for (const worktree of targets) {
      env.store.run('UPDATE worktrees SET sleeping = ?, sleep_changed_at = ? WHERE id = ?', sleeping ? 1 : 0, changedAt, worktree.id)
    }
  })
  for (const worktree of targets) env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  return { worktrees: targets.map((worktree) => ({ worktreeId: worktree.id, sleeping, changedAt })) }
}

export function sleepWorktree(env: ControlEnv, params: SleepParams, identity: CallerIdentity) {
  return setSleepState(env, params, identity, true)
}

export function wakeWorktree(env: ControlEnv, params: SleepParams, identity: CallerIdentity) {
  return setSleepState(env, params, identity, false)
}

async function readWindowEvidence(call: PublicCall): Promise<WindowEvidence> {
  const publicState = await readPublic(call, 'ui.state')
  if (publicState.error !== null) return { layouts: null, connIds: [], error: publicState.error, malformed: false }
  const state = recordOf(publicState.value)
  if (!Array.isArray(state?.windows)) return { layouts: null, connIds: [], error: null, malformed: true }
  const connIds: number[] = []
  const layouts: WindowLayoutEvidence[] = []
  for (const raw of state.windows) {
    const window = recordOf(raw)
    if (!window || typeof window.connId !== 'number' || !Number.isSafeInteger(window.connId) || window.connId < 1) {
      return { layouts: null, connIds, error: null, malformed: true }
    }
    const connId = window.connId
    connIds.push(connId)
    const selected = await readPublic(call, 'ui.window.state', { connId })
    if (selected.error !== null) return { layouts: null, connIds, error: selected.error, malformed: false }
    const selectedState = recordOf(selected.value)
    const layout = recordOf(selectedState?.layout)
    if (selectedState?.connId !== connId || !layout || !('view' in layout)) {
      return { layouts: null, connIds, error: null, malformed: true }
    }
    layouts.push({ connId, layout })
  }
  return { layouts, connIds, error: null, malformed: false }
}

async function readEditorState(env: ControlEnv): Promise<ReadEvidence> {
  return readPublic(env.call, 'quirky.editor/state')
}

async function readSidebarState(env: ControlEnv): Promise<ReadEvidence> {
  return readPublic(env.call, 'quirky.sidebar-extras/state')
}

function pathIsWithin(root: string, candidate: string): boolean {
  if (!isAbsolute(candidate)) return false
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

function addActiveBlockers(
  worktree: WorktreeControl,
  ui: WindowEvidence,
  sidebar: ReadEvidence,
  blockers: CleanupBlocker[]
): unknown[] {
  const identityParts: unknown[] = []
  if (ui.error !== null) {
    addBlocker(blockers, 'active-workspace-unknown', `Could not read canonical UI state: ${ui.error}.`)
    identityParts.push(['ui-state-error', ui.error, ui.connIds])
  } else if (ui.layouts === null) {
    addBlocker(blockers, 'active-workspace-unknown', 'Canonical UI state did not include valid per-window layouts.')
    identityParts.push(['window-identities', ui.connIds, 'malformed', ui.malformed])
  } else {
    identityParts.push(['window-identities', ui.connIds])
    for (const window of ui.layouts) {
      if (window.layout.view === null || window.layout.view === undefined) {
        identityParts.push([window.connId, null])
        continue
      }
      const view = recordOf(window.layout.view)
      const input = recordOf(view?.input)
      if (!view || !input) {
        addBlocker(blockers, 'active-workspace-unknown', `UI connection ${window.connId} has a view without exact workspace input.`)
        identityParts.push([window.connId, 'view-input-unknown'])
        continue
      }
      const activeId = typeof input.worktree === 'string' ? input.worktree : null
      const activePath = typeof input.path === 'string' ? input.path : null
      identityParts.push([window.connId, view.id ?? null, activeId, activePath])
      if (activeId === worktree.id || (activePath !== null && pathIsWithin(worktree.path, activePath))) {
        addBlocker(blockers, 'active-workspace', `This workspace is open in UI connection ${window.connId}.`)
      }
    }
  }
  if (sidebar.error !== null) {
    addBlocker(blockers, 'recent-visible-context-unknown', `Could not read sidebar visit history: ${sidebar.error}.`)
  } else {
    const state = recordOf(sidebar.value)
    const visits = recordOf(state?.visits)
    const active = recordOf(state?.active)
    if (!visits || (state?.active !== null && state?.active !== undefined && !active)) {
      addBlocker(blockers, 'recent-visible-context-unknown', 'Sidebar state did not include valid visit and activation evidence.')
    } else {
      const key = `${worktree.id}@${worktree.instanceId}`
      const visitedAt = visits[key]
      const now = Date.now()
      if (active?.worktreeId === worktree.id && active.instanceId === worktree.instanceId) {
        addBlocker(blockers, 'active-workspace', 'This workspace is the active sidebar workspace.')
      }
      if (typeof visitedAt === 'number' && Number.isFinite(visitedAt)) {
        identityParts.push(visitedAt)
        if (now - visitedAt < CLEANUP_IDLE_MS) {
          addBlocker(blockers, 'recent-visible-context', `This workspace was visible within the last ${Math.round(CLEANUP_IDLE_MS / DAY_MS)} days.`)
        }
      } else {
        identityParts.push(null)
      }
    }
  }
  return identityParts
}

function addEditorBlockers(worktree: WorktreeControl, editor: ReadEvidence, blockers: CleanupBlocker[]): unknown[] {
  if (editor.error !== null) {
    addBlocker(blockers, 'dirty-editor-unknown', `Could not inspect editor buffers: ${editor.error}.`)
    return [editor.error]
  }
  const state = recordOf(editor.value)
  if (!Array.isArray(state?.buffers) || !Array.isArray(state.closeRequests)) {
    addBlocker(blockers, 'dirty-editor-unknown', 'Editor state did not include buffers and close requests.')
    return ['malformed']
  }
  const buffers: Record<string, unknown>[] = []
  for (const raw of state.buffers) {
    const buffer = recordOf(raw)
    if (!buffer || typeof buffer.worktreeId !== 'string' || typeof buffer.id !== 'string' || typeof buffer.dirty !== 'boolean') {
      addBlocker(blockers, 'dirty-editor-unknown', 'An editor buffer had incomplete workspace or dirty-state evidence.')
      continue
    }
    buffers.push(buffer)
    if (buffer.worktreeId !== worktree.id) continue
    const external = buffer.external
    if (buffer.dirty || external === 'changed' || external === 'deleted') {
      addBlocker(blockers, 'dirty-editor-buffer', `Editor buffer ${String(buffer.relativePath ?? buffer.name ?? buffer.id)} has unsaved or externally changed content.`)
    }
  }
  const buffersById = new Map(buffers.map((buffer) => [buffer.id as string, buffer]))
  for (const raw of state.closeRequests) {
    const close = recordOf(raw)
    if (!close || typeof close.bufferId !== 'string' || typeof close.dirty !== 'boolean') {
      addBlocker(blockers, 'dirty-editor-unknown', 'An editor close request had incomplete dirty-state evidence.')
      continue
    }
    const buffer = buffersById.get(close.bufferId)
    if (buffer?.worktreeId === worktree.id && close.dirty) {
      addBlocker(blockers, 'dirty-editor-buffer', `Editor buffer ${String(buffer.relativePath ?? buffer.name ?? buffer.id)} has a pending dirty close decision.`)
    }
  }
  return buffers
    .filter((buffer) => buffer.worktreeId === worktree.id)
    .map((buffer) => [buffer.id, buffer.contentRevision, buffer.dirty, buffer.external])
}

async function gitBlockers(
  env: ControlEnv,
  worktree: WorktreeControl,
  repo: Repo | undefined,
  blockers: CleanupBlocker[]
): Promise<unknown[]> {
  if (!repo || repo.kind !== 'git') {
    addBlocker(blockers, 'git-status-error', 'The Git project for this workspace is unavailable.')
    return ['missing-project']
  }
  const evidence: unknown[] = []
  try {
    const registrations = await gitApi().listRegistrations(repo.path)
    const registration = registrations.find((entry) => worktreeIdForPath(entry.path) === worktree.id)
    if (!registration) {
      addBlocker(blockers, 'git-status-error', 'Git no longer reports this workspace registration.')
      evidence.push('registration-missing')
    } else if (registration.locked !== null) {
      addBlocker(blockers, 'locked', `Git has locked this workspace${registration.locked ? `: ${registration.locked}` : ''}.`)
      evidence.push(['locked', registration.locked])
    } else {
      evidence.push(['unlocked', null])
    }
  } catch (error) {
    addBlocker(blockers, 'git-status-error', `Could not inspect Git worktree registration: ${messageOf(error)}.`)
    evidence.push(['registration-error', messageOf(error)])
  }
  const statusResult = await readPublic(env.call, 'quirky.git/status', { worktree: worktree.id })
  if (statusResult.error !== null) {
    addBlocker(blockers, 'git-status-error', `Could not read Git status: ${statusResult.error}.`)
    return [...evidence, ['status-error', statusResult.error]]
  }
  const status = recordOf(statusResult.value)
  if (!status || !Array.isArray(status.entries) || !Array.isArray(status.files) || typeof status.capped !== 'boolean' || typeof status.operation !== 'string') {
    addBlocker(blockers, 'git-status-error', 'Git status did not include complete change and operation evidence.')
    return [...evidence, 'status-malformed']
  }
  const dirtyCount = Math.max(status.entries.length, status.files.length)
  if (dirtyCount > 0) addBlocker(blockers, 'dirty-files', `Git reports ${dirtyCount} changed or untracked file${dirtyCount === 1 ? '' : 's'}.`)
  if (status.capped) addBlocker(blockers, 'git-status-error', 'Git status was capped; cleanliness could not be established.')
  if (status.operation !== 'none') addBlocker(blockers, 'git-status-error', `Git operation ${status.operation} is in progress.`)
  if (status.busy !== null && status.busy !== undefined) addBlocker(blockers, 'git-status-error', `Git operation ${String(status.busy)} is still running.`)
  const upstream = recordOf(status.upstreamStatus)
  if (!upstream || typeof upstream.hasUpstream !== 'boolean') {
    addBlocker(blockers, 'git-status-error', 'Git status did not establish upstream state.')
    return [...evidence, ['dirty', dirtyCount], 'upstream-malformed']
  }
  if (upstream.hasUpstream) {
    if (!Number.isSafeInteger(upstream.ahead) || !Number.isSafeInteger(upstream.behind)) {
      addBlocker(blockers, 'git-status-error', 'Git upstream counts were incomplete.')
      evidence.push('upstream-counts-unknown')
    } else {
      if ((upstream.ahead as number) > 0) addBlocker(blockers, 'unpushed-commits', `The branch is ${String(upstream.ahead)} commit${upstream.ahead === 1 ? '' : 's'} ahead of ${String(upstream.name ?? 'its upstream')}.`)
      evidence.push(['upstream', upstream.name, upstream.ahead, upstream.behind])
    }
  } else {
    const compareResult = await readPublic(env.call, 'quirky.git/compare', {
      worktree: worktree.id,
      ...(worktree.baseRef ? { base: worktree.baseRef } : {})
    })
    if (compareResult.error !== null) {
      addBlocker(blockers, 'unknown-base', `Could not compare this branch with a safe base: ${compareResult.error}.`)
      evidence.push(['compare-error', compareResult.error])
    } else {
      const compare = recordOf(compareResult.value)
      if (!compare || compare.status !== 'ready' || !Number.isSafeInteger(compare.ahead) || !Number.isSafeInteger(compare.behind)) {
        const detail = typeof compare?.message === 'string' ? compare.message : 'Git did not establish a usable merge base.'
        addBlocker(blockers, 'unknown-base', detail)
        evidence.push(['compare-unknown', compare?.status ?? null, compare?.base ?? null, compare?.baseOid ?? null])
      } else {
        if ((compare.ahead as number) > 0) addBlocker(blockers, 'unpushed-commits', `The branch has ${String(compare.ahead)} commit${compare.ahead === 1 ? '' : 's'} beyond its known base.`)
        evidence.push(['base', compare.base, compare.baseOid, compare.headOid, compare.ahead, compare.behind])
      }
    }
  }
  evidence.push(['dirty', dirtyCount, status.capped, status.operation, status.busy ?? null])
  return evidence
}

function makeFingerprint(worktree: WorktreeControl, evidence: unknown[]): string {
  const activityDay = Math.floor(Math.max(worktree.lastActivityAt, worktree.createdAt) / DAY_MS)
  const value = JSON.stringify([
    2,
    worktree.id,
    worktree.instanceId,
    worktree.branch,
    worktree.head,
    worktree.baseRef,
    worktree.isMain,
    worktree.kind,
    worktree.pinned,
    worktree.parentId,
    worktree.projectGroupId,
    worktree.archivedAt,
    worktree.cleanupContext.volatile,
    worktree.cleanupContext.remoteConnected,
    activityDay,
    evidence
  ])
  return createHash('sha256').update(value).digest('hex')
}

function addWorktreeActivityBlockers(worktree: WorktreeControl, blockers: CleanupBlocker[]): void {
  if (worktree.isMain) addBlocker(blockers, 'main-worktree', 'The primary worktree cannot be deleted.')
  if (worktree.kind === 'folder') addBlocker(blockers, 'folder-repo', 'Folder workspaces are registrations, not stale Git worktrees.')
  if (worktree.pinned) addBlocker(blockers, 'pinned', 'Pinned workspaces are kept out of cleanup.')
}

async function buildCleanupSnapshot(env: ControlEnv): Promise<Snapshot> {
  const generatedAt = Date.now()
  const repos = await env.repos()
  const projectWorktrees = await Promise.all(repos.map(async (repo) => {
    try {
      return await listProject(env.list, repo, { prune: false })
    } catch (error) {
      throw env.fail('conflict', `Cleanup preview could not list worktrees in ${repo.name}: ${messageOf(error)}`, {
        reason: 'git-status-error',
        repoId: repo.id
      })
    }
  }))
  const groups = await env.list.groups()
  const worktrees = [...projectWorktrees.flat(), ...groups.flatMap((group) => listGroup(env.list, group))]
  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const childrenById = new Set(worktrees.flatMap((worktree) => worktree.parentId ? [worktree.parentId] : []))
  const [sessionEvidence, ui, editor, sidebar] = await Promise.all([
    readSessions(env.call),
    readWindowEvidence(env.call),
    readEditorState(env),
    readSidebarState(env)
  ])
  const candidates: CleanupCandidate[] = []
  for (const worktree of worktrees) {
    const lastActivity = Math.max(worktree.lastActivityAt, worktree.createdAt)
    const archivedEligible = worktree.archivedAt !== null && generatedAt - worktree.archivedAt >= 7 * DAY_MS
    if (!archivedEligible && (lastActivity <= 0 || generatedAt - lastActivity < CLEANUP_IDLE_MS)) continue
    const blockers: CleanupBlocker[] = []
    const fingerprintEvidence: unknown[] = []
    addWorktreeActivityBlockers(worktree, blockers)
    if (childrenById.has(worktree.id)) addBlocker(blockers, 'has-descendants', 'Remove eligible child workspaces first; cleanup never expands a selection to unselected descendants.')
    const sessionBlockerList = sessionBlockers(worktree.id, sessionEvidence)
    fingerprintEvidence.push(sessionBlockerList.map((blocker) => [blocker.code, blocker.detail]))
    for (const blocker of sessionBlockerList) addBlocker(blockers, blocker.code, blocker.detail)
    const terminal = await terminalVolatileEvidence(env.call, worktree.id, sessionEvidence)
    const repository = repoById.get(worktree.repoId)
    const remoteConnected = repository ? false : null
    worktree.cleanupContext = {
      ...worktree.cleanupContext,
      volatile: terminal.value,
      remoteConnected
    }
    fingerprintEvidence.push(terminal.evidence)
    fingerprintEvidence.push(['remote-execution-context', repository?.id ?? null, repository?.path ?? null, remoteConnected])
    if (terminal.value !== false) {
      addBlocker(blockers, 'volatile-local-context', terminal.detail ?? 'Live terminal context remains bound to this workspace.')
    }
    if (worktree.cleanupContext.remoteConnected === null) {
      addBlocker(blockers, 'remote-context-unknown', 'The worktree has no authoritative local repo or remote-host connectivity evidence.')
    }
    fingerprintEvidence.push(addActiveBlockers(worktree, ui, sidebar, blockers))
    fingerprintEvidence.push(addEditorBlockers(worktree, editor, blockers))
    if (worktree.kind === 'git') {
      fingerprintEvidence.push(await gitBlockers(env, worktree, repository, blockers))
    } else {
      fingerprintEvidence.push('folder-workspace')
    }
    const fingerprint = makeFingerprint(worktree, fingerprintEvidence)
    const row = rowOf(env.store, worktree.id)
    const ignored = row?.cleanup_ignored_fingerprint === fingerprint
    if (row?.cleanup_ignored_fingerprint && !ignored) {
      env.store.run('UPDATE worktrees SET cleanup_ignored_fingerprint = NULL, cleanup_ignored_at = NULL WHERE id = ?', worktree.id)
    }
    if (ignored) addBlocker(blockers, 'dismissed', 'This cleanup suggestion is ignored until its safety fingerprint changes or it is restored.')
    candidates.push({
      worktreeId: worktree.id,
      name: worktree.name,
      fingerprint,
      reason: archivedEligible ? 'archived-7day' : 'idle-clean',
      ignored,
      eligible: blockers.length === 0,
      blockers
    })
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name) || left.worktreeId.localeCompare(right.worktreeId))
  return { generatedAt, candidates, worktrees }
}

export async function cleanupPreview(env: ControlEnv): Promise<CleanupPreview> {
  const snapshot = await buildCleanupSnapshot(env)
  return { generatedAt: snapshot.generatedAt, candidates: snapshot.candidates }
}

export async function cleanupIgnore(
  env: ControlEnv,
  params: { worktreeId: string; fingerprint: string }
): Promise<{ ok: true }> {
  if (typeof params.worktreeId !== 'string' || typeof params.fingerprint !== 'string' || params.fingerprint.length === 0) {
    throw env.fail('invalid-params', 'worktreeId and fingerprint are required')
  }
  const snapshot = await buildCleanupSnapshot(env)
  const candidate = snapshot.candidates.find((row) => row.worktreeId === params.worktreeId)
  if (!candidate || candidate.fingerprint !== params.fingerprint) {
    throw env.fail('conflict', 'This cleanup suggestion changed; refresh the preview before ignoring it.', { reason: 'preview-stale' })
  }
  env.store.run(
    'UPDATE worktrees SET cleanup_ignored_fingerprint = ?, cleanup_ignored_at = ? WHERE id = ?',
    candidate.fingerprint,
    Date.now(),
    candidate.worktreeId
  )
  const worktree = snapshot.worktrees.find((row) => row.id === candidate.worktreeId)
  if (worktree) env.changed({ repoId: worktree.repoId, worktreeId: worktree.id })
  return { ok: true }
}

export function cleanupRestoreIgnored(env: ControlEnv): { restored: number } {
  const count = env.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM worktrees WHERE cleanup_ignored_fingerprint IS NOT NULL')?.count ?? 0
  env.store.run('UPDATE worktrees SET cleanup_ignored_fingerprint = NULL, cleanup_ignored_at = NULL WHERE cleanup_ignored_fingerprint IS NOT NULL')
  return { restored: count }
}

export async function cleanupRemove(
  env: ControlEnv,
  params: CleanupRemoveParams,
  identity: CallerIdentity
): Promise<{ results: CleanupRemovalResult[] }> {
  if (params.confirmed !== true) throw env.fail('invalid-params', 'confirmed must be true after the selected cleanup rows have been reviewed')
  if (!Array.isArray(params.selection) || params.selection.length === 0 || params.selection.some((item) =>
    !recordOf(item) || typeof item.worktreeId !== 'string' || typeof item.fingerprint !== 'string' || item.fingerprint.length === 0
  )) {
    throw env.fail('invalid-params', 'selection must contain worktreeId and fingerprint for each selected row')
  }
  const seen = new Set<string>()
  const results: CleanupRemovalResult[] = []
  for (const item of params.selection) {
    if (seen.has(item.worktreeId)) {
      results.push({ worktreeId: item.worktreeId, removed: false, error: 'Duplicate worktree selection was refused.' })
      continue
    }
    seen.add(item.worktreeId)
    try {
      const snapshot = await buildCleanupSnapshot(env)
      const candidate = snapshot.candidates.find((row) => row.worktreeId === item.worktreeId)
      if (!candidate || candidate.fingerprint !== item.fingerprint) {
        const blockers = candidate?.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join(' ') ?? ''
        results.push({
          worktreeId: item.worktreeId,
          removed: false,
          error: `Cleanup preview is stale; refresh and review this row again.${blockers ? ` ${blockers}` : ''}`
        })
        continue
      }
      if (!candidate.eligible) {
        results.push({
          worktreeId: item.worktreeId,
          removed: false,
          error: candidate.blockers.map((blocker) => `${blocker.code}: ${blocker.detail}`).join(' ')
        })
        continue
      }
      const target = snapshot.worktrees.find((worktree) => worktree.id === item.worktreeId)
      if (!target) {
        results.push({ worktreeId: item.worktreeId, removed: false, error: 'Workspace disappeared before canonical removal.' })
        continue
      }
      await removeWorktree(env.remove, { worktree: `id:${target.id}`, safeOnly: true }, identity)
      results.push({ worktreeId: item.worktreeId, removed: true })
    } catch (error) {
      results.push({ worktreeId: item.worktreeId, removed: false, error: messageOf(error) })
    }
  }
  return { results }
}
