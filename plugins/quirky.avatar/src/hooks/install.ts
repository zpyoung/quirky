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

const SHIM_UNAVAILABLE_REASON = 'The Quirky avatar gate is unavailable; try again shortly.'

/**
 * The hook command for `agent`. With the shim in place it runs the shim with the deadline. With the
 * shim missing or not executable it answers passthrough, so an agent outside a Quirky session is
 * never blocked, unless the session has a supervision marker: then it exits 2 with a retry reason,
 * so a supervised session fails closed.
 */
export function gateCommand(agent: string, deadlineMs: number): string {
  const shim = `"\${QUIRKY_HOME-}/bin/${GATE_SHIM}"`
  const marker = `"$QUIRKY_HOME/plugin-data/quirky.avatar/supervised/$QUIRKY_SESSION_ID"`
  const supervised = `[ -n "\${QUIRKY_HOME-}" ] && [ -n "\${QUIRKY_SESSION_ID-}" ] && [ -e ${marker} ]`
  const failClosed = `if ${supervised}; then printf '%s\\n' '${SHIM_UNAVAILABLE_REASON}' >&2; exit 2; fi`
  return `[ -x ${shim} ] || { ${failClosed}; printf '{}\\n'; exit 0; }; exec "$QUIRKY_HOME/bin/${GATE_SHIM}" ${agent} ${deadlineMs}`
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

type HooksFile = { doc: Json; text: string | null }

function readHooksFile(path: string): HooksFile {
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { doc: {}, text: null }
  }
  const parsed: unknown = text.trim() === '' ? {} : JSON.parse(text)
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`)
  return { doc: parsed, text }
}

// surgical JSON edits: only the avatar's entries are inserted or removed, so every other byte stays

type Span = { start: number; end: number }
type JsonNode = Span & { members: Member[] | null; elements: JsonNode[] | null }
type Member = Span & { key: string; keyEnd: number; value: JsonNode }

/** Parses JSON text that `JSON.parse` already accepted, keeping the offset of every object, array and member. */
function parseSpans(text: string): JsonNode {
  let i = 0
  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i]!)) i++
  }
  const scanString = (): void => {
    i++
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    i++
  }
  const parseValue = (): JsonNode => {
    skipWs()
    const start = i
    const ch = text[i]
    if (ch === '{') {
      const members: Member[] = []
      i++
      skipWs()
      while (text[i] !== '}') {
        const keyStart = i
        scanString()
        const keyEnd = i
        skipWs()
        i++
        const value = parseValue()
        members.push({ start: keyStart, end: value.end, key: JSON.parse(text.slice(keyStart, keyEnd)) as string, keyEnd, value })
        skipWs()
        if (text[i] === ',') i++
        skipWs()
      }
      i++
      return { start, end: i, members, elements: null }
    }
    if (ch === '[') {
      const elements: JsonNode[] = []
      i++
      skipWs()
      while (text[i] !== ']') {
        elements.push(parseValue())
        skipWs()
        if (text[i] === ',') i++
        skipWs()
      }
      i++
      return { start, end: i, members: null, elements }
    }
    if (ch === '"') scanString()
    else while (i < text.length && !/[\s,\]}]/.test(text[i]!)) i++
    return { start, end: i, members: null, elements: null }
  }
  return parseValue()
}

const splice = (text: string, start: number, end: number, insert: string): string => text.slice(0, start) + insert + text.slice(end)

const detectIndent = (text: string): string => /^([ \t]+)"/m.exec(text)?.[1] ?? '  '

function lineIndent(text: string, pos: number): string {
  return /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', pos - 1) + 1))![0]
}

/** The whitespace before `pos` on its line when nothing else precedes it there, else null. */
function ownLinePrefix(text: string, pos: number): string | null {
  const before = text.slice(text.lastIndexOf('\n', pos - 1) + 1, pos)
  return /^[ \t]*$/.test(before) && text.lastIndexOf('\n', pos - 1) >= 0 ? before : null
}

function render(value: unknown, prefix: string | null, unit: string): string {
  return prefix === null ? JSON.stringify(value) : JSON.stringify(value, null, unit).replaceAll('\n', `\n${prefix}`)
}

/** Appends `child` to an object or array node, copying the separator and layout of its last child. */
function appendChild(text: string, container: JsonNode, child: { key?: string; value: unknown }): string {
  const unit = detectIndent(text)
  const children: Span[] = container.members ?? container.elements!
  const last = children[children.length - 1]
  const entry = (prefix: string | null, colon: string): string =>
    child.key === undefined ? render(child.value, prefix, unit) : `${JSON.stringify(child.key)}${colon}${render(child.value, prefix, unit)}`
  if (last === undefined) {
    const multiline = text.trim().includes('\n')
    const base = lineIndent(text, container.start)
    const body = multiline ? `\n${base}${unit}${entry(`${base}${unit}`, ': ')}\n${base}` : entry(null, ':')
    return splice(text, container.start + 1, container.end - 1, body)
  }
  const before = children[children.length - 2]
  const between = before !== undefined ? text.slice(before.end, last.start) : `,${text.slice(container.start + 1, last.start)}`
  const separator = between.slice(between.indexOf(','))
  const prefix = separator.includes('\n') ? separator.slice(separator.lastIndexOf('\n') + 1) : null
  const lastMember = container.members?.[container.members.length - 1]
  const colon = lastMember === undefined ? '' : text.slice(lastMember.keyEnd, lastMember.value.start)
  return splice(text, last.end, last.end, separator + entry(prefix, colon))
}

/** Removes child `index` of a container together with one adjoining comma. */
function removeChild(text: string, container: JsonNode, index: number): string {
  const children: Span[] = container.members ?? container.elements!
  const child = children[index]!
  if (children.length === 1) return splice(text, container.start + 1, container.end - 1, '')
  if (index < children.length - 1) return splice(text, child.start, children[index + 1]!.start, '')
  return splice(text, children[index - 1]!.end, child.end, '')
}

const memberOf = (node: JsonNode, key: string): Member | undefined => node.members?.filter((member) => member.key === key).at(-1)

function replaceElement(text: string, element: JsonNode, value: unknown): string {
  return splice(text, element.start, element.end, render(value, ownLinePrefix(text, element.start), detectIndent(text)))
}

const elementValue = (text: string, element: JsonNode): unknown => JSON.parse(text.slice(element.start, element.end))

function installIntoText(path: string, text: string, definition: Json): string {
  let next = text
  const root = parseSpans(next)
  const hooksMember = memberOf(root, 'hooks')
  if (hooksMember === undefined) {
    const hooks = Object.fromEntries(GATE_EVENTS.map((event) => [event, [definition]]))
    return appendChild(next, root, { key: 'hooks', value: hooks })
  }
  if (hooksMember.value.members === null) throw new Error(`${path} has a hooks value that is not an object`)
  for (const event of GATE_EVENTS) {
    const hooks = memberOf(parseSpans(next), 'hooks')!.value
    const member = memberOf(hooks, event)
    if (member === undefined) {
      next = appendChild(next, hooks, { key: event, value: [definition] })
      continue
    }
    if (member.value.elements === null) throw new Error(`${path} has a ${event} value that is not a list`)
    const owned = member.value.elements.filter((element) => ownsGate(elementValue(next, element)))
    if (owned.length === 1 && sameJson(elementValue(next, owned[0]!), definition)) continue
    if (owned.length === 0) {
      next = appendChild(next, member.value, { value: definition })
      continue
    }
    next = replaceElement(next, owned[0]!, definition)
    for (let extra = owned.length - 1; extra >= 1; extra--) {
      const current = memberOf(memberOf(parseSpans(next), 'hooks')!.value, event)!.value
      const index = current.elements!.findIndex((element, at) => at > 0 && ownsGate(elementValue(next, element)))
      if (index >= 0) next = removeChild(next, current, index)
    }
  }
  return next
}

function removeFromText(text: string): string {
  let next = text
  for (;;) {
    const hooks = memberOf(parseSpans(next), 'hooks')
    if (hooks?.value.members == null) return next
    const target = hooks.value.members.find((member) => member.value.elements?.some((element) => ownsGate(elementValue(next, element))))
    if (target === undefined) return next
    const elements = target.value.elements!
    const index = elements.findIndex((element) => ownsGate(elementValue(next, element)))
    if (elements.length > 1) {
      next = removeChild(next, target.value, index)
      continue
    }
    next = removeChild(next, hooks.value, hooks.value.members.indexOf(target))
    const root = parseSpans(next)
    const remaining = memberOf(root, 'hooks')!
    if (remaining.value.members!.length === 0) next = removeChild(next, root, root.members!.indexOf(remaining))
  }
}

function writeIfChanged(path: string, next: string, current: string | null): boolean {
  if (next === current) return false
  JSON.parse(next)
  writeAtomically(path, next)
  return true
}

/**
 * Adds the avatar's PreToolUse and PermissionRequest entries to Codex's `hooks.json`. The file is
 * edited as text, so every byte outside the avatar's own entries is preserved, and an up-to-date
 * install changes nothing. Returns whether the file changed. Throws when the file is not a JSON
 * object, rather than overwrite it.
 */
export function installCodexHooks(agentEnv: AgentEnv, judgmentTimeoutSeconds: number): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.doc.hooks !== undefined && !isRecord(file.doc.hooks)) throw new Error(`${path} has a hooks value that is not an object`)
  const definition = codexDefinition(judgmentTimeoutSeconds)
  if (file.text === null || file.text.trim() === '') {
    const hooks = Object.fromEntries(GATE_EVENTS.map((event) => [event, [definition]]))
    return writeIfChanged(path, `${JSON.stringify({ hooks }, null, 2)}\n`, file.text)
  }
  return writeIfChanged(path, installIntoText(path, file.text, definition), file.text)
}

/** Removes the avatar's entries from Codex's `hooks.json` and nothing else. Returns whether the file changed. */
export function removeCodexHooks(agentEnv: AgentEnv): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.text === null || !isRecord(file.doc.hooks)) return false
  const next = removeFromText(file.text)
  if (next === file.text) return false
  if (Object.keys(JSON.parse(next) as Json).length === 0) {
    rmSync(path, { force: true })
    return true
  }
  return writeIfChanged(path, next, file.text)
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
