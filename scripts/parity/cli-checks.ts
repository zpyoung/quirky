import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { CliWorld } from './cli-world'
import { actorReceiptFiles, readActorReceipts, type CliActorReceipt } from './cli-actor'
import { assertNoOutsideCalls, cleanupLocalChecks, LOCAL_CHECK_IDS, runLocalChecks } from './cli-local'
import { cleanupWorkerChecks, runWorkerChecks, WORKER_CHECK_IDS } from './cli-workers'
import { cleanupStartupChecks, runStartupChecks, STARTUP_CHECK_IDS } from './cli-startup'

const CHECK_IDS = [
  'catalog',
  'repo-add', 'repo-list', 'repo-show', 'repo-set', 'folder-add', 'folder-idempotent',
  'worktree-create', 'worktree-list', 'worktree-show', 'worktree-set', 'worktree-remove',
  'agent-launch', 'agent-get', 'agent-close',
  'terminal-create', 'terminal-layout', 'terminal-read', 'terminal-send', 'terminal-close', 'terminal-exit',
  'loop-create', 'loop-list', 'loop-show', 'loop-pause', 'loop-edit', 'loop-steer', 'loop-resume', 'loop-stop',
  'ask-register', 'ask-cancel', 'ask-wait',
  'automation-create', 'automation-list', 'automation-show', 'automation-edit', 'automation-run', 'automation-runs', 'automation-remove',
  'actor-run-create', 'actor-run-current', 'actor-run-show', 'actor-run-list',
  'actor-task-create', 'actor-task-list', 'actor-task-update',
  'actor-gate-create', 'actor-gate-list', 'actor-gate-resolve',
  'actor-send', 'actor-check', 'actor-inbox',
  'file-open', 'file-state', 'file-read', 'file-close',
  'accounts-list', 'skill-show', 'skill-status', 'skill-install', 'skill-update', 'status',
  ...LOCAL_CHECK_IDS,
  ...WORKER_CHECK_IDS,
  ...STARTUP_CHECK_IDS
] as const

export const checkIds = new Set<string>(CHECK_IDS)

export type CliCheckContext = {
  world: CliWorld
  state: Record<string, unknown>
  call(id: string, argv: string[], format?: 'json' | 'jsonl', options?: { cwd?: string }): Promise<unknown>
  refuse(id: string, argv: string[], options?: { cwd?: string }): Promise<{ code: string; message: string; data?: unknown }>
  prove(id: string, evidence: Record<string, unknown>): void
  check(id: string): void
  importActor(receipts: unknown): void
  importActorRefusal(receipt: unknown): { code: string; message: string; data?: unknown }
  onActorLive?: () => Promise<void> | void
}

type ObjectValue = Record<string, unknown>
type TerminalPane = { tabId: string; paneId: string; sessionId: string }
type ActorReceipt = CliActorReceipt

