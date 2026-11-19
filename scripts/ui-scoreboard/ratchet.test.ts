import { expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runUiScoreboard } from '../ui-scoreboard'
import { checkRatchet, parseRatchetConfig } from './ratchet'
import * as tokens from './tokens'
import type { Evidence, Inventory, PluginInventory, SourceFile, StaticCheckId } from './contracts'

function plugin(id: string, hasUi = true, sources: SourceFile[] = []): PluginInventory {
  return { id, directory: `plugins/${id}`, hasUi, targets: [], sources }
}

function inventory(options: {
  plugins?: PluginInventory[]
  sharedSources?: SourceFile[]
  failures?: Evidence[]
} = {}): Inventory {
  return {
    repoRoot: '/fixture', commit: 'fixture', sourceDigest: 'digest', dirty: false,
    plugins: options.plugins ?? [], targets: [], sharedSources: options.sharedSources ?? [],
    exclusions: [], failures: options.failures ?? [],
  }
}

const auditUi = `import { EmptyState, InlineError } from '@quirky/ui'
export function Main({ status }: { status: string }) {
  if (status === 'busy') return <EmptyState message="Loading items" />
  if (status === 'none') return <EmptyState message="No items yet" />
  if (status === 'bad') return <InlineError message="Could not load" />
  return <button onClick={() => context.call('acme.app/save', {})}>Save</button>
}`

function passingAuditPlugin(ui = auditUi): PluginInventory {
  const coverage = {
    schemaVersion: 1,
    surfaces: {
      'view:acme.app/main': {
        loading: { applicable: true },
        empty: { applicable: true },
        error: { applicable: true },
      },
    },
    states: [
      {
        surface: 'view:acme.app/main', state: 'loading',
        site: { file: 'plugins/acme.app/src/ui.tsx', quote: "if (status === 'busy')" },
        anchor: "if (status === 'busy')",
        render: {
          component: 'EmptyState',
          element: { file: 'plugins/acme.app/src/ui.tsx', quote: '<EmptyState message="Loading items" />' },
          import: { file: 'plugins/acme.app/src/ui.tsx', quote: "import { EmptyState, InlineError } from '@quirky/ui'" },
        },
      },
      {
        surface: 'view:acme.app/main', state: 'empty',
        site: { file: 'plugins/acme.app/src/ui.tsx', quote: "if (status === 'none')" },
        anchor: "if (status === 'none')",
        render: {
          component: 'EmptyState',
          element: { file: 'plugins/acme.app/src/ui.tsx', quote: '<EmptyState message="No items yet" />' },
          import: { file: 'plugins/acme.app/src/ui.tsx', quote: "import { EmptyState, InlineError } from '@quirky/ui'" },
        },
      },
      {
        surface: 'view:acme.app/main', state: 'error',
        site: { file: 'plugins/acme.app/src/ui.tsx', quote: "if (status === 'bad')" },
        anchor: "if (status === 'bad')",
        render: {
          component: 'InlineError',
          element: { file: 'plugins/acme.app/src/ui.tsx', quote: '<InlineError message="Could not load" />' },
          import: { file: 'plugins/acme.app/src/ui.tsx', quote: "import { EmptyState, InlineError } from '@quirky/ui'" },
        },
      },
    ],
    notState: [],
    actions: [{
      site: { file: 'plugins/acme.app/src/ui.tsx', quote: 'onClick' },
      route: {
        invoke: { file: 'plugins/acme.app/src/ui.tsx', quote: "context.call('acme.app/save', {})" },
        target: 'acme.app/save',
      },
    }],
  }
  return {
    id: 'acme.app', directory: 'plugins/acme.app', hasUi: true,
    targets: ['view:acme.app/main'],
    sources: [
      { file: 'plugins/acme.app/src/ui.tsx', content: ui },
      { file: 'plugins/acme.app/src/main.ts', content: 'setTimeout(run, 30_000, { onTimeout: cleanup })' },
    ],
    contributions: {
      methods: ['acme.app/save'],
      commands: ['command:acme.app/refresh'],
      cliCommands: [{ id: 'save', words: 'save', methods: ['acme.app/save'] }],
    },
    coverage: { file: 'plugins/acme.app/ui-scoreboard.json', content: JSON.stringify(coverage) },
  }
}

const allStaticChecks = ['compatibility-tokens', 'loading', 'empty', 'error', 'commands'] as const

