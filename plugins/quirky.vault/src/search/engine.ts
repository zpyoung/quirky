import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { HISTORY_AGENTS } from '../agents'
import type { Presence, SearchHit, SearchRequest, SearchResponse, SearchResults, VaultRole } from '../types'

/*
 * MIT License
 * Copyright (c) 2026 Lovecast Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const QUERY_MAX_CHARS = 512
const CANDIDATE_LIMIT = 600
const RECENT_PAGE_ROWS = 512
const RECENT_SCAN_FACTOR = 20
const SESSION_ID_BATCH = 500
const SNIPPET_TOKENS = 12
const SNIPPET_MAX_CHARS = 512
const CHUNK_TARGET_CHARS = 8000
const TOOL_ROW_CHARS = 3072
const MAX_BODY_TERMS = 48
const MAX_QUERY_TERMS = 64
const MAX_TYPO_CANDIDATES = 4000
const MAX_TYPO_PROBES = 8
const MAX_TYPO_ROWS = 64
const MIN_TYPO_LENGTH = 4
const MAX_TYPO_LENGTH = 40
const MIN_TYPO_FREQUENCY = 2
const MIN_TYPO_SIMILARITY = 0.82
const LENGTH_PRIOR = 0.02
const MARK_OPEN = '\uE000'
const MARK_CLOSE = '\uE001'
const MARK_ESCAPE = '\uE002'
const INDEX_TOKEN = /[\p{L}\p{N}\p{M}\p{Co}_./+-]+/gu
const STOP_WORDS = new Set(
  (
    'a an and are as at be but by for from how i if in into is it its of on or that the this to ' +
    'was were what when where which who why with you your we my me do does did not no can could ' +
    'should would about our us they them there their has have had been being so such then than ' +
    "these those there's im ive dont"
  ).split(' ')
)
const LITERAL_PATTERN =
  /[A-Za-z0-9_]*[a-z][A-Z][A-Za-z0-9_]*|\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b|\b\w{2,}[._]\w{2,}\b|\b[\w.-]+\/[\w/.-]+\b|\b\w+\.(ts|tsx|js|jsx|py|rs|go|json|md|sh|yml|yaml|toml|c|cc|h|java|sql)\b|#\d{3,}|\b[A-Z]{2,6}-\d{2,}\b|[(){};=]|::|->|--\w|\b(Error|Exception|Traceback|error:|warning:)\b/
const QUOTED_QUERY = /"[^"]{3,}"|'[^']{3,}'/
const RAW_IDENTIFIER = /[A-Za-z0-9_./-]+/g
const CAMEL_PIECE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g
const IDENTIFIER_INTERESTING = /[_./-]|[a-z0-9][A-Z]|^[A-Z]{2,}[0-9_]*$/
const FOLDED_DIACRITIC = /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d-\u032e\u0330-\u0331]/
const TOKEN_BOUNDARY = /[^\p{L}\p{N}\p{Co}_.\-/+\uD800-\uDFFF]/u
const HISTORY_AGENT_SET = new Set<string>(HISTORY_AGENTS)

type SessionRow = {
  id: number
  vault_id: string
  agent: string
  session_id: string
  file_path: string
  candidate_path: string
  codex_home: string | null
  source_root: string
  title: string
  cwd: string | null
  cwd_key: string | null
  branch: string | null
  created_at: number
  updated_at: number
  message_count: number
  content_hash: string | null
  content_hash_count: number
}
export type SearchSourceRecord = Pick<SessionRow, 'file_path' | 'candidate_path' | 'source_root'>

type MatchRow = { rowid: number; score: number; session_row_id: number; role: VaultRole; ts: number | null }
type SqlFilter = { conditions: string[]; values: (string | number)[] }
type QueryPlan = { literal: boolean; truncated: boolean; terms: string[]; body: string[]; phrase: string[] }
type QuerySplit = { text: string; repoTerms: string[]; pathTerms: string[] }
type Route = 'phrase' | 'and' | 'or' | 'typo+phrase' | 'typo+and' | 'typo+or'
type Retrieved = { rows: MatchRow[]; sessions: SessionRow[]; route: Route; plan: QueryPlan; repairedTerms?: { original: string; corrected: string }[]; incomplete: boolean }
type SnippetPiece = { kind: 'text'; value: string } | { kind: 'mark'; value: string }
type Snippet = { text: string; truncated: boolean }

const SESSION_COLUMNS = `s.id, s.vault_id, s.agent, s.session_id, s.file_path, s.codex_home,
  f.root AS source_root, f.path AS candidate_path, s.title, s.cwd, s.cwd_key, s.branch, s.created_at,
  s.updated_at, s.message_count, s.content_hash, s.content_hash_count`

export function ensureQuerySchema(db: Database): void {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab USING fts5vocab(messages_fts, 'row')")
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_vocab_instance USING fts5vocab(messages_fts, 'instance')")
}

export function readGeneration(db: Database): number {
  const row = db.prepare("SELECT CAST(value AS INTEGER) AS generation FROM meta WHERE key = 'index_generation'").get() as { generation?: number } | null
  return Number.isSafeInteger(row?.generation) ? row!.generation! : 0
}

export function searchIndex(
  db: Database,
  request: SearchRequest,
  retentionCutoffMs: number | null,
  sourcePresence: (session: SearchSourceRecord) => Presence
): SearchResponse {
  const startedAt = performance.now()
  validateRequest(request)
  if (request.within !== undefined) return { kind: 'unavailable', reason: 'scope-unknown' }
  const filters = request.filters ?? {}
  const requestedAgents = filters.agents
  const agents = requestedAgents?.filter(agent => HISTORY_AGENT_SET.has(agent))
  if (requestedAgents && requestedAgents.length > 0 && agents!.length === 0) {
    return { kind: 'unavailable', reason: 'unsupported-agent' }
  }
  const generation = readGeneration(db)
  const incarnation = readMeta(db, 'index_incarnation')
  const cappedQuery = sliceCodeUnits(request.query, QUERY_MAX_CHARS)
  const split = splitQuery(cappedQuery)
  const scope = request.scope ?? 'all'
  const sort = filters.sort ?? 'relevance'
  const sqlFilter = buildFilter({ ...filters, ...(requestedAgents ? { agents } : {}) }, retentionCutoffMs)
  const pageKey = pageIdentity(request)
  let offset = 0
  if (request.cursor !== undefined) {
    try {
      offset = decodeCursor(request.cursor, generation, pageKey, incarnation)
    } catch (error) {
      return { kind: error instanceof CursorFailure && error.reason === 'stale' ? 'stale-cursor' : 'malformed-cursor' }
    }
  }

  const plan = planQuery(split.text)
  const matchesOperator = operatorMatcher(split)
  let retrieved: Retrieved | null = null
  let ranked: RankedEntry[]
  let incomplete = false
  if (plan.terms.length === 0) {
    const recent = hasOperators(split)
      ? retrieveRecent(db, sqlFilter, matchesOperator)
      : { sessions: [], incomplete: false }
    ranked = rankSessions(recent.sessions, new Map(), 'newest')
    incomplete = recent.incomplete
  } else {
    retrieved = retrieveText(db, plan, scope, sort, sqlFilter, matchesOperator)
    ranked = rankSessions(
      retrieved.sessions,
      new Map(retrieved.rows.map(row => [row.session_row_id, row])),
      sort
    )
    incomplete = retrieved.incomplete
  }

  const limit = request.limit ?? 20
  const page = ranked.slice(offset, offset + limit)
  let snippetsTruncated = false
  const hits: SearchHit[] = page.map(entry => {
    const { session, match, score, duplicateCount } = entry
    const snippet = match && retrieved
      ? buildSnippet(db, scope, match.rowid, retrieved.plan, retrieved.route)
      : null
    if (snippet?.truncated) snippetsTruncated = true
    return {
      id: session.vault_id,
      agent: session.agent,
      sessionId: session.session_id,
      title: session.title,
      cwd: session.cwd,
      branch: session.branch,
      updatedAt: session.updated_at,
      messageCount: session.message_count,
      score,
      duplicateCount,
      source: {
        presence: sourcePresence(session),
        filePath: session.file_path,
        ...(session.codex_home ? { codexHome: session.codex_home } : {})
      },
      evidence: match && retrieved
        ? { snippet: snippet?.text ?? '', role: match.role, timestamp: match.ts }
        : hasOperators(split)
          ? { snippet: 'Match in session metadata', role: 'system', timestamp: null }
          : null
    }
  })
  if (readGeneration(db) !== generation) return { kind: 'stale-cursor' }
  const hasMore = ranked.length > offset + limit
  const result: SearchResults = {
    kind: 'results',
    hits,
    page: {
      hasMore,
      cursor: hasMore ? encodeCursor(generation, offset + limit, pageKey, incarnation) : null
    },
    generation,
    truncated: {
      candidates: incomplete,
      snippets: snippetsTruncated,
      query: cappedQuery.length < request.query.length || plan.truncated,
      freshness: false
    },
    durationMs: performance.now() - startedAt
  }
  if (retrieved?.repairedTerms) {
    result.repairedTerms = Object.fromEntries(retrieved.repairedTerms.map(term => [term.original, term.corrected]))
  }
  if (request.debug) {
    result.debug = {
      route: retrieved?.route ?? 'operator-only',
      scope,
      candidates: ranked.length,
      incomplete
    }
  }
  return result
}


function validateRequest(request: SearchRequest): void {
  if (!request || typeof request !== 'object' || typeof request.query !== 'string') throw new TypeError('Search query must be a string')
  if (request.query.length > 1_000_000) throw new TypeError('Search query exceeds the accepted input bound')
  if (request.cursor !== undefined && typeof request.cursor !== 'string') throw new TypeError('Invalid search cursor')
  if (request.filters !== undefined && (!request.filters || typeof request.filters !== 'object' || Array.isArray(request.filters))) throw new TypeError('Invalid search filters')
  if (request.scope !== undefined && request.scope !== 'all' && request.scope !== 'conversation') throw new TypeError('Invalid search scope')
  if (request.freshness !== undefined && request.freshness !== 'indexed' && request.freshness !== 'wait-until-current') throw new TypeError('Invalid search freshness')
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100)) throw new TypeError('Search limit must be an integer from 1 to 100')
  if (request.filters?.sort !== undefined && request.filters.sort !== 'relevance' && request.filters.sort !== 'newest') throw new TypeError('Invalid search sort')
  if (request.filters?.agents !== undefined && (!Array.isArray(request.filters.agents) || request.filters.agents.some(value => typeof value !== 'string'))) throw new TypeError('Invalid search agents')
  if (request.filters?.scopePaths !== undefined && (!Array.isArray(request.filters.scopePaths) || request.filters.scopePaths.length > 64 || request.filters.scopePaths.some(value => typeof value !== 'string'))) throw new TypeError('Search accepts at most 64 scope paths')
  if (request.filters?.since !== undefined && !validIsoOffset(request.filters.since)) throw new TypeError('Search since must be ISO 8601 with an explicit offset')
  if (request.within !== undefined && (!request.within || typeof request.within !== 'object')) throw new TypeError('Invalid search scope')
}

function validIsoOffset(value: string): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value))
}

function readMeta(db: Database, key: string): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | null
  return row?.value ?? ''
}

function sliceCodeUnits(value: string, limit: number): string {
  if (value.length <= limit) return value
  let end = limit
  const last = value.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return value.slice(0, end)
}

function splitQuery(query: string): QuerySplit {
  const spans: string[] = []
  const repoTerms: string[] = []
  const pathTerms: string[] = []
  let index = 0
  while (index < query.length) {
    if (/\s/.test(query[index]!)) { index += 1; continue }
    const operator = /^(repo|path):/i.exec(query.slice(index))
    if (operator) {
      const valueAt = index + operator[0].length
      const quoted = readQuoted(query, valueAt)
      const value = quoted?.value ?? readBare(query, valueAt)
      index = quoted ? quoted.end : valueAt + value.length
      const operand = value.trim()
      if (operand) (operator[1]!.toLowerCase() === 'repo' ? repoTerms : pathTerms).push(operand)
      continue
    }
    const quoted = readQuoted(query, index)
    const value = quoted?.value ?? readBare(query, index)
    const end = quoted ? quoted.end : index + value.length
    spans.push(query.slice(index, end))
    index = end
  }
  return { text: spans.join(' '), repoTerms, pathTerms }
}

function readQuoted(query: string, at: number): { value: string; end: number } | null {
  const quote = query[at]
  if (quote !== '"' && quote !== "'") return null
  const close = query.indexOf(quote, at + 1)
  return close < 0 ? null : { value: query.slice(at + 1, close), end: close + 1 }
}

function readBare(query: string, at: number): string {
  let end = at
  while (end < query.length && !/\s/.test(query[end]!)) end += 1
  return query.slice(at, end)
}

function hasOperators(split: QuerySplit): boolean {
  return split.repoTerms.length > 0 || split.pathTerms.length > 0
}

function operatorMatcher(split: QuerySplit): (session: SessionRow) => boolean {
  return session => {
    if (split.repoTerms.length > 0) {
      const cwd = session.cwd ?? ''
      const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('//')
      const normalized = windows ? cwd.replace(/\\/g, '/') : cwd
      const parts = normalized.normalize('NFC').split('/').filter(Boolean)
      const label = (parts.length >= 2 ? parts.slice(-2).join('/') : parts[0] ?? 'Unknown location').toLowerCase()
      if (split.repoTerms.some(term => !label.includes(term.toLowerCase()))) return false
    }
    if (split.pathTerms.length > 0) {
      const path = `${session.cwd ?? ''} ${session.file_path}`.toLowerCase()
      if (split.pathTerms.some(term => !path.includes(term.toLowerCase()))) return false
    }
    return true
  }
}

function isLiteralQuery(query: string): boolean {
  return QUOTED_QUERY.test(query) || LITERAL_PATTERN.test(query)
}

function indexTokens(query: string, limit = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = []
  INDEX_TOKEN.lastIndex = 0
  for (const match of query.matchAll(INDEX_TOKEN)) {
    const token = match[0]
    if (/[\p{L}\p{N}\p{Co}]/u.test(token)) {
      out.push(token)
      if (out.length >= limit) break
    }
  }
  return out
}

function planQuery(query: string, literal = isLiteralQuery(query)): QueryPlan {
  const overCap = indexTokens(query, MAX_BODY_TERMS + 1)
  const truncated = overCap.length > MAX_BODY_TERMS
  const raw = overCap.slice(0, MAX_BODY_TERMS)
  let body = literal ? raw : raw.filter(token => !STOP_WORDS.has(token.toLowerCase()))
  if (body.length < 2) body = raw
  const terms = [...new Set(body)]
  const extra: string[] = []
  for (const term of terms) {
    for (const piece of identifierShadowTerms(term, 12)) {
      if (!terms.includes(piece) && !STOP_WORDS.has(piece) && !extra.includes(piece)) extra.push(piece)
    }
  }
  return { literal, truncated, terms: [...terms, ...extra].slice(0, MAX_QUERY_TERMS), body, phrase: raw }
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

function phraseExpression(terms: readonly string[]): string { return quoteFtsTerm(terms.join(' ')) }
function andExpression(terms: readonly string[]): string { return terms.map(quoteFtsTerm).join(' AND ') }
function orExpression(terms: readonly string[]): string { return terms.map(quoteFtsTerm).join(' OR ') }
function scopedExpression(scope: 'conversation' | 'all', expression: string): string {
  return scope === 'all' ? expression : `{user_text assistant_text}: (${expression})`
}

function identifierShadowTerms(text: string, limit = 4000): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  RAW_IDENTIFIER.lastIndex = 0
  for (const match of text.matchAll(RAW_IDENTIFIER)) {
    const token = match[0]
    if (token.length < 3 || token.length > 120 || !IDENTIFIER_INTERESTING.test(token)) continue
    const parts: string[] = []
    for (const piece of token.split(/[_./-]+/)) {
      if (!piece) continue
      parts.push(piece)
      if (/[a-z]/.test(piece) && /[A-Z]/.test(piece)) {
        CAMEL_PIECE.lastIndex = 0
        parts.push(...(piece.match(CAMEL_PIECE) ?? []))
      }
    }
    for (const part of parts) {
      const lowered = part.toLowerCase()
      if (lowered.length < 2 || seen.has(lowered)) continue
      seen.add(lowered)
      out.push(lowered)
      if (out.length >= limit) return out
    }
  }
  return out
}

function buildFilter(
  filters: NonNullable<SearchRequest['filters']>,
  retentionCutoffMs: number | null
): SqlFilter {
  const result: SqlFilter = { conditions: [], values: [] }
  if (retentionCutoffMs !== null) {
    result.conditions.push('f.mtime_ms >= ?')
    result.values.push(retentionCutoffMs)
  }
  if (filters.agents !== undefined) {
    if (filters.agents.length === 0) result.conditions.push('0 = 1')
    else {
      result.conditions.push(`s.agent IN (${filters.agents.map(() => '?').join(',')})`)
      result.values.push(...filters.agents)
    }
  }
  if (filters.since) {
    result.conditions.push('s.updated_at >= ?')
    result.values.push(Date.parse(filters.since))
  }
  if (filters.scopePaths && filters.scopePaths.length > 0) {
    const conditions = filters.scopePaths.map((path): string | null => {
      const key = normalizePathKey(path)
      if (!key) return null
      const children = key.endsWith('/') ? key : `${key}/`
      result.values.push(key, children, nextAfterPrefix(children))
      return `(s.cwd_key = ? OR (s.cwd_key >= ? AND s.cwd_key < ?))`
    }).filter((condition): condition is string => condition !== null)
    result.conditions.push(conditions.length > 0 ? `(${conditions.join(' OR ')})` : '0 = 1')
  }
  return result
}

function normalizePathKey(value: string): string | null {
  if (!value) return null
  const nfc = value.normalize('NFC')
  const windows = /^[A-Za-z]:[\\/]/.test(nfc) || nfc.startsWith('\\\\') || nfc.startsWith('//')
  let normalized = windows ? nfc.replace(/\\/g, '/').replace(/\/{2,}/g, '/') : nfc.replace(/\/{2,}/g, '/')
  if (nfc.startsWith('\\\\') || nfc.startsWith('//')) normalized = `//${normalized.replace(/^\/+/, '')}`
  normalized = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
  const wsl = normalized.match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i)
  if (wsl) return `//wsl/${wsl[1]!.toLowerCase()}${wsl[2] ?? ''}`
  return windows ? normalized.toLowerCase() : normalized
}

function nextAfterPrefix(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
}

function filterWhere(filter: SqlFilter): string {
  return filter.conditions.length ? ` AND ${filter.conditions.join(' AND ')}` : ''
}

function eligibleSessionIds(filter: SqlFilter): string {
  return `m.session_row_id IN (SELECT s.id FROM sessions s JOIN files f ON f.session_row_id = s.id WHERE 1 = 1${filterWhere(filter)})`
}

function retrieveText(
  db: Database,
  initialPlan: QueryPlan,
  scope: 'conversation' | 'all',
  sort: 'relevance' | 'newest',
  filter: SqlFilter,
  matchesOperators: (session: SessionRow) => boolean
): Retrieved {
  let incomplete = false
  const match = (expression: string): MatchRow[] => {
    const weight = scope === 'all' ? '3.0, 2.0, 1.0, 1.0' : '3.0, 2.0, 0.0, 0.0'
    const order = sort === 'newest' ? 'updated_at DESC, score DESC' : 'score DESC'
    const eligibility = filterWhere(filter)
      ? ` AND ${eligibleSessionIds(filter)}`
      : ''
    const sql = `WITH matched AS MATERIALIZED (
      SELECT messages_fts.rowid AS rowid, -bm25(messages_fts, ${weight}) AS score,
        m.session_row_id, m.role, m.ts, s.updated_at
      FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.id = m.session_row_id
      JOIN files f ON f.session_row_id = s.id
      WHERE messages_fts MATCH ?${eligibility}
    )
    SELECT rowid, max(score) AS score, session_row_id, role, ts
    FROM matched GROUP BY session_row_id ORDER BY ${order} LIMIT ${CANDIDATE_LIMIT}`
    const rows = db.prepare(sql).all(scopedExpression(scope, expression), ...filter.values) as MatchRow[]
    incomplete = rows.length >= CANDIDATE_LIMIT
    return rows
  }
  const loadSessions = (rows: MatchRow[]): { rows: MatchRow[]; sessions: SessionRow[] } => {
    const ids = rows.map(row => row.session_row_id)
    const sessions: SessionRow[] = []
    for (let start = 0; start < ids.length; start += SESSION_ID_BATCH) {
      const batch = ids.slice(start, start + SESSION_ID_BATCH)
      const sql = `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN files f ON f.session_row_id = s.id
        WHERE s.id IN (${batch.map(() => '?').join(',')})${filterWhere(filter)}`
      sessions.push(...db.prepare(sql).all(...batch, ...filter.values) as SessionRow[])
    }
    const eligible = new Set(sessions.filter(matchesOperators).map(session => session.id))
    return { sessions, rows: rows.filter(row => eligible.has(row.session_row_id)) }
  }
  const first = phraseThenAnd(initialPlan, match)
  if (first) {
    const loaded = loadSessions(first.rows)
    return { ...loaded, route: first.route, plan: initialPlan, incomplete }
  }
  const repaired = repairPlan(db, initialPlan, scope, filter)
  const plan = repaired?.plan ?? initialPlan
  const second = repaired ? phraseThenAnd(plan, match) : null
  const found = second ?? { rows: match(orExpression(plan.terms)), route: 'or' as const }
  const loaded = loadSessions(found.rows)
  const route: Route = repaired
    ? (`typo+${found.route}` as Route)
    : found.route
  return {
    ...loaded,
    route,
    plan,
    ...(repaired ? { repairedTerms: repaired.repairs } : {}),
    incomplete
  }
}

function phraseThenAnd(
  plan: QueryPlan,
  match: (expression: string) => MatchRow[]
): { rows: MatchRow[]; route: 'phrase' | 'and' } | null {
  const tokens = plan.phrase
  if (tokens.length === 0 || (tokens.length < 2 && !plan.literal)) return null
  const phrase = match(phraseExpression(tokens))
  if (phrase.length > 0) return { rows: phrase, route: 'phrase' }
  if (tokens.length < 2) return null
  const and = match(andExpression(tokens))
  return and.length > 0 ? { rows: and, route: 'and' } : null
}

function repairPlan(
  db: Database,
  plan: QueryPlan,
  scope: 'conversation' | 'all',
  filter: SqlFilter
): { plan: QueryPlan; repairs: { original: string; corrected: string }[] } | null {
  const eligible = filterWhere(filter) ? ` AND ${eligibleSessionIds(filter)}` : ''
  const liveRows = db.prepare(`SELECT count(*) AS rows FROM (
    SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_row_id JOIN files f ON f.session_row_id = s.id
    WHERE messages_fts MATCH ?${eligible} LIMIT ${MAX_TYPO_ROWS})`)
  const hasPostings = (term: string) => {
    const row = liveRows.get(scopedExpression(scope, quoteFtsTerm(term)), ...filter.values) as { rows: number }
    return (row?.rows ?? 0) > 0
  }
  const repairable = new Set(plan.body.map(term => term.toLowerCase()))
  const repairs: { original: string; corrected: string }[] = []
  const phrase = plan.phrase.map(token => {
    const lowered = token.toLowerCase()
    if (!repairable.has(lowered) || lowered.length < MIN_TYPO_LENGTH || lowered.length > MAX_TYPO_LENGTH || hasPostings(lowered)) return token
    const corrected = bestCorrection(db, lowered, scope, filter, hasPostings)
    if (!corrected || corrected === lowered) return token
    repairs.push({ original: token, corrected })
    return corrected
  })
  if (repairs.length === 0) return null
  return { plan: planQuery(phrase.join(' '), plan.literal), repairs }
}

function bestCorrection(
  db: Database,
  term: string,
  scope: 'conversation' | 'all',
  filter: SqlFilter,
  hasPostings: (term: string) => boolean
): string | null {
  for (const prefix of [term.slice(0, 2), term[1]! + term[0]!, term[0]!]) {
    const upper = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)
    const colFilter = scope === 'conversation' ? " AND v.col IN ('user_text', 'assistant_text')" : ''
    const sql = `SELECT term FROM (
      SELECT DISTINCT v.term AS term FROM messages_vocab_instance v
      JOIN messages m ON m.id = v.doc JOIN sessions s ON s.id = m.session_row_id
      JOIN files f ON f.session_row_id = s.id
      WHERE v.term >= ? AND v.term < ? AND length(v.term) BETWEEN ? AND ?${colFilter}${filterWhere(filter)}
      ORDER BY v.term LIMIT ${MAX_TYPO_CANDIDATES}
    )`
    const candidates = db.prepare(sql).all(
      prefix, upper, Math.max(MIN_TYPO_LENGTH - 1, term.length - 2), term.length + 2, ...filter.values
    ) as { term: string }[]
    const ranked = candidates
      .map(candidate => ({ term: candidate.term, score: indelSimilarity(term, candidate.term) }))
      .filter(candidate => candidate.score >= MIN_TYPO_SIMILARITY)
      .sort((left, right) => right.score - left.score || (left.term < right.term ? -1 : left.term > right.term ? 1 : 0))
      .slice(0, MAX_TYPO_PROBES)
    let best: { term: string; score: number; rows: number } | null = null
    for (const candidate of ranked) {
      if (!hasPostings(candidate.term)) continue
      const frequency = liveTermFrequency(db, candidate.term, scope, filter)
      if (frequency < MIN_TYPO_FREQUENCY) continue
      if (!best || candidate.score > best.score || (candidate.score === best.score && frequency > best.rows)) {
        best = { ...candidate, rows: frequency }
      }
    }
    if (best) return best.term
  }
  return null
}

function liveTermFrequency(db: Database, term: string, scope: 'conversation' | 'all', filter: SqlFilter): number {
  const eligible = filterWhere(filter) ? ` AND ${eligibleSessionIds(filter)}` : ''
  const sql = `SELECT count(*) AS rows FROM (
    SELECT m.id FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
    JOIN sessions s ON s.id = m.session_row_id JOIN files f ON f.session_row_id = s.id
    WHERE messages_fts MATCH ?${eligible} LIMIT ${MAX_TYPO_ROWS}
  )`
  const row = db.prepare(sql).get(scopedExpression(scope, quoteFtsTerm(term)), ...filter.values) as { rows: number }
  return row?.rows ?? 0
}

function commonSubsequenceLength(left: string, right: string): number {
  let previous = new Array<number>(right.length + 1).fill(0)
  let current = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = left[i - 1] === right[j - 1]
        ? previous[j - 1]! + 1
        : Math.max(previous[j]!, current[j - 1]!)
    }
    ;[previous, current] = [current, previous]
  }
  return previous[right.length]!
}

function indelSimilarity(left: string, right: string): number {
  const total = left.length + right.length
  return total === 0 ? 1 : 2 * commonSubsequenceLength(left, right) / total
}

function retrieveRecent(
  db: Database,
  filter: SqlFilter,
  matchesOperators: (session: SessionRow) => boolean
): { sessions: SessionRow[]; incomplete: boolean } {
  const where = filter.conditions.length ? `WHERE ${filter.conditions.join(' AND ')}` : ''
  const sql = `SELECT ${SESSION_COLUMNS} FROM sessions s JOIN files f ON f.session_row_id = s.id
    ${where} ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`
  const page = db.prepare(sql)
  const ceiling = CANDIDATE_LIMIT * RECENT_SCAN_FACTOR
  const sessions: SessionRow[] = []
  let scanned = 0
  let incomplete = false
  while (sessions.length < CANDIDATE_LIMIT) {
    if (scanned >= ceiling) { incomplete = true; break }
    const rows = page.all(...filter.values, RECENT_PAGE_ROWS, scanned) as SessionRow[]
    if (rows.length === 0) break
    scanned += rows.length
    for (const row of rows) {
      if (sessions.length < CANDIDATE_LIMIT && matchesOperators(row)) sessions.push(row)
    }
  }
  return { sessions, incomplete: incomplete || sessions.length >= CANDIDATE_LIMIT }
}

type RankedEntry = { session: SessionRow; match: MatchRow | null; score: number; duplicateCount: number }

function rankSessions(
  sessions: readonly SessionRow[],
  matches: ReadonlyMap<number, MatchRow>,
  sort: 'relevance' | 'newest'
): RankedEntry[] {
  const grouped = new Map<string, RankedEntry[]>()
  for (const session of sessions) {
    const match = matches.get(session.id) ?? null
    const entry = {
      session,
      match,
      score: (match?.score ?? 0) - LENGTH_PRIOR * Math.log(1 + session.message_count),
      duplicateCount: 1
    }
    const key = session.content_hash && session.content_hash_count >= 2
      ? `hash:${session.content_hash}`
      : `session:${session.id}`
    const group = grouped.get(key)
    if (group) group.push(entry)
    else grouped.set(key, [entry])
  }
  const ranked: RankedEntry[] = []
  for (const group of grouped.values()) {
    if (group.length === 1) { ranked.push(group[0]!); continue }
    let winner = group[0]!
    for (const candidate of group.slice(1)) {
      if (candidate.session.updated_at > winner.session.updated_at ||
        (candidate.session.updated_at === winner.session.updated_at && candidate.score > winner.score)) winner = candidate
    }
    ranked.push({ ...winner, duplicateCount: group.length })
  }
  ranked.sort((left, right) =>
    (sort === 'newest' ? 0 : right.score - left.score) ||
    right.session.updated_at - left.session.updated_at ||
    left.session.id - right.session.id
  )
  return ranked
}

function buildSnippet(
  db: Database,
  scope: 'conversation' | 'all',
  rowid: number,
  plan: QueryPlan,
  route: Route
): Snippet {
  const columns = [0, 1, 2, -1]
  const select = columns.flatMap((column, index) => [
    `snippet(messages_fts, ${column}, '${MARK_OPEN}', '${MARK_CLOSE}', '…', ${SNIPPET_TOKENS}) AS c${index}`,
    `snippet(messages_fts, ${column}, '', '', '…', ${SNIPPET_TOKENS}) AS p${index}`
  ]).join(', ')
  const expression = route.endsWith('phrase')
    ? phraseExpression(plan.phrase)
    : route.endsWith('and')
      ? andExpression(plan.phrase)
      : orExpression(plan.terms)
  try {
    const row = db.prepare(`SELECT ${select} FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid JOIN sessions s ON s.id = m.session_row_id
      WHERE messages_fts MATCH ? AND messages_fts.rowid IN (SELECT ?)`)
      .get(scopedExpression(scope, expression), rowid) as Record<string, string> | null
    if (!row || Object.values(row).some(value => typeof value !== 'string')) return { text: '', truncated: false }
    const index = columns.findIndex((_column, at) => row[`c${at}`] !== row[`p${at}`])
    if (index < 0) return { text: '', truncated: false }
    const pieces = splitMarks(row[`c${index}`]!, row[`p${index}`]!)
    return pieces ? renderSnippet(pieces) : { text: '', truncated: false }
  } catch {
    return { text: '', truncated: false }
  }
}

function splitMarks(marked: string, plain: string): SnippetPiece[] | null {
  const rest = [...plain]
  const pieces: SnippetPiece[] = []
  let at = 0
  let run = ''
  for (const point of marked) {
    if (point === rest[at]) { run += point; at += 1; continue }
    if (point !== MARK_OPEN && point !== MARK_CLOSE) return null
    pieces.push({ kind: 'text', value: run }, { kind: 'mark', value: point })
    run = ''
  }
  if (at !== rest.length) return null
  pieces.push({ kind: 'text', value: run })
  return pieces
}

function renderSnippet(pieces: SnippetPiece[]): Snippet {
  let text = ''
  let shown = 0
  let openedAt: number | null = null
  for (const piece of pieces) {
    if (piece.kind === 'mark') {
      const opening = piece.value === MARK_OPEN
      openedAt = opening ? text.length : null
      text += opening ? '[[' : ']]'
      continue
    }
    const points = [...piece.value]
    if (shown + points.length <= SNIPPET_MAX_CHARS) {
      shown += points.length
      text += escapeLiteralMarks(piece.value)
      continue
    }
    const visible = points.slice(0, SNIPPET_MAX_CHARS - shown).join('')
    text += escapeLiteralMarks(visible)
    return { text: openedAt === null ? text : text.slice(0, openedAt), truncated: true }
  }
  return { text, truncated: false }
}

/**
 * Evidence is one string for the public API. Real highlights remain `[[...]]`;
 * source-authored delimiters are escaped so they cannot forge highlight runs.
 * Decode U+E0022/U+E0020/U+E0021 only inside text runs, exactly once; never
 * rescan decoded text for highlight delimiters. Escaping U+E002 first makes the
 * representation injective even when transcript text resembles an escape.
 */
