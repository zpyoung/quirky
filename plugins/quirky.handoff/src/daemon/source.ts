import { isAbsolute, relative, sep } from 'node:path'
import type { GitDiff, GitStatus, Repo, Session, Worktree } from '@quirky/protocol'
import { boundCapture } from '../core'
import { DIFF_CHAR_CAP } from '../core/repo-state'
import type { Candidate, Preview, RepoStateResult, SourceInfo, SourceRef } from './types'

/** Calls another plugin's method; the plugin context's `call`. */
export type Call = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const CAPTURE_LINES = 800

type StatusRow = {
  state?: string
  prompt?: string
  lastAssistantMessage?: string
}

const nonEmpty = (value: string | null | undefined): string | null => (value ? value : null)

/** The key drafts and cached captures use: one per live session, one per archived transcript. */
export function sourceKey(ref: SourceRef): string {
  if ('session' in ref) return `session:${ref.session}`
  const { agent, providerSessionId, transcriptPath } = ref.archived
  return `archived:${agent}:${providerSessionId ?? transcriptPath ?? ''}`
}

const contains = (folder: string, path: string): boolean => {
  const base = folder.endsWith(sep) ? folder.slice(0, -1) : folder
  return path === base || path.startsWith(base + sep)
}

async function worktreesOf(call: Call): Promise<Worktree[]> {
  return (await call('quirky.worktree/list', {})) as Worktree[]
}

async function archivedWorktree(call: Call, selector: string | undefined, cwd: string | undefined): Promise<string | null> {
  if (selector) {
    try {
      return ((await call('quirky.worktree/resolve', { selector })) as Worktree).id
    } catch {
      return null
    }
  }
  if (!cwd) return null
  try {
    const holders = (await worktreesOf(call)).filter((worktree) => contains(worktree.path, cwd))
    holders.sort((a, b) => b.path.length - a.path.length)
    return holders[0]?.id ?? null
  } catch {
    return null
  }
}

/**
 * Reads what a source says about itself: a live session from the session plugin and the agent
 * status row, or an archived source from its own fields. Never writes to the source.
 */
export async function resolveSource(call: Call, ref: SourceRef): Promise<SourceInfo> {
  if ('session' in ref) {
    const session = (await call('quirky.session/get', { session: ref.session })) as Session
    let row: StatusRow | null = null
    try {
      row = (await call('quirky.agent-status/get', { session: session.id })) as StatusRow | null
    } catch {
      row = null
    }
    const info: SourceInfo = {
      key: sourceKey(ref),
      session: session.id,
      agent: session.agent,
      title: nonEmpty(session.title),
      cwd: nonEmpty(session.cwd),
      worktreeId: session.worktreeId,
      providerSessionId: session.providerSession?.id ?? null,
      transcriptPath: nonEmpty(session.providerSession?.transcriptPath),
      prompt: nonEmpty(row?.prompt),
      lastMessage: nonEmpty(row?.lastAssistantMessage),
      live: session.status !== 'exited',
      busy: row?.state === 'working'
    }
    return info
  }
  const { archived } = ref
  const info: SourceInfo = {
    key: sourceKey(ref),
    session: null,
    agent: archived.agent,
    title: nonEmpty(archived.title),
    cwd: nonEmpty(archived.cwd),
    worktreeId: await archivedWorktree(call, archived.worktree, archived.cwd),
    providerSessionId: nonEmpty(archived.providerSessionId),
    transcriptPath: nonEmpty(archived.transcriptPath),
    prompt: nonEmpty(archived.prompt),
    lastMessage: nonEmpty(archived.lastMessage),
    live: false,
    busy: false
  }
  return info
}

export type Destination = {
  candidates: Candidate[]
  canCreateWorktree: boolean
  /** The source's own worktree when it is among the candidates. */
  home: Worktree | null
}

/** A preview with what it was read from: the source itself and where it can go. */
export type Composition = { preview: Preview; info: SourceInfo; destination: Destination }

const candidateOf = (worktree: Worktree): Candidate => ({
  id: worktree.id,
  name: worktree.name,
  path: worktree.path,
  kind: worktree.kind,
  branch: worktree.branch
})

/**
 * Where a handoff can go: the source repo's worktrees plus folder workspaces that contain the
 * repo, or only the source's own folder for a folder source. An archived source with no known
 * worktree can go to any workspace but cannot create one.
 */
export async function destinationOf(call: Call, info: SourceInfo): Promise<Destination> {
  const all = await worktreesOf(call)
  const home = info.worktreeId === null ? null : (all.find((worktree) => worktree.id === info.worktreeId) ?? null)
  if (home === null) {
    return { candidates: info.session === null ? all.map(candidateOf) : [], canCreateWorktree: false, home: null }
  }
  if (home.kind === 'folder' || home.repoId.startsWith('group:')) {
    return { candidates: [candidateOf(home)], canCreateWorktree: false, home }
  }
  let repo: Repo | null = null
  try {
    repo = ((await call('quirky.repo/show', { repo: home.repoId })) as { repo: Repo }).repo
  } catch {
    repo = null
  }
  const repoPath = repo?.path
  const members = all.filter(
    (worktree) =>
      worktree.repoId === home.repoId || (repoPath !== undefined && worktree.kind === 'folder' && contains(worktree.path, repoPath))
  )
  return { candidates: members.map(candidateOf), canCreateWorktree: repo?.kind === 'git', home }
}

