import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { createIsolatedRuntimeEnvironment, type FixtureWorktree } from '../ui-review/fixtures'
import { readRuntime } from '@quirky/protocol/node'
import { parseCliRefusal, type CliReceipt } from './cli-run'
import { checkIds } from './cli-checks'
import * as table from './cli-table'
import { CLI_FILE_OBSERVATION_BINDINGS } from './cli-table'
import { createCliFilesWorld, type CliFilesWorld } from './cli-world'
import type { BrowserContext } from 'playwright'

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
export type CliFileReviewCard = {
  path: string
  expanded: boolean
  loaded: boolean
  text: string
  active?: boolean
  editable?: boolean
  hasReviewMark?: boolean
  mergeEditorCount?: number
  originalLines?: string[]
  modifiedLines?: string[]
}
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
  reviewScopeChip?: string | null
  reviewWidth?: number
  reviewScrollTop?: number
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
  parityComplete: boolean
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
export type CliFileNavigationHistory = { worktrees: string[]; index: number }

export function expectedHistory(
  before: CliFileNavigationHistory,
  shownBefore: string,
  destination: string
): CliFileNavigationHistory {
  const worktrees = before.worktrees.slice(0, before.index + 1)
  if (worktrees.at(-1) !== shownBefore) worktrees.push(shownBefore)
  if (worktrees.at(-1) !== destination) worktrees.push(destination)
  return { worktrees, index: worktrees.length - 1 }
}

