import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { RESERVED_FLAG_NAMES, flagNameOf } from '@quirky/protocol'
import type { ApiCatalog, ApiCliCommandEntry, ApiCliFlag, ApiCliPositional, ApiCommandEntry, ApiMethodEntry, ApiUiCommandEntry } from '@quirky/protocol'

export type CliDisposition = 'covered' | 'mapped-only' | 'gap' | 'excluded' | 'delegated'
export type CliRootOwner = 'g10-1' | 'g12-1'

export type CliInventoryCommand = {
  command: string
  path: string[]
  aliases: string[][]
  argumentMode: string
  summary: string
  usage: string
  flags: string[]
  positionalArgs: unknown[]
  examples: string[]
  notes: string[]
  [key: string]: unknown
}

export type CliInventory = {
  capturedAt: string
  discoveryCommands: string[]
  preflightCommands: string[]
  sourceSchemaVersion: number
  observedCommandCount: number
  rootWords: string[]
  rootAssignments: Array<{ root: string; owner: CliRootOwner }>
  commands: CliInventoryCommand[]
}

export type CliTableRow = {
  id: string
  command?: string
  root?: string
  provenance: string
  equivalent: string
  checks: string[]
  disposition: CliDisposition
  reason: string
  followUp?: string
  missingBehavior?: string
}

export type CliCatalogMapping = {
  rowId: string
  kind: 'plugin' | 'kernel' | 'api-call' | 'ui-run'
  words: string
  primaryWords: string
  plugin?: string
  commandId?: string
  groupAliases: string[]
  method: string | null
  methods: string[]
  flags: ApiCliFlag[]
  positionals: ApiCliPositional[]
  methodTarget?: string
  uiCommand?: string
}

export type CliCatalogRowRefs = { rowId: string; refs: string[] }

export type CliTableErrorCode =
  | 'invalid-capture'
  | 'invalid-table'
  | 'missing-group'
  | 'missing-command'
  | 'duplicate-row'
  | 'unknown-row'
  | 'unassigned-root'
  | 'missing-reason'
  | 'missing-check'
  | 'missing-follow-up'
  | 'missing-catalog-ref'
  | 'catalog-mismatch'
  | 'invalid-catalog'
  | 'invalid-mapping'
  | 'missing-method'
  | 'invalid-method-schema'
  | 'missing-cli-command'
  | 'invalid-command-binding'
  | 'shadowed-command'
  | 'missing-flag'
  | 'unexpected-flag'
  | 'invalid-flag-schema'
  | 'missing-positional'
  | 'unexpected-positional'
  | 'invalid-positional-schema'
  | 'missing-ui-command'
  | 'invalid-ui-command'

export class CliTableError extends Error {
  constructor(readonly code: CliTableErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'CliTableError'
  }
}

const TABLE_HEADER = '| ID | Orca feature / provenance | Quirky equivalent | Check | Disposition / reason |'
const MANDATORY_ROOTS = [
  'worktree', 'terminal', 'agent', 'loop', 'ask', 'automations', 'orchestration', 'repo',
  'project', 'file', 'account', 'skills', 'status', 'serve', 'agent-context'
] as const
const SCOPE_ROW_IDS: Record<string, true> = {
  'project-remote-hosts': true,
  'agent-native-chat': true,
  'account-newer-providers': true,
  'skills-catalog-extras': true,
  'file-open-render': true,
  'worktree-ps-summary': true
}
const DISPOSITIONS: Record<CliDisposition, true> = {
  covered: true,
  'mapped-only': true,
  gap: true,
  excluded: true,
  delegated: true
}
const CAPTURE_PATH = resolve(import.meta.dir, 'cli-orca.json')
const TABLE_PATH = resolve(import.meta.dir, '../../docs/parity/orca-cli.md')

function fail(code: CliTableErrorCode, message: string): never {
  throw new CliTableError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function stringArrayArray(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(stringArray)
}

function parseInventory(value: unknown): CliInventory {
  if (!isRecord(value) || typeof value.capturedAt !== 'string' || !Array.isArray(value.discoveryCommands) ||
    !stringArray(value.discoveryCommands) || (value.preflightCommands !== undefined && !stringArray(value.preflightCommands)) ||
    typeof value.sourceSchemaVersion !== 'number' || typeof value.observedCommandCount !== 'number' ||
    !stringArray(value.rootWords) || !Array.isArray(value.rootAssignments) || !Array.isArray(value.commands)) {
    return fail('invalid-capture', 'capture is missing inventory metadata')
  }
  const rootAssignments = value.rootAssignments.map((entry, index): CliInventory['rootAssignments'][number] => {
    if (!isRecord(entry) || typeof entry.root !== 'string' || (entry.owner !== 'g10-1' && entry.owner !== 'g12-1')) {
      return fail('invalid-capture', `root assignment ${index} is invalid`)
    }
    return { root: entry.root, owner: entry.owner }
  })
  const commands = value.commands.map((entry, index): CliInventoryCommand => {
    if (!isRecord(entry) || typeof entry.command !== 'string' || !stringArray(entry.path) ||
      !stringArrayArray(entry.aliases) || typeof entry.argumentMode !== 'string' || typeof entry.summary !== 'string' ||
      typeof entry.usage !== 'string' || !stringArray(entry.flags) || !Array.isArray(entry.positionalArgs) ||
      !stringArray(entry.examples) || !stringArray(entry.notes)) {
      return fail('invalid-capture', `command ${index} is missing its complete Orca record`)
    }
    return entry as CliInventoryCommand
  })
  return {
    capturedAt: value.capturedAt,
    discoveryCommands: value.discoveryCommands,
    preflightCommands: stringArray(value.preflightCommands) ? value.preflightCommands : [],
    sourceSchemaVersion: value.sourceSchemaVersion,
    observedCommandCount: value.observedCommandCount,
    rootWords: value.rootWords,
    rootAssignments,
    commands
  }
}

export function loadCliInventory(): CliInventory {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(CAPTURE_PATH, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail('invalid-capture', detail)
  }
  return parseInventory(value)
}

function splitTableRow(line: string): string[] | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return undefined
  return trimmed.slice(1, -1).split('|').map((cell) => cell.trim())
}