/** The agents a handoff can start: installed and enabled, in the agent plugin's order. */
export async function listAgents(
  call: Call
): Promise<{ state: 'ready' | 'failed'; list: { id: string; label: string }[]; defaultAgent: string | null }> {
  try {
    const result = (await call('quirky.agents/list', {})) as {
      defaultAgent?: string
      agents: { id: string; label: string; installed: boolean; enabled: boolean }[]
    }
    return {
      state: 'ready',
      list: result.agents.filter((agent) => agent.installed && agent.enabled).map(({ id, label }) => ({ id, label })),
      defaultAgent: typeof result.defaultAgent === 'string' ? result.defaultAgent : null
    }
  } catch {
    return { state: 'failed', list: [], defaultAgent: null }
  }
}

/** The bounded capture of a session's terminal, or null when it has no readable history. */
export async function readCapture(call: Call, sessionId: string): Promise<string | null> {
  const pages: string[][] = []
  let count = 0
  let before: string | undefined
  try {
    while (count < CAPTURE_LINES) {
      const page = (await call('quirky.terminal/history', {
        session: sessionId,
        lines: CAPTURE_LINES - count,
        format: 'text',
        ...(before === undefined ? {} : { before })
      })) as { lines: string[]; cursor: string | null }
      pages.unshift(page.lines)
      count += page.lines.length
      if (!page.cursor || page.lines.length === 0) break
      before = page.cursor
    }
  } catch {
    if (pages.length === 0) return null
  }
  return boundCapture(pages.flat().slice(-CAPTURE_LINES))
}

/** The transcript paths other live sessions report, which a project scan must not claim. */
export async function claimedTranscripts(call: Call, except: string | null): Promise<Set<string>> {
  const claimed = new Set<string>()
  try {
    for (const session of (await call('quirky.session/list', {})) as Session[]) {
      const path = session.providerSession?.transcriptPath
      if (session.id !== except && session.status !== 'exited' && path) claimed.add(path)
    }
  } catch {
    return claimed
  }
  return claimed
}

/**
 * The git status of a worktree and, when `withDiffs` is set, one diff per changed file until the
 * diff cap is reached. Rejects when the status call fails; a diff that fails is left out.
 */
export async function readRepoState(call: Call, worktreeId: string, withDiffs: boolean): Promise<RepoStateResult> {
  const worktree = `id:${worktreeId}`
  const status = (await call('quirky.git/status', { worktree })) as GitStatus
  if (!withDiffs) return { status }
  const diffs: GitDiff[] = []
  let size = 0
  for (const entry of status.entries) {
    if (size > DIFF_CHAR_CAP) break
    try {
      const diff = (await call('quirky.git/diff', {
        worktree,
        path: entry.path,
        source: entry.area === 'staged' ? 'staged' : 'unstaged',
        ...(entry.oldPath ? { oldPath: entry.oldPath } : {})
      })) as GitDiff
      diffs.push(diff)
      size += diff.original.length + diff.modified.length
    } catch {
      continue
    }
  }
  return { status, diffs }
}

/**
 * Reads the editor's open tabs for a worktree, in tab order. Null when no editor answers, so the
 * brief leaves the block out.
 */
export async function readEditorTabs(call: Call, worktree: { id: string; path: string }): Promise<string[] | null> {
  let result: unknown
  try {
    result = await call('quirky.editor/state', { worktree: worktree.id })
  } catch {
    return null
  }
  if (typeof result !== 'object' || result === null) return null
  const state = result as { buffers?: unknown; tabs?: unknown }
  if (!Array.isArray(state.buffers) || !Array.isArray(state.tabs)) return null
  if (typeof worktree.path !== 'string' || !isAbsolute(worktree.path)) return []

  const pathsByBuffer = new Map<string, string>()
  for (const value of state.buffers) {
    if (typeof value !== 'object' || value === null) continue
    const buffer = value as { id?: unknown; path?: unknown; relativePath?: unknown }
    if (
      typeof buffer.id !== 'string' ||
      buffer.id === '' ||
      typeof buffer.path !== 'string' ||
      !isAbsolute(buffer.path) ||
      typeof buffer.relativePath !== 'string'
    ) continue
    const path = relative(worktree.path, buffer.path)
    if (
      path === '' ||
      path === '..' ||
      path.startsWith(`..${sep}`) ||
      isAbsolute(path) ||
      buffer.relativePath !== path
    ) continue
    if (!pathsByBuffer.has(buffer.id)) pathsByBuffer.set(buffer.id, path)
  }

  const paths: string[] = []
  const seen = new Set<string>()
  for (const value of state.tabs) {
    if (typeof value !== 'object' || value === null) continue
    const tab = value as { tabId?: unknown; bufferId?: unknown }
    if (typeof tab.tabId !== 'string' || tab.tabId === '' || typeof tab.bufferId !== 'string') continue
    const path = pathsByBuffer.get(tab.bufferId)
    if (path === undefined || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}