function escapeLiteralMarks(value: string): string {
  return value.replaceAll(MARK_ESCAPE, `${MARK_ESCAPE}2`).replaceAll('[[', `${MARK_ESCAPE}0`).replaceAll(']]', `${MARK_ESCAPE}1`)
}

function searchMessageChunks(message: { role: VaultRole; text: string; timestamp: number | null }): { role: VaultRole; text: string; timestamp: number | null }[] {
  if (message.role === 'tool') return [{ ...message, text: sliceCodeUnits(message.text, TOOL_ROW_CHARS) }]
  if (message.text.length <= CHUNK_TARGET_CHARS) return [message]
  const chunks: { role: VaultRole; text: string; timestamp: number | null }[] = []
  let start = 0
  while (start < message.text.length) {
    let end = Math.min(message.text.length, start + CHUNK_TARGET_CHARS)
    if (end < message.text.length) {
      let split = -1
      for (let at = end - 1; at >= start + CHUNK_TARGET_CHARS / 2; at -= 1) {
        if (TOKEN_BOUNDARY.test(message.text[at]!) && !FOLDED_DIACRITIC.test(message.text[at]!)) { split = at + 1; break }
      }
      if (split > start) end = split
    }
    if (end < message.text.length) {
      const last = message.text.charCodeAt(end - 1)
      if (last >= 0xd800 && last <= 0xdbff) end += 1
    }
    chunks.push({ ...message, text: message.text.slice(start, end) })
    start = end
  }
  return chunks
}

