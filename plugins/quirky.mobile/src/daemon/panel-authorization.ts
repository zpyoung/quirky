/** Panel additions to the single mobile admission policy; native pages never grant arbitrary RPC. */
export const PANEL_METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'quirky.git/status': ['worktree'],
  'quirky.git/diff': ['worktree', 'path', 'staged', 'source', 'oldPath', 'mergeBase', 'head', 'commit', 'parent'],
  'quirky.git/stage': ['worktree', 'paths', 'scope'],
  'quirky.git/unstage': ['worktree', 'paths'],
  'quirky.git/discard': ['worktree', 'paths', 'area', 'yes', 'confirmation'],
  'quirky.git/describeDiscard': ['worktree', 'paths', 'area'],
  'quirky.git/commit': ['worktree', 'message'],
  'quirky.git/generateCommitMessage': ['worktree'],
  'quirky.git/cancelGenerate': ['worktree'],
  'quirky.git/push': ['worktree'],
  'quirky.git/pull': ['worktree'],
  'quirky.git/sync': ['worktree'],
  'quirky.git/fetch': ['worktree'],
  'quirky.git/fastForward': ['worktree'],
  'quirky.git/forcePush': ['worktree', 'expected', 'yes', 'confirmation'],
  'quirky.git/describeForcePush': ['worktree', 'expected'],
  'quirky.git/branches': ['worktree', 'query'],
  'quirky.git/switchBranch': ['worktree', 'branch', 'expectedBranch', 'expectedHead', 'yes', 'confirmation'],
  'quirky.git/describeSwitchBranch': ['worktree', 'branch', 'expectedBranch', 'expectedHead'],
  'quirky.git/continue': ['worktree'],
  'quirky.git/abort': ['worktree', 'yes', 'confirmation'],
  'quirky.git/describeAbort': ['worktree'],
  'quirky.git/compare': ['worktree', 'base'],
  'quirky.git/history': ['worktree', 'limit'],
  'quirky.git/commitFiles': ['worktree', 'commit'],
  'quirky.git/conflictFile': ['worktree', 'path', 'peek'],
  'quirky.git/notes': ['worktree', 'path'],
  'quirky.git/addNote': ['worktree', 'path', 'line', 'startLine', 'body'],
  'quirky.git/editNote': ['worktree', 'id', 'body'],
  'quirky.git/deleteNote': ['worktree', 'id'],
  'quirky.git/formatNotes': ['worktree', 'ids', 'path'],
  'quirky.git/noteTargets': ['worktree'],
  'quirky.git/sendNotes': ['worktree', 'scope', 'id', 'path', 'session', 'agent'],
  'quirky.hosting/forBranch': ['worktree', 'branch', 'headOid', 'number', 'fallbackPRNumber', 'prRepo'],
  'quirky.hosting/review': ['worktree', 'number', 'prRepo'],
  'quirky.hosting/creationEligibility': ['worktree', 'base', 'head', 'title'],
  'quirky.hosting/create': ['worktree', 'base', 'head', 'title', 'body', 'draft', 'useTemplate'],
  'quirky.hosting/workItemDetails': ['worktree', 'number', 'kind', 'reference', 'noCache'],
  'quirky.hosting/updateReview': ['worktree', 'number', 'prRepo', 'action', 'title', 'body'],
  'quirky.hosting/reviewers': ['worktree', 'number', 'prRepo', 'action', 'logins'],
  'quirky.hosting/reviewAssignees': ['worktree', 'number', 'prRepo', 'action', 'logins'],
  'quirky.hosting/reviewConversation': ['worktree', 'number', 'prRepo', 'action', 'body'],
  'quirky.reviews/checksLink': ['worktree', 'number'],
  'quirky.editor/explorer': ['worktree', 'action', 'path'],
  'quirky.editor/open': ['worktree', 'path', 'preview', 'pinned', 'focus', 'mode'],
  'quirky.editor/read': ['bufferId', 'action', 'kind', 'offset', 'length', 'contentRevision'],
  'quirky.editor/viewer': ['bufferId', 'action'],
  'quirky.editor/draft': ['bufferId', 'content', 'expectedRevision'],
  'quirky.editor/transfer': ['action', 'kind', 'bufferId', 'expectedRevision', 'totalBytes', 'transferId', 'offset', 'data'],
  'quirky.editor/save': ['bufferId', 'trigger'],
  'quirky.tasks/state': ['worktree'],
  'quirky.tasks/repositories': ['worktree'],
  'quirky.tasks/list': ['worktree', 'mode', 'repoIds', 'query', 'page', 'refresh'],
  'quirky.tasks/navigate': ['worktree', 'source', 'mode', 'detail'],
  'quirky.tasks/issue': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'refresh'],
  'quirky.tasks/issueEdit': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'title', 'body', 'state', 'stateReason', 'duplicateOf', 'labels', 'assignees'],
  'quirky.tasks/issueComment': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'body'],
  'quirky.tasks/workspace': ['target', 'action', 'newWorkspace', 'name', 'prompt', 'setup', 'agent', 'composerRequestId', 'trustSetup'],
  'quirky.tasks/workspaceComposerCancel': ['requestId'],
  'quirky.accounts/list': ['provider'],
  'quirky.accounts/usage': [],
  'quirky.accounts/inactiveUsage': ['provider'],
  'quirky.accounts/refresh': ['provider', 'force'],
  'quirky.accounts/select': ['provider', 'accountId'],
  'quirky.vault/list': ['host', 'limit', 'sort', 'force', 'within'],
  'quirky.vault/search': ['host', 'query', 'scope', 'freshness', 'limit', 'filters', 'cursor', 'within'],
  'quirky.vault/resume': ['id']
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function relativePath(value: unknown, root = false): boolean {
  if (root && value === '.') return true
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !value.startsWith('/') && !value.startsWith('\\') && !/^[A-Za-z]:/.test(value) && !value.includes('\0') &&
    !value.split(/[\\/]+/).some(part => part === '..' || part === '.')
}

