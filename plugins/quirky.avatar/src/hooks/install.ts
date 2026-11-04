import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { LaunchHook } from '@quirky/protocol'
import type { Level } from '../contracts'
import { GATE_EXTENSION_FILE, GATE_EXTENSION_MARKER, gateExtensionSource } from './pi-extension'

/** The shim every avatar hook command runs; entries are recognized as the avatar's by this name. */
export const GATE_SHIM = 'quirky-gate'

/** The first Claude release that fails closed with `onFailure: "block"`. */
export const MIN_CLAUDE_VERSION = '2.1.295'

const GATE_EVENTS = ['PreToolUse', 'PermissionRequest'] as const

type Json = Record<string, unknown>

/** The user's home and environment as an agent sees them, so installs can be pointed at a scratch home. */
export type AgentEnv = { home: string; env: Record<string, string | undefined> }

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The environment of the running daemon, with `HOME` honored because Bun's `homedir()` ignores it. */
export function processAgentEnv(): AgentEnv {
  return { home: process.env.HOME || homedir(), env: process.env }
}

/** True when a test run would write the developer's real agent configs. */
export function isRealHomeInTest(agentEnv: AgentEnv): boolean {
  return process.env.NODE_ENV === 'test' && agentEnv.home === homedir()
}

function dirOverride(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && isAbsolute(trimmed) ? trimmed : fallback
}

function writeAtomically(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, text, mode === undefined ? undefined : { mode })
  renameSync(temp, path)
}

// supervision markers

/** A marker names the worktree and level a supervised session is held to. */
export type Marker = { worktreeId: string; level: Level }

/** Where supervision markers live; the shim and the pi extension look here before any network call. */
export function markerDir(quirkyHome: string): string {
  return join(quirkyHome, 'plugin-data', 'quirky.avatar', 'supervised')
}

const safeSessionId = (sessionId: string): boolean => sessionId !== '' && !/[\\/]/.test(sessionId) && !sessionId.startsWith('.')

/** Writes the marker for `sessionId` (mode 0600); an id that is not a plain file name is ignored. */
export function writeMarkerFile(quirkyHome: string, sessionId: string, marker: Marker): void {
  if (!safeSessionId(sessionId)) return
  writeAtomically(join(markerDir(quirkyHome), sessionId), JSON.stringify(marker), 0o600)
}

/** Removes the marker for `sessionId`, which turns that session back into passthrough. */
export function removeMarkerFile(quirkyHome: string, sessionId: string): void {
  if (!safeSessionId(sessionId)) return
  rmSync(join(markerDir(quirkyHome), sessionId), { force: true })
}

/** The marker for `sessionId`, or null when there is none or it is unreadable. */
export function readMarkerFile(quirkyHome: string, sessionId: string): Marker | null {
  if (!safeSessionId(sessionId)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(markerDir(quirkyHome), sessionId), 'utf8'))
    if (isRecord(parsed) && typeof parsed.worktreeId === 'string' && typeof parsed.level === 'string') return parsed as Marker
  } catch {
    return null
  }
  return null
}

/** True when `sessionId` has a marker file. */
export function hasMarkerFile(quirkyHome: string, sessionId: string): boolean {
  return safeSessionId(sessionId) && existsSync(join(markerDir(quirkyHome), sessionId))
}

/** Removes every marker, so every session returns to passthrough. */
export function clearMarkerFiles(quirkyHome: string): void {
  let names: string[] = []
  try {
    names = readdirSync(markerDir(quirkyHome))
  } catch {
    return
  }
  for (const name of names) rmSync(join(markerDir(quirkyHome), name), { force: true })
}

// hook commands

/** The daemon's wait for a judgment, which the shim and the brain's deadline derive from. */
export function gateDeadlineMs(judgmentTimeoutSeconds: number): number {
  return Math.round((judgmentTimeoutSeconds + 5) * 1000)
}

/** The agent hook timeout, in seconds, kept above the shim's own curl limit. */
export function gateHookTimeoutSeconds(judgmentTimeoutSeconds: number): number {
  return Math.ceil(judgmentTimeoutSeconds + 15)
}

/**
 * The hook command for `agent`. It answers passthrough when Quirky's shim is absent, so an agent
 * outside a Quirky session is never blocked, and otherwise runs the shim with the deadline.
 */
export function gateCommand(agent: string, deadlineMs: number): string {
  return `[ -x "\${QUIRKY_HOME-}/bin/${GATE_SHIM}" ] || { printf '{}\\n'; exit 0; }; exec "$QUIRKY_HOME/bin/${GATE_SHIM}" ${agent} ${deadlineMs}`
}

const isGateCommand = (command: unknown): boolean => typeof command === 'string' && command.includes(GATE_SHIM)

