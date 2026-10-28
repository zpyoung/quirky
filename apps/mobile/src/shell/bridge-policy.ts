import type { MobileConnectionState, MobileGrant, MobilePageInit, MobileRoute } from '../contracts'
import { PANEL_METHOD_PARAMS } from '@quirky/protocol'
import { PANEL_ROUTE_FIELDS, validatePanelRoute } from '../panels/routes'
import { PAGE_BUNDLE_ROUTES } from './generation'

export const PAGE_METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'quirky.repo/list': [],
  'quirky.repo/groupList': [],
  'quirky.mobile/agentCatalog': [],
  'quirky.mobile/notificationPoll': ['subscriptionId', 'waitMs', 'after', 'epoch', 'onlyWhenDesktopAway', 'suppressWorktree'],
  'quirky.mobile/notificationCancel': ['subscriptionId'],
  'quirky.mobile/notificationTest': [],
  'quirky.worktree/list': ['repo'],
  'quirky.worktree/show': ['worktree'],
  'quirky.worktree/resolve': ['selector'],
  'quirky.worktree/create': ['repo', 'name', 'branchName', 'base'],
  'quirky.worktree/describeRemove': ['worktree'],
  'quirky.worktree/remove': ['worktree', 'yes'],
  'quirky.worktree/set': ['worktree', 'pinned', 'expectedInstanceId'],
  'quirky.session/list': ['worktree'],
  'quirky.session/get': ['session'],
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
  'quirky.terminal/resize': ['session', 'cols', 'rows'],
  ...PANEL_METHOD_PARAMS
})

export const WORKSPACE_PAGE_GRANTS: readonly MobileGrant[] = PAGE_BUNDLE_ROUTES.find((route) => route.kind === 'workspaces')!.grants
export const SESSION_PAGE_GRANTS: readonly MobileGrant[] = PAGE_BUNDLE_ROUTES.find((route) => route.kind === 'session')!.grants

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
function boundedEditorChunk(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 * 1024 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length / 4 * 3 - padding <= 48 * 1024
}

function validPageSpecificParams(method: string, params: Record<string, unknown>): boolean {
  if (method === 'quirky.repo/list' || method === 'quirky.repo/groupList' || method === 'quirky.mobile/agentCatalog' || method === 'quirky.mobile/notificationTest') return Object.keys(params).length === 0
  if (method === 'quirky.mobile/notificationPoll') return typeof params.subscriptionId === 'string' && params.subscriptionId.length > 0 && params.subscriptionId.length <= 128 &&
    Number.isSafeInteger(params.waitMs) && (params.waitMs as number) >= 0 && (params.waitMs as number) <= 25_000 &&
    (params.after === undefined || (Number.isSafeInteger(params.after) && (params.after as number) >= 0)) &&
    (params.epoch === undefined || (typeof params.epoch === 'string' && params.epoch.length <= 64)) &&
    typeof params.onlyWhenDesktopAway === 'boolean' && boundedString(params, 'suppressWorktree', false)
  if (method === 'quirky.mobile/notificationCancel') return typeof params.subscriptionId === 'string' &&
    params.subscriptionId.length > 0 && params.subscriptionId.length <= 128
  if (method === 'quirky.worktree/list') return boundedString(params, 'repo', false)
  if (method === 'quirky.worktree/show' || method === 'quirky.worktree/describeRemove') return boundedString(params, 'worktree')
  if (method === 'quirky.worktree/resolve') return typeof params.selector === 'string' && params.selector.length > 0 && params.selector.length <= 1027
  if (method === 'quirky.worktree/remove') return boundedString(params, 'worktree') && params.yes === true && Object.keys(params).length === 2
  if (method === 'quirky.worktree/create') return boundedString(params, 'repo', false) && boundedString(params, 'name', false) &&
    boundedString(params, 'branchName', false) && boundedString(params, 'base', false) &&
    (params.name === undefined || (params.name as string).length <= 128)
  if (method === 'quirky.worktree/set') return boundedString(params, 'worktree') && typeof params.pinned === 'boolean' && boundedString(params, 'expectedInstanceId')
  if (method === 'quirky.session/list') return boundedString(params, 'worktree', false)
  if (method === 'quirky.session/get' || method === 'quirky.session/close' || method === 'quirky.terminal/describeClose' || method === 'quirky.terminal/clear' || method === 'quirky.terminal/snapshot' || method === 'quirky.terminal/mobileState') return boundedString(params, 'session')
  if (method === 'quirky.session/create') return boundedString(params, 'worktree') && boundedString(params, 'agent') && viewport(params)
  if (method === 'quirky.session/setName') return boundedString(params, 'session') && typeof params.name === 'string' && params.name.length <= 128
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
  if (method === 'quirky.editor/read') {
    const text = params.action === 'text'
    const bytes = params.action === 'bytes'
    return boundedString(params, 'bufferId') && (text || bytes) &&
      Number.isSafeInteger(params.offset) && (params.offset as number) >= 0 &&
      Number.isSafeInteger(params.length) && (params.length as number) >= 0 &&
      (params.contentRevision === undefined || (Number.isSafeInteger(params.contentRevision) && (params.contentRevision as number) >= 0)) &&
      (text
        ? (params.kind === 'content' || params.kind === 'draft') && (params.length as number) <= 64 * 1024
        : params.kind === undefined && (params.length as number) <= 384 * 1024)
  }
  if (method === 'quirky.editor/draft') return boundedString(params, 'bufferId') &&
    typeof params.content === 'string' && utf8ByteLength(params.content) <= 48 * 1024 &&
    Number.isSafeInteger(params.expectedRevision) && (params.expectedRevision as number) >= 0
  if (method === 'quirky.editor/transfer') {
    if (params.action === 'begin') return Object.keys(params).length === 5 && params.kind === 'draft' && boundedString(params, 'bufferId') &&
      Number.isSafeInteger(params.expectedRevision) && (params.expectedRevision as number) >= 0 &&
      Number.isSafeInteger(params.totalBytes) && (params.totalBytes as number) > 0 && (params.totalBytes as number) <= 1024 * 1024
    if (params.action === 'chunk') return Object.keys(params).length === 4 && boundedString(params, 'transferId') &&
      Number.isSafeInteger(params.offset) && (params.offset as number) >= 0 && (params.offset as number) <= 1024 * 1024 && boundedEditorChunk(params.data)
    if (params.action === 'commit' || params.action === 'cancel') return Object.keys(params).length === 2 && boundedString(params, 'transferId')
    return false
  }
  return Object.hasOwn(PANEL_METHOD_PARAMS, method)
}

