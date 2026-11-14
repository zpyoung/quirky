import { createHash } from 'node:crypto'
import type { PluginContext } from '@quirky/protocol'
import type { JournalEntry, PreparedCommitInfo, PreparedCommitKind, SitterAction, SitterPayload, SitterWorld } from './policy'

export const ATTEMPT_TRAILER_KEY = 'Orca-Heimdall-Attempt'
export const MAX_SIGNATURE_LINES = 400

type GateVerdict = { verdict: 'allow' } | { verdict: 'hold'; reason: string; detail?: string }
type GitOutput = { stdoutText: string; stderr: string }
type GitRun = PluginContext['process']['run']
type RecordValue = Record<string, unknown>

const SHA_RE = /^[0-9a-f]{40,64}$/i
const ANSI_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g
const TIMESTAMP_RE = /\b(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)\b/g
const SHA_TEXT_RE = /\b[0-9a-f]{40,64}\b/gi
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value)
}

function failure(reason: string, detail: string): { effect: 'not-landed'; reason: string; detail: string } {
  return { effect: 'not-landed', reason, detail }
}

async function rawGit(run: GitRun, cwd: string, args: string[]) {
  try {
    return await run(['git', ...args], { cwd })
  } catch (error) {
    throw new Error(`git ${args[0] ?? 'command'} could not run: ${messageOf(error)}`)
  }
}

async function gitText(run: GitRun, cwd: string, args: string[]): Promise<GitOutput> {
  const result = await rawGit(run, cwd, args)
  if (result.exitCode !== 0 || result.stopped || result.spawnError || typeof result.stdoutText !== 'string') {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : ''
    throw new Error(`git ${args[0] ?? 'command'} failed${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}${detail ? `: ${detail}` : ''}`)
  }
  return { stdoutText: result.stdoutText, stderr: result.stderr }
}

export function normalizeLogText(raw: string): string {
  return raw.replace(ANSI_RE, '')
    .replace(TIMESTAMP_RE, '')
    .replace(SHA_TEXT_RE, '')
    .replace(UUID_RE, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_SIGNATURE_LINES)
    .join('\n')
}

export function computeFailureSignature(checkKey: string, text: string): string {
  return `sha256:${createHash('sha256').update(`${checkKey}\0${normalizeLogText(text)}`).digest('hex')}`
}

export function extractAttemptTrailer(commitMessage: string): string | null {
  if (commitMessage.split(ATTEMPT_TRAILER_KEY).length - 1 !== 1) return null
  const message = commitMessage.replace(/\r\n/g, '\n').trimEnd()
  const split = message.lastIndexOf('\n\n')
  if (split < 0) return null
  const footer = message.slice(split + 2).split('\n')
  if (footer.some((line) => line.length > 0 && !/^[A-Za-z0-9-]+:[ \t]+\S.*$/.test(line))) return null
  const matches = footer.filter((line) => line.startsWith(`${ATTEMPT_TRAILER_KEY}:`))
  if (matches.length !== 1) return null
  const match = matches[0]!.match(new RegExp(`^${ATTEMPT_TRAILER_KEY}:[ \\t]+(\\S(?:.*\\S)?)[ \\t]*$`))
  return match?.[1] ?? null
}

type DiffFile = { oldPath: string | null; newPath: string | null; deleted: boolean; lines: string[] }
type ParsedPath = { path: string | null; valid: boolean }
const GIT_PATH_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '\\': '\\', '"': '"' }

function validRepoPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').some((part) => part === '.' || part === '..')
}

function decodeGitPath(value: string): ParsedPath {
  if (value === '/dev/null') return { path: null, valid: true }
  if (!value.startsWith('"')) {
    if (value.includes('\t') || value.includes('\r') || value.includes('\n') || !validRepoPath(value)) return { path: null, valid: false }
    return { path: value, valid: true }
  }
  if (value.length < 2 || !value.endsWith('"')) return { path: null, valid: false }
  let decoded = ''
  for (let i = 1; i < value.length - 1; i += 1) {
    const char = value[i]!
    if (char !== '\\') {
      if (char === '"' || char === '\n' || char === '\r') return { path: null, valid: false }
      decoded += char
      continue
    }
    const escaped = value[++i]
    if (escaped === undefined) return { path: null, valid: false }
    if (Object.hasOwn(GIT_PATH_ESCAPES, escaped)) {
      decoded += GIT_PATH_ESCAPES[escaped]!
      continue
    }
    if (!/[0-7]/.test(escaped)) return { path: null, valid: false }
    let octal = escaped
    for (let count = 0; count < 2 && /[0-7]/.test(value[i + 1] ?? ''); count += 1) octal += value[++i]!
    const byte = Number.parseInt(octal, 8)
    if (byte > 255) return { path: null, valid: false }
    decoded += String.fromCharCode(byte)
  }
  if (decoded === '/dev/null') return { path: null, valid: true }
  return { path: validRepoPath(decoded) ? decoded : null, valid: validRepoPath(decoded) }
}