function ownsGate(definition: unknown): boolean {
  if (!isRecord(definition)) return false
  if (isGateCommand(definition.command)) return true
  return Array.isArray(definition.hooks) && definition.hooks.some((hook) => isRecord(hook) && isGateCommand(hook.command))
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// Claude

/** The first `x.y.z` in `claude --version` output, or null when there is none. */
export function parseClaudeVersion(output: string | null | undefined): string | null {
  const match = output ? /(\d+)\.(\d+)\.(\d+)/.exec(output) : null
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}

/** True only for a parseable version at or above `minimum`; an unknown version fails closed. */
export function claudeVersionAtLeast(version: string | null, minimum: string = MIN_CLAUDE_VERSION): boolean {
  const parsed = parseClaudeVersion(version)
  if (parsed === null) return false
  const have = parsed.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (have[i]! !== need[i]!) return have[i]! > need[i]!
  return true
}

/** Runs `<command> --version` and returns its output, or null on any failure or after five seconds. */
export async function probeClaudeVersion(command = 'claude'): Promise<string | null> {
  try {
    const proc = Bun.spawn([command, '--version'], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => proc.kill(), 5_000)
    const text = (await new Response(proc.stdout).text()).trim()
    clearTimeout(timer)
    return text === '' ? null : text
  } catch {
    return null
  }
}

/** A probe that remembers its answer for a minute. */
export function cachedClaudeVersion(probe: () => Promise<string | null> = probeClaudeVersion, ttlMs = 60_000): () => Promise<string | null> {
  let cached: { at: number; value: string | null } | null = null
  return async () => {
    if (cached !== null && Date.now() - cached.at < ttlMs) return cached.value
    const value = await probe().catch(() => null)
    cached = { at: Date.now(), value }
    return value
  }
}

/**
 * `existing` (the `--settings` object earlier launch hooks built) plus the avatar's PreToolUse and
 * PermissionRequest command hooks. Other hooks under those events are kept, because the runtime
 * replaces arrays rather than concatenating them.
 */
export function claudeGateSettings(existing: unknown, judgmentTimeoutSeconds: number): Json {
  const base = isRecord(existing) ? existing : {}
  const hooks: Json = isRecord(base.hooks) ? { ...base.hooks } : {}
  const definition = {
    matcher: '*',
    hooks: [
      {
        type: 'command',
        command: gateCommand('claude', gateDeadlineMs(judgmentTimeoutSeconds)),
        timeout: gateHookTimeoutSeconds(judgmentTimeoutSeconds),
        onFailure: 'block'
      }
    ]
  }
  for (const event of GATE_EVENTS) {
    const others = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter((entry) => !ownsGate(entry)) : []
    hooks[event] = [...others, definition]
  }
  return { ...base, hooks }
}

/** True when a launch's args carry a `--settings` object with a PreToolUse hook that runs the gate shim. */
export function launchHasGateHook(args: readonly unknown[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    let text: unknown
    if (arg === '--settings') text = args[i + 1]
    else if (typeof arg === 'string' && arg.startsWith('--settings=')) text = arg.slice('--settings='.length)
    if (typeof text !== 'string') continue
    try {
      const settings: unknown = JSON.parse(text)
      const entries = isRecord(settings) && isRecord(settings.hooks) ? settings.hooks.PreToolUse : undefined
      if (Array.isArray(entries) && entries.some(ownsGate)) return true
    } catch {
      continue
    }
  }
  return false
}

type LaunchHookDeps = { judgmentTimeoutSeconds(): number; claudeVersion(): Promise<string | null> }

/**
 * The launch hook that adds the avatar's `--settings` to a Claude launch. A Claude older than
 * 2.1.295 or of unknown version gets nothing, so its gate check fails instead of running unguarded.
 * Codex, pi and omp are gated through files, not launch args.
 */
export function createGateLaunchHook(deps: LaunchHookDeps): LaunchHook {
  return async (launch) => {
    if (launch.agent !== 'claude') return {}
    if (!claudeVersionAtLeast(await deps.claudeVersion())) return {}
    return { jsonArgs: { '--settings': claudeGateSettings(launch.jsonArgs['--settings'], deps.judgmentTimeoutSeconds()) } }
  }
}

// Codex

/** `$CODEX_HOME/hooks.json`, falling back to `~/.codex/hooks.json`. */
export function codexHooksPath(agentEnv: AgentEnv): string {
  return join(dirOverride(agentEnv.env.CODEX_HOME, join(agentEnv.home, '.codex')), 'hooks.json')
}

function codexDefinition(judgmentTimeoutSeconds: number): Json {
  return {
    hooks: [
      { type: 'command', command: gateCommand('codex', gateDeadlineMs(judgmentTimeoutSeconds)), timeout: gateHookTimeoutSeconds(judgmentTimeoutSeconds) }
    ]
  }
}

type HooksFile = { doc: Json; text: string | null; indent: string | number }

function readHooksFile(path: string): HooksFile {
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { doc: {}, text: null, indent: 2 }
  }
  const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`)
  return { doc: parsed, text, indent: /^([ \t]+)"/m.exec(text)?.[1] ?? 2 }
}

function writeHooksFile(path: string, file: HooksFile): boolean {
  const trailing = file.text === null || file.text.endsWith('\n') ? '\n' : ''
  const next = JSON.stringify(file.doc, null, file.indent) + trailing
  if (next === file.text) return false
  writeAtomically(path, next)
  return true
}

/**
 * Adds the avatar's PreToolUse and PermissionRequest entries to Codex's `hooks.json`. Entries it
 * does not own are left as they are, and an up-to-date install changes nothing. Returns whether
 * the file changed. Throws when the file is not a JSON object, rather than overwrite it.
 */
export function installCodexHooks(agentEnv: AgentEnv, judgmentTimeoutSeconds: number): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.doc.hooks !== undefined && !isRecord(file.doc.hooks)) throw new Error(`${path} has a hooks value that is not an object`)
  const hooks: Json = (file.doc.hooks as Json | undefined) ?? {}
  const definition = codexDefinition(judgmentTimeoutSeconds)
  for (const event of GATE_EVENTS) {
    const current = hooks[event]
    if (current !== undefined && !Array.isArray(current)) throw new Error(`${path} has a ${event} value that is not a list`)
    const existing = (current as unknown[] | undefined) ?? []
    const owned = existing.filter(ownsGate)
    if (owned.length === 1 && sameJson(owned[0], definition)) continue
    hooks[event] = [...existing.filter((entry) => !ownsGate(entry)), definition]
  }
  file.doc.hooks = hooks
  return writeHooksFile(path, file)
}

/** Removes the avatar's entries from Codex's `hooks.json` and nothing else. Returns whether the file changed. */
export function removeCodexHooks(agentEnv: AgentEnv): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.text === null || !isRecord(file.doc.hooks)) return false
  const hooks = file.doc.hooks
  let removed = false
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries) || !entries.some(ownsGate)) continue
    removed = true
    const kept = entries.filter((entry) => !ownsGate(entry))
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
  if (!removed) return false
  if (Object.keys(hooks).length === 0) delete file.doc.hooks
  if (Object.keys(file.doc).length === 0) {
    rmSync(path, { force: true })
    return true
  }
  return writeHooksFile(path, file)
}

/** True when both avatar entries are present in Codex's `hooks.json`. */
export function codexHooksInstalled(agentEnv: AgentEnv): boolean {
  try {
    const { doc } = readHooksFile(codexHooksPath(agentEnv))
    const hooks = isRecord(doc.hooks) ? doc.hooks : {}
    return GATE_EVENTS.every((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(ownsGate))
  } catch {
    return false
  }
}

// pi and omp

type PiAgent = 'pi' | 'omp'

function piAgentDir(agent: PiAgent, agentEnv: AgentEnv): string {
  return dirOverride(agentEnv.env.PI_CODING_AGENT_DIR, join(agentEnv.home, agent === 'pi' ? '.pi' : '.omp', 'agent'))
}

/** Where the avatar's extension file lives for `agent`; pi and omp share it when `PI_CODING_AGENT_DIR` is set. */
export function piExtensionPath(agent: PiAgent, agentEnv: AgentEnv): string {
  return join(piAgentDir(agent, agentEnv), 'extensions', GATE_EXTENSION_FILE)
}

/**
 * Writes the gate extension into the `extensions/` directory of each of pi and omp whose agent
 * directory exists. A file that is already current keeps its modification time, because the gate
 * check compares it with the session start. A file the avatar did not write is left alone.
 * Returns the paths written.
 */
export function installPiExtensions(agentEnv: AgentEnv): string[] {
  const content = gateExtensionSource()
  const written: string[] = []
  const seen = new Set<string>()
  for (const agent of ['pi', 'omp'] as const) {
    const path = piExtensionPath(agent, agentEnv)
    if (seen.has(path) || !existsSync(piAgentDir(agent, agentEnv))) continue
    seen.add(path)
    let current: string | null = null
    try {
      current = readFileSync(path, 'utf8')
    } catch {
      current = null
    }
    if (current === content) continue
    if (current !== null && !current.startsWith(`// ${GATE_EXTENSION_MARKER}`)) continue
    writeAtomically(path, content)
    written.push(path)
  }
  return written
}

/** The modification time of the avatar's extension for `agent` in ms, or null when it is absent. */
export function piExtensionMtimeMs(agent: PiAgent, agentEnv: AgentEnv): number | null {
  try {
    return statSync(piExtensionPath(agent, agentEnv)).mtimeMs
  } catch {
    return null
  }
}