export function validatePageRpc(method: unknown, params: unknown, grants: readonly MobileGrant[], route: MobileRoute): asserts method is string {
  if (typeof method !== 'string' || !Object.hasOwn(PAGE_METHOD_PARAMS, method)) throw new Error('Quirky method is unavailable to page apps')
  if (!grants.includes('rpc')) throw new Error('page route does not have the rpc grant')
  if (Object.hasOwn(PANEL_METHOD_PARAMS, method) && (route.kind === 'workspaces' || route.kind === 'session')) throw new Error('panel RPC method is unavailable to base pages')
  if (method.startsWith('quirky.terminal/') && !grants.includes('terminal')) throw new Error('page route does not have the terminal grant')
  if (!isPlainRecord(params) || !validTree(params, 0, false) || Object.keys(params).some((key) => !PAGE_METHOD_PARAMS[method]!.includes(key)) || !validPageSpecificParams(method, params)) {
    throw new Error('page RPC parameters are invalid')
  }
  const serialized = JSON.stringify({ method, params })
  if (!serialized || utf8ByteLength(serialized) > 640 * 1024) throw new Error('page RPC envelope exceeds the bridge limit')
}

const PAGE_MUTATIONS: Record<string, true> = {
  'quirky.worktree/create': true,
  'quirky.worktree/remove': true,
  'quirky.worktree/set': true,
  'quirky.session/create': true,
  'quirky.session/setName': true,
  'quirky.session/close': true,
  'quirky.ask/answer': true,
  'quirky.terminal/attach': true,
  'quirky.terminal/detach': true,
  'quirky.terminal/clear': true,
  'quirky.terminal/displayMode': true,
  'quirky.terminal/claim': true,
  'quirky.terminal/write': true,
  'quirky.terminal/send': true,
  'quirky.terminal/resize': true,
  'quirky.git/stage': true,
  'quirky.git/unstage': true,
  'quirky.git/discard': true,
  'quirky.git/commit': true,
  'quirky.git/generateCommitMessage': true,
  'quirky.git/cancelGenerate': true,
  'quirky.git/push': true,
  'quirky.git/pull': true,
  'quirky.git/sync': true,
  'quirky.git/fetch': true,
  'quirky.git/fastForward': true,
  'quirky.git/forcePush': true,
  'quirky.git/switchBranch': true,
  'quirky.git/continue': true,
  'quirky.git/abort': true,
  'quirky.git/addNote': true,
  'quirky.git/editNote': true,
  'quirky.git/deleteNote': true,
  'quirky.git/formatNotes': true,
  'quirky.git/sendNotes': true,
  'quirky.hosting/create': true,
  'quirky.hosting/updateReview': true,
  'quirky.hosting/reviewers': true,
  'quirky.hosting/reviewAssignees': true,
  'quirky.hosting/reviewConversation': true,
  'quirky.editor/open': true,
  'quirky.editor/draft': true,
  'quirky.editor/transfer': true,
  'quirky.editor/save': true,
  'quirky.tasks/navigate': true,
  'quirky.tasks/issueEdit': true,
  'quirky.tasks/issueComment': true,
  'quirky.tasks/workspace': true,
  'quirky.tasks/workspaceComposerCancel': true,
  'quirky.accounts/refresh': true,
  'quirky.accounts/select': true,
  'quirky.vault/resume': true,
  'quirky.mobile/notificationPoll': true,
  'quirky.mobile/notificationCancel': true,
  'quirky.mobile/notificationTest': true
}