test('ratchet evaluates each enrolled plugin and host once without evaluating unenrolled debt', () => {
  const source = inventory({
    plugins: [
      passingAuditPlugin(), plugin('acme.daemon', false),
      plugin('acme.unenrolled', false, [{ file: 'plugins/acme.unenrolled/src/main.ts', content: '"--compat-px-40"' }]),
    ],
  })
  const pluginSpy = spyOn(tokens, 'checkPlugin')
  const hostSpy = spyOn(tokens, 'checkHostTokens')
  try {
    expect(checkRatchet(source, {
      'acme.app': [...allStaticChecks], 'acme.daemon': [...allStaticChecks], host: ['compatibility-tokens'],
    })).toEqual({ exitCode: 0, failures: [] })
    expect(pluginSpy.mock.calls.map(([input, id]) => {
      expect(input).toBe(source)
      return id
    }).sort()).toEqual(['acme.app', 'acme.daemon'])
    expect(hostSpy.mock.calls).toEqual([[source]])
  } finally {
    pluginSpy.mockRestore()
    hostSpy.mockRestore()
  }
})

test('ratchet preserves all failing check evidence in enrollment order with one plugin evaluation', () => {
  const broken = passingAuditPlugin(`${auditUi}\nconst x="--compat-px-40"`)
  const coverage = JSON.parse(broken.coverage!.content)
  broken.coverage!.content = JSON.stringify({ ...coverage, states: [], actions: [] })
  const source = inventory({ plugins: [broken] })
  const checks: StaticCheckId[] = ['commands', 'error', 'compatibility-tokens', 'empty', 'loading']
  const scored = tokens.checkPlugin(source, broken.id)
  expect(scored.filter(({ status }) => status === 'fail').map(({ id }) => id).sort()).toEqual([...allStaticChecks].sort())
  const expected = checks.flatMap((id) => scored.find((check) => check.id === id)!.evidence.map((item) => ({
    ...item, message: `${broken.id} / ${id}: ${item.message}`,
  })))
  expect(expected.some(({ source }) => source?.file === 'plugins/acme.app/src/ui.tsx')).toBe(true)
  const pluginSpy = spyOn(tokens, 'checkPlugin')
  try {
    expect(checkRatchet(source, { [broken.id]: checks })).toEqual({ exitCode: 1, failures: expected })
    expect(pluginSpy.mock.calls).toEqual([[source, broken.id]])
  } finally {
    pluginSpy.mockRestore()
  }
})

test('ratchet validates the entire input before evaluating plugins or host', () => {
  const source = inventory({ plugins: [plugin('acme.daemon', false)] })
  const enrollment = { 'acme.daemon': [...allStaticChecks], host: ['compatibility-tokens' as const] }
  const pluginSpy = spyOn(tokens, 'checkPlugin')
  const hostSpy = spyOn(tokens, 'checkHostTokens')
  try {
    expect(checkRatchet(source, { ...enrollment, deleted: ['loading'] }).exitCode).toBe(2)
    expect(checkRatchet(source, { ...enrollment, host: ['screenshots' as StaticCheckId] }).exitCode).toBe(2)
    expect(checkRatchet({ ...source, failures: [{ code: 'inventory-error', message: 'unreadable source' }] }, enrollment)).toEqual({
      exitCode: 2, failures: [{ code: 'inventory-error', message: 'unreadable source' }],
    })
    expect(pluginSpy.mock.calls).toEqual([])
    expect(hostSpy.mock.calls).toEqual([])
  } finally {
    pluginSpy.mockRestore()
    hostSpy.mockRestore()
  }
})

test('ratchet reports every unavailable host check after one host evaluation', () => {
  const source = inventory()
  const hostSpy = spyOn(tokens, 'checkHostTokens')
  const pluginSpy = spyOn(tokens, 'checkPlugin')
  try {
    expect(checkRatchet(source, { host: [...allStaticChecks] })).toEqual({
      exitCode: 1,
      failures: ['loading', 'empty', 'error', 'commands'].map((id) => ({
        code: 'unavailable-ratchet-check', message: `Ratchet check host/${id} is unavailable`,
      })),
    })
    expect(hostSpy.mock.calls).toEqual([[source]])
    expect(pluginSpy.mock.calls).toEqual([])
  } finally {
    hostSpy.mockRestore()
    pluginSpy.mockRestore()
  }
})

