import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createIsolatedRuntimeEnvironment, type FixtureWorktree } from '../ui-review/fixtures'
import { readRuntime } from '@quirky/protocol/node'
import type { CliReceipt } from './cli-run'
import { checkIds } from './cli-checks'
import * as table from './cli-table'
import { CLI_FILE_OBSERVATION_BINDINGS } from './cli-table'
import { createCliFilesWorld, type CliFilesWorld } from './cli-world'

type JsonObject = Record<string, unknown>
type MaybePromise<T> = T | Promise<T>

export type CliFilesArguments = { json: boolean; help: boolean }
export type CliFileSnapshot = {
  connId: number
  windowWorktree: string
  windowViewId: string | null
  workspaceId: string
  groupId: string
  selectedTabId: string | null
  renderedTabId: string | null
  path: string | null
  documentHasFocus: boolean
  activeElement: { tag: string; role: string | null; inDocument: boolean }
  caret: { line: number; column: number } | null
}
export type CliFilePublicWindow = {
  connId: number
  receiptIds: { window: string; workspace: string; editor: string }
  windowState: JsonObject
  workspace: JsonObject
  editor: JsonObject
}
export type CliFileReviewCard = { path: string; expanded: boolean; loaded: boolean; text: string }
export type CliFileDomWindow = {
  connId: number
  workspaceId: string
  groupId: string
  selectedTabId: string | null
  renderedTabId: string | null
  path: string | null
  documentHasFocus: boolean
  activeElement: { tag: string; role: string | null; inDocument: boolean }
  activeElementHostedTabId: string | null
  activeElementIsSource: boolean
  reviewTabMounted: boolean
  caret: { line: number; column: number } | null
  lines: string[]
  reviewCards: CliFileReviewCard[]
}
export type CliFileObservationEvidence = {
  request: Record<string, unknown>
  public: { before: CliFilePublicWindow[]; after: CliFilePublicWindow[] }
  dom: { before: CliFileDomWindow[]; after: CliFileDomWindow[] }
  background?: { public: CliFilePublicWindow[]; dom: CliFileDomWindow[] }
  sentinels?: { a: JsonObject; b: JsonObject }
  review?: JsonObject
  routing?: JsonObject
  git?: JsonObject
  literal?: JsonObject
  elapsedMs?: number
  [key: string]: unknown
}
export type CliFileObservation = {
  id: string
  status: 'observed' | 'failed' | 'not-run'
  receiptIds: string[]
  before: CliFileSnapshot[]
  after: CliFileSnapshot[]
  evidence: CliFileObservationEvidence
  error?: { kind: string; message: string }
}
export type CliFilesReport = {
  schemaVersion: 1
  scope: 'goal-11-cli-files'
  ok: boolean
  parityComplete: false
  rows: Array<{
    id: string
    disposition: 'covered' | 'gap'
    status: 'observed' | 'failed' | 'not-run'
    executed: boolean
    observations: string[]
    differences: string[]
  }>
  observations: CliFileObservation[]
  receipts: CliReceipt[]
  cleanup: { ok: boolean; error?: string; evidence?: JsonObject }
  elapsedMs: number
  buildElapsedMs: number
  guards?: { denied: string[]; egress: string[]; injected: boolean }
  fixtures?: JsonObject
  error?: { stage: string; kind: string; message: string }
}
export type CliFilesRunOptions = {
  signal?: AbortSignal
  createWorld?: (options: { signal?: AbortSignal; deadline?: number }) => Promise<CliFilesWorld>
  onProgress?: (message: string) => MaybePromise<void>
}

export class CliFilesFailure extends Error {
  constructor(readonly kind: string, message: string, readonly stderrTail?: string) {
    super(message)
    this.name = 'CliFilesFailure'
  }
}

const WORK_LIMIT_MS = 330_000
const TEARDOWN_LIMIT_MS = 30_000
const CHILD_LIMIT_MS = 15_000
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 8 * 1024
const REQUIRED_ROW_BINDINGS = CLI_FILE_OBSERVATION_BINDINGS
const EXPECTED_OBSERVATIONS = [...new Set(Object.values(REQUIRED_ROW_BINDINGS).flat())]
const REVIEW_VIEW_ID = 'view:quirky.git/diff'
const SESSION_VIEW_ID = 'view:quirky.session/worktree'
const EDITOR_VIEW_ID = 'view:quirky.editor/document'
const LITERAL_PATH = "cli-parity/open '$(touch cli-injected); λ.txt"
const LITERAL_CONTENT = 'literal path\n'
const A_TARGET = 'src/app.ts'
const A_CONTENT = 'first A\nsecond A\n'
const B_TARGET = 'src/app.ts'
const B_CONTENT = 'first\nsecond λ\n'
const SENTINEL_PATH = 'docs/review-notes.md'
const A_SENTINEL_CONTENT = 'review notes A\n'
const B_SENTINEL_CONTENT = 'review notes B changed\n'
const REVIEW_PATHS = [A_TARGET, SENTINEL_PATH] as const
const EXPECTED_DIFFERENCES: Record<string, string[]> = {
  'file-diff': [
    'Review is one combined tab per worktree, not one diff tab per file.',
    'open-diff automatically activates Review; it has no explicit background presentation option.',
    'Review does not provide Orca edit/diff/both or staged/unstaged selection modes.'
  ],
  'file-open': [],
  'file-open-changed': [
    'open-changed uses one combined Review tab rather than per-file tabs.',
    'Review is automatically activated rather than optionally presented in the background.',
    'open-changed does not provide Orca edit/diff/both modes or staged/unstaged selection.'
  ],
  'file-open-render': [
    'Focused editor open activates the destination worktree tab but does not navigate the current window to that worktree.',
    'Headless DOM focus is not a native desktop foreground-window guarantee.'
  ]
}

/** Preserves literal filenames from Git's NUL-framed porcelain output. */
export function parseCliFilesGitPaths(stdout: string): string[] {
  if (stdout === '') return []
  if (!stdout.endsWith('\0')) throw new CliFilesFailure('fixture-git', 'Git status is not NUL terminated')
  const records = stdout.split('\0')
  const paths: string[] = []
  for (let index = 0; index < records.length - 1; index++) {
    const entry = records[index]
    if (!/^[ MADRCUT?!]{2} /.test(entry) || entry.length < 4) {
      throw new CliFilesFailure('fixture-git', 'Git status contains an invalid porcelain record')
    }
    paths.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2))) {
      index++
      if (index >= records.length - 1 || records[index] === '') {
        throw new CliFilesFailure('fixture-git', 'Git rename status omitted its original path')
      }
    }
  }
  return paths
}