export function isPageMutation(method: string): boolean {
  return Object.hasOwn(PAGE_MUTATIONS, method)
}

function matchesPageGrants(actual: unknown, expected: readonly MobileGrant[]): actual is MobileGrant[] {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const seen: Record<string, true> = Object.create(null) as Record<string, true>
  for (const grant of actual) {
    if (typeof grant !== 'string' || !expected.includes(grant as MobileGrant) || Object.hasOwn(seen, grant)) return false
    seen[grant] = true
  }
  return expected.every((grant) => Object.hasOwn(seen, grant))
}

export function validatePageInit(init: MobilePageInit): void {
  if (!init || init.v !== 1 || !SESSION_ID.test(init.sessionId)) throw new Error('page bridge init is invalid')
  validateRoute(init.route)
  const expected = PAGE_BUNDLE_ROUTES.find((route) => route.kind === init.route.kind)
  if (!expected || !matchesPageGrants(init.grants, expected.grants)) throw new Error('page route grants are invalid')
  if (!validTree(init.host) || !validTree(init.preferences) || !validTree(init.safeArea) || !validTree(init.connectionState)) throw new Error('page bridge init contains unsafe data')
}

export function validateRoute(route: MobileRoute | { kind: 'home' }): void {
  if (!isPlainRecord(route) || typeof route.kind !== 'string') throw new Error('page navigation route is invalid')
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
  validatePanelRoute(route)
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

export function validatePageReport(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value) || !validTree(value) || typeof value.route !== 'string' ||
    typeof value.connectionPhase !== 'string' || !Object.hasOwn(CONNECTION_PHASE, value.connectionPhase) || typeof value.stale !== 'boolean') {
    throw new Error('page report is invalid')
  }
  const common = ['route', 'connectionPhase', 'stale']
  if (value.route === 'workspaces') {
    const fields = [...common, 'visibleWorktreeIds', 'searchOpen', 'optionsOpen', 'sidebarCollapsed', 'detailMode']
    if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key)) ||
      !validIdArray(value.visibleWorktreeIds) || typeof value.searchOpen !== 'boolean' || typeof value.optionsOpen !== 'boolean' ||
      typeof value.sidebarCollapsed !== 'boolean' || (value.detailMode !== 'detailed' && value.detailMode !== 'compact')) throw new Error('workspace page report is invalid')
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
  if (Object.hasOwn(PANEL_ROUTE_FIELDS, value.route)) {
    const fields = PANEL_ROUTE_FIELDS[value.route as keyof typeof PANEL_ROUTE_FIELDS]!
    if (Object.keys(value).some((key) => !common.includes(key) && !fields.includes(key))) throw new Error('panel page report is invalid')
    const route: Record<string, unknown> = { kind: value.route }
    for (const field of fields) {
      if (field !== 'kind' && Object.hasOwn(value, field)) route[field] = value[field]
    }
    try {
      validatePanelRoute(route)
    } catch {
      throw new Error('panel page report is invalid')
    }
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
