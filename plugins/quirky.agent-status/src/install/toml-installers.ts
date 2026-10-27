import { join } from 'node:path'
import { hookCommand, isQuirkyHookCommand } from '../hook-command.ts'
import { InstallError, type InstallEnv, type Installer } from '../types.ts'
import { HOOK_TIMEOUT_SECONDS } from './claude-json.ts'
import { REAL_HOME_SKIPPED, dirOverride, isRealHomeInTest, tildePath } from './common.ts'
import { appendBlock, commitParts, findRegion, readText, removeRegion, snapshot, splitText, type TextLines } from './files-region.ts'
import { parseHeader, parseKeyLine, parseStringValue, quoteBasic, scanToml, type TomlScan } from './toml-lines.ts'

const KIMI_START = '# >>> quirky-managed-kimi-hooks'
const KIMI_END = '# <<< quirky-managed-kimi-hooks'
const KIMI_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure']

const JCODE_EVENTS = ['session_start', 'turn_start', 'pre_tool', 'post_tool', 'turn_end', 'session_end']

function kimiPath(target: InstallEnv): string {
  return join(dirOverride(target.env.KIMI_CODE_HOME, join(target.home, '.kimi-code')), 'config.toml')
}

function jcodePath(target: InstallEnv): string {
  return join(dirOverride(target.env.JCODE_HOME, join(target.home, '.jcode')), 'config.toml')
}

function kimiBlock(): string[] {
  const command = quoteBasic(hookCommand('kimi'))
  return [
    KIMI_START,
    ...KIMI_EVENTS.flatMap((event) => ['[[hooks]]', `event = "${event}"`, `command = ${command}`, `timeout = ${HOOK_TIMEOUT_SECONDS}`]),
    KIMI_END
  ]
}

/** Splits a TOML file into lines, throwing InstallError, with the file untouched, when it can't be read as TOML. */
function readToml(path: string, home: string): { text: string | null; parts: TextLines; scan: TomlScan } {
  const text = readText(path, home)
  const parts = splitText(text ?? '')
  const scan = scanToml(parts.lines)
  if (!scan.valid) throw new InstallError(`Could not parse ${tildePath(path, home)}`)
  return { text, parts, scan }
}

/**
 * Kimi Code reads its hooks from `[[hooks]]` tables. Quirky owns one marked block of them, so
 * install replaces the block and remove deletes it; every other line is the user's.
 */
export const kimiInstaller: Installer = {
  agent: 'kimi',
  source: 'kimi',
  files: (target) => [kimiPath(target)],
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const path = kimiPath(target)
    const { text, parts } = readToml(path, target.home)
    const original = snapshot(parts)
    const block = kimiBlock()
    const region = findRegion(parts.lines, KIMI_START, KIMI_END)
    if (region) parts.lines.splice(region.start, region.end - region.start + 1, ...block)
    else appendBlock(parts, block, true)
    return { changed: commitParts(path, text, original, parts) ? [path] : [] }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const path = kimiPath(target)
    const { text, parts } = readToml(path, target.home)
    const original = snapshot(parts)
    const region = findRegion(parts.lines, KIMI_START, KIMI_END)
    if (!region) return { changed: [] }
    removeRegion(parts, region)
    return { changed: commitParts(path, text, original, parts) ? [path] : [] }
  },
  status(target) {
    try {
      const { parts } = readToml(kimiPath(target), target.home)
      const region = findRegion(parts.lines, KIMI_START, KIMI_END)
      if (!region) return 'not-installed'
      const found = parts.lines.slice(region.start, region.end + 1).map((line) => line.trim())
      return found.join('\n') === kimiBlock().join('\n') ? 'installed' : 'not-installed'
    } catch (error) {
      if (error instanceof InstallError) return { error: error.message }
      throw error
    }
  }
}

/**
 * jcode tokenizes a hook value shell-style and runs it without a shell, so the shim command is
 * wrapped in `sh -c '...'`; single quotes pass it through verbatim.
 */
function jcodeValue(): string {
  return `sh -c '${hookCommand('jcode').replaceAll("'", "'\\''")}'`
}

type HooksTable = { header: number; end: number }

/** The `[hooks]` table's header line and the index after its last line; throws when the file defines it twice or in a way adding a table would break. */
function findHooksTable(parts: TextLines, scan: TomlScan): HooksTable | null {
  let found: HooksTable | null = null
  let inRoot = true
  for (const [index, kind] of scan.kinds.entries()) {
    const line = parts.lines[index]!
    if (kind === 'header') {
      inRoot = false
      const header = parseHeader(line)
      if (found && found.end === parts.lines.length) found.end = index
      if (header && !header.array && header.segments.join('.') === 'hooks') {
        if (found) throw new InstallError('duplicate hooks table')
        found = { header: index, end: parts.lines.length }
      }
    } else if (kind === 'key' && inRoot && parseKeyLine(line)?.segments[0] === 'hooks') {
      throw new InstallError('hooks defined at the top level')
    }
  }
  return found
}

