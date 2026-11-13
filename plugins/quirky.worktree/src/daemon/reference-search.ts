import type { GitHubWorktreeLink, PtySessionInfo } from '@quirky/protocol'
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
    if (segment === '-' && parts[index + 1] === 'issues') {
      const item = itemForParts(url.host, parts.slice(0, index), '#', parts[index + 2]!)
      if (item) return item
    }
    if (segment === 'merge_requests') {
      const item = itemForParts(url.host, parts.slice(0, index), '!', parts[index + 1]!)
      if (item) return item
    }
    if (segment === '-' && parts[index + 1] === 'merge_requests') {
      const item = itemForParts(url.host, parts.slice(0, index), '!', parts[index + 2]!)
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
  if (!LIVE_STATUSES.has(String(session.status))) return 'unverifiable'
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