/** Bounds read-only renderer work and fixture focus even when a page stops answering. */
export async function captureCliFilesRenderer<T>(read: () => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (signal.aborted) throw signal.reason
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CliFilesFailure('deadline', 'no renderer read time remains')
  const interrupted = Promise.withResolvers<never>()
  const abort = () => interrupted.reject(signal.reason ?? new CliFilesFailure('interrupted', 'renderer read interrupted'))
  const timer = setTimeout(() => interrupted.reject(new CliFilesFailure('dom-timeout', 'renderer evidence read timed out')), timeoutMs)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([Promise.resolve().then(read), interrupted.promise])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function record(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new CliFilesFailure('invalid-evidence', `${label} is not an object`)
  return value
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new CliFilesFailure('invalid-evidence', `${label} is not an array`)
  return value
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CliFilesFailure('invalid-evidence', `${label} is not a non-empty string`)
  return value
}
function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return string(value, label)
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new CliFilesFailure('invalid-evidence', `${label} is not a boolean`)
  return value
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new CliFilesFailure('invalid-evidence', `${label} is not an integer`)
  return value as number
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new CliFilesFailure('observation-mismatch', `${label} differed from its required evidence`)
  }
}
function includesText(actual: unknown, expected: string, label: string): void {
  if (typeof actual !== 'string' || !actual.includes(expected)) {
    throw new CliFilesFailure('observation-mismatch', `${label} did not contain the expected text`)
  }
}
function within(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate))
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}
function field(value: unknown, key: string, label: string): unknown {
  return record(value, label)[key]
}
function argvFlag(argv: readonly string[], flag: string, label: string): string {
  const index = argv.indexOf(flag)
  if (index < 0 || index + 1 >= argv.length) throw new CliFilesFailure('invalid-evidence', `${label} is missing ${flag}`)
  return argv[index + 1]!
}
function hasArgvFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag)
}
function commandOf(argv: readonly string[]): string {
  return argv.slice(0, 2).join(' ')
}
function tailIsLocalJson(argv: readonly string[]): boolean {
  return argv.length >= 4 && argv.at(-3) === '--runtime' && argv.at(-2) === 'local' && argv.at(-1) === '--json'
}
function sanitizeText(text: string, home: string, tokens: readonly string[]): string {
  let output = text
  if (home) output = output.split(home).join('<cli-home>')
  for (const token of tokens) if (token) output = output.split(token).join('<redacted>')
  output = output.replace(/([?#&](?:hookToken|runtimeToken|token)=)[^&#\s]+/gi, '$1<redacted>')
  output = output.replace(/((?:hookToken|runtimeToken|token|authorization|secret|password)\s*[=:]\s*)[^\s,"'}]+/gi, '$1<redacted>')
  return output
}
function sanitizeValue(value: unknown, home: string, tokens: readonly string[], key = ''): unknown {
  if (/^(?:token|hookToken|runtimeToken|sessionToken|authorization|secret|password)$/i.test(key)) return '<redacted>'
  if (typeof value === 'string') return sanitizeText(value, home, tokens)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, home, tokens))
  if (!isObject(value)) return value
  const result: JsonObject = {}
  for (const [childKey, child] of Object.entries(value)) result[childKey] = sanitizeValue(child, home, tokens, childKey)
  return result
}
function safeError(error: unknown): { kind: string; message: string; stderrTail?: string } {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const kind = typeof value.kind === 'string' ? value.kind : typeof value.code === 'string' ? value.code : 'observation-failed'
  const message = error instanceof Error ? error.message : String(error)
  const stderrTail = typeof value.stderrTail === 'string' ? value.stderrTail.slice(-MAX_DIAGNOSTIC_BYTES) : undefined
  return { kind, message, ...(stderrTail ? { stderrTail } : {}) }
}
function parseErrorEnvelope(value: unknown): { code: string; message: string; data?: unknown } {
  const outer = record(value, 'CLI refusal envelope')
  if (Object.keys(outer).length !== 1 || !Object.hasOwn(outer, 'error')) {
    throw new CliFilesFailure('malformed-output', 'CLI refusal did not emit one JSON error envelope')
  }
  const error = record(outer.error, 'CLI refusal error')
  const code = string(error.code, 'CLI refusal error.code')
  const message = string(error.message, 'CLI refusal error.message')
  return { code, message, ...(Object.hasOwn(error, 'data') ? { data: error.data } : {}) }
}
function asWorkspace(value: unknown): JsonObject {
  const outer = record(value, 'terminal workspace response')
  return isObject(outer.workspace) ? outer.workspace : outer
}
function tabsInWorkspace(workspaceValue: unknown): JsonObject[] {
  const workspace = asWorkspace(workspaceValue)
  const root = record(workspace.root, 'terminal workspace root')
  const result: JsonObject[] = []
  const visit = (node: JsonObject): void => {
    if (node.kind === 'group') {
      for (const item of array(node.tabs, 'terminal group tabs')) result.push(record(item, 'terminal tab'))
      return
    }
    if (node.kind === 'split') {
      visit(record(node.first, 'terminal first group'))
      visit(record(node.second, 'terminal second group'))
      return
    }
    throw new CliFilesFailure('invalid-evidence', 'terminal workspace contains an unknown group node')
  }
  visit(root)
  return result
}
function activeGroup(workspaceValue: unknown): JsonObject {
  const workspace = asWorkspace(workspaceValue)
  const activeGroupId = string(workspace.activeGroup, 'terminal workspace activeGroup')
  const root = record(workspace.root, 'terminal workspace root')
  const visit = (node: JsonObject): JsonObject | undefined => {
    if (node.kind === 'group') return node.id === activeGroupId ? node : undefined
    if (node.kind !== 'split') return undefined
    return visit(record(node.first, 'terminal first group')) ?? visit(record(node.second, 'terminal second group'))
  }
  const match = visit(root)
  if (!match) throw new CliFilesFailure('invalid-evidence', `active terminal group ${activeGroupId} is missing`)
  return match
}
function tabById(workspaceValue: unknown, id: string): JsonObject | undefined {
  return tabsInWorkspace(workspaceValue).find((tab) => tab.id === id)
}
function bufferById(editorValue: unknown, id: string): JsonObject | undefined {
  return array(record(editorValue, 'editor state').buffers, 'editor buffers')
    .map((entry) => record(entry, 'editor buffer'))
    .find((buffer) => buffer.id === id)
}
function workspaceViewTab(tab: JsonObject, label: string): { id: string; viewId: string; title: string; key: string; input: JsonObject } {
  return {
    id: string(tab.id, `${label}.id`),
    viewId: string(tab.viewId, `${label}.viewId`),
    title: string(tab.title, `${label}.title`),
    key: string(tab.key, `${label}.key`),
    input: record(tab.input, `${label}.input`)
  }
}
function sourceNavigation(buffer: JsonObject, tabId: string): { line: number; column: number } | undefined {
  const view = isObject(buffer.view) ? buffer.view : {}
  const byTabId = isObject(view.byTabId) ? view.byTabId : {}
  const tabView = isObject(byTabId[tabId]) ? byTabId[tabId] as JsonObject : {}
  const cursor = isObject(tabView.cursor) ? tabView.cursor : {}
  if (Number.isSafeInteger(cursor.line) && Number.isSafeInteger(cursor.column)) {
    return { line: cursor.line as number, column: cursor.column as number }
  }
  if (Number.isSafeInteger(tabView.line) && Number.isSafeInteger(tabView.column)) {
    return { line: tabView.line as number, column: tabView.column as number }
  }
  return undefined
}
function snapshotFrom(publicWindow: CliFilePublicWindow, domWindow: CliFileDomWindow): CliFileSnapshot {
  const state = record(publicWindow.windowState, 'ui.window.state')
  if (state.connId !== publicWindow.connId) throw new CliFilesFailure('connection-mismatch', 'public window readback returned another connection')
  const layout = record(state.layout, 'ui.window.state.layout')
  const workspace = asWorkspace(publicWindow.workspace)
  const group = activeGroup(publicWindow.workspace)
  const selected = nullableString(group.activeTab, 'terminal active tab')
  const view = layout.view === null ? null : record(layout.view, 'ui.window.state.layout.view')
  const result: CliFileSnapshot = {
    connId: publicWindow.connId,
    windowWorktree: string(layout.worktree, 'ui.window.state.layout.worktree'),
    windowViewId: view === null ? null : string(view.id, 'ui.window.state.layout.view.id'),
    workspaceId: string(workspace.id, 'terminal workspace.id'),
    groupId: string(group.id, 'terminal active group.id'),
    selectedTabId: selected,
    renderedTabId: domWindow.renderedTabId,
    path: domWindow.path,
    documentHasFocus: domWindow.documentHasFocus,
    activeElement: domWindow.activeElement,
    caret: domWindow.caret
  }
  assertSnapshotMatches(result, publicWindow, domWindow)
  return result
}
function assertSnapshotMatches(snapshot: CliFileSnapshot, publicWindow: CliFilePublicWindow, dom: CliFileDomWindow): void {
  const state = record(publicWindow.windowState, 'ui.window.state')
  const layout = record(state.layout, 'ui.window.state.layout')
  const workspace = asWorkspace(publicWindow.workspace)
  const group = activeGroup(publicWindow.workspace)
  const selected = nullableString(group.activeTab, 'terminal active tab')
  const view = layout.view === null ? null : record(layout.view, 'ui.window.state.layout.view')
  equal(snapshot.connId, publicWindow.connId, 'snapshot connection')
  equal(snapshot.connId, state.connId, 'window connection')
  equal(snapshot.connId, dom.connId, 'DOM connection')
  equal(snapshot.windowWorktree, layout.worktree, 'snapshot window worktree')
  equal(snapshot.windowViewId, view === null ? null : view.id, 'snapshot window view')
  equal(snapshot.workspaceId, workspace.id, 'snapshot public workspace')
  equal(snapshot.workspaceId, dom.workspaceId, 'DOM workspace')
  equal(snapshot.groupId, group.id, 'snapshot public active group')
  equal(snapshot.groupId, dom.groupId, 'DOM active group')
  equal(snapshot.selectedTabId, selected, 'snapshot public selected tab')
  equal(snapshot.selectedTabId, dom.selectedTabId, 'DOM selected tab')
  equal(snapshot.renderedTabId, dom.renderedTabId, 'DOM rendered tab')
  equal(snapshot.path, dom.path, 'DOM document path')
  equal(snapshot.documentHasFocus, dom.documentHasFocus, 'DOM hasFocus')
  equal(snapshot.activeElement, dom.activeElement, 'DOM active element')
  equal(snapshot.caret, dom.caret, 'native DOM caret')
}
function assertObservationReceiptSet(observation: CliFileObservation, receipts: CliReceipt[]): Map<string, CliReceipt> {
  if (!Array.isArray(observation.receiptIds) || observation.receiptIds.length === 0) {
    throw new CliFilesFailure('missing-receipt', `${observation.id} has no command receipts`)
  }
  if (new Set(observation.receiptIds).size !== observation.receiptIds.length) {
    throw new CliFilesFailure('duplicate-receipt', `${observation.id} repeats a receipt ID`)
  }
  const byId = new Map<string, CliReceipt>()
  for (const receipt of receipts) {
    if (byId.has(receipt.id)) throw new CliFilesFailure('duplicate-receipt', `duplicate CLI receipt ${receipt.id}`)
    byId.set(receipt.id, receipt)
  }
  for (const id of observation.receiptIds) {
    const receipt = byId.get(id)
    if (!receipt) throw new CliFilesFailure('missing-receipt', `${observation.id} references missing receipt ${id}`)
    if (!Array.isArray(receipt.argv) || !receipt.argv.every((arg) => typeof arg === 'string') || !tailIsLocalJson(receipt.argv)) {
      throw new CliFilesFailure('invalid-receipt', `receipt ${id} did not use local JSON CLI mode`)
    }
    equal(receipt.command, commandOf(receipt.argv), `receipt ${id} command label`)
    if (!Number.isSafeInteger(receipt.exitCode) || !Number.isSafeInteger(receipt.stdoutBytes) || receipt.stdoutBytes < 0 ||
        receipt.stdoutBytes > MAX_STDOUT_BYTES || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0 ||
        receipt.format !== 'json' || !isObject(receipt.evidence)) {
      throw new CliFilesFailure('invalid-receipt', `receipt ${id} has invalid bounded CLI measurements`)
    }
    if (receipt.stdoutBytes <= 0 || !Object.hasOwn(receipt.evidence, 'result')) {
      throw new CliFilesFailure('invalid-receipt', `receipt ${id} has no parsed CLI output`)
    }
    if (receipt.exitCode === 0) {
      if (isObject(receipt.evidence.result) && receipt.evidence.result.error !== undefined && receipt.evidence.result.error !== null) {
        throw new CliFilesFailure('cli-error', `receipt ${id} contains a zero-exit error envelope`)
      }
    } else parseErrorEnvelope(receipt.evidence.result)
  }
  return byId
}
function successfulReceipt(byId: Map<string, CliReceipt>, id: string): JsonObject {
  const receipt = byId.get(id)
  if (!receipt) throw new CliFilesFailure('missing-receipt', `missing receipt ${id}`)
  if (receipt.exitCode !== 0 || receipt.stdoutBytes <= 0) throw new CliFilesFailure('cli-exit', `receipt ${id} is not a successful invocation`)
  const result = receipt.evidence.result
  if (!isObject(result) && !Array.isArray(result) && (typeof result !== 'string' && typeof result !== 'number' && typeof result !== 'boolean')) {
    throw new CliFilesFailure('malformed-output', `receipt ${id} has no parsed JSON result`)
  }
  if (isObject(result) && result.error !== undefined && result.error !== null) {
    throw new CliFilesFailure('cli-error', `receipt ${id} contains a zero-exit error envelope`)
  }
  if (!Array.isArray(result) && !isObject(result)) throw new CliFilesFailure('malformed-output', `receipt ${id} did not contain an object result`)
  return result as JsonObject
}
function assertPublicRead(publicWindow: CliFilePublicWindow, byId: Map<string, CliReceipt>, observation: CliFileObservation, label: string): void {
  if (!Number.isSafeInteger(publicWindow.connId) || publicWindow.connId <= 0) throw new CliFilesFailure('invalid-evidence', `${label} connection ID is invalid`)
  const refs = record(publicWindow.receiptIds, `${label}.receiptIds`)
  for (const name of ['window', 'workspace', 'editor'] as const) {
    const receiptId = string(refs[name], `${label}.receiptIds.${name}`)
    assertReceiptLinked(observation, receiptId, `${label} ${name}`)
    const result = successfulReceipt(byId, receiptId)
    equal(result, publicWindow[name === 'window' ? 'windowState' : name], `${label} public ${name} readback`)
    const receipt = byId.get(receiptId)!
    const argv = receipt.argv
    if (name === 'window') {
      if (commandOf(argv) !== 'api call' || argv[2] !== 'ui.window.state' ||
          Number(argv[argv.indexOf('--conn-id') + 1]) !== publicWindow.connId) {
        throw new CliFilesFailure('invalid-receipt', `${label} window-state receipt targets a different connection`)
      }
      if (record(result, `${label} ui.window.state`).connId !== publicWindow.connId) {
        throw new CliFilesFailure('connection-mismatch', `${label} window state belongs to another connection`)
      }
    } else if (name === 'workspace') {
      if (commandOf(argv) !== 'api call' || argv[2] !== 'quirky.terminal/workspace') {
        throw new CliFilesFailure('invalid-receipt', `${label} workspace receipt is not the public terminal workspace route`)
      }
      const expectedWorkspace = string(record(publicWindow.windowState.layout, `${label} layout`).worktree, `${label} window worktree`)
      if (argvFlag(argv, '--workspace', `${label} workspace receipt`) !== expectedWorkspace) {
        throw new CliFilesFailure('worktree-mismatch', `${label} workspace receipt targets a different worktree`)
      }
      equal(result, publicWindow.workspace, `${label} public workspace readback`)
    } else {
      if (commandOf(argv) !== 'editor state') throw new CliFilesFailure('invalid-receipt', `${label} editor receipt is not editor state`)
      const expectedWorkspace = string(record(publicWindow.windowState.layout, `${label} layout`).worktree, `${label} window worktree`)
      if (argvFlag(argv, '--worktree', `${label} editor-state receipt`) !== expectedWorkspace) {
        throw new CliFilesFailure('worktree-mismatch', `${label} editor-state receipt targets another worktree`)
      }
      equal(result, publicWindow.editor, `${label} public editor readback`)
    }
  }
}
function assertSample(
  snapshots: CliFileSnapshot[],
  publicWindows: CliFilePublicWindow[],
  domWindows: CliFileDomWindow[],
  byId: Map<string, CliReceipt>,
  observation: CliFileObservation,
  label: string,
  requireDistinctWorkspaces = true
): void {
  if (snapshots.length !== 2 || publicWindows.length !== 2 || domWindows.length !== 2) {
    throw new CliFilesFailure('missing-observation', `${label} must contain both live windows`)
  }
  const connIds = new Set<number>()
  for (let index = 0; index < 2; index += 1) {
    const snapshot = snapshots[index]!
    const publicWindow = publicWindows[index]!
    const domWindow = domWindows[index]!
    if (connIds.has(snapshot.connId)) throw new CliFilesFailure('connection-mismatch', `${label} repeats a window connection`)
    connIds.add(snapshot.connId)
    if (publicWindow.connId !== snapshot.connId || domWindow.connId !== snapshot.connId) {
      throw new CliFilesFailure('connection-mismatch', `${label} page order does not match public connection identity`)
    }
    assertPublicRead(publicWindow, byId, observation, `${label} window ${index}`)
    assertSnapshotMatches(snapshot, publicWindow, domWindow)
  }
  if (requireDistinctWorkspaces && snapshots[0]!.workspaceId === snapshots[1]!.workspaceId) {
    throw new CliFilesFailure('worktree-mismatch', `${label} does not show distinct worktree workspaces`)
  }
}
function hasReceipt(observation: CliFileObservation, receiptId: string): boolean {
  return observation.receiptIds.includes(receiptId)
}
function assertReceiptLinked(observation: CliFileObservation, receiptId: string, label: string): void {
  if (!hasReceipt(observation, receiptId)) throw new CliFilesFailure('missing-receipt', `${label} readback receipt is not linked to ${observation.id}`)
}
function expectedAbsolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split(/[\\/]+/))
}
function isNormalizedAbsolute(value: string): boolean {
  return isAbsolute(value) || value.startsWith('<cli-home>/')
}
function readPathBuffer(value: unknown, id: string, label: string): JsonObject {
  const result = record(value, label)
  const buffer = record(result.buffer, `${label}.buffer`)
  equal(buffer.id, id, `${label} buffer identity`)
  return buffer
}
function editorOpenReceipts(observation: CliFileObservation, byId: Map<string, CliReceipt>, relativePath: string): CliReceipt[] {
  return observation.receiptIds.map((id) => byId.get(id)!).filter((receipt) =>
    receipt.command === 'editor open' && receipt.argv[2] === relativePath
  )
}
function selectedTabId(workspaceValue: unknown): string | null {
  const group = activeGroup(workspaceValue)
  return nullableString(group.activeTab, 'selected terminal tab')
}
function checkDocumentTab(publicWindow: CliFilePublicWindow, dom: CliFileDomWindow, tabId: string, path: string, contentLines?: string[]): void {
  const tab = tabById(publicWindow.workspace, tabId)
  if (!tab) throw new CliFilesFailure('tab-mismatch', `hosted tab ${tabId} is absent from public workspace readback`)
  if (tab.kind !== 'view' || tab.viewId !== EDITOR_VIEW_ID) throw new CliFilesFailure('view-mismatch', `tab ${tabId} is not the editor document view`)
  const input = record(tab.input, `editor tab ${tabId} input`)
  equal(input.mode, 'source', `editor tab ${tabId} source mode`)
  const bufferId = string(input.bufferId, `editor tab ${tabId} buffer ID`)
  const buffer = bufferById(publicWindow.editor, bufferId)
  if (!buffer) throw new CliFilesFailure('buffer-mismatch', `editor tab ${tabId} has no public buffer`)
  equal(buffer.mode, 'source', `editor buffer ${bufferId} source mode`)
  equal(buffer.tabId, tabId, `editor buffer tab ${tabId}`)
  equal(buffer.path, path, `editor buffer absolute path ${tabId}`)
  equal(dom.renderedTabId, tabId, `rendered editor tab ${tabId}`)
  equal(dom.path, path, `rendered editor path ${tabId}`)
  if (contentLines) equal(dom.lines, contentLines, `rendered editor lines ${tabId}`)
}
function checkSentinel(publicWindow: CliFilePublicWindow, dom: CliFileDomWindow, sentinel: JsonObject, label: string): void {
  const worktreeId = string(sentinel.worktreeId, `${label} worktree ID`)
  const path = string(sentinel.absolutePath, `${label} absolute path`)
  const editor = record(publicWindow.editor, `${label} editor state`)
  const buffers = array(editor.buffers, `${label} buffers`).map((entry) => record(entry, `${label} buffer`))
  const buffer = buffers.find((entry) => entry.path === path && entry.worktreeId === worktreeId)
  if (!buffer) throw new CliFilesFailure('missing-buffer', `${label} source-mode sentinel buffer is absent`)
  equal(buffer.mode, 'source', `${label} source-mode sentinel`)
  const tabId = string(buffer.tabId, `${label} tab ID`)
  const tab = tabById(publicWindow.workspace, tabId)
  if (!tab || tab.kind !== 'view' || tab.viewId !== EDITOR_VIEW_ID) {
    throw new CliFilesFailure('view-mismatch', `${label} sentinel is not an editor document tab`)
  }
  const input = record(tab.input, `${label} tab input`)
  equal(input.bufferId, buffer.id, `${label} sentinel tab-buffer link`)
  equal(input.mode, 'source', `${label} sentinel input mode`)
  equal(selectedTabId(publicWindow.workspace), tabId, `${label} selected sentinel tab`)
  equal(dom.selectedTabId, tabId, `${label} DOM selected sentinel tab`)
  equal(dom.renderedTabId, tabId, `${label} rendered sentinel tab`)
  equal(dom.path, path, `${label} visible sentinel path`)
  equal(dom.activeElement.inDocument, true, `${label} active element remains in document`)
  equal(dom.activeElementHostedTabId, tabId, `${label} sentinel focus tab`)
  equal(dom.activeElementIsSource, true, `${label} source editor focus`)
}
function checkOpenReceipt(
  receipt: CliReceipt,
  request: JsonObject,
  expectedFocus: boolean,
  label: string
): JsonObject {
  if (receipt.command !== 'editor open' || receipt.argv[0] !== 'editor' || receipt.argv[1] !== 'open') {
    throw new CliFilesFailure('invalid-receipt', `${label} is not an editor open receipt`)
  }
  const relativePath = string(request.relativePath, `${label} request path`)
  const worktreeId = string(request.worktreeId, `${label} request worktree`)
  const absolutePath = string(request.absolutePath, `${label} request absolute path`)
  if (!isNormalizedAbsolute(absolutePath)) throw new CliFilesFailure('path-mismatch', `${label} expected path is not absolute`)
  equal(receipt.argv[2], relativePath, `${label} CLI path bytes`)
  equal(argvFlag(receipt.argv, '--worktree', label), worktreeId, `${label} CLI worktree`)
  equal(argvFlag(receipt.argv, '--mode', label), 'source', `${label} CLI editor mode`)
  equal(hasArgvFlag(receipt.argv, '--focus'), expectedFocus, `${label} CLI focus flag`)
  if (request.line === undefined) {
    if (hasArgvFlag(receipt.argv, '--line')) throw new CliFilesFailure('navigation-mismatch', `${label} unexpectedly requested a line`)
  } else equal(argvFlag(receipt.argv, '--line', label), String(request.line), `${label} CLI requested line`)
  if (request.column === undefined) {
    if (hasArgvFlag(receipt.argv, '--column')) throw new CliFilesFailure('navigation-mismatch', `${label} unexpectedly requested a column`)
  } else equal(argvFlag(receipt.argv, '--column', label), String(request.column), `${label} CLI requested column`)
  const result = successfulReceipt(new Map([[receipt.id, receipt]]), receipt.id)
  equal(result.worktreeId, worktreeId, `${label} open result worktree`)
  equal(result.path, absolutePath, `${label} open result path`)
  equal(result.root && expectedAbsolute(String(result.root), relativePath), absolutePath, `${label} authorized root-relative path`)
  string(result.id, `${label} returned buffer ID`)
  string(result.openedTabId, `${label} returned hosted tab ID`)
  return result
}
function assertEditorObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  const beforePublic = observation.evidence.public.before
  const afterPublic = observation.evidence.public.after
  const beforeDom = observation.evidence.dom.before
  const afterDom = observation.evidence.dom.after
  assertSample(observation.before, beforePublic, beforeDom, byId, observation, `${observation.id} before`)
  assertSample(observation.after, afterPublic, afterDom, byId, observation, `${observation.id} after`)
  const deriveSentinel = (publicWindow: CliFilePublicWindow, dom: CliFileDomWindow, label: string): JsonObject => {
    const workspace = asWorkspace(publicWindow.workspace)
    const path = string(dom.path, `${label} visible sentinel path`)
    const worktreeId = string(workspace.id, `${label} worktree`)
    const buffers = array(publicWindow.editor.buffers, `${label} buffers`).map((entry) => record(entry, `${label} buffer`))
    const buffer = buffers.find((entry) => entry.path === path && entry.worktreeId === worktreeId)
    if (!buffer) throw new CliFilesFailure('missing-buffer', `${label} selected source sentinel is absent`)
    return { worktreeId, absolutePath: path, bufferId: string(buffer.id, `${label} buffer ID`), tabId: string(buffer.tabId, `${label} tab ID`) }
  }
  const sentinels = observation.evidence.sentinels
  const aSentinel = sentinels?.a ? record(sentinels.a, `${observation.id} sentinel A`) : deriveSentinel(beforePublic[0]!, beforeDom[0]!, 'sentinel A')
  const bSentinel = sentinels?.b ? record(sentinels.b, `${observation.id} sentinel B`) : deriveSentinel(beforePublic[1]!, beforeDom[1]!, 'sentinel B')
  const derivedA = deriveSentinel(beforePublic[0]!, beforeDom[0]!, 'sentinel A')
  const derivedB = deriveSentinel(beforePublic[1]!, beforeDom[1]!, 'sentinel B')
  equal(aSentinel.worktreeId, derivedA.worktreeId, 'sentinel A worktree identity')
  equal(aSentinel.absolutePath, derivedA.absolutePath, 'sentinel A path identity')
  equal(aSentinel.tabId, derivedA.tabId, 'sentinel A tab identity')
  equal(bSentinel.worktreeId, derivedB.worktreeId, 'sentinel B worktree identity')
  equal(bSentinel.absolutePath, derivedB.absolutePath, 'sentinel B path identity')
  equal(bSentinel.tabId, derivedB.tabId, 'sentinel B tab identity')
  const targetWorktree = string(request.worktreeId, `${observation.id} target worktree`)
  const targetPath = string(request.relativePath, `${observation.id} target path`)
  const targetAbsolute = string(request.absolutePath, `${observation.id} target absolute path`)
  const targetContent = string(request.content, `${observation.id} target bytes`)
  if (!isNormalizedAbsolute(targetAbsolute)) throw new CliFilesFailure('path-mismatch', `${observation.id} absolute path is invalid`)
  equal(request.mode, 'source', `${observation.id} requested mode`)
  equal(request.focus, true, `${observation.id} requested focus behavior`)
  const literal = observation.id === 'files-editor-literal-path'
  const targetIndex = observation.id === 'files-editor-other-worktree' ? 1 : 0
  const otherIndex = targetIndex === 0 ? 1 : 0
  const targetBefore = beforePublic[targetIndex]!
  const targetWorkspace = asWorkspace(targetBefore.workspace)
  equal(targetWorktree, targetWorkspace.id, `${observation.id} target window worktree`)
  equal(observation.before[targetIndex]!.windowWorktree, targetWorktree, `${observation.id} target window layout`)
  const targetRoot = string(
    array(targetBefore.editor.buffers, `${observation.id} baseline buffers`)
      .map((entry) => record(entry, `${observation.id} baseline buffer`))
      .find((entry) => entry.worktreeId === targetWorktree)?.root,
    `${observation.id} worktree root`
  )
  equal(expectedAbsolute(targetRoot, targetPath), targetAbsolute, `${observation.id} authorized target path`)
  equal(observation.before[otherIndex]!.windowWorktree, observation.before[otherIndex]!.workspaceId, `${observation.id} other window worktree`)
  checkSentinel(targetBefore, beforeDom[targetIndex]!, targetIndex === 0 ? aSentinel : bSentinel, `${observation.id} target baseline`)
  checkSentinel(beforePublic[otherIndex]!, beforeDom[otherIndex]!, otherIndex === 0 ? aSentinel : bSentinel, `${observation.id} other baseline`)
  if (literal) {
    equal(targetPath, LITERAL_PATH, 'literal relative path bytes')
    equal(targetContent, LITERAL_CONTENT, 'literal file bytes')
    equal(request.line, 1, 'literal file requested line')
    equal(request.column, 1, 'literal file requested column')
  } else {
    equal(request.line, 2, `${observation.id} requested line`)
    equal(request.column, 3, `${observation.id} requested column`)
    if (targetIndex === 0) {
      equal(targetPath, A_TARGET, 'same-worktree relative path')
      equal(targetContent, A_CONTENT, 'same-worktree file bytes')
    } else {
      equal(targetPath, B_TARGET, 'other-worktree relative path')
      equal(targetContent, B_CONTENT, 'other-worktree file bytes')
    }
  }
  const openReceipts = editorOpenReceipts(observation, byId, targetPath)
  if (literal) {
    if (openReceipts.length !== 1) throw new CliFilesFailure('missing-receipt', 'literal path observation must have exactly one target open')
    const opened = checkOpenReceipt(openReceipts[0]!, request, true, observation.id)
    const tabId = string(opened.openedTabId, `${observation.id} tab ID`)
    const bufferId = string(opened.id, `${observation.id} buffer ID`)
    const targetPub = afterPublic[targetIndex]!
    const targetDom = afterDom[targetIndex]!
    equal(opened.mode, 'source', `${observation.id} returned mode`)
    const root = string(opened.root, `${observation.id} root`)
    equal(expectedAbsolute(root, targetPath), targetAbsolute, `${observation.id} absolute authorization`)
    const buffer = bufferById(targetPub.editor, bufferId)
    if (!buffer) throw new CliFilesFailure('missing-buffer', `${observation.id} buffer is missing from editor readback`)
    equal(buffer.worktreeId, targetWorktree, `${observation.id} buffer worktree`)
    equal(buffer.path, targetAbsolute, `${observation.id} buffer path`)
    checkDocumentTab(targetPub, targetDom, tabId, targetAbsolute, ['literal path', ''])
    equal(targetDom.selectedTabId, tabId, `${observation.id} selected literal tab`)
    equal(targetDom.activeElementHostedTabId, tabId, `${observation.id} literal editor focus`)
    equal(targetDom.activeElementIsSource, true, `${observation.id} literal source focus`)
    equal(targetDom.activeElement.inDocument, true, `${observation.id} literal focus remains in document`)
    equal(targetDom.caret, { line: 1, column: 1 }, `${observation.id} native literal caret`)
    equal(targetDom.lines, ['literal path', ''], `${observation.id} rendered literal lines`)
    const readReceipt = findBufferRead(observation, byId, bufferId)
    const readBuffer = readPathBuffer(successfulReceipt(byId, readReceipt.id), bufferId, `${observation.id} buffer read`)
    equal(readBuffer.worktreeId, targetWorktree, `${observation.id} readback worktree`)
    equal(readBuffer.path, targetAbsolute, `${observation.id} readback absolute path`)
    equal(readBuffer.content, targetContent, `${observation.id} readback content`)
    const otherBuffers = array(afterPublic[otherIndex]!.editor.buffers, `${observation.id} other buffers`).map((entry) => record(entry, `${observation.id} other buffer`))
    if (otherBuffers.some((entry) => entry.path === targetAbsolute)) throw new CliFilesFailure('worktree-mismatch', 'literal A-only file appeared in the other worktree')
    equal(observation.evidence.literal?.existsInA, true, 'literal fixture exists only in A')
    checkSentinel(afterPublic[otherIndex]!, afterDom[otherIndex]!, bSentinel, 'literal path leaves B sentinel unchanged')
    equal(observation.after[otherIndex]!.windowWorktree, observation.before[otherIndex]!.windowWorktree, 'literal path leaves B worktree unchanged')
    equal(observation.after[otherIndex]!.selectedTabId, observation.before[otherIndex]!.selectedTabId, 'literal path leaves B selection unchanged')
    if (observation.evidence.literal?.injectionPresent !== false) throw new CliFilesFailure('literal-path-execution', 'literal file path injection sentinel was created')
    equal(observation.evidence.literal?.onlyInA, true, 'literal file A-only fixture')
    return
  }
  if (openReceipts.length !== 2) throw new CliFilesFailure('missing-receipt', `${observation.id} needs background and focus opens`)
  const backgroundReceipt = openReceipts.find((receipt) => !hasArgvFlag(receipt.argv, '--focus'))
  const focusReceipt = openReceipts.find((receipt) => hasArgvFlag(receipt.argv, '--focus'))
  if (!backgroundReceipt || !focusReceipt) throw new CliFilesFailure('missing-receipt', `${observation.id} did not execute both background and focused opens`)
  const backgroundOpen = checkOpenReceipt(backgroundReceipt, request, false, `${observation.id} background`)
  const focusedOpen = checkOpenReceipt(focusReceipt, request, true, `${observation.id} focused`)
  equal(backgroundOpen.id, focusedOpen.id, `${observation.id} reused buffer identity`)
  equal(backgroundOpen.openedTabId, focusedOpen.openedTabId, `${observation.id} reused hosted tab identity`)
  const background = observation.evidence.background
  if (!background || background.public.length !== 2 || background.dom.length !== 2) {
    throw new CliFilesFailure('missing-observation', `${observation.id} has no separate background-stage evidence`)
  }
  const backgroundSnapshots = background.public.map((entry, index) => snapshotFrom(entry, background.dom[index]!))
  assertSample(backgroundSnapshots, background.public, background.dom, byId, observation, `${observation.id} background`)
  const targetTabId = string(focusedOpen.openedTabId, `${observation.id} target tab`)
  const bufferId = string(focusedOpen.id, `${observation.id} buffer`)
  const bgTargetPub = background.public[targetIndex]!
  const bgTargetDom = background.dom[targetIndex]!
  if (selectedTabId(bgTargetPub.workspace) === targetTabId) {
    throw new CliFilesFailure('selection-mismatch', `${observation.id} background open selected its target tab`)
  }
  checkSentinel(bgTargetPub, bgTargetDom, targetIndex === 0 ? aSentinel : bSentinel, `${observation.id} background sentinel`)
  const bgBuffer = bufferById(bgTargetPub.editor, bufferId)
  if (!bgBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} background buffer is absent`)
  equal(bgBuffer.worktreeId, targetWorktree, `${observation.id} background buffer worktree`)
  equal(bgBuffer.path, targetAbsolute, `${observation.id} background buffer path`)
  const bgTab = tabById(bgTargetPub.workspace, targetTabId)
  if (!bgTab) throw new CliFilesFailure('missing-tab', `${observation.id} background tab is absent`)
  equal(bgTab.viewId, EDITOR_VIEW_ID, `${observation.id} background view ID`)
  equal(record(bgTab.input, `${observation.id} background input`).bufferId, bufferId, `${observation.id} background tab-buffer link`)
  equal(sourceNavigation(bgBuffer, targetTabId), { line: 2, column: 3 }, `${observation.id} saved background navigation`)
  checkSentinel(background.public[otherIndex]!, background.dom[otherIndex]!, otherIndex === 0 ? aSentinel : bSentinel, `${observation.id} background other window`)
  const targetPub = afterPublic[targetIndex]!
  const targetDom = afterDom[targetIndex]!
  const otherPub = afterPublic[otherIndex]!
  const otherDom = afterDom[otherIndex]!
  equal(observation.after[targetIndex]!.windowWorktree, targetWorktree, `${observation.id} focused target window worktree`)
  equal(observation.after[otherIndex]!.windowWorktree, observation.before[otherIndex]!.windowWorktree, `${observation.id} focused other window worktree`)
  equal(observation.after[otherIndex]!.selectedTabId, observation.before[otherIndex]!.selectedTabId, `${observation.id} focused other selection`)
  if (observation.id === 'files-editor-local') {
    equal(targetIndex, 0, 'same-worktree target page index')
    checkSentinel(otherPub, otherDom, bSentinel, 'same-worktree B remains on its sentinel')
  } else {
    equal(targetIndex, 1, 'cross-worktree target page index')
    checkSentinel(otherPub, otherDom, aSentinel, 'cross-worktree A remains on its sentinel')
  }
  const expectedLines = targetIndex === 0 ? ['first A', 'second A', ''] : ['first', 'second λ', '']
  checkDocumentTab(targetPub, targetDom, targetTabId, targetAbsolute, expectedLines)
  equal(targetDom.selectedTabId, targetTabId, `${observation.id} focused selected tab`)
  equal(targetDom.activeElementHostedTabId, targetTabId, `${observation.id} focused source tab`)
  equal(targetDom.activeElementIsSource, true, `${observation.id} source content focus`)
  equal(targetDom.activeElement.inDocument, true, `${observation.id} active source remains in document`)
  equal(targetDom.caret, { line: 2, column: 3 }, `${observation.id} visible native caret`)
  const finalBuffer = bufferById(targetPub.editor, bufferId)
  if (!finalBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} final buffer is absent`)
  equal(finalBuffer.worktreeId, targetWorktree, `${observation.id} final buffer worktree`)
  equal(finalBuffer.path, targetAbsolute, `${observation.id} final buffer path`)
  equal(expectedAbsolute(string(finalBuffer.root, `${observation.id} final buffer root`), targetPath), targetAbsolute, `${observation.id} final buffer authorized path`)
  const readReceipt = findBufferRead(observation, byId, bufferId)
  const readBuffer = readPathBuffer(successfulReceipt(byId, readReceipt.id), bufferId, `${observation.id} buffer read`)
  equal(readBuffer.worktreeId, targetWorktree, `${observation.id} readback worktree`)
  equal(readBuffer.path, targetAbsolute, `${observation.id} readback absolute path`)
  equal(readBuffer.content, targetContent, `${observation.id} readback bytes`)
  const pendingOrAcknowledged = sourceNavigation(finalBuffer, targetTabId)
  if (pendingOrAcknowledged && JSON.stringify(pendingOrAcknowledged) !== JSON.stringify({ line: 2, column: 3 })) {
    throw new CliFilesFailure('navigation-mismatch', `${observation.id} saved navigation differs from the request`)
  }
}
function findBufferRead(observation: CliFileObservation, byId: Map<string, CliReceipt>, bufferId: string): CliReceipt {
  const matches = observation.receiptIds.map((id) => byId.get(id)!).filter((receipt) =>
    receipt.command === 'editor read' && receipt.argv[0] === 'editor' && receipt.argv[1] === 'read' &&
    receipt.argv.includes('--buffer-id') && receipt.argv[receipt.argv.indexOf('--buffer-id') + 1] === bufferId &&
    receipt.argv.includes('--action') && receipt.argv[receipt.argv.indexOf('--action') + 1] === 'buffer'
  )
  if (matches.length !== 1) throw new CliFilesFailure('missing-receipt', `${observation.id} needs exactly one buffer readback for ${bufferId}`)
  return matches[0]!
}
function reviewKey(worktreeId: string): string {
  return `git-diff:${JSON.stringify([worktreeId, 'review'])}`
}
function reviewTabFor(workspaceValue: unknown, key: string): JsonObject[] {
  return tabsInWorkspace(workspaceValue).filter((tab) => tab.viewId === REVIEW_VIEW_ID && tab.key === key)
}
function reviewCards(dom: CliFileDomWindow[]): CliFileReviewCard[] {
  return dom.flatMap((window) => window.reviewCards)
}
function assertReviewCards(dom: CliFileDomWindow[], path: string, textNeedle?: string): void {
  const matching = reviewCards(dom).filter((card) => card.path === path)
  if (matching.length === 0) throw new CliFilesFailure('review-reveal-mismatch', `Review has no card for ${path}`)
  if (!matching.some((card) => card.expanded && card.loaded && (textNeedle === undefined || card.text.includes(textNeedle)))) {
    throw new CliFilesFailure('review-reveal-mismatch', `Review card ${path} is not expanded with loaded matching text`)
  }
}
function assertReviewSample(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  const beforePublic = observation.evidence.public.before
  const afterPublic = observation.evidence.public.after
  const beforeDom = observation.evidence.dom.before
  const afterDom = observation.evidence.dom.after
  assertSample(observation.before, beforePublic, beforeDom, byId, observation, `${observation.id} before`, observation.id !== 'files-review-reuse')
  assertSample(observation.after, afterPublic, afterDom, byId, observation, `${observation.id} after`, false)
  const review = record(observation.evidence.review, `${observation.id} review evidence`)
  const worktreeId = string(review.worktreeId, `${observation.id} Review worktree`)
  const path = review.path === null ? null : string(review.path, `${observation.id} Review path`)
  const targetConnId = integer(review.targetConnectionId, `${observation.id} target connection`)
  const key = reviewKey(worktreeId)
  equal(review.reviewKey, key, `${observation.id} stable Review key`)
  equal(request.worktreeId, worktreeId, `${observation.id} request worktree`)
  const expectedPath = observation.id === 'files-review-diff' ? A_TARGET :
    observation.id === 'files-review-reuse' ? SENTINEL_PATH : null
  equal(path, expectedPath, `${observation.id} requested Review path`)
  equal(request.path, expectedPath, `${observation.id} public command path`)
  equal(request.mode, 'review', `${observation.id} requested Review mode`)
  equal(request.targetConnectionId, targetConnId, `${observation.id} requested CLI target connection`)
  const targetIndex = observation.before.findIndex((snapshot) => snapshot.connId === targetConnId)
  if (targetIndex !== 0) throw new CliFilesFailure('connection-mismatch', `${observation.id} exact-window command did not target page A`)
  const afterB = afterPublic.find((window) => record(window.windowState.layout, `${observation.id} window layout`).worktree === worktreeId)
  const beforeB = beforePublic.find((window) => record(window.windowState.layout, `${observation.id} window layout`).worktree === worktreeId)
  if (!afterB || !beforeB) throw new CliFilesFailure('worktree-mismatch', `${observation.id} has no public readback for Review worktree B`)
  const beforeTabs = reviewTabFor(beforeB.workspace, key)
  const afterTabs = reviewTabFor(afterB.workspace, key)
  const bBuffers = array(beforeB.editor.buffers, `${observation.id} B editor buffers`).map((entry) => record(entry, `${observation.id} B editor buffer`))
  const bBuffer = bBuffers.find((entry) => entry.worktreeId === worktreeId)
  if (!bBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} has no public buffer for Review worktree B`)
  const bRoot = string(bBuffer.root, `${observation.id} B worktree root`)
  equal(request.absolutePath, expectedAbsolute(bRoot, path ?? ''), `${observation.id} absolute Review path`)
  equal(request.content, path === A_TARGET ? B_CONTENT : path === SENTINEL_PATH ? B_SENTINEL_CONTENT : B_CONTENT, `${observation.id} fixture content`)
  if (observation.id !== 'files-review-reuse') {
    const beforeA = beforePublic[targetIndex]!
    const beforeLayout = record(beforeA.windowState.layout, `${observation.id} baseline A layout`)
    if (beforeLayout.worktree === worktreeId) throw new CliFilesFailure('worktree-mismatch', `${observation.id} baseline A was not reset to its own worktree`)
    const sentinelPath = string(beforeDom[targetIndex]!.path, `${observation.id} baseline A sentinel path`)
    if (!sentinelPath.endsWith('/docs/review-notes.md')) {
      throw new CliFilesFailure('path-mismatch', `${observation.id} baseline A is not showing docs/review-notes.md`)
    }
    const sentinelTabId = selectedTabId(beforeA.workspace)
    if (!sentinelTabId) throw new CliFilesFailure('selection-mismatch', `${observation.id} baseline A has no selected sentinel`)
    checkSentinel(beforeA, beforeDom[targetIndex]!, {
      worktreeId: string(asWorkspace(beforeA.workspace).id, `${observation.id} A workspace`),
      absolutePath: sentinelPath
    }, `${observation.id} baseline A sentinel`)
  }
  for (let index = 0; index < 2; index += 1) {
    const layout = record(afterPublic[index]!.windowState.layout, `${observation.id} window ${index} layout`)
    equal(layout.worktree, worktreeId, `${observation.id} selected worktree in window ${index}`)
    equal(observation.after[index]!.windowWorktree, worktreeId, `${observation.id} snapshot worktree in window ${index}`)
  }
  if (observation.id === 'files-review-diff') {
    if (beforeTabs.length !== 0) throw new CliFilesFailure('review-tab-mismatch', 'cold Review baseline already has a Review tab')
    if (afterTabs.length !== 1) throw new CliFilesFailure('review-tab-mismatch', 'open-diff did not create exactly one Review tab')
    if (tabsInWorkspace(afterB.workspace).filter((tab) => tab.viewId === REVIEW_VIEW_ID).length !== 1) {
      throw new CliFilesFailure('review-tab-mismatch', 'open-diff created more than one hosted Review tab')
    }
  } else if (observation.id === 'files-review-reuse') {
    if (beforeTabs.length !== 1 || afterTabs.length !== 1) throw new CliFilesFailure('review-tab-mismatch', 'targeted diff did not reuse exactly one Review tab')
    equal(beforeTabs[0]!.id, afterTabs[0]!.id, 'targeted diff reused Review tab ID')
  } else {
    if (beforeTabs.length !== 0 || afterTabs.length !== 1) {
      throw new CliFilesFailure('review-tab-mismatch', 'open-changes did not create one clean Review tab')
    }
  }
  const tab = workspaceViewTab(afterTabs[0]!, `${observation.id} Review tab`)
  if (afterTabs[0]!.kind !== 'view') throw new CliFilesFailure('view-mismatch', `${observation.id} Review tab is not a hosted view`)
  equal(tab.viewId, REVIEW_VIEW_ID, `${observation.id} Review view ID`)
  equal(tab.title, 'Review', `${observation.id} Review title`)
  equal(tab.key, key, `${observation.id} Review key`)
  equal(tab.input.mode, 'review', `${observation.id} Review input mode`)
  equal(tab.input.worktree, worktreeId, `${observation.id} Review input worktree`)
  if (observation.id === 'files-review-diff') equal(tab.input.reveal, path, `${observation.id} cold Review input reveal`)
  const tabId = string(review.tabId, `${observation.id} Review tab ID`)
  equal(tab.id, tabId, `${observation.id} public Review tab ID`)
  const baselineTabIds = tabsInWorkspace(beforeB.workspace).map(entry => string(entry.id, 'baseline tab ID')).sort()
  const finalTabIds = tabsInWorkspace(afterB.workspace).map(entry => string(entry.id, 'final tab ID')).sort()
  const expectedTabIds = observation.id === 'files-review-reuse' ? baselineTabIds : [...baselineTabIds, tabId].sort()
  equal(finalTabIds, expectedTabIds, `${observation.id} exact workspace tab-set delta`)
  for (let index = 0; index < 2; index += 1) {
    const dom = afterDom[index]!
    equal(dom.selectedTabId, tabId, `${observation.id} shared Review tab selection`)
    equal(dom.renderedTabId, tabId, `${observation.id} rendered Review tab`)
    equal(dom.reviewTabMounted, true, `${observation.id} Review tab mounted in window ${index}`)
  }
  if (observation.id === 'files-review-diff') {
    assertReviewCards([afterDom[targetIndex]!], A_TARGET, 'second λ')
  } else if (observation.id === 'files-review-reuse') {
    assertReviewCards([afterDom[targetIndex]!], SENTINEL_PATH, 'review notes B changed')
  } else {
    const changed = array(review.changedPaths, `${observation.id} changed paths`).map((value) => string(value, 'changed path'))
    equal([...changed].sort(), [...REVIEW_PATHS].sort(), `${observation.id} changed path list`)
    assertReviewCards([afterDom[targetIndex]!], A_TARGET, 'second λ')
    for (const dom of afterDom) {
      if (!dom.reviewCards.some((card) => card.path === SENTINEL_PATH)) {
        throw new CliFilesFailure('review-reveal-mismatch', 'open-changes omitted docs/review-notes.md card')
      }
    }
    const repeat = record(review.repeatBefore, `${observation.id} repeated open-changes baseline`)
    const repeatPublic = record(repeat.public, `${observation.id} repeated public baseline`) as unknown as CliFilePublicWindow
    const repeatDom = record(repeat.dom, `${observation.id} repeated DOM baseline`) as unknown as CliFileDomWindow
    const repeatId = string(review.tabBeforeRepeat, `${observation.id} Review tab before repeat`)
    assertReceiptLinked(observation, repeatPublic.receiptIds.window, `${observation.id} repeat window`)
    assertReceiptLinked(observation, repeatPublic.receiptIds.workspace, `${observation.id} repeat workspace`)
    assertReceiptLinked(observation, repeatPublic.receiptIds.editor, `${observation.id} repeat editor`)
    assertPublicRead(repeatPublic, byId, observation, `${observation.id} repeat baseline`)
    const repeatSnapshot = snapshotFrom(repeatPublic, repeatDom)
    equal(repeatSnapshot.connId, targetConnId, `${observation.id} repeat baseline connection`)
    equal(repeatSnapshot.windowWorktree, worktreeId, `${observation.id} repeat baseline worktree`)
    equal(repeatDom.selectedTabId, repeatId, `${observation.id} Review selection before repeat`)
    equal(repeatDom.renderedTabId, repeatId, `${observation.id} rendered Review before repeat`)
    assertReviewCards([repeatDom], A_TARGET, 'second λ')
    const repeatTab = tabById(repeatPublic.workspace, repeatId)
    if (!repeatTab || repeatTab.viewId !== REVIEW_VIEW_ID || repeatTab.key !== key) {
      throw new CliFilesFailure('review-tab-mismatch', `${observation.id} repeat baseline does not contain the Review tab`)
    }
    equal(repeatTab.id, tabId, `${observation.id} open-changes repeat tab reuse`)
    const beforeTabIds = tabsInWorkspace(repeatPublic.workspace).map((entry) => string(entry.id, 'before-repeat tab ID')).sort()
    const afterTabIds = tabsInWorkspace(afterB.workspace).map((entry) => string(entry.id, 'after-repeat tab ID')).sort()
    equal(afterTabIds, beforeTabIds, `${observation.id} repeat open-changes created no per-file tabs`)
  }

  const relevantReceipts = observation.receiptIds.map((id) => byId.get(id)!)
  const commandId = observation.id === 'files-review-changed' ? 'command:quirky.git/open-changes' : 'command:quirky.git/open-diff'
  const exactCommands = relevantReceipts.filter((receipt) => receipt.command === 'api call' && receipt.argv[2] === 'ui.window.command.run' &&
    receipt.exitCode === 0 && receipt.argv.includes('--id') && receipt.argv[receipt.argv.indexOf('--id') + 1] === commandId)
  const expectedCommands = observation.id === 'files-review-changed' ? 2 : 1
  if (exactCommands.length !== expectedCommands) throw new CliFilesFailure('missing-receipt', `${observation.id} has an incorrect number of exact-window command receipts`)
  for (const exactCommand of exactCommands) {
    assertReceiptLinked(observation, exactCommand.id, `${observation.id} exact command`)
    equal(Number(argvFlag(exactCommand.argv, '--conn-id', `${observation.id} exact command`)), targetConnId, `${observation.id} exact target connection`)
    const args = JSON.parse(argvFlag(exactCommand.argv, '--args', `${observation.id} exact command`)) as JsonObject
    equal(args.worktree, worktreeId, `${observation.id} exact command worktree`)
    if (path !== null) equal(args.path, path, `${observation.id} exact command path`)
    else if (args.path !== undefined) throw new CliFilesFailure('invalid-receipt', 'open-changes unexpectedly included a file path')
  }

  if (observation.id === 'files-review-changed') {
    const git = record(observation.evidence.git, `${observation.id} public Git evidence`)
    for (const [phase, resultKey] of [['before', 'before'], ['after', 'after']] as const) {
      const receiptId = string(git[`${phase}ReceiptId`], `${observation.id} ${phase} Git status receipt`)
      assertReceiptLinked(observation, receiptId, `${observation.id} ${phase} Git status`)
      const receipt = byId.get(receiptId)!
      if (receipt.command !== 'api call' || receipt.argv[2] !== 'quirky.git/status' ||
          argvFlag(receipt.argv, '--worktree', `${observation.id} ${phase} Git status`) !== worktreeId) {
        throw new CliFilesFailure('invalid-receipt', `${observation.id} ${phase} status did not use public Git readback`)
      }
      const result = successfulReceipt(byId, receiptId)
      equal(result, git[resultKey], `${observation.id} ${phase} Git status readback`)
      const paths = array(record(result, `${observation.id} ${phase} status`).entries, `${observation.id} ${phase} status entries`)
        .map((entry) => string(record(entry, `${observation.id} ${phase} status entry`).path, 'Git status path')).sort()
      equal(paths, [...REVIEW_PATHS].sort(), `${observation.id} ${phase} changed file set`)
    }
    const supportIds = array(review.supportingReceiptIds, `${observation.id} supporting receipts`).map((entry) => string(entry, 'supporting receipt ID'))
    for (const receiptId of supportIds) {
      assertReceiptLinked(observation, receiptId, `${observation.id} supporting operation`)
      const receipt = byId.get(receiptId)!
      const supportCommand = argvFlag(receipt.argv, '--id', `${observation.id} supporting operation`)
      const supportArgs = JSON.parse(argvFlag(receipt.argv, '--args', `${observation.id} supporting operation`)) as JsonObject
      if (supportCommand === 'command:quirky.git/collapse-all') {
        equal(supportArgs.collapsed, false, `${observation.id} expansion support args`)
      } else if (supportCommand === 'command:quirky.git/load-diff') {
        equal(supportArgs.path, A_TARGET, `${observation.id} load support path`)
      } else {
        throw new CliFilesFailure('invalid-receipt', `${observation.id} has an unknown Review support command`)
      }
      if (receipt.command !== 'api call' || receipt.argv[2] !== 'ui.window.command.run' || receipt.exitCode !== 0) {
        throw new CliFilesFailure('invalid-receipt', `${observation.id} supporting operation was not a successful public window command`)
      }
      equal(Number(argvFlag(receipt.argv, '--conn-id', `${observation.id} supporting operation`)), targetConnId, `${observation.id} supporting window`)
    }
  }
}
function assertRoutingObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, 'routing before')
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, 'routing after')
  const routing = record(observation.evidence.routing, 'window routing evidence')
  const beforeA = observation.before[0]!
  const beforeB = observation.before[1]!
  const afterA = observation.after[0]!
  const afterB = observation.after[1]!
  equal(afterA.windowWorktree, beforeA.windowWorktree, 'ambiguous route A worktree')
  equal(afterB.windowWorktree, beforeB.windowWorktree, 'ambiguous route B worktree')
  equal(afterA.selectedTabId, beforeA.selectedTabId, 'ambiguous route A selection')
  equal(afterB.selectedTabId, beforeB.selectedTabId, 'ambiguous route B selection')
  equal(afterA.groupId, beforeA.groupId, 'ambiguous route A active group')
  equal(afterB.groupId, beforeB.groupId, 'ambiguous route B active group')
  const ambiguousId = string(routing.ambiguousReceiptId, 'ambiguous refusal receipt ID')
  assertReceiptLinked(observation, ambiguousId, 'ambiguous refusal')
  const ambiguous = byId.get(ambiguousId)!
  if (ambiguous.exitCode !== 1 || ambiguous.command !== 'ui run' || ambiguous.argv[0] !== 'ui' || ambiguous.argv[1] !== 'run') {
    throw new CliFilesFailure('invalid-refusal', 'ambiguous ui run was not an exit-1 refusal')
  }
  const refusal = parseErrorEnvelope(ambiguous.evidence.result)
  includesText(refusal.message, 'multiple Quirky windows are open; specify connId', 'ambiguous refusal message')
  if (hasArgvFlag(ambiguous.argv, '--conn-id')) throw new CliFilesFailure('invalid-refusal', 'ambiguous route unexpectedly selected a connection')
  const request = record(observation.evidence.request, 'window routing request')
  const ambiguousArgs = JSON.parse(argvFlag(ambiguous.argv, '--args', 'ambiguous ui run')) as JsonObject
  equal(ambiguousArgs.worktree, request.worktreeId, 'ambiguous route worktree')
  equal(ambiguousArgs.path, request.path, 'ambiguous route path')

  const staleId = string(routing.staleReceiptId, 'stale target receipt ID')
  assertReceiptLinked(observation, staleId, 'stale target refusal')
  const stale = byId.get(staleId)!
  if (stale.exitCode !== 1 || stale.command !== 'api call' || stale.argv[2] !== 'ui.window.command.run') {
    throw new CliFilesFailure('invalid-refusal', 'stale exact-window target did not refuse')
  }
  const staleError = parseErrorEnvelope(stale.evidence.result)
  if (staleError.message.length === 0) throw new CliFilesFailure('invalid-refusal', 'stale target refusal has no error message')
  const staleConn = Number(argvFlag(stale.argv, '--conn-id', 'stale route'))
  if (!Number.isSafeInteger(staleConn) || staleConn <= 0 || staleConn === beforeA.connId || staleConn === beforeB.connId) {
    throw new CliFilesFailure('invalid-refusal', 'stale route did not use an unknown connection')
  }
  equal(routing.staleConnId, staleConn, 'stale connection identity')
  equal(argvFlag(stale.argv, '--id', 'stale route'), 'command:quirky.git/open-diff', 'stale route command ID')
  const staleArgs = JSON.parse(argvFlag(stale.argv, '--args', 'stale route')) as JsonObject
  equal(staleArgs.worktree, request.worktreeId, 'stale route worktree')
  equal(staleArgs.path, request.path, 'stale route path')
  const reviewTabs = observation.evidence.public.after.flatMap((window) => {
    const workspaceId = string(asWorkspace(window.workspace).id, 'refused route workspace ID')
    return reviewTabFor(window.workspace, reviewKey(workspaceId))
  })
  if (reviewTabs.length !== 0) throw new CliFilesFailure('unexpected-route', 'refused routes opened a Review tab')
}

/** Revalidates a file observation from real receipts, independent public readback and live DOM data. */
export function assertCliFileObservation(observation: CliFileObservation, receipts: CliReceipt[]): void {
  if (!observation || !EXPECTED_OBSERVATIONS.includes(observation.id as (typeof EXPECTED_OBSERVATIONS)[number])) {
    throw new CliFilesFailure('unknown-observation', 'unknown CLI file observation ID')
  }
  if (observation.status !== 'observed') throw new CliFilesFailure('missing-observation', `${observation.id} is not marked observed`)
  if (!isObject(observation.evidence)) throw new CliFilesFailure('missing-observation', `${observation.id} has no independent evidence`)
  if ('observed' in observation && observation.observed !== undefined) {
    throw new CliFilesFailure('dishonest-evidence', 'an observed flag is not evidence')
  }
  if (observation.evidence.elapsedMs !== undefined &&
      (typeof observation.evidence.elapsedMs !== 'number' || observation.evidence.elapsedMs <= 0)) {
    throw new CliFilesFailure('invalid-observation', `${observation.id} has an invalid measured duration`)
  }
  const byId = assertObservationReceiptSet(observation, receipts)
  if (observation.id.startsWith('files-editor-')) assertEditorObservation(observation, byId)
  else if (observation.id.startsWith('files-review-')) assertReviewSample(observation, byId)
  else assertRoutingObservation(observation, byId)
}

/** Reduces only the four linked inventory rows; it never promotes a gap from observation evidence. */
export function reduceCliFilesRows(
  rows: table.CliTableRow[],
  observations: CliFileObservation[],
  receipts: CliReceipt[]
): CliFilesReport['rows'] {
  const bindings = CLI_FILE_OBSERVATION_BINDINGS as Readonly<Record<string, readonly string[]>>
  for (const [rowId, ids] of Object.entries(REQUIRED_ROW_BINDINGS)) {
    const actual = bindings[rowId]
    if (!actual || JSON.stringify(actual) !== JSON.stringify(ids)) {
      throw new CliFilesFailure('invalid-table', `observation binding for ${rowId} differs from the required registry`)
    }
  }
  for (const rowId of Object.keys(bindings)) {
    if (!Object.hasOwn(REQUIRED_ROW_BINDINGS, rowId)) throw new CliFilesFailure('invalid-table', `unexpected observation binding ${rowId}`)
  }
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  for (const [rowId, expectedIds] of Object.entries(REQUIRED_ROW_BINDINGS)) {
    const row = rowsById.get(rowId)
    if (!row) throw new CliFilesFailure('missing-row', `required observation row ${rowId} is missing`)
    if (row.disposition === 'excluded' || row.disposition === 'delegated') {
      throw new CliFilesFailure('invalid-table', `observation cannot run on ${row.disposition} row ${rowId}`)
    }
    if (row.disposition !== 'covered' && row.disposition !== 'gap') {
      throw new CliFilesFailure('invalid-table', `row ${rowId} has an unsupported observation disposition`)
    }
    if (JSON.stringify((row as table.CliTableRow & { observations?: string[] }).observations) !== JSON.stringify(expectedIds)) {
      throw new CliFilesFailure('invalid-table', `table row ${rowId} does not carry its compiled observation binding`)
    }
    if (row.checks.some((check) => expectedIds.includes(check))) {
      throw new CliFilesFailure('invalid-table', `row ${rowId} disguises observations as ordinary checks`)
    }
  }
  for (const row of rows) {
    if (Object.hasOwn(bindings, row.id)) continue
    if ((row as table.CliTableRow & { observations?: string[] }).observations !== undefined) {
      throw new CliFilesFailure('invalid-table', `observation is attached to unbound row ${row.id}`)
    }
  }
  const flattened = Object.values(bindings).flat()
  const expected = [...new Set(flattened)]
  if (expected.length !== EXPECTED_OBSERVATIONS.length ||
      expected.some((id) => !EXPECTED_OBSERVATIONS.includes(id as (typeof EXPECTED_OBSERVATIONS)[number])) ||
      flattened.length !== 11) {
    throw new CliFilesFailure('invalid-table', 'compiled observation registry has an unknown or missing ID')
  }
  const byObservation = new Map<string, CliFileObservation>()
  for (const observation of observations) {
    if (!observation || typeof observation.id !== 'string' || byObservation.has(observation.id)) {
      throw new CliFilesFailure('duplicate-observation', 'observation IDs are missing or duplicated')
    }
    if (!expected.includes(observation.id)) throw new CliFilesFailure('unknown-observation', `unknown observation ${observation.id}`)
    byObservation.set(observation.id, observation)
  }
  const receiptIds = new Set<string>()
  for (const receipt of receipts) {
    if (receiptIds.has(receipt.id)) throw new CliFilesFailure('duplicate-receipt', `duplicate CLI receipt ${receipt.id}`)
    receiptIds.add(receipt.id)
  }
  const outcomes = new Map<string, 'observed' | 'failed' | 'not-run'>()
  for (const id of expected) {
    const observation = byObservation.get(id)
    if (!observation) {
      outcomes.set(id, 'not-run')
      continue
    }
    if (observation.status === 'observed') {
      try {
        assertCliFileObservation(observation, receipts)
        outcomes.set(id, 'observed')
      } catch {
        outcomes.set(id, 'failed')
      }
    } else if (observation.status === 'failed') {
      if (!observation.error?.kind || !observation.error.message) {
        throw new CliFilesFailure('invalid-observation', `failed observation ${id} has no error`)
      }
      if (new Set(observation.receiptIds).size !== observation.receiptIds.length ||
          observation.receiptIds.some((receiptId) => !receiptIds.has(receiptId))) {
        throw new CliFilesFailure('missing-receipt', `failed observation ${id} references invalid receipts`)
      }
      outcomes.set(id, 'failed')
    } else if (observation.status === 'not-run') {
      if (observation.receiptIds.length !== 0 || !observation.error?.kind || !observation.error.message) {
        throw new CliFilesFailure('invalid-observation', `not-run observation ${id} must have an error and no receipts`)
      }
      outcomes.set(id, 'not-run')
    } else {
      throw new CliFilesFailure('invalid-observation', `observation ${id} has an unknown status`)
    }
  }
  return rows.filter((row) => Object.hasOwn(bindings, row.id)).map((row) => {
    const ids = [...bindings[row.id]!]
    const statuses = ids.map((id) => outcomes.get(id)!)
    const status: 'observed' | 'failed' | 'not-run' =
      statuses.includes('failed') ? 'failed' : statuses.every((value) => value === 'observed') ? 'observed' : 'not-run'
    return {
      id: row.id,
      disposition: row.disposition as 'covered' | 'gap',
      status,
      executed: statuses.some((value) => value !== 'not-run'),
      observations: ids,
      differences: [...EXPECTED_DIFFERENCES[row.id]!]
    }
  })
}
export function parseCliFilesArgs(args: string[]): CliFilesArguments {
  if (args.length === 0) return { json: false, help: false }
  if (args.length === 1 && args[0] === '--json') return { json: true, help: false }
  if (args.length === 1 && args[0] === '--help') return { json: false, help: true }
  throw new CliFilesFailure('invalid-arguments', 'Usage: bun scripts/parity/cli-files.ts [--json | --help]')
}

type BrowserPage = CliFilesWorld['pages'][number]
type WorldWindowRecord = CliFilesWorld['records'][number]
type CliRawResult = { stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number }
type CapturedSample = { public: CliFilePublicWindow[]; dom: CliFileDomWindow[]; snapshots: CliFileSnapshot[] }
type ObservationBuilder = {
  id: string
  startedAt: number
  receiptIds: Set<string>
  evidence: CliFileObservationEvidence
  before: CliFileSnapshot[]
  after: CliFileSnapshot[]
  background?: { public: CliFilePublicWindow[]; dom: CliFileDomWindow[] }
}
type SentinelInfo = { worktreeId: string; relativePath: string; absolutePath: string; bufferId: string; tabId: string }

function capturePageDom(): CliFileDomWindow {
  const workspace = document.querySelector<HTMLElement>('.qt-workspace[data-workspace]')
  const group = workspace?.querySelector<HTMLElement>('.qt-group.qt-active[data-group]') ?? workspace?.querySelector<HTMLElement>('.qt-group[data-group]')
  const activeTitle = group?.querySelector<HTMLElement>('.qt-tab-title[role="tab"][aria-selected="true"]')
  const selectedElement = activeTitle?.closest<HTMLElement>('.qt-tab[data-tab]') ?? null
  const selectedTabId = selectedElement?.dataset.tab ?? null
  const hosted = selectedTabId === null ? null : [...document.querySelectorAll<HTMLElement>('.qt-hosted-view[data-hosted-view]')]
    .find((element) => element.dataset.hostedView === selectedTabId) ?? null
  const hostedVisible = hosted !== null && !hosted.closest('[hidden]') &&
    getComputedStyle(hosted).display !== 'none' && getComputedStyle(hosted).visibility !== 'hidden'
  const renderedTabId = hostedVisible ? selectedTabId : null
  const path = hostedVisible ? hosted!.querySelector<HTMLElement>('.qe-document-path')?.getAttribute('title') ?? null : null
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const activeHosted = active?.closest<HTMLElement>('.qt-hosted-view[data-hosted-view]') ?? null
  const activeContent = active?.closest<HTMLElement>('.cm-content') ?? null
  const content = hostedVisible ? hosted!.querySelector<HTMLElement>('.cm-content') : null
  const lines = content ? [...content.querySelectorAll<HTMLElement>('.cm-line')].map((line) => line.textContent ?? '') : []
  let caret: { line: number; column: number } | null = null
  const selection = window.getSelection()
  if (content && selection?.anchorNode && content.contains(selection.anchorNode)) {
    const anchor = selection.anchorNode
    const line = (anchor instanceof Element ? anchor : anchor.parentElement)?.closest<HTMLElement>('.cm-line') ?? null
    if (line && content.contains(line)) {
      const lineElements = [...content.querySelectorAll<HTMLElement>('.cm-line')]
      const lineIndex = lineElements.indexOf(line)
      if (lineIndex >= 0) {
        try {
          const range = document.createRange()
          range.setStart(line, 0)
          range.setEnd(anchor, selection.anchorOffset)
          caret = { line: lineIndex + 1, column: range.toString().length + 1 }
        } catch {
          caret = null
        }
      }
    }
  }
  const reviewTabMounted = hostedVisible && hosted!.querySelector('[data-review-tab]') !== null
  const reviewCards = hostedVisible ? [...hosted!.querySelectorAll<HTMLElement>('.git-review__card[data-path]')].map((card) => {
    const body = card.querySelector<HTMLElement>('[data-review-body]')
    const pane = card.querySelector<HTMLElement>('.git-review__pane')
    const text = pane?.innerText ?? ''
    return {
      path: card.dataset.path ?? '',
      expanded: body !== null && !body.hidden,
      loaded: pane !== null && !pane.hidden && text.trim().length > 0,
      text
    }
  }) : []
  const activeElement = {
    tag: active?.tagName ?? '',
    role: active?.getAttribute('role') ?? null,
    inDocument: active !== null && document.documentElement.contains(active)
  }
  return {
    connId: 0,
    workspaceId: workspace?.dataset.workspace ?? '',
    groupId: group?.dataset.group ?? '',
    selectedTabId,
    renderedTabId,
    path,
    documentHasFocus: document.hasFocus(),
    activeElement,
    activeElementHostedTabId: activeHosted?.dataset.hostedView ?? null,
    activeElementIsSource: activeContent !== null,
    reviewTabMounted,
    caret,
    lines,
    reviewCards
  }
}

export class CliFilesRunner {
  readonly startedAt = Date.now()
  readonly workDeadline = this.startedAt + WORK_LIMIT_MS
  readonly workController = new AbortController()
  readonly cleanupController = new AbortController()
  readonly receipts: CliReceipt[] = []
  readonly tokenValues: string[] = []
  readonly gitEvidence: JsonObject[] = []
  readonly editorBuffers = new Map<string, string>()
  readonly reviewTabs = new Map<string, { worktreeId: string; tabId: string; connId: number }>()
  readonly observations = new Map<string, CliFileObservation>()
  world: CliFilesWorld | undefined
  windows: Array<{ page: BrowserPage; record: WorldWindowRecord; worktree: FixtureWorktree; connId: number }>= []
  home = ''
  currentStage = 'setup'
  activeObservation: ObservationBuilder | undefined
  buildElapsedMs = 0
  primaryFailure: { stage: string; kind: string; message: string } | undefined
  cleanupFailure: string | undefined
  cleanupEvidence: JsonObject = {}
  guardEvidence: { denied: string[]; egress: string[]; injected: boolean } | undefined
  fixtureEvidence: JsonObject = {}
  sentinelChild: Bun.Subprocess<'ignore', 'ignore', 'ignore'> | undefined
  sentinelHome = ''
  sentinelAliveAfterWorld = false
  sentinelError: string | undefined
  signalListener: (() => void) | undefined
  workTimer: ReturnType<typeof setTimeout> | undefined
  cleanupTimer: ReturnType<typeof setTimeout> | undefined

  constructor(readonly options: CliFilesRunOptions) {
    this.workTimer = setTimeout(() => this.workController.abort(new CliFilesFailure('deadline', 'CLI file rehearsal exceeded its 330-second work deadline')),
      Math.max(1, this.workDeadline - Date.now()))
    if (options.signal) {
      this.signalListener = () => this.workController.abort(options.signal?.reason ?? new CliFilesFailure('interrupted', 'CLI file rehearsal interrupted'))
      options.signal.addEventListener('abort', this.signalListener, { once: true })
      if (options.signal.aborted) this.signalListener()
    }
  }

  failIfStopped(): void {
    if (this.workController.signal.aborted) {
      const reason = this.workController.signal.reason
      throw reason instanceof Error ? reason : new CliFilesFailure('interrupted', 'CLI file rehearsal interrupted')
    }
    if (Date.now() >= this.workDeadline) throw new CliFilesFailure('deadline', 'CLI file rehearsal exceeded its 330-second work deadline')
  }


  async readRenderer<T>(read: () => Promise<T>, cleanup = false): Promise<T> {
    const signal = cleanup ? this.cleanupController.signal : this.workController.signal
    const deadline = cleanup ? Math.min(this.startedAt + WORK_LIMIT_MS + TEARDOWN_LIMIT_MS, Date.now() + TEARDOWN_LIMIT_MS) : this.workDeadline
    return captureCliFilesRenderer(read, signal, Math.min(CHILD_LIMIT_MS, deadline - Date.now()))
  }

  progress(message: string): void {
    console.error(`[cli-files] ${message}`)
    void this.options.onProgress?.(message)
  }

  registerReceipt(receipt: CliReceipt): void {
    if (this.receipts.some((existing) => existing.id === receipt.id)) throw new CliFilesFailure('duplicate-receipt', `duplicate CLI receipt ${receipt.id}`)
    this.receipts.push(receipt)
    this.activeObservation?.receiptIds.add(receipt.id)
  }

  safeParse(raw: CliRawResult, argv: string[], id: string): { result?: unknown; refusal?: { code: string; message: string; data?: unknown }; parseError?: string } {
    if (raw.stdoutBytes > MAX_STDOUT_BYTES || Buffer.byteLength(raw.stdout, 'utf8') > MAX_STDOUT_BYTES) {
      this.registerReceipt({
        id,
        command: commandOf(argv),
        argv,
        exitCode: raw.exitCode,
        format: 'json',
        stdoutBytes: raw.stdoutBytes,
        elapsedMs: raw.elapsedMs,
        evidence: {
          stdoutOverflow: true,
          stderrTail: sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues)
        }
      })
      throw new CliFilesFailure('stdout-overflow', `CLI receipt ${id} exceeded the 16 MiB stdout limit`, sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues))
    }
    let value: unknown
    try {
      value = JSON.parse(raw.stdout)
    } catch {
      const receipt: CliReceipt = {
        id,
        command: commandOf(argv),
        argv,
        exitCode: raw.exitCode,
        format: 'json',
        stdoutBytes: raw.stdoutBytes,
        elapsedMs: raw.elapsedMs,
        evidence: {
          malformed: true,
          stdoutPrefix: sanitizeText(raw.stdout.slice(0, 2048), this.home, this.tokenValues),
          stderrTail: sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues)
        }
      }
      this.registerReceipt(receipt)
      throw new CliFilesFailure('malformed-output', `CLI receipt ${id} did not emit valid JSON`, sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues))
    }
    if (raw.exitCode !== 0) {
      const refusal = parseErrorEnvelope(value)
      const receipt: CliReceipt = {
        id,
        command: commandOf(argv),
        argv,
        exitCode: raw.exitCode,
        format: 'json',
        stdoutBytes: raw.stdoutBytes,
        elapsedMs: raw.elapsedMs,
        evidence: {
          result: value,
          refusal: true,
          stderrTail: sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues)
        }
      }
      this.registerReceipt(receipt)
      return { refusal }
    }
    const resultRecord = isObject(value) ? value : undefined
    if (resultRecord && resultRecord.error !== undefined && resultRecord.error !== null) {
      const receipt: CliReceipt = {
        id,
        command: commandOf(argv),
        argv,
        exitCode: raw.exitCode,
        format: 'json',
        stdoutBytes: raw.stdoutBytes,
        elapsedMs: raw.elapsedMs,
        evidence: { result: value, stderrTail: sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues) }
      }
      this.registerReceipt(receipt)
      throw new CliFilesFailure('cli-error', `CLI receipt ${id} returned a zero-exit error envelope`)
    }
    const receipt: CliReceipt = {
      id,
      command: commandOf(argv),
      argv,
      exitCode: raw.exitCode,
      format: 'json',
      stdoutBytes: raw.stdoutBytes,
      elapsedMs: raw.elapsedMs,
      evidence: {
        result: value,
        ...(raw.stderr ? { stderrTail: sanitizeText(raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues) } : {})
      }
    }
    this.registerReceipt(receipt)
    return { result: value }
  }

  async execute(argv: string[], options: { id: string; cwd?: string; mutation?: boolean; cleanup?: boolean } ): Promise<{ result?: unknown; refusal?: { code: string; message: string; data?: unknown }; receipt: CliReceipt }> {
    const cleanup = options.cleanup === true
    const signal = cleanup ? this.cleanupController.signal : this.workController.signal
    if (!cleanup) this.failIfStopped()
    const deadline = cleanup ? Math.min(this.startedAt + WORK_LIMIT_MS + TEARDOWN_LIMIT_MS, Date.now() + TEARDOWN_LIMIT_MS) : this.workDeadline
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new CliFilesFailure(cleanup ? 'cleanup-deadline' : 'deadline', cleanup ? 'no teardown time remains' : 'no CLI command time remains')
    if (options.mutation) await this.assertLive(cleanup)
    const cliEntry = this.world?.cliEntry
    if (!this.world || !isAbsolute(process.execPath) || !cliEntry || !isAbsolute(cliEntry)) {
      throw new CliFilesFailure('world-identity', 'owned absolute Bun or checkout CLI path is missing')
    }
    const commandArgs = [...argv, '--runtime', 'local', '--json']
    if (argv.some((arg) => ['--home', '--runtime', '--out', '--executable'].includes(arg))) {
      throw new CliFilesFailure('invalid-arguments', 'arbitrary runner arguments are forbidden')
    }
    let raw: CliRawResult
    try {
      raw = await this.world.execute([process.execPath, cliEntry, ...commandArgs], {
        signal,
        timeoutMs: Math.min(CHILD_LIMIT_MS, remaining),
        cwd: options.cwd
      }) as CliRawResult
    } catch (error) {
      const value = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      if (typeof value.exitCode === 'number' && typeof value.stdoutBytes === 'number' && typeof value.elapsedMs === 'number') {
        const receipt: CliReceipt = {
          id: options.id,
          command: commandOf(commandArgs),
          argv: commandArgs,
          exitCode: value.exitCode,
          format: 'json',
          stdoutBytes: value.stdoutBytes,
          elapsedMs: value.elapsedMs,
          evidence: {
            executionError: safeError(error),
            stderrTail: typeof value.stderrTail === 'string' ? sanitizeText(value.stderrTail.slice(-MAX_DIAGNOSTIC_BYTES), this.home, this.tokenValues) : ''
          }
        }
        this.registerReceipt(receipt)
      }
      throw error
    }
    const parsed = this.safeParse(raw, commandArgs, options.id)
    const receipt = this.receipts.find((entry) => entry.id === options.id)!
    if (parsed.refusal) return { refusal: parsed.refusal, receipt }
    return { result: parsed.result, receipt }
  }

  async requireSuccess(id: string, argv: string[], options: { cwd?: string; mutation?: boolean; cleanup?: boolean } = {}): Promise<unknown> {
    const executed = await this.execute(argv, { id, ...options })
    if (executed.refusal) throw new CliFilesFailure('cli-exit', `CLI command ${id} exited ${executed.receipt.exitCode}: ${executed.refusal.message}`)
    return executed.result
  }

  async expectRefusal(id: string, argv: string[], expectedMessage?: string): Promise<{ code: string; message: string; data?: unknown }> {
    const executed = await this.execute(argv, { id, mutation: true })
    if (!executed.refusal || executed.receipt.exitCode !== 1 ||
        (expectedMessage !== undefined && !executed.refusal.message.includes(expectedMessage))) {
      throw new CliFilesFailure('unexpected-success', `CLI command ${id} did not refuse as required`)
    }
    if (executed.refusal.message.length === 0) throw new CliFilesFailure('invalid-refusal', `CLI command ${id} refused without an error message`)
    return executed.refusal
  }
  async reviewChanged(builder: ObservationBuilder): Promise<void> {
    const worktreeA = this.windows[0]!.worktree
    const worktreeB = this.windows[1]!.worktree
    await this.resetWindowView(0, worktreeA.id, 'files-review-changed-reset-a')
    await this.resetSentinel(0, builder)
    await this.closeReview(worktreeB.id, 'files-review-changed-close-review')
    const beforeStatusReceiptId = 'files-review-changed-status-before'
    const beforeStatus = await this.gitStatus(beforeStatusReceiptId, worktreeB.id)
    const entries = array(beforeStatus.entries, 'Git status entries').map((entry) => record(entry, 'Git status entry'))
    const changedPaths = entries.map((entry) => string(entry.path, 'Git status path')).sort()
    equal(changedPaths, [...REVIEW_PATHS].sort(), 'public Git status changed paths')
    const request = {
      worktreeId: worktreeB.id,
      path: null,
      absolutePath: worktreeB.path,
      content: B_CONTENT,
      targetConnectionId: this.windows[0]!.connId,
      mode: 'review'
    }
    builder.evidence.request = request
    const before = await this.addSample(builder, 'before')
    await this.runWindowCommand('files-review-changed-open-changes', this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: worktreeB.id })
    await this.waitForDom(0, (dom) => dom.workspaceId === worktreeB.id && dom.reviewCards.some((card) => card.path === A_TARGET), 'open-changes source card')
    await this.waitForDom(1, (dom) => dom.workspaceId === worktreeB.id && dom.reviewCards.some((card) => card.path === A_TARGET), 'open-changes shared source card')
    let afterOpen = await this.captureSample('files-review-changed-after-open')
    const needsExpandOrLoad = afterOpen.dom.some((dom) =>
      !REVIEW_PATHS.every((path) => dom.reviewCards.some((card) => card.path === path && card.expanded && card.loaded)))
    const supportReceipts: string[] = []
    if (needsExpandOrLoad) {
      const collapseId = 'files-review-changed-collapse-all'
      supportReceipts.push(collapseId)
      await this.runWindowCommand(collapseId, this.windows[0]!.connId, 'command:quirky.git/collapse-all', { collapsed: false })
      const loadId = 'files-review-changed-load-source'
      supportReceipts.push(loadId)
      await this.runWindowCommand(loadId, this.windows[0]!.connId, 'command:quirky.git/load-diff', { path: A_TARGET })
      await this.waitForDom(0, (dom) => dom.reviewCards.some((card) => card.path === A_TARGET && card.expanded && card.loaded && card.text.includes('second λ')),
        'loaded open-changes source diff')
      await this.waitForDom(1, (dom) => dom.reviewCards.some((card) => card.path === A_TARGET && card.expanded && card.loaded && card.text.includes('second λ')),
        'loaded shared open-changes source diff')
      afterOpen = await this.captureSample('files-review-changed-after-load')
    }
    const tabBeforeRepeat = await this.recordReviewTab(worktreeB.id, this.windows[0]!.connId, afterOpen)
    const editorTabsBefore = tabsInWorkspace(afterOpen.public[0]!.workspace).filter((tab) => tab.viewId === EDITOR_VIEW_ID).map((tab) => tab.id).sort()
    const repeatBefore = { public: afterOpen.public[0]!, dom: afterOpen.dom[0]! }
    await this.runWindowCommand('files-review-changed-repeat-open-changes', this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: worktreeB.id })
    await this.waitForDom(0, (dom) => dom.reviewCards.some((card) => card.path === A_TARGET && card.expanded && card.loaded && card.text.includes('second λ')),
      'reused open-changes Review')
    const after = await this.addSample(builder, 'after')
    const tabAfterRepeat = await this.recordReviewTab(worktreeB.id, this.windows[0]!.connId, after)
    equal(tabAfterRepeat, tabBeforeRepeat, 'open-changes Review tab reuse')
    const editorTabsAfter = tabsInWorkspace(after.public[0]!.workspace).filter((tab) => tab.viewId === EDITOR_VIEW_ID).map((tab) => tab.id).sort()
    equal(editorTabsAfter, editorTabsBefore, 'open-changes does not create editor tabs')
    const afterStatusReceiptId = 'files-review-changed-status-after'
    const statusAfter = await this.gitStatus(afterStatusReceiptId, worktreeB.id)
    const afterPaths = array(statusAfter.entries, 'post-Review Git status entries').map((entry) => string(record(entry, 'Git status entry').path, 'Git status path')).sort()
    equal(afterPaths, [...REVIEW_PATHS].sort(), 'post-Review Git status changed paths')
    builder.evidence.review = {
      worktreeId: worktreeB.id,
      path: null,
      targetConnectionId: this.windows[0]!.connId,
      reviewKey: reviewKey(worktreeB.id),
      tabId: tabAfterRepeat,
      tabBeforeRepeat,
      repeatBefore,
      changedPaths,
      supportingReceiptIds: supportReceipts,
      editorTabIdsBefore: editorTabsBefore,
      editorTabIdsAfter: editorTabsAfter
    }
    builder.evidence.git = {
      before: beforeStatus,
      beforeReceiptId: beforeStatusReceiptId,
      after: statusAfter,
      afterReceiptId: afterStatusReceiptId,
      changedPaths
    }
    builder.before = before.snapshots
  }

  async api(id: string, method: string, params: Record<string, unknown> = {}, options: { mutation?: boolean; cleanup?: boolean } = {}): Promise<unknown> {
    const args = ['api', 'call', method]
    for (const [name, value] of Object.entries(params)) {
      args.push(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
      args.push(typeof value === 'string' ? value : JSON.stringify(value))
    }
    return this.requireSuccess(id, args, options)
  }

  async editor(id: string, args: string[], options: { cwd?: string; mutation?: boolean; cleanup?: boolean } = {}): Promise<unknown> {
    return this.requireSuccess(id, ['editor', ...args], options)
  }

  async assertRuntimeIdentity(): Promise<void> {
    const world = this.world
    if (!world || world.env.QUIRKY_HOME !== world.home || resolve(world.home) !== world.home ||
        !Number.isSafeInteger(world.daemonPid) || world.daemonPid <= 0) {
      throw new CliFilesFailure('world-identity', 'owned runtime home or daemon identity is invalid')
    }
    let runtime
    try { runtime = readRuntime(world.home) }
    catch { throw new CliFilesFailure('runtime-identity', 'owned runtime identity could not be read') }
    if (!runtime || runtime.pid !== world.daemonPid) throw new CliFilesFailure('runtime-identity', 'runtime.json does not belong to the owned daemon PID')
    try { process.kill(world.daemonPid, 0) }
    catch { throw new CliFilesFailure('daemon-exited', 'owned daemon PID is not live') }
  }

  async assertLive(cleanup = false): Promise<void> {
    const world = this.world
    if (!world || this.windows.length !== 2) throw new CliFilesFailure('world-identity', 'both owned renderer windows are not available')
    if (!cleanup) this.failIfStopped()
    await this.assertRuntimeIdentity()
    for (const entry of this.windows) {
      if (entry.page.isClosed() || !entry.record.open) throw new CliFilesFailure('renderer-disconnected', `owned renderer ${entry.connId} is closed`)
      const alive = await this.readRenderer(() => entry.page.evaluate(() => document.readyState !== 'loading' && Boolean(document.querySelector('.shell-workspace'))), cleanup)
      if (!alive) throw new CliFilesFailure('renderer-disconnected', `owned renderer ${entry.connId} is not showing the Quirky shell`)
    }
  }

  async readPublicWindow(index: number, phase: string): Promise<CliFilePublicWindow> {
    const entry = this.windows[index]
    if (!entry) throw new CliFilesFailure('connection-mismatch', `window index ${index} is missing`)
    const stateId = `${this.activeObservation?.id ?? 'run'}-${phase}-window-${index}`
    const windowState = await this.api(`${stateId}-state`, 'ui.window.state', { connId: entry.connId })
    const state = record(windowState, `${phase} window state`)
    const layout = record(state.layout, `${phase} window layout`)
    const worktree = string(layout.worktree, `${phase} window worktree`)
    if (state.connId !== entry.connId) throw new CliFilesFailure('connection-mismatch', `${phase} returned the wrong window connection`)
    const workspace = await this.api(`${stateId}-workspace`, 'quirky.terminal/workspace', { workspace: worktree })
    const editor = await this.editor(`${stateId}-editor`, ['state', '--worktree', worktree])
    return {
      connId: entry.connId,
      receiptIds: { window: `${stateId}-state`, workspace: `${stateId}-workspace`, editor: `${stateId}-editor` },
      windowState: record(windowState, `${phase} public window state`),
      workspace: record(workspace, `${phase} public terminal workspace`),
      editor: record(editor, `${phase} public editor state`)
    }
  }

  async captureSample(phase: string): Promise<CapturedSample> {
    const publicWindows: CliFilePublicWindow[] = []
    const domWindows: CliFileDomWindow[] = []
    for (let index = 0; index < 2; index += 1) {
      publicWindows.push(await this.readPublicWindow(index, phase))
      const captured = await this.readRenderer(() => this.windows[index]!.page.evaluate(capturePageDom))
      captured.connId = this.windows[index]!.connId
      domWindows.push(captured)
    }
    const snapshots = publicWindows.map((window, index) => snapshotFrom(window, domWindows[index]!))
    return { public: publicWindows, dom: domWindows, snapshots }
  }

  async waitForDom(index: number, predicate: (dom: CliFileDomWindow) => boolean, label: string, timeoutMs = 30_000): Promise<CliFileDomWindow> {
    const until = Math.min(this.workDeadline, Date.now() + timeoutMs)
    let last: CliFileDomWindow | undefined
    while (Date.now() < until) {
      this.failIfStopped()
      const entry = this.windows[index]
      if (!entry || entry.page.isClosed()) throw new CliFilesFailure('renderer-disconnected', `${label} renderer closed while waiting`)
      last = await this.readRenderer(() => entry.page.evaluate(capturePageDom))
      last.connId = entry.connId
      if (predicate(last)) return last
      await Bun.sleep(Math.min(50, Math.max(1, until - Date.now())))
    }
    if (last && this.activeObservation) this.activeObservation.evidence.timedOutDom = { label, ...last }
    throw new CliFilesFailure('dom-timeout', `${label} did not appear in the live renderer${last ? ` (selected ${last.selectedTabId ?? 'none'}, path ${last.path ?? 'none'})` : ''}`)
  }

  async focusBaseline(index: number, tabId: string): Promise<void> {
    const entry = this.windows[index]
    if (!entry) throw new CliFilesFailure('connection-mismatch', 'baseline renderer is missing')
    const focused = await this.readRenderer(() => entry.page.evaluate((targetTabId) => {
      const hosted = [...document.querySelectorAll<HTMLElement>('.qt-hosted-view[data-hosted-view]')]
        .find((element) => element.dataset.hostedView === targetTabId)
      const content = hosted?.querySelector<HTMLElement>('.cm-content')
      content?.focus()
      return content !== undefined && document.activeElement === content
    }, tabId))
    if (!focused) throw new CliFilesFailure('fixture-focus', `could not focus baseline source tab ${tabId}`)
  }

  async openEditor(worktree: FixtureWorktree, path: string, options: { id: string; focus: boolean; line?: number; column?: number }): Promise<JsonObject> {
    const args = ['open', path, '--worktree', worktree.id, '--mode', 'source']
    if (options.line !== undefined) args.push('--line', String(options.line))
    if (options.column !== undefined) args.push('--column', String(options.column))
    if (options.focus) args.push('--focus')
    const result = record(await this.editor(options.id, args, { cwd: worktree.path, mutation: true }), `editor open ${path}`)
    const bufferId = string(result.id, 'editor open buffer ID')
    const tabId = string(result.openedTabId, 'editor open tab ID')
    this.editorBuffers.set(bufferId, worktree.id)
    return result
  }

  async sentinel(worktreeIndex: number, receiptPrefix: string): Promise<SentinelInfo> {
    const entry = this.windows[worktreeIndex]
    if (!entry) throw new CliFilesFailure('fixture-worktree', 'sentinel window does not exist')
    const opened = await this.openEditor(entry.worktree, SENTINEL_PATH, { id: `${receiptPrefix}-sentinel-open-${worktreeIndex}`, focus: true })
    const info: SentinelInfo = {
      worktreeId: entry.worktree.id,
      relativePath: SENTINEL_PATH,
      absolutePath: join(entry.worktree.path, SENTINEL_PATH),
      bufferId: string(opened.id, 'sentinel buffer ID'),
      tabId: string(opened.openedTabId, 'sentinel tab ID')
    }
    await this.waitForDom(worktreeIndex, (dom) => dom.selectedTabId === info.tabId && dom.renderedTabId === info.tabId &&
      dom.path === info.absolutePath && dom.lines.length > 0, `sentinel ${worktreeIndex}`)
    await this.focusBaseline(worktreeIndex, info.tabId)
    await this.waitForDom(worktreeIndex, dom => dom.activeElementHostedTabId === info.tabId && dom.activeElementIsSource,
      `sentinel ${worktreeIndex} baseline focus`)
    return info
  }

  async addSample(builder: ObservationBuilder, phase: 'before' | 'after' | 'background'): Promise<CapturedSample> {
    const sample = await this.captureSample(`${builder.id}-${phase}`)
    if (phase === 'before') builder.before = sample.snapshots
    else if (phase === 'after') builder.after = sample.snapshots
    else builder.background = { public: sample.public, dom: sample.dom }
    if (phase === 'before') {
      builder.evidence.public.before = sample.public
      builder.evidence.dom.before = sample.dom
    } else if (phase === 'after') {
      builder.evidence.public.after = sample.public
      builder.evidence.dom.after = sample.dom
    } else builder.evidence.background = { public: sample.public, dom: sample.dom }
    return sample
  }

  async observation(id: string, run: (builder: ObservationBuilder) => Promise<void>): Promise<void> {
    if (this.observations.has(id)) throw new CliFilesFailure('duplicate-observation', `observation ${id} was already executed`)
    const builder: ObservationBuilder = {
      id,
      startedAt: Date.now(),
      receiptIds: new Set(),
      before: [],
      after: [],
      evidence: { request: {}, public: { before: [], after: [] }, dom: { before: [], after: [] } }
    }
    this.activeObservation = builder
    this.currentStage = id
    try {
      this.failIfStopped()
      await run(builder)
      const observation: CliFileObservation = {
        id,
        status: 'observed',
        receiptIds: [...builder.receiptIds],
        before: builder.before,
        after: builder.after,
        evidence: builder.evidence
      }
      assertCliFileObservation(observation, this.receipts)
      builder.evidence.elapsedMs = Math.max(1, Date.now() - builder.startedAt)
      this.observations.set(id, observation)
    } catch (error) {
      const failure = safeError(error)
      const observation: CliFileObservation = {
        id,
        status: 'failed',
        receiptIds: [...builder.receiptIds],
        before: builder.before,
        after: builder.after,
        evidence: { ...builder.evidence, elapsedMs: Math.max(1, Date.now() - builder.startedAt) },
        error: { kind: failure.kind, message: sanitizeText(failure.message, this.home, this.tokenValues) }
      }
      this.observations.set(id, observation)
      this.primaryFailure ??= { stage: id, kind: failure.kind, message: sanitizeText(failure.message, this.home, this.tokenValues) }
      this.workController.abort(error)
      this.progress(`${id} failed: ${failure.message}`)
    } finally {
      this.activeObservation = undefined
    }
  }

  markNotRun(id: string, blocker: { kind: string; message: string }): void {
    if (this.observations.has(id)) return
    this.observations.set(id, {
      id,
      status: 'not-run',
      receiptIds: [],
      before: [],
      after: [],
      evidence: { request: {}, public: { before: [], after: [] }, dom: { before: [], after: [] }, elapsedMs: 0 },
      error: { kind: blocker.kind, message: sanitizeText(blocker.message, this.home, this.tokenValues) }
    })
  }

  async prepareGit(argv: string[], cwd: string, label: string): Promise<string> {
    const world = this.world
    if (!world) throw new CliFilesFailure('world-identity', 'Git preparation has no owned world')
    if (!within(world.home, cwd)) throw new CliFilesFailure('fixture-path', `Git preparation cwd escaped the owned home: ${cwd}`)
    if (!world.prepare) throw new CliFilesFailure('world-contract', 'owned file world does not expose restricted Git preparation')
    const gitArgv = ['/usr/bin/git', ...argv]
    const raw = await world.prepare(gitArgv, cwd) as CliRawResult
    this.gitEvidence.push({ id: label, executable: '/usr/bin/git', argv: gitArgv, cwd, exitCode: raw.exitCode, stdoutBytes: raw.stdoutBytes, elapsedMs: raw.elapsedMs, stdout: raw.stdout.trim(), stderrTail: raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES) })
    if (raw.exitCode !== 0) throw new CliFilesFailure('fixture-git', `Git fixture operation ${label} exited ${raw.exitCode}: ${raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES)}`)
    if (Buffer.byteLength(raw.stdout) > MAX_STDOUT_BYTES) throw new CliFilesFailure('stdout-overflow', `Git fixture operation ${label} exceeded 16 MiB`)
    return raw.stdout
  }
  writeFixture(worktree: FixtureWorktree, path: string, content: string): void {
    const root = resolve(worktree.path)
    const target = resolve(root, ...path.split(/[\\/]+/))
    if (!within(root, target) || !within(this.world!.home, target)) throw new CliFilesFailure('fixture-path', `fixture file ${path} escaped its owned worktree`)
    mkdirSync(resolve(target, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(target, content, { mode: 0o600 })
  }

  async prepareFixtures(): Promise<void> {
    const [a, b] = this.windows.map((entry) => entry.worktree)
    if (!a || !b || a.id === b.id || a.isMain || b.isMain) throw new CliFilesFailure('fixture-worktree', 'two distinct non-main soak worktrees are required')
    if (!within(this.world!.home, a.path) || !within(this.world!.home, b.path)) throw new CliFilesFailure('fixture-path', 'soak worktree path is outside the owned home')
    const initial: JsonObject[] = []
    for (const [index, worktree] of [a, b].entries()) {
      const status = await this.prepareGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktree.path, `initial-status-${index}`)
      initial.push({ worktreeId: worktree.id, porcelain: status })
      if (status !== '') throw new CliFilesFailure('fixture-git', 'selected non-main fixture worktree is not clean')
    }
    const baseline = [
      { target: A_CONTENT, sentinel: A_SENTINEL_CONTENT },
      { target: 'first\nsecond\n', sentinel: 'review notes B baseline\n' }
    ]
    for (const [index, worktree] of [a, b].entries()) {
      this.writeFixture(worktree, A_TARGET, baseline[index]!.target)
      this.writeFixture(worktree, SENTINEL_PATH, baseline[index]!.sentinel)
      await this.prepareGit(['add', '--', A_TARGET, SENTINEL_PATH], worktree.path, `stage-baseline-${index}`)
      await this.prepareGit(['-c', 'user.name=CLI parity fixture', '-c', 'user.email=cli-parity@example.invalid', 'commit', '-m', 'Seed CLI file observer baseline'], worktree.path, `commit-baseline-${index}`)
    }
    this.writeFixture(b, B_TARGET, B_CONTENT)
    this.writeFixture(b, SENTINEL_PATH, B_SENTINEL_CONTENT)
    this.writeFixture(a, LITERAL_PATH, LITERAL_CONTENT)
    const statusA = await this.prepareGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], a.path, 'after-fixture-A-status')
    const statusB = await this.prepareGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], b.path, 'after-fixture-B-status')
    const bPaths = parseCliFilesGitPaths(statusB).sort()
    equal(bPaths, [...REVIEW_PATHS].sort(), 'B fixture Git changed paths')
    if (!parseCliFilesGitPaths(statusA).includes(LITERAL_PATH)) throw new CliFilesFailure('fixture-git', 'literal A-only file is missing from A Git status')
    this.fixtureEvidence = {
      initialStatus: initial,
      baseline: [
        { worktreeId: a.id, path: A_TARGET, content: A_CONTENT, sentinelPath: SENTINEL_PATH, sentinelContent: A_SENTINEL_CONTENT },
        { worktreeId: b.id, path: B_TARGET, baselineContent: 'first\nsecond\n', content: B_CONTENT, sentinelPath: SENTINEL_PATH, sentinelContent: B_SENTINEL_CONTENT }
      ],
      changedPathsB: bPaths,
      literalPathAOnly: LITERAL_PATH
    }
  }

  async sentinelPair(builder: ObservationBuilder): Promise<{ a: SentinelInfo; b: SentinelInfo }> {
    const a = await this.sentinel(0, builder.id)
    const b = await this.sentinel(1, builder.id)
    builder.evidence.sentinels = { a, b }
    return { a, b }
  }

  async editorObservation(id: 'files-editor-local' | 'files-editor-other-worktree' | 'files-editor-literal-path', builder: ObservationBuilder): Promise<void> {
    const sentinels = await this.sentinelPair(builder)
    const literal = id === 'files-editor-literal-path'
    const targetIndex = id === 'files-editor-other-worktree' ? 1 : 0
    const otherIndex = targetIndex === 0 ? 1 : 0
    const targetEntry = this.windows[targetIndex]!
    const otherEntry = this.windows[otherIndex]!
    const path = literal ? LITERAL_PATH : targetIndex === 0 ? A_TARGET : B_TARGET
    const content = literal ? LITERAL_CONTENT : targetIndex === 0 ? A_CONTENT : B_CONTENT
    const absolutePath = join(targetEntry.worktree.path, path)
    const line = literal ? 1 : 2
    const column = literal ? 1 : 3
    builder.evidence.request = {
      worktreeId: targetEntry.worktree.id,
      relativePath: path,
      absolutePath,
      content,
      mode: 'source',
      focus: true,
      targetConnectionId: targetEntry.connId,
      line,
      column
    }
    const before = await this.addSample(builder, 'before')
    if (literal) {
      const focused = await this.openEditor(targetEntry.worktree, path, { id: `${id}-focus-open`, focus: true, line, column })
      const targetTab = string(focused.openedTabId, `${id} target tab`)
      await this.waitForDom(targetIndex, (dom) => dom.selectedTabId === targetTab && dom.renderedTabId === targetTab &&
        dom.path === absolutePath && JSON.stringify(dom.caret) === JSON.stringify({ line: 1, column: 1 }), `${id} focused document`)
      const read = await this.editor(`${id}-buffer-read`, ['read', '--buffer-id', string(focused.id, `${id} buffer ID`), '--action', 'buffer'], { cwd: targetEntry.worktree.path })
      const readBuffer = record(record(read, `${id} buffer read`).buffer, `${id} read buffer`)
      equal(readBuffer.id, focused.id, `${id} buffer read ID`)
      equal(readBuffer.worktreeId, targetEntry.worktree.id, `${id} buffer read worktree`)
      equal(readBuffer.path, absolutePath, `${id} buffer read absolute path`)
      equal(readBuffer.content, content, `${id} buffer read bytes`)
      const after = await this.addSample(builder, 'after')
      const otherBuffers = array(after.public[otherIndex]!.editor.buffers, 'other editor buffers').map((value) => record(value, 'other editor buffer'))
      const otherHasLiteral = otherBuffers.some((buffer) => buffer.path === absolutePath)
      const injectionPresent = existsSync(join(targetEntry.worktree.path, 'cli-injected')) ||
        existsSync(join(this.world!.home, 'cli-injected')) || existsSync(join(resolve(import.meta.dir, '../..'), 'cli-injected'))
      builder.evidence.literal = { existsInA: existsSync(absolutePath), onlyInA: !otherHasLiteral, injectionPresent }
      equal(otherEntry.worktree.id, sentinels.b.worktreeId, `${id} other fixture worktree`)
      equal(before.snapshots.length, 2, `${id} before window count`)
      return
    }
    const background = await this.openEditor(targetEntry.worktree, path, { id: `${id}-background-open`, focus: false, line, column })
    const backgroundTab = string(background.openedTabId, `${id} background tab`)
    await this.waitForDom(targetIndex, (dom) => dom.selectedTabId !== backgroundTab, `${id} background selection`)
    await this.addSample(builder, 'background')
    const focused = await this.openEditor(targetEntry.worktree, path, { id: `${id}-focus-open`, focus: true, line, column })
    equal(focused.id, background.id, `${id} background/focus buffer reuse`)
    equal(focused.openedTabId, background.openedTabId, `${id} background/focus tab reuse`)
    const targetTab = string(focused.openedTabId, `${id} target tab`)
    const expectedLines = targetIndex === 0 ? ['first A', 'second A', ''] : ['first', 'second λ', '']
    await this.waitForDom(targetIndex, (dom) => dom.selectedTabId === targetTab && dom.renderedTabId === targetTab &&
      dom.path === absolutePath && JSON.stringify(dom.caret) === JSON.stringify({ line, column }), `${id} focused document`)
    const read = await this.editor(`${id}-buffer-read`, ['read', '--buffer-id', string(focused.id, `${id} buffer ID`), '--action', 'buffer'], { cwd: targetEntry.worktree.path })
    const readBuffer = record(record(read, `${id} buffer read`).buffer, `${id} read buffer`)
    equal(readBuffer.id, focused.id, `${id} buffer read ID`)
    equal(readBuffer.worktreeId, targetEntry.worktree.id, `${id} buffer read worktree`)
    equal(readBuffer.path, absolutePath, `${id} buffer read absolute path`)
    equal(readBuffer.content, content, `${id} buffer read bytes`)
    const after = await this.addSample(builder, 'after')
    equal(before.snapshots.length, 2, `${id} before window count`)
    equal(otherEntry.worktree.id, otherIndex === 0 ? sentinels.a.worktreeId : sentinels.b.worktreeId, `${id} other fixture worktree`)
  }
  async resetSentinel(index: number, builder: ObservationBuilder): Promise<SentinelInfo> {
    const sentinel = await this.sentinel(index, `${builder.id}-reset`)
    await this.waitForDom(index, (dom) => dom.selectedTabId === sentinel.tabId && dom.path === sentinel.absolutePath &&
      dom.activeElementHostedTabId === sentinel.tabId && dom.activeElementIsSource, `${builder.id} reset sentinel`)
    return sentinel
  }

  async resetWindowView(index: number, worktreeId: string, id: string): Promise<void> {
    const entry = this.windows[index]!
    await this.api(id, 'ui.window.view.open', {
      connId: entry.connId,
      id: SESSION_VIEW_ID,
      input: { worktree: worktreeId }
    }, { mutation: true })
    const dom = await this.waitForDom(index, (sample) => sample.workspaceId === worktreeId, `reset worktree view ${worktreeId}`)
    if (dom.workspaceId !== worktreeId) throw new CliFilesFailure('worktree-mismatch', `window ${entry.connId} did not reset to ${worktreeId}`)
  }

  async runWindowCommand(id: string, connId: number, commandId: string, args: Record<string, unknown>, cleanup = false): Promise<unknown> {
    return this.api(id, 'ui.window.command.run', { connId, id: commandId, args }, { mutation: true, cleanup })
  }
  async gitStatus(id: string, worktreeId: string): Promise<JsonObject> {
    return record(await this.api(id, 'quirky.git/status', { worktree: worktreeId }), `${id} Git status`)
  }

  async recordReviewTab(worktreeId: string, connId: number, sample: CapturedSample): Promise<string> {
    const key = reviewKey(worktreeId)
    const matching = reviewTabFor(sample.public.find((entry) => entry.connId === connId)?.workspace, key)
    if (matching.length !== 1) throw new CliFilesFailure('review-tab-mismatch', `expected one Review tab for ${worktreeId}`)
    const tabId = string(matching[0]!.id, 'Review tab ID')
    this.reviewTabs.set(worktreeId, { worktreeId, tabId, connId })
    return tabId
  }

  async reviewDiff(builder: ObservationBuilder, path: string, id: 'files-review-diff' | 'files-review-reuse'): Promise<void> {
    const targetConnId = this.windows[0]!.connId
    const worktreeB = this.windows[1]!.worktree
    if (id === 'files-review-diff') {
      await this.resetWindowView(0, this.windows[0]!.worktree.id, `${id}-reset-a-view`)
      await this.resetSentinel(0, builder)
      await this.closeReview(worktreeB.id, `${id}-ensure-review-closed`)
    }
    const request = {
      worktreeId: worktreeB.id,
      path,
      absolutePath: join(worktreeB.path, path),
      content: path === A_TARGET ? B_CONTENT : B_SENTINEL_CONTENT,
      targetConnectionId: targetConnId,
      mode: 'review'
    }
    builder.evidence.request = request
    const before = await this.addSample(builder, 'before')
    const previousReview = reviewTabFor(before.public[1]!.workspace, reviewKey(worktreeB.id))[0]
    const commandReceiptId = `${id}-exact-open`
    await this.runWindowCommand(commandReceiptId, targetConnId, 'command:quirky.git/open-diff', { worktree: worktreeB.id, path })
    await this.waitForDom(0, (dom) => dom.workspaceId === worktreeB.id && dom.renderedTabId !== null && dom.reviewCards.some((card) => card.path === path && card.expanded && card.loaded), `${id} targeted Review card`)
    await this.waitForDom(1, dom => dom.workspaceId === worktreeB.id && dom.reviewTabMounted, `${id} shared Review tab`)
    const after = await this.addSample(builder, 'after')
    const tabId = await this.recordReviewTab(worktreeB.id, targetConnId, after)
    const tab = tabById(after.public[1]!.workspace, tabId)!
    const tabInfo = workspaceViewTab(tab, `${id} Review tab`)
    builder.evidence.review = {
      worktreeId: worktreeB.id,
      path,
      targetConnectionId: targetConnId,
      reviewKey: reviewKey(worktreeB.id),
      tabId,
      previousTabId: previousReview?.id ?? null,
      changedPaths: [...REVIEW_PATHS],
      inputRevealAfter: record(tab.input, `${id} review input`).reveal
    }
  }

  async closeReview(worktreeId: string, id: string): Promise<void> {
    const target = this.reviewTabs.get(worktreeId)
    if (!target) {
      const state = await this.api(`${id}-workspace`, 'quirky.terminal/workspace', { workspace: worktreeId })
      const tabs = tabsInWorkspace(state).filter((tab) => tab.viewId === REVIEW_VIEW_ID && tab.key === reviewKey(worktreeId))
      if (tabs.length === 0) return
      const connId = this.windows.find((entry) => entry.worktree.id === worktreeId)?.connId ?? this.windows[0]!.connId
      this.reviewTabs.set(worktreeId, { worktreeId, tabId: string(tabs[0]!.id, 'Review tab ID'), connId })
    }
    const current = this.reviewTabs.get(worktreeId)!
    const ownerConnId = this.windows.find((entry) => entry.worktree.id === worktreeId)?.connId ?? current.connId
    await this.runWindowCommand(id, ownerConnId, 'command:quirky.git/close-diff', { tabId: current.tabId })
    const until = Math.min(this.workDeadline, Date.now() + CHILD_LIMIT_MS)
    let attempt = 0
    while (Date.now() < until) {
      this.failIfStopped()
      const workspace = await this.api(`${id}-closed-${++attempt}`, 'quirky.terminal/workspace', { workspace: worktreeId })
      const detached = await Promise.all(this.windows.map(entry => this.readRenderer(() =>
        entry.page.evaluate(closedTabId => ![...document.querySelectorAll<HTMLElement>('.qt-hosted-view[data-hosted-view], .qt-tab[data-tab]')]
          .some(element => element.dataset.hostedView === closedTabId || element.dataset.tab === closedTabId), current.tabId))))
      if (!tabById(workspace, current.tabId) && detached.every(Boolean)) {
        this.reviewTabs.delete(worktreeId)
        return
      }
      await Bun.sleep(Math.min(50, Math.max(1, until - Date.now())))
    }
    throw new CliFilesFailure('review-close-timeout', `Review tab ${current.tabId} did not leave its workspace and renderers`)
  }
  async windowRouting(builder: ObservationBuilder): Promise<void> {
    const b = this.windows[1]!.worktree
    const argsJson = JSON.stringify({ worktree: b.id, path: A_TARGET })
    builder.evidence.request = { worktreeId: b.id, path: A_TARGET, targetConnectionId: this.windows[0]!.connId }
    const before = await this.addSample(builder, 'before')
    const ambiguousId = 'files-window-routing-ambiguous'
    await this.expectRefusal(ambiguousId, ['ui', 'run', 'command:quirky.git/open-diff', '--args', argsJson], 'multiple Quirky windows are open; specify connId')
    const staleConnId = Math.max(...this.windows.map((entry) => entry.connId)) + 100_000
    const staleId = 'files-window-routing-stale'
    const staleArgs = JSON.stringify({ worktree: b.id, path: A_TARGET })
    await this.expectRefusal(staleId, ['api', 'call', 'ui.window.command.run', '--conn-id', String(staleConnId), '--id', 'command:quirky.git/open-diff', '--args', staleArgs])
    const after = await this.addSample(builder, 'after')
    builder.evidence.routing = { ambiguousReceiptId: ambiguousId, staleReceiptId: staleId, staleConnId, targetWorktree: b.id }
    equal(before.snapshots.length, 2, 'routing before two windows')
  }

  async prepareRoutingAndReview(): Promise<void> {
    await this.observation('files-window-routing', (builder) => this.windowRouting(builder))
    if (this.observations.get('files-window-routing')?.status !== 'observed') return
    await this.observation('files-review-diff', async (builder) => {
      await this.reviewDiff(builder, A_TARGET, 'files-review-diff')
    })
    if (this.observations.get('files-review-diff')?.status !== 'observed') return
    await this.observation('files-review-reuse', async (builder) => {
      await this.reviewDiff(builder, SENTINEL_PATH, 'files-review-reuse')
    })
    if (this.observations.get('files-review-reuse')?.status !== 'observed') return
    await this.observation('files-review-changed', (builder) => this.reviewChanged(builder))
  }

  async ensureWorld(): Promise<void> {
    this.sentinelHome = realpathSync(mkdtempSync('/tmp/quirky-cli-files-sentinel-'))
    mkdirSync(join(this.sentinelHome, 'tmp'), { recursive: true, mode: 0o700 })
    const sentinelEnv = createIsolatedRuntimeEnvironment(this.sentinelHome, { repoRoot: resolve(import.meta.dir, '../..') })
    this.sentinelChild = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      cwd: this.sentinelHome,
      env: sentinelEnv,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore'
    }) as Bun.Subprocess<'ignore', 'ignore', 'ignore'>
    if (!Number.isSafeInteger(this.sentinelChild.pid) || this.sentinelChild.pid <= 0 || this.sentinelChild.exitCode !== null) {
      throw new CliFilesFailure('sentinel-start', 'unrelated cleanup sentinel did not start')
    }
    const factory = this.options.createWorld ?? createCliFilesWorld
    this.world = await factory({ signal: this.workController.signal, deadline: this.workDeadline })
    this.home = this.world.home
    this.buildElapsedMs = this.world.buildElapsedMs
    const runtime = readRuntime(this.world.home)
    if (!runtime || runtime.pid !== this.world.daemonPid) throw new CliFilesFailure('runtime-identity', 'new world runtime does not match its daemon PID')
    this.tokenValues.push(runtime.token, runtime.hookToken)
    if (this.world.env.QUIRKY_HOME !== this.world.home) throw new CliFilesFailure('world-identity', 'new world environment points outside its owned home')
    if (!existsSync(join(this.world.home, 'ui-dist', 'index.html'))) throw new CliFilesFailure('ui-build-missing', 'owned UI build is missing ui-dist/index.html')
    if (!isAbsolute(this.world.cliEntry) || !existsSync(this.world.cliEntry)) throw new CliFilesFailure('world-identity', 'checkout CLI entry is missing or not absolute')
    if (this.world.pages.length !== 2 || this.world.records.length !== 2 || this.world.worktrees.length !== 2) {
      throw new CliFilesFailure('window-count', 'file world did not return exactly two owned windows')
    }
    for (let index = 0; index < 2; index += 1) {
      const windowRecord = this.world.records[index]!
      const worktree = this.world.worktrees[index]!
      if (windowRecord.index !== index || windowRecord.worktree !== worktree.id || windowRecord.connId <= 0 || !windowRecord.open || !windowRecord.shown) {
        throw new CliFilesFailure('window-identity', `window record ${index} does not match the selected worktree and page order`)
      }
      this.windows.push({ page: this.world.pages[index]!, record: windowRecord, worktree, connId: windowRecord.connId })
    }
    if (this.windows[0]!.worktree.id === this.windows[1]!.worktree.id || this.windows[0]!.connId === this.windows[1]!.connId) {
      throw new CliFilesFailure('window-identity', 'the two owned windows do not have distinct worktrees and connections')
    }
    await this.assertRuntimeIdentity()
    const uiState = record(await this.requireSuccess('initial-ui-state', ['ui', 'state']), 'ui state')
    const liveWindows = array(uiState.windows, 'ui state windows').map((entry) => record(entry, 'ui state window'))
    const liveIds = new Set(liveWindows.map((entry) => integer(entry.connId, 'ui state connId')))
    for (const entry of this.windows) if (!liveIds.has(entry.connId)) throw new CliFilesFailure('renderer-disconnected', `ui.state did not list connection ${entry.connId}`)
    await this.validateTableAndCatalog()
    await this.prepareFixtures()
  }

  async validateTableAndCatalog(): Promise<void> {
    const rows = table.loadCliTable()
    table.validateInventory(table.loadCliInventory(), rows, checkIds)
    const catalog = record(await this.requireSuccess('api-catalog', ['api']), 'API catalog')
    table.validateCatalog(catalog, rows)
    const mappings = CLI_FILE_OBSERVATION_BINDINGS as Readonly<Record<string, readonly string[]>>
    for (const [rowId, expected] of Object.entries(REQUIRED_ROW_BINDINGS)) {
      const row = rows.find((entry) => entry.id === rowId)
      if (!row || JSON.stringify(mappings[rowId]) !== JSON.stringify(expected) ||
          JSON.stringify((row as table.CliTableRow & { observations?: string[] }).observations) !== JSON.stringify(expected)) {
        throw new CliFilesFailure('invalid-table', `required file observation binding is missing or invalid for ${rowId}`)
      }
    }
    const all = Object.values(mappings).flat()
    if (new Set(all).size !== EXPECTED_OBSERVATIONS.length ||
        EXPECTED_OBSERVATIONS.some((id) => !all.includes(id)) || all.length !== 11) {
      throw new CliFilesFailure('invalid-table', 'file observation registry does not contain exactly the seven linked observations')
    }
    const methods = array(catalog.methods, 'catalog methods').map((entry) => record(entry, 'catalog method'))
    const requireMethod = (name: string, required: Record<string, string>, optional: Record<string, string> = {}) => {
      const method = methods.find((entry) => entry.name === name)
      if (!method) throw new CliFilesFailure('catalog-mismatch', `API catalog is missing ${name}`)
      const params = record(method.params, `${name} parameters`)
      if (params.type !== 'object' || !isObject(params.properties)) throw new CliFilesFailure('catalog-mismatch', `${name} has no object parameter schema`)
      const properties = params.properties as JsonObject
      const requiredNames = Array.isArray(params.required) ? params.required : []
      const expectedRequired = Object.keys(required).sort()
      const actualRequired = requiredNames.filter((entry): entry is string => typeof entry === 'string').sort()
      equal(actualRequired, expectedRequired, `${name} complete required-argument list`)
      const expectedProperties = [...Object.keys(required), ...Object.keys(optional)].sort()
      equal(Object.keys(properties).sort(), expectedProperties, `${name} complete argument schema`)
      for (const [fieldName, type] of Object.entries(required)) {
        const schema = record(properties[fieldName], `${name}.${fieldName} schema`)
        if (type !== 'any' && schema.type !== type) throw new CliFilesFailure('invalid-method-schema', `${name}.${fieldName} has the wrong public schema type`)
        if (!requiredNames.includes(fieldName)) throw new CliFilesFailure('invalid-method-schema', `${name}.${fieldName} is not required by its public schema`)
      }
      for (const [fieldName, type] of Object.entries(optional)) {
        const schema = record(properties[fieldName], `${name}.${fieldName} schema`)
        if (type !== 'any' && schema.type !== type) throw new CliFilesFailure('invalid-method-schema', `${name}.${fieldName} has the wrong public schema type`)
        if (requiredNames.includes(fieldName)) throw new CliFilesFailure('invalid-method-schema', `${name}.${fieldName} must remain optional`)
      }
      return params
    }
    requireMethod('ui.window.state', { connId: 'integer' })
    requireMethod('ui.window.view.open', { connId: 'integer', id: 'string' }, { input: 'any' })
    requireMethod('ui.window.command.run', { connId: 'integer', id: 'string' }, { args: 'any' })
    for (const methodName of ['ui.window.state', 'ui.window.view.open', 'ui.window.command.run']) {
      const method = methods.find((entry) => entry.name === methodName)!
      const connSchema = record(record(method.params, `${methodName} params`).properties, `${methodName} properties`).connId
      if (!isObject(connSchema) || connSchema.minimum !== 1) {
        throw new CliFilesFailure('invalid-method-schema', `${methodName} connId must require a positive connection ID`)
      }
    }
    const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
    const counts: JsonObject = {}
    for (const key of ['commands', 'methods', 'events', 'uiCommands']) counts[key] = Array.isArray(catalog[key]) ? (catalog[key] as unknown[]).length : -1
    const apiReceipt = this.receipts.find((receipt) => receipt.id === 'api-catalog')!
    apiReceipt.evidence = { schemaVersion: catalog.schemaVersion, counts, digest, checkedRows: rows.length }
  }

  async editorScenarios(): Promise<void> {
    await this.observation('files-editor-local', (builder) => this.editorObservation('files-editor-local', builder))
    if (this.observations.get('files-editor-local')?.status !== 'observed') return
    await this.observation('files-editor-other-worktree', (builder) => this.editorObservation('files-editor-other-worktree', builder))
    if (this.observations.get('files-editor-other-worktree')?.status !== 'observed') return
    await this.observation('files-editor-literal-path', (builder) => this.editorObservation('files-editor-literal-path', builder))
  }

  async captureGuards(): Promise<void> {
    const world = this.world
    if (!world) return
    const readLines = (path: string): string[] => {
      if (!existsSync(path)) throw new CliFilesFailure('guard-evidence', `guard log is missing: ${path}`)
      const text = readFileSync(path, 'utf8')
      return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => sanitizeText(line, this.home, this.tokenValues))
    }
    const denied = [...readLines(world.tools.securityLog), ...readLines(world.tools.orcaLog)]
    const egress = readLines(world.tools.egressLog)
    const injectionPresent = this.windows.some((entry) => existsSync(join(entry.worktree.path, 'cli-injected'))) ||
      existsSync(join(world.home, 'cli-injected')) || existsSync(join(resolve(import.meta.dir, '../..'), 'cli-injected'))
    this.guardEvidence = { denied, egress, injected: injectionPresent }
    if (denied.length !== 0) throw new CliFilesFailure('guard-evidence', 'unexpected CLI denial tool activity was recorded')
    if (JSON.stringify(egress) !== JSON.stringify(['https://cli-parity-guard.invalid/self-test'])) {
      throw new CliFilesFailure('guard-evidence', 'egress guard log differs from the required self-test only')
    }
    if (injectionPresent) throw new CliFilesFailure('literal-path-execution', 'literal path created cli-injected')
  }

  async cleanupOwnedTabs(): Promise<void> {
    if (!this.world || this.windows.length !== 2) return
    const cleanupDeadline = Math.min(this.startedAt + WORK_LIMIT_MS + TEARDOWN_LIMIT_MS, Date.now() + TEARDOWN_LIMIT_MS)
    this.cleanupTimer = setTimeout(() => this.cleanupController.abort(new CliFilesFailure('cleanup-deadline', 'CLI file teardown exceeded its 30-second cleanup reserve')),
      Math.max(1, cleanupDeadline - Date.now()))
    try {
      await this.world.assertLive({ signal: this.cleanupController.signal, timeoutMs: Math.min(CHILD_LIMIT_MS, cleanupDeadline - Date.now()) })
      await this.assertLive(true)
    } catch (error) {
      const failure = safeError(error)
      this.primaryFailure ??= { stage: 'cleanup-liveness', kind: failure.kind, message: sanitizeText(failure.message, this.home, this.tokenValues) }
      return
    }
    try {
      const reviewToClose = new Map<string, { worktreeId: string; tabId: string; connId: number }>()
      for (const review of this.reviewTabs.values()) {
        reviewToClose.set(`${review.worktreeId}\0${review.tabId}`, review)
      }
      const worktrees = [...new Map(this.windows.map((entry) => [entry.worktree.id, entry.worktree])).values()]
      for (const worktree of worktrees) {
        const window = this.windows.find((entry) => entry.worktree.id === worktree.id)
        if (!window) continue
        try {
          const state = await this.api(`cleanup-workspace-${worktree.id}`, 'quirky.terminal/workspace', { workspace: worktree.id }, { cleanup: true })
          for (const tab of tabsInWorkspace(state)) {
            if (tab.viewId === REVIEW_VIEW_ID && tab.key === reviewKey(worktree.id)) {
              const tabId = string(tab.id, `cleanup Review tab for ${worktree.id}`)
              reviewToClose.set(`${worktree.id}\0${tabId}`, { worktreeId: worktree.id, tabId, connId: window.connId })
            }
          }
        } catch (error) {
          this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
        }
        try {
          const state = record(await this.editor(`cleanup-editor-state-${worktree.id}`, ['state', '--worktree', worktree.id], { cleanup: true }),
            `cleanup editor state ${worktree.id}`)
          for (const entry of array(state.buffers, `cleanup buffers ${worktree.id}`)) {
            const buffer = record(entry, `cleanup buffer ${worktree.id}`)
            if (typeof buffer.id === 'string') this.editorBuffers.set(buffer.id, worktree.id)
          }
        } catch (error) {
          this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
        }
      }
      for (const review of reviewToClose.values()) {
        if (this.cleanupController.signal.aborted) throw new CliFilesFailure('cleanup-deadline', 'no teardown time remains to close Review tabs')
        try {
          await this.runWindowCommand(`cleanup-review-${review.tabId}`, review.connId, 'command:quirky.git/close-diff', { tabId: review.tabId }, true)
        } catch (error) {
          this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
        }
      }
      for (const [bufferId] of this.editorBuffers) {
        if (this.cleanupController.signal.aborted) throw new CliFilesFailure('cleanup-deadline', 'no teardown time remains to close editor tabs')
        try {
          const result = record(await this.editor(`cleanup-editor-${bufferId}`, ['close', '--buffer-id', bufferId], { mutation: true, cleanup: true }),
            `cleanup editor close ${bufferId}`)
          if (result.closed !== true) throw new CliFilesFailure('cleanup-tab', `editor tab ${bufferId} did not close`)
        } catch (error) {
          this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
        }
      }
      for (const worktree of worktrees) {
        try {
          const state = await this.api(`cleanup-verify-workspace-${worktree.id}`, 'quirky.terminal/workspace', { workspace: worktree.id }, { cleanup: true })
          if (tabsInWorkspace(state).some((tab) => tab.viewId === REVIEW_VIEW_ID && tab.key === reviewKey(worktree.id))) {
            throw new CliFilesFailure('cleanup-tab', `Review tab remains open in ${worktree.id}`)
          }
          const editor = record(await this.editor(`cleanup-verify-editor-${worktree.id}`, ['state', '--worktree', worktree.id], { cleanup: true }),
            `cleanup verify editor state ${worktree.id}`)
          if (array(editor.buffers, `cleanup verify buffers ${worktree.id}`).length !== 0) {
            throw new CliFilesFailure('cleanup-tab', `editor buffers remain open in ${worktree.id}`)
          }
        } catch (error) {
          this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
        }
      }
    } catch (error) {
      this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
    }
  }

  async cleanupSentinel(): Promise<void> {
    const child = this.sentinelChild
    if (child) {
      this.sentinelAliveAfterWorld = child.exitCode === null && child.signalCode === null
      try {
        process.kill(child.pid, 0)
        this.sentinelAliveAfterWorld = child.exitCode === null && child.signalCode === null
      } catch {
        this.sentinelAliveAfterWorld = false
      }
      if (!this.sentinelAliveAfterWorld) this.sentinelError = 'unrelated sentinel did not survive owned-world cleanup'
      try {
        if (child.exitCode === null) child.kill('SIGTERM')
        const exit = await Promise.race([child.exited, Bun.sleep(750).then(() => null)])
        if (exit === null && child.exitCode === null) child.kill('SIGKILL')
        await child.exited
      } catch (error) {
        this.sentinelError = [this.sentinelError, safeError(error).message].filter(Boolean).join('; ')
      }
    } else {
      this.sentinelAliveAfterWorld = false
    }
    if (this.sentinelHome) {
      try {
        rmSync(this.sentinelHome, { recursive: true, force: true })
        if (existsSync(this.sentinelHome)) this.sentinelError = [this.sentinelError, 'sentinel home remains after cleanup'].filter(Boolean).join('; ')
      } catch (error) { this.sentinelError = [this.sentinelError, safeError(error).message].filter(Boolean).join('; ') }
    }
  }

  async cleanupWorld(): Promise<void> {
    if (!this.world) {
      await this.cleanupSentinel()
      this.cleanupFailure = [this.cleanupFailure, 'owned world cleanup identity could not be verified'].filter(Boolean).join('; ')
      if (this.sentinelError) this.cleanupFailure = [this.cleanupFailure, this.sentinelError].filter(Boolean).join('; ')
      this.cleanupEvidence = { processIdentitiesGone: false, trackedIdentities: [], sentinelAlive: this.sentinelAliveAfterWorld }
      clearTimeout(this.cleanupTimer)
      return
    }
    try {
      await this.world.cleanup()
    } catch (error) {
      const info = error && typeof error === 'object' ? error as Record<string, unknown> : {}
      this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
      if (typeof info.cleanupError === 'string') this.cleanupFailure = [this.cleanupFailure, info.cleanupError].filter(Boolean).join('; ')
    }
    const rawEvidence = isObject(this.world.cleanupEvidence) ? this.world.cleanupEvidence as JsonObject : {}
    const rawIdentities = Array.isArray(rawEvidence.trackedIdentities) ? rawEvidence.trackedIdentities :
      Array.isArray(rawEvidence.identities) ? rawEvidence.identities : []
    const trackedIdentities = rawIdentities.filter(isObject).map((identity) => identity as JsonObject)
    const homeRemoved = rawEvidence.homeRemoved === true || (this.home !== '' && !existsSync(this.home))
    const allRecordedGone = trackedIdentities.length > 0 && trackedIdentities.every((identity) => identity.gone === true)
    const processIdentitiesGone = rawEvidence.processIdentitiesGone === true || (allRecordedGone && homeRemoved)
    const daemonFound = trackedIdentities.some((identity) => typeof identity.command === 'string' && identity.command.includes('daemon/src/main.ts'))
    const browserFound = trackedIdentities.some((identity) => typeof identity.command === 'string' && /chrome|chromium/i.test(identity.command))
    if (!processIdentitiesGone) this.cleanupFailure = [this.cleanupFailure, 'owned process disappearance was not verified'].filter(Boolean).join('; ')
    if (!homeRemoved) this.cleanupFailure = [this.cleanupFailure, 'owned home was not verified removed'].filter(Boolean).join('; ')
    if (!daemonFound) this.cleanupFailure = [this.cleanupFailure, 'cleanup evidence omitted the owned daemon identity'].filter(Boolean).join('; ')
    if (!browserFound) this.cleanupFailure = [this.cleanupFailure, 'cleanup evidence omitted the owned browser identity'].filter(Boolean).join('; ')
    await this.cleanupSentinel()
    if (this.sentinelError) this.cleanupFailure = [this.cleanupFailure, this.sentinelError].filter(Boolean).join('; ')
    this.cleanupEvidence = {
      ...rawEvidence,
      processIdentitiesGone,
      homeRemoved,
      trackedIdentities,
      daemonIdentityFound: daemonFound,
      browserIdentityFound: browserFound,
      sentinelAlive: this.sentinelAliveAfterWorld
    }
    clearTimeout(this.cleanupTimer)
  }
  async run(): Promise<CliFilesReport> {
    const placeholder = (id: string): CliFileObservation => ({
      id,
      status: 'not-run',
      receiptIds: [],
      before: [],
      after: [],
      evidence: { request: {}, public: { before: [], after: [] }, dom: { before: [], after: [] }, elapsedMs: 0 },
      error: { kind: 'not-run', message: 'the file observation did not run' }
    })
    let rows: table.CliTableRow[] = []
    let cleanup = false
    try {
      this.progress('starting isolated two-window CLI file observation')
      rows = table.loadCliTable()
      await this.ensureWorld()
      this.progress('running renderer observations')
      await this.editorScenarios()
      if (!this.primaryFailure) await this.prepareRoutingAndReview()
      if (!this.primaryFailure) await this.captureGuards()
    } catch (error) {
      const failure = safeError(error)
      this.primaryFailure ??= {
        stage: this.currentStage,
        kind: failure.kind,
        message: sanitizeText(failure.message, this.home, this.tokenValues)
      }
      if (error && typeof error === 'object' && 'cleanupError' in error && typeof (error as Record<string, unknown>).cleanupError === 'string') {
        this.cleanupFailure = [(error as Record<string, unknown>).cleanupError as string, this.cleanupFailure].filter(Boolean).join('; ')
      }
    } finally {
      clearTimeout(this.workTimer)
      if (this.options.signal && this.signalListener) this.options.signal.removeEventListener('abort', this.signalListener)
      await this.cleanupOwnedTabs()
      try { if (!this.guardEvidence) await this.captureGuards() }
      catch (error) { this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ') }
      await this.cleanupWorld()
      clearTimeout(this.cleanupTimer)
      cleanup = true
    }
    const blocker = this.primaryFailure ?? (this.cleanupFailure ? { stage: 'cleanup', kind: 'cleanup-failed', message: this.cleanupFailure } : undefined)
    for (const id of EXPECTED_OBSERVATIONS) if (!this.observations.has(id)) this.markNotRun(id, blocker ?? { kind: 'not-run', message: 'dependent observation was not run' })
    let reportRows: CliFilesReport['rows'] = []
    try {
      reportRows = reduceCliFilesRows(rows, EXPECTED_OBSERVATIONS.map((id) => this.observations.get(id) ?? placeholder(id)), this.receipts)
    } catch (error) {
      const failure = safeError(error)
      this.primaryFailure ??= { stage: this.currentStage, kind: failure.kind, message: sanitizeText(failure.message, this.home, this.tokenValues) }
      reportRows = rows.filter((row) => Object.hasOwn(REQUIRED_ROW_BINDINGS, row.id)).map((row) => ({
        id: row.id,
        disposition: row.disposition as 'covered' | 'gap',
        status: 'failed',
        executed: false,
        observations: [...REQUIRED_ROW_BINDINGS[row.id]!],
        differences: [...EXPECTED_DIFFERENCES[row.id]!]
      }))
    }
    const observedAll = [...this.observations.values()].length === EXPECTED_OBSERVATIONS.length &&
      EXPECTED_OBSERVATIONS.every((id) => this.observations.get(id)?.status === 'observed')
    const ok = !this.primaryFailure && !this.cleanupFailure && cleanup && observedAll && this.guardEvidence?.injected === false
    const report: CliFilesReport = {
      schemaVersion: 1,
      scope: 'goal-11-cli-files',
      ok,
      parityComplete: false,
      rows: reportRows,
      observations: EXPECTED_OBSERVATIONS.map((id) => this.observations.get(id) ?? placeholder(id)),
      receipts: this.receipts,
      cleanup: {
        ok: !this.cleanupFailure && cleanup && this.cleanupEvidence.processIdentitiesGone === true && this.cleanupEvidence.sentinelAlive === true,
        ...(this.cleanupFailure ? { error: this.cleanupFailure } : {}),
        evidence: this.cleanupEvidence
      },
      elapsedMs: Math.max(1, Date.now() - this.startedAt),
      buildElapsedMs: this.buildElapsedMs,
      ...(this.guardEvidence ? { guards: this.guardEvidence } : {}),
      ...(Object.keys(this.fixtureEvidence).length ? { fixtures: { ...this.fixtureEvidence, gitCommands: this.gitEvidence } } : {}),
      ...(this.primaryFailure ? { error: this.primaryFailure } : {})
    }
    return sanitizeValue(report, this.home, this.tokenValues) as CliFilesReport
  }
}

export async function runCliFilesParity(options: CliFilesRunOptions = {}): Promise<CliFilesReport> {
  return new CliFilesRunner(options).run()
}

export async function main(args = process.argv.slice(2), runOptions: Omit<CliFilesRunOptions, 'signal'> = {}): Promise<number> {
  let parsed: CliFilesArguments
  try { parsed = parseCliFilesArgs(args) }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
  if (parsed.help) {
    console.log('Usage: bun scripts/parity/cli-files.ts [--json | --help]')
    return 0
  }
  const controller = new AbortController()
  const stop = () => controller.abort(new CliFilesFailure('interrupted', 'CLI file rehearsal interrupted'))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    const report = await runCliFilesParity({ ...runOptions, signal: controller.signal })
    await Bun.write(Bun.stdout, `${JSON.stringify(report, null, parsed.json ? undefined : 2)}\n`)
    return report.ok ? 0 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) process.exitCode = await main()
