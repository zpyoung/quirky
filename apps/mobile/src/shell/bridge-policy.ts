import type { MobileConnectionState, MobileGrant, MobilePageInit, MobileRoute } from '../contracts'

export const PAGE_METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'quirky.repo/list': [],
  'quirky.repo/groupList': [],
  'quirky.loops/summaries': [],
  'quirky.mobile/agentCatalog': [],
  'quirky.worktree/list': ['repo'],
  'quirky.worktree/show': ['worktree'],
  'quirky.worktree/create': ['repo', 'name', 'branchName', 'base'],
  'quirky.worktree/describeRemove': ['worktree'],
  'quirky.worktree/remove': ['worktree', 'yes'],
  'quirky.worktree/set': ['worktree', 'pinned', 'expectedInstanceId'],
  'quirky.session/list': ['worktree'],
  'quirky.session/create': ['worktree', 'agent', 'cols', 'rows'],
  'quirky.session/setName': ['session', 'name'],
  'quirky.session/close': ['session'],
  'quirky.ask/list': ['pendingOnly'],
  'quirky.ask/answer': ['askId', 'answers', 'skipped'],
  'quirky.terminal/attach': ['session', 'cols', 'rows', 'historyLines'],
  'quirky.terminal/detach': ['streamId'],
  'quirky.terminal/describeClose': ['session'],
  'quirky.terminal/clear': ['session'],
  'quirky.terminal/displayMode': ['session', 'mode', 'cols', 'rows'],
  'quirky.terminal/mobileState': ['session'],
  'quirky.terminal/claim': ['session', 'cols', 'rows'],
  'quirky.terminal/read': ['session', 'lines'],
  'quirky.terminal/snapshot': ['session'],
  'quirky.terminal/write': ['session', 'data'],
  'quirky.terminal/send': ['session', 'text', 'enter'],
  'quirky.terminal/resize': ['session', 'cols', 'rows']
})

export const WORKSPACE_PAGE_GRANTS: readonly MobileGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'externalLink']
export const SESSION_PAGE_GRANTS: readonly MobileGrant[] = ['rpc', 'storage', 'navigate', 'terminal', 'clipboard.read', 'clipboard.write', 'externalLink']

const FORBIDDEN_FIELDS: Record<string, true> = {
  token: true, deviceToken: true, secret: true, secretKey: true, credential: true, credentials: true,
  caller: true, role: true, deviceId: true, connection: true, clientId: true
}
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_TEXT_BYTES = 64 * 1024

