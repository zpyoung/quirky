import type { HostingEnv } from '../env'
import type { DetailComment } from '../comment-details'
import { isRecord } from '../data'
import { positiveInteger, readNoCache, validateFilePath } from '../detail-common'
import { gitlabError, type GitLabClient } from './api'
import type { GitLabHandler, GitLabScope } from './types'

type Note = { id: number; body: string; author: string | null; createdAt: string | null; system: boolean; position: Position; resolvable: boolean | null; resolved: boolean | null }
type Position = { path: string; line: number } | null
type Discussion = {
  id: string
  individual: boolean
  resolvable: boolean | null
  resolved: boolean | null
  position: Position
  notes: Note[]
}
type DiscussionPage = { discussions: Discussion[]; truncated: boolean }
type CachedCommentsPage = { page: DiscussionPage; mergeRequestUrl: string }

const INVALID_BODY = 'A non-empty comment body of at most 64 KiB is required.'
const SCHEMA_DRIFT = 'GitLab returned an unexpected discussion response.'

export function createGitLabDiscussionHandlers(env: HostingEnv, client: GitLabClient): Record<string, GitLabHandler> {
  return {
    comments: (scope, params) => comments(env, client, scope, params),
    reviewComment: (scope, params) => reviewComment(env, client, scope, params),
    resolveThread: (scope, params) => resolveThread(env, client, scope, params),
    reviewConversation: (scope, params) => reviewConversation(env, client, scope, params),
    reviewConversationConfirmation: (scope, params) => reviewConversationConfirmation(env, scope, params)
  }
}

async function comments(env: HostingEnv, client: GitLabClient, scope: GitLabScope, params: Record<string, unknown>): Promise<unknown> {
  const number = mergeRequestNumber(env, params)
  const noCache = readNoCache(env, params)
  const load = async (): Promise<CachedCommentsPage> => {
    const [page, mergeRequest] = await Promise.all([
      loadDiscussionPage(env, client, scope, number),
      readMergeRequest(env, client, scope, number)
    ])
    return { page, mergeRequestUrl: mergeRequestUrl(env, scope, number, mergeRequest) }
  }
  const cached = noCache
    ? await load()
    : await env.cache(env.cacheKey(scope, `gitlab:discussions:${number}`), 60_000, load)
  const { page, mergeRequestUrl: url } = cached
  const output = page.discussions.flatMap((discussion) => discussion.notes.flatMap<DetailComment>((note) => {
    if (note.system) return []
    if (discussion.individual) {
      return [{
        kind: 'issue_comment',
        id: note.id,
        author: note.author,
        url: `${url}#note_${note.id}`,
        isBot: null,
        body: note.body,
        createdAt: note.createdAt,
        state: null,
        path: null,
        line: null,
        startLine: null,
        threadId: null,
        isResolved: null,
        isOutdated: null,
        reactionSubjectId: null,
        reactions: []
      }]
    }
    return [{
      kind: 'review_comment',
      id: note.id,
      author: note.author,
      url: null,
      isBot: null,
      body: note.body,
      createdAt: note.createdAt,
      state: null,
      path: discussion.position?.path ?? null,
      line: discussion.position?.line ?? null,
      startLine: null,
      threadId: discussion.id,
      isResolved: discussion.resolvable ? discussion.resolved : null,
      isOutdated: discussion.position === null ? null : false,
      reactionSubjectId: null,
      reactions: []
    }]
  }))
  return {
    number,
    partial: page.truncated,
    partialFailures: page.truncated ? ['discussions_truncated'] : [],
    comments: output
  }
}

async function loadDiscussionPage(env: HostingEnv, client: GitLabClient, scope: GitLabScope, number: number): Promise<DiscussionPage> {
  const page = await client.pages(scope, {
    method: 'GET',
    path: `${mergeRequestPath(scope, number)}/discussions`,
    query: { per_page: 100 }
  }, 5)
  if (!isRecord(page) || !Array.isArray(page.items) || typeof page.truncated !== 'boolean') throw schemaDrift(env)
  return { discussions: page.items.map((value) => parseDiscussion(env, value)), truncated: page.truncated }
}

function parseDiscussion(env: HostingEnv, value: unknown): Discussion {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0 || typeof value.individual_note !== 'boolean' || !Array.isArray(value.notes)) {
    throw schemaDrift(env)
  }
  const notes = value.notes.map((note) => parseNote(env, note))
  const resolvable = optionalBoolean(env, value.resolvable) ?? notes[0]?.resolvable ?? null
  const resolved = optionalBoolean(env, value.resolved) ?? notes[0]?.resolved ?? null
  const position = parsePosition(env, value.position) ?? notes.find((note) => note.position !== null)?.position ?? null
  return { id: value.id, individual: value.individual_note, resolvable, resolved, position, notes }
}

