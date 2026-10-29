import { afterEach, expect, test } from 'bun:test'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { AUTOMATIONS_SETTINGS_VIEW, AUTOMATIONS_VIEW, type AutomationUiState } from '../src/ui-contracts'
import type { UiLayout, UiToolSlot } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'

const fixtures: PluginHarness[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.cleanup() })
async function boot() {
  const fixture = await startPluginHarness({ plugins: ['quirky.repo', 'quirky.worktree', 'quirky.ask', 'quirky.agents', 'quirky.checks', 'quirky.structured', 'quirky.session', 'quirky.automations'], fakeSession: false })
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
  const retained = await client.callAny('quirky.automations/uiState', {}) as AutomationUiState
  expect(retained.navigation).toMatchObject({ page: 'runs', query: 'audit', status: 'paused', runStatus: 'failed' })
}, 20_000)

test('automation tool navigation, editor opening, close, and settings return preserve the center', async () => {
  const { client } = await boot()
  const model = await client.callAny('ui.contributions', {}) as {
    tools?: { id: string; contributionId: string | null }[]
    views: { id: string }[]
  }
  const automationTool = model.tools?.find((tool) => tool.contributionId === AUTOMATIONS_VIEW)
  const centerView = model.views.find((view) => view.id !== AUTOMATIONS_VIEW && view.id !== AUTOMATIONS_SETTINGS_VIEW)
  expect(automationTool).toBeDefined()
  expect(centerView).toBeDefined()
  if (!automationTool || !centerView) throw new Error('Automation tool and unrelated center view must be contributed')

  const movedSlot: UiToolSlot = 'right-bottom'
  const center = { id: centerView.id, input: { retained: true } }
  await client.callAny('ui.tool.move', { id: automationTool.id, slot: movedSlot })
  await client.callAny('ui.view.open', center)
  await client.callAny('ui.tool.open', { id: automationTool.id })

  const opened = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(opened.layout.tools?.placements[automationTool.id]).toBe(movedSlot)
  expect(opened.layout.tools?.open[movedSlot]).toBe(automationTool.id)
  expect(opened.layout.view).toEqual(center)
  const viewTabs = structuredClone(opened.layout.viewTabs)

  await client.callAny('quirky.automations/uiNavigate', { query: 'audit', status: 'paused' })
  let current = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(current.layout.view).toEqual(center)
  expect(current.layout.viewTabs).toEqual(viewTabs)

  await client.callAny('quirky.automations/openEditor', {})
  current = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(current.layout.view).toEqual(center)
  expect(current.layout.viewTabs).toEqual(viewTabs)
  expect(current.layout.tools?.open[movedSlot]).toBe(automationTool.id)
  expect((await client.callAny('quirky.automations/uiState', {}) as AutomationUiState).editor).not.toBeNull()

  await client.callAny('quirky.automations/close', {})
  current = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(current.layout.tools?.open[movedSlot]).toBeNull()
  expect(current.layout.view).toEqual(center)
  expect(current.layout.viewTabs).toEqual(viewTabs)

  await client.callAny('ui.tool.open', { id: automationTool.id })
  await client.callAny('quirky.automations/settings', {})
  expect((await client.callAny('ui.state', {}) as { layout: UiLayout }).layout.view).toEqual({ id: AUTOMATIONS_SETTINGS_VIEW })
  await client.callAny('quirky.automations/open', {})
  current = await client.callAny('ui.state', {}) as { layout: UiLayout }
  expect(current.layout.view).toEqual(center)
  expect(current.layout.viewTabs?.some((view) => view.id === AUTOMATIONS_VIEW)).toBe(false)
  expect(current.layout.tools?.open[movedSlot]).toBe(automationTool.id)
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
