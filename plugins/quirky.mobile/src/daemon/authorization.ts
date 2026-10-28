export class MobileAuthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MobileAuthorizationError'
  }
}

const PARAMS: Readonly<Record<string, readonly string[]>> = {
  'status.get': [],
  'quirky.mobile/info': [],
  'quirky.mobile/preferences': [],
  'quirky.mobile/updatePreferences': ['autoRestoreFitMs'],
  'quirky.mobile/bundleManifest': [],
  'quirky.mobile/bundleChunk': ['buildId', 'path', 'offset'],
  'quirky.mobile/bundleRange': ['buildId', 'path', 'offset', 'gzip'],
  'quirky.mobile/agentCatalog': [],
  'quirky.repo/list': [],
  'quirky.repo/groupList': [],
  'quirky.worktree/list': ['repo'],
  'quirky.worktree/show': ['worktree'],
  'quirky.worktree/create': ['repo', 'name', 'branchName', 'base'],
  'quirky.worktree/describeRemove': ['worktree'],
  'quirky.worktree/remove': ['worktree', 'yes'],
  'quirky.worktree/set': ['worktree', 'pinned', 'expectedInstanceId'],
  'quirky.session/list': ['worktree'],
  'quirky.session/get': ['session'],
  'quirky.session/resume': ['session', 'fork'],
  'quirky.session/restore': ['session'],
  'quirky.session/create': ['worktree', 'agent', 'cols', 'rows'],
  'quirky.session/setName': ['session', 'name'],
  'quirky.session/close': ['session'],
  'quirky.agent-status/list': ['worktree'],
  'quirky.agent-status/get': ['session', 'at'],
  'quirky.agent-status/explain': ['session', 'at'],
  'quirky.agent-status/wait': ['session', 'until', 'timeoutMs'],
  'quirky.agent-status/waitOutput': ['session', 'pattern', 'ignoreCase', 'lines', 'timeoutMs'],
  'quirky.ask/list': ['pendingOnly'],
  'quirky.ask/answer': ['askId', 'answers', 'skipped'],
  'quirky.terminal/attach': ['session', 'cols', 'rows', 'historyLines', 'claim'],
  'quirky.terminal/detach': ['streamId'],
  'quirky.terminal/describeClose': ['session'],
  'quirky.terminal/clear': ['session'],
  'quirky.terminal/displayMode': ['session', 'mode', 'cols', 'rows'],
  'quirky.terminal/mobileState': ['session'],
  'quirky.terminal/claim': ['session', 'cols', 'rows'],
  'quirky.terminal/read': ['session', 'lines'],
  'quirky.terminal/snapshot': ['session'],
  'quirky.terminal/history': ['session', 'lines', 'before', 'format'],
  'quirky.terminal/write': ['session', 'data'],
  'quirky.terminal/send': ['session', 'text', 'enter'],
  'quirky.terminal/resize': ['session', 'cols', 'rows', 'claim']
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
      if (depth === 0 && Object.hasOwn(FORBIDDEN_KEYS, key)) throw new MobileAuthorizationError('mobile parameters cannot supply caller identity')
      checkTree(value[key], depth + 1)
    }
    return
  }
  if (value !== null && typeof value === 'object') throw new MobileAuthorizationError('mobile parameters must contain JSON values')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new MobileAuthorizationError('mobile parameters must contain finite numbers')
}

function isSafeBundleAssetPath(path: unknown): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024 || path.startsWith('/') ||
    path.includes('\\') || path.includes('%') || path.includes('\0')) return false
  return path.split('/').every((part) => {
    const last = part.charCodeAt(part.length - 1)
    return part.length > 0 && part !== '.' && part !== '..' && last !== 0x0a && last !== 0x0d &&
      last !== 0x2028 && last !== 0x2029 && /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(part)
  })
}

