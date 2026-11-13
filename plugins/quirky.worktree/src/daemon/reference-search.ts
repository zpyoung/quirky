import { basename } from 'node:path'
import type { GitHubWorktreeLink, PluginStore, PtySessionInfo, Repo } from '@quirky/protocol'
import { SelectorSyntaxError, matchWorktrees, type CallerIdentity, type SelectableWorktree } from '../../selector'
import type { DirectoryIdentitySource } from './identity'
import { folderStateOf } from './list'
import { metadataOf, type WorktreeRow } from './store'
import type {
  ReferenceItem,
  ReferenceSearchLink,
  ReferenceSearchMatch,
  ReferenceSearchQuery,
  ReferenceSearchResult,
  ReferenceSearchSession,
  ReferenceSessionLiveness
} from '../parity-types'
import type { WorktreeReference } from '../parity-types'

export class ReferenceQueryError extends Error {}

export type StoredWorktree = ReferenceSearchMatch['worktree'] & {
  references: WorktreeReference[]
  linkedPR: GitHubWorktreeLink | null
  linkedIssue: GitHubWorktreeLink | null
}

const KEY_EXAMPLE = 'query must be an owner/repo#123 or owner/repo!123 key'
const URL_EXAMPLE = 'query must be an absolute HTTP or HTTPS URL'
const MAX_QUERY_LENGTH = 2_048
const LINK_LIMIT = 20
const SESSION_LIMIT = 20
const LIVE_STATUSES = new Set(['starting', 'running', 'working', 'waiting', 'done'])

function validProject(project: string): boolean {
  const segments = project.split('/')
  return segments.length >= 2 && segments.every((segment) =>
    segment !== '' && segment !== '.' && segment !== '..' && segment !== '-' && !/[\s#!?]/.test(segment)
  )
}

function itemForParts(host: string, projectParts: string[], sigil: '#' | '!', numberText: string): ReferenceItem | null {
  const project = projectParts.join('/')
  if (!validProject(project) || !/^[1-9]\d*$/.test(numberText)) return null
  const number = Number(numberText)
  if (!Number.isSafeInteger(number)) return null
  const normalizedHost = host.toLowerCase()
  const normalizedProject = project.toLowerCase()
  return {
    id: `${normalizedHost}/${normalizedProject}${sigil}${number}`,
    host: normalizedHost,
    project: normalizedProject,
    sigil,
    number
  }
}

function itemFromUrl(url: URL): ReferenceItem | null {
  const parts = url.pathname.split('/').slice(1)
  for (let index = 2; index < parts.length - 2; index++) {
    if (parts[index] !== '-') continue
    const route = parts[index + 1]
    if (route === 'issues' || route === 'merge_requests') {
      return itemForParts(url.host, parts.slice(0, index), route === 'issues' ? '#' : '!', parts[index + 2]!)
    }
  }
  if (parts.length >= 4 && parts[2] === 'pull') {
    const item = itemForParts(url.host, parts.slice(0, 2), '#', parts[3]!)
    if (item) return item
  }
  for (let index = 2; index < parts.length - 1; index++) {
    const segment = parts[index]!
    if (segment === 'issues') {
      const item = itemForParts(url.host, parts.slice(0, index), '#', parts[index + 1]!)
      if (item) return item
    }
    if (segment === 'merge_requests') {
      const item = itemForParts(url.host, parts.slice(0, index), '!', parts[index + 1]!)
      if (item) return item
    }
  }
  return null
}

/** Parses a full HTTP(S) URL or a hostless owner/repo#N or owner/repo!N key. */
export function parseReferenceQuery(value: unknown): ReferenceSearchQuery {
  if (typeof value !== 'string' || value.trim() === '') throw new ReferenceQueryError(KEY_EXAMPLE)
  if (value.length > MAX_QUERY_LENGTH) {
    throw new ReferenceQueryError(`${KEY_EXAMPLE}; query must be at most ${MAX_QUERY_LENGTH} characters`)
  }
  const text = value.trim()
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new ReferenceQueryError(URL_EXAMPLE)
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
      throw new ReferenceQueryError(URL_EXAMPLE)
    }
    url.username = ''
    url.password = ''
    return { kind: 'url', url: url.href, item: itemFromUrl(url)?.id ?? null }
  }

  const match = /^(.+)([#!])([1-9]\d*)$/.exec(text)
  if (!match || !validProject(match[1]!)) throw new ReferenceQueryError(KEY_EXAMPLE)
  const sigil = match[2] === '!' ? '!' : '#'
  const number = Number(match[3])
  if (!Number.isSafeInteger(number)) throw new ReferenceQueryError(KEY_EXAMPLE)
  const key = `${match[1]!.toLowerCase()}${sigil}${number}`
  return { kind: 'key', key }
}

/** Recognizes issue and review URLs by path shape on any HTTP(S) host; fragments and suffix paths do not change the item. */
export function referenceItemOf(value: string): ReferenceItem | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return itemFromUrl(url)
  } catch {
    return null
  }
}