function parseNote(env: HostingEnv, value: unknown): Note {
  if (!isRecord(value) || !positiveInteger(value.id) || typeof value.body !== 'string') throw schemaDrift(env)
  let author: string | null = null
  if (value.author !== undefined && value.author !== null) {
    if (!isRecord(value.author) || value.author.username !== undefined && value.author.username !== null && typeof value.author.username !== 'string') {
      throw schemaDrift(env)
    }
    author = typeof value.author.username === 'string' ? value.author.username : null
  }
  if (value.created_at !== undefined && value.created_at !== null && typeof value.created_at !== 'string') throw schemaDrift(env)
  if (value.system !== undefined && typeof value.system !== 'boolean') throw schemaDrift(env)
  return {
    id: value.id,
    body: value.body,
    author,
    createdAt: typeof value.created_at === 'string' ? value.created_at : null,
    system: value.system === true,
    position: parsePosition(env, value.position),
    resolvable: optionalBoolean(env, value.resolvable),
    resolved: optionalBoolean(env, value.resolved)
  }
}

function parsePosition(env: HostingEnv, value: unknown): Position {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw schemaDrift(env)
  const path = typeof value.new_path === 'string' && value.new_path.length > 0
    ? value.new_path
    : typeof value.old_path === 'string' && value.old_path.length > 0
      ? value.old_path
      : null
  const line = positiveInteger(value.new_line) ? value.new_line : positiveInteger(value.old_line) ? value.old_line : null
  if (path === null || line === null) throw schemaDrift(env)
  let safePath: string
  try {
    safePath = validateFilePath(env, path)
  } catch {
    throw schemaDrift(env)
  }
  return { path: safePath, line }
}

function optionalBoolean(env: HostingEnv, value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') throw schemaDrift(env)
  return value
}

async function reviewComment(env: HostingEnv, client: GitLabClient, scope: GitLabScope, params: Record<string, unknown>): Promise<unknown> {
  const number = mergeRequestNumber(env, params)
  const action = params.action
  if (action !== 'inline' && action !== 'reply') throw env.invalid('invalid_input', 'Review comment action must be inline or reply.')
  const body = commentBody(env, params.body)
  return action === 'inline'
    ? addInlineComment(env, client, scope, number, params, body)
    : addReply(env, client, scope, number, params, body)
}

async function addInlineComment(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  params: Record<string, unknown>,
  body: string
): Promise<unknown> {
  const headSha = params.headSha
  if (typeof headSha !== 'string' || !isSha(headSha)) throw env.invalid('invalid_input', 'Inline comments require a valid expected head SHA.')
  const path = validateFilePath(env, params.path)
  const line = params.line
  const startLine = params.startLine
  if (!positiveInteger(line) || startLine !== undefined && !positiveInteger(startLine)) {
    throw env.invalid('invalid_input', 'Inline comments require positive line coordinates.')
  }
  if (startLine !== undefined && startLine > line) throw env.invalid('invalid_input', 'The range start line cannot follow its end line.')
  if (startLine !== undefined && startLine < line) {
    throw env.invalid('unsupported_range', 'GitLab range comments are not supported yet; comment on one line.')
  }

  const pull = await readMergeRequest(env, client, scope, number)
  const refs = currentDiffRefs(env, pull)
  if (refs.sha.toLowerCase() !== headSha.toLowerCase() || refs.head.toLowerCase() !== headSha.toLowerCase()) {
    throw env.invalid('stale_head', 'The merge request head changed; refresh before commenting.')
  }

  let response: { json: unknown }
  try {
    response = await client.request(scope, {
      method: 'POST',
      path: `${mergeRequestPath(scope, number)}/discussions`,
      body: {
        body,
        position: {
          position_type: 'text',
          base_sha: refs.base,
          start_sha: refs.start,
          head_sha: refs.head,
          old_path: path,
          new_path: path,
          new_line: line
        }
      }
    })
  } catch (error) {
    recordUncertainMutation(env, scope, number, 'reviewComment', error)
    if (errorReason(error) === 'validation_error') {
      throw gitlabError(env, 'invalid_coordinates', 'GitLab rejected the inline comment coordinates.')
    }
    throw error
  }
  const created = parseMutationResponse(env, scope, number, 'reviewComment', () => parseDiscussionResult(env, response.json))
  const note = created?.notes[0]
  if (!created || !note || created.individual || note.body !== body || created.position?.path !== path || created.position.line !== line) {
    uncertainSchemaFailure(env, scope, number, 'reviewComment')
  }
  env.changed(scope, { number, operation: 'reviewComment', completedSteps: ['inline_comment'] })
  return { number, action: 'inline', comment: { id: note.id, path, line, startLine: null, body: note.body } }
}

