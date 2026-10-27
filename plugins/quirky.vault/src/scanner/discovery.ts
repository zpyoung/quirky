import { readdir, lstat, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { HISTORY_AGENTS } from '../agents'
import type { Discovery, ScanIssue, SourceCandidate, SourceRoot } from '../types'
import { numberOrDate, readJsonObject, readJsonl, string } from './parsers/shared'
import {
  geminiChatProject,
  readGeminiProjectRegistry,
  readGeminiProjectRoot,
  readGeminiTranscriptMetadata,
  resolveGeminiCwd,
  type GeminiRegistryProject
} from './gemini-metadata'

const OMP_ARTIFACT_DIR = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const OPENCODE_DB_NAME = /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/i
const supportedAgents = new Set<string>(HISTORY_AGENTS)

type Layout = 'tree' | 'cline' | 'kiro' | 'kimi' | 'antigravity' | 'openclaw' | 'sqlite-dir' | 'sqlite-file' | 'metadata-only'
type RootSpec = { agent: string; path: string; layout: Layout; label?: string }

type DiscoveryOptions = { sourceHome: string; env: Record<string, string | undefined> }
type GeminiMetadataContext = {
  sourceRoot: string
  registryPath: string
  registry: GeminiRegistryProject[]
  registryObservation: string
  markers: Map<string, Promise<{ cwd: string | null; observation: string }>>
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function confinedEnvPath(name: string, fallback: string, home: string, env: Record<string, string | undefined>): string {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const expanded = raw === '~' ? home : raw.replace(/^~(?=[/\\])/, `${home}${sep}`)
  const candidate = resolve(expanded)
  if (resolve(home) !== resolve(homedir()) && !within(home, candidate)) return fallback
  return candidate
}

function sessionRoot(raw: string, family: '.pi' | '.omp', home: string): string {
  const value = resolve(raw.replace(/^~(?=[/\\])/, `${home}${sep}`))
  const leaf = basename(value)
  if (leaf === 'sessions') return value
  if (leaf === 'agent') return join(value, 'sessions')
  if (leaf === family) return join(value, 'agent', 'sessions')
  return value
}

function rootsFor(options: DiscoveryOptions): RootSpec[] {
  const home = resolve(options.env.QUIRKY_VAULT_SOURCE_HOME || options.sourceHome || homedir())
  const env = options.env
  const root = (name: string, fallback: string) => confinedEnvPath(name, fallback, home, env)
  const xdg = root('XDG_DATA_HOME', join(home, '.local', 'share'))
  const claudeDefault = join(home, '.claude')
  const claudeConfig = root('CLAUDE_CONFIG_DIR', claudeDefault)
  const codexHome = root('CODEX_HOME', join(home, '.codex'))
  const piRoot = sessionRoot(root('PI_CODING_AGENT_DIR', join(home, '.pi', 'agent', 'sessions')), '.pi', home)
  const ompConfig = root('PI_CONFIG_DIR', join(home, '.omp'))
  const ompProfile = env.OMP_PROFILE?.trim() || env.PI_PROFILE?.trim()
  const ompProfileValid = ompProfile && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(ompProfile) ? ompProfile : null
  const ompDefaultAgent = join(ompConfig, ...(ompProfileValid ? ['profiles', ompProfileValid] : []), 'agent')
  const ompRootValue = root('OMP_CODING_AGENT_DIR', ompDefaultAgent)
  let ompRoot = sessionRoot(ompRootValue, '.omp', home)
  if (env.XDG_DATA_HOME && !env.OMP_CODING_AGENT_DIR && !env.OMP_PROFILE && !env.PI_PROFILE) {
    const xdgOmp = join(xdg, 'omp', 'sessions')
    if (existsSync(xdgOmp)) ompRoot = xdgOmp
  }
  const primeSession = env.PRIME_AGENT_SESSION_DIR?.trim() || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim()
  const primeAgent = root('PRIME_AGENT_CODING_AGENT_DIR', join(home, '.prime', 'agent'))
  const primeSessionPath = primeSession ? resolve(primeSession.replace(/^~(?=[/\\])/, `${home}${sep}`)) : ''
  const primeRoot = primeSessionPath && (resolve(home) === resolve(homedir()) || within(home, primeSessionPath))
    ? primeSessionPath
    : join(primeAgent, 'sessions')
  const openclawState = root('OPENCLAW_STATE_DIR', join(home, '.openclaw'))
  const openclawLegacy = join(home, '.clawdbot')
  const devinHome = root('DEVIN_HOME', join(xdg, 'devin', 'cli'))
  const devinTranscriptRoot = join(devinHome, 'transcripts')
  const kimiHome = root('KIMI_CODE_HOME', join(home, '.kimi-code'))
  const openCodeData = root('OPENCODE_DATA_DIR', join(xdg, 'opencode'))
  const openCodeDbOverride = env.OPENCODE_DB?.trim()
  let dbOverride: string | null = null
  if (openCodeDbOverride && openCodeDbOverride !== ':memory:') {
    const candidate = isAbsolute(openCodeDbOverride) ? resolve(openCodeDbOverride) : resolve(openCodeData, openCodeDbOverride)
    if (resolve(home) === resolve(homedir()) || within(home, candidate)) dbOverride = candidate
  }
  const openCodeDatabasesPath = dbOverride ? dirname(dbOverride) : openCodeData
  const specs: RootSpec[] = [
    { agent: 'claude', path: join(claudeConfig, 'projects'), layout: 'tree' },
    { agent: 'claude', path: join(claudeDefault, 'projects'), layout: 'tree' },
    { agent: 'qoder', path: join(home, '.qoder', 'projects'), layout: 'tree' },
    { agent: 'codebuddy', path: join(home, '.codebuddy', 'projects'), layout: 'tree' },
    { agent: 'codex', path: join(codexHome, 'sessions'), layout: 'tree', label: codexHome },
    { agent: 'gemini', path: join(home, '.gemini', 'tmp'), layout: 'tree' },
    { agent: 'copilot', path: join(root('COPILOT_HOME', join(home, '.copilot')), 'session-state'), layout: 'tree' },
    { agent: 'cursor', path: join(root('CURSOR_HOME', join(home, '.cursor')), 'projects'), layout: 'tree' },
    { agent: 'cursor', path: join(root('CURSOR_HOME', join(home, '.cursor')), 'chats'), layout: 'metadata-only' },
    { agent: 'grok', path: root('GROK_SESSIONS_DIR', join(home, '.grok', 'sessions')), layout: 'tree' },
    { agent: 'devin', path: devinTranscriptRoot, layout: 'tree' },
    { agent: 'devin', path: join(devinHome, 'agent_logs'), layout: 'tree' },
    { agent: 'hermes', path: join(home, '.hermes', 'sessions'), layout: 'tree' },
    { agent: 'jcode', path: join(root('JCODE_HOME', join(home, '.jcode')), 'sessions'), layout: 'tree' },
    { agent: 'kiro', path: join(root('KIRO_HOME', join(home, '.kiro')), 'sessions', 'cli'), layout: 'kiro' },
    { agent: 'rovo', path: join(home, '.rovodev', 'sessions'), layout: 'tree' },
    { agent: 'pi', path: piRoot, layout: 'tree' },
    { agent: 'omp', path: ompRoot, layout: 'tree' },
    { agent: 'prime-agent', path: primeRoot, layout: 'tree' },
    { agent: 'openclaw', path: join(basename(openclawState) === 'agents' ? openclawState : join(openclawState, 'agents')), layout: 'openclaw' },
    { agent: 'openclaw', path: join(openclawLegacy, 'agents'), layout: 'openclaw' },
    { agent: 'droid', path: join(home, '.factory', 'sessions'), layout: 'tree' },
    { agent: 'droid', path: join(home, '.factory', 'projects'), layout: 'tree' },
    { agent: 'cline', path: root('CLINE_SESSION_DATA_DIR', join(home, '.cline', 'data', 'sessions')), layout: 'cline' },
    { agent: 'kimi', path: join(kimiHome, 'sessions'), layout: 'kimi' },
    { agent: 'muse', path: root('MUSE_SESSIONS_DIR', join(xdg, 'muse', 'sessions')), layout: 'tree' },
    { agent: 'antigravity', path: join(home, '.gemini', 'antigravity-cli', 'brain'), layout: 'antigravity' },
    { agent: 'opencode', path: join(openCodeData, 'storage', 'session'), layout: 'tree' },
    { agent: 'opencode', path: openCodeDatabasesPath, layout: 'sqlite-dir' },
    { agent: 'opencode2', path: openCodeDatabasesPath, layout: 'sqlite-dir' },
    { agent: 'zcode', path: join(home, '.zcode', 'cli', 'db', 'db.sqlite'), layout: 'sqlite-file' }
  ]
  const seen = new Set<string>()
  return specs.filter((spec) => {
    const key = `${spec.agent}\0${resolve(spec.path)}\0${spec.layout}`
    if (seen.has(key)) return false
    seen.add(key)
    return supportedAgents.has(spec.agent)
  }).map((spec) => ({ ...spec, path: resolve(spec.path) }))
}

function insideRealRoot(realRoot: string, path: string): boolean {
  return within(realRoot, path)
}

async function observe(path: string): Promise<{ signature: string; mtimeMs: number; size: number; regular: boolean }> {
  const info = await lstat(path, { bigint: true })
  return {
    signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    mtimeMs: Number(info.mtimeNs) / 1e6,
    size: Number(info.size),
    regular: info.isFile() && !info.isSymbolicLink()
  }
}

async function metadataObservation(path: string): Promise<string> {
  try {
    const observed = await observe(path)
    return `${path}=${observed.regular ? observed.signature : 'not-file'}`
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    return `${path}=${code || 'unknown'}`
  }
}

async function createGeminiMetadataContext(sourceRoot: string): Promise<GeminiMetadataContext> {
  const registryPath = join(dirname(sourceRoot), 'projects.json')
  const [registry, registryObservation] = await Promise.all([
    readGeminiProjectRegistry(registryPath),
    metadataObservation(registryPath)
  ])
  return { sourceRoot, registryPath, registry, registryObservation, markers: new Map() }
}

async function geminiCandidateMetadata(
  context: GeminiMetadataContext,
  path: string,
  signal?: AbortSignal
): Promise<{ cwd: string | null; observations: string[] } | null> {
  const project = geminiChatProject(context.sourceRoot, path)
  if (!project) return null
  let marker = context.markers.get(project.slug)
  if (!marker) {
    marker = Promise.all([
      readGeminiProjectRoot(project.markerPath),
      metadataObservation(project.markerPath)
    ]).then(([cwd, observation]) => ({ cwd, observation }))
    context.markers.set(project.slug, marker)
  }
  const [transcript, markerMetadata] = await Promise.all([
    readGeminiTranscriptMetadata(path, signal),
    marker
  ])
  return {
    cwd: resolveGeminiCwd(transcript.cwd, markerMetadata.cwd, project.slug, transcript.projectHash, context.registry),
    observations: [markerMetadata.observation, `${context.registryPath}=${context.registryObservation}`]
  }
}

async function cursorMetaIndex(chatsRoot: string): Promise<Map<string, string>> {
  const index = new Map<string, string>()
  let rootReal: string
  try {
    rootReal = await realpath(chatsRoot)
  } catch {
    return index
  }
  const pending = [chatsRoot]
  while (pending.length) {
    const directory = pending.pop()!
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name === 'meta.json') {
        const id = basename(dirname(path))
        const real = await realpath(path).catch(() => '')
        if (id && real && insideRealRoot(rootReal, real)) index.set(id, path)
      }
    }
  }
  return index
}

