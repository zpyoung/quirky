export type GitLabFailure = { status: number; body?: unknown; headers?: Record<string, string> }
export type GitLabCreateMode = 'normal' | 'conflict' | 'lost-created' | 'lost-empty'
export type GitLabRequestRecord = {
  method: string
  path: string
  query: Record<string, string>
  body: unknown
  authorization: string | null
}

export type GitLabServer = { port: number | undefined; url: URL; stop(closeActiveConnections?: boolean): void }
export type GitLabStandIn = {
  server: GitLabServer
  url: string
  host: string
  requests: GitLabRequestRecord[]
  mergeRequests: Record<string, any>[]
  listMergeRequests: Record<string, any>[] | undefined
  discussions: Record<string, any>[]
  scopes: string[]
  approvals: Record<string, any>
  failures: Map<string, GitLabFailure>
  createMode: GitLabCreateMode
  conflictCandidates: Record<string, any>[]
  close(): void
}

const PROJECT_PATH = '/api/v4/projects/group%2Fsub%2Fproj'
const NOTE_AUTHOR = { id: 7, username: 'fixture-user', name: 'Fixture User' }
const CREATED_AT = '2024-01-01T00:00:00.000Z'
const UPDATED_AT = '2024-01-02T00:00:00.000Z'

export function mergeRequest(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: 5,
    iid: 5,
    project_id: 42,
    source_project_id: 42,
    source_branch: 'feature',
    target_branch: 'main',
    title: 'Add x',
    description: 'body',
    state: 'opened',
    draft: false,
    sha: 'a'.repeat(40),
    diff_refs: {
      base_sha: 'b'.repeat(40),
      start_sha: 'c'.repeat(40),
      head_sha: 'a'.repeat(40)
    },
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    head_pipeline: { status: 'success' },
    reviewers: [{ username: 'rev' }],
    assignees: [],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    ...overrides
  }
}

