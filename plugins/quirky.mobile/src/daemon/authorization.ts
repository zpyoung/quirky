export class MobileAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileAuthorizationError'
  }
}

const PARAMS: Readonly<Record<string, readonly string[]>> = {
  'status.get': [],
  'quirky.mobile/info': [],
  'quirky.session/list': ['worktree'],
  'quirky.session/get': ['session'],
  'quirky.session/create': ['worktree', 'agent', 'prompt', 'submitPrompt', 'waitForPrompt', 'title', 'name', 'cols', 'rows'],
  'quirky.session/resume': ['session', 'fork'],
  'quirky.session/restore': ['session'],
  'quirky.session/close': ['session'],
  'quirky.session/setName': ['session', 'name'],
  'quirky.terminal/attach': ['session', 'cols', 'rows', 'historyLines', 'claim'],
  'quirky.terminal/detach': ['streamId'],
  'quirky.terminal/write': ['session', 'data'],
  'quirky.terminal/resize': ['session', 'cols', 'rows', 'claim'],
  'quirky.terminal/mobileState': ['session'],
  'quirky.terminal/claim': ['session', 'cols', 'rows'],
  'quirky.terminal/send': ['session', 'text', 'enter'],
  'quirky.terminal/read': ['session', 'lines'],
  'quirky.terminal/snapshot': ['session'],
  'quirky.terminal/history': ['session', 'lines', 'before', 'format'],
  'quirky.terminal/sessions': [],
  'quirky.agent-status/list': ['worktree'],
  'quirky.agent-status/get': ['session', 'at'],
  'quirky.agent-status/explain': ['session', 'at'],
  'quirky.agent-status/wait': ['session', 'until', 'timeoutMs'],
  'quirky.agent-status/waitOutput': ['session', 'pattern', 'ignoreCase', 'lines', 'timeoutMs'],
  'quirky.worktree/list': ['repo', 'group'],
  'quirky.worktree/show': ['worktree'],
  'quirky.worktree/resolve': ['selector'],
  'quirky.repo/list': [],
  'quirky.repo/show': ['repo'],
  'quirky.repo/resolve': ['selector'],
  'quirky.git/status': ['worktree'],
  'quirky.git/diff': ['worktree', 'path', 'staged', 'source', 'oldPath', 'mergeBase', 'head', 'commit', 'parent'],
  'quirky.git/stage': ['worktree', 'paths', 'scope'],
  'quirky.git/unstage': ['worktree', 'paths'],
  'quirky.git/commit': ['worktree', 'message'],
  'quirky.git/push': ['worktree'],
  'quirky.git/pull': ['worktree'],
  'quirky.git/fetch': ['worktree'],
  'quirky.git/sync': ['worktree'],
  'quirky.git/compare': ['worktree', 'base'],
  'quirky.git/branches': ['worktree', 'query'],
  'quirky.git/history': ['worktree', 'limit'],
  'quirky.git/commitFiles': ['worktree', 'commit'],
  'quirky.git/conflictFile': ['worktree', 'path', 'peek'],
  'quirky.git/notes': ['worktree', 'path'],
  'quirky.git/addNote': ['worktree', 'path', 'line', 'startLine', 'body'],
  'quirky.git/editNote': ['worktree', 'id', 'body'],
  'quirky.git/deleteNote': ['worktree', 'id'],
  'quirky.git/formatNotes': ['worktree', 'ids', 'path'],
  'quirky.git/noteTargets': ['worktree'],
  'quirky.accounts/list': ['provider'],
  'quirky.accounts/usage': [],
  'quirky.accounts/refresh': ['provider', 'force'],
  'quirky.accounts/select': ['provider', 'accountId'],
  'quirky.ask/list': ['pendingOnly'],
  'quirky.ask/wait': ['askId', 'timeoutMs'],
  'quirky.ask/answer': ['askId', 'answers', 'skipped'],
  'quirky.hosting/files': ['worktree', 'number', 'prRepo', 'noCache'],
  'quirky.hosting/fileContents': ['worktree', 'number', 'prRepo', 'path', 'side', 'noCache'],
  'quirky.session-info/get': ['session']
}

const FORBIDDEN_KEYS: Readonly<Record<string, true>> = {
  deviceId: true, role: true, token: true, deviceToken: true, credential: true, credentials: true,
  caller: true, connection: true, client: true, clientId: true, scope: true
}
const MAX_STRING_LENGTH = 64 * 1024
const MAX_ARRAY_LENGTH = 2048
const MAX_OBJECT_KEYS = 256

export const MOBILE_METHOD_ALLOWLIST: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(Object.keys(PARAMS).map((method) => [method, true] as const))
)

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function checkTree(value: unknown, depth = 0): void {
  if (depth > 8) throw new MobileAuthorizationError('mobile parameters are too deeply nested')
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new MobileAuthorizationError('mobile parameter is too large')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_LENGTH) throw new MobileAuthorizationError('mobile parameter list is too large')
    for (const item of value) checkTree(item, depth + 1)
    return
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
    if (keys.length > MAX_OBJECT_KEYS) throw new MobileAuthorizationError('mobile parameter object is too large')
    for (const key of keys) {
      if (Object.hasOwn(FORBIDDEN_KEYS, key)) throw new MobileAuthorizationError('mobile parameters cannot supply caller identity')
      checkTree(value[key], depth + 1)
    }
    return
  }
  if (value !== null && typeof value === 'object') throw new MobileAuthorizationError('mobile parameters must contain JSON values')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new MobileAuthorizationError('mobile parameters must contain finite numbers')
}

function isSafeRelativePath(path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false
  return !path.split(/[\\/]+/).some((part) => part === '..' || part === '.') && !path.includes('\0')
}

