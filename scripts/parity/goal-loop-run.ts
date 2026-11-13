import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { readRuntime } from '@quirky/protocol/node'
import { quotePosixShellLiteral } from './cli-actor'
import { createGoalLoopWorld, type GoalLoopWorld } from './goal-loop-world'

export const STEP_IDS = [
  'worktrees-create', 'agents-launch', 'terminals-roundtrip', 'loop-run-stop',
  'ask-answer-cancel', 'accounts-usage', 'worktrees-remove'
] as const

export type StepId = typeof STEP_IDS[number]
export type StepStatus = 'passed' | 'failed' | 'not-run'
export type StepResult = {
  id: StepId
  status: StepStatus
  elapsedMs: number
  evidence: Record<string, unknown>
  error?: { kind: string; message: string; stderrTail?: string }
}
export type GoalLoopReport = {
  schemaVersion: 1
  scope: 'goal-12-loop'
  ok: boolean
  providerMode: 'local-stand-ins'
  steps: StepResult[]
  cleanup: { ok: boolean; error?: string }
  elapsedMs: number
}
export type GoalLoopRunOptions = {
  signal?: AbortSignal
  createWorld?: typeof createGoalLoopWorld
  beforeStep?: (id: StepId, world: GoalLoopWorld) => void | Promise<void>
  executeStep?: (id: StepId, world: GoalLoopWorld) => Promise<Record<string, unknown>>
  onActiveTurn?: (world: GoalLoopWorld) => void | Promise<void>
  deadlineMs?: number
}

const DEFAULT_DEADLINE_MS = 120_000
const PRODUCT_CLEANUP_RESERVE_MAX_MS = 5_000
const FINAL_TEARDOWN_RESERVE_MAX_MS = 10_000
const CLI_TIMEOUT_MS = 15_000
const STDERR_LIMIT_BYTES = 8 * 1024
const STDOUT_LIMIT_BYTES = 16 * 1024 * 1024
const SHELL_COMMAND = `printf 'fixture-shell-ready\\n'; read line; printf 'ACK:%s\\n' "$line"; exec /bin/sh`
const LOOP_PROMPT = 'fixture-loop-tick'
const HELD_LOOP_PROMPT = 'fixture-loop-hold [hold]'
const EXPECTED_RESET_MS = 1_893_456_000_000

type ObjectValue = Record<string, unknown>
type CliResult = { exitCode: number; stdout: string; stderr: string }
type OwnedWorktree = {
  id: string
  name: 'goal-fixture-a' | 'goal-fixture-b'
  branch: string | null
  path: string
  parentId: null
  baseHead: string
  head: string
  agentSessionId?: string
}
type OwnedSession = { id: string; worktreeId: string; worktreeName: OwnedWorktree['name']; parentId: null; prompt?: string; tabId?: string; closed?: boolean }
type OwnedTab = { id: string; sessionId: string; worktreeId: string; closed?: boolean }
type RetainedBranch = { repoId: string; name: string; head: string }
type WorkflowState = {
  repoId?: string
  worktrees: OwnedWorktree[]
  sessions: OwnedSession[]
  shellSessionId?: string
  tabs: OwnedTab[]
  loops: string[]
  loopSessionIds: string[]
  retainedBranches: RetainedBranch[]
  productsRemoved: boolean
}
type RunContext = {
  world: GoalLoopWorld
  state: WorkflowState
  signal: AbortSignal
  controller: AbortController
  deadlineAt: number
  root: string
  tokens: string[]
  onActiveTurn?: (world: GoalLoopWorld) => void | Promise<void>
}
type TerminalPane = { tabId: string; sessionId: string }
type CodexTurn = { threadId: string; text: string }
type AskEvent = { status: string; askId: string }

export class GoalLoopFailure extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly stderrTail?: string,
    readonly evidence?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'GoalLoopFailure'
  }
}

export type GoalLoopArguments = { json: boolean; help: boolean }

export function parseGoalLoopArgs(args: string[]): GoalLoopArguments {
  if (args.length === 0) return { json: false, help: false }
  if (args.length === 1 && args[0] === '--json') return { json: true, help: false }
  if (args.length === 1 && args[0] === '--help') return { json: false, help: true }
  throw new GoalLoopFailure('invalid-arguments', 'Usage: bun scripts/parity/goal-loop.ts [--json | --help]')
}