export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes++
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index++
    } else bytes += 3
  }
  return bytes
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validTree(value: unknown, depth = 0, rejectIdentityFields = true): boolean {
  if (depth > 8) return false
  if (typeof value === 'string') return utf8ByteLength(value) <= MAX_TEXT_BYTES
  if (Array.isArray(value)) return value.length <= 2048 && value.every((item) => validTree(item, depth + 1, rejectIdentityFields))
  if (isPlainRecord(value)) {
    const keys = Object.keys(value)
    return keys.length <= 256 && keys.every((key) => (!rejectIdentityFields || !Object.hasOwn(FORBIDDEN_FIELDS, key)) && validTree(value[key], depth + 1, rejectIdentityFields))
  }
  return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function boundedString(params: Record<string, unknown>, key: string, required = true): boolean {
  const value = params[key]
  if (!required && value === undefined) return true
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

function viewport(params: Record<string, unknown>): boolean {
  return Number.isSafeInteger(params.cols) && (params.cols as number) >= 1 && (params.cols as number) <= 1000 &&
    Number.isSafeInteger(params.rows) && (params.rows as number) >= 1 && (params.rows as number) <= 500
}

function validPageSpecificParams(method: string, params: Record<string, unknown>): boolean {
  if (method === 'quirky.repo/list' || method === 'quirky.repo/groupList' || method === 'quirky.mobile/agentCatalog' ||
    method === 'quirky.loops/summaries') return Object.keys(params).length === 0
  if (method === 'quirky.worktree/list') return boundedString(params, 'repo', false)
  if (method === 'quirky.worktree/show' || method === 'quirky.worktree/describeRemove') return boundedString(params, 'worktree')
  if (method === 'quirky.worktree/remove') return boundedString(params, 'worktree') && params.yes === true && Object.keys(params).length === 2
  if (method === 'quirky.worktree/create') return boundedString(params, 'repo', false) && boundedString(params, 'name', false) &&
    boundedString(params, 'branchName', false) && boundedString(params, 'base', false) &&
    (params.name === undefined || (params.name as string).length <= 128)
  if (method === 'quirky.worktree/set') return boundedString(params, 'worktree') && typeof params.pinned === 'boolean' && boundedString(params, 'expectedInstanceId')
  if (method === 'quirky.session/list') return boundedString(params, 'worktree', false)
  if (method === 'quirky.session/create') return boundedString(params, 'worktree') && boundedString(params, 'agent') && viewport(params)
  if (method === 'quirky.session/setName') return boundedString(params, 'session') && typeof params.name === 'string' && params.name.length <= 128
  if (method === 'quirky.session/close' || method === 'quirky.terminal/describeClose' || method === 'quirky.terminal/clear' || method === 'quirky.terminal/snapshot' || method === 'quirky.terminal/mobileState') return boundedString(params, 'session')
  if (method === 'quirky.ask/list') return typeof params.pendingOnly === 'boolean'
  if (method === 'quirky.ask/answer') return boundedString(params, 'askId') && isPlainRecord(params.answers) && Object.keys(params.answers).length <= 100 &&
    (params.skipped === undefined || (Array.isArray(params.skipped) && params.skipped.length <= 100 &&
      params.skipped.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 1024)))
  if (method === 'quirky.terminal/attach') return boundedString(params, 'session') && viewport(params) && (params.historyLines === undefined || (Number.isSafeInteger(params.historyLines) && (params.historyLines as number) >= 0 && (params.historyLines as number) <= 10000))
  if (method === 'quirky.terminal/detach') return Number.isSafeInteger(params.streamId) && (params.streamId as number) > 0
  if (method === 'quirky.terminal/claim' || method === 'quirky.terminal/resize') return boundedString(params, 'session') && viewport(params)
  if (method === 'quirky.terminal/read') return boundedString(params, 'session') && (params.lines === undefined || (Number.isSafeInteger(params.lines) && (params.lines as number) >= 0 && (params.lines as number) <= 2000))
  if (method === 'quirky.terminal/write') return boundedString(params, 'session') && typeof params.data === 'string' && utf8ByteLength(params.data) <= MAX_TEXT_BYTES
  if (method === 'quirky.terminal/send') return boundedString(params, 'session') && typeof params.text === 'string' && utf8ByteLength(params.text) <= MAX_TEXT_BYTES && (params.enter === undefined || typeof params.enter === 'boolean')
  if (method === 'quirky.terminal/displayMode') {
    if (!boundedString(params, 'session')) return false
    if (params.mode === 'phone') return Object.keys(params).length === 4 && viewport(params)
    return params.mode === 'desktop' && Object.keys(params).length === 2
  }
  return false
}

export function validatePageRpc(method: unknown, params: unknown, grants: readonly MobileGrant[]): asserts method is string {
  if (typeof method !== 'string' || !Object.hasOwn(PAGE_METHOD_PARAMS, method)) throw new Error('Quirky method is unavailable to page apps')
  if (!grants.includes('rpc')) throw new Error('page route does not have the rpc grant')
  if (method.startsWith('quirky.terminal/') && !grants.includes('terminal')) throw new Error('page route does not have the terminal grant')
  if (!isPlainRecord(params) || !validTree(params, 0, false) || Object.keys(params).some((key) => !PAGE_METHOD_PARAMS[method]!.includes(key)) || !validPageSpecificParams(method, params)) {
    throw new Error('page RPC parameters are invalid')
  }
  const serialized = JSON.stringify({ method, params })
  if (!serialized || utf8ByteLength(serialized) > 640 * 1024) throw new Error('page RPC envelope exceeds the bridge limit')
}

export function isPageMutation(method: string): boolean {
  return method === 'quirky.worktree/create' || method === 'quirky.worktree/remove' || method === 'quirky.worktree/set' ||
    method === 'quirky.session/create' || method === 'quirky.session/setName' || method === 'quirky.session/close' ||
    method === 'quirky.ask/answer' || method === 'quirky.terminal/attach' || method === 'quirky.terminal/detach' ||
    method === 'quirky.terminal/clear' || method === 'quirky.terminal/displayMode' || method === 'quirky.terminal/claim' ||
    method === 'quirky.terminal/write' || method === 'quirky.terminal/send' || method === 'quirky.terminal/resize'
}

export function validatePageInit(init: MobilePageInit): void {
  if (!init || init.v !== 1 || !SESSION_ID.test(init.sessionId)) throw new Error('page bridge init is invalid')
  validateRoute(init.route)
  const expected = init.route.kind === 'workspaces' ? WORKSPACE_PAGE_GRANTS : SESSION_PAGE_GRANTS
  if (!Array.isArray(init.grants) || init.grants.length !== expected.length || expected.some((grant) => !init.grants.includes(grant))) throw new Error('page route grants are invalid')
  if (!validTree(init.host) || !validTree(init.preferences) || !validTree(init.safeArea) || !validTree(init.connectionState)) throw new Error('page bridge init contains unsafe data')
}

export function validateRoute(route: MobileRoute | { kind: 'home' }): void {
  if (route.kind === 'home') {
    if (Object.keys(route).length !== 1) throw new Error('home navigation route is invalid')
    return
  }
  if (route.kind === 'workspaces') {
    if (Object.keys(route).length !== 1) throw new Error('workspace navigation route is invalid')
    return
  }
  if (route.kind === 'session' && Object.keys(route).every((key) => ['kind', 'worktreeId', 'sessionId'].includes(key)) &&
    typeof route.worktreeId === 'string' && route.worktreeId.length > 0 && route.worktreeId.length <= 1024 &&
    (route.sessionId === undefined || (typeof route.sessionId === 'string' && route.sessionId.length <= 1024))) return
  throw new Error('page navigation route is invalid')
}

const CONNECTION_PHASE: Record<string, true> = {
  disconnected: true, connecting: true, connected: true, reconnecting: true,
  unreachable: true, 'auth-failed': true, 'credential-missing': true, 'credential-unavailable': true
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

function validIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 256 && value.every(validId)
}

function validLoopSummaryReport(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 256) return false
  return value.every((item) => {
    if (!isPlainRecord(item)) return false
    const fields = ['worktreeId', 'loopId', 'label']
    return Object.keys(item).length === fields.length && Object.keys(item).every((key) => fields.includes(key)) &&
      validId(item.worktreeId) && validId(item.loopId) && typeof item.label === 'string' && item.label.length > 0 && item.label.length <= 2048
  })
}

