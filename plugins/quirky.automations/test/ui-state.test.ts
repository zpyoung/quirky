import { afterEach, expect, test } from 'bun:test'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import type { AutomationUiState } from '../src/ui-contracts'
import type { UiLayout } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'

const fixtures: PluginHarness[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup() })
async function boot() {
  const fixture = await startPluginHarness({ plugins: ['quirky.automations'], fakeSession: false })
  fixtures.push(fixture)
  return fixture
}

test('scripted automation navigation retains filters and restores predecessor without settings clobbering it', async () => {
  const { client } = await boot()
  const before = await client.callAny('ui.state', {}) as { layout: UiLayout }
  await client.callAny('quirky.automations/open', { query: 'audit', status: 'paused' })
  await client.callAny('quirky.automations/uiNavigate', { page: 'runs', runStatus: 'failed', host: 'all' })
  const selected = await client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  expect(selected.navigation).toMatchObject({ page: 'runs', query: 'audit', status: 'paused', runStatus: 'failed' })
  await client.callAny('quirky.automations/settings', {})
  await client.callAny('quirky.automations/open', {})
  await client.callAny('quirky.automations/close', {})
  const after = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(after.layout.view).toEqual(before.layout.view)
}, 20_000)

test('invalid navigation is rejected atomically without losing prior selection or filter', async () => {
  const { client } = await boot()
  await client.callAny('quirky.automations/uiNavigate', { query: 'release', direction: 'desc' })
  const before = await client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  await expect(client.callAny('quirky.automations/uiNavigate', { query: 'changed', page: 'missing' })).rejects.toThrow()
  const after = await client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  expect(after).toEqual(before)
  await expect(client.callAny('quirky.automations/uiNavigate', { sort: 'constructor' })).rejects.toThrow()
  await expect(client.callAny('quirky.automations/uiNavigate', { query: 'x'.repeat(65_537) })).rejects.toThrow()
}, 20_000)

test('sidebar and confirmation preferences survive plugin reactivation without persisting drafts', async () => {
  const { client } = await boot()
  await client.callAny('setting.set', { id: 'setting:quirky.automations/show-automations-button', value: false })
  await client.callAny('setting.set', { id: 'setting:quirky.automations/ask-before-delete', value: false })
  await client.callAny('quirky.automations/uiNavigate', { query: 'transient' })
  await client.callAny('plugin.disable', { id: 'quirky.automations' })
  await client.callAny('plugin.enable', { id: 'quirky.automations' })
  const visible = await client.callAny('setting.get', { id: 'setting:quirky.automations/show-automations-button' })
  const confirm = await client.callAny('setting.get', { id: 'setting:quirky.automations/ask-before-delete' })
  expect(visible).toMatchObject({ value: false })
  expect(confirm).toMatchObject({ value: false })
  const state = await client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  expect(state.navigation.query).toBe('')
  expect(state.editor).toBeNull()
}, 20_000)

test('CLI navigation parses JSON patches and rejects malformed input without changing the retained state', async () => {
  const fixture = await boot()
  const result = await runCli(['automations', 'navigate', '--patch', JSON.stringify({ page: 'runs', runQuery: 'release', runStatus: 'failed' }), '--json'], { home: fixture.h.home, cwd: fixture.h.home })
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout).navigation).toMatchObject({ page: 'runs', runQuery: 'release', runStatus: 'failed' })
  const rejected = await runCli(['automations', 'navigate', '--patch', '{broken', '--json'], { home: fixture.h.home, cwd: fixture.h.home })
  expect(rejected.code).toBe(2)
  const retained = await fixture.client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  expect(retained.navigation).toMatchObject({ page: 'runs', runQuery: 'release', runStatus: 'failed' })
}, 20_000)