export function startGitLab(): GitLabStandIn {
  let requests: GitLabRequestRecord[] = []
  let mergeRequests: Record<string, any>[] = []
  let listMergeRequests: Record<string, any>[] | undefined
  let conflictCandidates: Record<string, any>[] = []
  let discussions: Record<string, any>[] = []
  let scopes = ['api']
  let approvals: Record<string, any> = { approved: false, approvals_left: 1, approved_by: [] }
  let failures = new Map<string, GitLabFailure>()
  let createMode: GitLabCreateMode = 'normal'
  let nextNoteId = 1000
  let closed = false
  let apiUrl = ''

  function json(body: unknown, status = 200, headers?: HeadersInit): Response {
    const responseHeaders = new Headers(headers)
    if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'application/json')
    return new Response(JSON.stringify(body === undefined ? {} : body), { status, headers: responseHeaders })
  }

  function failedResponse(failure: GitLabFailure): Response {
    return json(failure.body ?? { message: 'fixture failure' }, failure.status, failure.headers)
  }

  function lostResponse(): Response {
    const prefix = new TextEncoder().encode('{"')
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(prefix)
        queueMicrotask(() => controller.error(new Error('simulated lost GitLab response')))
      }
    })
    return new Response(body, {
      status: 201,
      headers: { 'content-type': 'application/json', 'content-length': '128' }
    })
  }

  function mergeRequestResponse(value: Record<string, any>): Record<string, any> {
    return {
      ...value,
      web_url: typeof value.web_url === 'string'
        ? value.web_url
        : `${apiUrl}/group/sub/proj/-/merge_requests/${value.iid}`
    }
  }

  function mergeRequestSummary(value: Record<string, any>): Record<string, any> {
    const summary = mergeRequestResponse(value)
    delete summary.diff_refs
    delete summary.head_pipeline
    return summary
  }

  function findMergeRequest(iidText: string): Record<string, any> | undefined {
    const iid = Number(iidText)
    if (!Number.isSafeInteger(iid)) return undefined
    return mergeRequests.find((value) => Number(value.iid) === iid)
  }

  function allocateNoteId(): number {
    const ids = discussions.flatMap((discussion) => Array.isArray(discussion.notes) ? discussion.notes.map((note: any) => Number(note.id)) : [])
    while (ids.includes(nextNoteId)) nextNoteId++
    return nextNoteId++
  }

  function makeNote(body: unknown): Record<string, any> {
    return {
      id: allocateNoteId(),
      body: typeof body === 'string' ? body : '',
      author: { ...NOTE_AUTHOR },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      system: false
    }
  }

  function findDiscussion(id: string): Record<string, any> | undefined {
    return discussions.find((discussion) => String(discussion.id) === id)
  }

  function routeMergeRequests(method: string, path: string, query: Record<string, string>, body: unknown): Response {
    const relative = path.slice(PROJECT_PATH.length)
    const parts = relative.split('/').filter(Boolean)
    if (parts[0] !== 'merge_requests') return json({ message: 'Not Found' }, 404)

    if (parts.length === 1) {
      if (method === 'GET') {
        let matches = (listMergeRequests ?? mergeRequests).filter((value) => query.source_branch === undefined || value.source_branch === query.source_branch)
        if (query.state !== 'all') matches = matches.filter((value) => value.state === 'opened' || value.state === 'open')
        if (query.order_by === 'updated_at') {
          const direction = query.sort === 'asc' ? 1 : -1
          matches = [...matches].sort((a, b) => direction * (Date.parse(a.updated_at ?? '') - Date.parse(b.updated_at ?? '')))
        }
        return json(matches.map(mergeRequestSummary))
      }
      if (method === 'POST') {
        const payload = isRecord(body) ? body : {}
        if (createMode === 'conflict') {
          mergeRequests.push(...conflictCandidates.map((value) => ({ ...value })))
          conflictCandidates = []
          return json({ message: 'Merge request already exists' }, 409)
        }
        if (createMode === 'lost-empty') return lostResponse()
        const iid = mergeRequests.reduce((highest, value) => Math.max(highest, Number(value.iid) || 0), 5) + 1
        const title = typeof payload.title === 'string' ? payload.title : ''
        const created = mergeRequest({
          id: iid,
          iid,
          source_branch: payload.source_branch,
          target_branch: payload.target_branch,
          title,
          description: payload.description,
          draft: /^(?:draft:|\[draft\]|\(draft\))/i.test(title.trim()),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        mergeRequests.push(created)
        if (createMode === 'lost-created') return lostResponse()
        return json(mergeRequestResponse(created), 201)
      }
      return json({ message: 'Method Not Allowed' }, 405)
    }

    const mr = findMergeRequest(parts[1]!)
    if (!mr) return json({ message: 'Not Found' }, 404)
    if (parts.length === 2) {
      if (method === 'GET') return json(mergeRequestResponse(mr))
      if (method === 'PUT') {
        const payload = isRecord(body) ? body : {}
        if (typeof payload.title === 'string') {
          mr.title = payload.title
          mr.draft = /^(?:draft:|\[draft\]|\(draft\))/i.test(payload.title.trim())
        }
        if (typeof payload.description === 'string') mr.description = payload.description
        if (payload.state_event === 'close') mr.state = 'closed'
        if (payload.state_event === 'reopen') mr.state = 'opened'
        mr.updated_at = new Date().toISOString()
        return json(mergeRequestResponse(mr))
      }
      return json({ message: 'Method Not Allowed' }, 405)
    }

    if (parts[2] === 'approvals' && parts.length === 3 && method === 'GET') {
      const perRequest = approvals[String(mr.iid)]
      return json(isRecord(perRequest) ? perRequest : approvals)
    }

    if (parts[2] === 'discussions') {
      if (parts.length === 3 && method === 'GET') {
        const page = Math.max(1, Number(query.page) || 1)
        const pageSize = 100
        const start = (page - 1) * pageSize
        const rows = discussions.slice(start, start + pageSize)
        const headers = start + rows.length < discussions.length ? { 'X-Next-Page': String(page + 1) } : undefined
        return json(rows, 200, headers)
      }
      if (parts.length === 3 && method === 'POST') {
        const payload = isRecord(body) ? body : {}
        const note = makeNote(payload.body)
        const discussion = {
          id: String(discussions.length + 1).padStart(40, '0'),
          individual_note: false,
          resolvable: true,
          resolved: false,
          notes: [note],
          ...(isRecord(payload.position) ? { position: payload.position } : {})
        }
        discussions.push(discussion)
        return json(discussion, 201)
      }
      if (parts.length === 4 && method === 'PUT') {
        const discussion = findDiscussion(parts[3]!)
        if (!discussion) return json({ message: 'Not Found' }, 404)
        if (query.resolved !== undefined) discussion.resolved = query.resolved === 'true'
        return json(discussion)
      }
      if (parts.length === 5 && parts[4] === 'notes' && method === 'POST') {
        const discussion = findDiscussion(parts[3]!)
        if (!discussion) return json({ message: 'Not Found' }, 404)
        const payload = isRecord(body) ? body : {}
        const note = makeNote(payload.body)
        discussion.notes = Array.isArray(discussion.notes) ? [...discussion.notes, note] : [note]
        return json(note, 201)
      }
    }

    if (parts[2] === 'notes') {
      if (parts.length === 3 && method === 'POST') {
        const payload = isRecord(body) ? body : {}
        const note = makeNote(payload.body)
        discussions.push({
          id: String(discussions.length + 1).padStart(40, '0'),
          individual_note: true,
          resolvable: false,
          resolved: false,
          notes: [note]
        })
        return json(note, 201)
      }
      if (parts.length === 4 && method === 'PUT') {
        const noteId = Number(parts[3])
        for (const discussion of discussions) {
          if (!Array.isArray(discussion.notes)) continue
          const note = discussion.notes.find((value: any) => Number(value.id) === noteId)
          if (note) {
            const payload = isRecord(body) ? body : {}
            if (typeof payload.body === 'string') note.body = payload.body
            note.updated_at = new Date().toISOString()
            return json(note)
          }
        }
        return json({ message: 'Not Found' }, 404)
      }
    }

    return json({ message: 'Not Found' }, 404)
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const method = request.method.toUpperCase()
      const path = url.pathname
      const query = Object.fromEntries(url.searchParams.entries())
      const text = await request.text()
      let body: unknown = null
      if (text.length > 0) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      const authorization = request.headers.get('authorization')
      requests.push({ method, path, query, body, authorization })

      if (authorization !== 'Bearer dummy-gitlab-token') return json({ message: '401 Unauthorized' }, 401)
      const failure = failures.get(`${method} ${path}`)
      if (failure) return failedResponse(failure)

      if (method === 'GET' && path === '/api/v4/user') {
        return json({ id: 7, username: 'fixture-user', name: 'Fixture User' })
      }
      if (method === 'GET' && path === '/api/v4/personal_access_tokens/self') return json({ scopes: [...scopes] })
      if (method === 'GET' && path === PROJECT_PATH) {
        return json({
          id: 42,
          path: 'proj',
          path_with_namespace: 'group/sub/proj',
          name: 'proj',
          default_branch: 'main',
          web_url: `${apiUrl}/group/sub/proj`
        })
      }
      if (path.startsWith(`${PROJECT_PATH}/`)) return routeMergeRequests(method, path, query, body)
      return json({ message: 'Not Found' }, 404)
    }
  })

  const host = `127.0.0.1:${server.port}`
  apiUrl = server.url.origin
  return {
    server,
    url: apiUrl,
    host,
    get requests() { return requests },
    set requests(value: GitLabRequestRecord[]) { requests = value },
    get mergeRequests() { return mergeRequests },
    set mergeRequests(value: Record<string, any>[]) { mergeRequests = value },
    get listMergeRequests() { return listMergeRequests },
    set listMergeRequests(value: Record<string, any>[] | undefined) { listMergeRequests = value },
    get discussions() { return discussions },
    set discussions(value: Record<string, any>[]) { discussions = value },
    get scopes() { return scopes },
    set scopes(value: string[]) { scopes = value },
    get approvals() { return approvals },
    set approvals(value: Record<string, any>) { approvals = value },
    get failures() { return failures },
    set failures(value: Map<string, GitLabFailure>) { failures = value },
    get createMode() { return createMode },
    get conflictCandidates() { return conflictCandidates },
    set conflictCandidates(value: Record<string, any>[]) { conflictCandidates = value },
    set createMode(value: GitLabCreateMode) { createMode = value },
    close() {
      if (closed) return
      closed = true
      server.stop(true)
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
