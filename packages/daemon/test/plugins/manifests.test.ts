import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

const rows: { plugin: string; contributes?: Record<string, unknown>; overrides?: unknown[]; says: string }[] = [
  { plugin: 'acme.nointerval', contributes: { job: [{ id: 'tick' }] }, says: 'job tick: interval is required' },
  {
    plugin: 'acme.fast',
    contributes: { job: [{ id: 'tick', interval: '500ms' }] },
    says: 'job tick: interval must be between 1s and 24h'
  },
  {
    plugin: 'acme.soon',
    contributes: { job: [{ id: 'tick', interval: 'soon' }] },
    says: 'job tick: interval must be a duration such as 30s, 5m or 2h'
  },
  {
    plugin: 'acme.agents',
    contributes: { 'launch-hook': [{ id: 'vars', agents: 'claude' }] },
    says: 'launch-hook vars: agents must be a list of agent names'
  },
  {
    plugin: 'acme.handler',
    contributes: { method: [{ id: 'go', handler: 'x' }] },
    says: 'method go: unknown field `handler`'
  },
  {
    plugin: 'acme.slow',
    overrides: [{ id: 'job:acme.poll/tick', interval: '2d' }],
    says: 'override job:acme.poll/tick: interval must be between 1s and 24h'
  }
]

test('SC-28: bad declarations of the four kinds make the plugin invalid', async () => {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  const root = join(home, 'plugins')
  writeModulePlugin(root, marker, { id: 'acme.ok', contributes: { job: [{ id: 'tick', interval: '1h' }] } })
  for (const { plugin, contributes, overrides } of rows) {
    writeModulePlugin(root, marker, { id: plugin, ...(contributes ? { contributes } : {}), ...(overrides ? { overrides } : {}) })
  }
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const client = await harness.connect()

  const plugins = await client.call('plugin.list', {})
  for (const { plugin, says } of rows) {
    const info = plugins.find((candidate) => candidate.id === plugin)!
    expect(info.state).toBe('invalid')
    expect(info.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(says)
  }
  const valid = plugins.find((candidate) => candidate.id === 'acme.ok')!
  expect(valid.state).toBe('inactive')
  expect(valid.diagnostics).toEqual([])
  expect((await client.call('job.list', {})).map((job) => job.id)).toEqual(['job:acme.ok/tick'])
})