function nextPathToken(input: string, start: number): { token: string; next: number } | null {
  while (input[start] === ' ') start += 1
  if (start >= input.length) return null
  if (input[start] !== '"') {
    let end = start
    while (end < input.length && input[end] !== ' ') end += 1
    return { token: input.slice(start, end), next: end }
  }
  let end = start + 1
  while (end < input.length) {
    if (input[end] === '\\') end += 2
    else if (input[end++] === '"') return { token: input.slice(start, end), next: end }
  }
  return null
}

function diffHeaderPaths(line: string): { oldPath: string | null; newPath: string | null; valid: boolean } {
  const input = line.slice('diff --git '.length)
  const first = nextPathToken(input, 0)
  const second = first ? nextPathToken(input, first.next) : null
  if (!first || !second || input.slice(second.next).trim() !== '') return { oldPath: null, newPath: null, valid: false }
  const old = decodeGitPath(first.token)
  const next = decodeGitPath(second.token)
  if (!old.valid || !next.valid || old.path === null || next.path === null) return { oldPath: null, newPath: null, valid: false }
  return {
    oldPath: old.path.startsWith('a/') ? old.path.slice(2) : old.path,
    newPath: next.path.startsWith('b/') ? next.path.slice(2) : next.path,
    valid: true
  }
}

function patchPath(value: string, prefix: 'a/' | 'b/'): ParsedPath {
  const parsed = decodeGitPath(value)
  if (!parsed.valid || parsed.path === null) return parsed
  return { path: parsed.path.startsWith(prefix) ? parsed.path.slice(2) : parsed.path, valid: true }
}

function diffFiles(diffText: string): { files: DiffFile[]; malformed: boolean } {
  const files: DiffFile[] = []
  let malformed = false
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const paths = diffHeaderPaths(line)
      malformed ||= !paths.valid
      files.push({ oldPath: paths.oldPath, newPath: paths.newPath, deleted: false, lines: [] })
      continue
    }
    const file = files.at(-1)
    if (!file) {
      if (line.trim()) malformed = true
      continue
    }
    file.lines.push(line)
    if (line.startsWith('rename from ')) {
      const parsed = decodeGitPath(line.slice('rename from '.length))
      malformed ||= !parsed.valid || parsed.path === null
      if (parsed.path !== null) file.oldPath = parsed.path
    } else if (line.startsWith('rename to ')) {
      const parsed = decodeGitPath(line.slice('rename to '.length))
      malformed ||= !parsed.valid || parsed.path === null
      if (parsed.path !== null) file.newPath = parsed.path
    } else if (line.startsWith('deleted file mode ')) file.deleted = true
    else if (line.startsWith('--- ')) {
      const path = patchPath(line.slice(4), 'a/')
      malformed ||= !path.valid
      if (path.path !== null) file.oldPath = path.path
    } else if (line.startsWith('+++ ')) {
      const path = patchPath(line.slice(4), 'b/')
      malformed ||= !path.valid
      if (path.path === null) file.deleted = true
      else file.newPath = path.path
    }
  }
  if (diffText.trim() && files.length === 0) malformed = true
  if (files.some((file) => file.oldPath === null || file.newPath === null)) malformed = true
  return { files, malformed }
}

function numstatPaths(numstatText: string): { paths: string[]; malformed: boolean } {
  const paths: string[] = []
  let malformed = false
  for (const line of numstatText.split(/\r?\n/)) {
    if (!line) continue
    const first = line.indexOf('\t')
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1)
    if (first < 0 || second < 0 || !/^(?:\d+|-)$/.test(line.slice(0, first)) || !/^(?:\d+|-)$/.test(line.slice(first + 1, second))) {
      malformed = true
      continue
    }
    const field = line.slice(second + 1)
    if (!field) {
      malformed = true
      continue
    }
    const rename = field.lastIndexOf(' => ')
    for (const value of rename < 0 ? [field] : [field.slice(0, rename), field.slice(rename + 4)]) {
      const parsed = decodeGitPath(value)
      malformed ||= !parsed.valid || parsed.path === null
      if (parsed.path !== null) paths.push(parsed.path)
    }
  }
  return { paths, malformed }
}