async function addReply(
  env: HostingEnv,
  client: GitLabClient,
  scope: GitLabScope,
  number: number,
  params: Record<string, unknown>,
  body: string
): Promise<unknown> {
  const replyToId = params.replyToId
  if (!positiveInteger(replyToId)) throw env.invalid('invalid_input', 'A positive review comment ID is required for a reply.')
  const page = await loadDiscussionPage(env, client, scope, number)
  let target: Discussion | null = null
  for (const discussion of page.discussions) {
    if (discussion.notes.some((note) => note.id === replyToId)) {
      target = discussion
      break
    }
  }
  if (target === null) throw env.invalid('foreign_target', 'The reply target does not belong to the selected merge request.')

  const path = `${mergeRequestPath(scope, number)}/discussions/${encodeURIComponent(target.id)}/notes`
  const response = await requestMutation(env, scope, number, 'reviewComment', () => client.request(scope, { method: 'POST', path, body: { body } }))
  const note = parseMutationResponse(env, scope, number, 'reviewComment', () => parseNoteResult(env, response.json))
  if (!note || note.body !== body) uncertainSchemaFailure(env, scope, number, 'reviewComment')
  env.changed(scope, { number, operation: 'reviewComment', completedSteps: ['reply'] })
  return {
    number,
    action: 'reply',
    comment: { id: note.id, path: target.position?.path ?? null, line: target.position?.line ?? null, startLine: null, body: note.body }
  }
}

async function resolveThread(env: HostingEnv, client: GitLabClient, scope: GitLabScope, params: Record<string, unknown>): Promise<unknown> {
  const number = mergeRequestNumber(env, params)
  const action = params.action
  const threadId = params.threadId
  if ((action !== 'resolve' && action !== 'unresolve') || typeof threadId !== 'string' || !/^[a-f0-9]{40}$/i.test(threadId)) {
    throw env.invalid('invalid_input', 'Thread action or ID is invalid.')
  }
  const resolved = action === 'resolve'
  const path = `${mergeRequestPath(scope, number)}/discussions/${encodeURIComponent(threadId)}`
  const response = await requestMutation(env, scope, number, 'resolveThread', () => client.request(scope, {
    method: 'PUT',
    path,
    query: { resolved }
  }))
  const discussion = parseMutationResponse(env, scope, number, 'resolveThread', () => parseDiscussion(env, response.json))
  if (discussion.id.toLowerCase() !== threadId.toLowerCase() || discussion.resolved !== resolved) {
    uncertainSchemaFailure(env, scope, number, 'resolveThread')
  }
  env.changed(scope, { number, operation: 'resolveThread', completedSteps: [action] })
  return { threadId, action, resolved }
}

async function reviewConversation(env: HostingEnv, client: GitLabClient, scope: GitLabScope, params: Record<string, unknown>): Promise<unknown> {
  const number = mergeRequestNumber(env, params)
  const action = params.action
  if (action === 'delete') throw env.invalid('unsupported_action', 'GitLab conversation comments cannot be deleted.')
  if (action !== 'add' && action !== 'edit') throw env.invalid('invalid_input', 'Conversation action must be add or edit.')
  const body = commentBody(env, params.body)
  const commentId = action === 'edit' ? params.commentId : undefined
  if (action === 'edit' && !positiveInteger(commentId)) throw env.invalid('invalid_input', 'A positive comment ID is required to edit a conversation comment.')
  const path = action === 'add'
    ? `${mergeRequestPath(scope, number)}/notes`
    : `${mergeRequestPath(scope, number)}/notes/${commentId}`
  const mergeRequest = await readMergeRequest(env, client, scope, number)
  const url = mergeRequestUrl(env, scope, number, mergeRequest)
  const response = await requestMutation(env, scope, number, `reviewConversation-${action}`, () => client.request(scope, {
    method: action === 'add' ? 'POST' : 'PUT',
    path,
    body: { body }
  }))
  const note = parseMutationResponse(env, scope, number, `reviewConversation-${action}`, () => parseNoteResult(env, response.json))
  if (!note || note.body !== body || action === 'edit' && note.id !== commentId) {
    uncertainSchemaFailure(env, scope, number, `reviewConversation-${action}`)
  }
  env.changed(scope, { number, operation: `reviewConversation-${action}`, completedSteps: [action] })
  return {
    number,
    action,
    comment: {
      id: note.id,
      kind: 'issue_comment',
      body: note.body,
      author: note.author,
      createdAt: note.createdAt,
      url: `${url}#note_${note.id}`
    }
  }
}

