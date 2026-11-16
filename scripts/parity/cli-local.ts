import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CliCheckContext } from './cli-checks'

export const LOCAL_CHECK_IDS = [
  'local-worktree-current',
  'local-repo-clone', 'local-repo-create', 'local-repo-set', 'local-repo-remove', 'local-search-refs',
  'local-terminal-sessions', 'local-tab-rename', 'local-pane-split', 'local-pane-read', 'local-pane-title', 'local-pane-get', 'local-tab-activate',
  'local-hooks-status', 'local-hooks-setup', 'local-hooks-remove',
  'local-account-add-claude', 'local-account-login-claude', 'local-account-add-codex', 'local-account-login-codex',
  'local-account-remove-claude', 'local-account-remove-codex'
] as const

type ObjectValue = Record<string, unknown>
type RefKind = 'branch' | 'tag' | 'remote-branch'
type ExpectedAccount = { id: string; label: string; email: string }

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function nonEmptyText(value: unknown, label: string): string {
  const result = text(value, label)
  if (result.length === 0) throw new Error(`${label} must not be empty`)
  return result
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} did not match the expected value`)
}

function field(value: unknown, key: string, label: string): unknown {
  return object(value, label)[key]
}

function stringField(value: unknown, key: string, label: string): string {
  return text(field(value, key, label), `${label}.${key}`)
}

function listObjects(value: unknown, label: string): ObjectValue[] {
  return array(value, label).map((entry, index) => object(entry, `${label}[${index}]`))
}


function errorKind(kind: string, message: string): Error {
  return Object.assign(new Error(message), { kind })
}

function parseJsonText(content: string, label: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error })
  }
}

function expectedDocument(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value
}

function containsDeep(value: unknown, expected: unknown): boolean {
  if (isDeepStrictEqual(value, expected)) return true
  if (Array.isArray(value)) return value.some(entry => containsDeep(entry, expected))
  if (isObject(value)) return Object.values(value).some(entry => containsDeep(entry, expected))
  return false
}
function containsString(value: unknown, expected: string): boolean {
  if (typeof value === 'string') return value.includes(expected)
  if (Array.isArray(value)) return value.some(entry => containsString(entry, expected))
  if (isObject(value)) return Object.values(value).some(entry => containsString(entry, expected))
  return false
}

function pathsInHome(entries: ObjectValue[], home: string): void {
  for (const [entryIndex, entry] of entries.entries()) {
    const files = array(entry.files, `hook status[${entryIndex}].files`)
    for (const [fileIndex, rawPath] of files.entries()) {
      const path = text(rawPath, `hook status[${entryIndex}].files[${fileIndex}]`)
      ensure(isAbsolute(path) && pathIsUnder(home, path), `hook status path escaped HOME: ${path}`)
    }
  }
}

function tabRecords(value: unknown): ObjectValue[] {
  const found = new Map<string, ObjectValue>()
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!isObject(current)) return
    if (typeof current.id === 'string' && current.root !== undefined) found.set(current.id, current)
    if (Array.isArray(current.tabs)) {
      for (const tab of current.tabs) {
        if (isObject(tab) && typeof tab.id === 'string') found.set(tab.id, tab)
        visit(tab)
      }
    }
    for (const [key, child] of Object.entries(current)) if (key !== 'tabs') visit(child)
  }
  visit(value)
  return [...found.values()]
}

function paneRecords(value: unknown): ObjectValue[] {
  const found: ObjectValue[] = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit)
      return
    }
    if (!isObject(current)) return
    if (current.kind === 'pane') found.push(current)
    for (const child of Object.values(current)) visit(child)
  }
  visit(value)
  return found
}

function containsPane(value: unknown, paneId: string, sessionId: string): boolean {
  return paneRecords(value).some(pane => pane.id === paneId && pane.session === sessionId)
}

function namedTab(layout: unknown, tabId: string): ObjectValue {
  const tab = tabRecords(layout).find(candidate => candidate.id === tabId)
  if (!tab) throw new Error(`terminal layout omitted tab ${tabId}`)
  return tab
}

function statusEntries(value: unknown, label: string): ObjectValue[] {
  if (Array.isArray(value)) return listObjects(value, label)
  const result = object(value, label)
  return listObjects(result.hooks ?? result.entries, `${label}.hooks`)
}

export function assertWorktreeCurrent(
  value: { nested: unknown; main: unknown; outside: { code: string; message: string } },
  expected: { worktreeId: string; worktreePath: string; repoId: string }
): void {
  const nested = object(value.nested, 'nested worktree current')
  equal(nested.id, expected.worktreeId, 'nested current worktree ID')
  equal(nested.path, expected.worktreePath, 'nested current worktree path')
  const main = object(value.main, 'main worktree current')
  equal(main.isMain, true, 'main current isMain')
  equal(main.repoId, expected.repoId, 'main current repository ID')
  equal(value.outside.code, 'not-found', 'outside current refusal code')
  equal(value.outside.message, 'no worktree matches current; use id:, name:, branch:, path: or current', 'outside current refusal message')
}

export function assertRepoClone(
  value: { result: unknown; fixtureBytes: Uint8Array; originUrl: string },
  expected: { name: string; path: string; originUrl: string; fixtureText: string }
): void {
  const result = object(value.result, 'repo clone result')
  equal(result.kind, 'git', 'repo clone kind')
  equal(result.name, expected.name, 'repo clone name')
  equal(result.path, expected.path, 'repo clone path')
  ensure(Buffer.from(value.fixtureBytes).equals(Buffer.from(expected.fixtureText, 'utf8')), 'repo clone fixture bytes differ')
  equal(value.originUrl, expected.originUrl, 'repo clone origin URL')
}

export function assertRepoCreated(value: unknown, expectedPath: string): void {
  const result = object(value, 'repo create result')
  equal(result.kind, 'git', 'repo create kind')
  equal(result.path, expectedPath, 'repo create path')
}

export function assertRepoSet(value: { updated: unknown; cleared: unknown; worktreeLocation: string }): void {
  const updated = object(value.updated, 'repo set result')
  const updatedRepo = object(updated.repo, 'repo set result.repo')
  const updatedSettings = object(updated.settings, 'repo set result.settings')
  equal(updatedRepo.displayName, 'CLI parity setup', 'repo set display name')
  equal(updatedSettings.worktreeLocation, value.worktreeLocation, 'repo set worktree location')
  const cleared = object(value.cleared, 'repo set clear result')
  equal(object(cleared.repo, 'repo set clear result.repo').displayName, null, 'cleared repo display name')
  equal(object(cleared.settings, 'repo set clear result.settings').worktreeLocation, value.worktreeLocation, 'cleared worktree location')
}

export function assertRepoRemoved(value: {
  cloneRemoved: unknown; createdRemoved: unknown; repos: unknown; cloneFileExists: boolean; createdHeadExists: boolean;
  cloneId: string; createdId: string; fixtureId: string; folderId: string; missingRefusal: { code: string; message: string }
}): void {
  equal(object(value.cloneRemoved, 'clone repo rm result').ok, true, 'clone repo rm result')
  equal(object(value.createdRemoved, 'created repo rm result').ok, true, 'created repo rm result')
  const ids = new Set(listObjects(value.repos, 'repo list after removal').map((entry, index) => stringField(entry, 'id', `repo list after removal[${index}]`)))
  ensure(!ids.has(value.cloneId) && !ids.has(value.createdId), 'repo list still contained a removed project')
  ensure(ids.has(value.fixtureId) && ids.has(value.folderId), 'repo list lost a retained fixture project')
  equal(value.cloneFileExists, true, 'clone files were preserved')
  equal(value.createdHeadExists, true, 'created repo files were preserved')
  equal(value.missingRefusal.code, 'not-found', 'unknown repo refusal code')
  equal(value.missingRefusal.message, 'no repo matches id:does-not-exist; use id:, name: or path:', 'unknown repo refusal message')
}

export function assertSearchRefs(value: unknown, expectedHead: string): void {
  const result = object(value, 'repo search refs result')
  const refs = listObjects(result.refs, 'repo search refs result.refs')
  const expected: Array<{ name: string; kind: RefKind; ref: string }> = [
    { name: 'cli-parity-both', kind: 'branch', ref: 'refs/heads/cli-parity-both' },
    { name: 'cli-parity-topic', kind: 'branch', ref: 'refs/heads/cli-parity-topic' },
    { name: 'cli-parity-both', kind: 'tag', ref: 'refs/tags/cli-parity-both' },
    { name: 'cli-parity-v1', kind: 'tag', ref: 'refs/tags/cli-parity-v1' }
  ]
  equal(refs.map(({ name, kind, ref }) => ({ name, kind, ref })), expected, 'search refs order and identity')
  ensure(refs.every(ref => ref.target === expectedHead), 'search refs did not resolve to the worktree head')
  equal(result.truncated, false, 'search refs truncation')
  const limited = object(result.limited, 'limited search refs result')
  equal(limited.refs, refs.slice(0, 3), 'limited search refs')
  equal(limited.truncated, true, 'limited search refs truncation')
  const insensitive = object(result.caseInsensitive, 'case-insensitive search refs result')
  const insensitiveRefs = listObjects(insensitive.refs, 'case-insensitive search refs')
  equal(insensitiveRefs.map(ref => ({ name: ref.name, kind: ref.kind, ref: ref.ref, target: ref.target })), [
    { name: 'cli-parity-v1', kind: 'tag', ref: 'refs/tags/cli-parity-v1', target: expectedHead }
  ], 'case-insensitive search refs')
  equal(insensitive.truncated, false, 'case-insensitive search refs truncation')
  const folderRefusal = object(result.folderRefusal, 'folder search refusal')
  equal(folderRefusal.code, 'invalid-params', 'folder search refusal code')
  equal(folderRefusal.message, `${text(result.folderName, 'plain-folder project name')} is not a Git repository`, 'folder search refusal message')
  equal(object(folderRefusal.data, 'folder search refusal data').reason, 'not-git', 'folder search refusal reason')
}

function terminalSessions(value: unknown): ObjectValue[] {
  return listObjects(object(value, 'terminal sessions').sessions, 'terminal sessions.sessions')
}

export function assertTerminalSessions(value: {
  sessions: unknown; layout: unknown; sessionId: string; tabId: string; paneId: string; worktreeId: string; worktreePath: string
}): void {
  const matches = terminalSessions(value.sessions).filter(session => session.sessionId === value.sessionId)
  ensure(matches.length === 1, `terminal sessions did not contain exactly one ${value.sessionId}`)
  const session = matches[0]!
  equal(session.state, 'running', 'terminal session state')
  ensure(typeof session.pid === 'number' && session.pid > 0, 'terminal session PID must be positive')
  equal(session.worktreeId, value.worktreeId, 'terminal session worktree')
  equal(session.cwd, value.worktreePath, 'terminal session cwd')
  const tab = namedTab(value.layout, value.tabId)
  ensure(containsPane(tab, value.paneId, value.sessionId), 'terminal layout did not place the session pane in its tab')
}

export function assertTabRename(value: { renamedLayout: unknown; clearedLayout: unknown; tabId: string }): void {
  const renamed = namedTab(value.renamedLayout, value.tabId)
  equal(renamed.customTitle, 'cli-parity-tab', 'renamed tab custom title')
  equal(renamed.defaultTitle, 'cli-parity-local', 'renamed tab default title')
  const cleared = namedTab(value.clearedLayout, value.tabId)
  equal(cleared.customTitle, null, 'cleared tab custom title')
}

export function assertPaneSplit(value: unknown, first: { session: string; pane: string }): { session: string; pane: string } {
  const split = object(value, 'terminal pane split result')
  const session = nonEmptyText(split.session, 'terminal pane split session')
  const pane = nonEmptyText(split.pane, 'terminal pane split pane')
  ensure(session !== first.session && pane !== first.pane, 'terminal pane split reused the original session or pane')
  return { session, pane }
}

export function assertPaneRead(value: unknown, worktreePath: string): void {
  const lines = array(object(value, 'terminal pane read result').lines, 'terminal pane read result.lines')
    .map((line, index) => text(line, `terminal pane read result.lines[${index}]`))
  ensure(lines.join('').includes(`SPLIT:${worktreePath}`), 'terminal pane output omitted the live SPLIT:$PWD marker')
}

export function assertPaneTitle(value: {
  titled: unknown; byFirstSession: unknown; cleared: unknown;
  expected: { worktreeId: string; tabId: string; paneId: string; sessionId: string; firstPaneId: string; firstSessionId: string }
}): void {
  const titled = object(value.titled, 'pane get by pane ID')
  equal(titled.workspace, value.expected.worktreeId, 'pane workspace')
  equal(titled.tab, value.expected.tabId, 'pane tab')
  equal(titled.active, true, 'titled pane active')
  const titledPane = object(titled.pane, 'pane get by pane ID.pane')
  equal(titledPane.id, value.expected.paneId, 'titled pane ID')
  equal(titledPane.session, value.expected.sessionId, 'titled pane session')
  equal(titledPane.title, 'cli-parity-pane', 'pane title')
  const first = object(value.byFirstSession, 'pane get by first session')
  equal(first.active, false, 'original pane active state')
  const firstPane = object(first.pane, 'pane get by first session.pane')
  equal(firstPane.id, value.expected.firstPaneId, 'original pane ID')
  equal(firstPane.session, value.expected.firstSessionId, 'original pane session')
  equal(firstPane.title, null, 'original pane title')
  const clearedPane = object(object(value.cleared, 'cleared pane get').pane, 'cleared pane get.pane')
  equal(clearedPane.title, null, 'cleared pane title')
}

export function assertTabActivation(value: {
  layout: unknown; groupId: string; tabId: string; refusal: { code: string; message: string }; sessions: unknown; sessionIds: string[]
}): void {
  const { workspace, group } = layoutGroup(value.layout, value.tabId)
  equal(workspace.activeGroup, value.groupId, 'active terminal group')
  equal(group.id, value.groupId, 'terminal group ID')
  equal(group.activeTab, value.tabId, 'active terminal tab')
  equal(value.refusal.code, 'not-found', 'unknown tab refusal code')
  equal(value.refusal.message, 'no tab tab-does-not-exist', 'unknown tab refusal message')
  const openSessions = new Set(terminalSessions(value.sessions).map((session, index) => {
    const id = session.sessionId ?? session.id
    return text(id, `terminal sessions after tab close[${index}].sessionId`)
  }))
  ensure(value.sessionIds.every(id => !openSessions.has(id)), 'tab close left a local session open')
}

export function assertHooksStatus(value: { entries: unknown; codexDocument: string; home: string; hookFile: string; userDocument: unknown }): void {
  const entries = statusEntries(value.entries, 'agent-status hooks status')
  equal(entries.length, 28, 'hook status entry count')
  pathsInHome(entries, value.home)
  const codex = entries.find(entry => entry.agent === 'codex')
  ensure(codex !== undefined, 'hook status omitted codex')
  equal(codex.status, 'not-installed', 'codex hook status after removal')
  equal(codex.files, [value.hookFile], 'codex hook status files')
  equal(parseJsonText(value.codexDocument, 'Codex hooks document'), expectedDocument(value.userDocument), 'user-owned Codex hook document')
}

export function assertHooksSetup(value: {
  setup: unknown; status: unknown; repeated: unknown; codexDocument: string; hookFile: string; home: string; userDocument: unknown
}): void {
  const setup = listObjects(value.setup, 'Codex hooks setup result')
  equal(setup.length, 1, 'Codex hooks setup result count')
  equal(setup[0]!.agent, 'codex', 'hooks setup agent')
  equal(setup[0]!.status, 'installed', 'hooks setup status')
  equal(setup[0]!.changed, [value.hookFile], 'hooks setup changed paths')
  const status = statusEntries(value.status, 'agent-status hooks status after setup')
  equal(status.length, 28, 'hook status entry count after setup')
  pathsInHome(status, value.home)
  const codex = status.find(entry => entry.agent === 'codex')
  ensure(codex !== undefined, 'hook status omitted codex after setup')
  equal(codex.status, 'installed', 'codex hook status after setup')
  const repeated = listObjects(value.repeated, 'repeated Codex hooks setup result')
  equal(repeated.length, 1, 'repeated hooks setup result count')
  equal(repeated[0]!.changed, [], 'repeated hooks setup changed paths')
  const document = parseJsonText(value.codexDocument, 'Codex hooks document after setup')
  const userHooks = object(object(expectedDocument(value.userDocument), 'user hook document').hooks, 'user hook document.hooks')
  const userStopHook = array(userHooks.Stop, 'user hook document.hooks.Stop')[0]
  ensure(userStopHook !== undefined && containsDeep(document, userStopHook), 'Codex hooks setup lost the user-owned entry')
  ensure(containsString(document, '/bin/quirky-hook\" codex'), 'Codex hooks setup omitted Quirky managed hook')
}

export function assertHooksRemoved(value: { removals: unknown; codexDocument: string; hookFile: string; userDocument: unknown }): void {
  const removals = listObjects(value.removals, 'Codex hooks removal results')
  ensure(removals.length > 0, 'Codex hooks removal result was empty')
  for (const [index, removal] of removals.entries()) {
    equal(removal.agent, 'codex', `hooks removal[${index}] agent`)
    equal(removal.changed, [value.hookFile], `hooks removal[${index}] changed paths`)
  }
  equal(parseJsonText(value.codexDocument, 'Codex hooks document after removal'), expectedDocument(value.userDocument), 'user-owned Codex hook document after removal')
}

export function assertAccountAdd(value: unknown, label: string): { id: string; accountId: string } {
  const result = object(value, `${label} account add result`)
  equal(result.status, 'pending', 'account add status')
  return { id: nonEmptyText(result.id, 'account add login ID'), accountId: nonEmptyText(result.accountId, 'account add account ID') }
}

export function assertAccountLogin(value: unknown, expected: ExpectedAccount): void {
  const login = object(value, 'account login status')
  equal(login.status, 'complete', 'account login status')
  equal(login.error, null, 'account login error')
  const result = object(login.result, 'account login result')
  equal(result.id, expected.id, 'account login result ID')
  equal(result.label, expected.label, 'account login result label')
  equal(result.email, expected.email, 'account login result email')
  equal(result.needsSignIn, false, 'account login needsSignIn')
}

export function assertAccountsPresent(value: unknown, expected: { claudeId: string; codexId: string }): void {
  const listing = object(value, 'accounts list after local sign-in')
  const accounts = listObjects(listing.accounts, 'accounts list after local sign-in.accounts')
  ensure(accounts.some(account => account.id === expected.claudeId), 'accounts list omitted the Claude account')
  ensure(accounts.some(account => account.id === expected.codexId), 'accounts list omitted the Codex account')
  const active = object(listing.active, 'accounts list active providers')
  equal(active.claude, null, 'active Claude account')
  equal(active.codex, expected.codexId, 'active Codex account')
}

export function assertAccountsRemoved(value: { removed: unknown; listed: unknown; profiles: { claude: unknown; codex: unknown } }): void {
  const assertEmpty = (raw: unknown, label: string): void => {
    const result = object(raw, label)
    equal(result.accounts, [], `${label} accounts`)
    equal(result.active, { claude: null, codex: null }, `${label} active accounts`)
  }
  assertEmpty(value.removed, 'accounts remove result')
  assertEmpty(value.listed, 'accounts list after removal')
  equal(value.profiles.claude, [], 'Claude private profile directory')
  equal(value.profiles.codex, [], 'Codex private profile directory')
}

export function assertNoOutsideCalls(paths: { egressLog: string; orcaLog: string; securityLog: string }): void {
  const egress = readFileSync(paths.egressLog, 'utf8')
  const sentinel = 'https://cli-parity-guard.invalid/self-test\n'
  if (egress !== sentinel) {
    const lines = egress.split(/\r?\n/)
    const first = lines[0] === 'https://cli-parity-guard.invalid/self-test' ? lines[1] : lines[0]
    throw errorKind('outside-call', `unexpected egress line: ${first || '<missing>'}`)
  }
  const orca = readFileSync(paths.orcaLog, 'utf8')
  if (orca.length > 0) throw errorKind('outside-call', `unexpected Orca call: ${orca.split(/\r?\n/)[0] || '<empty line>'}`)
  const securityLines = readFileSync(paths.securityLog, 'utf8').split(/\r?\n/).filter(Boolean)
  const invalid = securityLines.find(line => !line.startsWith('find-generic-password ') && !line.startsWith('delete-generic-password '))
  if (invalid) throw errorKind('outside-call', `unexpected security command: ${invalid}`)
}

async function productCall(
  context: CliCheckContext, receiptId: string, argv: string[], checkId = receiptId, options?: { cwd?: string }
): Promise<unknown> {
  context.check(checkId)
  return context.call(receiptId, argv, 'json', options)
}

async function productRefusal(
  context: CliCheckContext, receiptId: string, argv: string[], checkId: string, options?: { cwd?: string }
): Promise<{ code: string; message: string; data?: unknown }> {
  context.check(checkId)
  return context.refuse(receiptId, argv, options)
}

async function poll<T>(
  context: CliCheckContext, checkId: string, label: string, read: (attempt: number) => Promise<T>, ready: (value: T) => boolean, timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let last: T | undefined
  while (Date.now() < deadline) {
    context.check(checkId)
    last = await read(attempt++)
    if (ready(last)) return last
    const remaining = deadline - Date.now()
    if (remaining > 0) await Bun.sleep(Math.min(100, remaining))
  }
  throw new Error(`Timed out waiting for ${label}${last === undefined ? '' : `; last result ${JSON.stringify(last)}`}`)
}

function requiredState(context: CliCheckContext, key: string): string {
  return nonEmptyText(context.state[key], `check state.${key}`)
}


function worktreeHead(path: string, env: Record<string, string>): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path, env, encoding: 'utf8' })
    return nonEmptyText(head.trim(), 'worktree head')
  } catch (error) {
    throw new Error('could not read the worktree head', { cause: error })
  }
}

function pathIsUnder(root: string, candidate: string): boolean {
  const path = resolve(candidate)
  const fromRoot = relative(resolve(root), path)
  return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
}

async function runWorktreeCurrent(context: CliCheckContext): Promise<void> {
  const worktreeId = requiredState(context, 'worktreeId')
  const worktreePath = requiredState(context, 'worktreePath')
  const repoPath = realpathSync(context.world.paths.repository)
  const nested = join(worktreePath, 'nested dir')
  const outsidePath = join(context.world.home, 'tmp')
  mkdirSync(nested, { recursive: true })
  mkdirSync(outsidePath, { recursive: true })
  const current = await productCall(context, 'local-worktree-current', ['worktree', 'show', 'current'], 'local-worktree-current', { cwd: nested })
  const main = await productCall(context, 'local-worktree-current-main', ['worktree', 'show', 'current'], 'local-worktree-current', { cwd: repoPath })
  const outside = await productRefusal(context, 'local-worktree-current-outside', ['worktree', 'show', 'current'], 'local-worktree-current', { cwd: outsidePath })
  assertWorktreeCurrent({ nested: current, main, outside }, {
    worktreeId, worktreePath, repoId: requiredState(context, 'repoId')
  })
  context.prove('local-worktree-current', { nestedId: worktreeId, mainIsMain: true, outside: outside.code })
}

async function runRepoSetup(context: CliCheckContext): Promise<void> {
  const world = context.world
  const fixturePath = realpathSync(world.paths.repository)
  const fixtureText = 'first\nsecond λ\n'
  const cloneLocation = join(world.home, 'repositories', 'clones')
  const clonePath = join(cloneLocation, 'cli-parity-clone')
  const clone = object(await productCall(context, 'local-repo-clone', [
    'repo', 'clone', fixturePath, '--location', cloneLocation, '--name', 'cli-parity-clone'
  ]), 'repo clone result')
  const cloneId = nonEmptyText(clone.id, 'repo clone ID')
  context.state.localCloneId = cloneId
  const cloneRealPath = realpathSync(clonePath)
  const originConfig = readFileSync(join(cloneRealPath, '.git', 'config'), 'utf8')
  const originUrl = originConfig.match(/\[remote "origin"\][\s\S]*?^\s*url\s*=\s*(.+)$/m)?.[1]?.trim()
  ensure(originUrl !== undefined, 'repo clone did not configure origin URL')
  assertRepoClone({ result: clone, fixtureBytes: readFileSync(join(cloneRealPath, 'fixture.txt')), originUrl }, {
    name: 'cli-parity-clone', path: cloneRealPath, originUrl: fixturePath, fixtureText
  })
  const repeated = await productRefusal(context, 'local-repo-clone-repeat', [
    'repo', 'clone', fixturePath, '--location', cloneLocation, '--name', 'cli-parity-clone'
  ], 'local-repo-clone')
  equal(repeated.code, 'conflict', 'repeated clone refusal code')
  ensure(repeated.message.startsWith('destination exists: '), 'repeated clone refusal message did not name existing destination')
  context.prove('local-repo-clone', { kind: 'git', name: 'cli-parity-clone', path: cloneRealPath, originUrl })

  const createLocation = join(world.home, 'repositories', 'created')
  const createdPath = join(createLocation, 'cli-parity-created')
  const created = object(await productCall(context, 'local-repo-create', [
    'repo', 'create', 'cli-parity-created', '--location', createLocation
  ]), 'repo create result')
  const createdId = nonEmptyText(created.id, 'repo create ID')
  context.state.localCreatedRepoId = createdId
  const createdRealPath = realpathSync(createdPath)
  assertRepoCreated(created, createdRealPath)
  ensure(existsSync(join(createdRealPath, '.git', 'HEAD')), 'repo create omitted .git/HEAD')
  context.prove('local-repo-create', { kind: 'git', path: createdRealPath })

  const worktreeLocation = join(world.home, 'worktrees', 'clone-base')
  await productCall(context, 'local-repo-set', [
    'repo', 'set', cloneId, '--display-name', 'CLI parity setup', '--worktree-location', worktreeLocation
  ])
  const shown = await productCall(context, 'local-repo-set-show', ['repo', 'show', cloneId], 'local-repo-set')
  const cleared = await productCall(context, 'local-repo-set-clear', ['repo', 'set', cloneId, '--display-name', ''], 'local-repo-set')
  assertRepoSet({ updated: shown, cleared, worktreeLocation: resolve(worktreeLocation) })
  const shownRepo = object(field(shown, 'repo', 'repo show result'), 'repo show result.repo')
  equal(shownRepo.displayName, 'CLI parity setup', 'repo show display name')
  equal(object(field(shown, 'settings', 'repo show result'), 'repo show result.settings').worktreeLocation, resolve(worktreeLocation), 'repo show worktree location')
  context.prove('local-repo-set', { displayName: 'CLI parity setup', clearedDisplayName: null, worktreeLocation: resolve(worktreeLocation) })

  const cloneRemoved = await productCall(context, 'local-repo-remove', ['repo', 'rm', cloneId])
  context.state.localCloneRemoved = true
  const createdRemoved = await productCall(context, 'local-repo-remove-created', ['repo', 'rm', createdId], 'local-repo-remove')
  context.state.localCreatedRepoRemoved = true
  const list = await productCall(context, 'local-repo-remove-list', ['repo', 'list'], 'local-repo-remove')
  const missing = await productRefusal(context, 'local-repo-remove-missing', ['repo', 'rm', 'id:does-not-exist'], 'local-repo-remove')
  assertRepoRemoved({
    cloneRemoved, createdRemoved, repos: list,
    cloneFileExists: existsSync(join(cloneRealPath, 'fixture.txt')),
    createdHeadExists: existsSync(join(createdRealPath, '.git', 'HEAD')),
    cloneId, createdId, fixtureId: requiredState(context, 'repoId'), folderId: requiredState(context, 'folderId'), missingRefusal: missing
  })
  context.prove('local-repo-remove', { cloneRemoved: true, createdRemoved: true, filesPreserved: true, unknown: missing.code })
}

async function runSearchRefs(context: CliCheckContext): Promise<void> {
  const repoId = requiredState(context, 'repoId')
  const full = await productCall(context, 'local-search-refs', ['repo', 'search-refs', repoId, '--query', 'cli-parity-'])
  const worktreePath = requiredState(context, 'worktreePath')
  const head = worktreeHead(worktreePath, context.world.env)
  const limited = await productCall(context, 'local-search-refs-limit', ['repo', 'search-refs', repoId, '--query', 'cli-parity-', '--limit', '3'], 'local-search-refs')
  const insensitive = await productCall(context, 'local-search-refs-case', ['repo', 'search-refs', repoId, '--query', 'CLI-PARITY-V1'], 'local-search-refs')
  const folderName = basename(context.world.paths.folder)
  const refusal = await productRefusal(context, 'local-search-refs-folder', [
    'repo', 'search-refs', requiredState(context, 'folderId'), '--query', 'x'
  ], 'local-search-refs')
  const refusalRecord = refusal as { code: string; message: string; data?: unknown }
  assertSearchRefs({ ...object(full, 'search refs full result'), limited, caseInsensitive: insensitive, folderRefusal: refusalRecord, folderName }, head)
  context.prove('local-search-refs', {
    names: listObjects(object(full, 'search refs full result').refs, 'search refs').map(ref => ref.name),
    truncated: object(full, 'search refs full result').truncated,
    allTargetHead: listObjects(object(full, 'search refs full result').refs, 'search refs').every(ref => ref.target === head)
  })
}

function groupWithActiveTab(node: unknown, activeTab: string): ObjectValue | undefined {
  if (!isObject(node)) return undefined
  if (node.kind === 'group' && node.activeTab === activeTab) return node
  return groupWithActiveTab(node.first, activeTab) ?? groupWithActiveTab(node.second, activeTab)
}

function layoutGroup(layout: unknown, activeTab: string): { workspace: ObjectValue; group: ObjectValue } {
  const top = object(layout, 'terminal layout')
  const workspace = isObject(top.workspace) ? top.workspace : top
  const group = groupWithActiveTab(workspace.root, activeTab)
  ensure(group !== undefined, `terminal layout did not activate tab ${activeTab} in any group`)
  return { workspace, group }
}

async function runTerminalChecks(context: CliCheckContext): Promise<void> {
  const worktreeId = requiredState(context, 'worktreeId')
  const worktreePath = requiredState(context, 'worktreePath')
  const before = await productCall(context, 'local-terminal-sessions-before', ['terminal', 'layout', '--worktree', worktreeId], 'local-terminal-sessions')
  const baselineTabs = tabRecords(before).map(tab => text(tab.id, 'existing terminal tab ID'))
  context.state.localTerminalBaseline = baselineTabs
  context.state.localTabIds = []
  context.state.localClosedTabIds = []
  context.state.localTerminalCreationStarted = true
  const created = object(await productCall(context, 'local-terminal-sessions', [
    'terminal', 'tab', 'new', '--worktree', worktreeId, '--agent', 'shell', '--title', 'cli-parity-local'
  ]), 'terminal tab new result')
  const sessionId = nonEmptyText(created.session, 'new terminal session')
  const tabId = nonEmptyText(created.tab, 'new terminal tab')
  const paneId = nonEmptyText(created.pane, 'new terminal pane')
  context.state.localTabIds = [tabId]
  const sessions = await productCall(context, 'local-terminal-sessions-read', ['terminal', 'sessions'], 'local-terminal-sessions')
  const layout = await productCall(context, 'local-terminal-layout-read', ['terminal', 'layout', '--worktree', worktreeId], 'local-terminal-sessions')
  assertTerminalSessions({ sessions, layout, sessionId, tabId, paneId, worktreeId, worktreePath })
  context.prove('local-terminal-sessions', { sessionId, tabId, paneId, state: 'running', worktreeId, cwd: worktreePath })

  await productCall(context, 'local-tab-rename', ['terminal', 'tab', 'rename', tabId, 'cli-parity-tab'])
  const renamedLayout = await productCall(context, 'local-tab-rename-read', ['terminal', 'layout', '--worktree', worktreeId], 'local-tab-rename')
  await productCall(context, 'local-tab-rename-clear', ['terminal', 'tab', 'rename', tabId, ''], 'local-tab-rename')
  const clearedLayout = await productCall(context, 'local-tab-rename-clear-read', ['terminal', 'layout', '--worktree', worktreeId], 'local-tab-rename')
  assertTabRename({ renamedLayout, clearedLayout, tabId })
  context.prove('local-tab-rename', { tabId, customTitle: 'cli-parity-tab', cleared: true })

  const splitValue = await productCall(context, 'local-pane-split', ['terminal', 'pane', 'split', paneId, '--direction', 'right'])
  const split = assertPaneSplit(splitValue, { session: sessionId, pane: paneId })
  context.prove('local-pane-split', { sessionId: split.session, paneId: split.pane, distinct: true })
  await productCall(context, 'local-pane-read-send', [
    'terminal', 'send', split.session, 'printf \'SPLIT:%s\\n\' "$PWD"', '--enter'
  ], 'local-pane-read')
  await poll(context, 'local-pane-read', 'SPLIT marker in the split shell', async attempt => {
    return productCall(context, `local-pane-read-poll-${attempt + 1}`, ['terminal', 'read', split.session, '--lines', '20'], 'local-pane-read')
  }, value => {
    if (!isObject(value) || !Array.isArray(value.lines)) return false
    return value.lines.every(line => typeof line === 'string') && value.lines.join('').includes(`SPLIT:${worktreePath}`)
  }, 15_000)
  const finalRead = await productCall(context, 'local-pane-read', ['terminal', 'read', split.session, '--lines', '20'], 'local-pane-read')
  assertPaneRead(finalRead, worktreePath)
  context.prove('local-pane-read', { sessionId: split.session, output: object(finalRead, 'terminal read result').lines, livePwdMarker: true })

  await productCall(context, 'local-pane-title', ['terminal', 'pane', 'title', split.pane, 'cli-parity-pane'])
  const titled = await productCall(context, 'local-pane-get', ['terminal', 'pane', 'get', split.pane], 'local-pane-get')
  const byFirstSession = await productCall(context, 'local-pane-get-first', ['terminal', 'pane', 'get', sessionId], 'local-pane-get')
  await productCall(context, 'local-pane-title-clear', ['terminal', 'pane', 'title', split.pane, ''], 'local-pane-title')
  const cleared = await productCall(context, 'local-pane-get-clear', ['terminal', 'pane', 'get', split.pane], 'local-pane-title')
  const expectedPane = { worktreeId, tabId, paneId: split.pane, sessionId: split.session, firstPaneId: paneId, firstSessionId: sessionId }
  assertPaneTitle({ titled, byFirstSession, cleared, expected: expectedPane })
  context.prove('local-pane-title', { paneId: split.pane, title: 'cli-parity-pane', cleared: true })
  context.prove('local-pane-get', { paneId: split.pane, sessionId: split.session, firstPaneId: paneId, active: true })

  context.state.localTerminalCreationStarted = true
  const second = object(await productCall(context, 'local-tab-activate-create', [
    'terminal', 'tab', 'new', '--worktree', worktreeId, '--agent', 'shell'
  ], 'local-tab-activate'), 'second terminal tab result')
  const secondTab = nonEmptyText(second.tab, 'second terminal tab')
  const secondSession = nonEmptyText(second.session, 'second terminal session')
  context.state.localTabIds = [tabId, secondTab]
  const beforeActivate = await productCall(context, 'local-tab-activate-layout-before', ['terminal', 'layout', '--worktree', worktreeId], 'local-tab-activate')
  const { group: createdGroup } = layoutGroup(beforeActivate, secondTab)
  equal(createdGroup.activeTab, secondTab, 'new tab initially active')
  const groupId = nonEmptyText(createdGroup.id, 'active terminal group ID')
  await productCall(context, 'local-tab-activate', ['terminal', 'tab', 'activate', tabId])
  const activated = await productCall(context, 'local-tab-activate-layout', ['terminal', 'layout', '--worktree', worktreeId], 'local-tab-activate')
  const refusal = await productRefusal(context, 'local-tab-activate-missing', ['terminal', 'tab', 'activate', 'tab-does-not-exist'], 'local-tab-activate')
  await productCall(context, 'local-tab-activate-close-first', ['terminal', 'tab', 'close', tabId, '--yes'], 'local-tab-activate')
  context.state.localClosedTabIds = [tabId]
  await productCall(context, 'local-tab-activate-close-second', ['terminal', 'tab', 'close', secondTab, '--yes'], 'local-tab-activate')
  context.state.localClosedTabIds = [tabId, secondTab]
  const closedSessions = await poll(context, 'local-tab-activate', 'local terminal sessions to close', async attempt => {
    return productCall(context, `local-tab-activate-sessions-poll-${attempt + 1}`, ['terminal', 'sessions'], 'local-tab-activate')
  }, value => {
    const open = new Set(terminalSessions(value).map(session => session.sessionId ?? session.id))
    return ![sessionId, split.session, secondSession].some(id => open.has(id))
  }, 15_000)
  assertTabActivation({
    layout: activated, groupId, tabId, refusal, sessions: closedSessions, sessionIds: [sessionId, split.session, secondSession]
  })
  context.prove('local-tab-activate', { groupId, activeTab: tabId, renderedFocus: false, closedSessions: true })
  context.state.localTerminalCleanupVerified = true
}

async function runHookChecks(context: CliCheckContext): Promise<void> {
  const { world } = context
  const hookFile = world.paths.codexHooksFile
  const userDocument = world.paths.userHookDocument
  const entries = await productCall(context, 'local-hooks-status', ['agent-status', 'hooks', 'status'])
  const statusEntriesValue = statusEntries(entries, 'initial hooks status')
  equal(statusEntriesValue.length, 28, 'initial hook status count')
  pathsInHome(statusEntriesValue, world.home)
  context.prove('local-hooks-status', { entries: statusEntriesValue.length, pathsUnderHome: true })

  const removed = await productCall(context, 'local-hooks-remove', ['agent-status', 'hooks', 'remove', 'codex'])
  context.state.localHooksRemoved = true
  const afterRemove = await productCall(context, 'local-hooks-remove-status', ['agent-status', 'hooks', 'status'], 'local-hooks-remove')
  assertHooksStatus({
    entries: afterRemove, codexDocument: readFileSync(hookFile, 'utf8'), home: world.home, hookFile, userDocument
  })
  assertHooksRemoved({
    removals: removed, codexDocument: readFileSync(hookFile, 'utf8'), hookFile, userDocument
  })
  context.prove('local-hooks-remove', { userHookPreserved: true, status: 'not-installed', pathsUnderHome: true })

  context.state.localHooksSetup = true
  context.state.localHooksRemoved = false
  const setup = await productCall(context, 'local-hooks-setup', ['agent-status', 'hooks', 'setup', 'codex'])
  const afterSetup = await productCall(context, 'local-hooks-setup-status', ['agent-status', 'hooks', 'status'], 'local-hooks-setup')
  const repeated = await productCall(context, 'local-hooks-setup-repeat', ['agent-status', 'hooks', 'setup', 'codex'], 'local-hooks-setup')
  const setupDocument = readFileSync(hookFile, 'utf8')
  assertHooksSetup({ setup, status: afterSetup, repeated, codexDocument: setupDocument, hookFile, home: world.home, userDocument })
  context.prove('local-hooks-setup', { installed: true, idempotent: true, userHookPreserved: true })

  const finalRemoved = await productCall(context, 'local-hooks-remove-final', ['agent-status', 'hooks', 'remove', 'codex'], 'local-hooks-remove')
  context.state.localHooksRemoved = true
  assertHooksRemoved({
    removals: finalRemoved, codexDocument: readFileSync(hookFile, 'utf8'), hookFile, userDocument
  })
}

async function runAccountChecks(context: CliCheckContext): Promise<void> {
  const providers = [
    { provider: 'claude', label: 'CLI parity Claude', email: 'claude-parity@example.invalid', add: 'local-account-add-claude', login: 'local-account-login-claude' },
    { provider: 'codex', label: 'CLI parity Codex', email: 'codex-parity@example.invalid', add: 'local-account-add-codex', login: 'local-account-login-codex' }
  ] as const
  const identities: Array<{ provider: string; id: string; accountId: string; label: string; email: string }> = []
  for (const item of providers) {
    const result = await productCall(context, item.add, ['accounts', 'add', '--provider', item.provider, '--label', item.label])
    const { id, accountId } = assertAccountAdd(result, item.label)
    context.state[item.provider === 'claude' ? 'localClaudeAccountId' : 'localCodexAccountId'] = accountId
    context.state[item.provider === 'claude' ? 'localClaudeAccountRemoved' : 'localCodexAccountRemoved'] = false
    identities.push({ provider: item.provider, id, accountId, label: item.label, email: item.email })
    context.prove(item.add, { status: 'pending', id, accountId, provider: item.provider })
  }

  for (const item of providers) {
    const identity = identities.find(entry => entry.provider === item.provider)!
    await poll(context, item.login, `${item.provider} local login`, async attempt => {
      const id = `${item.login}-poll-${attempt + 1}`
      return productCall(context, id, ['accounts', 'login-status', '--id', identity.id], item.login)
    }, value => isObject(value) && (value.status === 'complete' || value.status === 'error'), 15_000)
    const completed = await productCall(context, item.login, ['accounts', 'login-status', '--id', identity.id], item.login)
    assertAccountLogin(completed, { id: identity.accountId, label: item.label, email: item.email })
    context.prove(item.login, {
      status: 'complete', accountId: identity.accountId, label: item.label, email: item.email, needsSignIn: false
    })
  }
  const unknown = await productRefusal(context, 'local-account-login-claude-unknown', [
    'accounts', 'login-status', '--id', '00000000-0000-4000-8000-000000000000'
  ], 'local-account-login-claude')
  equal(unknown.code, 'not-found', 'unknown login status refusal code')

  const accountListing = await productCall(context, 'local-account-login-codex-list', ['accounts', 'list'], 'local-account-login-codex')
  assertAccountsPresent(accountListing, { claudeId: identities[0]!.accountId, codexId: identities[1]!.accountId })
  const claudeLog = readFileSync(context.world.paths.claudeLoginLog, 'utf8')
  const codexLog = readFileSync(context.world.paths.codexLoginLog, 'utf8')
  equal(claudeLog, 'login\n', 'Claude stand-in login log')
  equal(codexLog, 'login\n', 'Codex stand-in login log')
  context.prove('local-account-login-codex', {
    status: 'complete', label: 'CLI parity Codex', email: 'codex-parity@example.invalid', needsSignIn: false,
    active: { claude: null, codex: identities[1]!.accountId }, standIns: { claude: 1, codex: 1 }
  })

  const profilesRoot = join(context.world.home, 'plugin-data', 'quirky.accounts', 'profiles')
  const claudeRemoved = await productCall(context, 'local-account-remove-claude', [
    'accounts', 'remove', '--provider', 'claude', '--account-id', identities[0]!.accountId, '--yes'
  ])
  context.state.localClaudeAccountRemoved = true
  const afterClaude = await productCall(context, 'local-account-remove-claude-list', ['accounts', 'list'], 'local-account-remove-claude')
  const claudeProfileEntries = directoryEntries(join(profilesRoot, 'claude'))
  ensure(isObject(claudeRemoved), 'Claude account removal returned no result')
  const remainingClaude = listObjects(object(afterClaude, 'accounts after Claude removal').accounts, 'accounts after Claude removal.accounts')
  ensure(!remainingClaude.some(account => account.id === identities[0]!.accountId), 'Claude account remained after removal')
  ensure(claudeProfileEntries.length === 0, 'Claude account profile data remained after removal')
  context.prove('local-account-remove-claude', { accountId: identities[0]!.accountId, removed: true, profileEmpty: true })

  const codexRemoved = await productCall(context, 'local-account-remove-codex', [
    'accounts', 'remove', '--provider', 'codex', '--account-id', identities[1]!.accountId, '--yes'
  ])
  context.state.localCodexAccountRemoved = true
  const afterAll = await productCall(context, 'local-account-remove-codex-list', ['accounts', 'list'], 'local-account-remove-codex')
  assertAccountsRemoved({
    removed: codexRemoved, listed: afterAll,
    profiles: { claude: directoryEntries(join(profilesRoot, 'claude')), codex: directoryEntries(join(profilesRoot, 'codex')) }
  })
  context.prove('local-account-remove-codex', { accounts: [], active: { claude: null, codex: null }, profilesEmpty: true })
}

function directoryEntries(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : []
}

export async function runLocalChecks(context: CliCheckContext): Promise<void> {
  await runWorktreeCurrent(context)
  await runRepoSetup(context)
  await runSearchRefs(context)
  await runTerminalChecks(context)
  await runHookChecks(context)
  await runAccountChecks(context)
}

export async function cleanupLocalChecks(
  context: Pick<CliCheckContext, 'state'>,
  attempt: (argv: string[]) => Promise<unknown | undefined>,
  errors: string[]
): Promise<void> {
  const state = context.state
  const clean = async (argv: string[], onSuccess: () => void): Promise<void> => {
    try {
      if (await attempt(argv) !== undefined) onSuccess()
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const tabIds = Array.isArray(state.localTabIds) ? state.localTabIds.filter((id): id is string => typeof id === 'string') : []
  const closedTabs = new Set(Array.isArray(state.localClosedTabIds) ? state.localClosedTabIds.filter((id): id is string => typeof id === 'string') : [])
  if (state.localTerminalCreationStarted === true && state.localTerminalCleanupVerified !== true) {
    const baselineValue = state.localTerminalBaseline
    const worktreeId = state.worktreeId
    if (Array.isArray(baselineValue) && baselineValue.every((id): id is string => typeof id === 'string') &&
        typeof worktreeId === 'string' && worktreeId.length > 0) {
      try {
        const layout = await attempt(['terminal', 'layout', '--worktree', worktreeId])
        if (layout !== undefined) {
          const baseline = new Set(baselineValue)
          const openLocalTabs = tabRecords(layout)
            .map(tab => text(tab.id, 'local cleanup tab ID'))
            .filter(tabId => !baseline.has(tabId))
          const openTabs = new Set(openLocalTabs)
          for (const tabId of tabIds) {
            if (openTabs.has(tabId)) closedTabs.delete(tabId)
            else closedTabs.add(tabId)
          }
          tabIds.splice(0, tabIds.length, ...openLocalTabs)
          state.localClosedTabIds = [...closedTabs]
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  for (const tabId of tabIds) {
    if (closedTabs.has(tabId)) continue
    await clean(['terminal', 'tab', 'close', tabId, '--yes'], () => {
      closedTabs.add(tabId)
      state.localClosedTabIds = [...closedTabs]
    })
  }

  const accounts = [
    { key: 'localClaudeAccountId', removed: 'localClaudeAccountRemoved', provider: 'claude' },
    { key: 'localCodexAccountId', removed: 'localCodexAccountRemoved', provider: 'codex' }
  ] as const
  for (const account of accounts) {
    const id = state[account.key]
    if (typeof id !== 'string' || id.length === 0 || state[account.removed] === true) continue
    await clean(['accounts', 'remove', '--provider', account.provider, '--account-id', id, '--yes'], () => { state[account.removed] = true })
  }

  if (state.localHooksSetup === true && state.localHooksRemoved !== true) {
    await clean(['agent-status', 'hooks', 'remove', 'codex'], () => { state.localHooksRemoved = true })
  }

  const repos = [
    { key: 'localCloneId', removed: 'localCloneRemoved' },
    { key: 'localCreatedRepoId', removed: 'localCreatedRepoRemoved' }
  ] as const
  for (const repo of repos) {
    const id = state[repo.key]
    if (typeof id !== 'string' || id.length === 0 || state[repo.removed] === true) continue
    await clean(['repo', 'rm', id], () => { state[repo.removed] = true })
  }
}
