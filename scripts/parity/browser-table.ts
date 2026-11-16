import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type BrowserRow = {
  id: string
  command?: string
  equivalent: string
  check?: string
  disposition: 'covered' | 'gap' | 'excluded' | 'delegated'
  reason: string
  primary: boolean
  deferred: boolean
}

export type BrowserCaptureCommand = {
  words: string
  usage: string
  flags: string[]
  summary: string
  [key: string]: unknown
}

export type BrowserCapture = {
  commands: BrowserCaptureCommand[]
  [key: string]: unknown
}

type ManifestCommand = {
  words: string
  methods: string[]
  flags: string[]
}

type BrowserManifest = {
  commands: Map<string, ManifestCommand>
  methods: Set<string>
}

const TABLE_HEADER = '| ID | Orca feature / provenance | Quirky equivalent | Check | Disposition / reason |'
const dispositionByName: Record<string, BrowserRow['disposition']> = {
  covered: 'covered',
  gap: 'gap',
  excluded: 'excluded',
  delegated: 'delegated'
}
const EXPECTED_EXTRA_IDS = new Set([
  'tab-switch-focus',
  'tab-profile-create-imported',
  'exec-unrestricted',
  'native-profile-persistence',
  'native-profile-clear',
  'browser-identity-set-activation-after-restart',
  'worktree-watch-page',
  'daemon-restart-profile',
  'wait-selector',
  'wait-text',
  'wait-js',
  'wait-url',
  'wait-load'
])
const EXCLUDED_EXTRA_IDS: Record<string, true> = {
  'tab-profile-create-imported': true,
  'exec-unrestricted': true,
  'native-profile-persistence': true,
  'native-profile-clear': true
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOfUnknown(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
}

function stringArray(value: unknown): value is string[] {
  const values = arrayOfUnknown(value)
  return values !== undefined && values.every((item: unknown) => typeof item === 'string')
}

function capturePath(): string {
  return resolve(import.meta.dir, 'browser-orca.json')
}

function tablePath(): string {
  return resolve(import.meta.dir, '../../docs/parity/orca-browser.md')
}

function manifestPath(): string {
  return resolve(import.meta.dir, '../../plugins/quirky.browser/quirky-plugin.json')
}

function parseCapture(value: unknown): BrowserCapture {
  if (!isRecord(value)) fail('invalid-capture', 'expected a command inventory')
  const captureCommands = arrayOfUnknown(value.commands)
  if (!captureCommands) fail('invalid-capture', 'expected a command inventory')

  const commands = captureCommands.map((entry: unknown, index): BrowserCaptureCommand => {
    if (!isRecord(entry) || typeof entry.words !== 'string' || typeof entry.usage !== 'string' ||
      typeof entry.summary !== 'string' || !stringArray(entry.flags)) {
      return fail('invalid-capture', `command ${index} must include words, usage, flags, and summary`)
    }
    return { ...entry, words: entry.words, usage: entry.usage, flags: entry.flags, summary: entry.summary }
  })
  if (value.schemaVersion !== 1 || value.browserCommandCount !== commands.length) {
    fail('invalid-capture', 'schema version or browser command count does not match the frozen capture')
  }
  return { ...value, commands }
}

export function loadBrowserCapture(): BrowserCapture {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(capturePath(), 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail('invalid-capture', detail)
  }
  return parseCapture(parsed)
}

function splitTableRow(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

export function readBrowserTable(text?: string): BrowserRow[] {
  const source = text ?? readFileSync(tablePath(), 'utf8')
  const lines = source.split(/\r?\n/)
  const header = lines.findIndex((line) => line.trim() === TABLE_HEADER)
  if (header < 0) fail('invalid-table', 'missing the five-column browser inventory header')

  const rows: BrowserRow[] = []
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') {
      if (rows.length > 0) break
      continue
    }
    const cells = splitTableRow(line)
    if (!cells) break
    if (cells.length !== 5) fail('invalid-table', `row ${index + 1} must have five cells`)
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue

    const [id, provenance, equivalent, checkCell, dispositionCell] = cells
    const primaryMatch = /^orca: `([^`]+)`(?: — .+)?$/.exec(provenance)
    const extraMatch = /^goal-10: ([a-z0-9-]+)$/.exec(provenance)
    if (!primaryMatch && !extraMatch) fail('invalid-table', `row ${index + 1} needs Orca or goal-10 provenance`)

    let check: string | undefined
    let deferred = false
    if (checkCell === 'deferred') deferred = true
    else if (checkCell === 'none') {
      check = undefined
    } else if (checkCell.startsWith('check:')) {
      check = checkCell.slice('check:'.length).trim() || undefined
    } else {
      fail('missing-check', `row ${id} must name a check, deferred observer, or none`)
    }

    const separator = dispositionCell.indexOf(':')
    const disposition = separator < 0 ? undefined : dispositionByName[dispositionCell.slice(0, separator).trim()]
    const reason = separator < 0 ? '' : dispositionCell.slice(separator + 1).trim()
    if (!disposition) fail('invalid-table', `row ${id} has an unknown disposition`)

    const row: BrowserRow = {
      id,
      equivalent,
      disposition,
      reason,
      primary: primaryMatch !== null,
      deferred
    }
    if (primaryMatch) row.command = primaryMatch[1]
    if (check) row.check = check
    rows.push(row)
  }
  return rows
}

function readBrowserManifest(): BrowserManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath(), 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail('manifest-mismatch', detail)
  }
  if (!isRecord(parsed) || !isRecord(parsed.contributes)) {
    return fail('manifest-mismatch', 'plugin manifest has no CLI or method declarations')
  }
  const rawCommands = arrayOfUnknown(parsed.contributes['cli-command'])
  const rawMethods = arrayOfUnknown(parsed.contributes.method)
  if (!rawCommands || !rawMethods) return fail('manifest-mismatch', 'plugin manifest has no CLI or method declarations')

  const methods = new Set<string>()
  for (const entry of rawMethods) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      fail('manifest-mismatch', 'method contribution lacks an ID')
    }
    methods.add(`quirky.browser/${entry.id}`)
  }

  const commands = new Map<string, ManifestCommand>()
  for (const entry of rawCommands) {
    if (!isRecord(entry) || typeof entry.words !== 'string' || !stringArray(entry.methods) || entry.methods.length === 0) {
      fail('manifest-mismatch', 'CLI command declaration lacks words or public methods')
    }
    const rawFlags = entry.flags
    let flags: string[]
    if (rawFlags === null || rawFlags === undefined) flags = []
    else if (isRecord(rawFlags)) flags = Object.keys(rawFlags)
    else fail('manifest-mismatch', `invalid flags for ${entry.words}`)
    const command: ManifestCommand = {
      words: entry.words,
      methods: entry.methods,
      flags
    }
    if (commands.has(command.words)) fail('manifest-mismatch', `duplicate CLI words ${command.words}`)
    commands.set(command.words, command)
  }
  return { commands, methods }
}

function expectedCliWords(orcaWords: string): string {
  if (orcaWords.startsWith('browser identity ')) return orcaWords.slice('browser '.length)
  if (orcaWords === 'tab profile set') return 'tab profile set-page'
  return orcaWords
}

function parseEquivalent(value: string): { words: string; flags: string[]; methods: string[] } | undefined {
  const match = /^CLI `quirky browser ([^`]+)`; flags: (.+); methods: (.+)$/.exec(value)
  if (!match) return undefined
  const parseCodeList = (input: string, pattern: RegExp): string[] | undefined => {
    if (input === 'none') return []
    const values = input.split(', ')
    if (values.length === 0 || values.some((item) => !pattern.test(item))) return undefined
    return values.map((item) => item.slice(1, -1))
  }
  const flags = parseCodeList(match[2], /^`--[a-z0-9-]+`$/)
  const methods = parseCodeList(match[3], /^`quirky\.browser\/[A-Za-z0-9]+`$/)
  if (!flags || !methods) return undefined
  return { words: match[1], flags: flags.map((flag) => flag.slice(2)), methods }
}

function checkEquivalent(row: BrowserRow, manifest: BrowserManifest): void {
  if (row.equivalent === '—') {
    if (row.primary || !Object.hasOwn(EXCLUDED_EXTRA_IDS, row.id) || row.disposition !== 'excluded') {
      fail('manifest-mismatch', `row ${row.id} has no CLI equivalent`)
    }
    return
  }

  const equivalent = parseEquivalent(row.equivalent)
  if (!equivalent) fail('manifest-mismatch', `row ${row.id} has malformed CLI, flag, or method metadata`)
  if (row.command && equivalent.words !== expectedCliWords(row.command)) {
    fail('manifest-mismatch', `row ${row.id} resolves to unexpected CLI words ${equivalent.words}`)
  }
  const actual = manifest.commands.get(equivalent.words)
  if (!actual) fail('manifest-mismatch', `CLI words ${equivalent.words} do not exist in the plugin manifest`)
  const undeclaredMethod = equivalent.methods.find((method) => !manifest.methods.has(method))
  if (undeclaredMethod) fail('manifest-mismatch', `public method ${undeclaredMethod} does not exist in the plugin manifest`)
  const sort = (values: string[]) => [...values].sort()
  if (JSON.stringify(sort(equivalent.flags)) !== JSON.stringify(sort(actual.flags)) ||
    JSON.stringify(sort(equivalent.methods)) !== JSON.stringify(sort(actual.methods))) {
    fail('manifest-mismatch', `row ${row.id} does not match manifest flags or public methods for ${actual.words}`)
  }
}

function executableExtraValid(row: BrowserRow): boolean {
  if (row.id === 'tab-switch-focus') {
    return row.check === row.id && !row.deferred && row.disposition === 'covered'
  }
  if (row.id === 'wait-selector' || row.id === 'wait-text' || row.id === 'wait-js') {
    return row.check === row.id && !row.deferred && row.disposition === 'covered'
  }
  if (
    row.id === 'browser-identity-set-activation-after-restart' ||
    row.id === 'worktree-watch-page' ||
    row.id === 'daemon-restart-profile'
  ) {
    return row.check === row.id && !row.deferred && row.disposition === 'covered'
  }
  if (row.id === 'wait-url' || row.id === 'wait-load') {
    return row.check === row.id && !row.deferred && row.disposition === 'covered'
  }
  return false
}

export function validateBrowserTable(rows: BrowserRow[], checkIds?: Iterable<string>): void {
  const capture = loadBrowserCapture()
  const commandWords = new Set<string>()
  for (const command of capture.commands) {
    if (commandWords.has(command.words)) fail('invalid-capture', `duplicate captured command ${command.words}`)
    commandWords.add(command.words)
  }

  const byCommand = new Map<string, BrowserRow>()
  const byId = new Map<string, BrowserRow>()
  const manifest = readBrowserManifest()
  const tableCheckIds = new Set<string>()
  for (const row of rows) {
    if (byId.has(row.id)) fail('duplicate-command', `duplicate row ID ${row.id}`)
    byId.set(row.id, row)
    if (!row.reason.trim()) fail('missing-reason', `row ${row.id} has no disposition reason`)
    if (row.primary) {
      if (!row.command || !commandWords.has(row.command)) fail('unknown-command', `unknown captured command ${row.command ?? row.id}`)
      if (row.id !== row.command.replaceAll(' ', '-')) fail('unknown-command', `row ID ${row.id} does not match command ${row.command}`)
      if (byCommand.has(row.command)) fail('duplicate-command', `duplicate primary command ${row.command}`)
      byCommand.set(row.command, row)
    } else if (!EXPECTED_EXTRA_IDS.has(row.id)) {
      fail('unknown-command', `unknown goal-10 inventory row ${row.id}`)
    }

    if (row.deferred) {
      fail('missing-check', `row ${row.id} has no executable observer; check it or exclude it with a reason`)
    } else if (row.disposition === 'excluded') {
      if (row.check) fail('missing-check', `excluded row ${row.id} must not claim an executable check`)
    } else {
      if (!row.check) fail('missing-check', `row ${row.id} has no check ID`)
      if (row.check !== row.id || tableCheckIds.has(row.check)) {
        fail('missing-check', `row ${row.id} must have its own unique check ID`)
      }
      tableCheckIds.add(row.check)
    }

    if (!row.primary && !row.deferred && row.disposition !== 'excluded' && !executableExtraValid(row)) {
      fail('missing-check', `goal-10 row ${row.id} has no declared executable observer`)
    }
    checkEquivalent(row, manifest)
  }

  for (const command of commandWords) {
    if (!byCommand.has(command)) fail('missing-command', `captured command ${command} has no primary row`)
  }
  for (const extra of EXPECTED_EXTRA_IDS) {
    if (!byId.has(extra)) fail('missing-command', `required goal-10 row ${extra} is missing`)
  }

  const declaredCheckIds = new Set([
    ...capture.commands.map((command) => command.words.replaceAll(' ', '-')),
    'tab-switch-focus',
    'browser-identity-set-activation-after-restart',
    'worktree-watch-page',
    'daemon-restart-profile',
    'wait-selector',
    'wait-text',
    'wait-js',
    'wait-url',
    'wait-load'
  ])
  for (const check of tableCheckIds) {
    if (!declaredCheckIds.has(check)) fail('missing-check', `check ${check} is not declared for this inventory`)
  }

  if (checkIds !== undefined) {
    const registered = new Set<string>()
    for (const id of checkIds) {
      if (registered.has(id)) fail('missing-check', `registry repeats check ${id}`)
      registered.add(id)
    }
    for (const id of tableCheckIds) {
      if (!registered.has(id)) fail('missing-check', `table check ${id} is absent from the executable registry`)
    }
    for (const id of registered) {
      if (!tableCheckIds.has(id)) fail('missing-check', `registry check ${id} has no table row`)
    }
  }
}