function checkMethodSpecific(method: string, params: Record<string, unknown>): void {
  if (method === 'quirky.session/create' && ((params.cols !== undefined && (!Number.isInteger(params.cols) || (params.cols as number) < 1 || (params.cols as number) > 1000)) ||
    (params.rows !== undefined && (!Number.isInteger(params.rows) || (params.rows as number) < 1 || (params.rows as number) > 500)))) throw new MobileAuthorizationError('invalid mobile session dimensions')
  if (method === 'quirky.terminal/attach' || method === 'quirky.terminal/resize' || method === 'quirky.terminal/claim') {
    if (!Number.isInteger(params.cols) || (params.cols as number) < 1 || (params.cols as number) > 1000 ||
      !Number.isInteger(params.rows) || (params.rows as number) < 1 || (params.rows as number) > 500) throw new MobileAuthorizationError('invalid mobile terminal viewport')
  }
  if ((method === 'quirky.terminal/attach' || method === 'quirky.terminal/resize') && params.claim !== undefined && typeof params.claim !== 'boolean') throw new MobileAuthorizationError('claim must be boolean')
  if (method === 'quirky.terminal/mobileState' && params.session !== undefined && typeof params.session !== 'string') throw new MobileAuthorizationError('session must be a string')
  if (method === 'quirky.terminal/claim' && typeof params.session !== 'string') throw new MobileAuthorizationError('session must be a string')
  if (method === 'quirky.terminal/attach' && params.historyLines !== undefined && (!Number.isInteger(params.historyLines) || (params.historyLines as number) < 0 || (params.historyLines as number) > 10000)) throw new MobileAuthorizationError('invalid mobile terminal history limit')
  if (method === 'quirky.terminal/write' && (typeof params.data !== 'string' || Buffer.byteLength(params.data) > 64 * 1024)) throw new MobileAuthorizationError('mobile terminal input is too large')
  if (method === 'quirky.terminal/send' && (typeof params.text !== 'string' || Buffer.byteLength(params.text) > 64 * 1024)) throw new MobileAuthorizationError('mobile terminal input is too large')
  if (method === 'quirky.agent-status/wait' && params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || (params.timeoutMs as number) < 0 || (params.timeoutMs as number) > 60000)) throw new MobileAuthorizationError('invalid mobile wait timeout')
  if (method === 'quirky.agent-status/waitOutput') {
    if (typeof params.pattern !== 'string' || params.pattern.length > 256 || /\([^)]*[+*][^)]*\)[+*{]/.test(params.pattern) || /(?:\.\*|\.\+){2}/.test(params.pattern)) throw new MobileAuthorizationError('unsafe mobile regular expression')
    if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || (params.timeoutMs as number) < 0 || (params.timeoutMs as number) > 60000)) throw new MobileAuthorizationError('invalid mobile wait timeout')
    if (params.lines !== undefined && (!Number.isInteger(params.lines) || (params.lines as number) < 0 || (params.lines as number) > 2000)) throw new MobileAuthorizationError('invalid mobile output line limit')
  }
  if (method === 'quirky.git/diff' || method === 'quirky.git/conflictFile' || method === 'quirky.git/notes' || method === 'quirky.git/addNote' || method === 'quirky.git/editNote' || method === 'quirky.git/deleteNote' || method === 'quirky.git/formatNotes') {
    if (params.path !== undefined && !isSafeRelativePath(params.path)) throw new MobileAuthorizationError('mobile git paths must be relative to a worktree')
  }
  if (method === 'quirky.git/addNote') {
    if (!Number.isInteger(params.line) || (params.line as number) < 1 || (params.startLine !== undefined && (!Number.isInteger(params.startLine) || (params.startLine as number) < 1)) ||
      typeof params.body !== 'string' || Buffer.byteLength(params.body) > 64 * 1024) throw new MobileAuthorizationError('invalid mobile Git note')
  }
  if (method === 'quirky.git/editNote' && (typeof params.body !== 'string' || Buffer.byteLength(params.body) > 64 * 1024)) throw new MobileAuthorizationError('mobile Git note is too large')
  if (method === 'quirky.git/stage' || method === 'quirky.git/unstage') {
    if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some((path) => !isSafeRelativePath(path)))) throw new MobileAuthorizationError('mobile git paths must be relative to a worktree')
  }
  if (method === 'quirky.hosting/fileContents' && !isSafeRelativePath(params.path)) throw new MobileAuthorizationError('mobile file path must be relative')
  if (method === 'quirky.hosting/files' || method === 'quirky.hosting/fileContents') {
    const repository = params.prRepo
    if (repository !== undefined && (!isPlainRecord(repository) || Object.keys(repository).some((key) => !['host', 'owner', 'repo'].includes(key)))) throw new MobileAuthorizationError('invalid repository selector')
  }
  if (method === 'quirky.ask/answer') {
    if (!isPlainRecord(params.answers) || Object.keys(params.answers).length > 100) throw new MobileAuthorizationError('invalid ask answer map')
  }
}

export function assertMobileCallAllowed(method: string, params: unknown): asserts params is Record<string, unknown> {
  const allowed = Object.hasOwn(PARAMS, method) ? PARAMS[method] : undefined
  if (!allowed) throw new MobileAuthorizationError('method is not available to mobile clients')
  if (!isPlainRecord(params)) throw new MobileAuthorizationError('mobile method params must be an object')
  if (Object.keys(params).some((key) => !allowed.includes(key))) throw new MobileAuthorizationError('mobile method params contain an unsupported field')
  checkTree(params)
  checkMethodSpecific(method, params)
}
