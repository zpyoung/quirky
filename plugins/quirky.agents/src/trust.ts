import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { TrustPreset } from './core/types'

type JsonObject = Record<string, unknown>

const isPlainObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

const errorCode = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined)

/** Trust presets whose agent also honours a trusted ancestor, so a home or root must never be written. */
const INHERITS_FROM_ANCESTOR: ReadonlySet<TrustPreset> = new Set(['claude', 'copilot', 'qoder', 'qoder-cn'])

/**
 * Pre-writes the record that tells `preset`'s agent the folder is trusted, so its first-launch
 * trust menu does not swallow a pasted prompt. Unrelated content in the target file is kept,
 * the write is atomic, and any failure throws; the caller decides whether a launch goes on.
 * A folder that is a filesystem root, the home, or above the home is skipped for agents that
 * let a trusted folder cover everything below it.
 */
export function writeTrust(preset: TrustPreset, folder: string, userHome: string): void {
  if (INHERITS_FROM_ANCESTOR.has(preset) && coversHome(folder, userHome)) return
  switch (preset) {
    case 'claude':
      return writeClaudeTrust(folder, userHome)
    case 'cursor':
      return writeCursorTrust(folder, userHome)
    case 'copilot':
      return writeCopilotTrust(folder, userHome)
    case 'codex':
      return writeCodexTrust(folder, userHome)
    case 'antigravity':
      return writeAntigravityTrust(folder, userHome)
    case 'qoder':
      return writeQoderTrust(folder, userHome, '.qoder')
    case 'qoder-cn':
      return writeQoderTrust(folder, userHome, '.qoder-cn')
  }
}

// agents compare after realpath(), so a worktree under a symlinked parent must match their lookup
function canonicalize(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function pathForms(path: string): string[] {
  const forms = new Set([resolve(path), canonicalize(resolve(path))])
  return [...forms].map((form) => (form.length > 1 ? form.replace(/\/+$/, '') : form))
}

function coversHome(folder: string, home: string): boolean {
  const homes = pathForms(home)
  return pathForms(folder).some((form) => form === '/' || homes.some((h) => h === form || h.startsWith(`${form}/`)))
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

function readJsonObject(path: string): JsonObject {
  const text = readText(path)
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${path} is not valid JSON`)
  }
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object`)
  return parsed
}

/** Replaces `path` via a same-directory temp file, keeping an existing file's mode and a symlink's link. */
function writeFileAtomic(path: string, contents: string): void {
  let target = path
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  let mode = 0o600
  try {
    mode = statSync(target).mode & 0o777
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  const temp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temp, contents, { flag: 'wx', mode })
    // umask may have narrowed the requested mode
    chmodSync(temp, mode)
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

const writeJsonAtomic = (path: string, value: JsonObject) => writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`)

function readList(config: JsonObject, key: string, path: string): unknown[] {
  const value = config[key]
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path}: ${key} is not a list`)
  return value
}

function writeClaudeTrust(folder: string, home: string): void {
  // a legacy .config.json in the config directory wins over ~/.claude.json, as in Claude Code
  const legacy = join(home, '.claude', '.config.json')
  const path = existsSync(legacy) ? legacy : join(home, '.claude.json')
  const keys = [...new Set(pathForms(folder).map((form) => normalize(form.normalize('NFC'))))]
  const config = readJsonObject(path)
  if (config.projects !== undefined && !isPlainObject(config.projects)) throw new Error(`${path}: projects is not an object`)
  const projects: JsonObject = { ...(config.projects as JsonObject | undefined) }
  const trusted = (entry: unknown) => isPlainObject(entry) && entry.hasTrustDialogAccepted === true
  if (keys.some((key) => trusted(projects[key]))) return
  for (const key of keys) {
    const entry = projects[key]
    projects[key] = isPlainObject(entry) ? { ...entry, hasTrustDialogAccepted: true } : { hasTrustDialogAccepted: true }
  }
  writeJsonAtomic(path, { ...config, projects })
}

