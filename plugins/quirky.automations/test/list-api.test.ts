import { afterEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { makeTempHome } from '../../../packages/daemon/test/helpers'

const fixtures: PluginHarness[] = []
const homes: string[] = []

async function start() {
  const home = makeTempHome('qa-automation-list-api-')
  homes.push(home)
  const fixture = await startPluginHarness({ plugins: ['quirky.automations'], fakeSession: false, home })
  fixtures.push(fixture)
  return fixture
}

const call = (fixture: PluginHarness, method: string, params: Record<string, unknown> = {}) => fixture.client.callAny(method, params)

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('public automation navigation applies patches without losing selection and filter state', async () => {
  const fixture = await start()
  const initial = await call(fixture, 'quirky.automations/uiState') as { navigation: Record<string, unknown> }
  expect(initial.navigation).toMatchObject({ page: 'list', host: 'all', query: '', runQuery: '' })

  const filtered = await call(fixture, 'quirky.automations/uiNavigate', { query: 'release', host: 'local' }) as { navigation: Record<string, unknown> }
  expect(filtered.navigation).toMatchObject({ page: 'list', query: 'release', host: 'local' })

  const dashboard = await call(fixture, 'quirky.automations/uiNavigate', { page: 'runs', host: 'all', runStatus: 'failed' }) as { navigation: Record<string, unknown> }
  expect(dashboard.navigation).toMatchObject({ page: 'runs', query: 'release', host: 'all', runStatus: 'failed' })

  const detail = await call(fixture, 'quirky.automations/uiNavigate', { page: 'detail', automationId: 'selected-automation', tab: 'runs' }) as { navigation: Record<string, unknown> }
  expect(detail.navigation).toMatchObject({ page: 'detail', automationId: 'selected-automation', tab: 'runs', query: 'release' })

  const run = await call(fixture, 'quirky.automations/uiNavigate', { page: 'run', runId: 'selected-run', automationId: 'selected-automation' }) as { navigation: Record<string, unknown> }
  expect(run.navigation).toMatchObject({ page: 'run', runId: 'selected-run', automationId: 'selected-automation', tab: 'runs' })
  expect((await call(fixture, 'quirky.automations/uiState') as { navigation: Record<string, unknown> }).navigation).toEqual(run.navigation)
})

test('sidebar and delete-confirmation settings are read and written through public settings APIs', async () => {
  const fixture = await start()
  const setting = async (id: string, value: boolean) => {
    await call(fixture, 'setting.set', { id, value })
    return call(fixture, 'setting.get', { id }) as Promise<{ value: boolean }>
  }

  expect(await setting('setting:quirky.automations/show-automations-button', false)).toMatchObject({ value: false })
  expect(await setting('setting:quirky.automations/show-automations-button', true)).toMatchObject({ value: true })
  expect(await setting('setting:quirky.automations/ask-before-delete', false)).toMatchObject({ value: false })
  expect(await setting('setting:quirky.automations/ask-before-delete', true)).toMatchObject({ value: true })
})