test('ratchet reevaluates in-place source changes on every call despite an unchanged digest', () => {
  const file = { file: 'plugins/acme.daemon/src/main.ts', content: '' }
  const source = inventory({ plugins: [plugin('acme.daemon', false, [file])] })
  const enrollment = { 'acme.daemon': [...allStaticChecks] }
  const pluginSpy = spyOn(tokens, 'checkPlugin')
  try {
    const results = ['', 'const x="--compat-px-40"', ''].map((content) => {
      file.content = content
      return checkRatchet(source, enrollment)
    })
    expect(results.map(({ exitCode }) => exitCode)).toEqual([0, 1, 0])
    expect(results[0]).toEqual({ exitCode: 0, failures: [] })
    expect(results[2]).toEqual({ exitCode: 0, failures: [] })
    expect(results[1]!.failures).toEqual([expect.objectContaining({
      code: 'compatibility-token',
      message: expect.stringMatching(/^acme\.daemon \/ compatibility-tokens:/),
      source: { file: file.file, line: 1, column: 10 },
    })])
    expect(source.sourceDigest).toBe('digest')
    expect(pluginSpy.mock.calls).toEqual(Array.from({ length: 3 }, () => [source, 'acme.daemon']))
  } finally {
    pluginSpy.mockRestore()
  }
})

test('ratchet accepts all static checks and enforces the enrolled source audit', () => {
  const enrollment = { 'acme.app': [...allStaticChecks] }
  expect({ ...parseRatchetConfig(JSON.stringify(enrollment)) }).toEqual(enrollment)
  const passing = checkRatchet(inventory({ plugins: [passingAuditPlugin()] }), enrollment)
  expect(passing.exitCode).toBe(0)
  expect(passing.failures).toEqual([])

  const missingBranch = passingAuditPlugin(auditUi.replace(
    "  if (status === 'busy')",
    "  if (!rows) return null\n  if (status === 'busy')",
  ))
  const failed = checkRatchet(inventory({ plugins: [missingBranch] }), enrollment)
  expect(failed.exitCode).toBe(1)
  expect(failed.failures).toContainEqual(expect.objectContaining({
    code: 'coverage-missing',
    message: expect.stringMatching(/^acme\.app \/ loading:/),
  }))

  const daemonTimeout = passingAuditPlugin()
  daemonTimeout.sources.find((source) => source.file.endsWith('/main.ts'))!.content =
    'setTimeout(() => {}, 30_000, { onTimeout: () => cleanup() })'
  expect(checkRatchet(inventory({ plugins: [daemonTimeout] }), enrollment).exitCode).toBe(0)

  expect(checkRatchet(inventory({ plugins: [passingAuditPlugin()] }), {
    'acme.app': ['screenshots' as unknown as StaticCheckId],
  }).exitCode).toBe(2)
})

test.each([false, true])('ratchet evaluates fragment coverage with regression=%s', (regression) => {
  const plugin = passingAuditPlugin()
  const coverage = JSON.parse(plugin.coverage!.content)
  plugin.coverage!.content = JSON.stringify({ ...coverage, actions: [] })
  if (regression) coverage.actions[0].route.invoke.quote = "context.call('acme.app/load', {})"
  const fragmentFile = 'plugins/acme.app/ui-scoreboard/actions.json'
  plugin.coverageFragments = [{
    file: fragmentFile,
    content: JSON.stringify({ ...coverage, surfaces: {}, states: [], notState: [] }),
  }]
  const result = checkRatchet(inventory({ plugins: [plugin] }), { 'acme.app': [...allStaticChecks] })
  if (regression) {
    expect(result.exitCode).toBe(1)
    expect(result.failures).toContainEqual(expect.objectContaining({
      code: 'evidence-missing',
      message: expect.stringMatching(/^acme\.app \/ commands: .* \[plugins\/acme\.app\/ui-scoreboard\/actions\.json\]$/),
    }))
  } else expect(result).toEqual({ exitCode: 0, failures: [] })
})
const valid = ['compatibility-tokens'] as const

test('parses empty and valid ratchets while rejecting malformed or duplicate config entries', () => {
  expect({ ...parseRatchetConfig('{}') }).toEqual({})
  expect({ ...parseRatchetConfig('{"acme.ui":["compatibility-tokens"],"host":["compatibility-tokens"]}') }).toEqual({
    'acme.ui': [...valid], host: [...valid],
  })

  for (const text of [
    '{', 'null', '[]', '{"": ["compatibility-tokens"]}',
    '{"acme.ui": null}', '{"acme.ui": {}}', '{"acme.ui": []}',
    '{"acme.ui": ["compatibility-tokens", "compatibility-tokens"]}',
    '{"acme.ui": ["screenshots"]}', '{"acme.ui": ["made-up"]}',
    '{"acme.ui": ["toString"]}', '{"acme.ui": ["constructor"]}',
    '{"acme.ui": ["compatibility-tokens"], "acme.ui": ["compatibility-tokens"]}',
  ]) {
    expect(() => parseRatchetConfig(text)).toThrow()
  }
})
test('prototype-named plugin keys are treated as unknown enrollment', () => {
  for (const pluginId of ['__proto__', 'constructor', 'toString']) {
    const enrollment = parseRatchetConfig(JSON.stringify({ [pluginId]: [...valid] }))
    expect(checkRatchet(inventory(), enrollment).exitCode).toBe(2)
  }
})