function writeCursorTrust(folder: string, home: string): void {
  const absolute = canonicalize(folder)
  const slug = absolute.replace(/^[\\/]+/, '').replace(/[\\/:*?"<>|]+/g, '-')
  if (!slug) return
  const marker = join(home, '.cursor', 'projects', slug, '.workspace-trusted')
  if (existsSync(marker)) return
  writeJsonAtomic(marker, { trustedAt: new Date().toISOString(), workspacePath: absolute })
}

function appendCanonical(list: unknown[], absolute: string): unknown[] | null {
  const present = list.some((entry) => typeof entry === 'string' && canonicalize(entry) === absolute)
  return present ? null : [...list, absolute]
}

function writeCopilotTrust(folder: string, home: string): void {
  const path = join(home, '.copilot', 'config.json')
  const config = readJsonObject(path)
  const next = appendCanonical(readList(config, 'trustedFolders', path), canonicalize(folder))
  if (next) writeJsonAtomic(path, { ...config, trustedFolders: next })
}

function writeAntigravityTrust(folder: string, home: string): void {
  const path = join(home, '.gemini', 'antigravity-cli', 'settings.json')
  const config = readJsonObject(path)
  const next = appendCanonical(readList(config, 'trustedWorkspaces', path), canonicalize(folder))
  if (next) writeJsonAtomic(path, { ...config, trustedWorkspaces: next })
}

function writeQoderTrust(folder: string, home: string, configDir: '.qoder' | '.qoder-cn'): void {
  const path = join(home, configDir, 'settings.json')
  const config = readJsonObject(path)
  if (config.permissions !== undefined && !isPlainObject(config.permissions)) throw new Error(`${path}: permissions is not an object`)
  const permissions: JsonObject = { ...(config.permissions as JsonObject | undefined) }
  const list = readList(permissions, 'trustDirectories', path)
  const absolute = canonicalize(folder)
  if (list.includes(absolute)) return
  writeJsonAtomic(path, { ...config, permissions: { ...permissions, trustDirectories: [...list, absolute] } })
}

function writeCodexTrust(folder: string, home: string): void {
  // codex checks the start folder's own entry before its repo root, so the folder itself is enough
  const path = join(home, '.codex', 'config.toml')
  const existing = readText(path) ?? ''
  const next = upsertProjectTrust(existing, canonicalize(folder))
  if (next !== existing) writeFileAtomic(path, next)
}

type TomlScan = { basic: boolean; literal: boolean; arrayDepth: number }

const isStructural = (state: TomlScan) => !state.basic && !state.literal && state.arrayDepth === 0

function skipBasicString(line: string, from: number): number {
  let index = from
  while (index < line.length) {
    if (line[index] === '\\') index += 2
    else if (line[index] === '"') return index + 1
    else index += 1
  }
  return index
}

function skipLiteralString(line: string, from: number): number {
  const end = line.indexOf("'", from)
  return end === -1 ? line.length : end + 1
}

/** Advances the scan across one line so lines inside multiline strings and arrays are not read as structure. */
function advanceScan(state: TomlScan, line: string): TomlScan {
  let mode: 'basic' | 'literal' | null = state.basic ? 'basic' : state.literal ? 'literal' : null
  let depth = state.arrayDepth
  let index = 0
  while (index < line.length) {
    if (mode === 'basic') {
      if (line[index] === '\\') index += 2
      else if (line.startsWith('"""', index)) {
        mode = null
        index += 3
      } else index += 1
      continue
    }
    if (mode === 'literal') {
      if (line.startsWith("'''", index)) {
        mode = null
        index += 3
      } else index += 1
      continue
    }
    const char = line[index]
    if (char === '#') break
    if (line.startsWith('"""', index)) {
      mode = 'basic'
      index += 3
    } else if (line.startsWith("'''", index)) {
      mode = 'literal'
      index += 3
    } else if (char === '"') index = skipBasicString(line, index + 1)
    else if (char === "'") index = skipLiteralString(line, index + 1)
    else {
      if (char === '[') depth += 1
      else if (char === ']') depth = Math.max(0, depth - 1)
      index += 1
    }
  }
  return { basic: mode === 'basic', literal: mode === 'literal', arrayDepth: depth }
}

const SIMPLE_ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

function parseSingleLineString(line: string, offset: number): { value: string; end: number } | null {
  let index = offset
  while (line[index] === ' ' || line[index] === '\t') index += 1
  if (line.startsWith('"""', index) || line.startsWith("'''", index)) return null
  const quote = line[index]
  if (quote !== '"' && quote !== "'") return null
  index += 1
  let value = ''
  while (index < line.length) {
    const char = line[index]!
    if (char === quote) return { value, end: index + 1 }
    if (quote === '"' && char === '\\') {
      const next = line[index + 1]
      if (next !== undefined && next in SIMPLE_ESCAPES) {
        value += SIMPLE_ESCAPES[next]
        index += 2
        continue
      }
      const width = next === 'u' ? 4 : next === 'U' ? 8 : 0
      const hex = line.slice(index + 2, index + 2 + width)
      if (!width || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) return null
      const code = Number.parseInt(hex, 16)
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
      value += String.fromCodePoint(code)
      index += 2 + width
      continue
    }
    value += char
    index += 1
  }
  return null
}

function parseKeyPath(source: string, offset: number): { segments: string[]; end: number } | null {
  const skipBlanks = (from: number) => {
    let index = from
    while (source[index] === ' ' || source[index] === '\t') index += 1
    return index
  }
  const segments: string[] = []
  let index = skipBlanks(offset)
  while (index < source.length) {
    const quoted = parseSingleLineString(source, index)
    if (quoted) {
      segments.push(quoted.value)
      index = quoted.end
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(source.slice(index))
      if (!bare) return null
      segments.push(bare[0])
      index += bare[0].length
    }
    index = skipBlanks(index)
    if (source[index] !== '.') return { segments, end: index }
    index = skipBlanks(index + 1)
  }
  return null
}

/** The key path of a `[table]` header line, or null for anything else (including `[[arrays]]`). */
function tableHeaderSegments(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('[') || trimmed.startsWith('[[')) return null
  const key = parseKeyPath(trimmed, 1)
  if (!key || trimmed[key.end] !== ']' || !/^\s*(#.*)?$/.test(trimmed.slice(key.end + 1))) return null
  return key.segments
}

function projectHeaderPath(line: string): string | null {
  const segments = tableHeaderSegments(line)
  return segments?.length === 2 && segments[0] === 'projects' ? segments[1]! : null
}

const escapeBasicString = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\b', '\\b')
    .replaceAll('\f', '\\f')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')

type TomlLine = { start: number; end: number; text: string; structural: boolean }

function* tomlLines(content: string): Generator<TomlLine> {
  let state: TomlScan = { basic: false, literal: false, arrayDepth: 0 }
  let cursor = 0
  while (cursor <= content.length) {
    const newline = content.indexOf('\n', cursor)
    const lineEnd = newline === -1 ? content.length : newline
    const text = content.slice(cursor, lineEnd).replace(/\r$/, '')
    yield { start: cursor, end: cursor + text.length, text, structural: isStructural(state) }
    state = advanceScan(state, text)
    if (newline === -1) return
    cursor = newline + 1
  }
}

/** Reads a `trust_level = "..."` line; `multilineAt` is where a `"""`/`'''` value opens when it spans lines. */
function trustLevelLine(text: string): { value: string | null; multilineAt: number | null } | null {
  const key = parseKeyPath(text, 0)
  if (!key || key.segments.length !== 1 || key.segments[0] !== 'trust_level' || text[key.end] !== '=') return null
  let open = key.end + 1
  while (text[open] === ' ' || text[open] === '\t') open += 1
  if (text.startsWith('"""', open) || text.startsWith("'''", open)) return { value: null, multilineAt: open }
  const parsed = parseSingleLineString(text, key.end + 1)
  const clean = parsed !== null && /^[ \t]*(?:#.*)?$/.test(text.slice(parsed.end))
  return { value: clean ? parsed.value : null, multilineAt: null }
}

/** End of the line holding the delimiter that closes the multiline string opened at `open`; null when unterminated. */
function multilineValueEnd(content: string, open: number): number | null {
  const delimiter = content.slice(open, open + 3)
  let index = open + 3
  while (index < content.length) {
    if (delimiter === '"""' && content[index] === '\\') index += 2
    else if (content.startsWith(delimiter, index)) {
      const newline = content.indexOf('\n', index)
      const end = newline === -1 ? content.length : newline
      return content[end - 1] === '\r' ? end - 1 : end
    } else index += 1
  }
  return null
}

/**
 * Sets `trust_level = "trusted"` in the `[projects."<path>"]` table of a Codex config, creating
 * the table when absent. Every other byte of the file, including line endings, is kept.
 */
function upsertProjectTrust(existing: string, projectPath: string): string {
  const content = existing.charCodeAt(0) === 0xfeff ? existing.slice(1) : existing
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const trustLine = 'trust_level = "trusted"'
  let headerEnd: number | null = null
  let entry: { start: number; end: number; value: string | null } | null = null
  for (const line of tomlLines(content)) {
    if (!line.structural) continue
    if (headerEnd === null) {
      if (projectHeaderPath(line.text) === projectPath) headerEnd = line.end
      continue
    }
    if (line.text.trimStart().startsWith('[')) break
    const level = trustLevelLine(line.text)
    if (level && !entry) {
      const end = level.multilineAt === null ? line.end : multilineValueEnd(content, line.start + level.multilineAt)
      entry = { start: line.start, end: end ?? line.end, value: level.value }
    }
  }
  if (headerEnd === null) {
    const block = [`[projects."${escapeBasicString(projectPath)}"]`, trustLine].join(eol)
    if (content.length === 0) return `${block}${eol}`
    const separator = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : eol + eol
    return `${content}${separator}${block}${eol}`
  }
  if (entry) {
    if (entry.value === 'trusted') return content
    return content.slice(0, entry.start) + trustLine + content.slice(entry.end)
  }
  return `${content.slice(0, headerEnd)}${eol}${trustLine}${content.slice(headerEnd)}`
}