export function validatePageReport(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !validTree(value) || typeof value.route !== 'string' ||
    typeof value.connectionPhase !== 'string' || !Object.hasOwn(CONNECTION_PHASE, value.connectionPhase) || typeof value.stale !== 'boolean') {
    throw new Error('page report is invalid')
  }
  const common = ['route', 'connectionPhase', 'stale']
  if (value.route === 'workspaces') {
    const fields = [...common, 'visibleWorktreeIds', 'searchOpen', 'optionsOpen', 'sidebarCollapsed', 'detailMode', 'loopSummaryStatus', 'loopSummaries']
    if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key)) ||
      !validIdArray(value.visibleWorktreeIds) || typeof value.searchOpen !== 'boolean' || typeof value.optionsOpen !== 'boolean' ||
      typeof value.sidebarCollapsed !== 'boolean' || (value.detailMode !== 'detailed' && value.detailMode !== 'compact') ||
      (value.loopSummaryStatus !== 'available' && value.loopSummaryStatus !== 'unavailable') || !validLoopSummaryReport(value.loopSummaries)) {
      throw new Error('workspace page report is invalid')
    }
    return
  }
  if (value.route === 'session') {
    const required = [...common, 'worktreeId', 'tabSessionIds', 'terminalVisible', 'dockOpen', 'sheetOpen', 'displayMode']
    const optional = ['sessionId', 'selectedSessionId']
    if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
      !validId(value.worktreeId) || !validIdArray(value.tabSessionIds) ||
      (value.sessionId !== undefined && !validId(value.sessionId)) || (value.selectedSessionId !== undefined && !validId(value.selectedSessionId)) ||
      typeof value.terminalVisible !== 'boolean' || typeof value.dockOpen !== 'boolean' || typeof value.sheetOpen !== 'boolean' ||
      (value.displayMode !== 'phone' && value.displayMode !== 'desktop')) throw new Error('session page report is invalid')
    return
  }
  throw new Error('page report route is invalid')
}

export function sanitizeConnectionState(value: unknown): MobileConnectionState {
  if (!isPlainRecord(value) || typeof value.phase !== 'string' || !Object.hasOwn(CONNECTION_PHASE, value.phase) ||
    !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 ||
    (value.connectedAt !== undefined && (typeof value.connectedAt !== 'number' || !Number.isFinite(value.connectedAt)))) {
    throw new Error('mobile connection state is invalid')
  }
  return {
    phase: value.phase as MobileConnectionState['phase'],
    attempts: value.attempts as number,
    ...(value.connectedAt === undefined ? {} : { connectedAt: value.connectedAt as number })
  }
}