test('rejects deleted plugins and screenshots while accepting implemented static checks', () => {
  expect(checkRatchet(inventory(), { 'acme.deleted': [...valid] }).exitCode).toBe(2)
  expect(checkRatchet(inventory({ plugins: [plugin('acme.ui')] }), { 'acme.ui': ['loading'] }).exitCode).toBe(1)
  expect(checkRatchet(inventory({ plugins: [plugin('acme.ui')] }), {
    'acme.ui': ['screenshots' as unknown as StaticCheckId],
  }).exitCode).toBe(2)
})

test('inventory errors fail even when no checks are enrolled', () => {
  const result = checkRatchet(inventory({ failures: [{ code: 'inventory-error', message: 'unreadable source' }] }), {})
  expect(result.exitCode).toBe(2)
  expect(result.failures).toContainEqual({ code: 'inventory-error', message: 'unreadable source' })
})

test('non-enrolled compatibility debt does not fail the ratchet', () => {
  const result = checkRatchet(inventory({
    plugins: [plugin('acme.ui', true, [{ file: 'plugins/acme.ui/src/ui.tsx', content: 'const style = "--compat-px-40"' }])],
  }), {})
  expect(result.exitCode).toBe(0)
  expect(result.failures).toEqual([])
})

test('an enrolled plugin token regression fails with plugin, check, and source site', () => {
  const result = checkRatchet(inventory({
    plugins: [plugin('acme.ui', true, [{ file: 'plugins/acme.ui/src/ui.tsx', content: 'const style = "--compat-px-40"' }])],
  }), { 'acme.ui': [...valid] })
  expect(result.exitCode).toBe(1)
  const evidence = JSON.stringify(result.failures)
  expect(evidence).toContain('acme.ui')
  expect(evidence).toContain('compatibility-tokens')
  expect(evidence).toContain('plugins/acme.ui/src/ui.tsx')
})

test('shared token regressions fail UI and host enrollment but not a daemon-only plugin', () => {
  const result = checkRatchet(inventory({
    plugins: [plugin('acme.ui'), plugin('acme.daemon', false)],
    sharedSources: [{ file: 'packages/ui/src/theme.css', content: '.panel { color: var(--compat-px-40); }' }],
  }), {
    'acme.ui': [...valid], 'acme.daemon': [...valid], host: [...valid],
  })
  expect(result.exitCode).toBe(1)
  const uiFailure = result.failures.find((item) => item.message.startsWith('acme.ui / compatibility-tokens:'))
  const hostFailure = result.failures.find((item) => item.message.startsWith('host / compatibility-tokens:'))
  expect(uiFailure?.source?.file).toBe('packages/ui/src/theme.css')
  expect(hostFailure?.source?.file).toBe('packages/ui/src/theme.css')
  const evidence = JSON.stringify(result.failures)
  expect(evidence).toContain('acme.ui')
  expect(evidence).toContain('host')
  expect(evidence).toContain('packages/ui/src/theme.css')
  expect(evidence).not.toContain('acme.daemon')
})

test('check-ratchet runs inventory only without runtime or report writes', async () => {
  const repoRoot = resolve(import.meta.dir, '../..')
  const config = readFileSync(resolve(repoRoot, 'scripts/ui-scoreboard-ratchet.json'), 'utf8')
  expect(parseRatchetConfig(config)).toBeObject()
  const source = inventory({ plugins: [plugin('acme.ui', true, [{ file: 'plugins/acme.ui/src/ui.tsx', content: '"--compat-px-40"' }])] })
  let inventoryCalls = 0
  const forbidden = () => { throw new Error('check-ratchet started runtime or wrote a report') }
  const exitCode = await runUiScoreboard(['--check-ratchet'], {
    repoRoot, collectInventory: () => { inventoryCalls++; return source },
    readFile: async () => JSON.stringify({ host: ['compatibility-tokens'] }),
    captureApplication: forbidden, reviewManifest: forbidden, mkdir: forbidden,
  })
  expect(exitCode).toBe(0)
  expect(inventoryCalls).toBe(1)
})

