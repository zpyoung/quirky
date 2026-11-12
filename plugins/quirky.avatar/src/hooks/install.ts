import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { LaunchHook } from '@quirky/protocol'
import type { Level } from '../contracts'
import { GATE_EXTENSION_FILE, GATE_EXTENSION_MARKER, gateExtensionSource } from './pi-extension'

/** The shim every avatar hook command runs; entries are recognized as the avatar's by this name. */
export const GATE_SHIM = 'quirky-gate'

/** The first Claude release that fails closed with `onFailure: "block"`. */
export const MIN_CLAUDE_VERSION = '2.1.295'

const GATE_EVENTS = ['PreToolUse', 'PermissionRequest'] as const
type GateHookEvent = typeof GATE_EVENTS[number]

/** The session a hook command is written for. Without one the command reads `$QUIRKY_HOME` and `$QUIRKY_SESSION_ID`. */
export type GateIdentity = { quirkyHome: string; sessionId: string }

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`


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

function writePath(path: string): { path: string; mode?: number } {
  let current = path
  let links = 0
  for (;;) {
    let info: Stats
    try {
      info = lstatSync(current)
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
      if (code === 'ENOENT') return { path: current }
      if (code === 'ELOOP') throw new Error(`${path} is a link that never reaches a file`)
      throw error
    }
    if (!info.isSymbolicLink()) return { path: current, mode: info.mode & 0o777 }
    if (links === 40) throw new Error(`${path} is a link that never reaches a file`)
    let target: string
    try {
      target = readlinkSync(current)
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
      if (code === 'ELOOP') throw new Error(`${path} is a link that never reaches a file`)
      throw error
    }
    current = isAbsolute(target) ? target : resolve(dirname(current), target)
    links++
  }
}

function writeAtomically(path: string, text: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const target = writePath(path)
  const temp = `${target.path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, text)
    const targetMode = mode ?? target.mode
    if (targetMode !== undefined) chmodSync(temp, targetMode)
    renameSync(temp, target.path)
  } finally {
    rmSync(temp, { force: true })
  }
}


/** A marker names the worktree and level a supervised session is held to. */
export type Marker = { worktreeId: string; level: Level }