function sidecarsFor(agent: string, path: string, root: RootSpec, extra: Record<string, unknown>, codexHome: string | null): string[] {
  switch (agent) {
    case 'codex': {
      const indexPath = codexHome ? join(codexHome, 'session_index.jsonl') : ''
      if (indexPath) extra.codexIndexPath = indexPath
      return indexPath ? [indexPath] : []
    }
    case 'cursor': return typeof extra.cursorMetaPath === 'string' ? [extra.cursorMetaPath] : []
    case 'antigravity': {
      const history = join(dirname(root.path), 'history.jsonl')
      extra.antigravityHistoryPath = history
      return [history]
    }
    case 'grok': {
      const history = join(dirname(path), 'chat_history.jsonl')
      extra.grokHistoryPath = history
      return [history]
    }
    case 'devin': {
      const dbPath = join(dirname(root.path), 'sessions.db')
      extra.devinSessionsDbPath = dbPath
      return [dbPath]
    }
    case 'cline': {
      const messages = `${path.slice(0, -'.json'.length)}.messages.json`
      extra.clineMessagesPath = messages
      return [messages]
    }
    case 'kiro': {
      const transcript = `${path.slice(0, -'.json'.length)}.jsonl`
      extra.kiroTranscriptPath = transcript
      return [transcript]
    }
    case 'kimi': {
      const sessionDir = dirname(path)
      const wire = typeof extra.kimiWirePath === 'string' ? extra.kimiWirePath : join(sessionDir, 'agents', 'main', 'wire.jsonl')
      const index = typeof extra.kimiSessionIndexPath === 'string' ? extra.kimiSessionIndexPath : join(dirname(dirname(dirname(path))), 'session_index.jsonl')
      extra.kimiWirePath = wire
      extra.kimiSessionIndexPath = index
      return [wire, index]
    }
    case 'rovo': {
      const context = join(dirname(path), 'session_context.json')
      extra.rovoContextPath = context
      return [context]
    }
    default: return []
  }
}