/** Determines liveness from status and runner evidence; terminal records need a live PTY, structured records do not. */
export function sessionLiveness(session: Record<string, unknown>, processes: PtySessionInfo[] | null): ReferenceSessionLiveness {
  if (session.status === 'exited') return 'exited'
  if (typeof session.status !== 'string' || !LIVE_STATUSES.has(session.status)) return 'unverifiable'
  if (session.kind === 'structured') return 'live'
  if (session.kind !== 'terminal' || typeof session.id !== 'string' || processes === null) return 'unverifiable'
  const process = processes.find((candidate) => candidate.sessionId === session.id)
  return process?.state === 'running' && process.alive === true ? 'live' : 'unverifiable'
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function itemKey(item: ReferenceItem): string {
  return `${item.project}${item.sigil}${item.number}`
}

function plainUrlKey(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.host.toLowerCase()}\n${path}\n${url.search}`
  } catch {
    return null
  }
}

function referenceLinks(worktree: StoredWorktree): ReferenceSearchLink[] {
  const links: ReferenceSearchLink[] = worktree.references.map((reference) => ({
    source: 'reference',
    referenceId: reference.id,
    url: reference.url,
    label: reference.label,
    item: referenceItemOf(reference.url)?.id ?? null
  }))
  for (const [source, link] of [['linkedPR', worktree.linkedPR], ['linkedIssue', worktree.linkedIssue]] as const) {
    if (!link) continue
    links.push({ source, referenceId: null, url: link.url, label: link.title, item: referenceItemOf(link.url)?.id ?? null })
  }
  return links
}

function linkMatches(query: ReferenceSearchQuery, link: ReferenceSearchLink): boolean {
  if (query.kind === 'key') {
    if (link.item === null) return false
    const item = referenceItemOf(link.url)
    return item !== null && itemKey(item) === query.key
  }
  if (query.item !== null) return link.item === query.item
  return plainUrlKey(link.url) !== null && plainUrlKey(link.url) === plainUrlKey(query.url)
}

function sessionFromRecord(record: Record<string, unknown>, processes: PtySessionInfo[] | null): ReferenceSearchSession {
  return {
    id: record.id as string,
    name: typeof record.name === 'string' ? record.name : null,
    title: typeof record.title === 'string' ? record.title : '',
    agent: typeof record.agent === 'string' ? record.agent : '',
    kind: typeof record.kind === 'string' ? record.kind : '',
    status: typeof record.status === 'string' ? record.status : '',
    liveness: sessionLiveness(record, processes),
    linked: false,
    lastActivityAt: typeof record.lastActivityAt === 'number' ? record.lastActivityAt : 0
  }
}

function compareSessions(left: ReferenceSearchSession, right: ReferenceSearchSession): number {
  const rank: Record<ReferenceSessionLiveness, number> = { live: 0, unverifiable: 1, exited: 2 }
  return rank[left.liveness] - rank[right.liveness] ||
    right.lastActivityAt - left.lastActivityAt ||
    compareText(left.id, right.id)
}

/**
 * Searches only the supplied stored links. URL comparison ignores scheme, credentials, fragment and trailing slashes;
 * sessions always have linked:false because no stored session-to-reference association exists.
 */
export function searchReferences(input: {
  query: ReferenceSearchQuery
  worktrees: StoredWorktree[]
  includeArchived: boolean
  limit: number
  sessions: { rows: unknown[] } | { error: string }
  processes: { rows: PtySessionInfo[] } | { error: string }
}): ReferenceSearchResult {
  const items = new Map<string, ReferenceItem>()
  const candidates: { worktree: StoredWorktree; links: ReferenceSearchLink[] }[] = []
  for (const worktree of input.worktrees) {
    const links = referenceLinks(worktree).filter((link) => linkMatches(input.query, link))
    if (links.length === 0) continue
    candidates.push({ worktree, links })
    for (const link of links) {
      if (link.item === null) continue
      const item = referenceItemOf(link.url)
      if (item) items.set(item.id, item)
    }
  }

  const archivedOmitted = input.includeArchived
    ? 0
    : candidates.filter(({ worktree }) => worktree.archivedAt !== null).length
  const eligible = candidates
    .filter(({ worktree }) => input.includeArchived || worktree.archivedAt === null)
    .sort((left, right) => right.worktree.lastActivityAt - left.worktree.lastActivityAt || compareText(left.worktree.id, right.worktree.id))
  const total = eligible.length

  const sessionsUnavailable = 'error' in input.sessions
  const processesUnavailable = 'error' in input.processes
  const processRows = processesUnavailable ? null : input.processes.rows
  const byWorktree = new Map<string, ReferenceSearchSession[]>()
  let skippedSessions = 0
  if (!sessionsUnavailable) {
    for (const value of input.sessions.rows) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        skippedSessions++
        continue
      }
      const record = value as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.worktreeId !== 'string') {
        skippedSessions++
        continue
      }
      const list = byWorktree.get(record.worktreeId) ?? []
      list.push(sessionFromRecord(record, processRows))
      byWorktree.set(record.worktreeId, list)
    }
  }

  const matches: ReferenceSearchMatch[] = eligible.slice(0, input.limit).map(({ worktree, links }) => {
    const sessions = sessionsUnavailable
      ? null
      : (byWorktree.get(worktree.id) ?? []).sort(compareSessions)
    return {
      worktree: {
        id: worktree.id,
        repoId: worktree.repoId,
        name: worktree.name,
        path: worktree.path,
        kind: worktree.kind,
        archivedAt: worktree.archivedAt,
        lastActivityAt: worktree.lastActivityAt,
        state: worktree.state,
        staleReason: worktree.staleReason
      },
      links: links.slice(0, LINK_LIMIT),
      linkTotal: links.length,
      sessions: sessions === null ? null : sessions.slice(0, SESSION_LIMIT),
      sessionTotal: sessions === null ? null : sessions.length
    }
  })

  const foundItems = [...items.values()].sort((left, right) => compareText(left.id, right.id))
  return {
    query: input.query,
    items: foundItems,
    ambiguous: foundItems.length > 1,
    matches,
    total,
    truncated: total > input.limit,
    archivedOmitted,
    stale: matches.filter(({ worktree }) => worktree.state === 'stale').length,
    evidence: {
      sessions: sessionsUnavailable ? 'unavailable' : 'listed',
      sessionsReason: sessionsUnavailable ? input.sessions.error : null,
      processes: processesUnavailable ? 'unavailable' : 'listed',
      processesReason: processesUnavailable ? input.processes.error : null,
      skippedSessions
    }
  }
}
export type ReferenceSearchEnv = {
  store: Pick<PluginStore, 'all' | 'get'>
  identitySource: DirectoryIdentitySource
  repoIds(): Promise<string[]>
  resolveRepo(selector: string): Promise<Repo>
  sessions(): Promise<unknown>
  processes(): Promise<PtySessionInfo[]>
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
}

/** Reads every stored worktree and marks stale folders or projects without writing to the store. */
export function readStoredWorktrees(
  env: Pick<ReferenceSearchEnv, 'store' | 'identitySource'>,
  liveRepoIds: ReadonlySet<string>
): StoredWorktree[] {
  return env.store.all<WorktreeRow>('SELECT * FROM worktrees ORDER BY id').map((row): StoredWorktree => {
    const metadata = metadataOf(row)
    let staleReason: StoredWorktree['staleReason'] = null
    if (!liveRepoIds.has(row.repo_id) && !row.repo_id.startsWith('group:')) {
      staleReason = 'project-unregistered'
    } else {
      const folderState = folderStateOf(row, row.path, env.identitySource)
      if (folderState === 'missing') staleReason = 'folder-missing'
      else if (folderState === 'replaced') staleReason = 'folder-replaced'
    }
    return {
      id: row.id,
      repoId: row.repo_id,
      name: row.display_name || row.name || (row.path === null ? row.id : basename(row.path)),
      path: row.path,
      kind: row.kind,
      archivedAt: metadata.archivedAt,
      lastActivityAt: row.last_activity_at,
      state: staleReason === null ? 'present' : 'stale',
      staleReason,
      references: metadata.references,
      linkedPR: metadata.linkedPR ?? null,
      linkedIssue: metadata.linkedIssue ?? null
    }
  })
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolves selectors and evidence from stored rows only; repo resolution failures pass through unchanged. */
export async function findReferences(
  env: ReferenceSearchEnv,
  params: Record<string, unknown>,
  identity: CallerIdentity
): Promise<ReferenceSearchResult> {
  let query: ReferenceSearchQuery
  try {
    query = parseReferenceQuery(params.query)
  } catch (error) {
    if (error instanceof ReferenceQueryError) throw env.fail('invalid-params', error.message)
    throw error
  }

  if (params.includeArchived !== undefined && typeof params.includeArchived !== 'boolean') {
    throw env.fail('invalid-params', 'includeArchived must be a boolean')
  }
  const includeArchived = params.includeArchived === true
  if (params.limit !== undefined && (typeof params.limit !== 'number' || !Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200)) {
    throw env.fail('invalid-params', 'limit must be an integer from 1 to 200')
  }
  const limit = typeof params.limit === 'number' ? params.limit : 50
  if (params.worktree !== undefined && typeof params.worktree !== 'string') {
    throw env.fail('invalid-params', 'worktree must be a selector string')
  }
  if (params.repo !== undefined && typeof params.repo !== 'string') {
    throw env.fail('invalid-params', 'repo must be a selector string')
  }
  if (params.worktree !== undefined && params.repo !== undefined) {
    throw env.fail('invalid-params', 'worktree and repo cannot be used together')
  }

  const worktreeSelector = params.worktree as string | undefined
  if (worktreeSelector?.trim().startsWith('branch:')) {
    throw env.fail('invalid-params', 'branch selectors require git; use id:, name:, path: or current')
  }
  const repoSelector = params.repo as string | undefined
  const repo = repoSelector === undefined ? undefined : await env.resolveRepo(repoSelector)
  const liveRepoIds = new Set(await env.repoIds())
  let worktrees = readStoredWorktrees(env, liveRepoIds)

  if (repo !== undefined) {
    worktrees = worktrees.filter((worktree) => worktree.repoId === repo.id)
  } else if (worktreeSelector !== undefined) {
    const selectable = worktrees.map((stored): SelectableWorktree & { stored: StoredWorktree } => ({
      id: stored.id,
      name: stored.name,
      path: stored.path,
      branch: null,
      stored
    }))
    let matches: (typeof selectable)[number][]
    try {
      matches = matchWorktrees(selectable, worktreeSelector, identity)
    } catch (error) {
      if (error instanceof SelectorSyntaxError) throw env.fail('invalid-params', error.message)
      throw error
    }
    if (matches.length === 0) {
      throw env.fail('not-found', `no worktree matches ${worktreeSelector}; use id:, name:, branch:, path: or current`)
    }
    if (matches.length > 1) {
      const ids = matches.map(({ id }) => `id:${id}`)
      throw env.fail('conflict', `${worktreeSelector} matches ${ids.length} worktrees: ${ids.join(', ')}`, { matches: ids })
    }
    worktrees = matches.map(({ stored }) => stored)
  }

  const sessionResult = (async () => {
    try {
      const rows = await env.sessions()
      return Array.isArray(rows) ? { rows } : { error: 'quirky.session/list returned a non-array value' }
    } catch (error) {
      return { error: failureMessage(error) }
    }
  })()
  const processResult = (async () => {
    try {
      const rows = await env.processes()
      return Array.isArray(rows) ? { rows } : { error: 'PTY process list returned a non-array value' }
    } catch (error) {
      return { error: failureMessage(error) }
    }
  })()
  const [sessions, processes] = await Promise.all([sessionResult, processResult])
  return searchReferences({ query, worktrees, includeArchived, limit, sessions, processes })
}
