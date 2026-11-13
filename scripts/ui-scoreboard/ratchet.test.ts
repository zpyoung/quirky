import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runUiScoreboard } from '../ui-scoreboard'
import { checkRatchet, parseRatchetConfig } from './ratchet'
import type { Evidence, Inventory, PluginInventory, SourceFile } from './contracts'

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

test('rejects deleted plugin enrollment and unimplemented static checks as configuration errors', () => {
  expect(checkRatchet(inventory(), { 'acme.deleted': [...valid] }).exitCode).toBe(2)
  expect(checkRatchet(inventory({ plugins: [plugin('acme.ui')] }), { 'acme.ui': ['loading'] }).exitCode).toBe(2)
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
  expect(parseRatchetConfig(config)).toEqual({})
  const source = inventory({ plugins: [plugin('acme.ui', true, [{ file: 'plugins/acme.ui/src/ui.tsx', content: '"--compat-px-40"' }])] })
  let inventoryCalls = 0
  const forbidden = () => { throw new Error('check-ratchet started runtime or wrote a report') }
  const exitCode = await runUiScoreboard(['--check-ratchet'], {
    repoRoot, collectInventory: () => { inventoryCalls++; return source },
    captureApplication: forbidden, reviewManifest: forbidden, mkdir: forbidden,
  })
  expect(exitCode).toBe(0)
  expect(inventoryCalls).toBe(1)
})