function parseCheckCell(cell: string, rowId: string): string[] {
  if (cell === 'none') return []
  if (!cell.startsWith('check:')) return fail('missing-check', `row ${rowId} must use check:<id,...> or none`)
  const acceptance = '; `bun test scripts/parity/cli.test.ts`'
  if (!cell.endsWith(acceptance)) return fail('missing-check', `row ${rowId} must name its subprocess acceptance command`)
  const checks = cell.slice('check:'.length, -acceptance.length).split(',').map((check) => check.trim())
  if (checks.length === 0 || checks.some((check) => check.length === 0) || new Set(checks).size !== checks.length) {
    return fail('missing-check', `row ${rowId} has an empty or duplicate check reference`)
  }
  return checks
}

export function parseCliTable(source: string): CliTableRow[] {
  const lines = source.split(/\r?\n/)
  const header = lines.findIndex((line) => line.trim() === TABLE_HEADER)
  if (header < 0) return fail('invalid-table', 'missing the five-column command inventory header')

  const rows: CliTableRow[] = []
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) {
      if (rows.length > 0) break
      continue
    }
    const cells = splitTableRow(line)
    if (!cells) break
    if (cells.length !== 5) return fail('invalid-table', `row ${index + 1} must have five cells`)
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue

    const [id, provenance, equivalent, checkCell, dispositionCell] = cells
    if (!/^[a-z0-9-]+$/.test(id)) return fail('invalid-table', `row ${index + 1} has an invalid ID`)
    const commandMatch = /^orca: `([^`]+)`(?: — .+)?$/.exec(provenance)
    const delegatedRootMatch = /^scope: delegated-root `([^`]+)`$/.exec(provenance)
    const scopeMatch = /^scope: ([a-z0-9-]+)$/.exec(provenance)
    if (!commandMatch && !delegatedRootMatch && !scopeMatch) return fail('invalid-table', `row ${id} needs Orca, scope or delegated-root provenance`)

    const separator = dispositionCell.indexOf(':')
    const disposition = separator < 0 ? undefined : dispositionCell.slice(0, separator).trim() as CliDisposition
    if (!disposition || DISPOSITIONS[disposition] !== true) return fail('invalid-table', `row ${id} has an unknown disposition`)
    const reason = separator < 0 ? '' : dispositionCell.slice(separator + 1).trim()
    const followUp = /(?:^|\s)Follow-up:\s*([^.;]+?)(?:\.|;|$)/i.exec(reason)?.[1]?.trim()
    const missingBehavior = disposition === 'gap'
      ? reason.split(/\s+Follow-up:/i)[0].trim()
      : undefined
    const row: CliTableRow = {
      id,
      provenance,
      equivalent,
      checks: parseCheckCell(checkCell, id),
      disposition,
      reason,
      ...(commandMatch ? { command: commandMatch[1] } : {}),
      ...(delegatedRootMatch ? { root: delegatedRootMatch[1] } : {}),
      ...(followUp ? { followUp } : {}),
      ...(missingBehavior !== undefined ? { missingBehavior } : {})
    }
    rows.push(row)
  }
  return rows
}