function readJcode(path: string, home: string): { text: string | null; parts: TextLines; scan: TomlScan; table: HooksTable | null } {
  const read = readToml(path, home)
  try {
    return { ...read, table: findHooksTable(read.parts, read.scan) }
  } catch (error) {
    if (error instanceof InstallError) throw new InstallError(`Could not parse ${tildePath(path, home)}`)
    throw error
  }
}

type JcodeKey = { event: string; line: number; value: string | null }

function jcodeKeys(parts: TextLines, scan: TomlScan, table: HooksTable): JcodeKey[] {
  const keys: JcodeKey[] = []
  for (let index = table.header + 1; index < table.end; index++) {
    if (scan.kinds[index] !== 'key') continue
    const key = parseKeyLine(parts.lines[index]!)
    if (key?.segments.length !== 1) continue
    keys.push({ event: key.segments[0]!, line: index, value: parseStringValue(key.value) })
  }
  return keys
}

const ownsValue = (value: string | null): boolean => value !== null && isQuirkyHookCommand(value)

/**
 * jcode keeps hooks as scalar `<event> = '<command>'` keys in its `[hooks]` table. Quirky owns a
 * key whose command runs the shim; a key the user wrote for the same event is kept and reported.
 */
export const jcodeInstaller: Installer = {
  agent: 'jcode',
  source: 'jcode',
  files: (target) => [jcodePath(target)],
  install(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const path = jcodePath(target)
    const { text, parts, scan, table } = readJcode(path, target.home)
    const original = snapshot(parts)
    const value = jcodeValue()
    const wanted = (event: string): string => `${event} = ${quoteBasic(value)}`
    const userOwned: string[] = []
    const present = new Set<string>()
    if (table) {
      for (const key of jcodeKeys(parts, scan, table)) {
        if (!JCODE_EVENTS.includes(key.event) || present.has(key.event)) continue
        present.add(key.event)
        if (!ownsValue(key.value)) userOwned.push(key.event)
        else if (key.value !== value) parts.lines[key.line] = wanted(key.event)
      }
    }
    const missing = JCODE_EVENTS.filter((event) => !present.has(event)).map(wanted)
    if (table) parts.lines.splice(table.header + 1, 0, ...missing)
    else appendBlock(parts, ['[hooks]', ...missing], true)
    const changed = commitParts(path, text, original, parts) ? [path] : []
    const message = userOwned.length > 0 ? `kept your own jcode hooks for ${userOwned.join(', ')}` : undefined
    return { changed, ...(message ? { message } : {}) }
  },
  remove(target) {
    if (isRealHomeInTest(target.home)) return { changed: [], message: REAL_HOME_SKIPPED }
    const path = jcodePath(target)
    const { text, parts, scan, table } = readJcode(path, target.home)
    if (!table) return { changed: [] }
    const owned = jcodeKeys(parts, scan, table).filter((key) => ownsValue(key.value))
    if (owned.length === 0) return { changed: [] }
    const original = snapshot(parts)
    const drop = new Set(owned.map((key) => key.line))
    const body = Array.from({ length: table.end - table.header - 1 }, (_, offset) => table.header + 1 + offset)
    if (body.every((index) => drop.has(index) || scan.kinds[index] === 'blank')) {
      // the table was Quirky's alone: take its header and the blank line install put above it
      drop.add(table.header)
      if (table.header > 0 && parts.lines[table.header - 1]!.trim() === '') drop.add(table.header - 1)
      if (table.end === parts.lines.length) for (const index of body) drop.add(index)
    }
    parts.lines = parts.lines.filter((_, index) => !drop.has(index))
    return { changed: commitParts(path, text, original, parts) ? [path] : [] }
  },
  status(target) {
    try {
      const { parts, scan, table } = readJcode(jcodePath(target), target.home)
      if (!table) return 'not-installed'
      const value = jcodeValue()
      const keys = jcodeKeys(parts, scan, table)
      return JCODE_EVENTS.every((event) => keys.some((key) => key.event === event && key.value === value)) ? 'installed' : 'not-installed'
    } catch (error) {
      if (error instanceof InstallError) return { error: error.message }
      throw error
    }
  }
}
