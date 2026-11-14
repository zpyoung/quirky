import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkIds } from './cli-checks'
import {
  CLI_MAPPINGS,
  CliTableError,
  loadCliInventory,
  loadCliTable,
  parseCliTable,
  validateCatalog,
  validateInventory,
  type CliCatalogMapping,
  type CliInventory,
  type CliTableRow
} from './cli-table'

type SyntheticCatalog = {
  schemaVersion: number
  methods: Array<{ name: string; plugin: string | null; params: Record<string, unknown>; result: Record<string, unknown> }>
  uiCommands: Array<{ id: string; plugin: string; title: string; args: Record<string, unknown> }>
  cli: {
    groups: Array<{ plugin: string; words: string; aliases: string[] }>
    commands: Array<Record<string, unknown>>
  }
  commands: Array<Record<string, unknown>>
}

function cloned<T>(value: T): T {
  return structuredClone(value)
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(CliTableError)
    return (error as CliTableError).code
  }
  throw new Error('expected validation to fail')
}

function registeredChecks(rows: CliTableRow[]): Set<string> {
  return new Set(rows.flatMap((row) => row.checks))
}

function syntheticCatalog(mappings: readonly CliCatalogMapping[] = CLI_MAPPINGS): SyntheticCatalog {
  const methods = new Map<string, SyntheticCatalog['methods'][number]>()
  const uiCommands = new Map<string, SyntheticCatalog['uiCommands'][number]>()
  const groups = new Map<string, SyntheticCatalog['cli']['groups'][number]>()
  const pluginCommands = new Map<string, Record<string, unknown>>()
  const commands = new Map<string, Record<string, unknown>>()

  const addMethod = (name: string, plugin: string | null): void => {
    if (!methods.has(name)) methods.set(name, { name, plugin, params: { type: 'object', properties: {} }, result: { type: 'object' } })
  }
  for (const mapping of mappings) {
    const plugin = mapping.plugin ?? null
    const words = mapping.words
    const groupWord = words.split(' ')[0]
    const flags = mapping.flags.map((flag) => ({ ...flag, param: flag.param ?? flag.name }))
    const positionals = mapping.positionals.map((positional) => ({ ...positional, param: positional.param ?? positional.name }))
    for (const method of mapping.methods) addMethod(method, method.startsWith('quirky.') ? method.split('/')[0] : null)
    if (mapping.methodTarget) addMethod(mapping.methodTarget, mapping.methodTarget.startsWith('quirky.') ? mapping.methodTarget.split('/')[0] : null)
    if (mapping.uiCommand) {
      const uiPlugin = mapping.uiCommand.split('/')[0].slice('command:'.length)
      uiCommands.set(mapping.uiCommand, { id: mapping.uiCommand, plugin: uiPlugin, title: mapping.uiCommand, args: { type: 'object' } })
    }
    if (mapping.kind === 'plugin') {
      if (!mapping.plugin) throw new Error('plugin catalog mapping is missing its plugin ID')
      const commandKey = `${mapping.plugin}:${mapping.commandId}`
      if (!groups.has(mapping.plugin)) groups.set(mapping.plugin, { plugin: mapping.plugin, words: groupWord, aliases: [...mapping.groupAliases] })
      if (!pluginCommands.has(commandKey)) {
        pluginCommands.set(commandKey, {
          id: mapping.commandId,
          plugin: mapping.plugin,
          apiVersion: '1.0.0',
          words,
          aliasWords: mapping.groupAliases.map((alias) => `${alias}${words.slice(groupWord.length)}`),
          summary: 'fixture command',
          positionals,
          flags,
          method: mapping.method,
          methods: [...mapping.methods],
          module: null
        })
      }
    }
    if (!commands.has(words)) {
      commands.set(words, {
        command: words,
        plugin,
        methods: [...mapping.methods],
        summary: 'fixture command',
        usage: words,
        positionals: positionals.map(({ name, description, required }) => ({ name, description, required })),
        flags: flags.map(({ name, type, description, required, repeatable, enum: values }) => ({ name, type, description, required, repeatable, ...(values ? { enum: values } : {}) }))
      })
    }
  }
  return {
    schemaVersion: 2,
    methods: [...methods.values()],
    uiCommands: [...uiCommands.values()],
    cli: { groups: [...groups.values()], commands: [...pluginCommands.values()] },
    commands: [...commands.values()]
  }
}

function validateRows(inventory: CliInventory, rows: CliTableRow[], checks: ReadonlySet<string> = checkIds): void {
  validateInventory(inventory, rows, checks)
}

const tablePath = resolve(import.meta.dir, '../../docs/parity/orca-cli.md')

test('the frozen inventory and human table cover all required commands and delegate every other root', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  expect(inventory.observedCommandCount).toBeGreaterThanOrEqual(inventory.commands.length)
  expect(inventory.rootWords.length).toBeGreaterThan(14)
  expect(rows.filter(row => row.command !== undefined).map(row => row.command).sort()).toEqual(inventory.commands.map(command => command.command).sort())
  expect(rows.filter((row) => row.command?.split(' ')[0] === 'loop').map((row) => row.command)).toContain('loop edit')
  expect(validateRows(inventory, rows)).toBeUndefined()
})

test('the table parser preserves command document order and parses multiple check references', () => {
  const source = readFileSync(tablePath, 'utf8')
  const rows = parseCliTable(source)
  expect(rows.map((row) => row.id)).toEqual(loadCliTable().map((row) => row.id))
  expect(rows.find((row) => row.id === 'agent-launch')?.checks).toEqual(['agent-launch', 'agent-get', 'agent-close'])
  expect(rows.find((row) => row.id === 'agent-context')?.checks).toEqual(['catalog'])
})