export function isCliFilesParityComplete(
  ok: boolean,
  cleanupOk: boolean,
  rows: CliFilesReport['rows']
): boolean {
  return ok && cleanupOk && rows.length === 4 &&
    rows.every((row) => row.disposition === 'covered' && row.status === 'observed')
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
const EXPECTED_OBSERVATION_COUNT = 13
const EXPECTED_BINDING_COUNT = 21
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
    'Quirky Review is one combined tab per worktree, not one diff tab per file.',
    'Review focuses by default; Orca opens the diff in the background.',
    'Exact window routing uses ui.window.command.run --conn-id rather than a command flag.',
    'Background reveal or scope applies in the target renderer when Review is next shown.',
    'Review source selects staged or unstaged; omission shows the whole review, not Orca’s unstaged default.'
  ],
  'file-open': ['Without --window, --focus selects the tab in its worktree workspace and moves no window.'],
  'file-open-changed': [
    'Quirky Review is one combined tab per worktree rather than one tab per changed file.',
    'Review focuses by default; Orca opens in the background.',
    'Edit and both open at most 50 files and refuse capped status; deleted files are skipped.'
  ],
  'file-open-render': [
    '--window routes focused editor open to the chosen Quirky renderer; without it, focus selects only the workspace tab.',
    'Headless document focus is not native macOS window raising.'
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
function renderedLine(value: unknown): string {
  if (typeof value !== 'string') throw new CliFilesFailure('invalid-evidence', 'rendered line is not a string')
  return value
}
function shownWorktree(window: CliFilePublicWindow): string {
  return string(record(window.windowState.layout, 'public window layout').worktree, 'shown worktree')
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
  if (!isDeepStrictEqual(actual, expected)) {
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
type CliFileHistoryRead = {
  connId: number
  shownWorktree: string
  receiptId: string
  result: CliFileNavigationHistory
}

function readNavigationHistory(
  value: unknown,
  byId: Map<string, CliReceipt>,
  observation: CliFileObservation,
  label: string
): CliFileHistoryRead {
  const history = record(value, label)
  const connId = integer(history.connId, `${label} connection`)
  const shownWorktree = string(history.shownWorktree, `${label} shown worktree`)
  const receiptId = string(history.receiptId, `${label} receipt ID`)
  assertReceiptLinked(observation, receiptId, label)
  const receipt = byId.get(receiptId)!
  if (receipt.command !== 'api call' || receipt.argv[2] !== 'quirky.worktree/navigationState' ||
      Number(argvFlag(receipt.argv, '--window', label)) !== connId) {
    throw new CliFilesFailure('invalid-receipt', `${label} is not the targeted public navigationState read`)
  }
  const result = successfulReceipt(byId, receiptId)
  equal(result, history.result, `${label} independent history readback`)
  const raw = record(history.result, `${label} result`)
  const worktrees = array(raw.worktrees, `${label} worktrees`).map((entry) => string(entry, `${label} worktree`))
  const index = integer(raw.index, `${label} index`)
  if (index < -1 || index >= worktrees.length) throw new CliFilesFailure('invalid-history', `${label} has an invalid cursor`)
  return { connId, shownWorktree, receiptId, result: { worktrees, index } }
}

function assertNavigationHistoryTransition(
  observation: CliFileObservation,
  byId: Map<string, CliReceipt>,
  beforeValue: unknown,
  afterValue: unknown,
  targetConnId: number,
  destination: string,
  label: string
): { before: CliFileHistoryRead; after: CliFileHistoryRead } {
  const before = readNavigationHistory(beforeValue, byId, observation, `${label} before`)
  const after = readNavigationHistory(afterValue, byId, observation, `${label} after`)
  equal(before.connId, targetConnId, `${label} history target connection`)
  equal(after.connId, targetConnId, `${label} resulting connection`)
  equal(after.shownWorktree, destination, `${label} resulting shown worktree`)
  equal(after.result, expectedHistory(before.result, before.shownWorktree, destination), `${label} expected navigation history`)
  return { before, after }
}
function assertFirstWindowLayoutReceipt(
  observation: CliFileObservation,
  byId: Map<string, CliReceipt>,
  afterCommandId: string,
  connId: number,
  publicWindow: CliFilePublicWindow,
  label: string
): void {
  assertReceiptLinked(observation, afterCommandId, `${label} product command`)
  const allReceipts = [...byId.values()]
  const commandIndex = allReceipts.findIndex((receipt) => receipt.id === afterCommandId)
  if (commandIndex < 0) throw new CliFilesFailure('missing-receipt', `${label} command is absent from raw receipts`)
  let firstLayout: CliReceipt | undefined
  for (const receipt of allReceipts.slice(commandIndex + 1)) {
    if (commandOf(receipt.argv) === 'api call' && receipt.argv[2] === 'ui.window.state' &&
        Number(argvFlag(receipt.argv, '--conn-id', label)) === connId) {
      firstLayout = receipt
      break
    }
  }
  if (!firstLayout) throw new CliFilesFailure('missing-receipt', `${label} has no public layout read after its command`)
  equal(firstLayout.id, publicWindow.receiptIds.window, `${label} first public layout receipt`)
  equal(Number(argvFlag(firstLayout.argv, '--conn-id', label)), connId, `${label} first public layout connection`)
  equal(successfulReceipt(byId, firstLayout.id), publicWindow.windowState, `${label} first public layout state`)
}
function assertCliRefusal(
  observation: CliFileObservation,
  byId: Map<string, CliReceipt>,
  receiptId: string,
  expected: { argv: string[]; exitCode: 1 | 2; code: string; message?: string },
  label: string
): { code: string; message: string; data?: unknown } {
  assertReceiptLinked(observation, receiptId, `${label} refusal`)
  const receipt = byId.get(receiptId)!
  equal(receipt.argv, [...expected.argv, '--runtime', 'local', '--json'], `${label} exact refusal argv`)
  equal(receipt.exitCode, expected.exitCode, `${label} refusal exit`)
  const refusal = parseCliRefusal(JSON.stringify(receipt.evidence.result), receipt.exitCode, expected.exitCode)
  equal(refusal.code, expected.code, `${label} refusal code`)
  if (expected.message !== undefined) equal(refusal.message, expected.message, `${label} refusal message`)
  return refusal
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
function assertWindowEditorOpen(
  receipt: CliReceipt,
  byId: Map<string, CliReceipt>,
  input: {
    relativePath: string
    worktreeId: string
    absolutePath: string
    window: number | null
    focus: boolean
    line?: number
    column?: number
  },
  label: string
): JsonObject {
  if (receipt.command !== 'editor open' || receipt.argv[0] !== 'editor' || receipt.argv[1] !== 'open') {
    throw new CliFilesFailure('invalid-receipt', `${label} is not an editor open command`)
  }
  equal(receipt.argv[2], input.relativePath, `${label} exact relative path`)
  equal(argvFlag(receipt.argv, '--worktree', label), input.worktreeId, `${label} worktree`)
  if (input.window !== null || hasArgvFlag(receipt.argv, '--mode')) {
    equal(argvFlag(receipt.argv, '--mode', label), 'source', `${label} mode`)
  }
  equal(hasArgvFlag(receipt.argv, '--focus'), input.focus, `${label} explicit focus`)
  if (input.window === null) {
    if (hasArgvFlag(receipt.argv, '--window')) throw new CliFilesFailure('invalid-receipt', `${label} unexpectedly targeted a window`)
  } else equal(argvFlag(receipt.argv, '--window', label), String(input.window), `${label} exact window`)
  if (input.line === undefined) {
    if (hasArgvFlag(receipt.argv, '--line')) throw new CliFilesFailure('navigation-mismatch', `${label} unexpectedly requested a line`)
  } else equal(argvFlag(receipt.argv, '--line', label), String(input.line), `${label} requested line`)
  if (input.column === undefined) {
    if (hasArgvFlag(receipt.argv, '--column')) throw new CliFilesFailure('navigation-mismatch', `${label} unexpectedly requested a column`)
  } else equal(argvFlag(receipt.argv, '--column', label), String(input.column), `${label} requested column`)
  const result = successfulReceipt(byId, receipt.id)
  equal(result.worktreeId, input.worktreeId, `${label} result worktree`)
  equal(result.path, input.absolutePath, `${label} result absolute path`)
  const root = string(result.root, `${label} authorized root`)
  equal(expectedAbsolute(root, input.relativePath), input.absolutePath, `${label} authorized path`)
  string(result.id, `${label} buffer ID`)
  string(result.openedTabId, `${label} hosted tab ID`)
  return result
}

function assertWindowFocusObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} top-level before`, false)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} top-level after`)
  const worktreeId = string(request.worktreeId, `${observation.id} target worktree`)
  const relativePath = string(request.relativePath, `${observation.id} target path`)
  const absolutePath = string(request.absolutePath, `${observation.id} absolute path`)
  const content = string(request.content, `${observation.id} source bytes`)
  const line = integer(request.line, `${observation.id} requested line`)
  const column = integer(request.column, `${observation.id} requested column`)
  const targetConnId = integer(request.targetConnectionId, `${observation.id} target connection`)
  equal(relativePath, B_TARGET, `${observation.id} relative path`)
  equal(content, B_CONTENT, `${observation.id} bytes`)
  equal(request.mode, 'source', `${observation.id} mode`)
  equal(line, 2, `${observation.id} initial line`)
  equal(column, 3, `${observation.id} initial column`)
  equal(observation.before.length, 2, `${observation.id} two live windows`)
  const beforePublic = observation.evidence.public.before
  const beforeDom = observation.evidence.dom.before
  assertSample(observation.before, beforePublic, beforeDom, byId, observation, `${observation.id} before`, false)
  const targetIndex = observation.before.findIndex((sample) => sample.connId === targetConnId)
  if (targetIndex !== 0) throw new CliFilesFailure('connection-mismatch', `${observation.id} did not route through page A`)
  const otherIndex = 1
  const shownBefore = string(
    record(beforePublic[targetIndex]!.windowState, `${observation.id} before target window`).layout &&
      record(record(beforePublic[targetIndex]!.windowState, `${observation.id} before target window`).layout, `${observation.id} before target layout`).worktree,
    `${observation.id} shown-before worktree`
  )
  if (shownBefore === worktreeId) throw new CliFilesFailure('worktree-mismatch', `${observation.id} target window did not start on the other worktree`)
  equal(observation.before[otherIndex]!.windowWorktree, shownBefore, `${observation.id} both windows start on A`)

  const sentinels = record(observation.evidence.sentinels, `${observation.id} sentinels`)
  const sentinelA = record(sentinels.a, `${observation.id} sentinel A`)
  const sentinelB = record(sentinels.b, `${observation.id} sentinel B`)
  checkSentinel(beforePublic[targetIndex]!, beforeDom[targetIndex]!, sentinelA, `${observation.id} cA sentinel`)
  checkSentinel(beforePublic[otherIndex]!, beforeDom[otherIndex]!, sentinelA, `${observation.id} cB shared sentinel`)
  equal(sentinelB.worktreeId, worktreeId, `${observation.id} destination sentinel worktree`)
  const destination = record(observation.evidence.destination, `${observation.id} destination workspace`)
  const destinationReceiptId = string(destination.beforeReceiptId, `${observation.id} destination baseline receipt`)
  assertReceiptLinked(observation, destinationReceiptId, `${observation.id} destination baseline`)
  const destinationReceipt = byId.get(destinationReceiptId)!
  if (destinationReceipt.command !== 'api call' || destinationReceipt.argv[2] !== 'quirky.terminal/workspace' ||
      argvFlag(destinationReceipt.argv, '--workspace', `${observation.id} destination baseline`) !== worktreeId) {
    throw new CliFilesFailure('invalid-receipt', `${observation.id} destination baseline was not a public workspace read`)
  }
  const destinationBefore = successfulReceipt(byId, destinationReceiptId)
  equal(destinationBefore, destination.before, `${observation.id} destination baseline readback`)
  equal(selectedTabId(destinationBefore), sentinelB.tabId, `${observation.id} destination sentinel is active before open`)

  const windowFocus = record(observation.evidence.windowFocus, `${observation.id} window focus evidence`)
  const tabId = string(windowFocus.tabId, `${observation.id} opened tab`)
  const bufferId = string(windowFocus.bufferId, `${observation.id} opened buffer`)
  const focus = record(windowFocus.focus, `${observation.id} first focus step`)
  const focusBefore = record(focus.before, `${observation.id} focus before`) as unknown as CapturedSample
  const focusAfter = record(focus.after, `${observation.id} focus after`) as unknown as CapturedSample
  assertSample(focusBefore.snapshots, focusBefore.public, focusBefore.dom, byId, observation, `${observation.id} focus before`, false)
  assertSample(focusAfter.snapshots, focusAfter.public, focusAfter.dom, byId, observation, `${observation.id} focus after`)
  equal(focusBefore.public[targetIndex]!.connId, targetConnId, `${observation.id} focus target before`)
  const focusReceiptId = string(focus.receiptId, `${observation.id} focus receipt`)
  const focusResult = assertWindowEditorOpen(byId.get(focusReceiptId)!, byId, {
    relativePath, worktreeId, absolutePath, window: targetConnId, focus: false, line, column
  }, `${observation.id} initial window open`)
  equal(focusResult.id, bufferId, `${observation.id} initial buffer identity`)
  equal(focusResult.openedTabId, tabId, `${observation.id} initial tab identity`)
  const initialEditorTabs = array(focusAfter.public[targetIndex]!.editor.tabs, `${observation.id} initial editor tabs`)
    .map((entry) => record(entry, `${observation.id} initial editor tab`))
    .filter((entry) => entry.bufferId === bufferId)
  equal(initialEditorTabs.map((entry) => entry.tabId), [tabId], `${observation.id} one initial tab for the buffer`)
  assertFirstWindowLayoutReceipt(observation, byId, focusReceiptId, targetConnId, focusAfter.public[targetIndex]!, `${observation.id} first focus read`)
  const focusLayout = record(focusAfter.public[targetIndex]!.windowState.layout, `${observation.id} focused layout`)
  equal(focusLayout.worktree, worktreeId, `${observation.id} cA destination worktree`)
  const focusView = record(focusLayout.view, `${observation.id} focused session view`)
  equal(focusView.id, SESSION_VIEW_ID, `${observation.id} session view ID`)
  equal(record(focusView.input, `${observation.id} focused session input`).worktree, worktreeId, `${observation.id} session input worktree`)
  equal(focusAfter.public[targetIndex]!.workspace && selectedTabId(focusAfter.public[targetIndex]!.workspace), tabId, `${observation.id} selected destination tab`)
  equal(focusAfter.dom[targetIndex]!.renderedTabId, tabId, `${observation.id} rendered destination tab`)
  equal(focusAfter.dom[targetIndex]!.path, absolutePath, `${observation.id} rendered absolute source path`)
  equal(focusAfter.dom[targetIndex]!.lines, ['first', 'second λ', ''], `${observation.id} rendered source lines`)
  equal(focusAfter.dom[targetIndex]!.caret, { line, column }, `${observation.id} native caret`)
  equal(focusAfter.dom[targetIndex]!.activeElementHostedTabId, tabId, `${observation.id} active element tab`)
  equal(focusAfter.dom[targetIndex]!.activeElementIsSource, true, `${observation.id} active source content`)
  equal(focusAfter.dom[targetIndex]!.activeElement.inDocument, true, `${observation.id} active element remains in the page`)
  equal(focusAfter.public[otherIndex]!.windowState.layout, focusBefore.public[otherIndex]!.windowState.layout, `${observation.id} cB layout unchanged`)
  equal(focusAfter.dom[otherIndex], focusBefore.dom[otherIndex], `${observation.id} cB DOM unchanged`)
  const focusHistoryBefore = record(focus.historyBefore, `${observation.id} focus history before`)
  const focusHistoryAfter = record(focus.historyAfter, `${observation.id} focus history after`)
  const focusTransition = assertNavigationHistoryTransition(
    observation, byId, focusHistoryBefore.target, focusHistoryAfter.target, targetConnId, worktreeId, `${observation.id} focus`
  )
  const otherTransition = {
    before: readNavigationHistory(focusHistoryBefore.other, byId, observation, `${observation.id} cB history before`),
    after: readNavigationHistory(focusHistoryAfter.other, byId, observation, `${observation.id} cB history after`)
  }
  equal(focusTransition.before.shownWorktree, shownBefore, `${observation.id} focus history/window correlation`)
  equal(otherTransition.after.result, otherTransition.before.result, `${observation.id} cB history unchanged`)

  const reuse = record(windowFocus.reuse, `${observation.id} reuse step`)
  const reuseBefore = record(reuse.before, `${observation.id} reuse before`) as unknown as CapturedSample
  const reuseAfter = record(reuse.after, `${observation.id} reuse after`) as unknown as CapturedSample
  assertSample(reuseBefore.snapshots, reuseBefore.public, reuseBefore.dom, byId, observation, `${observation.id} reuse before`, false)
  assertSample(reuseAfter.snapshots, reuseAfter.public, reuseAfter.dom, byId, observation, `${observation.id} reuse after`)
  const reuseReceiptId = string(reuse.receiptId, `${observation.id} reuse receipt`)
  const reuseResult = assertWindowEditorOpen(byId.get(reuseReceiptId)!, byId, {
    relativePath, worktreeId, absolutePath, window: targetConnId, focus: false, line: 1, column: 1
  }, `${observation.id} reuse open`)
  equal(reuseResult.id, bufferId, `${observation.id} reused buffer identity`)
  equal(reuseResult.openedTabId, tabId, `${observation.id} reused tab identity`)
  assertFirstWindowLayoutReceipt(observation, byId, reuseReceiptId, targetConnId, reuseAfter.public[targetIndex]!, `${observation.id} first reuse read`)
  equal(shownWorktree(reuseAfter.public[targetIndex]!), worktreeId, `${observation.id} reused destination worktree`)
  equal(reuseAfter.public[targetIndex]!.workspace && selectedTabId(reuseAfter.public[targetIndex]!.workspace), tabId, `${observation.id} reused selected tab`)
  const reuseBuffer = bufferById(reuseAfter.public[targetIndex]!.editor, bufferId)
  if (!reuseBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} reused editor buffer is missing`)
  const matchingEditorTabs = array(reuseAfter.public[targetIndex]!.editor.tabs, `${observation.id} editor tabs`)
    .map((entry) => record(entry, `${observation.id} editor tab`))
    .filter((entry) => entry.bufferId === bufferId)
  equal(matchingEditorTabs.length, 1, `${observation.id} one editor tab for reused buffer`)
  equal(reuseAfter.dom[targetIndex]!.caret, { line: 1, column: 1 }, `${observation.id} reused native caret`)
  equal(reuseAfter.dom[targetIndex]!.renderedTabId, tabId, `${observation.id} reused rendered tab`)
  equal(reuseAfter.dom[otherIndex], reuseBefore.dom[otherIndex], `${observation.id} reuse cB DOM unchanged`)
  const reuseHistoryBefore = record(reuse.historyBefore, `${observation.id} reuse history before`)
  const reuseHistoryAfter = record(reuse.historyAfter, `${observation.id} reuse history after`)
  const reuseTransition = assertNavigationHistoryTransition(
    observation, byId, reuseHistoryBefore.target, reuseHistoryAfter.target, targetConnId, worktreeId, `${observation.id} reuse`
  )
  equal(reuseTransition.before.shownWorktree, shownBefore, `${observation.id} reuse history/window correlation`)
  const reuseOtherBefore = readNavigationHistory(reuseHistoryBefore.other, byId, observation, `${observation.id} reuse cB history before`)
  const reuseOtherAfter = readNavigationHistory(reuseHistoryAfter.other, byId, observation, `${observation.id} reuse cB history after`)
  equal(reuseOtherAfter.result, reuseOtherBefore.result, `${observation.id} reuse cB history unchanged`)

  const background = record(windowFocus.background, `${observation.id} background step`)
  const backgroundBefore = record(background.before, `${observation.id} background before`) as unknown as CapturedSample
  const backgroundAfter = record(background.after, `${observation.id} background after`) as unknown as CapturedSample
  assertSample(backgroundBefore.snapshots, backgroundBefore.public, backgroundBefore.dom, byId, observation, `${observation.id} background before`)
  assertSample(backgroundAfter.snapshots, backgroundAfter.public, backgroundAfter.dom, byId, observation, `${observation.id} background after`)
  const backgroundReceiptId = string(background.receiptId, `${observation.id} background receipt`)
  const notesPath = 'docs/review-notes.md'
  const notesAbsolutePath = expectedAbsolute(
    string(focusResult.root, `${observation.id} authorized root`), notesPath
  )
  const backgroundResult = assertWindowEditorOpen(byId.get(backgroundReceiptId)!, byId, {
    relativePath: notesPath,
    worktreeId,
    absolutePath: notesAbsolutePath,
    window: null,
    focus: false
  }, `${observation.id} background open`)
  if (backgroundResult.openedTabId === tabId) throw new CliFilesFailure('tab-mismatch', `${observation.id} background open reused the active source tab`)
  equal(backgroundAfter.public[targetIndex]!.windowState.layout, backgroundBefore.public[targetIndex]!.windowState.layout, `${observation.id} background cA layout unchanged`)
  equal(backgroundAfter.public[otherIndex]!.windowState.layout, backgroundBefore.public[otherIndex]!.windowState.layout, `${observation.id} background cB layout unchanged`)
  equal(backgroundAfter.dom[targetIndex], backgroundBefore.dom[targetIndex], `${observation.id} background active source unchanged`)
  equal(backgroundAfter.dom[otherIndex], backgroundBefore.dom[otherIndex], `${observation.id} background cB DOM unchanged`)
  equal(selectedTabId(backgroundAfter.public[targetIndex]!.workspace), tabId, `${observation.id} background leaves destination active tab`)
  const backgroundHistoryBefore = record(background.historyBefore, `${observation.id} background history before`)
  const backgroundHistoryAfter = record(background.historyAfter, `${observation.id} background history after`)
  const backgroundTargetBefore = readNavigationHistory(backgroundHistoryBefore.target, byId, observation, `${observation.id} background cA history before`)
  const backgroundTargetAfter = readNavigationHistory(backgroundHistoryAfter.target, byId, observation, `${observation.id} background cA history after`)
  const backgroundOtherBefore = readNavigationHistory(backgroundHistoryBefore.other, byId, observation, `${observation.id} background cB history before`)
  const backgroundOtherAfter = readNavigationHistory(backgroundHistoryAfter.other, byId, observation, `${observation.id} background cB history after`)
  equal(backgroundTargetAfter.result, backgroundTargetBefore.result, `${observation.id} background cA history unchanged`)
  equal(backgroundOtherAfter.result, backgroundOtherBefore.result, `${observation.id} background cB history unchanged`)
}
function assertWindowRefusalsObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} top-level before`)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} top-level after`)
  const worktreeB = string(request.worktreeId, `${observation.id} target worktree`)
  const refusals = record(observation.evidence.refusals, `${observation.id} refusal evidence`)
  const initial = record(refusals.initial, `${observation.id} initial snapshot`)
  const initialSample = record(initial.sample, `${observation.id} initial sample`) as unknown as CapturedSample
  const initialHistory = record(initial.history, `${observation.id} initial histories`)
  const initialA = readNavigationHistory(initialHistory.a, byId, observation, `${observation.id} cA initial history`)
  const initialB = readNavigationHistory(initialHistory.b, byId, observation, `${observation.id} cB initial history`)
  assertSample(initialSample.snapshots, initialSample.public, initialSample.dom, byId, observation, `${observation.id} initial`, true)
  const connA = initialSample.public[0]!.connId
  const connB = initialSample.public[1]!.connId
  if (connA === connB) throw new CliFilesFailure('connection-mismatch', `${observation.id} repeats a live connection`)
  const worktreeA = shownWorktree(initialSample.public[0]!)
  equal(worktreeA, initialA.shownWorktree, `${observation.id} cA history baseline`)
  equal(shownWorktree(initialSample.public[1]!), initialB.shownWorktree, `${observation.id} cB history baseline`)
  const cBActive = selectedTabId(initialSample.public[1]!.workspace)
  if (cBActive === null) throw new CliFilesFailure('selection-mismatch', `${observation.id} cB has no active sentinel`)
  equal(initialSample.dom[1]!.selectedTabId, cBActive, `${observation.id} cB sentinel selection`)
  equal(initialSample.dom[1]!.renderedTabId, cBActive, `${observation.id} cB sentinel rendering`)

  const stableState = (
    sample: CapturedSample,
    history: { a: CliFileHistoryRead; b: CliFileHistoryRead }
  ): JsonObject[] => sample.public.map((publicWindow, index) => ({
    connId: publicWindow.connId,
    layout: publicWindow.windowState.layout,
    workspace: publicWindow.workspace,
    editor: publicWindow.editor,
    dom: sample.dom[index],
    history: index === 0 ? history.a.result : history.b.result
  }))
  const baselineState = stableState(initialSample, { a: initialA, b: initialB })
  const expectedCases: ReadonlyArray<{
    caseId: string; argv: string[]; exitCode: 1 | 2; code: string; message?: string
  }> = [
    { caseId: 'unknown-editor', argv: ['editor', 'open', 'src/app.ts', '--worktree', worktreeB, '--window', '999'], exitCode: 1, code: 'conflict', message: 'UI window connection 999 is not open' },
    { caseId: 'zero-window', argv: ['editor', 'open', 'src/app.ts', '--worktree', worktreeB, '--window', '0'], exitCode: 2, code: 'usage' },
    { caseId: 'focus-window-conflict', argv: ['editor', 'open', 'src/app.ts', '--worktree', worktreeB, '--focus=false', '--window', String(connA)], exitCode: 1, code: 'invalid-params', message: 'window cannot be combined with focus: false' },
    { caseId: 'unknown-review-window', argv: ['api', 'call', 'ui.window.command.run', '--conn-id', '999', '--id', 'command:quirky.git/open-diff', '--args', JSON.stringify({ worktree: worktreeB, path: 'src/app.ts' })], exitCode: 1, code: 'conflict', message: 'UI window connection 999 is not open' },
    { caseId: 'disconnected-editor', argv: ['editor', 'open', 'docs/review-notes.md', '--worktree', worktreeB, '--window', String(request.connC)], exitCode: 1, code: 'conflict', message: `UI window connection ${request.connC} is not open` },
    { caseId: 'disconnected-open-changes', argv: ['api', 'call', 'ui.window.command.run', '--conn-id', String(request.connC), '--id', 'command:quirky.git/open-changes', '--args', JSON.stringify({ worktree: worktreeB })], exitCode: 1, code: 'conflict', message: `UI window connection ${request.connC} is not open` }
  ]
  const cases = array(refusals.cases, `${observation.id} exact refusals`)
  equal(cases.length, expectedCases.length, `${observation.id} refusal count`)
  for (const [index, expected] of expectedCases.entries()) {
    const caseEvidence = record(cases[index], `${observation.id} refusal ${expected.caseId}`)
    equal(caseEvidence.caseId, expected.caseId, `${observation.id} refusal identity`)
    const receiptId = string(caseEvidence.receiptId, `${observation.id} refusal receipt`)
    assertCliRefusal(observation, byId, receiptId, {
      argv: expected.argv,
      exitCode: expected.exitCode,
      code: expected.code,
      ...(expected.message === undefined ? {} : { message: expected.message })
    }, `${observation.id} ${expected.caseId}`)
    const after = record(caseEvidence.after, `${observation.id} ${expected.caseId} after`)
    const afterSample = record(after.sample, `${observation.id} ${expected.caseId} sample`) as unknown as CapturedSample
    const afterHistories = record(after.history, `${observation.id} ${expected.caseId} histories`)
    const historyA = readNavigationHistory(afterHistories.a, byId, observation, `${observation.id} ${expected.caseId} cA history`)
    const historyB = readNavigationHistory(afterHistories.b, byId, observation, `${observation.id} ${expected.caseId} cB history`)
    assertSample(afterSample.snapshots, afterSample.public, afterSample.dom, byId, observation, `${observation.id} ${expected.caseId} after`, true)
    equal(stableState(afterSample, { a: historyA, b: historyB }), baselineState,
      `${observation.id} complete snapshot after ${expected.caseId}`)
  }

  const disconnected = record(refusals.disconnected, `${observation.id} disconnected page`)
  const connC = integer(disconnected.connId, `${observation.id} disconnected connection`)
  if (connC === connA || connC === connB) throw new CliFilesFailure('connection-mismatch', `${observation.id} third connection reused a live window ID`)
  equal(connC, integer(request.connC, `${observation.id} requested third connection`), `${observation.id} third connection identity`)
  if (disconnected.contextClosed !== true || disconnected.pageClosed !== true) {
    throw new CliFilesFailure('renderer-cleanup', `${observation.id} temporary renderer was not closed`)
  }
  const uiWindows = (receiptIdValue: unknown, label: string): number[] => {
    const receiptId = string(receiptIdValue, `${label} receipt ID`)
    assertReceiptLinked(observation, receiptId, label)
    const receipt = byId.get(receiptId)!
    if (receipt.command !== 'ui state' || receipt.argv[0] !== 'ui' || receipt.argv[1] !== 'state') {
      throw new CliFilesFailure('invalid-receipt', `${label} is not an owned ui state read`)
    }
    const result = successfulReceipt(byId, receiptId)
    return array(result.windows, `${label} windows`).map((entry) => integer(record(entry, label).connId, `${label} connection ID`))
  }
  const beforeCloseIds = uiWindows(disconnected.uiBeforeCloseReceiptId, `${observation.id} ui state with third page`)
  const afterCloseIds = uiWindows(disconnected.uiAfterCloseReceiptId, `${observation.id} ui state after third page close`)
  equal([...beforeCloseIds].sort((a, b) => a - b), [connA, connB, connC].sort((a, b) => a - b), `${observation.id} live third page enumeration`)
  equal([...afterCloseIds].sort((a, b) => a - b), [connA, connB].sort((a, b) => a - b), `${observation.id} disconnected page removal`)
  equal(disconnected.listedBeforeClose, beforeCloseIds.includes(connC), `${observation.id} third page was listed before closing`)
  equal(disconnected.listedWhenCommandsRan, afterCloseIds.includes(connC), `${observation.id} third page list at refusal time`)
  if (afterCloseIds.includes(connC)) throw new CliFilesFailure('renderer-disconnected', `${observation.id} third page remained listed when its stale ID was used`)
}
function assertReviewFocusWindowObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  const focusWindow = record(observation.evidence.focusWindow, `${observation.id} focus window evidence`)
  const worktreeId = string(focusWindow.worktreeId, `${observation.id} Review worktree`)
  const tabId = string(focusWindow.tabId, `${observation.id} Review tab`)
  const targetConnId = integer(request.targetConnectionId, `${observation.id} target connection`)
  equal(request.worktreeId, worktreeId, `${observation.id} request worktree`)
  equal(targetConnId, observation.before[0]!.connId, `${observation.id} command routes through cA`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} before`, false)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} after`)

  const baselineReceiptId = string(focusWindow.reviewWorkspaceReceiptId, `${observation.id} pre-existing Review workspace receipt`)
  assertReceiptLinked(observation, baselineReceiptId, `${observation.id} pre-existing Review tab`)
  const baselineReceipt = byId.get(baselineReceiptId)!
  if (baselineReceipt.command !== 'api call' || baselineReceipt.argv[2] !== 'quirky.terminal/workspace' ||
      argvFlag(baselineReceipt.argv, '--workspace', `${observation.id} Review workspace`) !== worktreeId) {
    throw new CliFilesFailure('invalid-receipt', `${observation.id} Review baseline is not a public workspace read`)
  }
  const baselineWorkspace = successfulReceipt(byId, baselineReceiptId)
  const key = reviewKey(worktreeId)
  const baselineReviewTabs = reviewTabFor(baselineWorkspace, key)
  if (baselineReviewTabs.length !== 1 || baselineReviewTabs[0]!.id !== tabId) {
    throw new CliFilesFailure('review-tab-mismatch', `${observation.id} Review baseline does not contain exactly tab ${tabId}`)
  }
  const sentinelTab = selectedTabId(baselineWorkspace)
  if (!sentinelTab || sentinelTab === tabId) throw new CliFilesFailure('selection-mismatch', `${observation.id} Review baseline sentinel is not active`)

  const step = (value: unknown, label: string, commandId: string, commandArgs: JsonObject, openChanges: boolean): void => {
    const evidence = record(value, label)
    const before = record(evidence.before, `${label} before`) as unknown as CapturedSample
    const after = record(evidence.after, `${label} after`) as unknown as CapturedSample
    assertSample(before.snapshots, before.public, before.dom, byId, observation, `${label} before`, false)
    assertSample(after.snapshots, after.public, after.dom, byId, observation, `${label} after`)
    const receiptId = string(evidence.receiptId, `${label} command receipt`)
    equal(receiptId, commandId, `${label} command identity`)
    const receipt = byId.get(receiptId)!
    if (receipt.command !== 'api call' || receipt.argv[2] !== 'ui.window.command.run' || receipt.exitCode !== 0) {
      throw new CliFilesFailure('invalid-receipt', `${label} did not use a successful exact-window command`)
    }
    assertReceiptLinked(observation, receiptId, `${label} command`)
    equal(Number(argvFlag(receipt.argv, '--conn-id', label)), targetConnId, `${label} routed connection`)
    const expectedCommand = openChanges ? 'command:quirky.git/open-changes' : 'command:quirky.git/open-diff'
    equal(argvFlag(receipt.argv, '--id', label), expectedCommand, `${label} command ID`)
    equal(JSON.parse(argvFlag(receipt.argv, '--args', label)), commandArgs, `${label} command args`)
    assertFirstWindowLayoutReceipt(observation, byId, receiptId, targetConnId, after.public[0]!, `${label} first public read`)
    const replyEnvelope = successfulReceipt(byId, receiptId)
    const reply = record(replyEnvelope.result, `${label} structured result`)
    if (openChanges) {
      equal(reply.worktree, worktreeId, `${label} worktree`)
      equal(reply.mode, 'diff', `${label} mode`)
      equal(reply.source, null, `${label} source`)
      equal(reply.focused, true, `${label} focused result`)
      equal(reply.statusComplete, true, `${label} status completeness`)
      equal(array(reply.opened, `${label} opened files`), [], `${label} opened files`)
      equal(array(reply.skipped, `${label} skipped files`), [], `${label} skipped files`)
      const review = record(reply.review, `${label} nested Review result`)
      equal(review.worktree, worktreeId, `${label} nested worktree`)
      equal(review.tabId, tabId, `${label} nested Review tab`)
      equal(review.created, false, `${label} nested Review reuse`)
      equal(review.focused, true, `${label} nested Review focus`)
      equal(review.source, null, `${label} nested source`)
      equal(review.reveal, null, `${label} nested reveal`)
      equal(review.statusComplete, null, `${label} nested status completeness`)
    } else {
      equal(reply.worktree, worktreeId, `${label} worktree`)
      equal(reply.tabId, tabId, `${label} Review tab`)
      equal(reply.created, false, `${label} Review reuse`)
      equal(reply.focused, true, `${label} Review focus`)
      equal(reply.source, null, `${label} Review source`)
      equal(reply.reveal, A_TARGET, `${label} Review reveal`)
      equal(reply.statusComplete, null, `${label} Review status completeness`)
    }
    const layout = record(after.public[0]!.windowState.layout, `${label} cA layout`)
    equal(layout.worktree, worktreeId, `${label} cA worktree`)
    const review = reviewTabFor(after.public[0]!.workspace, key)
    if (review.length !== 1 || review[0]!.id !== tabId) {
      throw new CliFilesFailure('review-tab-mismatch', `${label} cA does not render the pre-existing Review tab`)
    }
    equal(after.public[0]!.workspace && selectedTabId(after.public[0]!.workspace), tabId, `${label} active Review tab`)
    equal(after.dom[0]!.renderedTabId, tabId, `${label} rendered Review tab`)
    equal(after.dom[0]!.reviewTabMounted, true, `${label} mounted Review`)
    if (!openChanges) {
      const card = after.dom[0]!.reviewCards.find((entry) => entry.path === A_TARGET)
      if (!card) throw new CliFilesFailure('review-reveal-mismatch', `${label} has no ${A_TARGET} card`)
      equal(card.active, true, `${label} active card`)
      equal(card.expanded, true, `${label} expanded card`)
      equal(card.loaded, true, `${label} loaded card`)
      includesText(card.text, B_CONTENT, `${label} source text`)
    }
    equal(after.public[1]!.windowState.layout, before.public[1]!.windowState.layout, `${label} cB layout unchanged`)
    equal(after.dom[1], before.dom[1], `${label} cB DOM unchanged`)
    const historyBefore = record(evidence.historyBefore, `${label} histories before`)
    const historyAfter = record(evidence.historyAfter, `${label} histories after`)
    const targetHistory = assertNavigationHistoryTransition(
      observation, byId, historyBefore.target, historyAfter.target, targetConnId, worktreeId, label
    )
    const otherBefore = readNavigationHistory(historyBefore.other, byId, observation, `${label} cB history before`)
    const otherAfter = readNavigationHistory(historyAfter.other, byId, observation, `${label} cB history after`)
    equal(targetHistory.before.shownWorktree, string(record(before.public[0]!.windowState.layout, `${label} cA before layout`).worktree, `${label} shown before`), `${label} history baseline layout`)
    equal(otherAfter.result, otherBefore.result, `${label} cB history unchanged`)
  }

  const diffReceiptId = string(focusWindow.openDiffReceiptId, `${observation.id} open-diff receipt`)
  step(focusWindow.diff, `${observation.id} open-diff focus`, diffReceiptId, { worktree: worktreeId, path: A_TARGET }, false)
  const changesReceiptId = string(focusWindow.openChangesReceiptId, `${observation.id} open-changes receipt`)
  step(focusWindow.changes, `${observation.id} open-changes focus`, changesReceiptId, { worktree: worktreeId }, true)
}
function assertReviewBackgroundObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const evidence = record(observation.evidence.backgroundReview, `${observation.id} background Review evidence`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} top-level before`)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} top-level after`)
  const worktreeId = string(evidence.worktreeId, `${observation.id} Review worktree`)
  const tabId = string(evidence.tabId, `${observation.id} Review tab`)
  const sentinelTabId = string(evidence.sentinelTabId, `${observation.id} sentinel tab`)
  const beforePublic = observation.evidence.public.before
  const beforeDom = observation.evidence.dom.before
  assertSample(observation.before, beforePublic, beforeDom, byId, observation, `${observation.id} initial`, true)
  const connA = beforePublic[0]!.connId
  const connB = beforePublic[1]!.connId
  const worktreeA = shownWorktree(beforePublic[0]!)
  equal(shownWorktree(beforePublic[1]!), worktreeId, `${observation.id} cB shows B`)
  const key = reviewKey(worktreeId)
  const historyPair = (value: unknown, label: string) => {
    const histories = record(value, label)
    return {
      a: readNavigationHistory(histories.a, byId, observation, `${label} cA`),
      b: readNavigationHistory(histories.b, byId, observation, `${label} cB`)
    }
  }
  const assertHistoryStable = (beforeValue: unknown, afterValue: unknown, label: string) => {
    const before = historyPair(beforeValue, `${label} history before`)
    const after = historyPair(afterValue, `${label} history after`)
    equal(after.a.result, before.a.result, `${label} cA history unchanged`)
    equal(after.b.result, before.b.result, `${label} cB history unchanged`)
  }

  const cold = record(evidence.cold, `${observation.id} cold Review step`)
  const coldBefore = record(cold.before, `${observation.id} cold before`) as unknown as CapturedSample
  const coldAfter = record(cold.after, `${observation.id} cold after`) as unknown as CapturedSample & { activeTab: string }
  const coldActivated = record(cold.activated, `${observation.id} cold activation`) as unknown as CapturedSample
  assertSample(coldBefore.snapshots, coldBefore.public, coldBefore.dom, byId, observation, `${observation.id} cold before`)
  assertSample(coldAfter.snapshots, coldAfter.public, coldAfter.dom, byId, observation, `${observation.id} cold after`)
  assertSample(coldActivated.snapshots, coldActivated.public, coldActivated.dom, byId, observation, `${observation.id} cold activation`)
  equal(reviewTabFor(coldBefore.public[1]!.workspace, key), [], `${observation.id} cold baseline has no Review`)
  const coldReceiptId = string(evidence.coldReceiptId, `${observation.id} cold command receipt`)
  const coldReceipt = byId.get(coldReceiptId)!
  assertReceiptLinked(observation, coldReceiptId, `${observation.id} cold open-diff`)
  if (coldReceipt.command !== 'api call' || coldReceipt.argv[2] !== 'ui.window.command.run' || coldReceipt.exitCode !== 0) {
    throw new CliFilesFailure('invalid-receipt', `${observation.id} cold Review command is not an exact-window call`)
  }
  equal(Number(argvFlag(coldReceipt.argv, '--conn-id', `${observation.id} cold command`)), connA, `${observation.id} cold command window`)
  equal(argvFlag(coldReceipt.argv, '--id', `${observation.id} cold command`), 'command:quirky.git/open-diff', `${observation.id} cold command ID`)
  const coldArgs = JSON.parse(argvFlag(coldReceipt.argv, '--args', `${observation.id} cold command`)) as JsonObject
  equal(coldArgs, { worktree: worktreeId, path: A_TARGET, focus: false }, `${observation.id} cold command args`)
  const coldEnvelope = successfulReceipt(byId, coldReceiptId)
  const coldResult = record(coldEnvelope.result, `${observation.id} cold Review result`)
  equal(coldResult.worktree, worktreeId, `${observation.id} cold worktree`)
  equal(coldResult.tabId, tabId, `${observation.id} cold tab`)
  equal(coldResult.created, true, `${observation.id} cold tab creation`)
  equal(coldResult.focused, false, `${observation.id} cold background focus`)
  equal(coldResult.source, null, `${observation.id} cold source`)
  equal(coldResult.reveal, A_TARGET, `${observation.id} cold reveal`)
  equal(coldResult.statusComplete, null, `${observation.id} cold status completeness`)
  assertFirstWindowLayoutReceipt(observation, byId, coldReceiptId, connA, coldAfter.public[0]!, `${observation.id} cold first read`)
  const coldTab = reviewTabFor(coldAfter.public[1]!.workspace, key)
  if (coldTab.length !== 1 || coldTab[0]!.id !== tabId) {
    throw new CliFilesFailure('review-tab-mismatch', `${observation.id} cold open did not create exactly one Review tab`)
  }
  const coldInput = record(coldTab[0]!.input, `${observation.id} cold Review input`)
  equal(coldInput.mode, 'review', `${observation.id} cold stored mode`)
  equal(coldInput.worktree, worktreeId, `${observation.id} cold stored worktree`)
  equal(coldInput.reveal, A_TARGET, `${observation.id} cold stored reveal`)
  equal(coldAfter.activeTab, selectedTabId(coldAfter.public[1]!.workspace), `${observation.id} cold B active tab readback`)
  equal(coldAfter.activeTab, sentinelTabId, `${observation.id} cold leaves sentinel selected`)
  equal(coldAfter.public[0]!.windowState.layout, coldBefore.public[0]!.windowState.layout, `${observation.id} cold cA layout unchanged`)
  equal(coldAfter.public[1]!.windowState.layout, coldBefore.public[1]!.windowState.layout, `${observation.id} cold cB layout unchanged`)
  if (coldAfter.dom.some((dom) => dom.reviewTabMounted)) throw new CliFilesFailure('review-mount-mismatch', `${observation.id} cold background open mounted Review early`)
  equal(coldAfter.dom, coldBefore.dom, `${observation.id} cold background DOM unchanged`)
  assertHistoryStable(cold.historyBefore, cold.historyAfter, `${observation.id} cold background`)
  const coldActivateReceiptId = `${observation.id}-activate-cold`
  const coldActivateReceipt = byId.get(coldActivateReceiptId)
  if (!coldActivateReceipt) throw new CliFilesFailure('missing-receipt', `${observation.id} cold Review activation receipt is missing`)
  assertReceiptLinked(observation, coldActivateReceiptId, `${observation.id} cold activation`)
  equal(coldActivateReceipt.command, 'terminal tab', `${observation.id} terminal activation command`)
  equal(coldActivateReceipt.argv.slice(0, 4), ['terminal', 'tab', 'activate', tabId], `${observation.id} cold activation argv`)
  const coldActiveDom = coldActivated.dom[1]!
  equal(coldActiveDom.renderedTabId, tabId, `${observation.id} cold Review rendered after activation`)
  equal(coldActiveDom.reviewTabMounted, true, `${observation.id} cold Review mounted after activation`)
  const coldCard = coldActiveDom.reviewCards.find((card) => card.path === A_TARGET)
  if (!coldCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} activated Review has no ${A_TARGET} card`)
  equal(coldCard.active, true, `${observation.id} activated cold reveal`)
  equal(coldCard.expanded, true, `${observation.id} activated cold expansion`)
  equal(coldCard.loaded, true, `${observation.id} activated cold content`)
  includesText(coldCard.text, 'second λ', `${observation.id} activated cold text`)

  const mounted = record(evidence.mounted, `${observation.id} mounted Review step`)
  const mountedBefore = record(mounted.before, `${observation.id} mounted before`) as unknown as CapturedSample
  const mountedAfter = record(mounted.after, `${observation.id} mounted after`) as unknown as CapturedSample
  const mountedAfterShow = record(mounted.afterShow, `${observation.id} mounted reshow`) as unknown as CapturedSample
  assertSample(mountedBefore.snapshots, mountedBefore.public, mountedBefore.dom, byId, observation, `${observation.id} mounted before`)
  assertSample(mountedAfter.snapshots, mountedAfter.public, mountedAfter.dom, byId, observation, `${observation.id} mounted after`)
  assertSample(mountedAfterShow.snapshots, mountedAfterShow.public, mountedAfterShow.dom, byId, observation, `${observation.id} Review reshow`)
  const mountedReceiptId = string(evidence.mountedReceiptId, `${observation.id} mounted command receipt`)
  const mountedReceipt = byId.get(mountedReceiptId)!
  assertReceiptLinked(observation, mountedReceiptId, `${observation.id} mounted open-diff`)
  if (mountedReceipt.command !== 'api call' || mountedReceipt.argv[2] !== 'ui.window.command.run' || mountedReceipt.exitCode !== 0) {
    throw new CliFilesFailure('invalid-receipt', `${observation.id} mounted Review command is not an exact-window call`)
  }
  equal(Number(argvFlag(mountedReceipt.argv, '--conn-id', `${observation.id} mounted command`)), connB, `${observation.id} mounted command window`)
  equal(argvFlag(mountedReceipt.argv, '--id', `${observation.id} mounted command`), 'command:quirky.git/open-diff', `${observation.id} mounted command ID`)
  equal(JSON.parse(argvFlag(mountedReceipt.argv, '--args', `${observation.id} mounted command`)),
    { worktree: worktreeId, path: SENTINEL_PATH, focus: false }, `${observation.id} mounted command args`)
  const mountedResult = record(successfulReceipt(byId, mountedReceiptId).result, `${observation.id} mounted Review result`)
  equal(mountedResult.worktree, worktreeId, `${observation.id} mounted worktree`)
  equal(mountedResult.tabId, tabId, `${observation.id} mounted tab`)
  equal(mountedResult.created, false, `${observation.id} mounted tab reuse`)
  equal(mountedResult.focused, false, `${observation.id} mounted background focus`)
  equal(mountedResult.reveal, SENTINEL_PATH, `${observation.id} mounted deferred reveal`)
  const beforeTab = tabById(mountedBefore.public[1]!.workspace, tabId)
  const afterTab = tabById(mountedAfter.public[1]!.workspace, tabId)
  if (!beforeTab || !afterTab) throw new CliFilesFailure('review-tab-mismatch', `${observation.id} mounted Review tab is missing`)
  const inputBefore = record(mounted.inputBefore, `${observation.id} mounted stored input before`)
  const inputAfter = record(mounted.inputAfter, `${observation.id} mounted stored input after`)
  equal(inputBefore, beforeTab.input, `${observation.id} mounted independent stored input`)
  equal(inputAfter, afterTab.input, `${observation.id} mounted stored input after`)
  equal(inputAfter, inputBefore, `${observation.id} background request leaves stored input unchanged`)
  const mountedCard = mountedAfter.dom[1]!.reviewCards.find((card) => card.path === A_TARGET)
  if (!mountedCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} mounted Review lost its active card`)
  equal(mountedCard.active, true, `${observation.id} mounted active card`)
  const deferredCard = mountedAfter.dom[1]!.reviewCards.find((card) => card.path === SENTINEL_PATH)
  if (!deferredCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} mounted DOM is missing the deferred card`)
  equal(deferredCard.active, false, `${observation.id} mounted deferred card stays inactive`)
  const scrollBefore = mountedBefore.dom[1]!.reviewScrollTop
  const scrollAfter = mountedAfter.dom[1]!.reviewScrollTop
  if (typeof mounted.scrollTopBefore !== 'number' || typeof mounted.scrollTopAfter !== 'number') {
    throw new CliFilesFailure('invalid-evidence', `${observation.id} scroll measurements are not numbers`)
  }
  const recordedScrollBefore = mounted.scrollTopBefore
  const recordedScrollAfter = mounted.scrollTopAfter
  if (typeof scrollBefore !== 'number' || typeof scrollAfter !== 'number') {
    throw new CliFilesFailure('missing-observation', `${observation.id} did not capture the live Review scroll position`)
  }
  equal(scrollBefore, recordedScrollBefore, `${observation.id} live initial scroll readback`)
  equal(scrollAfter, recordedScrollAfter, `${observation.id} live resulting scroll readback`)
  equal(scrollBefore, scrollAfter, `${observation.id} background reveal preserves scroll`)
  equal(mountedBefore.public.map((window) => window.windowState.layout), mountedAfter.public.map((window) => window.windowState.layout), `${observation.id} mounted layouts unchanged`)
  equal(mountedBefore.dom, mountedAfter.dom, `${observation.id} mounted DOM unchanged`)
  assertHistoryStable(mounted.historyBefore, mounted.historyAfter, `${observation.id} mounted background`)
  const hidden = record(mounted.hidden, `${observation.id} hidden Review`) as unknown as CapturedSample
  assertSample(hidden.snapshots, hidden.public, hidden.dom, byId, observation, `${observation.id} hidden Review`)
  equal(hidden.dom[1]!.reviewTabMounted, false, `${observation.id} Review detaches before reshow`)
  equal(hidden.dom[1]!.renderedTabId, sentinelTabId, `${observation.id} sentinel renders before reshow`)
  for (const [suffix, expectedTab] of [['activate-sentinel', sentinelTabId], ['activate-review', tabId]] as const) {
    const receiptId = `${observation.id}-${suffix}`
    assertReceiptLinked(observation, receiptId, `${observation.id} ${suffix}`)
    const receipt = byId.get(receiptId)!
    equal(receipt.argv.slice(0, 4), ['terminal', 'tab', 'activate', expectedTab], `${observation.id} ${suffix} argv`)
    equal(receipt.exitCode, 0, `${observation.id} ${suffix} success`)
  }
  const reshownTab = tabById(mountedAfterShow.public[1]!.workspace, tabId)
  if (!reshownTab) throw new CliFilesFailure('review-tab-mismatch', `${observation.id} reshow lost Review`)
  equal(reshownTab.input, inputBefore, `${observation.id} reshow preserves stored input`)
  const afterShowDom = mountedAfterShow.dom[1]!
  equal(afterShowDom.renderedTabId, tabId, `${observation.id} Review rendered on reshow`)
  equal(afterShowDom.reviewTabMounted, true, `${observation.id} Review mounted on reshow`)
  const afterShowCard = afterShowDom.reviewCards.find((card) => card.path === SENTINEL_PATH)
  if (!afterShowCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} reshow has no deferred card`)
  equal(afterShowCard.active, true, `${observation.id} deferred card activated on reshow`)
  equal(afterShowCard.expanded, true, `${observation.id} deferred card expanded`)
  equal(afterShowCard.loaded, true, `${observation.id} deferred card loaded`)
  equal(afterShowDom.reviewCards.filter((card) => card.active).map((card) => card.path),
    [SENTINEL_PATH], `${observation.id} only the deferred card is active`)
}
function assertSourceGitRead(value: unknown, root: string, ref: string, expected: string, label: string): void {
  const read = record(value, label)
  equal(read.executable, '/usr/bin/git', `${label} executable`)
  equal(read.argv, ['/usr/bin/git', 'show', ref], `${label} exact argv`)
  equal(read.cwd, root, `${label} worktree cwd`)
  equal(read.exitCode, 0, `${label} Git exit`)
  const stdout = string(read.stdout, `${label} raw stdout`)
  equal(stdout, expected, `${label} exact bytes`)
  equal(integer(read.stdoutBytes, `${label} stdout byte count`), Buffer.byteLength(stdout), `${label} byte count`)
  equal(Number(read.elapsedMs) >= 0, true, `${label} measured duration`)
}

function assertSourceWorkingRead(value: unknown, absolutePath: string, expected: string, label: string): void {
  const read = record(value, label)
  equal(read.path, absolutePath, `${label} absolute path`)
  const bytesBase64 = string(read.bytesBase64, `${label} bytes`)
  const bytes = Buffer.from(bytesBase64, 'base64')
  equal(bytes.toString('base64'), bytesBase64, `${label} canonical base64`)
  equal(bytes.toString('utf8'), expected, `${label} exact file bytes`)
  equal(bytes.toString('hex'), Buffer.from(expected, 'utf8').toString('hex'), `${label} byte equality`)
}

function assertReviewSourceObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} top-level before`, false)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} top-level after`)
  const source = record(observation.evidence.sourceReview, `${observation.id} source evidence`)
  const worktreeA = string(observation.before[1]!.windowWorktree, `${observation.id} non-target worktree`)
  const worktreeId = string(source.worktreeId, `${observation.id} source worktree`)
  const tabId = string(source.tabId, `${observation.id} source Review tab`)
  const targetConnId = integer(request.targetConnectionId, `${observation.id} target connection`)
  equal(request.worktreeId, worktreeId, `${observation.id} requested worktree`)
  const readme = record(source.readme, `${observation.id} README versions`)
  const status = record(source.status, `${observation.id} status path sets`)
  const scopes = record(source.scopes, `${observation.id} source scopes`)
  const stagedPaths = array(status.stagedPaths, `${observation.id} staged paths`).map((path) => string(path, 'staged path')).sort()
  const unstagedPaths = array(status.unstagedPaths, `${observation.id} unstaged paths`).map((path) => string(path, 'unstaged path')).sort()
  const wholePaths = array(status.wholePaths, `${observation.id} whole-review paths`).map((path) => string(path, 'whole-review path')).sort()
  const expectedStaged = ['README.md', SENTINEL_PATH].sort()
  const expectedUnstaged = ['README.md', A_TARGET].sort()
  const expectedWhole = ['README.md', SENTINEL_PATH, A_TARGET].sort()
  equal(stagedPaths, expectedStaged, `${observation.id} expected staged paths`)
  equal(unstagedPaths, expectedUnstaged, `${observation.id} expected unstaged paths`)
  equal(wholePaths, expectedWhole, `${observation.id} expected whole-review paths`)
  const base = string(readme.base, `${observation.id} README HEAD bytes`)
  const index = string(readme.index, `${observation.id} README index bytes`)
  const working = string(readme.working, `${observation.id} README working bytes`)
  if (new Set([base, index, working]).size !== 3 || readme.distinct !== true) {
    throw new CliFilesFailure('fixture-bytes', `${observation.id} README fixture versions are not pairwise distinct`)
  }
  const written = record(readme.written, `${observation.id} README written bytes`)
  const readback = record(readme.readback, `${observation.id} README readback bytes`)
  equal(written, { base, index, working }, `${observation.id} written README versions`)
  equal(readback, { base, index, working }, `${observation.id} read-back README versions`)
  const beforeStatusId = string(status.beforeReceiptId, `${observation.id} pre-scope status receipt`)
  const afterStatusId = string(status.afterReceiptId, `${observation.id} post-scope status receipt`)
  for (const [phase, receiptId] of [['before', beforeStatusId], ['after', afterStatusId]] as const) {
    assertReceiptLinked(observation, receiptId, `${observation.id} ${phase} status`)
    const receipt = byId.get(receiptId)!
    if (receipt.command !== 'api call' || receipt.argv[2] !== 'quirky.git/status' ||
        argvFlag(receipt.argv, '--worktree', `${observation.id} ${phase} status`) !== worktreeId) {
      throw new CliFilesFailure('invalid-receipt', `${observation.id} ${phase} status is not a public worktree status read`)
    }
    const result = successfulReceipt(byId, receiptId)
    const entries = array(record(result, `${observation.id} ${phase} status`).entries, `${observation.id} ${phase} status entries`)
      .map((entry) => record(entry, `${observation.id} ${phase} status entry`))
    const staged = entries.filter((entry) => entry.area === 'staged').map((entry) => string(entry.path, 'staged status path')).sort()
    const unstaged = entries.filter((entry) => entry.area === 'unstaged' || entry.area === 'untracked')
      .map((entry) => string(entry.path, 'unstaged status path')).sort()
    equal(staged, stagedPaths, `${observation.id} ${phase} public staged status`)
    equal(unstaged, unstagedPaths, `${observation.id} ${phase} public unstaged status`)
    const docsEntries = entries.filter((entry) => entry.path === SENTINEL_PATH)
    equal(docsEntries.length, 1, `${observation.id} docs status count`)
    equal(docsEntries[0]!.area, 'staged', `${observation.id} docs staged status`)
    const readmeEntries = entries.filter((entry) => entry.path === 'README.md')
    equal(readmeEntries.map((entry) => entry.area).sort(), ['staged', 'unstaged'], `${observation.id} partial README status`)
    if (!entries.some((entry) => entry.path === A_TARGET && (entry.area === 'unstaged' || entry.area === 'untracked'))) {
      throw new CliFilesFailure('fixture-status', `${observation.id} app source is not unstaged or untracked`)
    }
  }

  const stagedScope = record(scopes.staged, `${observation.id} staged scope`)
  const stagedAfter = record(stagedScope.after, `${observation.id} staged after`) as unknown as CapturedSample
  const bBuffers = array(stagedAfter.public[0]!.editor.buffers, `${observation.id} B buffers`).map((entry) => record(entry, `${observation.id} B buffer`))
  const bBuffer = bBuffers.find((buffer) => buffer.worktreeId === worktreeId)
  if (!bBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} B editor root is unavailable`)
  const root = string(bBuffer.root, `${observation.id} B root`)
  const readmePath = string(readme.absolutePath, `${observation.id} README absolute path`)
  equal(readmePath, expectedAbsolute(root, 'README.md'), `${observation.id} exact B README path`)
  const readmeGitReads = record(readme.gitReads, `${observation.id} README Git reads`)
  assertSourceGitRead(readmeGitReads.base, root, 'HEAD:README.md', base, `${observation.id} README HEAD`)
  assertSourceGitRead(readmeGitReads.index, root, ':README.md', index, `${observation.id} README index`)
  assertSourceWorkingRead(readme.workingRead, readmePath, working, `${observation.id} README working read`)
  const docs = record(source.docs, `${observation.id} docs versions`)
  const docsBase = string(docs.base, `${observation.id} docs HEAD bytes`)
  const docsIndex = string(docs.index, `${observation.id} docs index bytes`)
  const docsWorking = string(docs.working, `${observation.id} docs working bytes`)
  if (docsIndex !== docsWorking || docsBase === docsIndex) {
    throw new CliFilesFailure('fixture-bytes', `${observation.id} staged docs versions are inconsistent`)
  }
  const docsPath = string(docs.absolutePath, `${observation.id} docs absolute path`)
  equal(docsPath, expectedAbsolute(root, SENTINEL_PATH), `${observation.id} exact B docs path`)
  const docsReads = record(docs.gitReads, `${observation.id} docs Git reads`)
  assertSourceGitRead(docsReads.base, root, `HEAD:${SENTINEL_PATH}`, docsBase, `${observation.id} docs HEAD`)
  assertSourceGitRead(docsReads.index, root, `:${SENTINEL_PATH}`, docsIndex, `${observation.id} docs index`)
  assertSourceWorkingRead(docs.workingRead, docsPath, docsWorking, `${observation.id} docs working read`)
  const appWorking = record(source.appWorking, `${observation.id} app working bytes`)
  const appPath = string(appWorking.path, `${observation.id} app absolute path`)
  equal(appPath, expectedAbsolute(root, A_TARGET), `${observation.id} exact B app path`)
  assertSourceWorkingRead(appWorking, appPath, B_CONTENT, `${observation.id} app working read`)

  const expectedSource: Record<'staged' | 'unstaged' | 'whole', string | null> = {
    staged: 'staged', unstaged: 'unstaged', whole: null
  }
  const expectedPaths: Record<'staged' | 'unstaged' | 'whole', string[]> = {
    staged: stagedPaths, unstaged: unstagedPaths, whole: wholePaths
  }
  for (const name of ['staged', 'unstaged', 'whole'] as const) {
    const scope = record(scopes[name], `${observation.id} ${name} scope`)
    const before = record(scope.before, `${observation.id} ${name} before`) as unknown as CapturedSample
    const after = record(scope.after, `${observation.id} ${name} after`) as unknown as CapturedSample
    const beforeDistinct = before.snapshots[0]!.workspaceId !== before.snapshots[1]!.workspaceId
    assertSample(before.snapshots, before.public, before.dom, byId, observation, `${observation.id} ${name} before`, beforeDistinct)
    assertSample(after.snapshots, after.public, after.dom, byId, observation, `${observation.id} ${name} after`)
    const receiptId = string(scope.receiptId, `${observation.id} ${name} command receipt`)
    const receipt = byId.get(receiptId)!
    assertReceiptLinked(observation, receiptId, `${observation.id} ${name} scope command`)
    if (receipt.command !== 'api call' || receipt.argv[2] !== 'ui.window.command.run' || receipt.exitCode !== 0 ||
        Number(argvFlag(receipt.argv, '--conn-id', `${observation.id} ${name}`)) !== after.public[0]!.connId) {
      throw new CliFilesFailure('invalid-receipt', `${observation.id} ${name} scope was not opened in exact window cA`)
    }
    const commandId = name === 'staged' ? 'command:quirky.git/open-diff' : 'command:quirky.git/open-changes'
    equal(argvFlag(receipt.argv, '--id', `${observation.id} ${name}`), commandId, `${observation.id} ${name} command ID`)
    const args = JSON.parse(argvFlag(receipt.argv, '--args', `${observation.id} ${name}`)) as JsonObject
    if (name === 'staged') {
      equal(args, { worktree: worktreeId, path: SENTINEL_PATH, source: 'staged' }, `${observation.id} staged command args`)
    } else if (name === 'unstaged') {
      equal(args, { worktree: worktreeId, area: 'unstaged' }, `${observation.id} unstaged command args`)
    } else {
      equal(args, { worktree: worktreeId }, `${observation.id} whole-review command args`)
    }
    const outer = record(successfulReceipt(byId, receiptId).result, `${observation.id} ${name} command result`)
    if (name === 'staged') {
      equal(outer.worktree, worktreeId, `${observation.id} staged reply worktree`)
      equal(outer.tabId, tabId, `${observation.id} staged reply tab`)
      equal(outer.created, true, `${observation.id} staged reply creates tab`)
      equal(outer.focused, true, `${observation.id} staged reply focuses`)
      equal(outer.source, 'staged', `${observation.id} staged reply source`)
      equal(outer.reveal, SENTINEL_PATH, `${observation.id} staged reply reveal`)
      equal(outer.statusComplete, true, `${observation.id} staged reply completeness`)
    } else {
      equal(outer.worktree, worktreeId, `${observation.id} ${name} reply worktree`)
      equal(outer.mode, 'diff', `${observation.id} ${name} reply mode`)
      equal(outer.source, expectedSource[name], `${observation.id} ${name} reply source`)
      equal(outer.focused, true, `${observation.id} ${name} reply focus`)
      equal(outer.statusComplete, true, `${observation.id} ${name} status completeness`)
      equal(array(outer.opened, `${observation.id} ${name} opened`), [], `${observation.id} ${name} editor results`)
      equal(array(outer.skipped, `${observation.id} ${name} skipped`), [], `${observation.id} ${name} skipped results`)
      const review = record(outer.review, `${observation.id} ${name} nested Review`)
      equal(review.worktree, worktreeId, `${observation.id} ${name} nested worktree`)
      equal(review.tabId, tabId, `${observation.id} ${name} nested tab`)
      equal(review.created, false, `${observation.id} ${name} nested tab reuse`)
      equal(review.focused, true, `${observation.id} ${name} nested focus`)
      equal(review.source, expectedSource[name], `${observation.id} ${name} nested source`)
      equal(review.reveal, null, `${observation.id} ${name} nested reveal`)
      equal(review.statusComplete, expectedSource[name] === null ? null : true, `${observation.id} ${name} nested status`)
    }
    assertFirstWindowLayoutReceipt(observation, byId, receiptId, after.public[0]!.connId, after.public[0]!, `${observation.id} ${name} first public read`)
    equal(shownWorktree(after.public[1]!), worktreeA, `${observation.id} ${name} cB worktree remains A`)
    equal(after.dom[1], before.dom[1], `${observation.id} ${name} cB DOM unchanged`)
    const historiesBefore = record(scope.historyBefore, `${observation.id} ${name} histories before`)
    const historiesAfter = record(scope.historyAfter, `${observation.id} ${name} histories after`)
    const targetHistory = assertNavigationHistoryTransition(
      observation, byId, historiesBefore, historiesAfter, after.public[0]!.connId, worktreeId, `${observation.id} ${name}`
    )
    equal(targetHistory.before.shownWorktree, before.snapshots[0]!.windowWorktree, `${observation.id} ${name} history/window baseline`)
    const otherBefore = readNavigationHistory(scope.otherHistoryBefore, byId, observation, `${observation.id} ${name} cB history before`)
    const otherAfter = readNavigationHistory(scope.otherHistoryAfter, byId, observation, `${observation.id} ${name} cB history after`)
    equal(otherAfter.result, otherBefore.result, `${observation.id} ${name} cB history unchanged`)
    const baselineOtherLayout = before.public[1]!.windowState.layout
    const baselineOtherDom = before.dom[1]!
    const assertOtherWindow = (value: unknown, label: string): void => {
      const point = record(value, label)
      const connId = integer(point.connId, `${label} connection`)
      equal(connId, before.public[1]!.connId, `${label} target window`)
      const receiptId = string(point.receiptId, `${label} layout receipt`)
      assertReceiptLinked(observation, receiptId, label)
      const receipt = byId.get(receiptId)!
      if (receipt.command !== 'api call' || receipt.argv[2] !== 'ui.window.state' ||
          Number(argvFlag(receipt.argv, '--conn-id', label)) !== connId) {
        throw new CliFilesFailure('invalid-receipt', `${label} is not an exact-window state read`)
      }
      const state = successfulReceipt(byId, receiptId)
      equal(state, point.windowState, `${label} independent layout readback`)
      equal(state.connId, connId, `${label} returned window`)
      equal(state.layout, baselineOtherLayout, `${label} original layout unchanged`)
      equal(point.dom, baselineOtherDom, `${label} original DOM unchanged`)
      const history = readNavigationHistory(point.history, byId, observation, `${label} history`)
      equal(history.connId, connId, `${label} history window`)
      equal(history.result, otherBefore.result, `${label} original history unchanged`)
    }

    const key = reviewKey(worktreeId)
    const matching = reviewTabFor(after.public[0]!.workspace, key)
    if (matching.length !== 1 || matching[0]!.id !== tabId) {
      throw new CliFilesFailure('review-tab-mismatch', `${observation.id} ${name} does not reuse one Review tab`)
    }
    const allReviewTabs = tabsInWorkspace(after.public[0]!.workspace).filter((tab) => tab.viewId === REVIEW_VIEW_ID)
    equal(allReviewTabs.length, 1, `${observation.id} ${name} one combined Review tab`)
    equal(scope.tabCount, 1, `${observation.id} ${name} reported Review tab count`)
    const input = record(matching[0]!.input, `${observation.id} ${name} Review input`)
    equal(input.mode, 'review', `${observation.id} ${name} Review mode`)
    equal(input.worktree, worktreeId, `${observation.id} ${name} Review worktree`)
    if (expectedSource[name] === null) {
      if (input.source !== undefined) throw new CliFilesFailure('source-mismatch', `${observation.id} whole review retained a source scope`)
    } else equal(input.source, expectedSource[name], `${observation.id} ${name} stored source scope`)
    equal(scope.cardPaths, expectedPaths[name], `${observation.id} ${name} evidence card paths`)
    const dom = array(scope.dom, `${observation.id} ${name} final DOM`).map((entry) => record(entry, `${observation.id} ${name} DOM`) as unknown as CliFileDomWindow)
    if (dom.length !== 2) throw new CliFilesFailure('missing-observation', `${observation.id} ${name} final DOM omits a window`)
    equal(dom[1], baselineOtherDom, `${observation.id} ${name} final cB DOM unchanged`)
    assertOtherWindow(scope.finalOther, `${observation.id} ${name} final cB readback`)
    const targetDom = dom[0]!
    equal(targetDom.workspaceId, worktreeId, `${observation.id} ${name} final DOM worktree`)
    equal(targetDom.reviewTabMounted, true, `${observation.id} ${name} Review mounted`)
    const width = targetDom.reviewWidth
    if (typeof width !== 'number' || width < 900) throw new CliFilesFailure('review-layout', `${observation.id} ${name} Review is not wide enough to show both diff sides`)
    equal(scope.chip, targetDom.reviewScopeChip ?? null, `${observation.id} ${name} scope chip readback`)
    const expectedChip = name === 'staged' ? 'Staged changes' : name === 'unstaged' ? 'Unstaged changes' : null
    equal(targetDom.reviewScopeChip ?? null, expectedChip, `${observation.id} ${name} scope chip`)
    const cards = targetDom.reviewCards
    const cardPaths = cards.map((card) => card.path).sort()
    equal(cardPaths, expectedPaths[name], `${observation.id} ${name} loaded DOM card set`)
    for (const card of cards) {
      equal(card.expanded, true, `${observation.id} ${name} ${card.path} expanded`)
      equal(card.loaded, true, `${observation.id} ${name} ${card.path} loaded`)
    }
    const readmeCardValue = cards.find((card) => card.path === 'README.md')
    if (!readmeCardValue) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} ${name} omitted README.md`)
    const readmeCard = record(readmeCardValue, `${observation.id} ${name} README card`)
    equal(readmeCard.mergeEditorCount, 2, `${observation.id} ${name} README side-by-side editor count`)
    const originalLines = array(readmeCard.originalLines, `${observation.id} ${name} README original side`).map(renderedLine)
    const modifiedLines = array(readmeCard.modifiedLines, `${observation.id} ${name} README modified side`).map(renderedLine)
    const expectedOriginal = name === 'unstaged' ? index : base
    const expectedModified = name === 'staged' ? index : working
    equal(originalLines, expectedOriginal.split('\n'), `${observation.id} ${name} README original bytes`)
    equal(modifiedLines, expectedModified.split('\n'), `${observation.id} ${name} README modified bytes`)
    if (name === 'staged') {
      equal(readmeCard.editable, false, `${observation.id} staged README readonly`)
      const docsCard = cards.find((card) => card.path === SENTINEL_PATH)
      if (!docsCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} staged scope omitted docs`)
      equal(docsCard.editable, false, `${observation.id} staged docs readonly`)
      equal(docsCard.hasReviewMark, false, `${observation.id} staged docs has no review mark`)
    }
    if (name === 'unstaged') {
      const appCard = cards.find((card) => card.path === A_TARGET)
      if (!appCard) throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} unstaged scope omitted app source`)
      const appModified = array(record(appCard, `${observation.id} app card`).modifiedLines, `${observation.id} app modified side`)
        .map(renderedLine)
      equal(appModified, B_CONTENT.split('\n'), `${observation.id} app source bytes`)
      equal(appCard.editable, true, `${observation.id} unstaged app source editable`)
    }
    const supporting = array(scope.supporting, `${observation.id} ${name} support receipts`)
    const supportCommands = new Set<string>()
    let foundReadmeReveal = false
    for (const [supportIndex, supportValue] of supporting.entries()) {
      const support = record(supportValue, `${observation.id} ${name} support ${supportIndex}`)
      const supportReceiptId = string(support.receiptId, `${observation.id} ${name} support receipt`)
      assertReceiptLinked(observation, supportReceiptId, `${observation.id} ${name} support`)
      const supportReceipt = byId.get(supportReceiptId)!
      if (supportReceipt.exitCode !== 0 || supportReceipt.command !== 'api call' || supportReceipt.argv[2] !== 'ui.window.command.run' ||
          Number(argvFlag(supportReceipt.argv, '--conn-id', `${observation.id} ${name} support`)) !== after.public[0]!.connId) {
        throw new CliFilesFailure('invalid-receipt', `${observation.id} ${name} support did not use the exact-window route`)
      }
      const supportCommand = argvFlag(supportReceipt.argv, '--id', `${observation.id} ${name} support`)
      const supportArgs = JSON.parse(argvFlag(supportReceipt.argv, '--args', `${observation.id} ${name} support`)) as JsonObject
      supportCommands.add(supportCommand)
      if (supportCommand === 'command:quirky.git/collapse-all') {
        equal(supportArgs, { collapsed: false }, `${observation.id} ${name} expand support`)
        assertOtherWindow(support.otherAfter, `${observation.id} ${name} after expand`)
      } else if (supportCommand === 'command:quirky.git/load-diff') {
        if (!['README.md', SENTINEL_PATH, A_TARGET].includes(String(supportArgs.path))) {
          throw new CliFilesFailure('invalid-receipt', `${observation.id} ${name} loaded an unrelated diff path`)
        }
        assertOtherWindow(support.otherAfter, `${observation.id} ${name} after load ${String(supportArgs.path)}`)
      } else if (supportCommand === 'command:quirky.git/open-diff') {
        equal(supportArgs, {
          worktree: worktreeId,
          path: 'README.md',
          ...(expectedSource[name] === null ? {} : { source: expectedSource[name] })
        }, `${observation.id} ${name} README reveal args`)
        const result = record(successfulReceipt(byId, supportReceiptId).result, `${observation.id} ${name} README reveal result`)
        equal(result.worktree, worktreeId, `${observation.id} ${name} README reveal worktree`)
        equal(result.tabId, tabId, `${observation.id} ${name} README reveal tab`)
        equal(result.created, false, `${observation.id} ${name} README reveal reused tab`)
        equal(result.focused, true, `${observation.id} ${name} README reveal focused`)
        equal(result.source, expectedSource[name], `${observation.id} ${name} README reveal source`)
        equal(result.reveal, 'README.md', `${observation.id} ${name} README reveal path`)
        const before = record(support.before, `${observation.id} ${name} README reveal before`) as unknown as CapturedSample
        const after = record(support.after, `${observation.id} ${name} README reveal after`) as unknown as CapturedSample
        assertSample(before.snapshots, before.public, before.dom, byId, observation, `${observation.id} ${name} README reveal before`)
        assertSample(after.snapshots, after.public, after.dom, byId, observation, `${observation.id} ${name} README reveal after`)
        assertFirstWindowLayoutReceipt(observation, byId, supportReceiptId, after.public[0]!.connId, after.public[0]!, `${observation.id} ${name} README reveal first read`)
        const supportHistory = assertNavigationHistoryTransition(
          observation, byId, support.historyBefore, support.historyAfter, after.public[0]!.connId, worktreeId,
          `${observation.id} ${name} README reveal`
        )
        equal(supportHistory.before.shownWorktree, worktreeId, `${observation.id} ${name} README reveal source window`)
        equal(after.dom[1], before.dom[1], `${observation.id} ${name} README reveal cB DOM unchanged`)
        equal(after.public[1]!.windowState.layout, before.public[1]!.windowState.layout, `${observation.id} ${name} README reveal cB layout unchanged`)
        const otherBefore = readNavigationHistory(support.otherHistoryBefore, byId, observation, `${observation.id} ${name} README cB history before`)
        const otherAfter = readNavigationHistory(support.otherHistoryAfter, byId, observation, `${observation.id} ${name} README cB history after`)
        equal(otherAfter.result, otherBefore.result, `${observation.id} ${name} README cB history unchanged`)
        foundReadmeReveal = true
      } else {
        throw new CliFilesFailure('invalid-receipt', `${observation.id} ${name} has an unknown support command`)
      }
    }
    if (!supportCommands.has('command:quirky.git/collapse-all') ||
        !supportCommands.has('command:quirky.git/load-diff') || !foundReadmeReveal) {
      throw new CliFilesFailure('missing-receipt', `${observation.id} ${name} lacks exact-window expand/load/reveal support`)
    }
    if (name !== 'staged' && !cards.some((card) => card.path === A_TARGET && card.loaded && card.expanded)) {
      throw new CliFilesFailure('review-reveal-mismatch', `${observation.id} ${name} source card was not loaded`)
    }
  }

  const refusal = record(source.refusal, `${observation.id} staged-source refusal`)
  const refusalReceiptId = string(refusal.receiptId, `${observation.id} refusal receipt`)
  const refusalMessage = `${A_TARGET} has no staged changes.`
  assertCliRefusal(observation, byId, refusalReceiptId, {
    argv: ['api', 'call', 'ui.window.command.run', '--conn-id', String(targetConnId), '--id', 'command:quirky.git/open-diff',
      '--args', JSON.stringify({ worktree: worktreeId, path: A_TARGET, source: 'staged' })],
    exitCode: 1,
    code: 'conflict',
    message: refusalMessage
  }, `${observation.id} source refusal`)
  const refusalBefore = record(refusal.before, `${observation.id} refusal before`) as unknown as CapturedSample
  const refusalAfter = record(refusal.after, `${observation.id} refusal after`) as unknown as CapturedSample
  assertSample(refusalBefore.snapshots, refusalBefore.public, refusalBefore.dom, byId, observation, `${observation.id} refusal before`)
  assertSample(refusalAfter.snapshots, refusalAfter.public, refusalAfter.dom, byId, observation, `${observation.id} refusal after`)
  const beforeTab = tabById(refusalBefore.public[0]!.workspace, tabId)
  const afterTab = tabById(refusalAfter.public[0]!.workspace, tabId)
  if (!beforeTab || !afterTab) throw new CliFilesFailure('review-tab-mismatch', `${observation.id} refusal lost Review tab`)
  equal(afterTab.input, beforeTab.input, `${observation.id} refused scope preserves T2 input`)
  equal(refusal.afterInput, afterTab.input, `${observation.id} refusal input evidence`)
  equal(refusal.beforeInput, beforeTab.input, `${observation.id} refusal prior input evidence`)
  equal(selectedTabId(refusalAfter.public[0]!.workspace), tabId, `${observation.id} refusal active tab`)
  equal(refusalAfter.public[0]!.windowState.layout, refusalBefore.public[0]!.windowState.layout, `${observation.id} refusal cA layout unchanged`)
  equal(refusalAfter.public[1]!.windowState.layout, refusalBefore.public[1]!.windowState.layout, `${observation.id} refusal cB layout unchanged`)
  equal(refusalAfter.dom[1], refusalBefore.dom[1], `${observation.id} refusal cB DOM unchanged`)
  const otherHistoryBefore = readNavigationHistory(refusal.otherHistoryBefore, byId, observation, `${observation.id} refusal cB history before`)
  const otherHistoryAfter = readNavigationHistory(refusal.otherHistoryAfter, byId, observation, `${observation.id} refusal cB history after`)
  equal(otherHistoryAfter.result, otherHistoryBefore.result, `${observation.id} refusal cB history unchanged`)
}
function assertChangedModesObservation(observation: CliFileObservation, byId: Map<string, CliReceipt>): void {
  const request = record(observation.evidence.request, `${observation.id} request`)
  assertSample(observation.before, observation.evidence.public.before, observation.evidence.dom.before, byId, observation, `${observation.id} top-level before`)
  assertSample(observation.after, observation.evidence.public.after, observation.evidence.dom.after, byId, observation, `${observation.id} top-level after`)
  const modes = record(observation.evidence.changedModes, `${observation.id} changed modes evidence`)
  const worktreeId = string(modes.worktreeId, `${observation.id} worktree`)
  const editorTabId = string(modes.editorTabId, `${observation.id} reused editor tab`)
  const reviewTabId = string(modes.reviewTabId, `${observation.id} Review tab`)
  const sentinelTabId = string(modes.sentinelTabId, `${observation.id} sentinel tab`)
  const targetConnId = integer(request.targetConnectionId, `${observation.id} cA connection`)
  equal(request.worktreeId, worktreeId, `${observation.id} request worktree`)
  equal(observation.before.length, 2, `${observation.id} two live windows`)
  const status = record(modes.status, `${observation.id} public changed-file status`)
  const statusReceiptId = string(status.receiptId, `${observation.id} status receipt`)
  assertReceiptLinked(observation, statusReceiptId, `${observation.id} changed-file status`)
  const statusReceipt = byId.get(statusReceiptId)!
  if (statusReceipt.command !== 'api call' || statusReceipt.argv[2] !== 'quirky.git/status' ||
      argvFlag(statusReceipt.argv, '--worktree', `${observation.id} Git status`) !== worktreeId) {
    throw new CliFilesFailure('invalid-receipt', `${observation.id} changed-file status is not a public worktree read`)
  }
  const statusResult = successfulReceipt(byId, statusReceiptId)
  const entries = array(statusResult.entries, `${observation.id} status entries`).map((entry) => record(entry, `${observation.id} status entry`))
  const byPath = new Map<string, JsonObject[]>()
  for (const entry of entries) {
    const path = string(entry.path, `${observation.id} status path`)
    const values = byPath.get(path) ?? []
    values.push(entry)
    byPath.set(path, values)
  }
  const hasDeleted = (path: string): boolean => byPath.get(path)?.some((entry) =>
    (entry.area === 'unstaged' && entry.status === 'deleted') ||
    (entry.area === 'staged' && entry.status === 'deleted' && !byPath.get(path)!.some((other) =>
      other.area === 'unstaged' || other.area === 'untracked'))
  ) ?? false
  const expectedEditPaths = [...byPath.keys()].filter((path) => !hasDeleted(path)).sort()
  const expectedUnstagedPaths = [...byPath.entries()]
    .filter(([path, rows]) => rows.some((entry) => entry.area === 'unstaged' || entry.area === 'untracked') && !hasDeleted(path))
    .map(([path]) => path).sort()
  equal(expectedEditPaths, ['docs/review-notes.md', 'src/app.ts'], `${observation.id} edit mode file selection`)
  equal(expectedUnstagedPaths, ['src/app.ts'], `${observation.id} unstaged edit file selection`)
  equal(array(modes.expectedEditPaths, `${observation.id} expected edit paths`), expectedEditPaths, `${observation.id} reported edit paths`)
  equal(array(modes.expectedUnstagedPaths, `${observation.id} expected unstaged paths`), expectedUnstagedPaths, `${observation.id} reported unstaged paths`)
  if (statusResult.capped === true) throw new CliFilesFailure('fixture-status', `${observation.id} status is capped`)

  const applySample = (value: unknown, label: string): CapturedSample => {
    const sample = record(value, label) as unknown as CapturedSample
    const distinct = sample.snapshots[0]!.workspaceId !== sample.snapshots[1]!.workspaceId
    assertSample(sample.snapshots, sample.public, sample.dom, byId, observation, label, distinct)
    return sample
  }
  const editorTabForPath = (sample: CapturedSample, path: string): { bufferId: string; tabId: string } => {
    const editor = sample.public.find((entry) => shownWorktree(entry) === worktreeId)?.editor
    if (!editor) throw new CliFilesFailure('missing-buffer', `${observation.id} has no public editor state for B`)
    const buffers = array(editor.buffers, `${observation.id} editor buffers`).map((entry) => record(entry, `${observation.id} editor buffer`))
    const rootBuffer = buffers.find((buffer) => buffer.worktreeId === worktreeId)
    if (!rootBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} B root buffer is missing`)
    const absolutePath = expectedAbsolute(string(rootBuffer.root, `${observation.id} B root`), path)
    const matchingBuffers = buffers.filter((buffer) => buffer.worktreeId === worktreeId && buffer.path === absolutePath)
    if (matchingBuffers.length !== 1) throw new CliFilesFailure('missing-buffer', `${observation.id} expected one B buffer for ${path}`)
    const bufferId = string(matchingBuffers[0]!.id, `${observation.id} ${path} buffer ID`)
    const tabs = array(editor.tabs, `${observation.id} editor tabs`).map((entry) => record(entry, `${observation.id} editor tab`))
      .filter((entry) => entry.bufferId === bufferId)
    if (tabs.length !== 1) throw new CliFilesFailure('duplicate-tab', `${observation.id} expected exactly one editor tab for ${path}`)
    return { bufferId, tabId: string(tabs[0]!.tabId, `${observation.id} ${path} tab ID`) }
  }
  const initialBWindow = observation.evidence.public.before.find((window) => window.connId !== targetConnId)!
  const bEditor = initialBWindow.editor
  const appBuffer = array(bEditor.buffers, `${observation.id} initial B buffers`)
    .map((entry) => record(entry, `${observation.id} initial B buffer`))
    .find((buffer) => buffer.worktreeId === worktreeId && typeof buffer.path === 'string' && buffer.path.endsWith(`/${A_TARGET}`))
  if (!appBuffer) throw new CliFilesFailure('missing-buffer', `${observation.id} did not retain the scenario-7 app buffer`)
  equal(string(appBuffer.tabId, `${observation.id} scenario-7 tab`), editorTabId, `${observation.id} scenario-7 editor tab identity`)

  const expectedOpened = [
    { path: 'docs/review-notes.md', tabId: sentinelTabId, bufferId: string(
      array(bEditor.buffers, `${observation.id} baseline editor buffers`)
        .map((entry) => record(entry, `${observation.id} baseline buffer`))
        .find((buffer) => buffer.worktreeId === worktreeId && typeof buffer.path === 'string' && buffer.path.endsWith('/docs/review-notes.md'))?.id,
      `${observation.id} sentinel document buffer`
    ) },
    { path: 'src/app.ts', tabId: editorTabId, bufferId: string(appBuffer.id, `${observation.id} app buffer ID`) }
  ]
  const expectedSkipped = [{ path: 'README.md', reason: 'deleted' }]
  const checkOpenedState = (sample: CapturedSample, label: string) => {
    const state = sample.public.find((window) => shownWorktree(window) === worktreeId)
    if (!state) throw new CliFilesFailure('worktree-mismatch', `${label} has no B workspace readback`)
    for (const expected of expectedOpened) {
      const result = editorTabForPath(sample, expected.path)
      equal(result.tabId, expected.tabId, `${label} ${expected.path} tab identity`)
      equal(result.bufferId, expected.bufferId, `${label} ${expected.path} buffer identity`)
      const viewTabs = tabsInWorkspace(state.workspace).filter((tab) => tab.viewId === EDITOR_VIEW_ID && tab.key === expected.bufferId)
      equal(viewTabs.length, 1, `${label} exactly one document view for ${expected.path}`)
      equal(viewTabs[0]!.id, expected.tabId, `${label} document view tab for ${expected.path}`)
    }
  }
  const checkChangesResult = (
    stepValue: unknown,
    label: string,
    mode: 'edit' | 'both',
    expectFocus: boolean,
    extraArgs: Record<string, unknown>,
    receiptId?: string
  ) => {
    const step = record(stepValue, label)
    const before = applySample(step.before, `${label} before`)
    const after = applySample(step.after, `${label} after`)
    const id = receiptId ?? string(step.receiptId, `${label} receipt ID`)
    const receipt = byId.get(id)!
    assertReceiptLinked(observation, id, `${label} command`)
    if (receipt.command !== 'api call' || receipt.argv[2] !== 'ui.window.command.run' || receipt.exitCode !== 0 ||
        Number(argvFlag(receipt.argv, '--conn-id', label)) !== targetConnId) {
      throw new CliFilesFailure('invalid-receipt', `${label} did not use the exact target window`)
    }
    equal(argvFlag(receipt.argv, '--id', label), 'command:quirky.git/open-changes', `${label} command ID`)
    const args = JSON.parse(argvFlag(receipt.argv, '--args', label)) as JsonObject
    equal(args, { worktree: worktreeId, mode, ...extraArgs }, `${label} exact args`)
    const result = record(successfulReceipt(byId, id).result, `${label} structured result`)
    equal(result.worktree, worktreeId, `${label} worktree`)
    equal(result.mode, mode, `${label} mode`)
    equal(result.source, extraArgs.area === 'unstaged' ? 'unstaged' : null, `${label} source`)
    equal(result.focused, expectFocus, `${label} focus result`)
    equal(result.statusComplete, true, `${label} status completeness`)
    equal(array(result.opened, `${label} opened`), extraArgs.area === 'unstaged'
      ? expectedOpened.filter((entry) => expectedUnstagedPaths.includes(entry.path)) : expectedOpened, `${label} exact opened entries`)
    equal(array(result.skipped, `${label} skipped`), expectedSkipped, `${label} exact skipped entries`)
    if (mode === 'edit') {
      equal(result.review, null, `${label} edit mode has no Review`)
    } else {
      const review = record(result.review, `${label} Review result`)
      equal(review.worktree, worktreeId, `${label} Review worktree`)
      equal(review.tabId, reviewTabId, `${label} Review tab`)
      equal(review.created, false, `${label} Review reused tab`)
      equal(review.focused, true, `${label} Review focused`)
      equal(review.source, null, `${label} Review source`)
    }
    checkOpenedState(after, label)
    const beforeOther = before.public.find((window) => window.connId !== targetConnId)!
    const afterOther = after.public.find((window) => window.connId !== targetConnId)!
    equal(afterOther.windowState.layout, beforeOther.windowState.layout, `${label} cB layout unchanged`)
    equal(after.dom[1], before.dom[1], `${label} cB DOM unchanged`)
    const historyBefore = record(step.historyBefore, `${label} history before`)
    const historyAfter = record(step.historyAfter, `${label} history after`)
    if (expectFocus) {
      assertFirstWindowLayoutReceipt(observation, byId, id, targetConnId, after.public[0]!, `${label} first public layout`)
      const transition = assertNavigationHistoryTransition(
        observation, byId, historyBefore.target, historyAfter.target, targetConnId, worktreeId, label
      )
      equal(transition.before.shownWorktree, shownWorktree(before.public[0]!), `${label} history baseline`)
    } else {
      const targetBefore = readNavigationHistory(historyBefore.target, byId, observation, `${label} cA history before`)
      const targetAfter = readNavigationHistory(historyAfter.target, byId, observation, `${label} cA history after`)
      equal(targetAfter.result, targetBefore.result, `${label} background cA history unchanged`)
      equal(after.public[0]!.windowState.layout, before.public[0]!.windowState.layout, `${label} background cA layout unchanged`)
      equal(after.dom[0], before.dom[0], `${label} background cA DOM unchanged`)
    }
    const otherBefore = readNavigationHistory(historyBefore.other, byId, observation, `${label} cB history before`)
    const otherAfter = readNavigationHistory(historyAfter.other, byId, observation, `${label} cB history after`)
    equal(otherAfter.result, otherBefore.result, `${label} cB history unchanged`)
    return { before, after }
  }

  const edit = checkChangesResult(modes.edit, `${observation.id} edit`, 'edit', false, { focus: false })
  const editAfterB = edit.after.public.find((window) => shownWorktree(window) === worktreeId)!
  equal(selectedTabId(editAfterB.workspace), sentinelTabId, `${observation.id} background edit leaves sentinel active`)
  equal(edit.after.dom.find((dom) => dom.connId === editAfterB.connId)!.path, expectedAbsolute(
    string(appBuffer.root, `${observation.id} app root`), 'docs/review-notes.md'
  ), `${observation.id} background edit keeps the sentinel document visible`)
  const both = checkChangesResult(modes.both, `${observation.id} both`, 'both', true, {})
  equal(selectedTabId(both.after.public[0]!.workspace), reviewTabId, `${observation.id} both selects Review`)
  const bothReviewTabs = reviewTabFor(both.after.public[0]!.workspace, reviewKey(worktreeId))
  equal(bothReviewTabs.map((tab) => tab.id), [reviewTabId], `${observation.id} both reuses the combined Review tab`)
  const unstaged = record(modes.unstagedEdit, `${observation.id} unstaged edit`)
  const unstagedStep = checkChangesResult(unstaged, `${observation.id} unstaged edit`, 'edit', true, { area: 'unstaged' })
  const result = record(
    successfulReceipt(byId, string(unstaged.receiptId, `${observation.id} unstaged command receipt`)).result,
    `${observation.id} unstaged structured result`
  )
  equal(result.mode, 'edit', `${observation.id} unstaged edit mode`)
  equal(result.source, 'unstaged', `${observation.id} unstaged scope`)
  equal(array(result.opened, `${observation.id} unstaged opened`), [
    { path: A_TARGET, tabId: editorTabId, bufferId: string(appBuffer.id, `${observation.id} app buffer ID`) }
  ], `${observation.id} unstaged exact opened path`)
  equal(array(result.skipped, `${observation.id} unstaged skipped`), expectedSkipped, `${observation.id} unstaged deleted path`)
  const firstAbsolutePath = string(unstaged.firstOpenedAbsolutePath, `${observation.id} first opened absolute path`)
  equal(firstAbsolutePath, expectedAbsolute(string(appBuffer.root, `${observation.id} app root`), A_TARGET), `${observation.id} authorized focused editor path`)
  equal(unstagedStep.after.dom[0]!.path, firstAbsolutePath, `${observation.id} focused app path`)
  equal(unstagedStep.after.dom[0]!.renderedTabId, editorTabId, `${observation.id} focused app tab`)
  equal(selectedTabId(unstagedStep.after.public[0]!.workspace), editorTabId, `${observation.id} app active tab`)
  const readmeStatus = entries.filter((entry) => entry.path === 'README.md')
  equal(readmeStatus.map((entry) => `${entry.area}:${entry.status}`).sort(),
    ['staged:modified', 'unstaged:deleted'], `${observation.id} partial README deletion`)
  equal(entries.filter((entry) => entry.path === 'docs/review-notes.md').map((entry) => `${entry.area}:${entry.status}`),
    ['staged:modified'], `${observation.id} docs edit status`)
  const appStatus = entries.filter((entry) => entry.path === A_TARGET)
  if (appStatus.length !== 1 || (appStatus[0]!.area !== 'unstaged' && appStatus[0]!.area !== 'untracked') ||
      appStatus[0]!.status === 'deleted') {
    throw new CliFilesFailure('fixture-status', `${observation.id} app source is not openable`)
  }
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
  const historySteps = array(review.history, `${observation.id} focused command histories`)
  if (historySteps.length !== expectedCommands) {
    throw new CliFilesFailure('missing-receipt', `${observation.id} is missing focused command history evidence`)
  }
  for (const [index, exactCommand] of exactCommands.entries()) {
    assertReceiptLinked(observation, exactCommand.id, `${observation.id} exact command`)
    equal(Number(argvFlag(exactCommand.argv, '--conn-id', `${observation.id} exact command`)), targetConnId, `${observation.id} exact target connection`)
    const args = JSON.parse(argvFlag(exactCommand.argv, '--args', `${observation.id} exact command`)) as JsonObject
    equal(args.worktree, worktreeId, `${observation.id} exact command worktree`)
    if (path !== null) equal(args.path, path, `${observation.id} exact command path`)
    else if (args.path !== undefined) throw new CliFilesFailure('invalid-receipt', 'open-changes unexpectedly included a file path')

    const envelope = successfulReceipt(byId, exactCommand.id)
    const reply = record(envelope.result, `${observation.id} structured command result`)
    if (commandId === 'command:quirky.git/open-diff') {
      equal(reply.worktree, worktreeId, `${observation.id} open-diff result worktree`)
      equal(reply.tabId, tabId, `${observation.id} open-diff result tab`)
      equal(reply.created, observation.id === 'files-review-diff', `${observation.id} open-diff result creation`)
      equal(reply.focused, true, `${observation.id} open-diff result focus`)
      equal(reply.source, null, `${observation.id} open-diff result source`)
      equal(reply.reveal, path, `${observation.id} open-diff result reveal`)
      equal(reply.statusComplete, null, `${observation.id} open-diff status completeness`)
    } else {
      equal(reply.worktree, worktreeId, `${observation.id} open-changes result worktree`)
      equal(reply.mode, 'diff', `${observation.id} open-changes result mode`)
      equal(reply.source, null, `${observation.id} open-changes result source`)
      equal(reply.focused, true, `${observation.id} open-changes result focus`)
      equal(reply.statusComplete, true, `${observation.id} open-changes status completeness`)
      equal(array(reply.opened, `${observation.id} opened files`), [], `${observation.id} open-changes editor results`)
      equal(array(reply.skipped, `${observation.id} skipped files`), [], `${observation.id} open-changes skipped results`)
      const result = record(reply.review, `${observation.id} nested Review result`)
      equal(result.worktree, worktreeId, `${observation.id} nested Review worktree`)
      equal(result.tabId, tabId, `${observation.id} nested Review tab`)
      equal(result.created, index === 0, `${observation.id} nested Review creation`)
      equal(result.focused, true, `${observation.id} nested Review focus`)
      equal(result.source, null, `${observation.id} nested Review source`)
      equal(result.reveal, null, `${observation.id} nested Review reveal`)
      equal(result.statusComplete, null, `${observation.id} nested Review status completeness`)
    }

    const historyStep = record(historySteps[index], `${observation.id} command history ${index}`)
    const transition = assertNavigationHistoryTransition(
      observation,
      byId,
      historyStep.before,
      historyStep.after,
      targetConnId,
      worktreeId,
      `${observation.id} focused command ${index}`
    )
    const beforeWindow = index === 0
      ? beforePublic[targetIndex]!
      : record(record(review.repeatBefore, `${observation.id} repeat baseline`).public, `${observation.id} repeat public baseline`) as unknown as CliFilePublicWindow
    const layout = record(record(beforeWindow.windowState, `${observation.id} history before window`).layout, `${observation.id} history before layout`)
    const shownBefore = string(layout.worktree, `${observation.id} shown-before worktree`)
    equal(transition.before.shownWorktree, shownBefore, `${observation.id} history and window baseline correlation`)
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
  if (observation.id === 'files-editor-window-focus') assertWindowFocusObservation(observation, byId)
  else if (observation.id === 'files-window-refusals') assertWindowRefusalsObservation(observation, byId)
  else if (observation.id === 'files-review-focus-window') assertReviewFocusWindowObservation(observation, byId)
  else if (observation.id === 'files-review-background') assertReviewBackgroundObservation(observation, byId)
  else if (observation.id === 'files-review-source') assertReviewSourceObservation(observation, byId)
  else if (observation.id === 'files-changed-modes') assertChangedModesObservation(observation, byId)
  else if (observation.id.startsWith('files-editor-')) assertEditorObservation(observation, byId)
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
  if (expected.length !== EXPECTED_OBSERVATION_COUNT ||
      expected.length !== EXPECTED_OBSERVATIONS.length ||
      expected.some((id) => !EXPECTED_OBSERVATIONS.includes(id as (typeof EXPECTED_OBSERVATIONS)[number])) ||
      flattened.length !== EXPECTED_BINDING_COUNT) {
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
type CliFilesHistories = { target: CliFileHistoryRead; other: CliFileHistoryRead }
type CliFilesTransition = {
  receiptId: string
  result: unknown
  before: CapturedSample
  after: CapturedSample
  historyBefore: CliFilesHistories
  historyAfter: CliFilesHistories
}
type TemporaryRenderer = {
  context: BrowserContext
  page: BrowserPage | null
  connId: number
  contextClosed: boolean
  pageClosed: boolean
  connectionGone: boolean
}
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
  const review = hostedVisible ? hosted!.querySelector<HTMLElement>('[data-review-tab]') : null
  const reviewScroll = review?.querySelector<HTMLElement>('[data-review-scroll]') ?? null
  const reviewTabMounted = review !== null
  const reviewScopeChip = review?.querySelector<HTMLElement>('.ui-scope-chip__label')?.textContent?.trim() ?? null
  const reviewWidth = reviewScroll?.getBoundingClientRect().width ?? 0
  const reviewScrollTop = reviewScroll?.scrollTop ?? 0
  const reviewCards = review ? [...review.querySelectorAll<HTMLElement>('.git-review__card[data-path]')].map((card) => {
    const body = card.querySelector<HTMLElement>('[data-review-body]')
    const pane = card.querySelector<HTMLElement>('.git-review__pane')
    const text = pane?.innerText ?? ''
    const mergeEditors = pane ? [...pane.querySelectorAll<HTMLElement>('.cm-mergeViewEditor')] : []
    const originalLines = mergeEditors[0]
      ? [...mergeEditors[0].querySelectorAll<HTMLElement>('.cm-line')].map((line) => line.textContent ?? '')
      : []
    const modifiedLines = mergeEditors[1]
      ? [...mergeEditors[1].querySelectorAll<HTMLElement>('.cm-line')].map((line) => line.textContent ?? '')
      : []
    return {
      path: card.dataset.path ?? '',
      active: card.hasAttribute('data-active'),
      expanded: body !== null && !body.hidden,
      loaded: pane !== null && !pane.hidden && text.trim().length > 0,
      editable: card.querySelector('[contenteditable="true"]') !== null,
      hasReviewMark: card.querySelector('.git-review__review button') !== null,
      mergeEditorCount: mergeEditors.length,
      originalLines,
      modifiedLines,
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
    reviewScopeChip,
    reviewWidth,
    reviewScrollTop,
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
  readonly temporaryPages: TemporaryRenderer[] = []
  fileSentinels: { a: SentinelInfo; b: SentinelInfo } | undefined
  windowEditorTabId = ''
  windowEditorBufferId = ''
  sourceReviewTabId = ''
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

  async execute(argv: string[], options: { id: string; cwd?: string; mutation?: boolean; cleanup?: boolean; signal?: AbortSignal } ): Promise<{ result?: unknown; refusal?: { code: string; message: string; data?: unknown }; receipt: CliReceipt }> {
    const cleanup = options.cleanup === true
    const baseSignal = cleanup ? this.cleanupController.signal : this.workController.signal
    const signal = options.signal ? AbortSignal.any([baseSignal, options.signal]) : baseSignal
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

  async requireSuccess(id: string, argv: string[], options: { cwd?: string; mutation?: boolean; cleanup?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    const executed = await this.execute(argv, { id, ...options })
    if (executed.refusal) throw new CliFilesFailure('cli-exit', `CLI command ${id} exited ${executed.receipt.exitCode}: ${executed.refusal.message}`)
    return executed.result
  }

  async expectRefusal(
    id: string,
    argv: string[],
    expected: { exitCode: 1 | 2; code?: string; message?: string; messageIncludes?: string }
  ): Promise<{ code: string; message: string; data?: unknown }> {
    const executed = await this.execute(argv, { id, mutation: true })
    if (!executed.refusal || executed.receipt.exitCode !== expected.exitCode) {
      throw new CliFilesFailure('unexpected-success', `CLI command ${id} did not exit ${expected.exitCode} with the expected refusal`)
    }
    const refusal = parseCliRefusal(
      JSON.stringify(executed.receipt.evidence.result),
      executed.receipt.exitCode,
      expected.exitCode
    )
    if ((expected.code !== undefined && refusal.code !== expected.code) ||
        (expected.message !== undefined && refusal.message !== expected.message) ||
        (expected.messageIncludes !== undefined && !refusal.message.includes(expected.messageIncludes))) {
      throw new CliFilesFailure('invalid-refusal', `CLI command ${id} returned a different refusal`)
    }
    return refusal
  }
  async reviewChanged(builder: ObservationBuilder): Promise<void> {
    const worktreeA = this.windows[0]!.worktree
    const worktreeB = this.windows[1]!.worktree
    await this.navigateWindowToWorktree(0, worktreeA.id, 'files-review-changed-reset-a')
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
    const historyBefore = await this.captureNavigationHistory(
      'files-review-changed-history-before',
      this.windows[0]!.connId,
      string(record(before.public[0]!.windowState, 'open-changes before layout').layout && record(record(before.public[0]!.windowState, 'open-changes before layout').layout, 'open-changes layout').worktree, 'open-changes shown-before')
    )
    await this.runWindowCommand('files-review-changed-open-changes', this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: worktreeB.id })
    const firstReadAfterOpen = await this.readPublicWindow(0, 'files-review-changed-first-read')
    const firstOpenLayout = record(firstReadAfterOpen.windowState.layout, 'open-changes first-read layout')
    const historyAfter = await this.captureNavigationHistory(
      'files-review-changed-history-after',
      this.windows[0]!.connId,
      string(firstOpenLayout.worktree, 'open-changes first-read worktree')
    )
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
    const historyBeforeRepeat = await this.captureNavigationHistory(
      'files-review-changed-history-before-repeat',
      this.windows[0]!.connId,
      string(record(repeatBefore.public.windowState, 'repeat before layout').layout && record(record(repeatBefore.public.windowState, 'repeat before layout').layout, 'repeat before layout').worktree, 'repeat shown-before')
    )
    await this.runWindowCommand('files-review-changed-repeat-open-changes', this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: worktreeB.id })
    const firstReadAfterRepeat = await this.readPublicWindow(0, 'files-review-changed-first-read-repeat')
    const firstRepeatLayout = record(firstReadAfterRepeat.windowState.layout, 'repeat first-read layout')
    const historyAfterRepeat = await this.captureNavigationHistory(
      'files-review-changed-history-after-repeat',
      this.windows[0]!.connId,
      string(firstRepeatLayout.worktree, 'repeat first-read worktree')
    )
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
      editorTabIdsAfter: editorTabsAfter,
      firstReadAfterOpen,
      firstReadAfterRepeat,
      history: [
        { before: historyBefore, after: historyAfter },
        { before: historyBeforeRepeat, after: historyAfterRepeat }
      ]
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

  async readPublicWindow(index: number, phase: string, initialLayout?: { receiptId: string; state: JsonObject }): Promise<CliFilePublicWindow> {
    const entry = this.windows[index]
    if (!entry) throw new CliFilesFailure('connection-mismatch', `window index ${index} is missing`)
    const stateId = `${this.activeObservation?.id ?? 'run'}-${phase}-window-${index}`
    const windowState = initialLayout?.state ?? await this.api(`${stateId}-state`, 'ui.window.state', { connId: entry.connId })
    const state = record(windowState, `${phase} window state`)
    const layout = record(state.layout, `${phase} window layout`)
    const worktree = string(layout.worktree, `${phase} window worktree`)
    if (state.connId !== entry.connId) throw new CliFilesFailure('connection-mismatch', `${phase} returned the wrong window connection`)
    const workspace = await this.api(`${stateId}-workspace`, 'quirky.terminal/workspace', { workspace: worktree })
    const editor = await this.editor(`${stateId}-editor`, ['state', '--worktree', worktree])
    return {
      connId: entry.connId,
      receiptIds: { window: initialLayout?.receiptId ?? `${stateId}-state`, workspace: `${stateId}-workspace`, editor: `${stateId}-editor` },
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
  async captureSampleAfterFirstWindowRead(phase: string, firstWindow: CliFilePublicWindow, otherWindow: CliFilePublicWindow): Promise<CapturedSample> {
    if (firstWindow.connId !== this.windows[0]!.connId) {
      throw new CliFilesFailure('connection-mismatch', `${phase} first layout read is not from page A`)
    }
    const publicWindows = [firstWindow, otherWindow]
    const domWindows: CliFileDomWindow[] = []
    for (let index = 0; index < 2; index += 1) {
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
    await this.waitForDom(index, dom => dom.renderedTabId === tabId && dom.path !== null && dom.lines.length > 0,
      `baseline source ${index}:${tabId}`)
    const focused = await this.readRenderer(() => entry.page.evaluate((targetTabId) => {
      const hosted = [...document.querySelectorAll<HTMLElement>('.qt-hosted-view[data-hosted-view]')]
        .find((element) => element.dataset.hostedView === targetTabId)
      const content = hosted?.querySelector<HTMLElement>('.cm-content')
      content?.focus()
      return content !== undefined && document.activeElement === content
    }, tabId))
    if (!focused) throw new CliFilesFailure('fixture-focus', `could not focus baseline source tab ${index}:${tabId}`)
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
      if (builder.before.length > 0) {
        try {
          const readback = await this.captureSample(`${id}-failure-readback`)
          builder.evidence.failureReadback = readback
          if (builder.after.length === 0) {
            builder.after = readback.snapshots
            builder.evidence.public.after = readback.public
            builder.evidence.dom.after = readback.dom
          }
        } catch (readbackError) {
          builder.evidence.failureReadbackError = safeError(readbackError)
        }
      }
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
    this.gitEvidence.push({ id: label, executable: '/usr/bin/git', argv: gitArgv, cwd, exitCode: raw.exitCode, stdoutBytes: raw.stdoutBytes, elapsedMs: raw.elapsedMs, stdout: raw.stdout, stderrTail: raw.stderr.slice(-MAX_DIAGNOSTIC_BYTES) })
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

  async navigateWindowToWorktree(index: number, worktreeId: string, id: string): Promise<void> {
    const entry = this.windows[index]!
    await this.api(id, 'quirky.worktree/navigate', {
      worktree: `id:${worktreeId}`,
      target: 'terminal',
      window: entry.connId
    }, { mutation: true })
    const dom = await this.waitForDom(index, (sample) => sample.workspaceId === worktreeId, `navigate window to worktree ${worktreeId}`)
    if (dom.workspaceId !== worktreeId) throw new CliFilesFailure('worktree-mismatch', `window ${entry.connId} did not navigate to worktree ${worktreeId}`)
  }

  async runWindowCommand(id: string, connId: number, commandId: string, args: Record<string, unknown>, cleanup = false): Promise<unknown> {
    return this.api(id, 'ui.window.command.run', { connId, id: commandId, args }, { mutation: true, cleanup })
  }
  async gitStatus(id: string, worktreeId: string): Promise<JsonObject> {
    return record(await this.api(id, 'quirky.git/status', { worktree: worktreeId }), `${id} Git status`)
  }
  async captureNavigationHistory(id: string, connId: number, shownWorktree: string): Promise<CliFileHistoryRead> {
    const raw = record(await this.api(id, 'quirky.worktree/navigationState', { window: connId }), `${id} navigation history`)
    const worktrees = array(raw.worktrees, `${id} history worktrees`).map((entry) => string(entry, `${id} history worktree`))
    const index = integer(raw.index, `${id} history index`)
    return { connId, shownWorktree, receiptId: id, result: { worktrees, index } }
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
      await this.navigateWindowToWorktree(0, this.windows[0]!.worktree.id, `${id}-reset-a-view`)
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
    const historyBefore = await this.captureNavigationHistory(
      `${id}-history-before`,
      targetConnId,
      string(record(before.public[0]!.windowState, `${id} before layout`).layout && record(record(before.public[0]!.windowState, `${id} before layout`).layout, `${id} before layout`).worktree, `${id} shown-before`)
    )
    const commandReceiptId = `${id}-exact-open`
    await this.runWindowCommand(commandReceiptId, targetConnId, 'command:quirky.git/open-diff', { worktree: worktreeB.id, path })
    const firstReadAfter = await this.readPublicWindow(0, `${id}-first-read`)
    const firstReadLayout = record(firstReadAfter.windowState.layout, `${id} first-read layout`)
    const historyAfter = await this.captureNavigationHistory(
      `${id}-history-after`,
      targetConnId,
      string(firstReadLayout.worktree, `${id} first-read worktree`)
    )
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
      inputRevealAfter: record(tab.input, `${id} review input`).reveal,
      firstReadAfter,
      history: [{ before: historyBefore, after: historyAfter }]
    }
  }

  async closeReview(worktreeId: string, id: string, via: 'ui' | 'terminal' = 'ui'): Promise<void> {
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
    if (via === 'terminal') await this.requireSuccess(id, ['terminal', 'tab', 'close', current.tabId], { mutation: true })
    else await this.runWindowCommand(id, ownerConnId, 'command:quirky.git/close-diff', { tabId: current.tabId })
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
    await this.expectRefusal(ambiguousId, ['ui', 'run', 'command:quirky.git/open-diff', '--args', argsJson], {
      exitCode: 1,
      messageIncludes: 'multiple Quirky windows are open; specify connId'
    })
    const staleConnId = Math.max(...this.windows.map((entry) => entry.connId)) + 100_000
    const staleId = 'files-window-routing-stale'
    const staleArgs = JSON.stringify({ worktree: b.id, path: A_TARGET })
    await this.expectRefusal(staleId, ['api', 'call', 'ui.window.command.run', '--conn-id', String(staleConnId), '--id', 'command:quirky.git/open-diff', '--args', staleArgs], {
      exitCode: 1
    })
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

  setObservationSamples(builder: ObservationBuilder, before: CapturedSample, after: CapturedSample): void {
    builder.before = before.snapshots
    builder.after = after.snapshots
    builder.evidence.public = { before: before.public, after: after.public }
    builder.evidence.dom = { before: before.dom, after: after.dom }
  }

  async captureHistories(id: string, sample: CapturedSample): Promise<CliFilesHistories> {
    const reads: CliFileHistoryRead[] = []
    for (const [index, window] of sample.public.entries()) {
      reads.push(await this.captureNavigationHistory(
        `${id}-${index}`, window.connId, shownWorktree(window)
      ))
    }
    return { target: reads[0]!, other: reads[1]! }
  }

  async transition(
    id: string,
    mutate: () => Promise<unknown>,
    waitForRender?: (result: unknown) => Promise<unknown>
  ): Promise<CliFilesTransition> {
    const before = await this.captureSample(`${id}-before`)
    const historyBefore = await this.captureHistories(`${id}-history-before`, before)
    const progress: JsonObject = { receiptId: id, before, historyBefore }
    if (this.activeObservation) {
      this.activeObservation.evidence.inFlight = progress
      if (this.activeObservation.before.length === 0) {
        this.activeObservation.before = before.snapshots
        this.activeObservation.evidence.public.before = before.public
        this.activeObservation.evidence.dom.before = before.dom
      }
    }
    const result = await mutate()
    const layouts: Array<{ receiptId: string; state: JsonObject }> = []
    const histories: CliFileHistoryRead[] = []
    for (const [index, window] of this.windows.entries()) {
      const receiptId = `${id}-immediate-window-${index}`
      const state = record(await this.api(receiptId, 'ui.window.state', { connId: window.connId }), `${id} immediate layout`)
      layouts.push({ receiptId, state })
      histories.push(await this.captureNavigationHistory(`${id}-history-after-${index}`, window.connId,
        string(record(state.layout, `${id} immediate layout`).worktree, `${id} immediate worktree`)))
    }
    const historyAfter = { target: histories[0]!, other: histories[1]! }
    const first = await this.readPublicWindow(0, `${id}-first-read`, layouts[0]!)
    const other = await this.readPublicWindow(1, `${id}-other-read`, layouts[1]!)
    progress.result = result
    progress.firstPublicRead = first
    progress.historyAfter = historyAfter
    if (waitForRender) await waitForRender(result)
    const after = await this.captureSampleAfterFirstWindowRead(`${id}-after`, first, other)
    if (this.activeObservation) {
      this.activeObservation.after = after.snapshots
      this.activeObservation.evidence.public.after = after.public
      this.activeObservation.evidence.dom.after = after.dom
      Reflect.deleteProperty(this.activeObservation.evidence, 'inFlight')
    }
    return { receiptId: id, result, before, after, historyBefore, historyAfter }
  }

  async activateTab(id: string, tabId: string): Promise<void> {
    await this.requireSuccess(id, ['terminal', 'tab', 'activate', tabId], { mutation: true })
  }

  async editorWindowFocus(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-setup-a`)
    await this.navigateWindowToWorktree(1, b.id, `${builder.id}-setup-b`)
    const sentinels = await this.sentinelPair(builder)
    this.fileSentinels = sentinels
    const destinationId = `${builder.id}-destination-before`
    const destinationBefore = await this.api(destinationId, 'quirky.terminal/workspace', { workspace: b.id })
    await this.navigateWindowToWorktree(1, a.id, `${builder.id}-other-on-a`)
    await this.focusBaseline(0, sentinels.a.tabId)
    await this.focusBaseline(1, sentinels.a.tabId)
    builder.evidence.request = {
      worktreeId: b.id, relativePath: B_TARGET, absolutePath: join(b.path, B_TARGET), content: B_CONTENT,
      mode: 'source', line: 2, column: 3, targetConnectionId: this.windows[0]!.connId
    }
    const open = async (id: string, line: number, column: number) => {
      const result = record(await this.editor(id, [
        'open', B_TARGET, '--worktree', b.id, '--window', String(this.windows[0]!.connId),
        '--mode', 'source', '--line', String(line), '--column', String(column)
      ], { mutation: true }), id)
      this.editorBuffers.set(string(result.id, `${id} buffer`), b.id)
      return result
    }
    const focused = (line: number, column: number) => this.waitForDom(0, dom =>
      dom.workspaceId === b.id && dom.path === join(b.path, B_TARGET) &&
      dom.caret?.line === line && dom.caret.column === column && dom.activeElementIsSource,
    `${builder.id} source caret ${line}:${column}`)
    const focusId = `${builder.id}-open`
    const focus = await this.transition(focusId, () => open(focusId, 2, 3), () => focused(2, 3))
    const opened = record(focus.result, `${builder.id} opened document`)
    this.windowEditorTabId = string(opened.openedTabId, 'window editor tab')
    this.windowEditorBufferId = string(opened.id, 'window editor buffer')
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-reuse-show-a`)
    await this.focusBaseline(0, sentinels.a.tabId)
    const reuseId = `${builder.id}-reuse`
    const reuse = await this.transition(reuseId, () => open(reuseId, 1, 1), () => focused(1, 1))
    const backgroundId = `${builder.id}-background`
    const background = await this.transition(backgroundId, () =>
      this.editor(backgroundId, ['open', SENTINEL_PATH, '--worktree', b.id], { mutation: true }))
    this.setObservationSamples(builder, focus.before, background.after)
    builder.evidence.destination = {
      beforeReceiptId: destinationId, before: destinationBefore, after: background.after.public[0]!.workspace
    }
    builder.evidence.windowFocus = {
      tabId: this.windowEditorTabId, bufferId: this.windowEditorBufferId, focus, reuse, background
    }
  }

  async windowRefusals(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    const connA = this.windows[0]!.connId
    const connB = this.windows[1]!.connId
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-setup-a`)
    await this.navigateWindowToWorktree(1, b.id, `${builder.id}-setup-b`)
    await this.sentinelPair(builder)
    const snapshot = async (id: string) => {
      const sample = await this.captureSample(id)
      const history = await this.captureHistories(`${id}-history`, sample)
      return { sample, history: { a: history.target, b: history.other } }
    }
    const initial = await snapshot(`${builder.id}-initial`)
    this.setObservationSamples(builder, initial.sample, initial.sample)
    const cases: Array<{
      caseId: string; receiptId: string
      after: { sample: CapturedSample; history: { a: CliFileHistoryRead; b: CliFileHistoryRead } }
    }> = []
    const refused = async (caseId: string, argv: string[], exitCode: 1 | 2, code: string, message?: string) => {
      const receiptId = `${builder.id}-${caseId}`
      await this.expectRefusal(receiptId, argv, { exitCode, code, ...(message ? { message } : {}) })
      cases.push({ caseId, receiptId, after: await snapshot(`${receiptId}-after`) })
    }
    await refused('unknown-editor', ['editor', 'open', B_TARGET, '--worktree', b.id, '--window', '999'],
      1, 'conflict', 'UI window connection 999 is not open')
    await refused('zero-window', ['editor', 'open', B_TARGET, '--worktree', b.id, '--window', '0'], 2, 'usage')
    await refused('focus-window-conflict', [
      'editor', 'open', B_TARGET, '--worktree', b.id, '--focus=false', '--window', String(connA)
    ], 1, 'invalid-params', 'window cannot be combined with focus: false')
    await refused('unknown-review-window', [
      'api', 'call', 'ui.window.command.run', '--conn-id', '999', '--id', 'command:quirky.git/open-diff',
      '--args', JSON.stringify({ worktree: b.id, path: B_TARGET })
    ], 1, 'conflict', 'UI window connection 999 is not open')
    const browser = this.windows[0]!.page.context().browser()
    if (!browser) throw new CliFilesFailure('world-contract', 'owned browser is unavailable for the temporary page')
    const context = await this.readRenderer(() => browser.newContext({ viewport: { width: 1400, height: 1000 } }))
    const temporary: TemporaryRenderer = {
      context, page: null, connId: 0, contextClosed: false, pageClosed: false, connectionGone: false
    }
    this.temporaryPages.push(temporary)
    let uiBeforeClose: unknown
    let uiBeforeCloseReceiptId = ''
    try {
      temporary.page = await this.readRenderer(() => context.newPage())
      const page = temporary.page
      await this.readRenderer(() => page.goto(this.windows[0]!.page.url(), { waitUntil: 'domcontentloaded' }))
      const until = Math.min(this.workDeadline, Date.now() + 10_000)
      const discoverySignal = AbortSignal.timeout(Math.max(1, until - Date.now()))
      for (let attempt = 0; Date.now() < until; attempt++) {
        uiBeforeCloseReceiptId = `${builder.id}-third-open-${attempt}`
        uiBeforeClose = await this.requireSuccess(uiBeforeCloseReceiptId, ['ui', 'state'], { signal: discoverySignal })
        const ids = array(record(uiBeforeClose, 'third page UI state').windows, 'UI windows')
          .map(window => integer(record(window, 'UI window').connId, 'UI connection'))
          .filter(id => id !== connA && id !== connB)
        if (ids.length === 1) { temporary.connId = ids[0]!; break }
        if (ids.length > 1) throw new CliFilesFailure('connection-mismatch', 'temporary page discovered several new connections')
        await Bun.sleep(50)
      }
      if (!temporary.connId) throw new CliFilesFailure('renderer-disconnected', 'temporary UI page did not connect within ten seconds')
    } finally {
      await this.readRenderer(() => context.close())
      temporary.contextClosed = true
      temporary.pageClosed = temporary.page?.isClosed() ?? true
    }
    let uiAfterClose: unknown
    let uiAfterCloseReceiptId = ''
    const until = Math.min(this.workDeadline, Date.now() + 10_000)
    const closureSignal = AbortSignal.timeout(Math.max(1, until - Date.now()))
    for (let attempt = 0; Date.now() < until; attempt++) {
      uiAfterCloseReceiptId = `${builder.id}-third-closed-${attempt}`
      uiAfterClose = await this.requireSuccess(uiAfterCloseReceiptId, ['ui', 'state'], { signal: closureSignal })
      const listed = array(record(uiAfterClose, 'closed UI state').windows, 'closed UI windows')
        .some(window => record(window, 'closed UI window').connId === temporary.connId)
      if (!listed) { temporary.connectionGone = true; break }
      await Bun.sleep(50)
    }
    if (!temporary.connectionGone) throw new CliFilesFailure('renderer-disconnected', 'temporary UI connection survived its closed context')
    const disconnectedBaseline = await snapshot(`${builder.id}-disconnected-baseline`)
    await refused('disconnected-editor', [
      'editor', 'open', SENTINEL_PATH, '--worktree', b.id, '--window', String(temporary.connId)
    ], 1, 'conflict', `UI window connection ${temporary.connId} is not open`)
    await refused('disconnected-open-changes', [
      'api', 'call', 'ui.window.command.run', '--conn-id', String(temporary.connId),
      '--id', 'command:quirky.git/open-changes', '--args', JSON.stringify({ worktree: b.id })
    ], 1, 'conflict', `UI window connection ${temporary.connId} is not open`)
    const after = cases.at(-1)!.after.sample
    this.setObservationSamples(builder, initial.sample, after)
    builder.evidence.request = { worktreeId: b.id, connA, connB, connC: temporary.connId }
    builder.evidence.refusals = {
      initial, cases, disconnectedBaseline, uiBeforeClose, uiAfterClose,
      disconnected: {
        connId: temporary.connId, uiBeforeCloseReceiptId, uiAfterCloseReceiptId,
        listedBeforeClose: true, listedWhenCommandsRan: false, contextClosed: temporary.contextClosed, pageClosed: temporary.pageClosed
      }
    }
  }

  async reviewFocusWindow(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    const sentinels = this.fileSentinels
    if (!sentinels) throw new CliFilesFailure('missing-observation', 'window editor sentinel evidence is missing')
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-setup-a`)
    await this.navigateWindowToWorktree(1, a.id, `${builder.id}-setup-other-a`)
    await this.activateTab(`${builder.id}-sentinel-b`, sentinels.b.tabId)
    await this.focusBaseline(0, sentinels.a.tabId)
    await this.focusBaseline(1, sentinels.a.tabId)
    const reviewWorkspaceReceiptId = `${builder.id}-review-baseline`
    const workspace = await this.api(reviewWorkspaceReceiptId, 'quirky.terminal/workspace', { workspace: b.id })
    const tabs = reviewTabFor(workspace, reviewKey(b.id))
    equal(tabs.length, 1, `${builder.id} existing Review`)
    const tabId = string(tabs[0]!.id, 'existing Review tab')
    builder.evidence.request = { worktreeId: b.id, path: B_TARGET, targetConnectionId: this.windows[0]!.connId }
    const openDiffReceiptId = `${builder.id}-open-diff`
    const diff = await this.transition(openDiffReceiptId, () => this.runWindowCommand(
      openDiffReceiptId, this.windows[0]!.connId, 'command:quirky.git/open-diff', { worktree: b.id, path: B_TARGET }
    ), () => this.waitForDom(0, dom => dom.renderedTabId === tabId && dom.reviewCards.some(card =>
      card.path === B_TARGET && card.active && card.loaded && card.expanded), `${builder.id} focused file`))
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-reset-a`)
    await this.activateTab(`${builder.id}-reset-sentinel-b`, sentinels.b.tabId)
    await this.focusBaseline(0, sentinels.a.tabId)
    const openChangesReceiptId = `${builder.id}-open-changes`
    const changes = await this.transition(openChangesReceiptId, () => this.runWindowCommand(
      openChangesReceiptId, this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: b.id }
    ), () => this.waitForDom(0, dom => dom.renderedTabId === tabId && dom.reviewTabMounted, `${builder.id} focused changes`))
    this.setObservationSamples(builder, diff.before, changes.after)
    builder.evidence.focusWindow = { worktreeId: b.id, tabId, reviewWorkspaceReceiptId, openDiffReceiptId, openChangesReceiptId, diff, changes }
  }

  async reviewBackground(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    const sentinels = this.fileSentinels
    if (!sentinels) throw new CliFilesFailure('missing-observation', 'window editor sentinel evidence is missing')
    await this.navigateWindowToWorktree(0, a.id, `${builder.id}-setup-a`)
    await this.navigateWindowToWorktree(1, b.id, `${builder.id}-setup-b`)
    await this.activateTab(`${builder.id}-select-sentinel-b`, sentinels.b.tabId)
    await this.closeReview(b.id, `${builder.id}-close-existing`, 'terminal')
    await this.waitForDom(1, dom => dom.renderedTabId === sentinels.b.tabId && !dom.reviewTabMounted, `${builder.id} sentinel`)
    await this.focusBaseline(0, sentinels.a.tabId)
    await this.focusBaseline(1, sentinels.b.tabId)
    const coldReceiptId = `${builder.id}-cold-open`
    const coldStep = await this.transition(coldReceiptId, () => this.runWindowCommand(
      coldReceiptId, this.windows[0]!.connId, 'command:quirky.git/open-diff', { worktree: b.id, path: B_TARGET, focus: false }
    ))
    const reply = record(record(coldStep.result, 'cold envelope').result, 'cold Review reply')
    const tabId = string(reply.tabId, 'cold Review tab')
    this.reviewTabs.set(b.id, { worktreeId: b.id, tabId, connId: this.windows[1]!.connId })
    await this.activateTab(`${builder.id}-activate-cold`, tabId)
    await this.waitForDom(1, dom => dom.renderedTabId === tabId && dom.reviewCards.length === 2 &&
      dom.reviewCards.every(card => card.expanded && card.loaded) &&
      dom.reviewCards.some(card => card.path === B_TARGET && card.active), `${builder.id} cold activation`)
    const activated = await this.captureSample(`${builder.id}-cold-activated`)
    const mountedBefore = await this.captureSample(`${builder.id}-mounted-before`)
    const mountedHistoryBefore = await this.captureHistories(`${builder.id}-mounted-before-history`, mountedBefore)
    const inputBefore = record(tabById(mountedBefore.public[1]!.workspace, tabId)!.input, 'mounted input before')
    const mountedReceiptId = `${builder.id}-mounted-open`
    await this.runWindowCommand(mountedReceiptId, this.windows[1]!.connId, 'command:quirky.git/open-diff', {
      worktree: b.id, path: SENTINEL_PATH, focus: false
    })
    await Bun.sleep(500)
    const mountedAfter = await this.captureSample(`${builder.id}-mounted-after`)
    const mountedHistoryAfter = await this.captureHistories(`${builder.id}-mounted-after-history`, mountedAfter)
    const inputAfter = record(tabById(mountedAfter.public[1]!.workspace, tabId)!.input, 'mounted input after')
    await this.activateTab(`${builder.id}-activate-sentinel`, sentinels.b.tabId)
    await this.waitForDom(1, dom => !dom.reviewTabMounted && dom.renderedTabId === sentinels.b.tabId, `${builder.id} hidden Review`)
    const hidden = await this.captureSample(`${builder.id}-hidden`)
    await this.activateTab(`${builder.id}-activate-review`, tabId)
    await this.waitForDom(1, dom => dom.renderedTabId === tabId && dom.reviewCards.some(card =>
      card.path === SENTINEL_PATH && card.active && card.loaded && card.expanded), `${builder.id} deferred reveal`)
    const afterShow = await this.captureSample(`${builder.id}-reshown`)
    this.setObservationSamples(builder, coldStep.before, afterShow)
    builder.evidence.request = { worktreeId: b.id, targetConnectionId: this.windows[0]!.connId }
    builder.evidence.backgroundReview = {
      worktreeId: b.id, tabId, sentinelTabId: sentinels.b.tabId, coldReceiptId, mountedReceiptId,
      cold: {
        before: coldStep.before, after: { ...coldStep.after, activeTab: selectedTabId(coldStep.after.public[1]!.workspace) },
        activated,
        historyBefore: { a: coldStep.historyBefore.target, b: coldStep.historyBefore.other },
        historyAfter: { a: coldStep.historyAfter.target, b: coldStep.historyAfter.other }
      },
      mounted: {
        before: mountedBefore, after: mountedAfter, hidden, afterShow, inputBefore, inputAfter,
        scrollTopBefore: mountedBefore.dom[1]!.reviewScrollTop, scrollTopAfter: mountedAfter.dom[1]!.reviewScrollTop,
        historyBefore: { a: mountedHistoryBefore.target, b: mountedHistoryBefore.other },
        historyAfter: { a: mountedHistoryAfter.target, b: mountedHistoryAfter.other }
      }
    }
  }

  async captureOtherWindow(id: string) {
    const window = this.windows[1]!
    const receiptId = `${id}-window`
    const windowState = record(await this.api(receiptId, 'ui.window.state', { connId: window.connId }), `${id} other layout`)
    const dom = await this.readRenderer(() => window.page.evaluate(capturePageDom))
    dom.connId = window.connId
    const history = await this.captureNavigationHistory(`${id}-history`, window.connId,
      string(record(windowState.layout, `${id} other layout`).worktree, `${id} other worktree`))
    return { connId: window.connId, receiptId, windowState, dom, history }
  }

  async waitForStatus(id: string, worktree: string, ready: (status: JsonObject) => boolean): Promise<{ receiptId: string; result: JsonObject }> {
    const until = Math.min(this.workDeadline, Date.now() + CHILD_LIMIT_MS)
    for (let attempt = 0; Date.now() < until; attempt++) {
      const receiptId = `${id}-${attempt}`
      const result = await this.gitStatus(receiptId, worktree)
      if (ready(result)) return { receiptId, result }
      await Bun.sleep(50)
    }
    throw new CliFilesFailure('fixture-status', `${id} did not reach the required public Git status`)
  }

  async reviewSource(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    const id = builder.id
    await this.prepareGit(['add', '--', SENTINEL_PATH], b.path, `${id}-stage-docs`)
    const baseWritten = await this.prepareGit(['show', 'HEAD:README.md'], b.path, `${id}-read-initial-head`)
    const indexWritten = `${baseWritten}scope index λ\n`
    const workingWritten = `${indexWritten}scope working λ\n`
    this.writeFixture(b, 'README.md', indexWritten)
    await this.prepareGit(['add', '--', 'README.md'], b.path, `${id}-stage-readme`)
    this.writeFixture(b, 'README.md', workingWritten)
    const gitRead = async (label: string, ref: string) => {
      const bytes = await this.prepareGit(['show', ref], b.path, `${id}-${label}`)
      return { bytes, read: this.gitEvidence.at(-1)! }
    }
    const workingRead = (path: string) => {
      const absolutePath = join(b.path, path)
      const bytes = readFileSync(absolutePath)
      return { bytes: bytes.toString('utf8'), read: { path: absolutePath, bytesBase64: bytes.toString('base64') } }
    }
    const head = await gitRead('readme-head', 'HEAD:README.md')
    const index = await gitRead('readme-index', ':README.md')
    const working = workingRead('README.md')
    const docsHead = await gitRead('docs-head', `HEAD:${SENTINEL_PATH}`)
    const docsIndex = await gitRead('docs-index', `:${SENTINEL_PATH}`)
    const docsWorking = workingRead(SENTINEL_PATH)
    const appWorking = workingRead(B_TARGET)
    const written = { base: baseWritten, index: indexWritten, working: workingWritten }
    const readback = { base: head.bytes, index: index.bytes, working: working.bytes }
    equal(readback, written, `${id} independent README readbacks`)
    if (new Set(Object.values(readback)).size !== 3) throw new CliFilesFailure('fixture-bytes', 'README versions are not distinct')
    if (docsIndex.bytes !== docsWorking.bytes || docsHead.bytes === docsWorking.bytes) {
      throw new CliFilesFailure('fixture-bytes', 'docs fixture is not completely staged')
    }
    equal(appWorking.bytes, B_CONTENT, `${id} independent app working bytes`)
    assertSourceWorkingRead(working.read, join(b.path, 'README.md'), workingWritten, `${id} setup README`)
    assertSourceWorkingRead(docsWorking.read, join(b.path, SENTINEL_PATH), docsIndex.bytes, `${id} setup docs`)
    assertSourceWorkingRead(appWorking.read, join(b.path, B_TARGET), B_CONTENT, `${id} setup app`)
    const readme = {
      ...readback, absolutePath: join(b.path, 'README.md'), distinct: true, written, readback,
      gitReads: { base: head.read, index: index.read }, workingRead: working.read
    }
    const docs = {
      base: docsHead.bytes, index: docsIndex.bytes, working: docsWorking.bytes,
      absolutePath: join(b.path, SENTINEL_PATH), gitReads: { base: docsHead.read, index: docsIndex.read },
      workingRead: docsWorking.read
    }
    const entries = (status: JsonObject) => array(status.entries, `${id} entries`).map(entry => record(entry, 'Git status entry'))
    const paths = (status: JsonObject, areas: string[]) => [...new Set(entries(status)
      .filter(entry => areas.includes(String(entry.area))).map(entry => string(entry.path, 'status path')))].sort()
    const statusBefore = await this.waitForStatus(`${id}-status-before`, b.id, status =>
      status.capped === false &&
      JSON.stringify(paths(status, ['staged'])) === JSON.stringify(['README.md', SENTINEL_PATH]) &&
      JSON.stringify(paths(status, ['unstaged', 'untracked'])) === JSON.stringify(['README.md', B_TARGET]))
    const stagedPaths = paths(statusBefore.result, ['staged'])
    const unstagedPaths = paths(statusBefore.result, ['unstaged', 'untracked'])
    const wholePaths = [...new Set([...stagedPaths, ...unstagedPaths])].sort()
    await this.readRenderer(() => this.windows[0]!.page.setViewportSize({ width: 2400, height: 1400 }))
    await this.closeReview(b.id, `${id}-close-review`, 'terminal')
    await this.navigateWindowToWorktree(0, a.id, `${id}-setup-a`)
    await this.navigateWindowToWorktree(1, a.id, `${id}-setup-other-a`)
    if (!this.fileSentinels) throw new CliFilesFailure('missing-observation', 'source sentinel identity is missing')
    await this.focusBaseline(0, this.fileSentinels.a.tabId)
    await this.focusBaseline(1, this.fileSentinels.a.tabId)
    const scopes: Record<string, JsonObject> = {}
    let firstBefore: CapturedSample | undefined
    for (const name of ['staged', 'unstaged', 'whole'] as const) {
      const expectedPaths = name === 'staged' ? stagedPaths : name === 'unstaged' ? unstagedPaths : wholePaths
      const chip = name === 'staged' ? 'Staged changes' : name === 'unstaged' ? 'Unstaged changes' : null
      const commandId = name === 'staged' ? 'command:quirky.git/open-diff' : 'command:quirky.git/open-changes'
      const args = name === 'staged' ? { worktree: b.id, path: SENTINEL_PATH, source: 'staged' }
        : name === 'unstaged' ? { worktree: b.id, area: 'unstaged' } : { worktree: b.id }
      const receiptId = `${id}-${name}`
      const step = await this.transition(receiptId, async () => {
        const result = await this.runWindowCommand(receiptId, this.windows[0]!.connId, commandId, args)
        if (name === 'staged') {
          this.sourceReviewTabId = string(record(record(result, 'staged envelope').result, 'staged result').tabId, 'staged Review tab')
          this.reviewTabs.set(b.id, { worktreeId: b.id, tabId: this.sourceReviewTabId, connId: this.windows[0]!.connId })
        }
        return result
      }, () => this.waitForDom(0, dom => dom.reviewTabMounted && dom.reviewScopeChip === chip &&
        JSON.stringify(dom.reviewCards.map(card => card.path).sort()) === JSON.stringify(expectedPaths), `${id} ${name} card set`))
      firstBefore ??= step.before
      const supporting: JsonObject[] = []
      const support = async (label: string, command: string, input: JsonObject) => {
        const supportId = `${id}-${name}-${label}`
        await this.runWindowCommand(supportId, this.windows[0]!.connId, `command:quirky.git/${command}`, input)
        supporting.push({ receiptId: supportId, otherAfter: await this.captureOtherWindow(supportId) })
      }
      await support('expand', 'collapse-all', { collapsed: false })
      if (name !== 'unstaged') await support('load-docs', 'load-diff', { path: SENTINEL_PATH })
      const revealId = `${id}-${name}-reveal-readme`
      const reveal = await this.transition(revealId, () => this.runWindowCommand(
        revealId, this.windows[0]!.connId, 'command:quirky.git/open-diff',
        { worktree: b.id, path: 'README.md', ...(name === 'whole' ? {} : { source: name }) }
      ), () => this.waitForDom(0, dom => dom.reviewCards.some(card => card.path === 'README.md' && card.active), `${id} ${name} README reveal`))
      supporting.push({
        receiptId: revealId, before: reveal.before, after: reveal.after,
        historyBefore: reveal.historyBefore.target, historyAfter: reveal.historyAfter.target,
        otherHistoryBefore: reveal.historyBefore.other, otherHistoryAfter: reveal.historyAfter.other
      })
      await support('load-readme', 'load-diff', { path: 'README.md' })
      if (name !== 'staged') await support('load-app', 'load-diff', { path: B_TARGET })
      await this.waitForDom(0, dom => dom.reviewScopeChip === chip && dom.reviewCards.length === expectedPaths.length &&
        dom.reviewCards.every(card => card.expanded && card.loaded) &&
        dom.reviewCards.some(card => card.path === 'README.md' && card.mergeEditorCount === 2), `${id} ${name} loaded sides`)
      const final = await this.captureSample(`${id}-${name}-loaded`)
      scopes[name] = {
        receiptId, before: step.before, after: step.after,
        historyBefore: step.historyBefore.target, historyAfter: step.historyAfter.target,
        otherHistoryBefore: step.historyBefore.other, otherHistoryAfter: step.historyAfter.other,
        cardPaths: final.dom[0]!.reviewCards.map(card => card.path).sort(), chip: final.dom[0]!.reviewScopeChip,
        dom: final.dom, tabCount: tabsInWorkspace(final.public[0]!.workspace).filter(tab => tab.viewId === REVIEW_VIEW_ID).length,
        finalOther: {
          connId: final.public[1]!.connId, receiptId: final.public[1]!.receiptIds.window,
          windowState: final.public[1]!.windowState, dom: final.dom[1]!,
          history: await this.captureNavigationHistory(`${id}-${name}-final-other-history`, final.public[1]!.connId, shownWorktree(final.public[1]!))
        },
        supporting
      }
    }
    const statusAfterId = `${id}-status-after`
    await this.gitStatus(statusAfterId, b.id)
    const before = await this.captureSample(`${id}-refusal-before`)
    const historiesBefore = await this.captureHistories(`${id}-refusal-before-history`, before)
    const refusalId = `${id}-refused-staged`
    const refusal = await this.expectRefusal(refusalId, [
      'api', 'call', 'ui.window.command.run', '--conn-id', String(this.windows[0]!.connId),
      '--id', 'command:quirky.git/open-diff', '--args', JSON.stringify({ worktree: b.id, path: B_TARGET, source: 'staged' })
    ], { exitCode: 1, code: 'conflict', message: `${B_TARGET} has no staged changes.` })
    const after = await this.captureSample(`${id}-refusal-after`)
    const historiesAfter = await this.captureHistories(`${id}-refusal-after-history`, after)
    this.setObservationSamples(builder, firstBefore!, after)
    builder.evidence.request = { worktreeId: b.id, absolutePath: join(b.path, 'README.md'), targetConnectionId: this.windows[0]!.connId }
    builder.evidence.sourceReview = {
      worktreeId: b.id, tabId: this.sourceReviewTabId, readme, docs, appWorking: appWorking.read,
      status: { stagedPaths, unstagedPaths, wholePaths, beforeReceiptId: statusBefore.receiptId, afterReceiptId: statusAfterId },
      scopes,
      refusal: {
        receiptId: refusalId, ...refusal, before, after,
        beforeInput: tabById(before.public[0]!.workspace, this.sourceReviewTabId)!.input,
        afterInput: tabById(after.public[0]!.workspace, this.sourceReviewTabId)!.input,
        otherHistoryBefore: historiesBefore.other, otherHistoryAfter: historiesAfter.other
      }
    }
  }

  async changedModes(builder: ObservationBuilder): Promise<void> {
    const a = this.windows[0]!.worktree
    const b = this.windows[1]!.worktree
    const id = builder.id
    const sentinels = this.fileSentinels
    if (!sentinels || !this.sourceReviewTabId || !this.windowEditorTabId) {
      throw new CliFilesFailure('missing-observation', 'changed modes lack earlier editor/Review identities')
    }
    rmSync(join(b.path, 'README.md'))
    const status = await this.waitForStatus(`${id}-status`, b.id, result => {
      const entries = array(result.entries, `${id} status entries`).map(entry => record(entry, 'mode status entry'))
      return result.capped === false && JSON.stringify(entries.filter(entry => entry.path === 'README.md')
        .map(entry => `${entry.area}:${entry.status}`).sort()) === JSON.stringify(['staged:modified', 'unstaged:deleted'])
    })
    const entries = array(status.result.entries, `${id} entries`).map(entry => record(entry, 'changed-file status'))
    const paths = [...new Set(entries.map(entry => string(entry.path, 'changed path')))]
    const deleted = new Set(paths.filter(path => {
      const rows = entries.filter(entry => entry.path === path)
      return rows.some(entry => entry.area === 'unstaged' && entry.status === 'deleted') ||
        (rows.some(entry => entry.area === 'staged' && entry.status === 'deleted') &&
          !rows.some(entry => entry.area === 'unstaged' || entry.area === 'untracked'))
    }))
    const expectedEditPaths = paths.filter(path => !deleted.has(path)).sort()
    const expectedUnstagedPaths = paths.filter(path => !deleted.has(path) &&
      entries.some(entry => entry.path === path && (entry.area === 'unstaged' || entry.area === 'untracked'))).sort()
    await this.navigateWindowToWorktree(0, a.id, `${id}-setup-a`)
    await this.navigateWindowToWorktree(1, b.id, `${id}-setup-b`)
    await this.activateTab(`${id}-sentinel-b`, sentinels.b.tabId)
    await this.focusBaseline(0, sentinels.a.tabId)
    await this.focusBaseline(1, sentinels.b.tabId)
    const editId = `${id}-edit`
    const edit = await this.transition(editId, () => this.runWindowCommand(
      editId, this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: b.id, mode: 'edit', focus: false }
    ))
    await this.navigateWindowToWorktree(1, a.id, `${id}-other-on-a`)
    await this.focusBaseline(1, sentinels.a.tabId)
    const bothId = `${id}-both`
    const both = await this.transition(bothId, () => this.runWindowCommand(
      bothId, this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: b.id, mode: 'both' }
    ), () => this.waitForDom(0, dom => dom.renderedTabId === this.sourceReviewTabId && dom.reviewTabMounted, `${id} both Review`))
    await this.navigateWindowToWorktree(0, a.id, `${id}-edit-reset-a`)
    await this.focusBaseline(0, sentinels.a.tabId)
    const unstagedId = `${id}-edit-unstaged`
    const unstagedEdit = await this.transition(unstagedId, () => this.runWindowCommand(
      unstagedId, this.windows[0]!.connId, 'command:quirky.git/open-changes', { worktree: b.id, mode: 'edit', area: 'unstaged' }
    ), () => this.waitForDom(0, dom => dom.renderedTabId === this.windowEditorTabId && dom.path === join(b.path, B_TARGET), `${id} focused editor`))
    const result = record(record(unstagedEdit.result, 'unstaged envelope').result, 'unstaged edit result')
    const first = record(array(result.opened, 'unstaged opened')[0], 'first opened file')
    this.setObservationSamples(builder, edit.before, unstagedEdit.after)
    builder.evidence.request = { worktreeId: b.id, targetConnectionId: this.windows[0]!.connId }
    builder.evidence.changedModes = {
      worktreeId: b.id, editorTabId: this.windowEditorTabId, reviewTabId: this.sourceReviewTabId,
      sentinelTabId: sentinels.b.tabId, expectedEditPaths, expectedUnstagedPaths,
      status: { entries, receiptId: status.receiptId }, edit, both,
      unstagedEdit: { ...unstagedEdit, firstOpenedAbsolutePath: join(b.path, string(first.path, 'first opened path')) }
    }
  }

  async fileWindowScenarios(): Promise<void> {
    const recipes: Array<[string, (builder: ObservationBuilder) => Promise<void>]> = [
      ['files-editor-window-focus', builder => this.editorWindowFocus(builder)],
      ['files-window-refusals', builder => this.windowRefusals(builder)],
      ['files-review-focus-window', builder => this.reviewFocusWindow(builder)],
      ['files-review-background', builder => this.reviewBackground(builder)],
      ['files-review-source', builder => this.reviewSource(builder)],
      ['files-changed-modes', builder => this.changedModes(builder)]
    ]
    for (const [id, recipe] of recipes) {
      if (this.primaryFailure) break
      this.progress(id)
      await this.observation(id, recipe)
    }
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
    if (new Set(all).size !== EXPECTED_OBSERVATION_COUNT ||
        EXPECTED_OBSERVATIONS.some((id) => !all.includes(id)) || all.length !== EXPECTED_BINDING_COUNT) {
      throw new CliFilesFailure('invalid-table', 'file observation registry does not contain exactly thirteen observations')
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

  beginCleanup(): number {
    const deadline = Math.min(this.startedAt + WORK_LIMIT_MS + TEARDOWN_LIMIT_MS, Date.now() + TEARDOWN_LIMIT_MS)
    this.cleanupTimer ??= setTimeout(() => this.cleanupController.abort(
      new CliFilesFailure('cleanup-deadline', 'CLI file teardown exceeded its 30-second cleanup reserve')
    ), Math.max(1, deadline - Date.now()))
    return deadline
  }

  async cleanupTemporaryPages(): Promise<void> {
    for (const temporary of this.temporaryPages) {
      try {
        if (!temporary.contextClosed) {
          await this.readRenderer(() => temporary.context.close(), true)
          temporary.contextClosed = true
          temporary.pageClosed = temporary.page?.isClosed() ?? true
        }
        if (temporary.connId && !temporary.connectionGone) {
          const until = Math.min(this.startedAt + WORK_LIMIT_MS + TEARDOWN_LIMIT_MS, Date.now() + 10_000)
          for (let attempt = 0; Date.now() < until; attempt++) {
            const state = record(await this.requireSuccess(`cleanup-temporary-${temporary.connId}-${attempt}`,
              ['ui', 'state'], { cleanup: true }), 'temporary cleanup state')
            if (!array(state.windows, 'temporary cleanup windows').some(window =>
              record(window, 'temporary cleanup window').connId === temporary.connId)) {
              temporary.connectionGone = true
              break
            }
            await Bun.sleep(50)
          }
          if (!temporary.connectionGone) throw new CliFilesFailure('renderer-cleanup', 'temporary UI connection disappearance was not verified')
        }
      } catch (error) {
        this.cleanupFailure = [this.cleanupFailure, safeError(error).message].filter(Boolean).join('; ')
      }
    }
  }

  async cleanupOwnedTabs(): Promise<void> {
    if (!this.world || this.windows.length !== 2) return
    const cleanupDeadline = this.beginCleanup()
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
      sentinelAlive: this.sentinelAliveAfterWorld,
      temporaryPageIdentities: this.temporaryPages.map(page => ({
        connId: page.connId, contextClosed: page.contextClosed, pageClosed: page.pageClosed, connectionGone: page.connectionGone
      }))
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
      if (!this.primaryFailure) await this.fileWindowScenarios()
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
      this.beginCleanup()
      await this.cleanupTemporaryPages()
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
    const cleanupOk = !this.cleanupFailure && cleanup && this.cleanupEvidence.processIdentitiesGone === true && this.cleanupEvidence.sentinelAlive === true
    const ok = !this.primaryFailure && !this.cleanupFailure && cleanup && observedAll && this.guardEvidence?.injected === false
    const report: CliFilesReport = {
      schemaVersion: 1,
      scope: 'goal-11-cli-files',
      ok,
      parityComplete: isCliFilesParityComplete(ok, cleanupOk, reportRows),
      rows: reportRows,
      observations: EXPECTED_OBSERVATIONS.map((id) => this.observations.get(id) ?? placeholder(id)),
      receipts: this.receipts,
      cleanup: {
        ok: cleanupOk,
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