/** Where supervision markers live; the shim and the pi extension look here before any network call. */
export function markerDir(quirkyHome: string): string {
  return join(quirkyHome, 'plugin-data', 'quirky.avatar', 'supervised')
}
/** Names of files in the marker directory, sorted; empty when the directory is absent. */
export function listMarkerFiles(quirkyHome: string): string[] {
  try {
    return readdirSync(markerDir(quirkyHome), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
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


/** The daemon's wait for a judgment, which the shim and the brain's deadline derive from. */
export function gateDeadlineMs(judgmentTimeoutSeconds: number): number {
  return Math.round((judgmentTimeoutSeconds + 5) * 1000)
}

/** The agent hook timeout, in seconds, kept 30 seconds above the judgment timeout. */
export function gateHookTimeoutSeconds(judgmentTimeoutSeconds: number): number {
  return Math.ceil(judgmentTimeoutSeconds + 30)
}

const SHIM_UNAVAILABLE_REASON = "Quirky's avatar gate is unavailable; try again shortly."
const PERMISSION_REQUEST_DENIAL = `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Quirky's avatar gate is unavailable; try again shortly."}}}`

/**
 * The event-specific hook command. It answers `{}` unless the session has a supervision marker,
 * then runs the shim as a child and refuses in the event's form if the shim cannot decide.
 */
export function gateCommand(agent: 'claude' | 'codex', event: GateHookEvent, deadlineMs: number, identity?: GateIdentity): string {
  const identitySetup = identity === undefined
    ? `QUIRKY_HOME="\${QUIRKY_HOME-}"; QUIRKY_SESSION_ID="\${QUIRKY_SESSION_ID-}";`
    : `QUIRKY_HOME=${shellQuote(identity.quirkyHome)}; QUIRKY_SESSION_ID=${shellQuote(identity.sessionId)};`
  const passthrough = `printf '{}\\n'; exit 0`
  const eventTwoPass = event === 'PreToolUse' ? `if [ "$status" -eq 2 ]; then exit 2; fi;` : ''
  const refusal = event === 'PreToolUse'
    ? `printf '%s\\n' ${shellQuote(SHIM_UNAVAILABLE_REASON)} >&2; exit 2;`
    : `printf '%s\\n' ${shellQuote(PERMISSION_REQUEST_DENIAL)}; printf '%s\\n' ${shellQuote(SHIM_UNAVAILABLE_REASON)} >&2; exit 0;`
  return `{ ${identitySetup} export QUIRKY_HOME QUIRKY_SESSION_ID; if [ -z "$QUIRKY_HOME" ]; then ${passthrough}; fi; case "$QUIRKY_SESSION_ID" in ''|.*|*/*) ${passthrough} ;; esac; if [ ! -e "$QUIRKY_HOME/plugin-data/quirky.avatar/supervised/$QUIRKY_SESSION_ID" ]; then ${passthrough}; fi; "$QUIRKY_HOME/bin/${GATE_SHIM}" ${agent} ${deadlineMs} ${event}; status=$?; if [ "$status" -eq 0 ]; then exit 0; fi; ${eventTwoPass} ${refusal} }`
}

const isGateCommand = (command: unknown): boolean => typeof command === 'string' && command.includes(GATE_SHIM)

const ownsGateHook = (hook: unknown): boolean => isRecord(hook) && isGateCommand(hook.command)

function ownsGate(definition: unknown): boolean {
  if (!isRecord(definition)) return false
  if (isGateCommand(definition.command)) return true
  return Array.isArray(definition.hooks) && definition.hooks.some(ownsGateHook)
}

function ownsGateGroup(definition: unknown): boolean {
  if (!isRecord(definition)) return false
  if (isGateCommand(definition.command)) return true
  return Array.isArray(definition.hooks) && definition.hooks.length > 0 && definition.hooks.every(ownsGateHook)
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

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
 * `existing` (the `--settings` object earlier launch hooks built) plus one avatar command hook
 * under each gate event. Other hooks under those events are kept.
 */
export function claudeGateSettings(existing: unknown, judgmentTimeoutSeconds: number, identity?: GateIdentity): Json {
  const base = isRecord(existing) ? existing : {}
  const hooks: Json = isRecord(base.hooks) ? { ...base.hooks } : {}
  const deadlineMs = gateDeadlineMs(judgmentTimeoutSeconds)
  const timeout = gateHookTimeoutSeconds(judgmentTimeoutSeconds)
  for (const event of GATE_EVENTS) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []
    hooks[event] = entries.flatMap((entry) => {
      if (ownsGateGroup(entry)) return []
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) return [entry]
      const otherHooks = entry.hooks.filter((hook) => !ownsGateHook(hook))
      return otherHooks.length === entry.hooks.length ? [entry] : [{ ...entry, hooks: otherHooks }]
    }).concat([{
      matcher: '*',
      hooks: [{
        type: 'command',
        command: gateCommand('claude', event, deadlineMs, identity),
        timeout,
        onFailure: 'block'
      }]
    }])
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

/** What the launch hook recorded about a session it patched with the gate settings. */
export type HookedRecord = { agent: string; at: number; claudeVersion: string | null }

/** Where launch-hook records live; the session launch record does not keep hook-added args, so this is the proof a session was patched. */
export function hookedDir(dataDir: string): string {
  return join(dataDir, 'hooked')
}

/** Writes the record that `sessionId` was launched with the gate settings (mode 0600); an id that is not a plain file name is ignored. */
export function writeHookedRecord(dataDir: string, sessionId: string, record: HookedRecord): void {
  if (!safeSessionId(sessionId)) return
  writeAtomically(join(hookedDir(dataDir), sessionId), JSON.stringify(record), 0o600)
}

/** True when the launch hook recorded that it added the gate settings to `sessionId`'s launch. */
export function hasHookedRecord(dataDir: string, sessionId: string): boolean {
  if (!safeSessionId(sessionId)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(hookedDir(dataDir), sessionId), 'utf8'))
    return isRecord(parsed) && typeof parsed.agent === 'string'
  } catch {
    return false
  }
}

type LaunchHookDeps = { judgmentTimeoutSeconds(): number; claudeVersion(): Promise<string | null>; quirkyHome: string; dataDir?: string }

/**
 * The launch hook that adds the avatar's `--settings` to a Claude launch and records the session as
 * hooked under `dataDir` when one is given. A Claude older than 2.1.295 or of unknown version gets nothing and no
 * record, so its gate check fails instead of running unguarded. Codex, pi and omp are gated through
 * files, not launch args.
 */
export function createGateLaunchHook(deps: LaunchHookDeps): LaunchHook {
  return async (launch) => {
    if (launch.agent !== 'claude') return {}
    const version = await deps.claudeVersion()
    if (!claudeVersionAtLeast(version)) return {}
    try {
      if (deps.dataDir !== undefined) writeHookedRecord(deps.dataDir, launch.sessionId, { agent: launch.agent, at: Date.now(), claudeVersion: parseClaudeVersion(version) })
    } catch {
      // an unwritable record leaves the session unprovable, which the gate check reports
    }
    return { jsonArgs: { '--settings': claudeGateSettings(launch.jsonArgs['--settings'], deps.judgmentTimeoutSeconds(), { quirkyHome: deps.quirkyHome, sessionId: launch.sessionId }) } }
  }
}


/** `$CODEX_HOME/hooks.json`, falling back to `~/.codex/hooks.json`. */
export function codexHooksPath(agentEnv: AgentEnv): string {
  return join(dirOverride(agentEnv.env.CODEX_HOME, join(agentEnv.home, '.codex')), 'hooks.json')
}

function codexDefinition(event: GateHookEvent, judgmentTimeoutSeconds: number): Json {
  return {
    hooks: [
      { type: 'command', command: gateCommand('codex', event, gateDeadlineMs(judgmentTimeoutSeconds)), timeout: gateHookTimeoutSeconds(judgmentTimeoutSeconds) }
    ]
  }
}

type HooksFile = { doc: Json; text: string | null }

function readHooksFile(path: string): HooksFile {
  let text: string | null = null
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'unknown'
    if (code === 'ENOENT') return { doc: {}, text: null }
    throw new Error(`${path} could not be read (${code})`)
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

function installIntoText(path: string, text: string, definitions: Record<GateHookEvent, Json>): string {
  let next = text
  const root = parseSpans(next)
  const hooksMember = memberOf(root, 'hooks')
  if (hooksMember === undefined) {
    const hooks = Object.fromEntries(GATE_EVENTS.map((event) => [event, [definitions[event]]]))
    return appendChild(next, root, { key: 'hooks', value: hooks })
  }
  if (hooksMember.value.members === null) throw new Error(`${path} has a hooks value that is not an object`)
  for (const event of GATE_EVENTS) {
    const hooks = memberOf(parseSpans(next), 'hooks')!.value
    const member = memberOf(hooks, event)
    if (member === undefined) {
      next = appendChild(next, hooks, { key: event, value: [definitions[event]] })
      continue
    }
    if (member.value.elements === null) throw new Error(`${path} has a ${event} value that is not a list`)
    const groups = member.value.elements.map((element) => elementValue(next, element))
    const ownedIndexes = groups.flatMap((group, index) => ownsGateGroup(group) ? [index] : [])
    const hasSharedOwnedHooks = groups.some((group) => !ownsGateGroup(group) && ownsGate(group))
    const firstOwned = ownedIndexes[0]
    if (ownedIndexes.length === 1 && sameJson(groups[firstOwned!]!, definitions[event]) && !hasSharedOwnedHooks) continue
    for (let index = groups.length - 1; index >= 0; index--) {
      const list = memberOf(memberOf(parseSpans(next), 'hooks')!.value, event)!.value
      const groupNode = list.elements![index]!
      const group = elementValue(next, groupNode)
      if (ownsGateGroup(group)) {
        if (index === firstOwned) {
          if (!sameJson(group, definitions[event])) next = replaceElement(next, groupNode, definitions[event])
        } else {
          next = removeChild(next, list, index)
        }
        continue
      }
      if (!ownsGate(group)) continue
      const groupHooks = memberOf(groupNode, 'hooks')?.value
      if (groupHooks?.elements === null || groupHooks === undefined) continue
      for (let hookIndex = groupHooks.elements.length - 1; hookIndex >= 0; hookIndex--) {
        const currentList = memberOf(memberOf(parseSpans(next), 'hooks')!.value, event)!.value
        const currentGroup = currentList.elements![index]!
        const currentHooks = memberOf(currentGroup, 'hooks')!.value
        if (ownsGateHook(elementValue(next, currentHooks.elements![hookIndex]!))) {
          next = removeChild(next, currentHooks, hookIndex)
        }
      }
    }
    if (firstOwned === undefined) {
      const list = memberOf(memberOf(parseSpans(next), 'hooks')!.value, event)!.value
      next = appendChild(next, list, { value: definitions[event] })
    }
  }
  return next
}

function removeFromText(text: string): string {
  let next = text
  for (;;) {
    const root = parseSpans(next)
    const hooks = memberOf(root, 'hooks')
    if (hooks?.value.members == null) return next
    let target: Member | undefined
    let groupIndex = -1
    for (const member of hooks.value.members) {
      groupIndex = member.value.elements?.findIndex((element) => ownsGate(elementValue(next, element))) ?? -1
      if (groupIndex >= 0) {
        target = member
        break
      }
    }
    if (target === undefined) return next
    const groups = target.value.elements!
    const groupNode = groups[groupIndex]!
    const group = elementValue(next, groupNode)
    if (ownsGateGroup(group)) {
      next = removeChild(next, target.value, groupIndex)
      if (groups.length === 1) {
        const currentRoot = parseSpans(next)
        const currentHooks = memberOf(currentRoot, 'hooks')!
        const eventIndex = currentHooks.value.members!.findIndex((member) => member.start === target.start)
        next = removeChild(next, currentHooks.value, eventIndex)
        const rootAfter = parseSpans(next)
        const remaining = memberOf(rootAfter, 'hooks')
        if (remaining?.value.members?.length === 0) next = removeChild(next, rootAfter, rootAfter.members!.indexOf(remaining))
      }
      continue
    }
    const groupHooks = memberOf(groupNode, 'hooks')!.value
    const hookIndex = groupHooks.elements!.findIndex((element) => ownsGateHook(elementValue(next, element)))
    next = removeChild(next, groupHooks, hookIndex)
  }
}

function writeIfChanged(path: string, next: string, current: string | null): boolean {
  if (next === current) return false
  JSON.parse(next)
  writeAtomically(path, next)
  return true
}

/**
 * Adds the avatar's event-specific entries to Codex's `hooks.json`, preserving all bytes outside
 * its own entries. An up-to-date install changes nothing; invalid files are not overwritten.
 */
export function installCodexHooks(agentEnv: AgentEnv, judgmentTimeoutSeconds: number): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.doc.hooks !== undefined && !isRecord(file.doc.hooks)) throw new Error(`${path} has a hooks value that is not an object`)
  const definitions = Object.fromEntries(GATE_EVENTS.map((event) => [event, codexDefinition(event, judgmentTimeoutSeconds)])) as Record<GateHookEvent, Json>
  if (file.text === null || file.text.trim() === '') {
    const hooks = Object.fromEntries(GATE_EVENTS.map((event) => [event, [definitions[event]]]))
    return writeIfChanged(path, `${JSON.stringify({ hooks }, null, 2)}\n`, file.text)
  }
  return writeIfChanged(path, installIntoText(path, file.text, definitions), file.text)
}

/** Removes the avatar's entries from Codex's `hooks.json` and nothing else; never deletes the file. */
export function removeCodexHooks(agentEnv: AgentEnv): boolean {
  const path = codexHooksPath(agentEnv)
  const file = readHooksFile(path)
  if (file.text === null || !isRecord(file.doc.hooks)) return false
  const next = removeFromText(file.text)
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


type PiAgent = 'pi' | 'omp'

function piAgentDir(agent: PiAgent, agentEnv: AgentEnv): string {
  return dirOverride(agentEnv.env.PI_CODING_AGENT_DIR, join(agentEnv.home, agent === 'pi' ? '.pi' : '.omp', 'agent'))
}

/** Where the avatar's extension file lives for `agent`; pi and omp share it when `PI_CODING_AGENT_DIR` is set. */
export function piExtensionPath(agent: PiAgent, agentEnv: AgentEnv): string {
  return join(piAgentDir(agent, agentEnv), 'extensions', GATE_EXTENSION_FILE)
}

/**
 * Writes the gate extension into the `extensions/` directory of each selected agent whose agent
 * directory exists. Current files keep their modification time; files the avatar did not write
 * are left alone. Returns the paths written.
 */
export function installPiExtensions(agentEnv: AgentEnv, agents: readonly PiAgent[] = ['pi', 'omp']): string[] {
  const content = gateExtensionSource()
  const written: string[] = []
  const seen = new Set<string>()
  for (const agent of agents) {
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

/** Removes only avatar-owned pi and omp extension files and returns the paths deleted. */
export function removePiExtensions(agentEnv: AgentEnv): string[] {
  const removed: string[] = []
  const seen = new Set<string>()
  for (const agent of ['pi', 'omp'] as const) {
    const path = piExtensionPath(agent, agentEnv)
    if (seen.has(path)) continue
    seen.add(path)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!content.startsWith(`// ${GATE_EXTENSION_MARKER}`)) continue
    rmSync(path, { force: true })
    removed.push(path)
  }
  return removed
}

/** The modification time of the avatar's extension for `agent` in ms, or null when it is absent. */
export function piExtensionMtimeMs(agent: PiAgent, agentEnv: AgentEnv): number | null {
  try {
    return statSync(piExtensionPath(agent, agentEnv)).mtimeMs
  } catch {
    return null
  }
}
