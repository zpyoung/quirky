import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../../daemon/test/helpers'
import { writePlugin } from '../../daemon/test/plugins/fixtures'
import { startHeadlessWindow, type HeadlessWindow } from './fixtures/headless-window'

let harness: Harness | undefined
let window_: HeadlessWindow | undefined
afterEach(async () => { await window_?.stop(); window_ = undefined; await harness?.cleanup(); harness = undefined })

test('Settings opens a contributed preferences view and removes its link when its plugin is disabled', async () => {
  const home = makeTempHome()
  writePlugin(join(home, 'plugins'), {
    id: 'acme.preferences', name: 'Preferences fixture', version: '1.0.0', ui: 'ui.js',
    contributes: { view: [
      { id: 'preferences', title: 'Fixture preferences', settings: true },
      { id: 'ordinary', title: 'Ordinary work' }
    ] }
  }, { 'ui.js': `export function activate(context) {
    context.provide('view:acme.preferences/preferences', (element) => { element.textContent = 'Plugin preferences content'; return () => { element.textContent = '' } })
    context.provide('view:acme.preferences/ordinary', (element) => { element.textContent = 'Ordinary content' })
  }` })
  harness = await startHarness({ home })
  window_ = await startHeadlessWindow({ home, runtime: harness.runtime })
  await window_.click('button[aria-label="Settings"]')
  const button = await window_.waitFor(() => [...document.querySelectorAll('button')].find((el) => el.textContent === 'Fixture preferences'))
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Ordinary work')
  button.click()
  await window_.waitFor(() => document.body.textContent?.includes('Plugin preferences content'))
  const client = await harness.connect('cli')
  expect((await client.call('ui.state')).layout.view).toEqual({ id: 'view:acme.preferences/preferences' })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await window_.click('button[aria-label="Settings"]')
  await client.call('plugin.disable', { id: 'acme.preferences' })
  await window_.waitFor(() => ![...document.querySelectorAll('button')].some((el) => el.textContent === 'Fixture preferences'))
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Settings')
}, 20_000)