function requireKeys(params: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(params).some(key => !keys.includes(key))) throw new Error('mobile panel parameters contain an unsupported field')
}

function boundedInteger(value: unknown, max: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
}

/** Capability restrictions beyond each feature's own schema/containment/confirmation validation. */
export function assertPanelParameters(method: string, params: Record<string, unknown>): void {
  if (!Object.hasOwn(PANEL_METHOD_PARAMS, method)) return
  requireKeys(params, PANEL_METHOD_PARAMS[method]!)
  if (params.yes !== undefined && typeof params.yes !== 'boolean') throw new Error('mobile confirmation must be boolean')
  if (params.confirmation !== undefined && typeof params.confirmation !== 'string') throw new Error('mobile confirmation must be an ask id')
  if (params.prRepo !== undefined && (!record(params.prRepo) || Object.keys(params.prRepo).some(key => !['host', 'owner', 'repo'].includes(key)))) throw new Error('invalid mobile hosted repository')

  if (method.startsWith('quirky.git/')) {
    if (params.path !== undefined && !relativePath(params.path)) throw new Error('mobile Git paths must be worktree-relative')
    if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some(path => !relativePath(path)))) throw new Error('mobile Git paths must be worktree-relative')
    if (method === 'quirky.git/stage' && params.scope !== undefined && !['all', 'tracked'].includes(String(params.scope))) throw new Error('invalid mobile staging scope')
    if (method === 'quirky.git/sendNotes' && !['all', 'file', 'note'].includes(String(params.scope))) throw new Error('invalid mobile note scope')
  }

  if (method === 'quirky.editor/open' || method === 'quirky.editor/explorer') {
    if (params.path !== undefined && !relativePath(params.path, method.endsWith('/explorer'))) throw new Error('mobile editor paths must be worktree-relative')
    if (method.endsWith('/open') && !relativePath(params.path)) throw new Error('mobile editor path is required')
    if (method.endsWith('/explorer') && !['list', 'refresh'].includes(String(params.action))) throw new Error('mobile explorer permits list and refresh only')
    if (params.focus !== undefined && params.focus !== false) throw new Error('mobile file previews cannot focus the desktop')
  }
  if (method === 'quirky.editor/read') {
    if (!['text', 'bytes'].includes(String(params.action))) throw new Error('mobile editor reads must be bounded text or bytes')
    const limit = params.action === 'bytes' ? 384 * 1024 : 65536
    if (!boundedInteger(params.length, limit)) throw new Error('invalid mobile editor read size')
    if (params.action === 'text' && !['content', 'draft'].includes(String(params.kind))) throw new Error('invalid mobile text source')
  }
  if (method === 'quirky.editor/viewer' && params.action !== 'metadata') throw new Error('mobile viewer permits metadata only')
  if (method === 'quirky.editor/draft' && (typeof params.content !== 'string' || Buffer.byteLength(params.content) > 48 * 1024)) throw new Error('large mobile drafts require a bounded transfer')
  if (method === 'quirky.editor/save' && params.trigger !== undefined && params.trigger !== 'user') throw new Error('mobile file save must respect the user conflict guard')
  if (method === 'quirky.editor/transfer') {
    if (params.action === 'begin') {
      requireKeys(params, ['action', 'kind', 'bufferId', 'expectedRevision', 'totalBytes'])
      if (params.kind !== 'draft' || typeof params.bufferId !== 'string' || !boundedInteger(params.expectedRevision, Number.MAX_SAFE_INTEGER) || !boundedInteger(params.totalBytes, 1024 * 1024)) throw new Error('mobile transfer permits only bounded buffer drafts')
    } else if (params.action === 'chunk') {
      requireKeys(params, ['action', 'transferId', 'offset', 'data'])
      if (typeof params.transferId !== 'string' || !boundedInteger(params.offset, 1024 * 1024) || typeof params.data !== 'string' || params.data.length > 65536 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.data)) throw new Error('invalid bounded mobile transfer chunk')
    } else if (params.action === 'commit' || params.action === 'cancel') {
      requireKeys(params, ['action', 'transferId'])
      if (typeof params.transferId !== 'string') throw new Error('mobile transfer id is required')
    } else throw new Error('unsupported mobile transfer action')
  }

  if (method.startsWith('quirky.vault/')) {
    if (params.host !== undefined && params.host !== 'local') throw new Error('mobile history is local to the paired host')
    if (params.limit !== undefined && (!boundedInteger(params.limit, 100) || params.limit === 0)) throw new Error('mobile history limit must be1..100')
    if (params.within !== undefined && (!record(params.within) || Object.keys(params.within).length !== 1 || Object.keys(params.within).some(key => !['repo', 'worktree'].includes(key)) || Object.values(params.within).some(value => typeof value !== 'string' || !value))) throw new Error('mobile history needs one exact scope')
    if (params.filters !== undefined && (!record(params.filters) || Object.keys(params.filters).some(key => key !== 'sort'))) throw new Error('unsupported mobile history filter')
  }
  if (method.startsWith('quirky.accounts/') && params.provider !== undefined && !['claude', 'codex'].includes(String(params.provider))) throw new Error('unsupported mobile account provider')

  if (method === 'quirky.hosting/reviewConversation' && params.action !== 'add') throw new Error('mobile task conversation permits new comments only')
  if (method === 'quirky.hosting/reviewAssignees' && params.action !== 'set') throw new Error('unsupported mobile assignee action')
  if (method === 'quirky.tasks/workspace' && params.action !== 'start') throw new Error('mobile Tasks can start or open linked workspaces only')
  if (method === 'quirky.tasks/navigate') {
    if (params.source !== undefined && params.source !== 'github') throw new Error('unsupported mobile task source')
    if (params.mode !== undefined && !['issues', 'prs'].includes(String(params.mode))) throw new Error('unsupported mobile Tasks mode')
  }
  for (const key of ['target', 'detail']) {
    if (params[key] === undefined || params[key] === null) continue
    if (!record(params[key])) throw new Error('invalid mobile work-item target')
    requireKeys(params[key], ['worktree', 'kind', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo'])
  }
}