async function candidateForFile(spec: RootSpec, path: string, rootReal: string, cursorIndex: Map<string, string>, codexIndexes: Map<string, Promise<Map<string, string>>>, issues: ScanIssue[], rootForAgent: readonly RootSpec[], geminiMetadata: GeminiMetadataContext | null, signal?: AbortSignal): Promise<SourceCandidate | null> {
  let observed: Awaited<ReturnType<typeof observe>>
  try {
    observed = await observe(path)
  } catch (error) {
    issues.push({ agent: spec.agent, filePath: path, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
    return null
  }
  if (!observed.regular) return null
  const real = await realpath(path).catch(() => '')
  if (!real || !insideRealRoot(rootReal, real)) return null
  const extra: Record<string, unknown> = {}
  const metadataObservations: string[] = []
  if (spec.agent === 'gemini' && geminiMetadata) {
    const geminiMetadataForFile = await geminiCandidateMetadata(geminiMetadata, path, signal)
    if (geminiMetadataForFile) {
      if (geminiMetadataForFile.cwd) extra.cwd = geminiMetadataForFile.cwd
      metadataObservations.push(...geminiMetadataForFile.observations)
    }
  }
  let codexHome: string | null = null
  let sessionId = basename(path).replace(extname(path), '')
  if (spec.agent === 'codex') {
    sessionId = sessionId.replace(/^rollout-/, '')
    codexHome = spec.label ?? dirname(dirname(dirname(path)))
    extra.codexHome = codexHome
    let pending = codexIndexes.get(codexHome)
    if (!pending) {
      pending = codexTitleIndex(codexHome, signal)
      codexIndexes.set(codexHome, pending)
    }
    const indexed = (await pending).get(sessionId)
    if (indexed) extra.title = indexed
  } else if (spec.agent === 'cursor') {
    extra.cursorMetaPath = cursorIndex.get(sessionId)
  } else if (spec.agent === 'antigravity') {
    sessionId = path.split(sep).at(-4) ?? sessionId
  } else if (spec.agent === 'kimi') {
    sessionId = basename(dirname(path))
    const state = await readJsonObject(path)
    const agentTable = state?.agents
    if (agentTable && typeof agentTable === 'object' && !Array.isArray(agentTable)) {
      const main = Object.entries(agentTable as Record<string, unknown>).find(([, value]) => value && typeof value === 'object' && (value as Record<string, unknown>).type === 'main')?.[0]
      if (main) extra.kimiWirePath = join(dirname(path), 'agents', main, 'wire.jsonl')
    }
    const sessionRootPath = rootForAgent.find((item) => item.agent === 'kimi')?.path ?? dirname(path)
    extra.kimiSessionIndexPath = join(sessionRootPath, 'session_index.jsonl')
  } else if (spec.agent === 'cline') {
    const stem = basename(path, '.json')
    sessionId = stem.endsWith('.session') ? stem.slice(0, -8) : stem
  } else if (spec.agent === 'rovo') {
    sessionId = basename(dirname(path))
  } else if (spec.agent === 'grok') {
    sessionId = basename(dirname(path))
  } else if (spec.agent === 'muse') {
    sessionId = basename(dirname(path))
  }
  const sidecars = sidecarsFor(spec.agent, path, spec, extra, codexHome)
  const sidecarSignatures: string[] = []
  for (const sidecar of sidecars) {
    try {
      const side = await observe(sidecar)
      sidecarSignatures.push(`${sidecar}=${side.regular ? side.signature : 'not-file'}`)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
      sidecarSignatures.push(`${sidecar}=${code || 'unknown'}`)
      if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
        issues.push({ agent: spec.agent, filePath: sidecar, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
      }
    }
  }
  const signature = metadataObservations.length
    ? `${observed.signature}|${sidecarSignatures.join('|')}|${metadataObservations.join('|')}`
    : `${observed.signature}|${sidecarSignatures.join('|')}`
  return {
    agent: spec.agent,
    filePath: path,
    root: spec.path,
    signature,
    mtimeMs: observed.mtimeMs,
    size: observed.size,
    codexHome,
    sessionId,
    sidecars,
    metadata: extra
  }
}

async function codexTitleIndex(codexHome: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const path = join(codexHome, 'session_index.jsonl')
  const titles = new Map<string, string>()
  try {
    for await (const record of readJsonl(path, signal)) {
      const id = string(record.id)
      const title = string(record.thread_name)
      if (id && title) titles.set(id, title)
    }
  } catch {
    // The session index is created opportunistically; transcripts remain browseable without it.
  }
  return titles
}

function supportedFile(spec: RootSpec, path: string, depth: number): boolean {
  const name = basename(path)
  const extension = extname(path).toLowerCase()
  switch (spec.agent) {
    case 'claude': case 'qoder': case 'codebuddy': return extension === '.jsonl'
    case 'codex': return extension === '.jsonl'
    case 'gemini': return extension === '.json' || extension === '.jsonl'
    case 'copilot': case 'pi': case 'omp': case 'prime-agent': case 'droid': return extension === '.jsonl'
    case 'openclaw': return extension === '.jsonl' && path.split(sep).includes('sessions')
    case 'cursor': return extension === '.jsonl' && path.split(sep).includes('agent-transcripts')
    case 'grok': return name === 'summary.json'
    case 'devin': return extension === '.json'
    case 'hermes': return name.startsWith('session_') && extension === '.json'
    case 'jcode': return name.startsWith('session_') && extension === '.json'
    case 'kiro': return extension === '.json' && !name.endsWith('.messages.json')
    case 'rovo': return name === 'metadata.json'
    case 'cline': return extension === '.json' && name === `${basename(dirname(path))}.json`
    case 'kimi': return name === 'state.json' && basename(dirname(path)).startsWith('session_')
    case 'muse': return name === 'session.jsonl'
    case 'antigravity': return (name === 'transcript.jsonl' || name === 'transcript_full.jsonl') && path.split(sep).slice(-3, -1).join(sep) === join('.system_generated', 'logs')
    case 'opencode': return extension === '.json'
    default: return false
  }
}

function descend(spec: RootSpec, directory: string, depth: number): boolean {
  const name = basename(directory)
  if (['claude', 'qoder', 'codebuddy'].includes(spec.agent) && name === 'subagents') return false
  if (spec.agent === 'omp' && OMP_ARTIFACT_DIR.test(name)) return false
  if (spec.layout === 'cline') return depth === 0
  if (spec.layout === 'kiro' || spec.layout === 'metadata-only') return false
  if (spec.layout === 'antigravity') return depth === 0 || (depth === 1 && name === '.system_generated') || (depth === 2 && name === 'logs')
  if (spec.layout === 'openclaw') return depth === 0 || (depth === 1 && name === 'sessions') || depth > 1
  if (spec.layout === 'kimi') return (depth === 0 && name.startsWith('wd_')) || (depth === 1 && name.startsWith('session_'))
  return true
}

async function scanFilesystemRoot(spec: RootSpec, options: DiscoveryOptions, allSpecs: readonly RootSpec[], cursorIndex: Map<string, string>, codexIndexes: Map<string, Promise<Map<string, string>>>, issues: ScanIssue[], geminiMetadata: GeminiMetadataContext | null, signal?: AbortSignal): Promise<{ root: SourceRoot; candidates: SourceCandidate[] }> {
  let rootInfo
  try {
    rootInfo = await lstat(spec.path)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return { root: { agent: spec.agent, path: spec.path, presence: 'missing' }, candidates: [] }
    const reason = error instanceof Error ? error.message : String(error)
    issues.push({ agent: spec.agent, root: spec.path, reason, kind: 'error' })
    return { root: { agent: spec.agent, path: spec.path, presence: 'unverifiable', reason }, candidates: [] }
  }
  if (rootInfo.isSymbolicLink()) {
    const reason = 'Source root is a symbolic link'
    issues.push({ agent: spec.agent, root: spec.path, reason, kind: 'error' })
    return { root: { agent: spec.agent, path: spec.path, presence: 'unverifiable', reason }, candidates: [] }
  }
  if (spec.layout === 'sqlite-file') {
    if (!rootInfo.isFile()) return { root: { agent: spec.agent, path: spec.path, presence: 'missing' }, candidates: [] }
    const candidates = await sqliteCandidates(spec, options, issues)
    return { root: { agent: spec.agent, path: spec.path, presence: 'present' }, candidates }
  }
  if (!rootInfo.isDirectory()) return { root: { agent: spec.agent, path: spec.path, presence: 'unverifiable', reason: 'Source root is not a directory' }, candidates: [] }
  let rootReal: string
  try {
    rootReal = await realpath(spec.path)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    issues.push({ agent: spec.agent, root: spec.path, reason, kind: 'error' })
    return { root: { agent: spec.agent, path: spec.path, presence: 'unverifiable', reason }, candidates: [] }
  }
  if (spec.layout === 'sqlite-dir') {
    const candidates = await sqliteCandidates(spec, options, issues)
    return { root: { agent: spec.agent, path: spec.path, presence: 'present' }, candidates }
  }
  const candidates: SourceCandidate[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: spec.path, depth: 0 }]
  let unreadable = false
  while (queue.length) {
    if (signal?.aborted) throw signal.reason ?? new Error('Scan cancelled')
    const { dir, depth } = queue.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      unreadable = true
      issues.push({ agent: spec.agent, root: dir, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (descend(spec, path, depth)) queue.push({ dir: path, depth: depth + 1 })
      } else if (entry.isFile() && supportedFile(spec, path, depth)) {
        const candidate = await candidateForFile(spec, path, rootReal, cursorIndex, codexIndexes, issues, allSpecs, geminiMetadata, signal)
        if (candidate) candidates.push(candidate)
      }
    }
  }
  return { root: { agent: spec.agent, path: spec.path, presence: unreadable ? 'unverifiable' : 'present', ...(unreadable ? { reason: 'Some source directories could not be read' } : {}) }, candidates }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function sqliteRows(path: string, table: 'session' | 'session_v2'): Record<string, unknown>[] {
  let db: Database | undefined
  try {
    db = new Database(path, { readonly: true, create: false })
    db.exec('PRAGMA query_only = ON')
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name?: unknown }[]
    if (!tables.some((item) => item.name === table)) return []
    const columns = db.query(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as { name?: unknown }[]
    const names = new Set(columns.map((item) => String(item.name)))
    if (!names.has('id') || !names.has('time_created') || !names.has('time_updated')) return []
    const projection = ['id', 'time_created', 'time_updated', 'title', 'directory', 'cwd', 'parent_id', 'time_archived'].filter((name) => names.has(name)).map(quoteIdentifier).join(', ')
    const predicates = [names.has('parent_id') ? '"parent_id" IS NULL' : '', names.has('time_archived') ? '"time_archived" IS NULL' : ''].filter(Boolean).join(' AND ')
    const query = `SELECT ${projection} FROM ${quoteIdentifier(table)}${predicates ? ` WHERE ${predicates}` : ''}`
    return db.query(query).all() as Record<string, unknown>[]
  } catch (error) {
    throw error
  } finally {
    db?.close()
  }
}

async function sqliteCandidates(spec: RootSpec, options: DiscoveryOptions, issues: ScanIssue[]): Promise<SourceCandidate[]> {
  let databasePaths: string[]
  if (spec.layout === 'sqlite-file') {
    databasePaths = [spec.path]
  } else {
    databasePaths = await readdir(spec.path, { withFileTypes: true }).then((entries) => entries.filter((entry) => entry.isFile() && OPENCODE_DB_NAME.test(entry.name)).map((entry) => join(spec.path, entry.name))).catch((error) => {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : ''
      if (code !== 'ENOENT' && code !== 'ENOTDIR') issues.push({ agent: spec.agent, root: spec.path, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
      return []
    })
    const override = options.env.OPENCODE_DB?.trim()
    if ((spec.agent === 'opencode' || spec.agent === 'opencode2') && override && override !== ':memory:') {
      const selected = isAbsolute(override) ? resolve(override) : resolve(spec.path, override)
      if (dirname(selected) === resolve(spec.path) && !databasePaths.includes(selected)) databasePaths.push(selected)
    }
  }
  const result: SourceCandidate[] = []
  for (const dbPath of databasePaths) {
    let observation: Awaited<ReturnType<typeof observe>>
    try {
      observation = await observe(dbPath)
    } catch (error) {
      issues.push({ agent: spec.agent, filePath: dbPath, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
      continue
    }
    if (!observation.regular) continue
    const tables: ('session' | 'session_v2')[] = spec.agent === 'opencode' ? ['session'] : spec.agent === 'opencode2' ? ['session_v2'] : ['session']
    for (const table of tables) {
      let rows: Record<string, unknown>[]
      try {
        rows = sqliteRows(dbPath, table)
      } catch (error) {
        issues.push({ agent: spec.agent, filePath: dbPath, reason: error instanceof Error ? error.message : String(error), kind: 'error' })
        continue
      }
      for (const row of rows) {
        const sessionId = string(row.id)
        if (!sessionId) continue
        const filePath = `${dbPath}#${sessionId}`
        const updatedAt = numberOrDate(row.time_updated)
        const createdAt = numberOrDate(row.time_created)
        const stamp = updatedAt !== null && updatedAt > 0 ? updatedAt : createdAt ?? observation.mtimeMs
        const metadata: Record<string, unknown> = {
          sqliteTable: table,
          title: string(row.title),
          cwd: string(row.directory) ?? string(row.cwd),
          createdAt,
          updatedAt
        }
        result.push({
          agent: spec.agent,
          filePath,
          root: spec.path,
          signature: `${observation.signature}|${sessionId}|${row.time_updated ?? ''}|${row.time_created ?? ''}|${row.title ?? ''}|${row.directory ?? row.cwd ?? ''}`,
          mtimeMs: stamp,
          size: observation.size,
          codexHome: null,
          sessionId,
          sidecars: [],
          metadata
        })
      }
    }
  }
  return result
}

function sortCandidates(candidates: SourceCandidate[]): SourceCandidate[] {
  const chosen = new Map<string, SourceCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.agent}\0${candidate.sessionId ?? ''}`
    const previous = chosen.get(key)
    const candidateIsSqlite = candidate.metadata?.sqliteTable === 'session' || candidate.metadata?.sqliteTable === 'session_v2'
    const previousIsSqlite = previous?.metadata?.sqliteTable === 'session' || previous?.metadata?.sqliteTable === 'session_v2'
    const candidateIsFullAntigravity = candidate.agent === 'antigravity' && candidate.filePath.endsWith('transcript_full.jsonl')
    const previousIsFullAntigravity = previous?.agent === 'antigravity' && previous.filePath.endsWith('transcript_full.jsonl')
    if (!previous || (candidate.agent === 'opencode' && candidateIsSqlite && !previousIsSqlite) || (candidate.agent === 'antigravity' && candidateIsFullAntigravity && !previousIsFullAntigravity) || (candidateIsSqlite === previousIsSqlite && candidateIsFullAntigravity === previousIsFullAntigravity && candidate.mtimeMs > previous.mtimeMs)) {
      chosen.set(key, candidate)
    }
  }
  return [...chosen.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.agent.localeCompare(b.agent) || a.filePath.localeCompare(b.filePath))
}

export async function discoverSources(options: DiscoveryOptions, signal?: AbortSignal): Promise<Discovery> {
  const rootSpecs = rootsFor(options)
  const geminiRoot = rootSpecs.find((spec) => spec.agent === 'gemini' && spec.layout === 'tree')?.path
  const geminiMetadata = geminiRoot ? await createGeminiMetadataContext(geminiRoot) : null
  const issues: ScanIssue[] = []
  const cursorRoot = rootSpecs.find((spec) => spec.agent === 'cursor' && spec.layout === 'metadata-only')?.path
  const cursorIndex = cursorRoot ? await cursorMetaIndex(cursorRoot) : new Map<string, string>()
  const codexIndexes = new Map<string, Promise<Map<string, string>>>()
  const roots: SourceRoot[] = []
  const candidates: SourceCandidate[] = []
  for (const spec of rootSpecs) {
    if (signal?.aborted) throw signal.reason ?? new Error('Scan cancelled')
    const result = await scanFilesystemRoot(spec, options, rootSpecs, cursorIndex, codexIndexes, issues, geminiMetadata, signal)
    roots.push(result.root)
    candidates.push(...result.candidates)
  }
  const unique = sortCandidates(candidates)
  return { candidates: unique, roots, issues }
}

export function stableSourceId(candidate: SourceCandidate): string {
  const identity = `${candidate.agent}\0${resolve(candidate.filePath)}\0${candidate.sessionId ?? ''}`
  return `local_${createHash('sha256').update(identity).digest('base64url')}`
}

export function agentSourceRoots(options: DiscoveryOptions, agent: string): string[] {
  return rootsFor(options).filter((spec) => spec.agent === agent && spec.layout !== 'metadata-only').map((spec) => spec.path)
}

export function isPathWithin(root: string, path: string): boolean {
  return within(root, path)
}

export function isDeleteSupported(agent: string): boolean {
  return ['gemini', 'copilot', 'cursor', 'hermes', 'devin', 'openclaw', 'droid', 'pi', 'omp', 'claude', 'codebuddy', 'rovo', 'grok', 'cline'].includes(agent)
}