function isProtectedPath(path: string): boolean {
  return path === '.gitlab-ci.yml' ||
    ['.github/workflows/', '.github/actions/', '.circleci/', 'buildkite/'].some((prefix) => path.startsWith(prefix)) ||
    /(?:^|\/)[^/]*(?:baseline|ratchet)[^/]*$/i.test(path)
}

function isTestPath(path: string): boolean {
  return /\.(?:test|spec)\.[^/]+$/i.test(path) || /(?:^|\/)(?:__tests__|tests?)\//i.test(path) || /_test\.py$/i.test(path)
}

const ASSERTION_RE = /\b(?:expect\s*\(|assert\.|assert\s*\(|assertEquals\s*\(|assertEqual\s*\()/
const SUPPRESSION_RE = /eslint-disable|@ts-(?:ignore|expect-error|nocheck)|coverageThreshold|maxWarnings|\b(?:test|it|describe)\.(?:skip|only)\b|\b(?:xit|xdescribe)\b|@pytest\.mark\.(?:skip|xfail)\b/i

export function inspectDiffPolicy(diffText: string, numstatText: string): string | null {
  const parsedDiff = diffFiles(diffText)
  const parsedNumstat = numstatPaths(numstatText)
  if (parsedDiff.malformed || parsedNumstat.malformed) return 'diff paths could not be parsed safely'
  const files = parsedDiff.files
  const paths = new Set(parsedNumstat.paths)
  for (const file of files) {
    if (file.oldPath !== null) paths.add(file.oldPath)
    if (file.newPath !== null) paths.add(file.newPath)
  }
  const protectedPath = [...paths].find(isProtectedPath)
  if (protectedPath) return `protected CI or baseline/ratchet path changed: ${protectedPath}`
  for (const file of files) {
    if (file.deleted && [file.oldPath, file.newPath].some((path) => path !== null && isTestPath(path))) {
      return `test file deleted: ${file.oldPath ?? file.newPath}`
    }
    for (const line of file.lines) {
      if (line.startsWith('+') && !line.startsWith('+++ ') && SUPPRESSION_RE.test(line.slice(1))) {
        return 'added test suppression, skip, or focus'
      }
    }
  }
  let removedAssertions = 0
  let addedAssertions = 0
  for (const file of files) {
    if (![file.oldPath, file.newPath].some((path) => path !== null && isTestPath(path))) continue
    for (const line of file.lines) {
      if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
      if (line.startsWith('+') && ASSERTION_RE.test(line.slice(1))) addedAssertions += 1
      else if (line.startsWith('-') && ASSERTION_RE.test(line.slice(1))) removedAssertions += 1
    }
  }
  if (removedAssertions > addedAssertions) return 'test diff removes more assertions than it adds'
  return null
}

async function changedPaths(run: GitRun, cwd: string, parentSha: string, commitSha: string): Promise<string[]> {
  const output = (await gitText(run, cwd, [
    'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--name-only', '-z',
    parentSha, commitSha, '--'
  ])).stdoutText
  if (output === '') return []
  if (!output.endsWith('\0')) throw new Error('git returned malformed NUL-delimited diff paths')
  const paths = output.slice(0, -1).split('\0')
  if (paths.some((path) => !validRepoPath(path))) throw new Error('git returned malformed diff paths')
  return paths
}

async function pathsChangedFromBothParents(run: GitRun, cwd: string, firstParentSha: string, secondParentSha: string, commitSha: string): Promise<string[]> {
  const [firstParentPaths, secondParentPaths] = await Promise.all([
    changedPaths(run, cwd, firstParentSha, commitSha),
    changedPaths(run, cwd, secondParentSha, commitSha)
  ])
  const secondParentPathSet = new Set(secondParentPaths)
  return firstParentPaths.filter((path) => secondParentPathSet.has(path))
}

async function inspectWorktreeState(run: GitRun, worktreePath: string, expectedKind?: PreparedCommitKind) {
  const status = (await gitText(run, worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdoutText
  const localDirty = status.length > 0
  const headResult = await rawGit(run, worktreePath, ['rev-parse', '--verify', 'HEAD'])
  if (headResult.spawnError || headResult.stopped || typeof headResult.stdoutText !== 'string') throw new Error('git could not inspect HEAD')
  if (headResult.exitCode !== 0) {
    if (headResult.exitCode !== 128) throw new Error(`git rev-parse failed (exit ${String(headResult.exitCode)})`)
    const inside = (await gitText(run, worktreePath, ['rev-parse', '--is-inside-work-tree'])).stdoutText.trim()
    const symbolicHead = await rawGit(run, worktreePath, ['symbolic-ref', '-q', 'HEAD'])
    const symbolicRef = typeof symbolicHead.stdoutText === 'string' ? symbolicHead.stdoutText.trim() : ''
    if (inside !== 'true' || symbolicHead.exitCode !== 0 || symbolicHead.spawnError || symbolicHead.stopped || !symbolicRef.startsWith('refs/heads/') || symbolicRef.length <= 'refs/heads/'.length) {
      throw new Error('worktree has no valid HEAD')
    }
    return { localHeadSha: null, localDirty, localPrepared: null }
  }
  const localHeadSha = headResult.stdoutText.trim()
  if (!isSha(localHeadSha)) throw new Error('git returned a malformed HEAD SHA')
  const parentLine = (await gitText(run, worktreePath, ['rev-list', '--parents', '-n', '1', localHeadSha])).stdoutText.trim().split(/\s+/)
  if (parentLine[0] !== localHeadSha || parentLine.some((sha) => !isSha(sha))) throw new Error('git returned malformed commit parent data')
  const parents = parentLine.slice(1)
  const commitMessage = (await gitText(run, worktreePath, ['show', '-s', '--format=%B', localHeadSha])).stdoutText
  let diffText: string
  let numstatText: string
  if (parents.length === 2) {
    const sharedPaths = await pathsChangedFromBothParents(run, worktreePath, parents[0]!, parents[1]!, localHeadSha)
    if (sharedPaths.length === 0) {
      diffText = ''
      numstatText = ''
    } else {
      const pathspecs = sharedPaths.map((path) => `:(literal)${path}`)
      diffText = (await gitText(run, worktreePath, [
        'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', parents[0]!, localHeadSha, '--', ...pathspecs
      ])).stdoutText
      numstatText = ''
    }
  } else {
    const diffArgs = parents.length > 0
      ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', parents[0]!, localHeadSha, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '-p', '-r', localHeadSha]
    const numstatArgs = parents.length > 0
      ? ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--numstat', parents[0]!, localHeadSha, '--']
      : ['diff-tree', '--root', '--no-commit-id', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--numstat', '-r', localHeadSha]
    const [diff, numstat] = await Promise.all([
      gitText(run, worktreePath, diffArgs),
      gitText(run, worktreePath, numstatArgs)
    ])
    diffText = diff.stdoutText
    numstatText = numstat.stdoutText
  }
  let policyViolation = inspectDiffPolicy(diffText, numstatText)
  const validParents = expectedKind === 'fix' ? parents.length === 1 : expectedKind === 'conflict-resolution' ? parents.length === 1 || parents.length === 2 : true
  if (!policyViolation && !validParents) policyViolation = `unexpected parent count for ${expectedKind}`
  return {
    localHeadSha,
    localDirty,
    localPrepared: {
      sha: localHeadSha,
      parentCount: parents.length,
      primaryParentSha: parents[0] ?? null,
      secondaryParentSha: parents[1] ?? null,
      attemptTrailer: extractAttemptTrailer(commitMessage),
      dirty: localDirty,
      policyViolation
    } satisfies PreparedCommitInfo
  }
}

export async function inspectWorktree(
  processRun: PluginContext['process']['run'],
  worktreePath: string,
  expectedKind?: PreparedCommitKind
): Promise<{ localHeadSha: string | null; localDirty: boolean; localPrepared: PreparedCommitInfo | null }> {
  return inspectWorktreeState(processRun, worktreePath, expectedKind)
}


function attemptMatches(entry: JournalEntry, fingerprint: string, expectedHeadSha: string): boolean {
  if (entry.kind !== 'attempt' || entry.fingerprint !== fingerprint || entry.state !== 'settled' || entry.effect !== 'landed') return false
  const action = entry.action
  return isRecord(action) && typeof action.kind === 'string' && action.kind.startsWith('prepare-') && action.expectedHeadSha === expectedHeadSha
}

function hold(reason: string, detail: string): GateVerdict {
  return { verdict: 'hold', reason, detail }
}

export async function preflightContention(
  call: PluginContext['call'],
  processRun: PluginContext['process']['run'],
  params: {
    action: SitterAction
    snapshot: { world: SitterWorld }
    journal: readonly JournalEntry[]
    enrollment: { worktreeId: string | null; kindPayload: SitterPayload }
  }
): Promise<GateVerdict> {
  const kind = params.action.kind
  if (kind !== 'prepare-fix' && kind !== 'prepare-conflict-resolution' &&
    kind !== 'publish-fix' && kind !== 'publish-conflict-resolution') return { verdict: 'allow' }
  const worktreeId = params.enrollment.worktreeId
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) return hold('worktree-unavailable', 'the enrolled worktree id is missing')
  try {
    const [terminalResult, agentResult, worktreeResult] = await Promise.all([
      call('quirky.terminal/sessions', {}),
      call('quirky.agent-status/list', { worktree: worktreeId }),
      call('quirky.worktree/resolve', { selector: `id:${worktreeId}` })
    ])
    if (!isRecord(terminalResult) || !Array.isArray(terminalResult.sessions)) return hold('worktree-busy', 'terminal sessions returned a malformed response')
    for (const session of terminalResult.sessions) {
      if (!isRecord(session) || (session.worktreeId !== null && typeof session.worktreeId !== 'string') || typeof session.state !== 'string' || typeof session.alive !== 'boolean') {
        return hold('worktree-busy', 'terminal sessions returned a malformed session')
      }
      if (session.worktreeId === worktreeId && session.alive !== false && session.state !== 'exited') {
        return hold('worktree-busy', `live terminal session ${String(session.sessionId ?? 'unknown')} occupies the worktree`)
      }
    }
    if (!Array.isArray(agentResult)) return hold('worktree-busy', 'agent status returned a malformed response')
    for (const row of agentResult) {
      if (!isRecord(row) || typeof row.sessionId !== 'string' || typeof row.state !== 'string') {
        return hold('worktree-busy', 'agent status returned a malformed row')
      }
      if (row.state !== 'done') return hold('worktree-busy', `foreground agent ${String(row.sessionId ?? 'unknown')} is ${row.state}`)
    }
    if (!isRecord(worktreeResult) || worktreeResult.id !== worktreeId || typeof worktreeResult.path !== 'string' || worktreeResult.path.length === 0) {
      return hold('worktree-unavailable', 'worktree resolution returned a malformed response')
    }
    const expectedKind: PreparedCommitKind | undefined = kind.endsWith('fix') ? 'fix' : kind.endsWith('conflict-resolution') ? 'conflict-resolution' : undefined
    const state = await inspectWorktreeState(processRun, worktreeResult.path, expectedKind)
    if (state.localDirty) return hold('worktree-busy', 'uncommitted-changes: the worktree has tracked or untracked changes')
    if (kind.startsWith('prepare-')) {
      const rawExpected = (params.action as SitterAction & { expectedHeadSha?: unknown }).expectedHeadSha
      const expected = typeof rawExpected === 'string' ? rawExpected : ''
      if (!isSha(expected) || state.localHeadSha !== expected) {
        const trailer = state.localPrepared?.attemptTrailer
        if (trailer && !params.journal.some((entry) => attemptMatches(entry, trailer, expected))) {
          return hold('abandoned-prepared-commit', `HEAD ${state.localHeadSha ?? '(none)'} carries an unmatched ${ATTEMPT_TRAILER_KEY} trailer`)
        }
        return hold('local-head-moved', `worktree HEAD ${state.localHeadSha ?? '(none)'} does not equal expected remote ${rawExpected === undefined ? '(missing)' : String(rawExpected)}`)
      }
    }
    return { verdict: 'allow' }
  } catch (error) {
    return hold('worktree-unavailable', `preflight inspection failed closed: ${messageOf(error)}`)
  }
}

function reasonOf(error: unknown): string | null {
  if (!isRecord(error)) return null
  const data = isRecord(error.data) ? error.data : error
  return typeof data.reason === 'string' ? data.reason : null
}

function validCommitShape(info: PreparedCommitInfo, expectedKind: PreparedCommitKind, expectedHeadSha: string, fingerprint: string, expectedBaseSha?: string): string | null {
  if (!isSha(expectedHeadSha) || !isSha(info.sha)) return 'expected or prepared commit SHA is malformed'
  if (info.dirty) return 'the worktree has tracked or untracked changes'
  if (info.parentCount !== 1 && !(expectedKind === 'conflict-resolution' && info.parentCount === 2)) return `prepared commit has an invalid parent count: ${info.parentCount}`
  if (info.primaryParentSha !== expectedHeadSha) return `prepared commit first parent is ${info.primaryParentSha ?? '(none)'}, expected ${expectedHeadSha}`
  if (info.parentCount === 2) {
    if (!isSha(expectedBaseSha)) return 'expected base SHA is missing or malformed'
    if (!isSha(info.secondaryParentSha)) return 'prepared commit second parent SHA is malformed'
    if (info.secondaryParentSha !== expectedBaseSha) return `prepared commit second parent is ${info.secondaryParentSha}, expected ${expectedBaseSha}`
  }
  if (info.attemptTrailer !== fingerprint) return `prepared commit attempt trailer does not match ${fingerprint}`
  if (info.policyViolation) return info.policyViolation
  return null
}

async function verifyPrepared(
  processRun: GitRun,
  worktreePath: string,
  params: { expectedHeadSha: string; preparedCommitSha: string; expectedPrepareFingerprint: string; expectedKind: PreparedCommitKind; expectedBaseSha?: string }
): Promise<string | null> {
  const state = await inspectWorktreeState(processRun, worktreePath, params.expectedKind)
  if (state.localHeadSha !== params.preparedCommitSha) return `local HEAD is ${state.localHeadSha ?? '(none)'}, not prepared commit ${params.preparedCommitSha}`
  if (!state.localPrepared) return 'prepared commit could not be inspected'
  return validCommitShape(state.localPrepared, params.expectedKind, params.expectedHeadSha, params.expectedPrepareFingerprint, params.expectedBaseSha)
}

export async function publishPreparedBranch(
  call: PluginContext['call'],
  processRun: PluginContext['process']['run'],
  params: {
    worktreePath: string
    worktreeId: string
    expectedHeadSha: string
    preparedCommitSha: string
    expectedPrepareFingerprint: string
    expectedKind: PreparedCommitKind
    expectedBaseSha?: string
  }
): Promise<
  | { effect: 'landed'; detail?: string }
  | { effect: 'not-landed'; reason: string; detail: string }
  | { effect: 'indeterminate'; reason: string; detail: string }
> {
  const validateLocal = async () => {
    try {
      return await verifyPrepared(processRun, params.worktreePath, params)
    } catch (error) {
      return `local Git inspection failed: ${messageOf(error)}`
    }
  }
  const initialProblem = await validateLocal()
  if (initialProblem) return failure('prepared-commit-refused', initialProblem)
  let target: unknown
  try {
    target = await call('quirky.git/pushTarget', { worktree: `id:${params.worktreeId}`, purpose: 'review' })
  } catch (error) {
    if (reasonOf(error) === 'stale-target') return failure('head-moved', messageOf(error))
    return failure('push-target-unavailable', `push target lookup failed: ${messageOf(error)}`)
  }
  if (!isRecord(target) || target.ready !== true || !isSha(target.headOid)) {
    return failure('push-target-unavailable', 'push target returned a malformed or unavailable review target')
  }
  if (target.headOid !== params.expectedHeadSha) return failure('head-moved', `remote review head is ${target.headOid}, expected ${params.expectedHeadSha}`)
  const afterLookupProblem = await validateLocal()
  if (afterLookupProblem) return failure('prepared-commit-refused', `local state changed during target lookup: ${afterLookupProblem}`)
  let pushed: unknown
  try {
    pushed = await call('quirky.git/forcePush', {
      worktree: `id:${params.worktreeId}`,
      purpose: 'review',
      expected: params.expectedHeadSha,
      expectedLocalHead: params.preparedCommitSha,
      yes: true
    })
  } catch (error) {
    if (reasonOf(error) === 'stale-lease' || reasonOf(error) === 'stale-target') return failure('head-moved', messageOf(error))
    return { effect: 'indeterminate', reason: 'push-uncertain', detail: `force-push completion is unknown: ${messageOf(error)}` }
  }
  if (isRecord(pushed) && pushed.pushed === true) return { effect: 'landed' }
  if (isRecord(pushed) && typeof pushed.remote === 'string' && typeof pushed.branch === 'string' && typeof pushed.upstream === 'string') {
    return { effect: 'landed' }
  }
  return { effect: 'indeterminate', reason: 'push-uncertain', detail: 'force-push returned an unrecognized result; remote completion cannot be verified' }
}