export function parseGoalLoopOutput(stdout: string, exitCode: number, stderr = ''): unknown {
  if (exitCode !== 0) {
    const detail = diagnostic(stdout)
    throw new GoalLoopFailure('cli-nonzero', `CLI exited with status ${exitCode}${detail ? `: ${detail}` : ''}`, diagnostic(stderr))
  }
  if (Buffer.byteLength(stdout) > STDOUT_LIMIT_BYTES) {
    throw new GoalLoopFailure('malformed-cli-json', 'CLI output exceeded the JSON output limit', diagnostic(stderr))
  }
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new GoalLoopFailure('malformed-cli-json', 'CLI did not emit exactly one JSON document', diagnostic(stderr))
  }
  if (isObject(value) && value.error !== undefined && value.error !== null) {
    const error = isObject(value.error) && typeof value.error.message === 'string' ? value.error.message : 'CLI returned an error envelope'
    throw new GoalLoopFailure('cli-error', error, diagnostic(stderr))
  }
  return value
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown, label: string): ObjectValue {
  if (!isObject(value)) throw new GoalLoopFailure('malformed-cli-json', `${label} must be an object`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GoalLoopFailure('malformed-cli-json', `${label} must be an array`)
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new GoalLoopFailure('malformed-cli-json', `${label} must be a non-empty string`)
  return value
}

function positivePid(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new GoalLoopFailure('missing-process', `${label} was not an owned process`)
  }
  return value
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new GoalLoopFailure('assertion', `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
  }
}


function ensure(condition: unknown, message: string, kind = 'assertion', evidence?: Record<string, unknown>): asserts condition {
  if (!condition) throw new GoalLoopFailure(kind, message, undefined, evidence)
}

function field(value: unknown, key: string, label: string): unknown {
  return object(value, label)[key]
}

function requiredString(value: unknown, key: string, label: string): string {
  return string(field(value, key, label), `${label}.${key}`)
}

function nestedRecord(value: unknown, key: string, label: string): ObjectValue {
  return object(field(value, key, label), `${label}.${key}`)
}

function resultRecord(value: unknown, key: string, label: string): ObjectValue {
  const record = object(value, label)
  return isObject(record[key]) ? record[key] as ObjectValue : record
}

function arrayField(value: unknown, key: string, label: string): unknown[] {
  return array(field(value, key, label), `${label}.${key}`)
}

function containsUnder(root: string, candidate: string): boolean {
  const fromRoot = relative(resolve(root), resolve(candidate))
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)
}

function gitText(world: GoalLoopWorld, cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: world.env, timeout: 3_000 })
  if (result.exitCode !== 0) {
    throw new GoalLoopFailure('fixture-git', `read-only Git ${args[0]} failed`, result.stderr.toString('utf8'))
  }
  return result.stdout.toString('utf8').trim()
}

function parseJsonLines(text: string, label: string): ObjectValue[] {
  const lines = text.split(/\r?\n/).filter(line => line.length > 0)
  return lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new GoalLoopFailure('fixture-log', `${label}[${index}] was not JSON`)
    }
    return object(value, `${label}[${index}]`)
  })
}

function occurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let offset = 0
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

function terminalPanes(value: unknown, label: string): TerminalPane[] {
  const result = object(value, label)
  const workspace = isObject(result.workspace) ? result.workspace : result
  const panes: TerminalPane[] = []
  const visit = (node: unknown, tabId?: string): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, tabId)
      return
    }
    if (!isObject(node)) return
    if (node.kind === 'pane') {
      if (tabId !== undefined && typeof node.session === 'string') panes.push({ tabId, sessionId: node.session })
      return
    }
    if (Array.isArray(node.tabs)) {
      for (const item of node.tabs) {
        if (isObject(item) && typeof item.id === 'string' && item.root !== undefined) visit(item.root, item.id)
        else visit(item, tabId)
      }
    }
    if (node.root !== undefined) visit(node.root, typeof node.id === 'string' && tabId === undefined ? node.id : tabId)
    if (node.first !== undefined) visit(node.first, tabId)
    if (node.second !== undefined) visit(node.second, tabId)
  }
  visit(workspace.root)
  return panes
}

function textFromTerminal(value: unknown, label: string): string {
  return arrayField(value, 'lines', label).map((line, index) => string(line, `${label}.lines[${index}]`)).join('\n')
}

function codexTurns(text: string): CodexTurn[] {
  return parseJsonLines(text, 'Codex fixture log')
    .filter(entry => entry.method === 'turn/start')
    .map((entry, index) => {
      const params = object(entry.params, `Codex turn ${index}.params`)
      const input = array(params.input, `Codex turn ${index}.params.input`)
      const content = input.map((part, partIndex) => {
        const item = object(part, `Codex turn ${index}.input[${partIndex}]`)
        return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
      }).filter(Boolean).join('\n')
      return { threadId: requiredString(params, 'threadId', `Codex turn ${index}.params`), text: content }
    })
}

function askEvents(stdout: string, label: string): AskEvent[] {
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0)
  return lines.map((line, index) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      throw new GoalLoopFailure('malformed-ask-jsonl', `${label}[${index}] was not JSON`)
    }
    const event = object(value, `${label}[${index}]`)
    return { status: requiredString(event, 'status', `${label}[${index}]`), askId: requiredString(event, 'askId', `${label}[${index}]`) }
  })
}

function usageProvider(value: unknown, providers: ObjectValue[], label: string): ObjectValue {
  const found = providers.find(provider => provider.provider === value)
  if (!found) throw new GoalLoopFailure('usage-evidence', `${label} provider was absent from accounts usage`)
  return found
}

function turnsForPrompt(turns: CodexTurn[], prompt: string): CodexTurn[] {
  return turns.filter(turn => turn.text.includes(prompt))
}

function diagnostic(text: string, ctx?: Pick<RunContext, 'root' | 'tokens'>): string {
  let value = text
  if (ctx) {
    if (ctx.root.length > 0) value = value.split(ctx.root).join('<owned-root>')
    for (const token of ctx.tokens) if (token.length > 0) value = value.split(token).join('<redacted>')
  }
  value = value.replace(/("[^"]*(?:token|authorization|secret|password)[^"]*"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2')
    .replace(/((?:token|authorization|secret|password)\s*[=:]\s*)[^\s,"'}]+/gi, '$1<redacted>')
    .replace(/Bearer\s+[^\s,"'}]+/gi, 'Bearer <redacted>')
  if (Buffer.byteLength(value, 'utf8') <= STDERR_LIMIT_BYTES) return value
  const bytes = Buffer.from(value, 'utf8')
  let start = bytes.length - STDERR_LIMIT_BYTES
  while ((bytes[start]! & 0xc0) === 0x80) start += 1
  return bytes.subarray(start).toString('utf8')
}

function safeValue(value: unknown, ctx: Pick<RunContext, 'root' | 'tokens'>): unknown {
  if (typeof value === 'string') return diagnostic(value, ctx)
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (Array.isArray(value)) return value.map(item => safeValue(item, ctx))
  if (!isObject(value)) return String(value)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item, ctx)]))
}

function errorDetails(error: unknown, ctx?: Pick<RunContext, 'root' | 'tokens'>): {
  kind: string
  message: string
  stderrTail?: string
  evidence: Record<string, unknown>
} {
  const record = isObject(error) ? error : {}
  const kind = typeof record.kind === 'string' ? record.kind : 'assertion'
  const message = diagnostic(error instanceof Error ? error.message : String(error), ctx)
  const stderr = typeof record.stderrTail === 'string' ? diagnostic(record.stderrTail, ctx) : undefined
  const evidence = isObject(record.evidence) ? safeValue(record.evidence, ctx ?? { root: '', tokens: [] }) as Record<string, unknown> : {}
  return { kind, message, ...(stderr === undefined ? {} : { stderrTail: stderr }), evidence }
}

function collectTokens(world: GoalLoopWorld): string[] {
  const tokens = Object.entries(world.env)
    .filter(([key]) => /token|secret|credential|authorization/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  const home = world.env.QUIRKY_HOME
  if (typeof home === 'string') {
    try {
      const runtime = readRuntime(home)
      if (runtime?.token) tokens.push(runtime.token)
      if (runtime?.hookToken) tokens.push(runtime.hookToken)
    } catch {}
  }
  return [...new Set(tokens)]
}

function failureFromSignal(signal: AbortSignal): GoalLoopFailure {
  const reason = signal.reason
  if (reason instanceof GoalLoopFailure) return reason
  if (isObject(reason) && typeof reason.kind === 'string') {
    return new GoalLoopFailure(reason.kind, reason.message instanceof Error ? reason.message.message : String(reason.message ?? reason.kind))
  }
  return new GoalLoopFailure('interrupted', reason instanceof Error ? reason.message : 'Goal loop rehearsal interrupted')
}

function checkAbort(ctx: Pick<RunContext, 'signal' | 'controller' | 'deadlineAt'>): void {
  if (ctx.signal.aborted) throw failureFromSignal(ctx.signal)
  if (Date.now() >= ctx.deadlineAt) {
    const failure = new GoalLoopFailure('deadline', 'Goal loop work deadline exceeded')
    ctx.controller.abort(failure)
    throw failure
  }
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal.aborted) throw failureFromSignal(signal)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let timer: ReturnType<typeof setTimeout>
  const onAbort = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    reject(failureFromSignal(signal))
  }
  timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  await promise
}

async function cliJson(
  ctx: RunContext,
  args: string[],
  signal: AbortSignal = ctx.signal,
  deadlineAt = ctx.deadlineAt
): Promise<unknown> {
  if (signal === ctx.signal) checkAbort(ctx)
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) throw new GoalLoopFailure('deadline', 'No CLI time remains in the owned rehearsal deadline')
  let result: CliResult
  try {
    result = await ctx.world.cli(args, { signal, timeoutMs: Math.max(1, Math.min(CLI_TIMEOUT_MS, remaining)) })
  } catch (error) {
    if (signal.aborted) throw failureFromSignal(signal)
    const details = errorDetails(error, ctx)
    throw new GoalLoopFailure(details.kind, details.message, details.stderrTail)
  }
  try {
    return parseGoalLoopOutput(result.stdout, result.exitCode, result.stderr)
  } catch (error) {
    const details = errorDetails(error, ctx)
    throw new GoalLoopFailure(details.kind, details.message, details.stderrTail)
  }
}

async function poll<T>(
  ctx: RunContext,
  label: string,
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs = 15_000
): Promise<T> {
  const end = Math.min(Date.now() + timeoutMs, ctx.deadlineAt)
  let last: T | undefined
  while (Date.now() < end) {
    checkAbort(ctx)
    last = await read()
    if (ready(last)) return last
    const remaining = end - Date.now()
    if (remaining > 0) await sleep(Math.min(100, remaining), ctx.signal)
  }
  throw new GoalLoopFailure('timeout', `Timed out waiting for ${label}`)
}

async function createWorktrees(ctx: RunContext): Promise<Record<string, unknown>> {
  const daemonPid = positivePid(ctx.world.daemonPid, 'Owned daemon PID')
  const repoPath = resolve(ctx.world.repoPath)
  ensure(containsUnder(ctx.root, repoPath), 'Fixture repository escaped the owned root', 'fixture-path')
  const repo = object(await cliJson(ctx, ['repo', 'add', repoPath]), 'repo add result')
  equal(repo.kind, 'git', 'repo kind')
  equal(resolve(requiredString(repo, 'path', 'repo add result')), repoPath, 'repo path')
  const repoId = requiredString(repo, 'id', 'repo add result')
  ctx.state.repoId = repoId

  const worktreesRoot = resolve(ctx.world.paths.worktreesRoot)
  ensure(containsUnder(ctx.root, worktreesRoot), 'Worktrees root escaped the owned root', 'fixture-path')
  await cliJson(ctx, ['setting', 'set', 'setting:quirky.worktree/worktreesRoot', worktreesRoot])

  const baseHead = gitText(ctx.world, repoPath, ['rev-parse', 'main'])
  const created: OwnedWorktree[] = []
  for (const [name, prompt] of [['goal-fixture-a', 'fixture-initial-a'], ['goal-fixture-b', undefined]] as const) {
    const args = ['worktree', 'create', '--repo', `id:${repoId}`, '--name', name, '--base', 'main', '--no-parent', '--setup', 'skip']
    if (prompt !== undefined) args.push('--agent', 'omp', '--prompt', prompt)
    const receipt = object(await cliJson(ctx, args), `${name} create result`)
    const worktree = nestedRecord(receipt, 'worktree', `${name} create result`)
    const id = requiredString(worktree, 'id', `${name} worktree`)
    const path = resolve(requiredString(worktree, 'path', `${name} worktree`))
    ensure(containsUnder(ctx.root, path) && containsUnder(worktreesRoot, path), `${name} escaped the owned worktree root`, 'fixture-path')
    equal(worktree.parentId, null, `${name} parentId`)
    const head = gitText(ctx.world, path, ['rev-parse', 'HEAD'])
    equal(head, baseHead, `${name} HEAD from local main`)
    const tracked: OwnedWorktree = {
      id,
      name,
      branch: typeof worktree.branch === 'string' ? worktree.branch : null,
      path,
      parentId: null,
      baseHead,
      head,
      ...(typeof receipt.agentSessionId === 'string' ? { agentSessionId: receipt.agentSessionId } : {})
    }
    created.push(tracked)
    ctx.state.worktrees.push(tracked)
  }
  return {
    repoId,
    worktrees: created.map(worktree => ({
      id: worktree.id, name: worktree.name, branch: worktree.branch,
      base: 'main', parentId: worktree.parentId, baseHead: worktree.baseHead, head: worktree.head,
      ...(worktree.agentSessionId === undefined ? {} : { agentSessionId: worktree.agentSessionId })
    })),
    daemonPid,
  }
}

function worktreeByName(ctx: RunContext, name: OwnedWorktree['name']): OwnedWorktree {
  const worktree = ctx.state.worktrees.find(item => item.name === name)
  if (!worktree) throw new GoalLoopFailure('missing-worktree', `Owned worktree ${name} was not created`)
  return worktree
}

function promptRecords(text: string, prompt: string, sessionId: string): number {
  const records = parseJsonLines(text, 'OMP argv log')
  const matching = records.filter(record => record.sessionId === sessionId && record.prompt === prompt)
  if (matching.length !== 1) throw new GoalLoopFailure('missing-agent', `OMP argv log did not record ${prompt} once`)
  const argv = array(matching[0]!.argv, 'OMP argv record.argv').map((part, index) => string(part, `OMP argv record.argv[${index}]`))
  const count = argv.filter(part => part === prompt).length
  if (count !== 1) throw new GoalLoopFailure('missing-agent', `OMP argv did not contain ${prompt} exactly once`)
  return count
}

async function launchAgents(ctx: RunContext): Promise<Record<string, unknown>> {
  const a = worktreeByName(ctx, 'goal-fixture-a')
  const b = worktreeByName(ctx, 'goal-fixture-b')
  if (!a.agentSessionId) throw new GoalLoopFailure('missing-agent', 'Worktree A create did not return its OMP session ID')
  const launched = object(await cliJson(ctx, [
    'session', 'new', '--worktree', b.id, '--agent', 'omp', '--prompt', 'fixture-initial-b'
  ]), 'worktree B OMP launch result')
  const sessionBId = requiredString(launched, 'id', 'worktree B OMP launch result')
  const sessions: OwnedSession[] = [
    { id: a.agentSessionId, worktreeId: a.id, worktreeName: a.name, parentId: a.parentId, prompt: 'fixture-initial-a' },
    { id: sessionBId, worktreeId: b.id, worktreeName: b.name, parentId: b.parentId, prompt: 'fixture-initial-b' }
  ]
  ctx.state.sessions.push(...sessions)
  const evidence: Record<string, unknown>[] = []
  for (const session of sessions) {
    const worktree = worktreeByName(ctx, session.worktreeName)
    const snapshot = object(await cliJson(ctx, ['session', 'get', session.id]), `${session.worktreeName} session read`)
    equal(snapshot.id, session.id, `${session.worktreeName} session ID`)
    equal(snapshot.kind, 'terminal', `${session.worktreeName} session kind`)
    equal(snapshot.worktreeId, worktree.id, `${session.worktreeName} session worktree`)
    const marker = `PROMPT:${session.prompt}:${session.id}`
    const argvLog = await poll(
      ctx,
      `${session.worktreeName} OMP argv prompt`,
      () => ctx.world.readLog('omp'),
      text => parseJsonLines(text, 'OMP argv log').some(record => record.sessionId === session.id && record.prompt === session.prompt)
    )
    const argvPromptCount = promptRecords(argvLog, session.prompt!, session.id)
    const terminal = await poll(
      ctx,
      `${session.worktreeName} terminal prompt`,
      async () => textFromTerminal(await cliJson(ctx, ['terminal', 'read', session.id, '--lines', '100']), `${session.worktreeName} prompt terminal`),
      text => occurrences(text, marker) > 0
    )
    const terminalCount = occurrences(terminal, marker)
    ensure(terminalCount === 1, `${session.worktreeName} terminal did not show its prompt marker exactly once`, 'missing-agent')
    evidence.push({
      id: session.id, worktreeId: worktree.id, worktreeName: worktree.name, prompt: session.prompt, kind: snapshot.kind,
      parentId: worktree.parentId, argvPromptCount,
      terminalPromptCount: terminalCount, terminalQuoteCount: terminalCount, terminalQuote: marker
    })
  }
  const ptyPid = positivePid(ctx.world.ptyPid, 'Owned PTY host PID')
  return { sessions: evidence, ptyPid }
}

function sessionIds(value: unknown, label: string): Set<string> {
  const sessions = array(value, label)
  return new Set(sessions.map((entry, index) => requiredString(entry, 'id', `${label}[${index}]`)))
}

function inputLines(text: string, sessionId: string): string[] {
  return parseJsonLines(text, 'OMP input log')
    .filter(entry => entry.sessionId === sessionId)
    .map((entry, index) => requiredString(entry, 'line', `OMP input ${index}`))
}

async function readSession(ctx: RunContext, sessionId: string): Promise<string> {
  return textFromTerminal(await cliJson(ctx, ['terminal', 'read', sessionId, '--lines', '100']), `terminal read ${sessionId}`)
}

async function terminalRoundtrip(ctx: RunContext): Promise<Record<string, unknown>> {
  const a = worktreeByName(ctx, 'goal-fixture-a')
  const b = worktreeByName(ctx, 'goal-fixture-b')
  const sessionA = ctx.state.sessions.find(item => item.worktreeId === a.id)
  const sessionB = ctx.state.sessions.find(item => item.worktreeId === b.id)
  ensure(sessionA && sessionB, 'Initial OMP sessions were not recorded')
  const listedA = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', a.id]), 'sessions scoped to A')
  const listedB = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', b.id]), 'sessions scoped to B')
  ensure(listedA.has(sessionA.id) && !listedA.has(sessionB.id), 'A-scoped session list did not isolate A')
  ensure(listedB.has(sessionB.id) && !listedB.has(sessionA.id), 'B-scoped session list did not isolate B')
  const before = await readSession(ctx, sessionA.id)
  const nudge = 'fixture-nudge-a'
  const send = await cliJson(ctx, ['terminal', 'send', sessionA.id, nudge, '--enter'])
  object(send, 'terminal send receipt')
  const sendReceiptReceived = true
  let after = ''
  const ack = `ACK:${nudge}`
  try {
    await poll(ctx, 'A terminal ACK and OMP input bytes', async () => {
      const [output, logged] = await Promise.all([readSession(ctx, sessionA.id), ctx.world.readLog('omp-input')])
      after = output
      return { output, input: inputLines(logged, sessionA.id) }
    }, value => value.input.length === 1 && value.input[0] === nudge && occurrences(value.output, ack) === 1)
  } catch (error) {
    const details = errorDetails(error, ctx)
    throw new GoalLoopFailure(details.kind === 'timeout' ? 'missing-terminal-ack' : details.kind, details.message, details.stderrTail, {
      sendReceiptReceived, inputLines: inputLines(await ctx.world.readLog('omp-input'), sessionA.id), ackCount: occurrences(after, ack)
    })
  }
  const inputsA = inputLines(await ctx.world.readLog('omp-input'), sessionA.id)
  equal(inputsA, [nudge], 'OMP received input bytes')
  const rawInputLines = parseJsonLines(await ctx.world.readLog('omp-input'), 'OMP input bytes')
    .filter(entry => entry.sessionId === sessionA.id)
    .map((entry, index) => requiredString(entry, 'rawLine', `OMP raw input ${index}`))
  ensure(rawInputLines.length === 1 && (rawInputLines[0] === nudge || rawInputLines[0] === `\u001b[200~${nudge}\u001b[201~`),
    'OMP received bytes did not contain exactly one input payload', 'missing-terminal-ack', { sendReceiptReceived, rawInputLines })
  after = await readSession(ctx, sessionA.id)
  const afterAckCount = occurrences(after, ack)
  ensure(afterAckCount === 1, 'A terminal ACK was not present exactly once', 'missing-terminal-ack', { sendReceiptReceived })
  const outputB = await readSession(ctx, sessionB.id)
  const ackCountB = occurrences(outputB, ack)
  equal(ackCountB, 0, 'B terminal ACK count')

  const beforePanes = terminalPanes(await cliJson(ctx, ['terminal', 'layout', '--worktree', b.id]), 'B terminal layout before shell')
  const beforePanesA = terminalPanes(await cliJson(ctx, ['terminal', 'layout', '--worktree', a.id]), 'A terminal layout before shell')
  for (const [session, panes] of [[sessionA, beforePanesA], [sessionB, beforePanes]] as const) {
    const pane = panes.find(item => item.sessionId === session.id)
    if (!pane) continue
    session.tabId = pane.tabId
    if (!ctx.state.tabs.some(tab => tab.id === pane.tabId)) {
      ctx.state.tabs.push({ id: pane.tabId, sessionId: session.id, worktreeId: session.worktreeId })
    }
  }
  const beforeTabs = new Set(beforePanes.map(pane => pane.tabId))
  const createdLayout = await cliJson(ctx, [
    'terminal', 'tab', 'new', '--worktree', b.id, '--agent', 'shell', '--command', `/bin/sh -c ${quotePosixShellLiteral(SHELL_COMMAND)}`
  ])
  const createdPanes = terminalPanes(createdLayout, 'new shell terminal layout')
  const tabIds = [...new Set(createdPanes.filter(pane => !beforeTabs.has(pane.tabId)).map(pane => pane.tabId))]
  ensure(tabIds.length === 1, `Expected one new shell tab, found ${tabIds.length}`)
  const shellTabId = tabIds[0]!
  const shellPane = createdPanes.find(pane => pane.tabId === shellTabId)
  ensure(shellPane, 'New shell tab had no terminal session')
  const shellSessionId = shellPane.sessionId
  ctx.state.tabs.push({ id: shellTabId, sessionId: shellSessionId, worktreeId: b.id })
  ctx.state.sessions.push({ id: shellSessionId, worktreeId: b.id, worktreeName: b.name, parentId: b.parentId, tabId: shellTabId })
  ctx.state.shellSessionId = shellSessionId
  await poll(ctx, 'fixture shell readiness', () => readSession(ctx, shellSessionId), text => text.includes('fixture-shell-ready'))
  const shellInput = 'fixture-shell-input'
  const shellSend = await cliJson(ctx, ['terminal', 'send', shellSessionId, shellInput, '--enter'])
  object(shellSend, 'shell input send receipt')
  let shellOutput = ''
  const shellAck = `ACK:${shellInput}`
  await poll(ctx, 'independent shell ACK', async () => {
    shellOutput = await readSession(ctx, shellSessionId)
    return shellOutput
  }, text => occurrences(text, shellAck) === 1)
  shellOutput = await readSession(ctx, shellSessionId)
  const shellAckCount = occurrences(shellOutput, shellAck)
  ensure(shellAckCount === 1, 'Independent shell ACK was not present exactly once', 'missing-terminal-ack', { sendReceiptReceived: true })
  return {
    scopedSessionLists: { aContainsOnlyA: true, bContainsOnlyB: true, listedA: [...listedA], listedB: [...listedB] },
    nudge: { text: nudge, sendReceiptReceived, inputLines: inputsA, rawInputLines, ackQuote: ack, ackCountA: afterAckCount, ackCountB },
    shell: { tabId: shellTabId, sessionId: shellSessionId, input: shellInput, sendReceiptReceived: true, ackQuote: shellAck, ackCount: shellAckCount },
    initialReadContainedPrompt: before.includes('PROMPT:fixture-initial-a:')
  }
}

function loopSnapshot(value: unknown, label: string): ObjectValue {
  return resultRecord(value, 'loop', label)
}

function loopArray(value: unknown, label: string): ObjectValue[] {
  const raw = Array.isArray(value) ? value : arrayField(value, 'loops', label)
  return raw.map((entry, index) => object(entry, `${label}[${index}]`))
}

function loopOutput(loop: ObjectValue, prompt: string, label: string): { quote: string; quoteCount: number; endReason?: string } {
  const iterations = arrayField(loop, 'recentIterations', label)
  const iteration = iterations.find(entry => isObject(entry) && typeof entry.outputTail === 'string' && entry.outputTail.includes(prompt))
  if (!isObject(iteration) || typeof iteration.outputTail !== 'string') {
    throw new GoalLoopFailure('missing-loop-output', `${label} did not record output containing ${prompt}`)
  }
  const quote = prompt
  const quoteCount = occurrences(iteration.outputTail, quote)
  ensure(quoteCount === 1, `${label} output did not contain its marker exactly once`)
  return { quote, quoteCount, ...(typeof iteration.endReason === 'string' ? { endReason: iteration.endReason } : {}) }
}

function loopState(loop: ObjectValue, expected: string, label: string): void {
  equal(loop.state, expected, `${label}.state`)
}

function trackLoopSession(ctx: RunContext, worktree: OwnedWorktree, loop: ObjectValue, label: string): string {
  equal(loop.worktreeId, worktree.id, `${label} worktree`)
  const sessionId = requiredString(loop, 'sessionId', label)
  if (!ctx.state.loopSessionIds.includes(sessionId)) ctx.state.loopSessionIds.push(sessionId)
  return sessionId
}
async function loops(ctx: RunContext): Promise<Record<string, unknown>> {
  const b = worktreeByName(ctx, 'goal-fixture-b')
  const createdValue = await cliJson(ctx, [
    'loop', 'create', '--agent', 'codex', '--worktree', b.id, '--preset', 'interval', '--every', '1',
    '--max-iterations', '1', '--prompt', LOOP_PROMPT
  ])
  const cappedCreate = loopSnapshot(createdValue, 'loop create result')
  const cappedId = requiredString(cappedCreate, 'id', 'loop create result')
  ctx.state.loops.push(cappedId)
  const listed = loopArray(await cliJson(ctx, ['loop', 'list', '--worktree', b.id]), 'loop list result')
  ensure(listed.some(loop => loop.id === cappedId), 'loop list omitted the created loop')
  let capped = await poll(ctx, 'one completed loop iteration', async () => {
    const snapshot = loopSnapshot(await cliJson(ctx, ['loop', 'show', cappedId]), 'loop show poll')
    return snapshot
  }, value => value.iterationsCompleted === 1 && value.state === 'paused' && value.pauseReason === 'cap-iterations')
  equal(capped.iterationsCompleted, 1, 'capped loop iterationsCompleted')
  equal(capped.pauseReason, 'cap-iterations', 'capped loop pauseReason')
  const cappedOutput = loopOutput(capped, LOOP_PROMPT, 'capped loop')
  const cappedSessionId = trackLoopSession(ctx, b, capped, 'capped loop session')
  const turnsBeforeStop = codexTurns(await ctx.world.readLog('codex'))
  const promptTurns = turnsForPrompt(turnsBeforeStop, LOOP_PROMPT)
  equal(promptTurns.length, 1, 'native Codex loop request count')
  equal(occurrences(promptTurns[0]!.text, LOOP_PROMPT), 1, 'native Codex prompt marker count')
  const stopReceipt = loopSnapshot(await cliJson(ctx, ['loop', 'stop', cappedId]), 'ordinary loop stop result')
  loopState(stopReceipt, 'stopped', 'ordinary loop stop')
  const stoppedCapped = loopSnapshot(await cliJson(ctx, ['loop', 'show', cappedId]), 'ordinary loop stopped readback')
  loopState(stoppedCapped, 'stopped', 'ordinary loop stopped readback')

  const heldValue = await cliJson(ctx, [
    'loop', 'create', '--agent', 'codex', '--worktree', b.id, '--preset', 'interval', '--every', '1',
    '--max-iterations', '1', '--prompt', HELD_LOOP_PROMPT
  ])
  const heldCreate = loopSnapshot(heldValue, 'held loop create result')
  const heldId = requiredString(heldCreate, 'id', 'held loop create result')
  ctx.state.loops.push(heldId)
  const heldTurns = await poll(ctx, 'active held native Codex turn', async () => {
    const all = codexTurns(await ctx.world.readLog('codex'))
    return turnsForPrompt(all, HELD_LOOP_PROMPT)
  }, turns => turns.length === 1, 15_000)
  const activeTurn = heldTurns[0]!
  const heldState = loopSnapshot(await cliJson(ctx, ['loop', 'show', heldId]), 'held loop active snapshot')
  ensure(heldState.state === 'running' || heldState.state === 'needs-you', 'Held loop was not active when observed')
  const heldSessionId = trackLoopSession(ctx, b, heldState, 'held loop session')
  await ctx.onActiveTurn?.(ctx.world)
  checkAbort(ctx)
  const immediateStop = loopSnapshot(await cliJson(ctx, ['loop', 'stop', heldId, '--now']), 'immediate loop stop result')
  loopState(immediateStop, 'stopped', 'immediate loop stop')
  const stoppedHeld = loopSnapshot(await cliJson(ctx, ['loop', 'show', heldId]), 'immediate loop stopped readback')
  loopState(stoppedHeld, 'stopped', 'immediate loop stopped readback')
  const codexAfterStop = parseJsonLines(await ctx.world.readLog('codex'), 'Codex fixture log')
  const interruptRequests = codexAfterStop.filter(entry => entry.method === 'turn/interrupt' && isObject(entry.params) && entry.params.threadId === activeTurn.threadId)
  const heldTurnCountBeforeDelay = turnsForPrompt(codexTurns(await ctx.world.readLog('codex')), HELD_LOOP_PROMPT).length
  await sleep(1_100, ctx.signal)
  const heldTurnCountAfterDelay = turnsForPrompt(codexTurns(await ctx.world.readLog('codex')), HELD_LOOP_PROMPT).length
  equal(heldTurnCountBeforeDelay, 1, 'held native turn start count before stop verification')
  equal(heldTurnCountAfterDelay, heldTurnCountBeforeDelay, 'held native turn start count after stop')
  equal(interruptRequests.length, 1, 'native Codex interruption request count')
  const stoppedIterations = arrayField(stoppedHeld, 'recentIterations', 'stopped held loop')
  const stoppedIteration = stoppedIterations.findLast(entry => isObject(entry) && typeof entry.endReason === 'string')
  ensure(isObject(stoppedIteration), 'Stopped held loop did not record an iteration outcome')
  const turnOutcome = string(stoppedIteration.endReason, 'stopped held loop iteration endReason')
  ensure(turnOutcome === 'interrupted' || turnOutcome === 'stopped', 'Held loop iteration did not record an interrupted or stopped outcome')
  return {
    capped: {
      id: cappedId, sessionId: cappedSessionId, prompt: LOOP_PROMPT, iterationsCompleted: capped.iterationsCompleted,
      state: capped.state, pauseReason: capped.pauseReason, turnStartCount: promptTurns.length,
      promptCount: occurrences(promptTurns[0]!.text, LOOP_PROMPT), outputQuote: cappedOutput.quote,
      outputQuoteCount: cappedOutput.quoteCount
    },
    ordinaryStop: { id: cappedId, state: stoppedCapped.state },
    interrupt: {
      id: heldId, sessionId: heldSessionId, state: stoppedHeld.state, activeTurnObserved: true,
      turnOutcome, interruptRequestCount: interruptRequests.length,
      extraTurnStartCount: heldTurnCountAfterDelay - heldTurnCountBeforeDelay,
    }
  }
}

function writeCommand(command: string, outputFile: string): string {
  return `${command} > ${quotePosixShellLiteral(outputFile)}`
}

async function readAskFile(ctx: RunContext, path: string, label: string, expectedEvents = 1): Promise<string> {
  return poll(ctx, label, async () => {
    if (!existsSync(path)) return ''
    return readFileSync(path, 'utf8')
  }, text => text.endsWith('\n') && text.split(/\r?\n/).filter(Boolean).length >= expectedEvents, 15_000)
}

async function sendShellCommand(ctx: RunContext, sessionId: string, command: string): Promise<void> {
  object(await cliJson(ctx, ['terminal', 'send', sessionId, command, '--enter']), 'shell command send receipt')
}

async function askAnswerCancel(ctx: RunContext): Promise<Record<string, unknown>> {
  const shell = ctx.state.sessions.find(session => session.id === ctx.state.shellSessionId)
  ensure(shell, 'Ask fixture requires the owned live shell session')
  const askSpec = ctx.world.paths.askSpec
  ensure(isAbsolute(askSpec) && containsUnder(ctx.root, askSpec), 'Ask spec escaped the owned root', 'fixture-path')
  const answerOutput = resolve(ctx.root, 'ask-answer.jsonl')
  const answerCommand = writeCommand(
    `quirky ask --spec ${quotePosixShellLiteral(`@${askSpec}`)} --chunk-ms 50 --timeout-ms 10000 --runtime local --json`, answerOutput
  )
  await sendShellCommand(ctx, shell.id, answerCommand)
  const answerText = await readAskFile(ctx, answerOutput, 'Ask registration JSONL', 2)
  const events = askEvents(answerText, 'Ask registration event')
  ensure(events.length === 2, `Ask registration produced ${events.length} events`)
  equal(events[0]!.status, 'registered', 'Ask registration status')
  equal(events[1]!.status, 'pending', 'Ask pending status')
  equal(events[0]!.askId, events[1]!.askId, 'Ask registration ID consistency')
  const answerId = events[0]!.askId
  ensure(answerId.length > 0, 'Ask registration returned an empty ID')
  await cliJson(ctx, ['api', 'call', 'quirky.ask/answer', '--ask-id', answerId, '--answers', JSON.stringify({ continue: { value: true, source: 'input' } })])
  const answeredPath = resolve(ctx.root, 'ask-answer-wait.jsonl')
  await sendShellCommand(ctx, shell.id, writeCommand(`quirky ask wait --id ${quotePosixShellLiteral(answerId)} --chunk-ms 1000 --runtime local --json`, answeredPath))
  const answeredOutput = await readAskFile(ctx, answeredPath, 'answered Ask envelope')
  const answerLines = askEvents(answeredOutput, 'answered Ask envelope')
  ensure(answerLines.length === 1 && answerLines[0]!.status === 'answered', 'Live Ask wait did not return one answered envelope')
  const answeredEnvelope = object(JSON.parse(answeredOutput.trim()), 'answered Ask envelope')
  equal(answeredEnvelope.askId, answerId, 'answered Ask ID')
  equal(answeredEnvelope.answers, { continue: { value: true, source: 'input' } }, 'answered Ask answers')
  equal(answeredEnvelope.skipped, [], 'answered Ask skipped answers')

  const cancelOutput = resolve(ctx.root, 'ask-cancel.jsonl')
  await sendShellCommand(ctx, shell.id, writeCommand(
    `quirky ask --spec ${quotePosixShellLiteral(`@${askSpec}`)} --chunk-ms 50 --timeout-ms 10000 --runtime local --json`, cancelOutput
  ))
  const cancelText = await readAskFile(ctx, cancelOutput, 'cancellable Ask JSONL', 2)
  const cancelEvents = askEvents(cancelText, 'cancellable Ask event')
  ensure(cancelEvents.length === 2, `Cancellable Ask produced ${cancelEvents.length} events`)
  equal(cancelEvents[0]!.status, 'registered', 'cancellable Ask registration status')
  equal(cancelEvents[1]!.status, 'pending', 'cancellable Ask pending status')
  equal(cancelEvents[0]!.askId, cancelEvents[1]!.askId, 'cancellable Ask ID consistency')
  const cancelId = cancelEvents[0]!.askId
  ensure(cancelId !== answerId, 'Two fixture Asks unexpectedly shared an ID')
  await cliJson(ctx, ['ask', 'cancel', '--id', cancelId])
  const declinedPath = resolve(ctx.root, 'ask-cancel-wait.jsonl')
  await sendShellCommand(ctx, shell.id, writeCommand(`quirky ask wait --id ${quotePosixShellLiteral(cancelId)} --chunk-ms 1000 --runtime local --json`, declinedPath))
  const declinedOutput = await readAskFile(ctx, declinedPath, 'declined Ask envelope')
  const declinedEnvelope = object(JSON.parse(declinedOutput.trim()), 'declined Ask envelope')
  equal(declinedEnvelope.askId, cancelId, 'declined Ask ID')
  equal(declinedEnvelope.status, 'declined', 'cancelled Ask terminal status')
  return {
    answered: {
      askId: answerId, events: events.map(event => ({ status: event.status, askId: event.askId })),
      wait: { status: answeredEnvelope.status, askId: answeredEnvelope.askId, answers: answeredEnvelope.answers, skipped: answeredEnvelope.skipped }
    },
    cancelled: { askId: cancelId, events: cancelEvents.map(event => ({ status: event.status, askId: event.askId })), wait: { status: declinedEnvelope.status, askId: declinedEnvelope.askId } }
  }
}

function providerList(value: unknown): ObjectValue[] {
  const entries = arrayField(value, 'providers', 'accounts usage')
  return entries.map((entry, index) => object(entry, `accounts usage.providers[${index}]`))
}

function usageWindow(provider: ObjectValue, key: string, providerName: string): ObjectValue {
  return nestedRecord(provider, key, `${providerName} usage`)
}

async function accountsUsage(ctx: RunContext): Promise<Record<string, unknown>> {
  const list = object(await cliJson(ctx, ['accounts', 'list']), 'managed accounts list')
  const managed = arrayField(list, 'accounts', 'managed accounts list')
  equal(managed.length, 0, 'managed account count')
  const turnsBefore = codexTurns(await ctx.world.readLog('codex')).length
  const codexCallsBefore = parseJsonLines(await ctx.world.readLog('codex'), 'Codex fixture log')
  const codexReadsBefore = codexCallsBefore.filter(entry => entry.method === 'account/rateLimits/read').length
  const agyCallsBefore = parseJsonLines(await ctx.world.readLog('agy'), 'Antigravity argv log').length
  await cliJson(ctx, ['accounts', 'refresh', '--provider', 'codex'])
  await cliJson(ctx, ['accounts', 'refresh', '--provider', 'antigravity'])
  const claudeRefresh = providerList(await cliJson(ctx, ['accounts', 'refresh', '--provider', 'claude']))
  const refreshedClaude = usageProvider('claude', claudeRefresh, 'Claude refresh')
  equal(refreshedClaude.status, 'unavailable', 'Claude refresh status')
  equal(refreshedClaude.session, null, 'Claude refresh session')
  equal(refreshedClaude.weekly, null, 'Claude refresh weekly')
  const providers = providerList(await cliJson(ctx, ['accounts', 'usage']))
  const codex = usageProvider('codex', providers, 'Codex')
  const antigravity = usageProvider('antigravity', providers, 'Antigravity')
  const claude = usageProvider('claude', providers, 'Claude')
  equal(codex.status, 'ok', 'Codex usage status')
  equal(antigravity.status, 'ok', 'Antigravity usage status')
  equal(claude.status, 'unavailable', 'Claude usage status')
  const codexSession = usageWindow(codex, 'session', 'Codex')
  const codexWeekly = usageWindow(codex, 'weekly', 'Codex')
  const agySession = usageWindow(antigravity, 'session', 'Antigravity')
  const agyWeekly = usageWindow(antigravity, 'weekly', 'Antigravity')
  for (const [window, percent, label] of [
    [codexSession, 31, 'Codex session'], [codexWeekly, 12, 'Codex weekly'],
    [agySession, 25, 'Antigravity session'], [agyWeekly, 60, 'Antigravity weekly']
  ] as const) {
    equal(window.usedPercent, percent, `${label} percentage`)
    equal(window.resetsAt, EXPECTED_RESET_MS, `${label} reset timestamp`)
  }
  equal(claude.session, null, 'Claude usage session')
  equal(claude.weekly, null, 'Claude usage weekly')
  const resetCredits = object(codex.rateLimitResetCredits, 'Codex rate-limit reset credits')
  equal(resetCredits.availableCount, 1, 'Codex reset-credit availability')
  const agyCalls = parseJsonLines(await ctx.world.readLog('agy'), 'Antigravity argv log')
  const agyArgv = agyCalls.slice(agyCallsBefore).map((entry, index) => {
    const argv = array(entry.argv, `Antigravity argv[${index}]`)
    return argv.map((item, part) => string(item, `Antigravity argv[${index}][${part}]`))
  })
  equal(agyArgv, [
    ['--version'],
    ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s']
  ], 'Antigravity adapter argv')
  const codexLog = parseJsonLines(await ctx.world.readLog('codex'), 'Codex fixture log')
  const rateLimitReads = codexLog.filter(entry => entry.method === 'account/rateLimits/read').length - codexReadsBefore
  const consumeCalls = codexLog.filter(entry => typeof entry.method === 'string' && /consume/i.test(entry.method)).length
  const turnsAfter = codexTurns(await ctx.world.readLog('codex')).length
  equal(turnsAfter, turnsBefore, 'model turns during account usage refresh')
  ensure(rateLimitReads > 0, 'Codex quota was not read through the native local adapter')
  equal(consumeCalls, 0, 'Codex reset-credit consume calls')
  const egress = await ctx.world.readLog('egress')
  equal(egress.trim(), '', 'non-loopback egress attempts')
  const orca = await ctx.world.readLog('orca')
  equal(orca.trim(), '', 'Orca fixture invocations')
  return {
    standIns: true,
    providerAuthenticationExercised: false,
    managedAccounts: managed,
    providers: {
      codex: {
        status: codex.status,
        session: { usedPercent: codexSession.usedPercent, resetsAt: codexSession.resetsAt },
        weekly: { usedPercent: codexWeekly.usedPercent, resetsAt: codexWeekly.resetsAt },
        resetCreditsAvailable: resetCredits.availableCount
      },
      antigravity: {
        status: antigravity.status,
        session: { usedPercent: agySession.usedPercent, resetsAt: agySession.resetsAt },
        weekly: { usedPercent: agyWeekly.usedPercent, resetsAt: agyWeekly.resetsAt }
      },
      claude: {
        status: claude.status, session: claude.session, weekly: claude.weekly,
        refreshedStatus: refreshedClaude.status, refreshedSession: refreshedClaude.session,
        refreshedWeekly: refreshedClaude.weekly
      }
    },
    codexRateLimitReads: rateLimitReads,
    codexConsumeCalls: consumeCalls,
    antigravityArgv: agyArgv,
    egressAttempts: 0,
    orcaInvocations: 0
  }
}

function asRetainedBranch(value: unknown, repoId: string, label: string): RetainedBranch | undefined {
  if (!isObject(value) || value.keptBranch === undefined || value.keptBranch === null) return undefined
  const branch = object(value.keptBranch, `${label}.keptBranch`)
  return { repoId, name: requiredString(branch, 'name', `${label}.keptBranch`), head: requiredString(branch, 'head', `${label}.keptBranch`) }
}

async function closeOwnedSession(ctx: RunContext, session: OwnedSession): Promise<void> {
  await cliJson(ctx, ['session', 'close', session.id, '--yes'])
  session.closed = true
}

async function closeOwnedTab(ctx: RunContext, tab: OwnedTab): Promise<void> {
  await cliJson(ctx, ['terminal', 'tab', 'close', tab.id, '--yes'])
  tab.closed = true
}

function ensureBranchRefRemoved(world: GoalLoopWorld, branch: RetainedBranch): void {
  const ref = `refs/heads/${branch.name}`
  const result = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', ref], {
    cwd: world.repoPath, env: world.env, timeout: 3_000
  })
  if (result.exitCode === 0) throw new GoalLoopFailure('branch-not-removed', `CLI left retained branch ${branch.name}`)
  if (result.exitCode !== 1) throw new GoalLoopFailure('fixture-git', 'read-only Git branch verification failed', result.stderr.toString('utf8'))
}
async function removeWorktree(ctx: RunContext, worktree: OwnedWorktree): Promise<void> {
  const receipt = await cliJson(ctx, ['worktree', 'rm', worktree.id, '--force', '--yes'])
  const retained = asRetainedBranch(receipt, ctx.state.repoId!, `remove ${worktree.name}`)
  if (retained) {
    ctx.state.retainedBranches.push(retained)
    await cliJson(ctx, ['worktree', 'delete-branch', retained.repoId, retained.name, '--head', retained.head, '--yes'])
    ensureBranchRefRemoved(ctx.world, retained)
  }
}

async function worktreesRemove(ctx: RunContext): Promise<Record<string, unknown>> {
  const a = worktreeByName(ctx, 'goal-fixture-a')
  const b = worktreeByName(ctx, 'goal-fixture-b')
  const repoId = ctx.state.repoId
  ensure(repoId, 'Fixture repository was not registered')
  for (const tab of [...ctx.state.tabs]) await closeOwnedTab(ctx, tab)
  let listedA = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', a.id]), 'sessions before A cleanup')
  let listedB = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', b.id]), 'sessions before B cleanup')
  for (const session of ctx.state.sessions) {
    const listed = session.worktreeId === a.id ? listedA : listedB
    if (!listed.has(session.id)) {
      if (session.tabId !== undefined) {
        session.closed = true
        continue
      }
      throw new GoalLoopFailure('missing-session', `${session.worktreeName} session disappeared before cleanup`)
    }
    await closeOwnedSession(ctx, session)
  }
  for (const loopSessionId of ctx.state.loopSessionIds) {
    if (listedB.has(loopSessionId) && !ctx.state.sessions.some(session => session.id === loopSessionId)) {
      await cliJson(ctx, ['session', 'close', loopSessionId, '--yes'])
    }
  }
  listedA = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', a.id]), 'sessions after A cleanup')
  listedB = sessionIds(await cliJson(ctx, ['session', 'list', '--worktree', b.id]), 'sessions after B cleanup')
  equal(listedA.size, 0, 'A sessions after cleanup')
  equal(listedB.size, 0, 'B sessions after cleanup')
  const panesA = terminalPanes(await cliJson(ctx, ['terminal', 'layout', '--worktree', a.id]), 'A terminal layout after cleanup')
  const panesB = terminalPanes(await cliJson(ctx, ['terminal', 'layout', '--worktree', b.id]), 'B terminal layout after cleanup')
  const ownedSessionIds = new Set([...ctx.state.sessions.map(session => session.id), ...ctx.state.loopSessionIds])
  ensure([...panesA, ...panesB].every(pane => !ownedSessionIds.has(pane.sessionId)), 'A fixture session remained in a terminal tab')
  const tabsAbsentFromLayout = ctx.state.tabs.every(tab => !panesA.some(pane => pane.tabId === tab.id) && !panesB.some(pane => pane.tabId === tab.id))
  ensure(tabsAbsentFromLayout, 'Owned shell tab remained in terminal layout')
  await removeWorktree(ctx, a)
  await removeWorktree(ctx, b)
  const remaining = loopArray(await cliJson(ctx, ['worktree', 'list', '--repo', `id:${repoId}`]), 'worktrees after removal')
  const remainingIds = remaining.map((worktree, index) => requiredString(worktree, 'id', `worktrees after removal[${index}]`))
  ensure(!remainingIds.includes(a.id) && !remainingIds.includes(b.id), 'Scoped worktree list still contains a removed fixture worktree')
  ctx.state.productsRemoved = true
  return {
    removedWorktreeIds: [a.id, b.id], remainingWorktreeIds: remainingIds,
    closedSessionIds: [...new Set([...ctx.state.sessions.map(session => session.id), ...ctx.state.loopSessionIds])],
    closedTabIds: ctx.state.tabs.map(tab => tab.id),
    tabsAbsentFromLayout,
    retainedBranches: ctx.state.retainedBranches.map(branch => ({ ...branch, deletedThroughCli: true })),
  }
}

async function defaultStep(id: StepId, ctx: RunContext): Promise<Record<string, unknown>> {
  switch (id) {
    case 'worktrees-create': return createWorktrees(ctx)
    case 'agents-launch': return launchAgents(ctx)
    case 'terminals-roundtrip': return terminalRoundtrip(ctx)
    case 'loop-run-stop': return loops(ctx)
    case 'ask-answer-cancel': return askAnswerCancel(ctx)
    case 'accounts-usage': return accountsUsage(ctx)
    case 'worktrees-remove': return worktreesRemove(ctx)
  }
}

async function cleanupProducts(ctx: RunContext, cleanupSignal: AbortSignal, cleanupDeadline: number): Promise<boolean> {
  if (ctx.state.productsRemoved) return false
  if (!ctx.state.repoId && ctx.state.worktrees.length === 0 && ctx.state.sessions.length === 0 && ctx.state.tabs.length === 0 && ctx.state.loops.length === 0 && ctx.state.loopSessionIds.length === 0) return false
  const daemonPid = ctx.world.daemonPid
  if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0) return false
  try {
    process.kill(daemonPid, 0)
  } catch {
    return false
  }
  const errors: string[] = []
  const attempt = async (args: string[]): Promise<unknown | undefined> => {
    if (cleanupSignal.aborted || Date.now() >= cleanupDeadline) {
      errors.push('product cleanup deadline exceeded')
      return undefined
    }
    try {
      return await cliJson(ctx, args, cleanupSignal, cleanupDeadline)
    } catch (error) {
      const details = errorDetails(error, ctx)
      errors.push(`${args.slice(0, 2).join(' ')}: ${details.message}`)
      return undefined
    }
  }
  for (const loopId of ctx.state.loops) {
    const value = await attempt(['loop', 'show', loopId])
    if (value === undefined) continue
    const state = loopSnapshot(value, 'cleanup loop snapshot').state
    if (state !== 'stopped' && state !== 'completed') await attempt(['loop', 'stop', loopId, '--now'])
  }
  for (const tab of ctx.state.tabs) {
    if (!tab.closed) await attempt(['terminal', 'tab', 'close', tab.id, '--yes'])
  }
  const remainingSessions = new Map<string, Set<string>>()
  for (const session of ctx.state.sessions) {
    if (session.closed || remainingSessions.has(session.worktreeId)) continue
    const listed = await attempt(['session', 'list', '--worktree', session.worktreeId])
    if (listed !== undefined) remainingSessions.set(session.worktreeId, sessionIds(listed, 'cleanup session list'))
  }
  for (const session of ctx.state.sessions) {
    if (!session.closed && remainingSessions.get(session.worktreeId)?.has(session.id)) {
      await attempt(['session', 'close', session.id, '--yes'])
    }
  }
  const repoId = ctx.state.repoId
  if (repoId) {
    const knownIds = new Set(ctx.state.worktrees.map(worktree => worktree.id))
    const listed = await attempt(['worktree', 'list', '--repo', `id:${repoId}`])
    const listedWorktrees = listed === undefined ? [] : loopArray(listed, 'cleanup worktree list')
    for (const worktree of listedWorktrees) {
      if (typeof worktree.id !== 'string' || (!knownIds.has(worktree.id) && worktree.name !== 'goal-fixture-a' && worktree.name !== 'goal-fixture-b')) continue
      const receipt = await attempt(['worktree', 'rm', worktree.id, '--force', '--yes'])
      const retained = receipt === undefined ? undefined : asRetainedBranch(receipt, repoId, 'cleanup worktree remove')
      if (retained) {
        const deleted = await attempt(['worktree', 'delete-branch', repoId, retained.name, '--head', retained.head, '--yes'])
        if (deleted !== undefined) ctx.state.retainedBranches.push(retained)
      }
    }
    const after = await attempt(['worktree', 'list', '--repo', `id:${repoId}`])
    if (after !== undefined) {
      const entries = loopArray(after, 'cleanup worktree readback')
      if (entries.some(entry => typeof entry.id === 'string' && knownIds.has(entry.id))) errors.push('cleanup left a fixture worktree registered')
    }
  }
  if (errors.length > 0) throw new GoalLoopFailure('product-cleanup', errors.join('; '))
  return true
}

function newStepResults(): StepResult[] {
  return STEP_IDS.map(id => ({ id, status: 'not-run', elapsedMs: 0, evidence: {} }))
}

function collectFailure(step: StepResult, error: unknown, ctx?: RunContext): void {
  const details = errorDetails(error, ctx)
  step.status = 'failed'
  step.evidence = details.evidence
  step.error = {
    kind: details.kind,
    message: details.message,
    ...(details.stderrTail === undefined ? {} : { stderrTail: details.stderrTail })
  }
}

export async function runGoalLoop(options: GoalLoopRunOptions = {}): Promise<GoalLoopReport> {
  const startedAt = Date.now()
  const totalMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const deadlineAt = startedAt + Math.max(1, totalMs)
  const productCleanupReserve = Math.min(PRODUCT_CLEANUP_RESERVE_MAX_MS, Math.max(1, Math.floor(totalMs * 0.1)))
  const finalTeardownReserve = Math.min(FINAL_TEARDOWN_RESERVE_MAX_MS, Math.max(1, Math.floor(totalMs * 0.4)))
  const productCleanupDeadline = deadlineAt - finalTeardownReserve
  const workDeadlineAt = productCleanupDeadline - productCleanupReserve
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason ?? new GoalLoopFailure('interrupted', 'Goal loop rehearsal interrupted'))
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()
  const workTimer = setTimeout(() => controller.abort(new GoalLoopFailure('deadline', 'Goal loop work deadline exceeded')), Math.max(0, workDeadlineAt - Date.now()))
  const steps = newStepResults()
  const state: WorkflowState = { worktrees: [], sessions: [], tabs: [], loops: [], loopSessionIds: [], retainedBranches: [], productsRemoved: false }
  let world: GoalLoopWorld | undefined
  let ctx: RunContext | undefined
  let worldStarted = false
  let failedIndex = -1
  let cleanupFailure: string | undefined
  try {
    world = await (options.createWorld ?? createGoalLoopWorld)({ signal: controller.signal, deadline: deadlineAt })
    ctx = {
      world, state, signal: controller.signal, controller, deadlineAt: workDeadlineAt,
      root: world.root, tokens: [], onActiveTurn: options.onActiveTurn
    }
    ctx.tokens = collectTokens(world)
    const startupAt = Date.now()
    try {
      checkAbort(ctx)
      await world.start()
      worldStarted = true
      ctx.tokens = collectTokens(world)
      checkAbort(ctx)
    } catch (error) {
      failedIndex = 0
      steps[0]!.elapsedMs = Math.max(0, Date.now() - startupAt)
      collectFailure(steps[0]!, error, ctx)
    }
    if (failedIndex < 0) {
      for (let index = 0; index < STEP_IDS.length; index += 1) {
        const id = STEP_IDS[index]!
        const step = steps[index]!
        const stepStartedAt = Date.now()
        try {
          checkAbort(ctx)
          await options.beforeStep?.(id, world)
          checkAbort(ctx)
          const evidence = options.executeStep
            ? await options.executeStep(id, world)
            : await defaultStep(id, ctx)
          checkAbort(ctx)
          step.status = 'passed'
          step.evidence = safeValue(evidence, ctx) as Record<string, unknown>
        } catch (error) {
          failedIndex = index
          collectFailure(step, error, ctx)
          break
        } finally {
          step.elapsedMs = Math.max(0, Date.now() - stepStartedAt)
        }
      }
    }
  } catch (error) {
    failedIndex = 0
    steps[0]!.elapsedMs = Math.max(0, Date.now() - startedAt)
    collectFailure(steps[0]!, error, ctx)
    if (isObject(error) && typeof error.cleanupError === 'string') cleanupFailure = diagnostic(error.cleanupError, ctx)
  } finally {
    clearTimeout(workTimer)
    const recordCleanupFailure = (message: string) => {
      cleanupFailure = cleanupFailure ? `${cleanupFailure}; ${message}` : message
    }
    const teardownController = new AbortController()
    const teardownTimer = setTimeout(
      () => teardownController.abort(new GoalLoopFailure('deadline', 'Goal loop final teardown deadline exceeded')),
      Math.max(0, deadlineAt - Date.now())
    )
    if (ctx && worldStarted) {
      const productController = new AbortController()
      const productTimer = setTimeout(
        () => productController.abort(new GoalLoopFailure('deadline', 'Goal loop product cleanup deadline exceeded')),
        Math.max(0, productCleanupDeadline - Date.now())
      )
      let productCleanupRan = false
      try {
        productCleanupRan = await cleanupProducts(ctx, productController.signal, productCleanupDeadline)
      } catch (error) {
        const details = errorDetails(error, ctx)
        recordCleanupFailure(details.message)
      } finally {
        clearTimeout(productTimer)
      }
      if (productCleanupRan && (productController.signal.aborted || Date.now() >= productCleanupDeadline) &&
          !cleanupFailure?.includes('product cleanup deadline exceeded')) {
        recordCleanupFailure('Goal loop product cleanup deadline exceeded')
      }
    }
    if (world) {
      try {
        await world.cleanup({ signal: teardownController.signal, deadline: deadlineAt })
      } catch (error) {
        const details = errorDetails(error, ctx)
        recordCleanupFailure(details.message)
      }
    }
    if (teardownController.signal.aborted || Date.now() >= deadlineAt) {
      if (!cleanupFailure?.includes('final teardown deadline exceeded')) {
        recordCleanupFailure('Goal loop final teardown deadline exceeded')
      }
    }
    clearTimeout(teardownTimer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
  if (failedIndex >= 0) {
    for (let index = failedIndex + 1; index < steps.length; index += 1) {
      steps[index]!.status = 'not-run'
      steps[index]!.elapsedMs = 0
      steps[index]!.evidence = {}
    }
  }
  const cleanup = cleanupFailure === undefined
    ? { ok: true as const }
    : { ok: false as const, error: diagnostic(cleanupFailure, ctx) }
  const ok = steps.every(step => step.status === 'passed') && cleanup.ok
  return {
    schemaVersion: 1,
    scope: 'goal-12-loop',
    ok,
    providerMode: 'local-stand-ins',
    steps,
    cleanup,
    elapsedMs: Math.max(0, Date.now() - startedAt)
  }
}