test('inventory validation rejects a missing captured command', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable().filter((row) => row.command !== 'loop edit')
  expect(codeOf(() => validateRows(inventory, rows))).toBe('missing-command')
})

test('inventory validation requires the compact worktree summary scope row', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable().filter((row) => row.id !== 'worktree-ps-summary')
  expect(codeOf(() => validateRows(inventory, rows))).toBe('missing-command')
})

test('inventory validation rejects a duplicate command row', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  const original = rows.find((row) => row.command === 'repo list')!
  rows.push({ ...original, id: 'repo-list-copy' })
  expect(codeOf(() => validateRows(inventory, rows))).toBe('duplicate-row')
})

test('inventory validation rejects a row with no disposition reason', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  rows.find((row) => row.command === 'serve')!.reason = ''
  expect(codeOf(() => validateRows(inventory, rows))).toBe('missing-reason')
})

test('inventory validation rejects a captured root without a delegation', () => {
  const inventory = cloned(loadCliInventory())
  inventory.rootAssignments.pop()
  expect(codeOf(() => validateRows(inventory, loadCliTable()))).toBe('unassigned-root')
})

test('inventory validation rejects a covered check absent from the executable registry', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  const checks = registeredChecks(rows)
  checks.delete('repo-add')
  expect(codeOf(() => validateRows(inventory, rows, checks))).toBe('missing-check')
})

test('inventory validation requires a follow-up for mapped-only rows', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  const row = rows.find((candidate) => candidate.id === 'orchestration-dispatch')!
  row.disposition = 'mapped-only'
  row.checks = []
  row.followUp = undefined
  expect(codeOf(() => validateRows(inventory, rows, registeredChecks(rows)))).toBe('missing-follow-up')
})

test('inventory validation rejects captured commands added without a table row', () => {
  const inventory = cloned(loadCliInventory())
  const command = cloned(inventory.commands.find((entry) => entry.command === 'repo list')!)
  command.command = 'repo synthetic'
  command.path = ['repo', 'synthetic']
  inventory.commands.push(command)
  inventory.observedCommandCount += 1
  expect(codeOf(() => validateRows(inventory, loadCliTable()))).toBe('missing-command')
})

test('catalog validation checks each compiled target and returns refs in table order', () => {
  const rows = loadCliTable()
  const checked = validateCatalog(syntheticCatalog(), rows)
  expect(checked.map((entry) => entry.rowId)).toEqual(rows.map((row) => row.id))
  expect(checked.find((entry) => entry.rowId === 'orchestration-dispatch')?.refs.length).toBeGreaterThan(0)
  expect(checked.find((entry) => entry.rowId === 'serve-service-install')?.refs).toEqual([])
  expect(checked.find((entry) => entry.rowId === 'serve')?.refs.length).toBeGreaterThan(0)
})

test('catalog validation rejects a missing serve command', () => {
  const catalog = syntheticCatalog()
  catalog.commands = catalog.commands.filter(command => command.command !== 'serve')
  expect(() => validateCatalog(catalog, loadCliTable())).toThrow('missing-command')
})

test('catalog validation rejects serve without its port flag', () => {
  const catalog = syntheticCatalog()
  const entry = catalog.commands.find(command => command.command === 'serve')
  if (entry) entry.flags = (entry.flags as Array<{ name: string }>).filter(flag => flag.name !== 'port')
  expect(() => validateCatalog(catalog, loadCliTable())).toThrow('missing-flag')
})

test('catalog validation rejects a missing public method binding', () => {
  const catalog = syntheticCatalog()
  const expected = CLI_MAPPINGS.find((mapping) => mapping.rowId === 'repo-add')!
  catalog.methods = catalog.methods.filter((method) => method.name !== expected.methods[0])
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('catalog validation rejects a shadowed command', () => {
  const catalog = syntheticCatalog()
  const entry = catalog.commands.find((command) => command.command === 'repo add')!
  entry.shadowedBy = 'kernel repo add'
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('catalog validation rejects a missing expected flag', () => {
  const catalog = syntheticCatalog()
  const expected = CLI_MAPPINGS.find((mapping) => mapping.rowId === 'worktree-create')!
  const entry = catalog.commands.find((command) => command.command === expected.words)!
  const missing = expected.flags[0]?.name
  expect(missing).toBeDefined()
  entry.flags = (entry.flags as Array<{ name: string }>).filter((flag) => flag.name !== missing)
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('catalog validation rejects a missing UI command target', () => {
  const catalog = syntheticCatalog()
  catalog.uiCommands = []
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('catalog validation resolves group and command aliases to the primary entry', () => {
  const rows = loadCliTable()
  const mapping = CLI_MAPPINGS.find((candidate) => candidate.rowId === 'loop-create')!
  const alias: CliCatalogMapping = { ...mapping, words: 'loop create' }
  const mappings = CLI_MAPPINGS.map((candidate) => candidate === mapping ? alias : candidate)
  const checked = validateCatalog(syntheticCatalog(), rows, mappings)
  expect(checked.find((entry) => entry.rowId === 'loop-create')?.refs).toContain('command:loops create')
})

test('a new equivalent claim cannot bypass compiled catalog and behavior declarations', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  rows.find(row => row.id === 'repo-list')!.equivalent += '; `status`'
  expect(codeOf(() => validateRows(inventory, rows))).toBe('missing-catalog-ref')
})
