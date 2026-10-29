import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { loadViewMenuSettings, toggleViewMenuSetting } from '../src/bun/view-menu'

let harness: Harness | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })

test('a plugin-declared View menu switch remains scriptable and disappears when its plugin is disabled', async () => {
  const home = makeTempHome('qmenu-')
  const pluginDir = join(home, 'plugins', 'acme.menu')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'quirky-plugin.json'), JSON.stringify({ id: 'acme.menu', apiVersion: '1.0.0', name: 'Menu fixture', version: '1.0.0', contributes: { setting: [{ id: 'visible', type: 'boolean', default: true, title: 'Show fixture', menu: 'view' }] } }))
  harness = await startHarness({ home })
  const client = await harness.connect('cli')
  const call = (method: string, params: Record<string, unknown>) => client.callAny(method, params)
  expect(await loadViewMenuSettings(call)).toEqual([{ id: 'setting:acme.menu/visible', label: 'Show fixture', checked: true }])
  const initial = await client.callAny('setting.get', { id: 'setting:acme.menu/visible' }) as { value: boolean }
  expect(initial.value).toBe(true)
  await client.callAny('setting.set', { id: 'setting:acme.menu/visible', value: false })
  const hidden = await client.callAny('setting.get', { id: 'setting:acme.menu/visible' }) as { value: boolean }
  expect(hidden.value).toBe(false)
  await toggleViewMenuSetting(call, 'setting:acme.menu/visible')
  expect(await loadViewMenuSettings(call)).toEqual([{ id: 'setting:acme.menu/visible', label: 'Show fixture', checked: true }])
  await client.callAny('plugin.disable', { id: 'acme.menu' })
  await expect(client.callAny('setting.get', { id: 'setting:acme.menu/visible' })).rejects.toThrow()
  expect(await loadViewMenuSettings(call)).toEqual([])
  await expect(toggleViewMenuSetting(call, 'setting:acme.menu/visible')).rejects.toThrow()
  await client.callAny('plugin.enable', { id: 'acme.menu' })
  const restored = await client.callAny('setting.get', { id: 'setting:acme.menu/visible' }) as { value: boolean }
  expect(restored.value).toBe(true)
}, 20_000)
