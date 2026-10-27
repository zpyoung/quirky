import { readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

const AMBIGUITY_WINDOW_MS = 300_000
const SAFE_ID = /^[A-Za-z0-9._-]+$/

export type ProbeVerdict = 'usable' | 'unverifiable' | 'unreachable' | 'none'
export type ProbeCandidate = 'reported' | 'session-id' | 'history' | 'project-scan'
export type ProbeReason = 'path-outside-known-roots' | 'undiscoverable-path' | 'stat-failed' | 'ambiguous'

export type ProbeInput = {
  agent: string
  sessionId: string | null
  providerSessionId: string | null
  reportedPath: string | null
  cwd: string
  history: string[]
  claimed: Set<string>
  env: { HOME: string; CLAUDE_CONFIG_DIR?: string; CODEX_HOME?: string }
}

export type ProbeResult = {
  verdict: ProbeVerdict
  path: string | null
  reason: ProbeReason | null
  candidate: ProbeCandidate | null
}

type Outcome =
  | { kind: 'usable'; path: string }
  | { kind: 'refused'; reason: ProbeReason }
  | { kind: 'missing' }

const codeOf = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code
const isAbsent = (error: unknown) => codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR'

function rootOf(agent: string, env: ProbeInput['env']): string | null {
  if (agent === 'claude') return join(env.CLAUDE_CONFIG_DIR || join(env.HOME, '.claude'), 'projects')
  if (agent === 'codex') return join(env.CODEX_HOME || join(env.HOME, '.codex'), 'sessions')
  return null
}

async function entriesOf(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (isAbsent(error)) return []
    throw error
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (isAbsent(error)) return null
    throw error
  }
}

async function check(path: string, root: string | null): Promise<Outcome> {
  if (root === null) return { kind: 'refused', reason: 'undiscoverable-path' }
  if (!path.endsWith('.jsonl')) return { kind: 'refused', reason: 'path-outside-known-roots' }
  let real: string | null
  let realRoot: string | null
  try {
    real = await realpathOrNull(resolve(path))
    realRoot = await realpathOrNull(root)
  } catch {
    return { kind: 'refused', reason: 'stat-failed' }
  }
  if (real === null) return { kind: 'missing' }
  if (realRoot === null || !real.startsWith(realRoot + sep) || !real.endsWith('.jsonl')) {
    return { kind: 'refused', reason: 'path-outside-known-roots' }
  }
  try {
    const info = await stat(real)
    return info.isFile() ? { kind: 'usable', path: real } : { kind: 'refused', reason: 'stat-failed' }
  } catch (error) {
    return isAbsent(error) ? { kind: 'missing' } : { kind: 'refused', reason: 'stat-failed' }
  }
}

async function newest(paths: string[]): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null
  for (const path of paths) {
    const { mtimeMs } = await stat(path)
    if (!best || mtimeMs > best.mtime) best = { path, mtime: mtimeMs }
  }
  return best?.path ?? null
}

async function findBySessionId(agent: string, root: string, id: string): Promise<string | null> {
  if (!SAFE_ID.test(id)) return null
  if (agent === 'claude') {
    const hits: string[] = []
    for (const folder of await entriesOf(root)) {
      if (!folder.isDirectory()) continue
      const file = join(root, folder.name, `${id}.jsonl`)
      if ((await realpathOrNull(file)) !== null) hits.push(file)
    }
    return newest(hits)
  }
  const hits: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await entriesOf(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) hits.push(full)
    }
  }
  await walk(root)
  return newest(hits)
}

type Scan = { path: string } | { ambiguous: true } | null

async function scanProject(root: string, cwd: string, claimed: Set<string>): Promise<Scan> {
  const taken = new Set<string>()
  for (const path of claimed) {
    taken.add(path)
    taken.add((await realpathOrNull(path)) ?? path)
  }
  const dir = join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'))
  const files: { path: string; mtime: number }[] = []
  for (const entry of await entriesOf(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const path = join(dir, entry.name)
    if (taken.has(path) || taken.has((await realpathOrNull(path)) ?? path)) continue
    files.push({ path, mtime: (await stat(path)).mtimeMs })
  }
  files.sort((a, b) => b.mtime - a.mtime)
  if (files.length === 0) return null
  if (files.length > 1 && files[0].mtime - files[1].mtime <= AMBIGUITY_WINDOW_MS) return { ambiguous: true }
  return { path: files[0].path }
}

/**
 * Decides whether the source's transcript can be read on this machine, and where. Candidates are
 * tried best first (reported path, provider session id, earlier paths, Claude project scan); the
 * first usable one wins, otherwise the first refusal, otherwise unreachable when a path was named.
 * Never rejects: any failure is an unverifiable verdict.
 */
export async function probeTranscript(input: ProbeInput): Promise<ProbeResult> {
  try {
    return await probe(input)
  } catch {
    return { verdict: 'unverifiable', path: null, reason: 'stat-failed', candidate: null }
  }
}

async function probe(input: ProbeInput): Promise<ProbeResult> {
  const root = rootOf(input.agent, input.env)
  let refusal: ProbeResult | null = null
  let missing: ProbeResult | null = null
  let ambiguous = false
  const seen = new Set<string>()

  const attempt = async (path: string, candidate: ProbeCandidate): Promise<ProbeResult | null> => {
    if (seen.has(path)) return null
    seen.add(path)
    const outcome = await check(path, root)
    if (outcome.kind === 'usable') return { verdict: 'usable', path: outcome.path, reason: null, candidate }
    if (outcome.kind === 'refused') refusal ??= { verdict: 'unverifiable', path, reason: outcome.reason, candidate }
    else missing ??= { verdict: 'unreachable', path, reason: null, candidate }
    return null
  }

  if (input.reportedPath) {
    const found = await attempt(input.reportedPath, 'reported')
    if (found) return found
  }
  if (root !== null && input.providerSessionId) {
    try {
      const path = await findBySessionId(input.agent, root, input.providerSessionId)
      const found = path && (await attempt(path, 'session-id'))
      if (found) return found
    } catch {
      refusal ??= { verdict: 'unverifiable', path: null, reason: 'stat-failed', candidate: 'session-id' }
    }
  }
  for (const path of input.history) {
    const found = await attempt(path, 'history')
    if (found) return found
  }
  if (root !== null && input.agent === 'claude') {
    try {
      const scan = await scanProject(root, input.cwd, input.claimed)
      if (scan && 'path' in scan) {
        const found = await attempt(scan.path, 'project-scan')
        if (found) return found
      } else if (scan) ambiguous = true
    } catch {
      refusal ??= { verdict: 'unverifiable', path: null, reason: 'stat-failed', candidate: 'project-scan' }
    }
  }

  if (refusal) return refusal
  if (missing) return missing
  if (ambiguous) return { verdict: 'none', path: null, reason: 'ambiguous', candidate: 'project-scan' }
  return { verdict: 'none', path: null, reason: null, candidate: null }
}