export function loadCliTable(): CliTableRow[] {
  try {
    return parseCliTable(readFileSync(TABLE_PATH, 'utf8'))
  } catch (error) {
    if (error instanceof CliTableError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    return fail('invalid-table', detail)
  }
}


function expectedRowIdsForCommand(command: string): string {
  return command.replaceAll(' ', '-')
}

function validateEquivalentClaims(row: CliTableRow): void {
  if (!row.command || row.disposition === 'excluded') return
  const declared = CLI_MAPPINGS.filter(mapping => mapping.rowId === row.id)
  for (const [, snippet] of row.equivalent.matchAll(/`([^`]+)`/g)) {
    if (snippet.startsWith('--')) continue
    const candidates = CLI_MAPPINGS.filter(mapping => snippet === mapping.words || snippet.startsWith(`${mapping.words} `))
    const longest = candidates.reduce((length, mapping) => Math.max(length, mapping.words.length), 0)
    const binding = declared.find(mapping => mapping.words.length === longest && candidates.includes(mapping))
    if (!binding) return fail('missing-catalog-ref', `${row.id} claims ${snippet} without a compiled catalog reference`)
    const argument = snippet.slice(binding.words.length).trim().split(/\s+/)[0]
    if ((binding.methodTarget && argument !== binding.methodTarget) ||
        (binding.uiCommand && argument.replace(/^command:/, '') !== binding.uiCommand.replace(/^command:/, '')) ||
        (argument && !argument.startsWith('--') && binding.positionals.length === 0)) {
      return fail('missing-catalog-ref', `${row.id} claims an undeclared target for ${binding.words}`)
    }
  }
}

export function validateInventory(
  inventoryInput: CliInventory,
  rows: CliTableRow[],
  registeredChecks: ReadonlySet<string>
): void {
  const inventory = parseInventory(inventoryInput)
  if (inventory.sourceSchemaVersion !== 1 || !Number.isInteger(inventory.observedCommandCount) ||
    inventory.observedCommandCount < inventory.commands.length || !inventory.discoveryCommands.includes('orca agent-context --json')) {
    return fail('invalid-capture', 'capture discovery metadata is inconsistent')
  }
  const rootWords = new Set(inventory.rootWords)
  if (rootWords.size !== inventory.rootWords.length) return fail('invalid-capture', 'rootWords contains duplicates')

  const requiredRoots = new Set<string>(MANDATORY_ROOTS)
  for (const root of MANDATORY_ROOTS) {
    if (!rootWords.has(root)) return fail('missing-group', `capture is missing required root ${root}`)
  }

  const capturedCommands = new Map<string, CliInventoryCommand>()
  for (const command of inventory.commands) {
    if (command.command.split(' ')[0] !== command.path[0] || command.path.join(' ') !== command.command) {
      return fail('invalid-capture', `command record ${command.command} has inconsistent words and path`)
    }
    if (!rootWords.has(command.path[0]) || !requiredRoots.has(command.path[0])) {
      return fail('invalid-capture', `command ${command.command} is outside the required captured roots`)
    }
    if (capturedCommands.has(command.command)) return fail('invalid-capture', `capture repeats command ${command.command}`)
    capturedCommands.set(command.command, command)
  }
  for (const root of MANDATORY_ROOTS) {
    if (!inventory.commands.some((command) => command.path[0] === root)) {
      return fail('missing-group', `capture has no command records for root ${root}`)
    }
  }

  const assignments = new Map<string, CliRootOwner>()
  for (const assignment of inventory.rootAssignments) {
    if (assignments.has(assignment.root) || !rootWords.has(assignment.root) || requiredRoots.has(assignment.root)) {
      return fail('unassigned-root', `root ${assignment.root} is assigned more than once or is not delegable`)
    }
    assignments.set(assignment.root, assignment.owner)
  }
  for (const root of rootWords) {
    if (requiredRoots.has(root)) continue
    if (!assignments.has(root)) return fail('unassigned-root', `captured root ${root} has no goal assignment`)
  }
  for (const root of assignments.keys()) {
    if (!rootWords.has(root)) return fail('unassigned-root', `assigned root ${root} is absent from rootWords`)
  }

  const byId = new Map<string, CliTableRow>()
  const byCommand = new Map<string, CliTableRow>()
  const delegatedRows = new Map<string, CliTableRow>()
  const declaredChecks = new Set<string>()
  for (const row of rows) {
    if (byId.has(row.id)) return fail('duplicate-row', `duplicate table row ID ${row.id}`)
    byId.set(row.id, row)
    if (!row.reason.trim()) return fail('missing-reason', `row ${row.id} has no disposition reason`)

    if (row.command !== undefined) {
      if (!capturedCommands.has(row.command)) return fail('unknown-row', `row ${row.id} names uncaptured command ${row.command}`)
      if (byCommand.has(row.command)) return fail('duplicate-row', `command ${row.command} has multiple table rows`)
      if (row.id !== expectedRowIdsForCommand(row.command)) return fail('unknown-row', `row ${row.id} does not match command ${row.command}`)
      byCommand.set(row.command, row)
    } else if (row.root !== undefined) {
      if (row.id !== `delegated-root-${row.root}` || row.disposition !== 'delegated' || !assignments.has(row.root) ||
        !row.equivalent.includes(assignments.get(row.root)!)) {
        return fail('unknown-row', `delegation row ${row.id} does not match an assigned capture root`)
      }
      if (delegatedRows.has(row.root)) return fail('duplicate-row', `root ${row.root} has multiple delegation rows`)
      delegatedRows.set(row.root, row)
    } else if (SCOPE_ROW_IDS[row.id] !== true) {
      return fail('unknown-row', `row ${row.id} is not a declared command, scope or delegation row`)
    }

    if (row.disposition === 'covered') {
      if (row.checks.length === 0) return fail('missing-check', `covered row ${row.id} has no behavioral check`)
    } else if (row.checks.length !== 0) {
      return fail('missing-check', `${row.disposition} row ${row.id} cannot claim behavioral checks`)
    }
    for (const check of row.checks) {
      if (!registeredChecks.has(check)) return fail('missing-check', `table check ${check} is absent from the executable registry`)
      declaredChecks.add(check)
    }
    if (row.disposition === 'mapped-only' && !row.followUp) {
      return fail('missing-follow-up', `mapped-only row ${row.id} needs a named exercise follow-up`)
    }
    if (row.disposition === 'gap' && (!row.missingBehavior || !row.followUp)) {
      return fail('missing-follow-up', `gap row ${row.id} needs missing behavior and a named follow-up`)
    }
    if (row.disposition === 'excluded' && !/(?:BRIEF\.md|Decisions\s+\d|capture|captured)/i.test(row.reason)) {
      return fail('missing-reason', `excluded row ${row.id} must cite its scope source`)
    }
    if (row.disposition === 'mapped-only' && !CLI_MAPPINGS.some((mapping) => mapping.rowId === row.id)) {
      return fail('missing-catalog-ref', `mapped-only row ${row.id} has no compiled catalog mapping`)
    }
    if (row.command && row.disposition === 'covered' && !CLI_MAPPINGS.some((mapping) => mapping.rowId === row.id)) {
      return fail('missing-catalog-ref', `covered row ${row.id} has no compiled catalog mapping`)
    }
    validateEquivalentClaims(row)
  }

  for (const command of capturedCommands.keys()) {
    if (!byCommand.has(command)) return fail('missing-command', `captured command ${command} has no table row`)
  }
  for (const command of byCommand.keys()) {
    if (!requiredRoots.has(command.split(' ')[0])) return fail('unknown-row', `command ${command} is outside the required roots`)
  }
  for (const root of assignments.keys()) {
    if (!delegatedRows.has(root)) return fail('unassigned-root', `captured root ${root} has no delegated table row`)
  }
  for (const root of delegatedRows.keys()) {
    if (!assignments.has(root)) return fail('unassigned-root', `delegation row for ${root} has no capture assignment`)
  }
  for (const scopeId of Object.keys(SCOPE_ROW_IDS)) {
    if (!byId.has(scopeId)) return fail('missing-command', `required subordinate scope row ${scopeId} is missing`)
  }
  for (const check of registeredChecks) {
    if (!declaredChecks.has(check)) return fail('missing-check', `registry check ${check} has no table row`)
  }
}


const pluginReferences: Array<{ rowId: string; plugin: string; commandId: string }> = [
  { rowId: 'account-add', plugin: 'quirky.accounts', commandId: 'add' },
  { rowId: 'account-add', plugin: 'quirky.accounts', commandId: 'login-status' },
  { rowId: 'account-list', plugin: 'quirky.accounts', commandId: 'list' },
  { rowId: 'account-rm', plugin: 'quirky.accounts', commandId: 'remove' },
  { rowId: 'agent-hooks-off', plugin: 'quirky.agent-status', commandId: 'hooks-remove' },
  { rowId: 'agent-hooks-on', plugin: 'quirky.agent-status', commandId: 'hooks-setup' },
  { rowId: 'agent-hooks-status', plugin: 'quirky.agent-status', commandId: 'hooks-status' },
  { rowId: 'agent-launch', plugin: 'quirky.session', commandId: 'new' },
  { rowId: 'agent-launch', plugin: 'quirky.session', commandId: 'get' },
  { rowId: 'agent-launch', plugin: 'quirky.session', commandId: 'close' },
  { rowId: 'ask', plugin: 'quirky.ask', commandId: 'ask' },
  { rowId: 'ask-cancel', plugin: 'quirky.ask', commandId: 'cancel' },
  { rowId: 'ask-wait', plugin: 'quirky.ask', commandId: 'wait' },
  ...['create', 'edit', 'list', 'remove', 'run', 'runs', 'show'].map((commandId) => ({ rowId: `automations-${commandId}`, plugin: 'quirky.automations', commandId })),
  { rowId: 'file-open', plugin: 'quirky.editor', commandId: 'open' },
  { rowId: 'file-open', plugin: 'quirky.editor', commandId: 'state' },
  { rowId: 'file-open', plugin: 'quirky.editor', commandId: 'read' },
  { rowId: 'file-open', plugin: 'quirky.editor', commandId: 'close' },
  { rowId: 'file-open-render', plugin: 'quirky.editor', commandId: 'open' },
  { rowId: 'file-open-render', plugin: 'quirky.editor', commandId: 'state' },
  { rowId: 'file-open-render', plugin: 'quirky.editor', commandId: 'read' },
  ...['create', 'edit', 'list', 'pause', 'resume', 'show', 'steer', 'stop'].map((commandId) => ({ rowId: `loop-${commandId}`, plugin: 'quirky.loops', commandId })),
  { rowId: 'orchestration-ask', plugin: 'quirky.orchestration', commandId: 'ask' },
  { rowId: 'orchestration-check', plugin: 'quirky.orchestration', commandId: 'check' },
  { rowId: 'orchestration-dispatch', plugin: 'quirky.orchestration', commandId: 'dispatch' },
  { rowId: 'orchestration-dispatch-show', plugin: 'quirky.orchestration', commandId: 'dispatch-show' },
  { rowId: 'orchestration-gate-create', plugin: 'quirky.orchestration', commandId: 'gate-create' },
  { rowId: 'orchestration-gate-list', plugin: 'quirky.orchestration', commandId: 'gate-list' },
  { rowId: 'orchestration-gate-resolve', plugin: 'quirky.orchestration', commandId: 'gate-resolve' },
  { rowId: 'orchestration-inbox', plugin: 'quirky.orchestration', commandId: 'inbox' },
  { rowId: 'orchestration-reply', plugin: 'quirky.orchestration', commandId: 'reply' },
  { rowId: 'orchestration-request-show', plugin: 'quirky.orchestration', commandId: 'request-show' },
  { rowId: 'orchestration-reset', plugin: 'quirky.orchestration', commandId: 'reset' },
  { rowId: 'orchestration-run-create', plugin: 'quirky.orchestration', commandId: 'run-create' },
  { rowId: 'orchestration-run-current', plugin: 'quirky.orchestration', commandId: 'run-current' },
  { rowId: 'orchestration-run-list', plugin: 'quirky.orchestration', commandId: 'run-list' },
  { rowId: 'orchestration-run-show', plugin: 'quirky.orchestration', commandId: 'run-show' },
  { rowId: 'orchestration-run-use', plugin: 'quirky.orchestration', commandId: 'run-use' },
  { rowId: 'orchestration-send', plugin: 'quirky.orchestration', commandId: 'send' },
  { rowId: 'orchestration-task-create', plugin: 'quirky.orchestration', commandId: 'task-create' },
  { rowId: 'orchestration-task-list', plugin: 'quirky.orchestration', commandId: 'task-list' },
  { rowId: 'orchestration-task-update', plugin: 'quirky.orchestration', commandId: 'task-update' },
  ...['worker-abandon', 'worker-list', 'worker-read', 'worker-release', 'worker-retain', 'worker-show', 'worker-start', 'worker-stop'].map((commandId) => ({ rowId: `orchestration-${commandId}`, plugin: 'quirky.orchestration', commandId })),
  { rowId: 'project-list', plugin: 'quirky.repo', commandId: 'list' },
  { rowId: 'project-setup-clone', plugin: 'quirky.repo', commandId: 'clone' },
  { rowId: 'project-setup-create', plugin: 'quirky.repo', commandId: 'create' },
  { rowId: 'project-setup-create', plugin: 'quirky.repo', commandId: 'add' },
  { rowId: 'project-setup-delete', plugin: 'quirky.repo', commandId: 'rm' },
  { rowId: 'project-setup-existing-folder', plugin: 'quirky.repo', commandId: 'add' },
  { rowId: 'project-setup-update', plugin: 'quirky.repo', commandId: 'set' },
  { rowId: 'project-setups', plugin: 'quirky.repo', commandId: 'list' },
  { rowId: 'repo-add', plugin: 'quirky.repo', commandId: 'add' },
  { rowId: 'repo-list', plugin: 'quirky.repo', commandId: 'list' },
  { rowId: 'repo-set', plugin: 'quirky.repo', commandId: 'set' },
  { rowId: 'repo-set-base-ref', plugin: 'quirky.repo', commandId: 'set' },
  { rowId: 'repo-show', plugin: 'quirky.repo', commandId: 'show' },
  { rowId: 'repo-search-refs', plugin: 'quirky.repo', commandId: 'search-refs' },
  { rowId: 'terminal-close', plugin: 'quirky.terminal', commandId: 'tab-close' },
  { rowId: 'terminal-create', plugin: 'quirky.terminal', commandId: 'tab-new' },
  { rowId: 'terminal-create', plugin: 'quirky.terminal', commandId: 'layout' },
  { rowId: 'terminal-list', plugin: 'quirky.terminal', commandId: 'sessions' },
  { rowId: 'terminal-read', plugin: 'quirky.terminal', commandId: 'read' },
  { rowId: 'terminal-rename', plugin: 'quirky.terminal', commandId: 'tab-rename' },
  { rowId: 'terminal-send', plugin: 'quirky.terminal', commandId: 'send' },
  { rowId: 'terminal-set-pane-title', plugin: 'quirky.terminal', commandId: 'pane-title' },
  { rowId: 'terminal-show', plugin: 'quirky.terminal', commandId: 'pane-get' },
  { rowId: 'terminal-show', plugin: 'quirky.terminal', commandId: 'read' },
  { rowId: 'terminal-split', plugin: 'quirky.terminal', commandId: 'pane-split' },
  { rowId: 'terminal-switch', plugin: 'quirky.terminal', commandId: 'tab-activate' },
  { rowId: 'terminal-wait', plugin: 'quirky.agent-status', commandId: 'wait' },
  { rowId: 'worktree-create', plugin: 'quirky.worktree', commandId: 'create' },
  { rowId: 'worktree-current', plugin: 'quirky.worktree', commandId: 'show' },
  { rowId: 'worktree-list', plugin: 'quirky.worktree', commandId: 'list' },
  { rowId: 'worktree-ps', plugin: 'quirky.agent-status', commandId: 'dashboard' },
  { rowId: 'worktree-ps', plugin: 'quirky.orchestration', commandId: 'run-list' },
  { rowId: 'worktree-ps', plugin: 'quirky.orchestration', commandId: 'task-list' },
  { rowId: 'worktree-ps', plugin: 'quirky.orchestration', commandId: 'worker-list' },
  { rowId: 'worktree-rm', plugin: 'quirky.worktree', commandId: 'rm' },
  { rowId: 'worktree-set', plugin: 'quirky.worktree', commandId: 'set' },
  { rowId: 'worktree-show', plugin: 'quirky.worktree', commandId: 'show' }
]

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function fullMethodName(plugin: string, name: string): string {
  return name.includes('/') ? name : `${plugin}/${name}`
}

function manifestFlag(name: string, value: unknown): ApiCliFlag {
  const types = ['string', 'integer', 'number', 'boolean', 'json']
  if (!isRecord(value) || typeof value.type !== 'string' || !types.includes(value.type) || typeof value.description !== 'string') {
    return fail('invalid-mapping', `manifest flag ${name} lacks a valid type or description`)
  }
  return {
    name,
    type: value.type as ApiCliFlag['type'],
    description: value.description,
    required: value.required === true,
    repeatable: value.repeatable === true,
    ...(Array.isArray(value.enum) ? { enum: value.enum as (string | number)[] } : {}),
    param: typeof value.param === 'string' ? value.param : name.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())
  }
}

function generatedFlags(manifest: Record<string, unknown>, method: string, positionals: ApiCliPositional[]): ApiCliFlag[] {
  const contributions = isRecord(manifest.contributes) ? manifest.contributes : {}
  const methodEntries = arrayRecords(contributions.method)
  const methodName = method.split('/').at(-1)
  const declaration = methodEntries.find((entry) => entry.id === methodName)
  const params = declaration && isRecord(declaration.params) ? declaration.params : undefined
  const properties = params && isRecord(params.properties) ? params.properties : {}
  const required = params && Array.isArray(params.required) ? params.required : []
  const taken = new Set(positionals.map((positional) => positional.param))
  const reserved = new Set<string>(RESERVED_FLAG_NAMES)
  const scalarTypes = ['string', 'integer', 'number', 'boolean']
  const flags: ApiCliFlag[] = []
  for (const [property, rawSchema] of Object.entries(properties)) {
    if (taken.has(property) || !isRecord(rawSchema)) continue
    const name = flagNameOf(property)
    if (reserved.has(name)) continue
    const schema = rawSchema
    const items = isRecord(schema.items) ? schema.items : undefined
    const repeatable = schema.type === 'array' && items !== undefined && typeof items.type === 'string' && scalarTypes.includes(items.type)
    const type = typeof schema.type === 'string' && scalarTypes.includes(schema.type)
      ? schema.type
      : repeatable && items
        ? items.type
        : 'json'
    const enumValues = schema.type === 'array' ? items?.enum : schema.enum
    flags.push({
      name,
      type: type as ApiCliFlag['type'],
      description: typeof schema.description === 'string' ? schema.description : '',
      required: required.includes(property),
      repeatable,
      ...(Array.isArray(enumValues) ? { enum: enumValues as (string | number)[] } : {}),
      param: property
    })
  }
  return flags
}

const pluginManifestCache = new Map<string, Record<string, unknown>>()

function loadPluginManifest(plugin: string): Record<string, unknown> {
  const cached = pluginManifestCache.get(plugin)
  if (cached) return cached
  const manifestPath = resolve(import.meta.dir, '../../plugins', plugin, 'quirky-plugin.json')
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return fail('invalid-mapping', `cannot read ${plugin} CLI manifest: ${detail}`)
  }
  if (!isRecord(manifest)) return fail('invalid-mapping', `manifest ${plugin} is not an object`)
  pluginManifestCache.set(plugin, manifest)
  return manifest
}

function compilePluginMapping(reference: { rowId: string; plugin: string; commandId: string }): CliCatalogMapping {
  const manifest = loadPluginManifest(reference.plugin)
  const contributes = isRecord(manifest.contributes) ? manifest.contributes : {}
  const commands = arrayRecords(contributes['cli-command'])
  const declaration = commands.find((entry) => entry.id === reference.commandId)
  if (!declaration) return fail('invalid-mapping', `missing ${reference.plugin} CLI contribution ${reference.commandId}`)
  const group = reference.plugin.startsWith('quirky.') ? reference.plugin.slice('quirky.'.length) : reference.plugin
  const suffix = typeof declaration.words === 'string' ? declaration.words : reference.commandId
  const primaryWords = suffix === '' ? group : `${group} ${suffix}`
  const positionalSpecs = Array.isArray(declaration.positionals) ? declaration.positionals : []
  const positionals: ApiCliPositional[] = positionalSpecs.map((raw) => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.description !== 'string') {
      return fail('invalid-mapping', `invalid positional in ${reference.plugin} ${reference.commandId}`)
    }
    return {
      name: raw.name,
      description: raw.description,
      required: raw.required === true,
      param: typeof raw.param === 'string' ? raw.param : raw.name
    }
  })
  const method = typeof declaration.method === 'string' ? fullMethodName(reference.plugin, declaration.method) : null
  const methods = Array.isArray(declaration.methods)
    ? declaration.methods.filter((entry): entry is string => typeof entry === 'string')
    : method === null ? [] : [method]
  const flags = isRecord(declaration.flags)
    ? Object.entries(declaration.flags).map(([name, value]) => manifestFlag(name, value))
    : method === null ? [] : generatedFlags(manifest, method, positionals)
  const aliases = stringArray(manifest.cliAliases) ? manifest.cliAliases : []
  return {
    rowId: reference.rowId,
    kind: 'plugin',
    words: primaryWords,
    primaryWords,
    plugin: reference.plugin,
    commandId: `cli-command:${reference.plugin}/${reference.commandId}`,
    groupAliases: [...aliases],
    method,
    methods,
    flags,
    positionals
  }
}

function flagBinding(name: string, type: ApiCliFlag['type'], description: string, required = false): ApiCliFlag {
  return { name, type, description, required, repeatable: false, param: name }
}

function positionalBinding(name: string, description: string, required = false): ApiCliPositional {
  return { name, description, required, param: name }
}

function kernelMapping(
  rowId: string,
  words: string,
  methods: string[],
  flags: ApiCliFlag[] = [],
  positionals: ApiCliPositional[] = [],
  details: { kind?: 'kernel' | 'api-call' | 'ui-run'; methodTarget?: string; uiCommand?: string } = {}
): CliCatalogMapping {
  return {
    rowId,
    kind: details.kind ?? 'kernel',
    words,
    primaryWords: words,
    groupAliases: [],
    method: null,
    methods,
    flags,
    positionals,
    ...(details.methodTarget ? { methodTarget: details.methodTarget } : {}),
    ...(details.uiCommand ? { uiCommand: details.uiCommand } : {})
  }
}

const KERNEL_MAPPINGS: CliCatalogMapping[] = [
  kernelMapping('agent-context', 'api', ['api.describe']),
  kernelMapping('file-diff', 'ui run', ['ui.command.run'], [
    flagBinding('args', 'json', 'the command arguments, as JSON')
  ], [positionalBinding('command', 'the command contribution ID', true)], {
    kind: 'ui-run', uiCommand: 'command:quirky.git/open-diff'
  }),
  kernelMapping('file-open-changed', 'ui run', ['ui.command.run'], [
    flagBinding('args', 'json', 'the command arguments, as JSON')
  ], [positionalBinding('command', 'the command contribution ID', true)], {
    kind: 'ui-run', uiCommand: 'command:quirky.git/open-changes'
  }),
  kernelMapping('skills-get', 'skill show', ['api.describe']),
  kernelMapping('skills-install', 'skill install', ['api.describe'], [
    flagBinding('dir', 'string', 'the skills folder; the skill goes in <dir>/quirky/SKILL.md', true)
  ]),
  kernelMapping('skills-install', 'skill status', ['api.describe'], [
    flagBinding('dir', 'string', 'the skills folder; the skill goes in <dir>/quirky/SKILL.md', true)
  ]),
  kernelMapping('skills-update', 'skill install', ['api.describe'], [
    flagBinding('dir', 'string', 'the skills folder; the skill goes in <dir>/quirky/SKILL.md', true)
  ]),
  kernelMapping('skills-update', 'skill status', ['api.describe'], [
    flagBinding('dir', 'string', 'the skills folder; the skill goes in <dir>/quirky/SKILL.md', true)
  ]),
  kernelMapping('status', 'status', ['status.get']),
  kernelMapping('serve', 'serve', ['status.get'], [
    flagBinding('port', 'integer', 'listen on this loopback port; refuse to start when it is in use'),
    flagBinding('disable-plugins', 'boolean', 'safe mode: installed plugins, stored disables and the distro layer are off for this run')
  ])
]

export const CLI_MAPPINGS: readonly CliCatalogMapping[] = [
  ...pluginReferences.map(compilePluginMapping),
  ...KERNEL_MAPPINGS
]


function recordArray(value: unknown): Array<Record<string, unknown>> | undefined {
  return Array.isArray(value) && value.every(isRecord) ? value : undefined
}

function stringsFrom(value: unknown): string[] | undefined {
  return stringArray(value) ? value : undefined
}

function equalStringArrays(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index])
}

function compareMethods(actual: unknown, expected: string[], label: string): void {
  const actualMethods = stringsFrom(actual)
  if (!actualMethods || !equalStringArrays(actualMethods, expected)) {
    return fail('invalid-command-binding', `${label} method binding does not match its declaration`)
  }
}

function compareFlags(actual: unknown, expected: ApiCliFlag[], label: string, includeParam: boolean): void {
  const flags = recordArray(actual)
  if (!flags) return fail('invalid-flag-schema', `${label} flags are not described`)
  const expectedNames = expected.map((flag) => flag.name)
  const actualNames = flags.map((flag) => flag.name).filter((name): name is string => typeof name === 'string')
  for (const name of expectedNames) {
    if (!actualNames.includes(name)) return fail('missing-flag', `${label} is missing --${name}`)
  }
  for (const name of actualNames) {
    if (!expectedNames.includes(name)) return fail('unexpected-flag', `${label} declares unexpected --${name}`)
  }
  for (const expectedFlag of expected) {
    const actualFlag = flags.find((flag) => flag.name === expectedFlag.name)!
    if (typeof actualFlag.description !== 'string' ||
      actualFlag.type !== expectedFlag.type || actualFlag.description !== expectedFlag.description ||
      actualFlag.required !== expectedFlag.required || actualFlag.repeatable !== expectedFlag.repeatable ||
      (includeParam && actualFlag.param !== expectedFlag.param) ||
      JSON.stringify(actualFlag.enum ?? null) !== JSON.stringify(expectedFlag.enum ?? null)) {
      return fail('invalid-flag-schema', `${label} --${expectedFlag.name} metadata differs from its source declaration`)
    }
  }
}

function comparePositionals(actual: unknown, expected: ApiCliPositional[], label: string, includeParam: boolean): void {
  const positionals = recordArray(actual)
  if (!positionals) return fail('invalid-positional-schema', `${label} positionals are not described`)
  const actualNames = positionals.map((entry) => entry.name).filter((name): name is string => typeof name === 'string')
  const expectedNames = expected.map((entry) => entry.name)
  for (const name of expectedNames) {
    if (!actualNames.includes(name)) return fail('missing-positional', `${label} is missing <${name}>`)
  }
  for (const name of actualNames) {
    if (!expectedNames.includes(name)) return fail('unexpected-positional', `${label} declares unexpected <${name}>`)
  }
  for (const expectedPositional of expected) {
    const actualPositional = positionals.find((entry) => entry.name === expectedPositional.name)!
    if (typeof actualPositional.description !== 'string' ||
      actualPositional.description !== expectedPositional.description || actualPositional.required !== expectedPositional.required ||
      (includeParam && actualPositional.param !== expectedPositional.param)) {
      return fail('invalid-positional-schema', `${label} <${expectedPositional.name}> metadata differs from its source declaration`)
    }
  }
}

function resolvePluginCommand(catalog: ApiCatalog, mapping: CliCatalogMapping): ApiCliCommandEntry {
  const candidates = catalog.cli.commands.filter((entry) => entry.plugin === mapping.plugin && entry.id === mapping.commandId)
  const entry = candidates.find((candidate) => candidate.words === mapping.words || candidate.aliasWords.includes(mapping.words))
  if (!entry) return fail('missing-cli-command', `${mapping.words} is absent from cli.commands`)
  if (entry.words !== mapping.primaryWords) {
    return fail('invalid-command-binding', `${mapping.words} resolves to ${entry.words}, expected ${mapping.primaryWords}`)
  }
  const group = catalog.cli.groups.find((candidate) => candidate.plugin === mapping.plugin)
  if (!group || group.words !== mapping.primaryWords.split(' ')[0]) {
    return fail('invalid-command-binding', `${mapping.plugin} does not own ${mapping.primaryWords.split(' ')[0]}`)
  }
  for (const alias of mapping.groupAliases) {
    if (!group.aliases.includes(alias)) return fail('invalid-command-binding', `${mapping.plugin} lost declared group alias ${alias}`)
  }
  if (entry.aliasWords.length !== mapping.groupAliases.length || entry.aliasWords.some((aliasWord, index) => {
    const suffix = mapping.primaryWords.slice(group.words.length)
    return aliasWord !== `${mapping.groupAliases[index]}${suffix}`
  })) {
    return fail('invalid-command-binding', `${mapping.primaryWords} has incorrect group alias words`)
  }
  if (entry.method !== mapping.method) return fail('invalid-command-binding', `${mapping.primaryWords} has a different generic method binding`)
  compareMethods(entry.methods, mapping.methods, mapping.primaryWords)
  compareFlags(entry.flags, mapping.flags, mapping.primaryWords, true)
  comparePositionals(entry.positionals, mapping.positionals, mapping.primaryWords, true)
  return entry
}

function verifyMethod(catalog: ApiCatalog, methodName: string): ApiMethodEntry {
  const method = catalog.methods.find((entry) => entry.name === methodName)
  if (!method) return fail('missing-method', `catalog has no method ${methodName}`)
  if (!isRecord(method.params) || !isRecord(method.result)) {
    return fail('invalid-method-schema', `${methodName} is missing parameter or result schema`)
  }
  return method
}

function verifyUiCommand(catalog: ApiCatalog, commandId: string): ApiUiCommandEntry {
  const command = catalog.uiCommands.find((entry) => entry.id === commandId)
  if (!command) return fail('missing-ui-command', `catalog has no UI command ${commandId}`)
  if (command.plugin !== commandId.slice('command:'.length).split('/')[0] || !isRecord(command.args)) {
    return fail('invalid-ui-command', `UI command ${commandId} has no matching plugin or argument schema`)
  }
  const args = command.args as Record<string, unknown>
  if (isRecord(args.properties)) {
    for (const [name, raw] of Object.entries(args.properties)) {
      if (!isRecord(raw) || typeof raw.description !== 'string' || raw.description.length === 0) {
        return fail('invalid-ui-command', `${commandId} argument ${name} has no description`)
      }
    }
  }
  return command
}

function verifyKernelCommand(catalog: ApiCatalog, mapping: CliCatalogMapping): ApiCommandEntry {
  const entry = catalog.commands.find((candidate) => candidate.command === mapping.words)
  if (!entry) return fail('missing-command', `catalog has no command ${mapping.words}`)
  if (entry.shadowedBy) return fail('shadowed-command', `${mapping.words} is shadowed by ${entry.shadowedBy}`)
  if (entry.plugin !== null) return fail('invalid-command-binding', `${mapping.words} is not a kernel command`)
  compareMethods(entry.methods, mapping.methods, mapping.words)
  compareFlags(entry.flags, mapping.flags, mapping.words, false)
  comparePositionals(entry.positionals, mapping.positionals, mapping.words, false)
  return entry
}

function validateCatalogChecked(
  catalogInput: unknown,
  rows: CliTableRow[],
  mappings: readonly CliCatalogMapping[] = CLI_MAPPINGS
): CliCatalogRowRefs[] {
  if (!isRecord(catalogInput) || catalogInput.schemaVersion !== 2 || !Array.isArray(catalogInput.methods) ||
    !Array.isArray(catalogInput.uiCommands) || !isRecord(catalogInput.cli) || !Array.isArray(catalogInput.cli.commands) ||
    !Array.isArray(catalogInput.cli.groups) || !Array.isArray(catalogInput.commands)) {
    return fail('invalid-catalog', 'expected schemaVersion 2 with methods, commands, cli and uiCommands')
  }
  const catalog = catalogInput as unknown as ApiCatalog
  const rowsById = new Map(rows.map((row) => [row.id, row]))
  const refsByRow = new Map<string, string[]>()
  for (const row of rows) refsByRow.set(row.id, [])

  for (const mapping of mappings) {
    const row = rowsById.get(mapping.rowId)
    if (!row || row.disposition === 'excluded' || row.disposition === 'delegated') {
      return fail('invalid-mapping', `compiled catalog ref ${mapping.rowId} has no eligible table row`)
    }
    if (mapping.kind === 'plugin') {
      const entry = resolvePluginCommand(catalog, mapping)
      const publicCommand = catalog.commands.find((candidate) => candidate.command === entry.words)
      if (!publicCommand) return fail('missing-command', `catalog has no active command ${entry.words}`)
      if (publicCommand.shadowedBy) return fail('shadowed-command', `${entry.words} is shadowed by ${publicCommand.shadowedBy}`)
      if (publicCommand.plugin !== mapping.plugin) return fail('invalid-command-binding', `${entry.words} is owned by ${String(publicCommand.plugin)}`)
      compareMethods(publicCommand.methods, mapping.methods, entry.words)
      compareFlags(publicCommand.flags, mapping.flags, entry.words, false)
      comparePositionals(publicCommand.positionals, mapping.positionals, entry.words, false)
    } else {
      verifyKernelCommand(catalog, mapping)
    }

    const refs = refsByRow.get(mapping.rowId)!
    refs.push(`command:${mapping.primaryWords}`)
    for (const method of mapping.methods) {
      verifyMethod(catalog, method)
      refs.push(`method:${method}`)
    }
    if (mapping.methodTarget) {
      verifyMethod(catalog, mapping.methodTarget)
      refs.push(`method:${mapping.methodTarget}`)
    }
    if (mapping.uiCommand) {
      verifyUiCommand(catalog, mapping.uiCommand)
      refs.push(`uiCommand:${mapping.uiCommand}`)
    }
  }

  for (const row of rows) {
    const refs = refsByRow.get(row.id) ?? []
    if ((row.disposition === 'covered' || row.disposition === 'mapped-only') && refs.length === 0) {
      return fail('missing-catalog-ref', `${row.disposition} row ${row.id} has no catalog mapping`)
    }
  }
  return rows.map((row) => ({ rowId: row.id, refs: [...new Set(refsByRow.get(row.id) ?? [])] }))
}

export function validateCatalog(
  catalogInput: unknown,
  rows: CliTableRow[],
  mappings: readonly CliCatalogMapping[] = CLI_MAPPINGS
): CliCatalogRowRefs[] {
  try {
    return validateCatalogChecked(catalogInput, rows, mappings)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CliTableError('catalog-mismatch', detail)
  }
}