type LoopSnapshot = ObjectValue

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

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function stringField(value: unknown, key: string, label: string): string {
  return string(object(value, label)[key], `${label}.${key}`)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
  return value
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function entity(value: unknown, key: string, label: string): ObjectValue {
  const result = object(value, label)
  return Object.hasOwn(result, key) ? object(result[key], `${label}.${key}`) : result
}


function optionalString(value: unknown, key: string): string | undefined {
  if (!isObject(value)) return undefined
  return typeof value[key] === 'string' ? value[key] : undefined
}

function stateString(context: CliCheckContext, key: string): string {
  return string(context.state[key], `check state.${key}`)
}

function assertUnder(root: string, candidate: string, label: string): void {
  const realRoot = realpathSync(root)
  const realCandidate = realpathSync(candidate)
  const fromRoot = relative(realRoot, realCandidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} escaped the owned CLI home: ${candidate}`)
  }
}

function readUtf8(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`${label} could not be read`, { cause: error })
  }
}

function assertExactBytes(path: string, expected: string, label: string): void {
  const actual = readFileSync(path)
  const expectedBytes = Buffer.from(expected, 'utf8')
  if (!actual.equals(expectedBytes)) throw new Error(`${label} bytes differ from the fixed fixture`)
}

function parseJson(text: string, label: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error) {
    throw new Error(`${label} did not contain valid JSON`, { cause: error })
  }
}

function parseJsonLines(text: string, label: string): unknown[] {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length === 0) throw new Error(`${label} returned no JSONL records`)
  return lines.map((line, index) => parseJson(line, `${label}[${index}]`))
}

function fieldOneOf(value: unknown, keys: readonly string[], label: string): string {
  const result = object(value, label)
  for (const key of keys) {
    const candidate = result[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  throw new Error(`${label} did not contain ${keys.join(' or ')}`)
}

function normalizedWorkspace(value: unknown, label: string): ObjectValue {
  const result = object(value, label)
  return Object.hasOwn(result, 'workspace') ? object(result.workspace, `${label}.workspace`) : result
}

function terminalPanes(workspaceValue: unknown, label: string): TerminalPane[] {
  const workspace = normalizedWorkspace(workspaceValue, label)
  const panes: TerminalPane[] = []
  const visit = (value: unknown, tabId?: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, tabId))
      return
    }
    if (!isObject(value)) return
    if (value.kind === 'pane') {
      if (tabId !== undefined && typeof value.id === 'string' && typeof value.session === 'string') {
        panes.push({ tabId, paneId: value.id, sessionId: value.session })
      }
      return
    }
    if (Array.isArray(value.tabs)) {
      for (const entry of value.tabs) {
        if (isObject(entry) && typeof entry.id === 'string' && entry.root !== undefined) visit(entry.root, entry.id)
        else visit(entry, tabId)
      }
    }
    if (value.root !== undefined) {
      const childTab = typeof value.id === 'string' && tabId === undefined ? value.id : tabId
      visit(value.root, childTab)
    }
    if (value.first !== undefined) visit(value.first, tabId)
    if (value.second !== undefined) visit(value.second, tabId)
  }
  visit(workspace.root)
  return panes
}

function addedTab(panes: TerminalPane[], before: ReadonlySet<string>, label: string): TerminalPane {
  const added = panes.filter((pane) => !before.has(pane.tabId))
  const tabIds = [...new Set(added.map((pane) => pane.tabId))]
  if (tabIds.length !== 1) throw new Error(`${label} expected one new terminal tab, found ${tabIds.length}`)
  const inTab = added.filter((pane) => pane.tabId === tabIds[0])
  if (inTab.length !== 1) throw new Error(`${label} expected one pane in the new terminal tab, found ${inTab.length}`)
  return inTab[0]!
}

function hasFieldArrayItem(value: unknown, key: string, predicate: (item: ObjectValue) => boolean, label: string): ObjectValue {
  const entries = array(object(value, label)[key], `${label}.${key}`).map((item, index) => object(item, `${label}.${key}[${index}]`))
  const found = entries.find(predicate)
  if (found === undefined) throw new Error(`${label}.${key} did not contain the expected item`)
  return found
}

function textFromTerminal(value: unknown, label: string): string {
  const rawLines = array(object(value, label).lines, `${label}.lines`)
  const lines = rawLines.map((line, index) => {
    if (typeof line !== 'string') throw new Error(`${label}.lines[${index}] must be a string`)
    return line
  })
  return lines.join('\n')
}

function jsonlFile(path: string, label: string): ObjectValue[] {
  if (!existsSync(path)) return []
  const contents = readUtf8(path, label)
  return contents.split(/\r?\n/).filter((line) => line.length > 0).map((line, index) => object(parseJson(line, `${label}[${index}]`), `${label}[${index}]`))
}

function codexTurnTexts(path: string): Array<{ threadId: string; text: string }> {
  return jsonlFile(path, 'Codex fixture request log')
    .filter((entry) => entry.method === 'turn/start')
    .map((entry, index) => {
      const params = object(entry.params, `Codex turn ${index}.params`)
      const input = array(params.input, `Codex turn ${index}.input`)
      const text = input.map((item, itemIndex) => {
        const part = object(item, `Codex turn ${index}.input[${itemIndex}]`)
        return part.type === 'text' && typeof part.text === 'string' ? part.text : ''
      }).filter(Boolean).join('\n')
      return { threadId: stringField(params, 'threadId', `Codex turn ${index}.params`), text }
    })
}

function occurrences(text: string, needle: string): number {
  let count = 0
  let at = 0
  while ((at = text.indexOf(needle, at)) !== -1) {
    count += 1
    at += needle.length
  }
  return count
}

function loopRecord(value: unknown, label: string): LoopSnapshot {
  return entity(value, 'loop', label)
}

function loopConfig(loop: LoopSnapshot): ObjectValue {
  return isObject(loop.config) ? loop.config : loop
}

function loopState(loop: LoopSnapshot, label: string): Record<string, unknown> {
  const config = loopConfig(loop)
  const pacing = object(config.pacing, `${label}.pacing`)
  equal(pacing.kind, 'on-idle', `${label}.pacing.kind`)
  equal(config.sessionPolicy, 'fresh', `${label}.sessionPolicy`)
  return loop
}

function assertCapped(loop: LoopSnapshot, completed: number, label: string): void {
  equal(loop.iterationsCompleted, completed, `${label}.iterationsCompleted`)
  equal(loop.state, 'paused', `${label}.state`)
  equal(loop.pauseReason, 'cap-iterations', `${label}.pauseReason`)
  equal(loop.nextIterationAt, null, `${label}.nextIterationAt`)
}

export function assertLoopCapSnapshot(value: unknown, iterations: number): Record<string, unknown> {
  const loop = loopRecord(value, 'loop cap snapshot')
  assertCapped(loop, iterations, 'loop cap snapshot')
  loopState(loop, 'loop cap snapshot')
  return loop
}

export function assertOmpPromptEvidence(argv: readonly string[], output: string, prompt: string): number {
  const promptCount = argv.reduce((count, argument) => count + occurrences(argument, prompt), 0)
  equal(promptCount, 1, 'OMP prompt argv count')
  ensure(output.includes(`PROMPT:${prompt}`), 'OMP terminal did not show the delivered prompt marker')
  return promptCount
}

export function assertTerminalAckEvidence(inputLines: readonly string[], output: string, input: string): void {
  equal(inputLines, [input], 'actor input log entries')
  ensure(output.includes(`ACK:${input}`), 'actor terminal output did not independently acknowledge the sent line')
}

export function assertActorAskEnvelope(stdout: string): { askId: string } {
  const events = parseJsonLines(stdout, 'actor Ask JSONL')
  equal(events.length, 2, 'actor Ask record count')
  const registered = object(events[0], 'actor Ask registered record')
  const pending = object(events[1], 'actor Ask pending record')
  equal(registered.status, 'registered', 'actor Ask first event')
  equal(pending.status, 'pending', 'actor Ask second event')
  const askId = stringField(registered, 'askId', 'actor Ask registered record')
  equal(stringField(pending, 'askId', 'actor Ask pending record'), askId, 'actor Ask ID consistency')
  return { askId }
}

export function assertActorRunState(
  value: unknown,
  expected: { runId: string; objective: string; sessionId: string }
): Record<string, unknown> {
  const run = object(object(value, 'actor Run result').run, 'actor Run result.run')
  equal(run.id, expected.runId, 'actor Run ID')
  equal(run.objective, expected.objective, 'actor Run objective')
  equal(run.coordinatorSessionId, expected.sessionId, 'actor Run coordinator')
  return run
}

export function assertExactUtf8Content(actual: string, expected: string, label: string): void {
  if (!Buffer.from(actual, 'utf8').equals(Buffer.from(expected, 'utf8'))) throw new Error(`${label} content bytes differ`)
}

export function assertAutomationRunEvidence(
  value: unknown,
  runId: string,
  promptCount: number
): { status: string; trigger: string; sessionKind: string; content: string; promptCount: number } {
  const run = object(value, 'manual automation run')
  equal(run.id, runId, 'manual automation run ID')
  equal(run.status, 'completed', 'manual automation status')
  equal(run.trigger, 'manual', 'manual automation trigger')
  equal(run.sessionKind, 'structured', 'manual automation session kind')
  const snapshot = object(run.outputSnapshot, 'manual automation output snapshot')
  const content = stringField(snapshot, 'content', 'manual automation output snapshot')
  assertExactUtf8Content(content, 'Codex: cli-parity-auto', 'manual automation output')
  equal(promptCount, 1, 'manual automation Codex prompt count')
  return { status: 'completed', trigger: 'manual', sessionKind: 'structured', content, promptCount }
}

async function productCall(
  context: CliCheckContext,
  id: string,
  argv: string[],
  checkId = id,
  format: 'json' | 'jsonl' = 'json'
): Promise<unknown> {
  context.check(checkId)
  return context.call(id, argv, format)
}

async function poll<T>(
  context: CliCheckContext,
  checkId: string,
  label: string,
  read: (attempt: number) => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 30_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  let last: T | undefined
  while (Date.now() < deadline) {
    context.check(checkId)
    last = await read(attempt)
    if (ready(last)) return last
    attempt += 1
    const remaining = deadline - Date.now()
    if (remaining > 0) await Bun.sleep(Math.min(100, remaining))
  }
  throw new Error(`Timed out waiting for ${label}${last === undefined ? '' : `; last result ${JSON.stringify(last)}`}`)
}

async function runProjectChecks(context: CliCheckContext): Promise<void> {
  const { world } = context
  const repoRoot = world.paths.repository
  const folderPath = world.paths.folder
  assertUnder(world.home, repoRoot, 'fixture Git repository')
  assertUnder(world.home, folderPath, 'fixture plain folder')
  const repositoryRealPath = realpathSync(repoRoot)
  const folderRealPath = realpathSync(folderPath)
  const fixtureText = 'first\nsecond λ\n'
  assertExactBytes(join(repositoryRealPath, 'fixture.txt'), fixtureText, 'repository fixture')

  const added = object(await productCall(context, 'repo-add', ['repo', 'add', repositoryRealPath]), 'repo add result')
  equal(added.kind, 'git', 'repo add kind')
  equal(added.path, repositoryRealPath, 'repo add real path')
  const repoId = stringField(added, 'id', 'repo add result')
  context.state.repoId = repoId
  context.prove('repo-add', { kind: 'git', path: repositoryRealPath, id: repoId })

  const folder = object(await productCall(context, 'folder-add', ['repo', 'add', folderRealPath, '--folder']), 'folder add result')
  equal(folder.kind, 'folder', 'folder add kind')
  equal(folder.path, folderRealPath, 'folder add real path')
  const folderId = stringField(folder, 'id', 'folder add result')
  context.state.folderId = folderId
  context.prove('folder-add', { kind: 'folder', path: folderRealPath, id: folderId })

  const repeatedFolder = object(await productCall(context, 'folder-idempotent', ['repo', 'add', folderRealPath, '--folder']), 'repeated folder add result')
  equal(stringField(repeatedFolder, 'id', 'repeated folder add result'), folderId, 'folder idempotency')
  context.prove('folder-idempotent', { id: folderId, sameId: true })

  const repoList = array(await productCall(context, 'repo-list', ['repo', 'list']), 'repo list result')
    .map((entry, index) => object(entry, `repo list result[${index}]`))
  ensure(repoList.some((entry) => entry.id === repoId && entry.path === repositoryRealPath), 'repo list omitted the exact Git fixture path')
  ensure(repoList.some((entry) => entry.id === folderId && entry.path === folderRealPath), 'repo list omitted the exact plain-folder path')
  context.prove('repo-list', { gitPath: repositoryRealPath, folderPath: folderRealPath, gitId: repoId, folderId })

  const changed = object(await productCall(context, 'repo-set', ['repo', 'set', repoId, '--default-base', 'main']), 'repo set result')
  const changedRepo = object(changed.repo, 'repo set result.repo')
  const changedSettings = object(changed.settings, 'repo set result.settings')
  equal(changedRepo.id, repoId, 'repo set ID')
  equal(changedSettings.defaultBase, 'main', 'repo set default base')
  context.prove('repo-set', { id: repoId, defaultBase: 'main' })

  const shown = object(await productCall(context, 'repo-show', ['repo', 'show', repoId]), 'repo show result')
  const shownRepo = object(shown.repo, 'repo show result.repo')
  const shownSettings = object(shown.settings, 'repo show result.settings')
  equal(shownRepo.id, repoId, 'repo show ID')
  equal(shownRepo.path, repositoryRealPath, 'repo show path')
  equal(shownSettings.defaultBase, 'main', 'repo show default base')
  context.prove('repo-show', { id: repoId, path: repositoryRealPath, defaultBase: 'main' })

  const root = world.paths.worktreesRoot
  assertUnder(world.home, root, 'worktrees root')
  await productCall(context, 'worktree-root-setting', ['setting', 'set', 'setting:quirky.worktree/worktreesRoot', root])

  const createdResult = object(await productCall(context, 'worktree-create', [
    'worktree', 'create', '--repo', `id:${repoId}`, '--name', 'cli-parity', '--base', 'main', '--no-parent', '--setup', 'skip'
  ]), 'worktree create result')
  const createdWorktree = object(createdResult.worktree, 'worktree create result.worktree')
  const worktreeId = stringField(createdWorktree, 'id', 'worktree create result.worktree')
  const worktreePath = stringField(createdWorktree, 'path', 'worktree create result.worktree')
  context.state.worktreeId = worktreeId
  context.state.worktreePath = worktreePath
  equal(createdWorktree.parentId, null, 'worktree parent')
  assertUnder(world.home, worktreePath, 'created worktree')
  assertUnder(root, worktreePath, 'created worktree root')
  assertExactBytes(join(worktreePath, 'fixture.txt'), fixtureText, 'worktree fixture')
  context.prove('worktree-create', { id: worktreeId, parentId: null, path: worktreePath, fileContents: fixtureText })

  const listedWorktrees = array(await productCall(context, 'worktree-list', ['worktree', 'list', '--repo', `id:${repoId}`]), 'worktree list result')
    .map((entry, index) => object(entry, `worktree list result[${index}]`))
  ensure(listedWorktrees.some((entry) => entry.id === worktreeId && entry.path === worktreePath), 'worktree list omitted the created fixture worktree')
  context.prove('worktree-list', { id: worktreeId, path: worktreePath })

  const shownWorktree = object(await productCall(context, 'worktree-show', ['worktree', 'show', worktreeId]), 'worktree show result')
  equal(shownWorktree.id, worktreeId, 'worktree show ID')
  equal(shownWorktree.path, worktreePath, 'worktree show path')
  equal(shownWorktree.parentId, null, 'worktree show parent')
  context.prove('worktree-show', { id: worktreeId, path: worktreePath, parentId: null })

  await productCall(context, 'worktree-set', ['worktree', 'set', worktreeId, '--comment', 'cli-parity-comment'])
  const updatedWorktree = object(await productCall(context, 'worktree-set-readback', ['worktree', 'show', worktreeId], 'worktree-set'), 'worktree set readback')
  equal(updatedWorktree.id, worktreeId, 'worktree set readback ID')
  equal(updatedWorktree.comment, 'cli-parity-comment', 'worktree set readback comment')
  context.prove('worktree-set', { id: worktreeId, comment: 'cli-parity-comment' })
}

async function runActorChecks(context: CliCheckContext): Promise<void> {
  const { world } = context
  const worktreeId = stateString(context, 'worktreeId')
  const expectedActorIds = [
    'ask-register', 'ask-cancel', 'ask-wait',
    'actor-run-create', 'actor-run-current', 'actor-run-show',
    'actor-task-create', 'actor-task-list', 'actor-task-update', 'actor-task-list-updated',
    'actor-gate-create', 'actor-gate-list', 'actor-gate-resolve',
    'actor-send', 'actor-check', 'actor-inbox'
  ]
  const baselineValue = await productCall(context, 'terminal-layout-before-actor', ['terminal', 'layout', '--worktree', worktreeId])
  const baseline = terminalPanes(baselineValue, 'terminal layout before actor')
  const existingTabs = new Set(baseline.map((pane) => pane.tabId))
  context.state.actorTerminalBaseline = [...existingTabs]
  context.state.actorTabCreated = true
  const newTab = await productCall(context, 'terminal-create', [
    'terminal', 'tab', 'new', '--worktree', worktreeId, '--agent', 'shell', '--command', world.paths.actorCommand, '--title', 'cli-parity-actor'
  ])
  const returnedPanes = terminalPanes(newTab, 'terminal tab new result')
  ensure(returnedPanes.some((pane) => !existingTabs.has(pane.tabId)), 'terminal tab new did not return its created tab in workspace data')

  const layout = await productCall(context, 'terminal-layout', ['terminal', 'layout', '--worktree', worktreeId])
  const actorPane = addedTab(terminalPanes(layout, 'terminal layout with actor'), existingTabs, 'actor terminal layout')
  const actorTabId = actorPane.tabId
  const actorSessionId = actorPane.sessionId
  context.state.actorTabId = actorTabId
  context.state.actorSessionId = actorSessionId
  equal(object(layout, 'terminal layout result').id, worktreeId, 'actor layout worktree')
  context.prove('terminal-layout', { worktreeId, tabId: actorTabId, sessionId: actorSessionId })

  const live = object(await productCall(context, 'actor-live-readback', ['session', 'get', actorSessionId], 'terminal-create'), 'actor session readback')
  equal(live.id, actorSessionId, 'actor session ID')
  equal(live.worktreeId, worktreeId, 'actor session worktree')
  if (live.status === 'exited') {
    const output = await productCall(context, 'actor-startup-output', ['terminal', 'read', actorSessionId, '--lines', '100'], 'terminal-create')
    throw new Error(`fixture actor exited before the live hook: ${JSON.stringify(output).slice(-8192)}`)
  }
  context.prove('terminal-create', { worktreeId, tabId: actorTabId, sessionId: actorSessionId })
  if (context.onActorLive) await context.onActorLive()

  context.check('ask-register')
  const deadline = Date.now() + 60_000
  let actorReceipts: ActorReceipt[] = []
  while (Date.now() < deadline) {
    context.check('ask-register')
    if (existsSync(world.paths.actorReceiptManifest)) {
      actorReceipts = readActorReceipts(world.home)
      const ids = actorReceipts.map((receipt) => receipt.id)
      if (expectedActorIds.every((id) => ids.includes(id))) break
    }
    await Bun.sleep(100)
  }
  equal(actorReceipts.map((receipt) => receipt.id), expectedActorIds, 'actor receipt execution order')
  equal(actorReceiptFiles(world.home).length, expectedActorIds.length, 'actor receipt file count')
  for (const receipt of actorReceipts) {
    const format = receipt.id === 'ask-register' ? 'jsonl' : 'json'
    equal(receipt.format, format, `${receipt.id} output format`)
    context.check(receipt.id)
    context.importActor([receipt])
    equal(receipt.stdoutBytes, Buffer.byteLength(receipt.stdout, 'utf8'), `${receipt.id} stdout byte count`)
    ensure(Number.isFinite(receipt.elapsedMs) && receipt.elapsedMs >= 0, `${receipt.id} elapsed time is invalid`)
    ensure(receipt.argv.includes('--json'), `${receipt.id} omitted explicit JSON mode`)
    const runtimeIndex = receipt.argv.indexOf('--runtime')
    equal(receipt.argv[runtimeIndex + 1], 'local', `${receipt.id} runtime selection`)
    equal(receipt.exitCode, 0, `${receipt.id} exit code`)
  }

  context.check('ask-register')
  const askReceipt = actorReceipt(actorReceipts, 'ask-register')
  const { askId } = assertActorAskEnvelope(askReceipt.stdout)
  ensure(askReceipt.argv.includes(`@${world.paths.askSpec}`), 'actor Ask did not use the fixed local confirmation spec')
  const spec = object(parseJson(readUtf8(world.paths.askSpec, 'owned Ask spec'), 'owned Ask spec'), 'owned Ask spec')
  equal(spec, { questions: [{ id: 'continue', type: 'confirm', question: 'Continue CLI fixture?' }] }, 'owned Ask spec')
  context.prove('ask-register', { records: ['registered', 'pending'], askId, sameId: true })

  context.check('ask-cancel')
  const cancelResult = object(parseJson(actorReceipt(actorReceipts, 'ask-cancel').stdout, 'actor Ask cancel'), 'actor Ask cancel result')
  equal(cancelResult.status, 'declined', 'actor Ask cancel status')
  equal(fieldOneOf(cancelResult, ['askId', 'id', 'requestId'], 'actor Ask cancel result'), askId, 'actor Ask cancel ID')
  context.prove('ask-cancel', { askId, status: 'declined' })

  context.check('ask-wait')
  const waitResult = object(parseJson(actorReceipt(actorReceipts, 'ask-wait').stdout, 'actor Ask wait'), 'actor Ask wait result')
  equal(waitResult.status, 'declined', 'actor Ask wait status')
  equal(fieldOneOf(waitResult, ['askId', 'id', 'requestId'], 'actor Ask wait result'), askId, 'actor Ask wait ID')
  context.prove('ask-wait', { askId, status: 'declined' })

  context.check('actor-run-create')
  const createdRun = object(parseJson(actorReceipt(actorReceipts, 'actor-run-create').stdout, 'actor run create'), 'actor run create result')
  const runId = stringField(createdRun.run, 'id', 'actor run create result.run')
  context.state.actorRunId = runId
  const actorSession = stateString(context, 'actorSessionId')
  assertActorRunState(createdRun, { runId, objective: 'cli-parity-objective', sessionId: actorSession })
  context.prove('actor-run-create', { runId, objective: 'cli-parity-objective', coordinatorSessionId: actorSession })

  context.check('actor-run-current')
  const currentRunResult = object(parseJson(actorReceipt(actorReceipts, 'actor-run-current').stdout, 'actor run current'), 'actor run current result')
  assertActorRunState(currentRunResult, { runId, objective: 'cli-parity-objective', sessionId: actorSession })
  context.prove('actor-run-current', { runId, objective: 'cli-parity-objective', coordinatorSessionId: actorSession })

  context.check('actor-run-show')
  const shownRunResult = object(parseJson(actorReceipt(actorReceipts, 'actor-run-show').stdout, 'actor run show'), 'actor run show result')
  assertActorRunState(shownRunResult, { runId, objective: 'cli-parity-objective', sessionId: actorSession })
  context.prove('actor-run-show', { runId, objective: 'cli-parity-objective', coordinatorSessionId: actorSession })

  const runList = object(await productCall(context, 'actor-run-list', ['orchestration', 'run-list']), 'controller run list result')
  const runs = array(runList.runs, 'controller run list result.runs').map((entry, index) => object(entry, `controller run list result.runs[${index}]`))
  ensure(runs.some((entry) => entry.id === runId && entry.objective === 'cli-parity-objective'), 'controller run-list did not independently contain the actor Run')
  context.prove('actor-run-list', { runId, found: true, objective: 'cli-parity-objective' })

  context.check('actor-task-create')
  const createdTaskResult = object(parseJson(actorReceipt(actorReceipts, 'actor-task-create').stdout, 'actor task create'), 'actor task create result')
  const createdTask = object(createdTaskResult.task, 'actor task create result.task')
  const taskId = stringField(createdTask, 'id', 'actor task create result.task')
  equal(createdTask.runId, runId, 'actor task Run ID')
  equal(createdTask.spec, 'cli-parity-task', 'actor task spec')
  context.state.actorTaskId = taskId
  context.prove('actor-task-create', { taskId, runId, spec: 'cli-parity-task' })

  context.check('actor-task-list')
  const taskListResult = object(parseJson(actorReceipt(actorReceipts, 'actor-task-list').stdout, 'actor task list'), 'actor task list result')
  equal(taskListResult.runId, runId, 'actor task list Run ID')
  const taskList = array(taskListResult.tasks, 'actor task list result.tasks').map((entry, index) => object(entry, `actor task list result.tasks[${index}]`))
  const listedTask = taskList.find((entry) => entry.id === taskId)
  ensure(listedTask !== undefined, 'actor task list omitted the created task')
  equal(listedTask.status, 'ready', 'actor task initial status')
  context.prove('actor-task-list', { taskId, runId, status: 'ready' })

  context.check('actor-task-update')
  const updatedTaskResult = object(parseJson(actorReceipt(actorReceipts, 'actor-task-update').stdout, 'actor task update'), 'actor task update result')
  equal(object(updatedTaskResult.task, 'actor task update result.task').id, taskId, 'actor task update receipt ID')
  const updatedList = object(parseJson(actorReceipt(actorReceipts, 'actor-task-list-updated').stdout, 'updated actor task list'), 'updated actor task list')
  const updatedTask = array(updatedList.tasks, 'updated actor task list.tasks').map((entry, index) => object(entry, `updated task ${index}`)).find(task => task.id === taskId)
  ensure(updatedTask !== undefined, 'independent task-list omitted the updated task')
  equal(updatedTask.id, taskId, 'actor updated task ID')
  const taskResult = object(updatedTask.result, 'actor updated task result')
  equal(taskResult.kind, 'coordinator_update', 'actor task result kind')
  equal(taskResult.text, 'cli-parity-result', 'actor task result text')
  equal(taskResult.reportedBy, actorSession, 'actor task result reporter')
  context.prove('actor-task-update', { taskId, kind: 'coordinator_update', text: 'cli-parity-result', reportedBy: actorSession })

  context.check('actor-gate-create')
  const createdGateResult = object(parseJson(actorReceipt(actorReceipts, 'actor-gate-create').stdout, 'actor gate create'), 'actor gate create result')
  const createdGate = object(createdGateResult.gate, 'actor gate create result.gate')
  const gateId = stringField(createdGate, 'id', 'actor gate create result.gate')
  equal(createdGate.taskId, taskId, 'actor gate task ID')
  equal(createdGate.status, 'pending', 'actor gate status')
  const blockedTask = object(createdGateResult.task, 'actor gate create result.task')
  equal(blockedTask.status, 'blocked', 'actor gate blocked task status')
  context.state.actorGateId = gateId
  context.prove('actor-gate-create', { gateId, taskId, gateStatus: 'pending', taskStatus: 'blocked' })

  context.check('actor-gate-list')
  const listedGateResult = object(parseJson(actorReceipt(actorReceipts, 'actor-gate-list').stdout, 'actor gate list'), 'actor gate list result')
  const listedGates = array(listedGateResult.gates, 'actor gate list result.gates').map((entry, index) => object(entry, `actor gate list result.gates[${index}]`))
  ensure(listedGates.some((entry) => entry.id === gateId && entry.taskId === taskId && entry.status === 'pending'), 'actor gate list omitted the pending gate')
  context.prove('actor-gate-list', { gateId, taskId, status: 'pending' })

  context.check('actor-gate-resolve')
  const resolvedGateResult = object(parseJson(actorReceipt(actorReceipts, 'actor-gate-resolve').stdout, 'actor gate resolve'), 'actor gate resolve result')
  const resolvedGate = object(resolvedGateResult.gate, 'actor gate resolve result.gate')
  const readyTask = object(resolvedGateResult.task, 'actor gate resolve result.task')
  equal(resolvedGate.id, gateId, 'actor resolved gate ID')
  equal(resolvedGate.status, 'resolved', 'actor resolved gate status')
  equal(resolvedGate.resolution, 'continue', 'actor gate resolution')
  equal(readyTask.id, taskId, 'actor resolved task ID')
  equal(readyTask.status, 'ready', 'actor resolved task status')
  context.prove('actor-gate-resolve', { gateId, status: 'resolved', resolution: 'continue', taskId, taskStatus: 'ready' })

  context.check('actor-send')
  const sent = object(parseJson(actorReceipt(actorReceipts, 'actor-send').stdout, 'actor send'), 'actor send result')
  equal(sent.kind, 'message', 'actor send result kind')
  const sentMessages = array(sent.messages, 'actor send result.messages').map((entry, index) => object(entry, `actor send result.messages[${index}]`))
  const message = sentMessages.find((entry) => entry.subject === 'cli-parity-mail' && entry.body === 'cli-parity-body')
  ensure(message !== undefined, 'actor send did not return the fixed durable message')
  const messageId = stringField(message, 'id', 'actor sent message')
  context.state.actorMessageId = messageId
  context.prove('actor-send', { messageId, subject: 'cli-parity-mail', body: 'cli-parity-body' })

  context.check('actor-check')
  const checked = object(parseJson(actorReceipt(actorReceipts, 'actor-check').stdout, 'actor check'), 'actor check result')
  equal(checked.mode, 'peek', 'actor check mode')
  const checkedMessages = array(checked.messages, 'actor check result.messages').map((entry, index) => object(entry, `actor check result.messages[${index}]`))
  ensure(checkedMessages.some((entry) => entry.id === messageId && entry.subject === 'cli-parity-mail' && entry.body === 'cli-parity-body'), 'actor peek did not independently read the exact sent message')
  context.prove('actor-check', { messageId, mode: 'peek', subject: 'cli-parity-mail', body: 'cli-parity-body' })

  context.check('actor-inbox')
  const inbox = object(parseJson(actorReceipt(actorReceipts, 'actor-inbox').stdout, 'actor inbox'), 'actor inbox result')
  const inboxMessages = array(inbox.messages, 'actor inbox result.messages').map((entry, index) => object(entry, `actor inbox result.messages[${index}]`))
  ensure(inboxMessages.some((entry) => entry.id === messageId && entry.subject === 'cli-parity-mail' && entry.body === 'cli-parity-body'), 'actor inbox history did not independently retain the exact sent message')
  context.prove('actor-inbox', { messageId, subject: 'cli-parity-mail', body: 'cli-parity-body' })
}

function actorReceipt(receipts: ActorReceipt[], id: string): ActorReceipt {
  const matches = receipts.filter((receipt) => receipt.id === id)
  if (matches.length !== 1) throw new Error(`Expected one actor receipt ${id}, found ${matches.length}`)
  return matches[0]!
}

async function runAgentTerminalChecks(context: CliCheckContext): Promise<void> {
  const worktreeId = stateString(context, 'worktreeId')
  const launched = object(await productCall(context, 'agent-launch', [
    'session', 'new', '--agent', 'omp', '--worktree', worktreeId, '--prompt', 'cli-parity-prompt'
  ]), 'OMP agent launch result')
  const sessionId = stringField(launched, 'id', 'OMP agent launch result')
  context.state.agentSessionId = sessionId
  equal(launched.worktreeId, worktreeId, 'OMP launch worktree')

  await poll(context, 'agent-get', 'OMP prompt terminal output', async (attempt) => {
    return productCall(context, `agent-prompt-poll-${attempt + 1}`, ['terminal', 'read', sessionId, '--lines', '100'], 'agent-get')
  }, (value) => isObject(value) && Array.isArray(value.lines) && value.lines.some((line) => typeof line === 'string' && line.includes('PROMPT:cli-parity-prompt')), 30_000)
  const session = object(await productCall(context, 'agent-get', ['session', 'get', sessionId]), 'OMP session get result')
  equal(session.id, sessionId, 'OMP session ID')
  equal(session.worktreeId, worktreeId, 'OMP session worktree')

  const output = textFromTerminal(await productCall(context, 'agent-prompt-terminal-read', ['terminal', 'read', sessionId, '--lines', '100']), 'OMP prompt terminal read')
  const ompArgv = readUtf8(context.world.paths.ompLog, 'OMP argv log').split(/\r?\n/).filter((argument) => argument.length > 0)
  const promptOccurrences = assertOmpPromptEvidence(ompArgv, output, 'cli-parity-prompt')
  context.prove('agent-launch', { sessionId, worktreeId, promptArgvCount: promptOccurrences })
  context.prove('agent-get', { sessionId, worktreeId, status: stringField(session, 'status', 'OMP session get result') })

  await productCall(context, 'agent-close', ['session', 'close', sessionId, '--yes'])
  context.state.agentClosed = true
  const sessions = array(await productCall(context, 'agent-close-readback', ['session', 'list', '--worktree', worktreeId], 'agent-close'), 'sessions after OMP close')
  ensure(!sessions.some(value => object(value, 'listed session').id === sessionId), 'session close left the OMP session in the workspace inventory')
  context.prove('agent-close', { sessionId, absentFromInventory: true })

  const actorSessionId = stateString(context, 'actorSessionId')
  const sendResult = await productCall(context, 'terminal-send', ['terminal', 'send', actorSessionId, 'cli-parity-input', '--enter'])
  object(sendResult, 'terminal send result')
  const inputPath = context.world.paths.actorInputLog
  const ackDeadline = Date.now() + 15_000
  let inputLines: string[] = []
  let terminalText = ''
  let readAttempt = 0
  while (Date.now() < ackDeadline) {
    context.check('terminal-send')
    if (existsSync(inputPath)) {
      const logged = readUtf8(inputPath, 'actor input log')
      inputLines = logged.split(/\r?\n/)
      if (inputLines.at(-1) === '') inputLines.pop()
    }
    const read = await productCall(context, `terminal-read-ack-poll-${++readAttempt}`, ['terminal', 'read', actorSessionId, '--lines', '100'], 'terminal-send')
    terminalText = textFromTerminal(read, 'actor ACK terminal read')
    if (inputLines.length === 1 && inputLines[0] === 'cli-parity-input' && terminalText.includes('ACK:cli-parity-input')) break
    await Bun.sleep(100)
  }
  assertTerminalAckEvidence(inputLines, terminalText, 'cli-parity-input')
  const terminalRead = textFromTerminal(await productCall(context, 'terminal-read', ['terminal', 'read', actorSessionId, '--lines', '100']), 'terminal read result')
  assertTerminalAckEvidence(inputLines, terminalRead, 'cli-parity-input')
  context.prove('terminal-send', { inputLog: inputLines, output: 'ACK:cli-parity-input' })
  context.prove('terminal-read', { sessionId: actorSessionId, output: terminalRead })

  const worktree = stateString(context, 'worktreeId')
  const beforeExitLayout = terminalPanes(await productCall(context, 'terminal-exit-layout-before', ['terminal', 'layout', '--worktree', worktree]), 'terminal layout before exit command')
  const beforeExitTabs = new Set(beforeExitLayout.map((pane) => pane.tabId))
  context.state.exitTerminalBaseline = [...beforeExitTabs]
  context.state.exitTabCreated = true
  const exitCommand = "printf 'cli-parity-exit\\n'"
  const exitTabResult = await productCall(context, 'terminal-exit-create', [
    'terminal', 'tab', 'new', '--worktree', worktree, '--agent', 'shell', '--command', exitCommand, '--title', 'cli-parity-exit'
  ])
  const exitLayout = await productCall(context, 'terminal-exit-layout', ['terminal', 'layout', '--worktree', worktree])
  const exitPane = addedTab(terminalPanes(exitLayout, 'terminal layout with exit command'), beforeExitTabs, 'exit command terminal')
  context.state.exitTabId = exitPane.tabId
  context.state.exitSessionId = exitPane.sessionId
  ensure(terminalPanes(exitTabResult, 'exit terminal tab result').some((pane) => pane.sessionId === exitPane.sessionId), 'exit command tab response did not identify the session in its layout')

  await poll(context, 'terminal-exit', 'exit command terminal session', async (attempt) => {
    return productCall(context, `terminal-exit-poll-${attempt + 1}`, ['session', 'get', exitPane.sessionId], 'terminal-exit')
  }, (value) => isObject(value) && value.id === exitPane.sessionId && value.status === 'exited', 20_000)
  const waitResult = object(await productCall(context, 'terminal-exit', [
    'agent-status', 'wait', exitPane.sessionId, '--until', 'exited', '--timeout-ms', '1000'
  ]), 'agent-status wait result')
  equal(waitResult.status, 'matched', 'agent-status wait status')
  equal(waitResult.state, 'exited', 'agent-status wait state')
  const exitOutput = textFromTerminal(await productCall(context, 'terminal-exit-output', ['terminal', 'read', exitPane.sessionId, '--lines', '100'], 'terminal-exit'), 'exit terminal output')
  ensure(exitOutput.includes('cli-parity-exit'), 'exit command terminal omitted the fixed printf output')
  context.prove('terminal-exit', { status: 'matched', state: 'exited', output: exitOutput })

  const accounts = object(await productCall(context, 'accounts-list', ['accounts', 'list']), 'accounts list result')
  equal(accounts.accounts, [], 'managed accounts')
  equal(accounts.active, { claude: null, codex: null }, 'active managed accounts')
  equal(accounts.pendingLogin, null, 'pending login')
  const systemDefault = object(accounts.systemDefault, 'accounts list systemDefault')
  equal(object(systemDefault.claude, 'Claude System default').hasAuth, false, 'Claude System default authentication')
  equal(object(systemDefault.codex, 'Codex System default').hasAuth, false, 'Codex System default authentication')
  context.prove('accounts-list', { accounts: [], active: { claude: null, codex: null }, pendingLogin: null, systemDefaultHasAuth: { claude: false, codex: false } })

  const status = object(await productCall(context, 'status', ['status']), 'daemon status result')
  const pid = finiteNumber(status.pid, 'daemon status pid')
  equal(pid, context.world.daemonPid, 'owned daemon PID')
  equal(status.home, context.world.home, 'owned daemon home')
  const ptyHost = object(status.ptyHost, 'daemon status PTY host')
  equal(ptyHost.alive, true, 'PTY host liveness')
  const ptyHostPid = finiteNumber(ptyHost.pid, 'daemon status PTY host pid')
  equal(ptyHostPid, context.world.ptyPid, 'owned PTY host PID')
  context.prove('status', { pid, home: context.world.home, ptyHostPid, owned: true })

  const actorTabId = stateString(context, 'actorTabId')
  await productCall(context, 'terminal-close', ['terminal', 'tab', 'close', actorTabId, '--yes'])
  const afterActorClose = await productCall(context, 'terminal-close-layout', ['terminal', 'layout', '--worktree', worktree], 'terminal-close')
  ensure(!terminalPanes(afterActorClose, 'layout after actor close').some((pane) => pane.tabId === actorTabId), 'terminal tab close left the actor tab in layout')
  context.state.actorTabClosed = true
  context.prove('terminal-close', { tabId: actorTabId, absentFromLayout: true })

  const exitTabId = stateString(context, 'exitTabId')
  await productCall(context, 'terminal-exit-close', ['terminal', 'tab', 'close', exitTabId, '--yes'], 'terminal-exit')
  context.state.exitTabClosed = true
}

async function runLoopChecks(context: CliCheckContext): Promise<void> {
  const worktreeId = stateString(context, 'worktreeId')
  const created = loopRecord(await productCall(context, 'loop-create', [
    'loops', 'create', '--agent', 'codex', '--worktree', worktreeId, '--preset', 'until-done', '--max-iterations', '1', '--prompt', 'cli-parity-loop'
  ]), 'loop create result')
  const loopId = stringField(created, 'id', 'loop create result')
  context.state.loopId = loopId
  loopState(created, 'loop create result')
  context.prove('loop-create', { id: loopId, pacing: 'on-idle', sessionPolicy: 'fresh' })

  const listed = await productCall(context, 'loop-list', ['loops', 'list', '--worktree', worktreeId])
  const loopList = Array.isArray(listed) ? listed : array(object(listed, 'loop list result').loops, 'loop list result.loops')
    .map((entry, index) => object(entry, `loop list result.loops[${index}]`))
  ensure(loopList.some((entry) => entry.id === loopId), 'loop list omitted the created loop')
  context.prove('loop-list', { id: loopId, found: true })

  const firstPoll = await poll(context, 'loop-show', 'first native loop turn', async (attempt) => {
    return productCall(context, `loop-poll-${attempt + 1}`, ['loops', 'show', loopId], 'loop-show')
  }, (value) => {
    const loop = loopRecord(value, 'first loop poll')
    return loop.iterationsCompleted === 1 && loop.state === 'paused' && loop.pauseReason === 'cap-iterations' && loop.nextIterationAt === null
  }, 45_000)
  loopState(loopRecord(firstPoll, 'first completed loop poll'), 'first completed loop poll')
  assertLoopCapSnapshot(await productCall(context, 'loop-show', ['loops', 'show', loopId]), 1)
  const firstTurns = codexTurnTexts(context.world.paths.codexLog)
  const firstPromptTurns = firstTurns.filter((turn) => turn.text.includes('cli-parity-loop') && !turn.text.includes('cli-parity-loop-edited'))
  equal(firstPromptTurns.length, 1, 'first native loop request count')
  equal(occurrences(firstPromptTurns[0]!.text, 'cli-parity-loop'), 1, 'first native loop prompt occurrences')
  context.prove('loop-show', {
    iterationsCompleted: 1, state: 'paused', pauseReason: 'cap-iterations', nextIterationAt: null,
    pacing: 'on-idle', sessionPolicy: 'fresh', promptCount: 1
  })

  const requestCountBeforePause = codexTurnTexts(context.world.paths.codexLog).length
  assertLoopCapSnapshot(await productCall(context, 'loop-pause', ['loops', 'pause', loopId]), 1)
  const requestCountAfterPause = codexTurnTexts(context.world.paths.codexLog).length
  equal(requestCountAfterPause, requestCountBeforePause, 'pause native request count')
  context.prove('loop-pause', { state: 'paused', iterationsCompleted: 1, requestsUnchanged: true })

  await productCall(context, 'loop-edit', ['loops', 'edit', loopId, '--name', 'CLI-parity-edited', '--prompt', 'cli-parity-loop-edited'])
  const edited = loopRecord(await productCall(context, 'loop-edit-readback', ['loops', 'show', loopId], 'loop-edit'), 'edited loop readback')
  equal(edited.name, 'CLI-parity-edited', 'edited loop name')
  equal(loopConfig(edited).promptSource, { kind: 'repeat', body: 'cli-parity-loop-edited' }, 'edited loop prompt source')
  context.prove('loop-edit', { id: loopId, name: 'CLI-parity-edited', prompt: 'cli-parity-loop-edited' })

  await productCall(context, 'loop-steer', ['loops', 'steer', loopId, 'cli-parity-steer'])
  const resumed = loopRecord(await productCall(context, 'loop-resume', ['loops', 'resume', loopId, '--add-iterations', '1']), 'loop resume result')
  equal(resumed.id, loopId, 'resumed loop ID')
  await poll(context, 'loop-resume', 'second native loop turn', async (attempt) => {
    return productCall(context, `loop-resume-poll-${attempt + 1}`, ['loops', 'show', loopId], 'loop-resume')
  }, (value) => {
    const loop = loopRecord(value, 'second loop poll')
    return loop.iterationsCompleted === 2 && loop.state === 'paused' && loop.pauseReason === 'cap-iterations' && loop.nextIterationAt === null
  }, 45_000)
  assertLoopCapSnapshot(await productCall(context, 'loop-resume-show', ['loops', 'show', loopId], 'loop-resume'), 2)
  const turnTexts = codexTurnTexts(context.world.paths.codexLog)
  const initialLoopPromptTurns = turnTexts.filter((turn) => turn.text.includes('cli-parity-loop') && !turn.text.includes('cli-parity-loop-edited'))
  equal(initialLoopPromptTurns.length, 1, 'original loop prompt request count')
  const secondPromptTurns = turnTexts.filter((turn) => turn.text.includes('cli-parity-loop-edited'))
  equal(secondPromptTurns.length, 1, 'edited loop prompt request count')
  equal(occurrences(secondPromptTurns[0]!.text, 'cli-parity-loop-edited'), 1, 'edited loop prompt occurrences')
  equal(occurrences(secondPromptTurns[0]!.text, 'cli-parity-steer'), 1, 'steer note occurrences')
  ensure(initialLoopPromptTurns[0]!.threadId !== secondPromptTurns[0]!.threadId, 'resumed loop did not start a fresh Codex thread')
  context.prove('loop-steer', { note: 'cli-parity-steer', deliveredOnSecondTurn: true })
  context.prove('loop-resume', {
    iterationsCompleted: 2, state: 'paused', pauseReason: 'cap-iterations', nextIterationAt: null,
    editedPrompt: 'cli-parity-loop-edited', steer: 'cli-parity-steer', freshTurn: true
  })

  const stopped = loopRecord(await productCall(context, 'loop-stop', ['loops', 'stop', loopId, '--yes']), 'loop stop result')
  equal(stopped.state, 'stopped', 'loop stop state')
  const stoppedReadback = loopRecord(await productCall(context, 'loop-stop-readback', ['loops', 'show', loopId], 'loop-stop'), 'stopped loop readback')
  equal(stoppedReadback.state, 'stopped', 'stopped loop readback state')
  context.state.loopStopped = true
  context.prove('loop-stop', { id: loopId, state: 'stopped' })
}

async function runAutomationChecks(context: CliCheckContext): Promise<void> {
  const repoId = stateString(context, 'repoId')
  const worktreeId = stateString(context, 'worktreeId')
  const created = object(await productCall(context, 'automation-create', [
    'automations', 'create', '--name', 'CLI-parity', '--prompt', 'cli-parity-auto', '--provider', 'codex',
    '--project', repoId, '--workspace', worktreeId, '--trigger', 'daily', '--timezone', 'UTC', '--disabled'
  ]), 'automation create result')
  const automationId = stringField(created, 'id', 'automation create result')
  context.state.automationId = automationId
  equal(created.enabled, false, 'automation initial disabled state')
  context.prove('automation-create', { id: automationId, enabled: false, name: 'CLI-parity' })

  const listed = array(await productCall(context, 'automation-list', ['automations', 'list']), 'automation list result')
    .map((entry, index) => object(entry, `automation list result[${index}]`))
  ensure(listed.some((entry) => entry.id === automationId), 'automation list omitted the created definition')
  context.prove('automation-list', { id: automationId, found: true })

  const shown = object(await productCall(context, 'automation-show', ['automations', 'show', automationId]), 'automation show result')
  equal(shown.id, automationId, 'automation show ID')
  equal(shown.name, 'CLI-parity', 'automation show initial name')
  equal(shown.enabled, false, 'automation show disabled state')
  context.prove('automation-show', { id: automationId, name: 'CLI-parity', enabled: false })

  await productCall(context, 'automation-edit', ['automations', 'edit', automationId, '--name', 'CLI-parity-edited'])
  const edited = object(await productCall(context, 'automation-edit-readback', ['automations', 'show', automationId], 'automation-edit'), 'automation edit readback')
  equal(edited.name, 'CLI-parity-edited', 'automation edited name')
  equal(edited.enabled, false, 'automation remained disabled after edit')
  context.prove('automation-edit', { id: automationId, name: 'CLI-parity-edited', enabled: false })

  const runResult = object(await productCall(context, 'automation-run', ['automations', 'run', automationId]), 'manual automation run result')
  const runId = stringField(runResult, 'id', 'manual automation run result')
  context.state.automationRunId = runId
  await poll(context, 'automation-runs', 'manual automation completion', async (attempt) => {
    return productCall(context, `automation-runs-poll-${attempt + 1}`, ['automations', 'runs', '--id', automationId], 'automation-runs')
  }, (value) => {
    if (!isObject(value) || !Array.isArray(value.runs)) return false
    return value.runs.some((entry) => isObject(entry) && entry.id === runId && entry.status === 'completed')
  }, 45_000)
  const completedPage = object(await productCall(context, 'automation-runs', ['automations', 'runs', '--id', automationId]), 'completed automation runs result')
  const runs = array(completedPage.runs, 'completed automation runs result.runs')
    .map((entry, index) => object(entry, `completed automation runs result.runs[${index}]`))
  const completed = runs.find((entry) => entry.id === runId)
  ensure(completed !== undefined, 'automation runs omitted the completed manual run')
  const promptCount = codexTurnTexts(context.world.paths.codexLog).filter((turn) => turn.text.includes('cli-parity-auto')).length
  context.prove('automation-run', { id: runId, trigger: 'manual' })
  context.prove('automation-runs', assertAutomationRunEvidence(completed, runId, promptCount))

  await productCall(context, 'automation-remove', ['automations', 'remove', automationId, '--yes'])
  const afterRemove = array(await productCall(context, 'automation-list-after-remove', ['automations', 'list'], 'automation-remove'), 'automation list after remove')
    .map((entry, index) => object(entry, `automation list after remove[${index}]`))
  ensure(!afterRemove.some((entry) => entry.id === automationId), 'automation remove left its definition in the list')
  context.state.automationRemoved = true
  context.prove('automation-remove', { id: automationId, absentFromList: true })
}

async function runFileAndSkillChecks(context: CliCheckContext): Promise<void> {
  const worktreeId = stateString(context, 'worktreeId')
  const worktreePath = stateString(context, 'worktreePath')
  const expectedContent = 'first\nsecond λ\n'
  const fixturePath = join(worktreePath, 'fixture.txt')
  assertExactBytes(fixturePath, expectedContent, 'worktree fixture before editor open')

  const opened = object(await productCall(context, 'file-open', ['editor', 'open', 'fixture.txt', '--worktree', worktreeId, '--line', '2', '--column', '1']), 'editor open result')
  const bufferId = stringField(opened, 'id', 'editor open result')
  const tabId = stringField(opened, 'openedTabId', 'editor open result')
  context.state.editorBufferId = bufferId
  context.state.editorTabId = tabId
  equal(opened.worktreeId, worktreeId, 'opened editor worktree')
  equal(opened.path, fixturePath, 'opened editor exact path')
  context.prove('file-open', { bufferId, tabId, worktreeId, path: fixturePath })

  const state = object(await productCall(context, 'file-state', ['editor', 'state', '--worktree', worktreeId]), 'editor state result')
  const buffers = array(state.buffers, 'editor state buffers').map((entry, index) => object(entry, `editor state buffers[${index}]`))
  const buffer = buffers.find((entry) => entry.id === bufferId)
  ensure(buffer !== undefined, 'editor state omitted the opened buffer')
  equal(buffer.worktreeId, worktreeId, 'editor state buffer worktree')
  const view = object(buffer.view, 'editor state buffer view')
  const perTabView = object(object(view.byTabId, 'editor state buffer view.byTabId')[tabId], 'editor saved tab view')
  equal(perTabView.line, 2, 'editor saved line')
  equal(perTabView.column, 1, 'editor saved column')
  const explorer = object(state.explorer, 'editor state explorer')
  equal(explorer.worktreeId, worktreeId, 'editor explorer worktree')
  const tabs = array(state.tabs, 'editor state tabs').map((entry, index) => object(entry, `editor state tabs[${index}]`))
  ensure(tabs.some((entry) => entry.tabId === tabId && entry.bufferId === bufferId), 'editor state omitted the hosted tab or associated it with another buffer')
  context.prove('file-state', { bufferId, tabId, worktreeId, line: perTabView.line, column: perTabView.column })

  const readResult = object(await productCall(context, 'file-read', ['editor', 'read', '--buffer-id', bufferId, '--action', 'buffer']), 'editor read result')
  const readBuffer = object(readResult.buffer, 'editor read result.buffer')
  equal(readBuffer.id, bufferId, 'editor read buffer ID')
  equal(readBuffer.worktreeId, worktreeId, 'editor read worktree')
  assertExactUtf8Content(stringField(readBuffer, 'content', 'editor read result.buffer'), expectedContent, 'editor buffer')
  equal(finiteNumber(readResult.size, 'editor read size'), Buffer.byteLength(expectedContent, 'utf8'), 'editor buffer byte size')
  context.prove('file-read', { bufferId, worktreeId, content: expectedContent })

  await productCall(context, 'file-close', ['editor', 'close', '--buffer-id', bufferId])
  const afterClose = object(await productCall(context, 'file-state-after-close', ['editor', 'state', '--worktree', worktreeId], 'file-close'), 'editor state after close')
  const remainingTabs = array(afterClose.tabs, 'editor state after close.tabs').map((entry, index) => object(entry, `editor state after close.tabs[${index}]`))
  ensure(!remainingTabs.some((entry) => entry.tabId === tabId), 'editor close left the hosted tab in subsequent state')
  context.state.editorClosed = true
  context.prove('file-close', { bufferId, tabId, absentFromState: true })

  const skillRoot = join(context.world.home, 'cli-skill')
  context.state.skillRoot = skillRoot
  const skillValue = object(await productCall(context, 'skill-show', ['skill', 'show']), 'skill show result')
  const skillText = stringField(skillValue, 'skill', 'skill show result')
  const skillDigest = createHash('sha256').update(skillText, 'utf8').digest('hex')
  context.prove('skill-show', { bytes: Buffer.byteLength(skillText, 'utf8'), digest: skillDigest })

  const missing = object(await productCall(context, 'skill-status', ['skill', 'status', '--dir', skillRoot]), 'initial skill status')
  equal(missing.status, 'missing', 'initial skill status')
  context.prove('skill-status', { state: 'missing' })

  const firstInstall = object(await productCall(context, 'skill-install', ['skill', 'install', '--dir', skillRoot]), 'first skill install')
  equal(firstInstall.status, 'installed', 'first skill install status')
  const skillPath = join(skillRoot, 'quirky', 'SKILL.md')
  context.state.skillPath = skillPath
  assertExactBytes(skillPath, skillText, 'installed generated skill')
  const currentStatus = object(await productCall(context, 'skill-status-after-install', ['skill', 'status', '--dir', skillRoot]), 'installed skill status')
  equal(currentStatus.status, 'up-to-date', 'subsequent skill status')
  const repeatedInstall = object(await productCall(context, 'skill-install-idempotent', ['skill', 'install', '--dir', skillRoot]), 'idempotent skill install')
  equal(repeatedInstall.status, 'up-to-date', 'subsequent skill install status')
  assertExactBytes(skillPath, skillText, 'idempotent skill install bytes')
  context.prove('skill-install', { state: 'installed', subsequentStatus: 'up-to-date', subsequentInstall: 'up-to-date', bytesEqual: true })

  writeFileSync(skillPath, 'stale CLI fixture bytes\n')
  const stale = object(await productCall(context, 'skill-status-stale', ['skill', 'status', '--dir', skillRoot]), 'stale skill status')
  equal(stale.status, 'stale', 'stale skill status')
  const refreshed = object(await productCall(context, 'skill-update', ['skill', 'install', '--dir', skillRoot]), 'skill update install')
  equal(refreshed.status, 'installed', 'stale skill replacement status')
  assertExactBytes(skillPath, skillText, 'updated generated skill')
  const finalStatus = object(await productCall(context, 'skill-status-after-update', ['skill', 'status', '--dir', skillRoot], 'skill-update'), 'final skill status')
  equal(finalStatus.status, 'up-to-date', 'final updated skill status')
  assertExactBytes(skillPath, skillText, 'final generated skill')
  context.prove('skill-update', { state: 'up-to-date', bytesEqual: true, staleStatus: 'stale' })
}

async function removeOwnedWorktree(context: CliCheckContext): Promise<void> {
  const worktreeId = stateString(context, 'worktreeId')
  const repoId = stateString(context, 'repoId')
  const removed = object(await productCall(context, 'worktree-remove', ['worktree', 'rm', worktreeId, '--force', '--yes']), 'worktree remove result')
  context.state.worktreeRemoved = true
  const keptBranchValue = removed.keptBranch
  let retainedBranch: { name: string; head: string } | null = null
  if (keptBranchValue !== undefined && keptBranchValue !== null) {
    const branch = object(keptBranchValue, 'worktree remove retained branch')
    retainedBranch = {
      name: stringField(branch, 'name', 'worktree remove retained branch'),
      head: stringField(branch, 'head', 'worktree remove retained branch')
    }
    context.state.retainedBranch = retainedBranch
  }

  const remaining = array(await productCall(context, 'worktree-list-after-remove', ['worktree', 'list', '--repo', `id:${repoId}`]), 'worktree list after remove')
    .map((entry, index) => object(entry, `worktree list after remove[${index}]`))
  ensure(!remaining.some((entry) => entry.id === worktreeId), 'worktree list still contains the removed fixture worktree')
  context.state.worktreeRemovalVerified = true

  if (retainedBranch !== null) {
    await productCall(context, 'worktree-delete-branch', [
      'worktree', 'delete-branch', repoId, retainedBranch.name, '--head', retainedBranch.head, '--yes'
    ], 'worktree-remove')
    context.state.retainedBranchDeleted = true
  }
  context.prove('worktree-remove', { worktreeId, removed: true, absentFromList: true, retainedBranch, retainedBranchDeleted: retainedBranch !== null })
}

export async function runCliChecks(context: CliCheckContext): Promise<void> {
  await runProjectChecks(context)
  await runActorChecks(context)
  await runAgentTerminalChecks(context)
  await runLoopChecks(context)
  await runAutomationChecks(context)
  await runFileAndSkillChecks(context)
  await runLocalChecks(context)
  await runWorkerChecks(context)
  await removeOwnedWorktree(context)
  await runStartupChecks(context)
  assertNoOutsideCalls({
    egressLog: context.world.paths.egressLog,
    orcaLog: context.world.paths.orcaLog,
    securityLog: context.world.paths.securityLog
  })
}

export async function cleanupCliChecks(context: CliCheckContext): Promise<void> {
  const errors: string[] = []
  await cleanupStartupChecks(context, errors)
  let sequence = 0
  const attempt = async (argv: string[]): Promise<unknown | undefined> => {
    context.check('cleanup')
    try {
      return await context.call(`cleanup-${++sequence}`, argv)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }

  const closeUntrackedTabs = async (baselineKey: string, label: string): Promise<void> => {
    const baselineValue = context.state[baselineKey]
    const worktreeId = optionalString(context.state, 'worktreeId')
    if (!Array.isArray(baselineValue) || !baselineValue.every((entry) => typeof entry === 'string') || worktreeId === undefined) {
      errors.push(`${label} terminal cleanup lacks a valid baseline`)
      return
    }
    const layout = await attempt(['terminal', 'layout', '--worktree', worktreeId])
    if (layout === undefined) return
    try {
      const baseline = new Set(baselineValue)
      const tabs = new Set(terminalPanes(layout, `${label} cleanup layout`).map((pane) => pane.tabId))
      for (const tabId of tabs) {
        if (!baseline.has(tabId)) await attempt(['terminal', 'tab', 'close', tabId, '--yes'])
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const bufferId = optionalString(context.state, 'editorBufferId')
  if (bufferId && context.state.editorClosed !== true) {
    await attempt(['editor', 'close', '--buffer-id', bufferId])
    context.state.editorClosed = true
  }

  const automationId = optionalString(context.state, 'automationId')
  if (automationId && context.state.automationRemoved !== true) {
    await attempt(['automations', 'remove', automationId, '--yes'])
    context.state.automationRemoved = true
  }

  const loopId = optionalString(context.state, 'loopId')
  if (loopId && context.state.loopStopped !== true) {
    await attempt(['loops', 'stop', loopId, '--yes'])
    context.state.loopStopped = true
  }

  const agentSessionId = optionalString(context.state, 'agentSessionId')
  if (agentSessionId && context.state.agentClosed !== true) {
    await attempt(['session', 'close', agentSessionId, '--yes'])
    context.state.agentClosed = true
  }

  const actorTabId = optionalString(context.state, 'actorTabId')
  if (actorTabId && context.state.actorTabClosed !== true) {
    const closed = await attempt(['terminal', 'tab', 'close', actorTabId, '--yes'])
    if (closed !== undefined) context.state.actorTabClosed = true
  } else if (!actorTabId && context.state.actorTabCreated === true && context.state.actorTabClosed !== true) {
    await closeUntrackedTabs('actorTerminalBaseline', 'actor')
  }

  const exitTabId = optionalString(context.state, 'exitTabId')
  if (exitTabId && context.state.exitTabClosed !== true) {
    const closed = await attempt(['terminal', 'tab', 'close', exitTabId, '--yes'])
    if (closed !== undefined) context.state.exitTabClosed = true
  } else if (!exitTabId && context.state.exitTabCreated === true && context.state.exitTabClosed !== true) {
    await closeUntrackedTabs('exitTerminalBaseline', 'exit')
  }

  await cleanupWorkerChecks(context, attempt, errors)
  await cleanupLocalChecks(context, attempt, errors)
  const worktreeId = optionalString(context.state, 'worktreeId')
  const repoId = optionalString(context.state, 'repoId')
  if (worktreeId && repoId && context.state.worktreeRemoved !== true) {
    const removed = await attempt(['worktree', 'rm', worktreeId, '--force', '--yes'])
    if (removed !== undefined) {
      context.state.worktreeRemoved = true
      if (isObject(removed) && isObject(removed.keptBranch)) {
        context.state.retainedBranch = {
          name: stringField(removed.keptBranch, 'name', 'cleanup retained branch'),
          head: stringField(removed.keptBranch, 'head', 'cleanup retained branch')
        }
      }
    }
  }
  if (worktreeId && repoId && context.state.worktreeRemoved === true && context.state.worktreeRemovalVerified !== true) {
    const listValue = await attempt(['worktree', 'list', '--repo', `id:${repoId}`])
    if (listValue !== undefined) {
      try {
        const listed = array(listValue, 'cleanup worktree list').map((entry, index) => object(entry, `cleanup worktree list[${index}]`))
        if (listed.some((entry) => entry.id === worktreeId)) errors.push('cleanup worktree list still contains the removed worktree')
        else context.state.worktreeRemovalVerified = true
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }
  const retainedBranch = context.state.retainedBranch
  if (repoId && isObject(retainedBranch) && context.state.retainedBranchDeleted !== true) {
    const name = stringField(retainedBranch, 'name', 'cleanup retained branch')
    const head = stringField(retainedBranch, 'head', 'cleanup retained branch')
    const deleted = await attempt(['worktree', 'delete-branch', repoId, name, '--head', head, '--yes'])
    if (deleted !== undefined) context.state.retainedBranchDeleted = true
  }

  if (errors.length > 0) throw new Error(`CLI product cleanup failed: ${errors.join('; ')}`)
}