function hashMessage(previous: string | null, role: string, text: string): string {
  return createHash('sha256').update(previous ?? '').update('\0').update(role).update('\0').update(text).digest('hex')
}

export type SearchContentHash = { hash: string | null; count: number }
export function extendContentHash(previous: SearchContentHash, role: VaultRole, text: string): SearchContentHash {
  if (previous.count >= 8) return previous
  return { hash: hashMessage(previous.hash, role, text), count: previous.count + 1 }
}

export function indexedMessageRows(message: { role: VaultRole; text: string; timestamp: number | null }): { role: VaultRole; text: string; timestamp: number | null; identifiers: string }[] {
  return searchMessageChunks(message).map(row => ({ ...row, identifiers: identifierShadowTerms(row.text).join(' ') }))
}

function pageIdentity(request: SearchRequest): string {
  const filters = request.filters ?? {}
  const identity = JSON.stringify([
    request.query, request.scope ?? 'all', filters.sort ?? 'relevance', filters.since ?? null,
    [...(filters.agents ?? [])].sort(), [...(filters.scopePaths ?? [])].sort()
  ])
  return createHash('sha256').update(identity).digest('base64url').slice(0, 16)
}

class CursorFailure extends Error {
  constructor(readonly reason: 'stale' | 'malformed') { super(reason) }
}

type CursorPayload = { i: string; g: number; o: number; k: string }

function encodeCursor(generation: number, offset: number, key: string, incarnation: string): string {
  return Buffer.from(JSON.stringify({ i: incarnation, g: generation, o: offset, k: key } satisfies CursorPayload)).toString('base64url')
}

function decodeCursor(cursor: string, generation: number, key: string, incarnation: string): number {
  let payload: CursorPayload
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid base64url')
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload
  } catch {
    throw new CursorFailure('malformed')
  }
  if (!payload || !Number.isInteger(payload.g) || payload.g < 0 || !Number.isInteger(payload.o) || payload.o < 0 || typeof payload.k !== 'string' || typeof payload.i !== 'string') {
    throw new CursorFailure('malformed')
  }
  if (payload.g !== generation || payload.i !== incarnation) throw new CursorFailure('stale')
  if (payload.k !== key) throw new CursorFailure('malformed')
  return payload.o
}

