import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkIds } from './cli-checks'
import { buildCliReport, parseCliRefusal, reduceCliRows } from './cli-run'
import type { CliReceipt } from './cli-run'
import { KERNEL_METHOD_SCHEMAS } from '../../packages/protocol/src/kernel-schemas'
import {
  CLI_MAPPINGS,
  CLI_SCHEMA_REQUIREMENTS,
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
type TestObservationRow = CliTableRow & { observations?: string[] }

function parseSingleRow(checkCell: string): CliTableRow {
  const rows = parseCliTable([
    '| ID | Orca feature / provenance | Quirky equivalent | Check | Disposition / reason |',
    '| --- | --- | --- | --- | --- |',
    `| agent-context | orca: \`agent-context\` | \`api\` | ${checkCell} | covered: Fixture behavioral contract. |`
  ].join('\n'))
  return rows[0]!
}

function setObservations(row: CliTableRow, observations?: string[]): void {
  const testRow = row as TestObservationRow
  if (observations === undefined) delete testRow.observations
  else testRow.observations = observations
}

function rowObservations(row: CliTableRow): string[] | undefined {
  return (row as TestObservationRow).observations
}

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

const exactWindowMethodParams: Record<string, Record<string, unknown>> = {
  'ui.window.command.run': {
    type: 'object',
    properties: {
      connId: { type: 'integer', description: 'A live kernel UI connection ID.' },
      id: { type: 'string' },
      args: { description: "Checked against the command's args schema." }
    },
    required: ['connId', 'id']
  }
}

function syntheticCatalog(mappings: readonly CliCatalogMapping[] = CLI_MAPPINGS): SyntheticCatalog {
  const methods = new Map<string, SyntheticCatalog['methods'][number]>()
  const uiCommands = new Map<string, SyntheticCatalog['uiCommands'][number]>()
  const groups = new Map<string, SyntheticCatalog['cli']['groups'][number]>()
  const pluginCommands = new Map<string, Record<string, unknown>>()
  const commands = new Map<string, Record<string, unknown>>()

  const addMethod = (name: string, plugin: string | null): void => {
    if (!methods.has(name)) {
      methods.set(name, {
        name,
        plugin,
        params: cloned(exactWindowMethodParams[name] ?? { type: 'object', properties: {} }),
        result: { type: 'object' }
      })
    }
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
  for (const requirement of CLI_SCHEMA_REQUIREMENTS) {
    const target = requirement.target
    if (target.kind === 'cli-flag') continue
    const container = target.kind === 'method-param'
      ? methods.get(target.method)!.params
      : uiCommands.get(target.command)!.args
    const properties = (container.properties ??= {}) as Record<string, unknown>
    properties[target.property] = {
      type: requirement.schema.type,
      description: requirement.id,
      ...(requirement.schema.minimum !== undefined ? { minimum: requirement.schema.minimum } : {}),
      ...((requirement.schema.enumEquals ?? requirement.schema.enumIncludes) ? {
        enum: [...(requirement.schema.enumEquals ?? requirement.schema.enumIncludes)!]
      } : {})
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
const serviceRestoreIds = ['serve-restore-resume', 'serve-service-install', 'serve-service-status', 'serve-service-uninstall']
const fileObservationIds = {
  'file-open': ['files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path', 'files-editor-window-focus'],
  'file-open-render': ['files-editor-local', 'files-editor-other-worktree', 'files-editor-literal-path', 'files-editor-window-focus', 'files-window-refusals'],
  'file-diff': ['files-review-diff', 'files-review-reuse', 'files-window-routing', 'files-window-refusals', 'files-review-focus-window', 'files-review-background', 'files-review-source'],
  'file-open-changed': ['files-review-changed', 'files-window-routing', 'files-window-refusals', 'files-review-focus-window', 'files-changed-modes']
} as const

test('service and host-restore scope decisions remain captured exclusions without behavioral claims', () => {
  const inventory = loadCliInventory()
  const rows = loadCliTable()
  const excluded = rows.filter(row => serviceRestoreIds.includes(row.id))
  expect(excluded.map(row => row.id)).toEqual(serviceRestoreIds)
  for (const row of excluded) {
    expect(row).toMatchObject({ disposition: 'excluded', checks: [] })
    expect(row.reason.trim()).not.toBe('')
    expect(row).not.toHaveProperty('followUp')
    expect(row).not.toHaveProperty('missingBehavior')

    const withoutReason = cloned(rows)
    withoutReason.find(candidate => candidate.id === row.id)!.reason = ''
    expect(codeOf(() => validateRows(inventory, withoutReason))).toBe('missing-reason')

    const withCheck = cloned(rows)
    withCheck.find(candidate => candidate.id === row.id)!.checks = ['status']
    expect(codeOf(() => validateRows(inventory, withCheck))).toBe('missing-check')

    expect(codeOf(() => validateRows(inventory, rows.filter(candidate => candidate.id !== row.id)))).toBe('missing-command')
  }
  expect(validateRows(inventory, rows)).toBeUndefined()
})

test('excluded service and host-restore rows have no compiled catalog obligations', () => {
  const rows = loadCliTable()
  const catalog = syntheticCatalog()
  const refs = validateCatalog(catalog, rows)
  expect(CLI_MAPPINGS.filter(mapping => serviceRestoreIds.includes(mapping.rowId))).toEqual([])
  expect(refs.filter(entry => serviceRestoreIds.includes(entry.rowId))).toEqual(
    serviceRestoreIds.map(rowId => ({ rowId, refs: [] }))
  )
  expect(refs.find(entry => entry.rowId === 'status')!.refs).toContain('command:status')
  expect(refs.find(entry => entry.rowId === 'serve')!.refs).toContain('command:serve')

  const status = CLI_MAPPINGS.find(mapping => mapping.rowId === 'status')!
  expect(codeOf(() => validateCatalog(catalog, rows, [
    ...CLI_MAPPINGS, { ...status, rowId: 'serve-service-status' }
  ]))).toBe('catalog-mismatch')
})

test('excluded service and host-restore report rows do not fabricate execution', () => {
  const allRows = loadCliTable()
  const rows = allRows.filter(row => serviceRestoreIds.includes(row.id))
  const refs = new Map(validateCatalog(syntheticCatalog(), allRows).map(entry => [entry.rowId, entry.refs]))
  const results = reduceCliRows(rows, [], new Set(), refs)
  expect(results).toEqual(rows.map(row => ({
    id: row.id, status: 'excluded', executed: false, checks: [], catalogRefs: [], reason: row.reason
  })))
  expect(results.map(row => row.id)).toEqual(serviceRestoreIds)
})

test('service and host-restore exclusions preserve an unrelated catalog transport failure', () => {
  const rows = loadCliTable().filter(row => serviceRestoreIds.includes(row.id))
  const report = buildCliReport({
    rows, receipts: [], proven: new Set(), catalogRefs: new Map(),
    failure: { checkId: 'catalog', kind: 'transport', message: 'dead daemon' }, elapsedMs: 0
  })
  expect(report).toMatchObject({
    schemaVersion: 1, ok: false, parityComplete: false, receipts: [],
    error: { stage: 'catalog', kind: 'transport', message: 'dead daemon' }, cleanup: { ok: true }
  })
  expect(report.rows).toEqual(rows.map(row => ({
    id: row.id, status: 'excluded', executed: false, checks: [], catalogRefs: [], reason: row.reason
  })))
})

test('worker-read requires live, explicit terminal and archived proof before passing', () => {
  const rows = loadCliTable()
  const row = rows.find(row => row.id === 'orchestration-worker-read')!
  const checks = ['workers-read-live', 'workers-read-terminal', 'workers-read-archived']
  expect(row).toMatchObject({ disposition: 'covered', checks })
  expect(row).not.toHaveProperty('followUp')
  expect(row).not.toHaveProperty('missingBehavior')
  const refs = new Map(validateCatalog(syntheticCatalog(), rows).map(entry => [entry.rowId, entry.refs]))
  expect(refs.get(row.id)!.length).toBeGreaterThan(0)
  const receipts: CliReceipt[] = checks.map(id => ({
    id, command: 'orchestration worker-read', argv: ['orchestration', 'worker-read', '--json'],
    exitCode: 0, format: 'json', stdoutBytes: 1, elapsedMs: 0, evidence: {}
  }))
  const reduce = (observed = receipts, proven = new Set(checks)) => reduceCliRows([row], observed, proven, refs)[0]
  expect(reduce()).toMatchObject({ status: 'passed', executed: true, checks })
  for (const id of checks) {
    expect(reduce(receipts.filter(receipt => receipt.id !== id)).status, id).not.toBe('passed')
    expect(reduce(receipts, new Set(checks.filter(check => check !== id))).status, id).not.toBe('passed')
    expect(reduce(receipts.map(receipt => receipt.id === id ? { ...receipt, exitCode: 1 } : receipt)).status, id).not.toBe('passed')
    const failure = { checkId: id, kind: 'assertion', message: 'read evidence mismatch' }
    expect(reduceCliRows([row], receipts, new Set(checks), refs, failure)[0]).toMatchObject({
      status: 'failed', executed: true, error: failure
    })
  }
  expect(reduceCliRows([row], receipts, new Set(checks), new Map())[0].status).not.toBe('passed')
})

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

test('table check grammar parses observations alone and after ordinary checks', () => {
  const checkOnly = parseSingleRow('check:catalog; `bun test scripts/parity/cli.test.ts`')
  expect(checkOnly.checks).toEqual(['catalog'])
  expect(checkOnly).not.toHaveProperty('observations')

  const observeOnly = parseSingleRow('observe:files-editor-local, files-editor-other-worktree; `bun test scripts/parity/cli-files.test.ts`')
  expect(observeOnly).toMatchObject({
    checks: [],
    observations: ['files-editor-local', 'files-editor-other-worktree']
  })

  const combined = parseSingleRow(
    'check:catalog; `bun test scripts/parity/cli.test.ts`; observe:files-editor-local; `bun test scripts/parity/cli-files.test.ts`'
  )
  expect(combined.checks).toEqual(['catalog'])
  expect(rowObservations(combined)).toEqual(['files-editor-local'])

  const none = parseSingleRow('none')
  expect(none.checks).toEqual([])
  expect(none).not.toHaveProperty('observations')
})

test('table parser rejects malformed observations and wrong acceptance commands', () => {
  const invalidCells = [
    'observe:; `bun test scripts/parity/cli-files.test.ts`',
    'observe:files-editor-local,; `bun test scripts/parity/cli-files.test.ts`',
    'observe:files-editor-local,files-editor-local; `bun test scripts/parity/cli-files.test.ts`',
    'observe:files-editor-local; `bun test scripts/parity/cli.test.ts`',
    'check:catalog; `bun test scripts/parity/cli-files.test.ts`',
    'check:catalog; `bun test scripts/parity/cli.test.ts`; observe:files-editor-local; `bun test scripts/parity/cli.test.ts`'
  ]
  for (const cell of invalidCells) {
    expect(codeOf(() => parseSingleRow(cell))).toBe('missing-check')
  }
})

test('the four file rows declare bounded renderer coverage with compiled observation bindings', () => {
  const rows = loadCliTable()
  for (const [id, observations] of Object.entries(fileObservationIds)) {
    expect(rowObservations(rows.find(row => row.id === id)!)).toEqual([...observations])
    const row = rows.find(row => row.id === id)!
    expect(row.disposition).toBe('covered')
    expect(row.reason).not.toContain('Follow-up:')
  }

  expect(rows.find(row => row.id === 'file-open')).toMatchObject({
    disposition: 'covered',
    checks: ['file-open', 'file-state', 'file-read', 'file-close']
  })
  for (const id of ['file-open-render', 'file-diff', 'file-open-changed']) {
    expect(rows.find(row => row.id === id)).toMatchObject({ disposition: 'covered', checks: [] })
  }
  expect(rows.find(row => row.id === 'file-open-render')!.reason).toMatch(/--window/)
  expect(rows.find(row => row.id === 'file-open-render')!.reason).toMatch(/headless.*not.*native/i)
  for (const id of ['file-diff', 'file-open-changed']) {
    expect(rows.find(row => row.id === id)!.reason).toContain('combined Review')
  }
  const source = readFileSync(tablePath, 'utf8')
  for (const title of [
    'Prove file and review CLI targeting in the real UI',
    'Navigate the selected window for editor open focus',
    'Provide explicit background Review presentation'
  ]) expect(source).not.toContain(title)

  const refs = new Map(validateCatalog(syntheticCatalog(), rows).map(entry => [entry.rowId, entry.refs]))
  expect(refs.get('file-open-render')).toEqual(expect.arrayContaining([
    'command:editor open', 'command:editor state', 'command:editor read'
  ]))
  expect(refs.get('file-diff')).toEqual(expect.arrayContaining([
    'command:ui run', 'uiCommand:command:quirky.git/open-diff'
  ]))
  expect(refs.get('file-open-changed')).toEqual(expect.arrayContaining([
    'command:ui run', 'uiCommand:command:quirky.git/open-changes'
  ]))
})

test('each Review row compiles an exact-window api-call catalog mapping', () => {
  const rows = loadCliTable()
  const reviewMappings = CLI_MAPPINGS
    .filter(mapping => ['file-diff', 'file-open-changed'].includes(mapping.rowId) && mapping.kind === 'api-call')
    .map(mapping => [mapping.rowId, mapping.words, mapping.methodTarget, mapping.methods])
  expect(reviewMappings).toEqual([
    ['file-diff', 'api call', 'ui.window.command.run', ['api.describe']],
    ['file-open-changed', 'api call', 'ui.window.command.run', ['api.describe']]
  ])

  const refs = new Map(validateCatalog(syntheticCatalog(), rows).map(entry => [entry.rowId, entry.refs]))
  for (const id of ['file-diff', 'file-open-changed']) {
    expect(refs.get(id)).toEqual(expect.arrayContaining([
      'command:api call', 'method:ui.window.command.run', 'command:ui run'
    ]))
  }
})

test('catalog validation rejects a missing or malformed exact-window method schema', () => {
  const rows = loadCliTable()
  const missing = syntheticCatalog()
  missing.methods = missing.methods.filter(method => method.name !== 'ui.window.command.run')
  expect(() => validateCatalog(missing, rows)).toThrow(expect.objectContaining({ code: 'catalog-mismatch' }))

  const malformed = syntheticCatalog()
  let target = malformed.methods.find(method => method.name === 'ui.window.command.run')
  if (!target) {
    target = { name: 'ui.window.command.run', plugin: null, params: {}, result: {} }
    malformed.methods.push(target)
  }
  Object.assign(target, { params: null })
  expect(() => validateCatalog(malformed, rows)).toThrow(expect.objectContaining({ code: 'catalog-mismatch' }))

  const corruptions = [
    { property: 'connId', kind: 'missing' },
    { property: 'connId', kind: 'type' },
    { property: 'connId', kind: 'required' },
    { property: 'id', kind: 'missing' },
    { property: 'id', kind: 'type' },
    { property: 'id', kind: 'required' },
    { property: 'args', kind: 'missing' },
    { property: 'args', kind: 'required-extra' }
  ] as const
  for (const corruption of corruptions) {
    const catalog = syntheticCatalog()
    const params = catalog.methods.find(method => method.name === 'ui.window.command.run')!.params
    const properties = params.properties as Record<string, Record<string, unknown>>
    if (corruption.kind === 'missing') {
      delete properties[corruption.property]
    } else if (corruption.kind === 'type') {
      properties[corruption.property]!.type = corruption.property === 'connId' ? 'string' : 'integer'
    } else if (corruption.kind === 'required') {
      params.required = (params.required as string[]).filter(name => name !== corruption.property)
    } else {
      params.required = [...params.required as string[], corruption.property]
    }
    expect(codeOf(() => validateCatalog(catalog, rows))).toBe('catalog-mismatch')
  }
})

test('inventory rejects unknown, duplicate and misbound observation IDs', () => {
  const inventory = loadCliInventory()
  const mutations = [
    { observations: ['files-unknown'], expected: 'invalid-table' },
    { observations: ['files-editor-local', 'files-editor-local'], expected: 'invalid-table' },
    { observations: ['files-review-diff'], expected: 'invalid-table' }
  ] as const

  for (const mutation of mutations) {
    const rows = loadCliTable()
    setObservations(rows.find(row => row.id === 'file-open')!, [...mutation.observations])
    expect(codeOf(() => validateRows(inventory, rows))).toBe(mutation.expected)
  }
})

test('inventory requires every row binding and forbids observations on excluded or delegated rows', () => {
  const inventory = loadCliInventory()
  const missing = loadCliTable()
  setObservations(missing.find(row => row.id === 'file-open')!, [
    'files-editor-other-worktree', 'files-editor-literal-path'
  ])
  expect(codeOf(() => validateRows(inventory, missing))).toBe('missing-check')

  for (const id of ['account-select', 'delegated-root-back']) {
    const rows = loadCliTable()
    setObservations(rows.find(row => row.id === id)!, ['files-window-routing'])
    expect(codeOf(() => validateRows(inventory, rows))).toBe('invalid-table')
  }
})

test('renderer observation IDs cannot be claimed as ordinary behavioral checks', () => {
  const rows = loadCliTable()
  const parsed = parseSingleRow('check:files-editor-local; `bun test scripts/parity/cli.test.ts`')
  rows.find(row => row.id === 'file-open')!.checks = parsed.checks
  expect(codeOf(() => validateRows(loadCliInventory(), rows))).toBe('missing-check')
})

test('core report keeps observation pointers unexecuted and separate from parity checks', () => {
  const allRows = loadCliTable()
  const linked = allRows.filter(row => Object.hasOwn(fileObservationIds, row.id))
  const catalogRefs = new Map(validateCatalog(syntheticCatalog(), allRows).map(entry => [entry.rowId, entry.refs]))
  const reduced = reduceCliRows(linked, [], new Set(), catalogRefs)

  for (const row of linked) {
    expect(reduced.find(result => result.id === row.id)).toMatchObject({
      observations: {
        checks: [...rowObservations(row)!],
        command: 'bun scripts/parity/cli-files.ts --json',
        executed: false
      }
    })
  }
  expect(reduced.find(result => result.id === 'file-open')).toMatchObject({
    status: 'not-run',
    executed: false,
    checks: ['file-open', 'file-state', 'file-read', 'file-close']
  })
  for (const id of ['file-open-render', 'file-diff', 'file-open-changed']) {
    expect(reduced.find(result => result.id === id)).toMatchObject({
      status: 'separate-run',
      executed: false,
      checks: []
    })
  }

  const report = buildCliReport({
    rows: linked, receipts: [], proven: new Set(), catalogRefs, elapsedMs: 0
  })
  expect(report.parityComplete).toBe(false)
  expect(report.rows.find(row => row.id === 'file-open')?.status).toBe('failed')
  for (const id of ['file-open-render', 'file-diff', 'file-open-changed']) {
    expect(report.rows.find(row => row.id === id)?.status).toBe('separate-run')
  }

  const untouched = allRows.find(row => row.id === 'account-list')!
  expect(reduceCliRows([untouched], [], new Set(), catalogRefs)[0]).toEqual({
    id: untouched.id,
    status: 'not-run',
    executed: false,
    checks: untouched.checks,
    catalogRefs: catalogRefs.get(untouched.id) ?? [],
    reason: untouched.reason
  })
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

test('worktree ps rows bind the summary command and preserve independent views', () => {
  const rows = loadCliTable()
  const ps = rows.find(row => row.id === 'worktree-ps')!
  const summary = rows.find(row => row.id === 'worktree-ps-summary')!

  expect(ps.equivalent).toContain('`orchestration ps --limit 100 --json`')
  expect(summary.equivalent).toContain('`orchestration ps --limit 100 --json`')
  expect(summary).toMatchObject({ disposition: 'covered', checks: ['workers-ps-summary'] })
  expect(summary.followUp).toBeUndefined()
  expect(ps.checks).toEqual(expect.arrayContaining([
    'workers-ps-dashboard', 'workers-ps-runs', 'workers-ps-tasks', 'workers-list', 'workers-ps-summary'
  ]))

  const refs = new Map(validateCatalog(syntheticCatalog(), rows).map(entry => [entry.rowId, entry.refs]))
  expect(refs.get('worktree-ps')).toEqual(expect.arrayContaining([
    'command:agent-status dashboard',
    'command:orchestration run-list',
    'command:orchestration task-list',
    'command:orchestration worker-list',
    'command:orchestration ps',
    'method:quirky.orchestration/summary'
  ]))
  expect(refs.get('worktree-ps-summary')).toEqual(expect.arrayContaining([
    'command:orchestration ps',
    'method:quirky.orchestration/summary'
  ]))
})

test('catalog validation rejects summary without its public method', () => {
  const mapping = CLI_MAPPINGS.find(candidate =>
    candidate.rowId === 'worktree-ps-summary' && candidate.words === 'orchestration ps'
  )
  expect(mapping).toBeDefined()
  if (!mapping) return
  const catalog = syntheticCatalog()
  catalog.methods = catalog.methods.filter(method => method.name !== 'quirky.orchestration/summary')
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('catalog validation rejects summary without its integer limit flag', () => {
  const mapping = CLI_MAPPINGS.find(candidate =>
    candidate.rowId === 'worktree-ps-summary' && candidate.words === 'orchestration ps'
  )
  expect(mapping).toBeDefined()
  if (!mapping) return
  const catalog = syntheticCatalog()
  const command = catalog.cli.commands.find(entry => entry.id === mapping.commandId)!
  command.flags = (command.flags as Array<{ name: string }>).filter(flag => flag.name !== 'limit')
  expect(codeOf(() => validateCatalog(catalog, loadCliTable()))).toBe('catalog-mismatch')
})

test('a summary scope row cannot pass without its successful receipt', () => {
  const summary = loadCliTable().find(row => row.id === 'worktree-ps-summary')!
  const report = buildCliReport({
    rows: [summary],
    receipts: [],
    proven: new Set(),
    catalogRefs: new Map([['worktree-ps-summary', ['command:orchestration ps', 'method:quirky.orchestration/summary']]]),
    elapsedMs: 0
  })
  expect(report.ok).toBe(false)
  expect(report.error).toMatchObject({ stage: 'workers-ps-summary', kind: 'missing-receipt' })
  expect(report.rows).toMatchObject([{ id: 'worktree-ps-summary', status: 'failed', executed: false }])
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

test('observation-only covered rows require compiled observation and schema contracts', () => {
  const rows = loadCliTable()
  for (const id of ['file-open-render', 'file-diff', 'file-open-changed']) {
    rows.find(row => row.id === id)!.disposition = 'covered'
  }
  validateRows(loadCliInventory(), rows)
  const missing = cloned(rows)
  missing.find(row => row.id === 'repo-list')!.checks = []
  expect(codeOf(() => validateRows(loadCliInventory(), missing, registeredChecks(missing)))).toBe('missing-check')
  const unbound = cloned(rows)
  delete unbound.find(row => row.id === 'file-diff')!.observations
  expect(codeOf(() => validateRows(loadCliInventory(), unbound))).toBe('missing-check')
  const bindings = CLI_SCHEMA_REQUIREMENTS.map(requirement => requirement.rowIds)
  try {
    for (const requirement of CLI_SCHEMA_REQUIREMENTS) {
      requirement.rowIds = requirement.rowIds.filter(id => id !== 'file-diff')
    }
    expect(codeOf(() => validateRows(loadCliInventory(), rows))).toBe('missing-check')
  } finally {
    CLI_SCHEMA_REQUIREMENTS.forEach((requirement, index) => { requirement.rowIds = bindings[index]! })
  }
})

test('catalog refuses each missing or weakened public file argument contract', () => {
  const rows = loadCliTable()
  expect(CLI_SCHEMA_REQUIREMENTS.map(requirement => requirement.id)).toEqual([
    'editor-open-window', 'editor-open-window-flag', 'window-command-conn',
    'open-diff-focus', 'open-diff-source', 'open-changes-focus', 'open-changes-mode', 'open-changes-area'
  ])
  const properties = (catalog: SyntheticCatalog, name: string, kind: 'method' | 'command') =>
    (kind === 'method' ? catalog.methods.find(entry => entry.name === name)!.params
      : catalog.uiCommands.find(entry => entry.id === name)!.args).properties as Record<string, Record<string, unknown>>
  const mutations: Array<(catalog: SyntheticCatalog) => void> = [
    catalog => { delete properties(catalog, 'quirky.editor/open', 'method').window },
    catalog => { properties(catalog, 'quirky.editor/open', 'method').window = { type: 'integer' } },
    catalog => {
      for (const entry of [...catalog.commands, ...catalog.cli.commands]) {
        if (entry.command === 'editor open' || entry.words === 'editor open') {
          entry.flags = (entry.flags as Array<{ name: string }>).filter(flag => flag.name !== 'window')
        }
      }
    },
    catalog => { delete properties(catalog, 'command:quirky.git/open-diff', 'command').focus },
    catalog => { properties(catalog, 'command:quirky.git/open-diff', 'command').source!.enum = ['unstaged'] },
    catalog => { delete properties(catalog, 'command:quirky.git/open-changes', 'command').focus },
    catalog => { properties(catalog, 'command:quirky.git/open-changes', 'command').mode!.enum = ['edit', 'diff'] },
    catalog => { properties(catalog, 'command:quirky.git/open-changes', 'command').area!.enum = ['staged'] },
    catalog => { delete properties(catalog, 'ui.window.command.run', 'method').connId }
  ]
  validateCatalog(syntheticCatalog(), rows)
  for (const mutate of mutations) {
    const catalog = syntheticCatalog()
    mutate(catalog)
    expect(codeOf(() => validateCatalog(catalog, rows))).toBe('catalog-mismatch')
  }
})

test('checked-in manifests and kernel schemas satisfy every file argument requirement', () => {
  const catalog = syntheticCatalog()
  for (const name of ['quirky.editor', 'quirky.git']) {
    const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, `../../plugins/${name}/quirky-plugin.json`), 'utf8'))
    for (const method of catalog.methods.filter(entry => entry.plugin === name)) {
      method.params = manifest.contributes.method.find((entry: { id: string }) => `${name}/${entry.id}` === method.name).params
    }
    for (const command of catalog.uiCommands.filter(entry => entry.plugin === name)) {
      command.args = manifest.contributes.command.find((entry: { id: string }) => `command:${name}/${entry.id}` === command.id).args
    }
  }
  catalog.methods.find(entry => entry.name === 'ui.window.command.run')!.params = KERNEL_METHOD_SCHEMAS['ui.window.command.run'].params
  validateCatalog(catalog, loadCliTable())
})

test('core observation-only coverage points to a separate run without claiming execution', () => {
  const row = { ...loadCliTable().find(row => row.id === 'file-diff')!, disposition: 'covered' as const }
  const refs = new Map([[row.id, ['uiCommand:command:quirky.git/open-diff']]])
  const report = buildCliReport({ rows: [row], receipts: [], proven: new Set(), catalogRefs: refs, elapsedMs: 1 })
  expect(report).toMatchObject({ ok: true, parityComplete: false })
  expect(report).not.toHaveProperty('error')
  expect(report.rows[0]).toMatchObject({
    status: 'separate-run', executed: false, checks: [],
    observations: { checks: row.observations, command: 'bun scripts/parity/cli-files.ts --json', executed: false }
  })
  expect(reduceCliRows([row], [], new Set(), new Map())[0]!.status).toBe('not-run')
  expect(reduceCliRows([{ ...row, disposition: 'gap' }], [], new Set(), refs)[0]!.status).toBe('gap')
  expect(reduceCliRows([{ ...row, checks: ['file-open'] }], [], new Set(), refs)[0]!.status).toBe('not-run')
})

test('refusal parsing accepts exit two only for an explicitly expected usage refusal', () => {
  const usage = JSON.stringify({ error: { code: 'usage', message: 'window must be positive' } })
  const conflict = JSON.stringify({ error: { code: 'conflict', message: 'window is not open' } })
  expect(parseCliRefusal(usage, 2, 2)).toEqual({ code: 'usage', message: 'window must be positive' })
  expect(parseCliRefusal(conflict, 1)).toEqual({ code: 'conflict', message: 'window is not open' })
  expect(() => parseCliRefusal(conflict, 2, 2)).toThrow()
  expect(() => parseCliRefusal(usage, 2)).toThrow()
  expect(() => parseCliRefusal(usage, 1, 2)).toThrow()
  expect(() => parseCliRefusal(usage, 0, 2)).toThrow()
})