function boundedString(value: unknown, maxLength = 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function validViewport(params: Record<string, unknown>): boolean {
  return Number.isInteger(params.cols) && (params.cols as number) >= 1 && (params.cols as number) <= 1000 &&
    Number.isInteger(params.rows) && (params.rows as number) >= 1 && (params.rows as number) <= 500
}

function checkMethodSpecific(method: string, params: Record<string, unknown>): void {
  if (method === 'quirky.mobile/updatePreferences' &&
    params.autoRestoreFitMs !== null && (typeof params.autoRestoreFitMs !== 'number' || !Number.isFinite(params.autoRestoreFitMs))) {
    throw new MobileAuthorizationError('autoRestoreFitMs must be a finite number or null')
  }
  if (method === 'quirky.mobile/bundleChunk' || method === 'quirky.mobile/bundleRange') {
    if (typeof params.buildId !== 'string' || !/^[0-9a-f]{64}$/.test(params.buildId) ||
      !isSafeBundleAssetPath(params.path) || !Number.isSafeInteger(params.offset) ||
      (params.offset as number) < 0 || (params.offset as number) > 32 * 1024 * 1024) {
      throw new MobileAuthorizationError('invalid mobile page bundle read')
    }
    if (method === 'quirky.mobile/bundleRange' && params.gzip !== undefined && typeof params.gzip !== 'boolean') {
      throw new MobileAuthorizationError('gzip must be boolean')
    }
  }
  if (method === 'quirky.worktree/list' && params.repo !== undefined && !boundedString(params.repo)) throw new MobileAuthorizationError('invalid mobile repository selector')
  if (method === 'quirky.worktree/show' || method === 'quirky.worktree/describeRemove' ||
    method === 'quirky.worktree/remove' || method === 'quirky.worktree/set') {
    if (!boundedString(params.worktree)) throw new MobileAuthorizationError('invalid mobile worktree selector')
  }
  if (method === 'quirky.worktree/create') {
    if ((params.repo !== undefined && !boundedString(params.repo)) ||
      (params.name !== undefined && !boundedString(params.name, 128)) ||
      (params.branchName !== undefined && !boundedString(params.branchName)) ||
      (params.base !== undefined && !boundedString(params.base))) throw new MobileAuthorizationError('invalid mobile worktree creation parameters')
  }
  if (method === 'quirky.worktree/remove' && params.yes !== true) {
    throw new MobileAuthorizationError('worktree removal requires an explicit confirmation')
  }
  if (method === 'quirky.worktree/set' && (typeof params.pinned !== 'boolean' || !boundedString(params.expectedInstanceId))) {
    throw new MobileAuthorizationError('mobile worktree updates may only change the pin state')
  }
  if (method === 'quirky.session/list' && params.worktree !== undefined && !boundedString(params.worktree)) throw new MobileAuthorizationError('invalid mobile worktree selector')
  if (method === 'quirky.session/create' &&
    ((params.cols !== undefined && (!Number.isInteger(params.cols) || (params.cols as number) < 1 || (params.cols as number) > 1000)) ||
      (params.rows !== undefined && (!Number.isInteger(params.rows) || (params.rows as number) < 1 || (params.rows as number) > 500)))) {
    throw new MobileAuthorizationError('invalid mobile session dimensions')
  }
  if (method === 'quirky.session/setName' &&
    (!boundedString(params.session) || (params.name !== null && (typeof params.name !== 'string' || params.name.length > 128)))) {
    throw new MobileAuthorizationError('invalid mobile session name')
  }
  if (method === 'quirky.session/close' || method === 'quirky.terminal/describeClose' ||
    method === 'quirky.terminal/clear' || method === 'quirky.terminal/snapshot') {
    if (!boundedString(params.session)) throw new MobileAuthorizationError('invalid mobile terminal session')
  }
  if (method === 'quirky.terminal/mobileState' && params.session !== undefined && !boundedString(params.session)) {
    throw new MobileAuthorizationError('invalid mobile terminal session')
  }
  if (method === 'quirky.ask/list' && params.pendingOnly !== undefined && typeof params.pendingOnly !== 'boolean') throw new MobileAuthorizationError('pendingOnly must be boolean')
  if (method === 'quirky.ask/answer' &&
    (!boundedString(params.askId) || !isPlainRecord(params.answers) || Object.keys(params.answers).length > 100 ||
      (params.skipped !== undefined && (!Array.isArray(params.skipped) || params.skipped.length > 100 || params.skipped.some((id) => !boundedString(id)))))) {
    throw new MobileAuthorizationError('invalid ask answer map')
  }
  if (method === 'quirky.agent-status/wait' && params.timeoutMs !== undefined &&
    (!Number.isInteger(params.timeoutMs) || (params.timeoutMs as number) < 0 || (params.timeoutMs as number) > 60_000)) {
    throw new MobileAuthorizationError('invalid mobile wait timeout')
  }
  if (method === 'quirky.agent-status/waitOutput') {
    if (typeof params.pattern !== 'string' || params.pattern.length > 256 ||
      /\([^)]*[+*][^)]*\)[+*{]/.test(params.pattern) || /(?:\.\*|\.\+){2}/.test(params.pattern)) {
      throw new MobileAuthorizationError('unsafe mobile regular expression')
    }
    if (params.timeoutMs !== undefined &&
      (!Number.isInteger(params.timeoutMs) || (params.timeoutMs as number) < 0 || (params.timeoutMs as number) > 60_000)) {
      throw new MobileAuthorizationError('invalid mobile wait timeout')
    }
    if (params.lines !== undefined && (!Number.isInteger(params.lines) || (params.lines as number) < 0 || (params.lines as number) > 2000)) {
      throw new MobileAuthorizationError('invalid mobile output line limit')
    }
  }
  if ((method === 'quirky.terminal/attach' || method === 'quirky.terminal/resize') &&
    params.claim !== undefined && typeof params.claim !== 'boolean') throw new MobileAuthorizationError('claim must be boolean')
  if (method === 'quirky.terminal/attach' &&
    (!boundedString(params.session) || !validViewport(params) ||
      (params.historyLines !== undefined && (!Number.isInteger(params.historyLines) || (params.historyLines as number) < 0 || (params.historyLines as number) > 10000)))) {
    throw new MobileAuthorizationError('invalid mobile terminal attach')
  }
  if (method === 'quirky.terminal/detach' && (!Number.isSafeInteger(params.streamId) || (params.streamId as number) <= 0)) {
    throw new MobileAuthorizationError('invalid mobile terminal stream ID')
  }
  if (method === 'quirky.terminal/claim' || method === 'quirky.terminal/resize') {
    if (!boundedString(params.session) || !validViewport(params)) throw new MobileAuthorizationError('invalid mobile terminal viewport')
  }
  if (method === 'quirky.terminal/read' && (!boundedString(params.session) ||
    (params.lines !== undefined && (!Number.isInteger(params.lines) || (params.lines as number) < 0 || (params.lines as number) > 2000)))) {
    throw new MobileAuthorizationError('invalid mobile terminal read')
  }
  if (method === 'quirky.terminal/write' &&
    (!boundedString(params.session) || typeof params.data !== 'string' || Buffer.byteLength(params.data) > 64 * 1024)) {
    throw new MobileAuthorizationError('mobile terminal input is too large')
  }
  if (method === 'quirky.terminal/send' &&
    (!boundedString(params.session) || typeof params.text !== 'string' || Buffer.byteLength(params.text) > 64 * 1024 ||
      (params.enter !== undefined && typeof params.enter !== 'boolean'))) {
    throw new MobileAuthorizationError('mobile terminal input is too large')
  }
  if (method === 'quirky.terminal/displayMode') {
    if (!boundedString(params.session)) throw new MobileAuthorizationError('invalid mobile terminal session')
    if (params.mode === 'phone') {
      if (Object.keys(params).length !== 4 || !validViewport(params)) throw new MobileAuthorizationError('invalid phone display mode viewport')
    } else if (params.mode !== 'desktop' || Object.keys(params).length !== 2) {
      throw new MobileAuthorizationError('desktop display mode accepts only session and mode')
    }
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