function reviewConversationConfirmation(env: HostingEnv, scope: GitLabScope, params: Record<string, unknown>): unknown {
  mergeRequestNumber(env, params)
  const action = params.action
  if (action === 'delete') throw env.invalid('unsupported_action', 'GitLab conversation comments cannot be deleted.')
  if (action !== 'add' && action !== 'edit') throw env.invalid('invalid_input', 'Conversation action must be add or edit.')
  commentBody(env, params.body)
  if (action === 'edit' && !positiveInteger(params.commentId)) throw env.invalid('invalid_input', 'A positive comment ID is required to edit a conversation comment.')
  return null
}

async function requestMutation<T>(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  operation: string,
  request: () => Promise<T>
): Promise<T> {
  try {
    return await request()
  } catch (error) {
    recordUncertainMutation(env, scope, number, operation, error)
    throw error
  }
}

async function readMergeRequest(env: HostingEnv, client: GitLabClient, scope: GitLabScope, number: number): Promise<Record<string, unknown>> {
  const response = await client.request(scope, { method: 'GET', path: mergeRequestPath(scope, number) })
  if (!isRecord(response.json)) throw schemaDrift(env)
  return response.json
}

function currentDiffRefs(env: HostingEnv, value: Record<string, unknown>): { sha: string; base: string; start: string; head: string } {
  if (!isSha(value.sha)) throw schemaDrift(env)
  if (value.diff_refs === null) throw gitlabError(env, 'diff_pending', 'GitLab is still preparing this merge request.')
  if (!isRecord(value.diff_refs)) throw schemaDrift(env)
  const refs = value.diff_refs
  if (!isSha(refs.base_sha) || !isSha(refs.start_sha) || !isSha(refs.head_sha)) throw schemaDrift(env)
  return { sha: value.sha, base: refs.base_sha, start: refs.start_sha, head: refs.head_sha }
}

function parseDiscussionResult(env: HostingEnv, value: unknown): Discussion | null {
  if (!isRecord(value)) return null
  return parseDiscussion(env, value)
}

function parseNoteResult(env: HostingEnv, value: unknown): Note | null {
  if (!isRecord(value)) return null
  return parseNote(env, value)
}

function parseMutationResponse<T>(
  env: HostingEnv,
  scope: GitLabScope,
  number: number,
  operation: string,
  parse: () => T
): T {
  try {
    return parse()
  } catch {
    return uncertainSchemaFailure(env, scope, number, operation)
  }
}

function commentBody(env: HostingEnv, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || Buffer.byteLength(value, 'utf8') > 65_536) {
    throw env.invalid('invalid_input', INVALID_BODY)
  }
  return value
}

function mergeRequestNumber(env: HostingEnv, params: Record<string, unknown>): number {
  if (!positiveInteger(params.number)) throw env.invalid('invalid_input', 'A positive merge request number is required.')
  return params.number
}

function mergeRequestPath(scope: GitLabScope, number: number): string {
  return `/projects/${scope.projectId}/merge_requests/${number}`
}

function mergeRequestUrl(env: HostingEnv, scope: GitLabScope, number: number, value: Record<string, unknown>): string {
  const rawUrl = value.web_url
  if (typeof rawUrl !== 'string') throw schemaDrift(env)
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw schemaDrift(env)
  }
  const expectedProtocol = scope.apiBase.startsWith('http://') ? 'http:' : 'https:'
  const namespace = scope.repository.owner.split('/').map(encodeURIComponent).join('/')
  const project = encodeURIComponent(scope.repository.repo)
  const expectedPath = `/${namespace}/${project}/-/merge_requests/${number}`
  if (url.protocol !== expectedProtocol || url.host.toLowerCase() !== scope.origin.host.toLowerCase()
    || url.username || url.password || url.search || url.hash || url.pathname !== expectedPath) {
    throw schemaDrift(env)
  }
  return url.toString().replace(/\/$/, '')
}

function schemaDrift(env: HostingEnv): Error {
  return gitlabError(env, 'schema_drift', SCHEMA_DRIFT)
}

function uncertainSchemaFailure(env: HostingEnv, scope: GitLabScope, number: number, operation: string): never {
  env.changed(scope, { number, operation, uncertain: true })
  throw schemaDrift(env)
}

function recordUncertainMutation(env: HostingEnv, scope: GitLabScope, number: number, operation: string, error: unknown): void {
  const reason = errorReason(error)
  if (reason === 'network_error' || reason === 'timeout' || reason === 'output_limit' || reason === 'unknown_completion') {
    env.changed(scope, { number, operation, uncertain: true })
  }
}

function errorReason(error: unknown): string | null {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.reason !== 'string') return null
  return error.data.reason
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
}

