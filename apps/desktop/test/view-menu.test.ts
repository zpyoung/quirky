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

test('a View menu row is omitted, and its toggle refused, while its whenSetting sibling is not true', async () => {
  const home = makeTempHome('qmenu-')
  const pluginDir = join(home, 'plugins', 'acme.gated')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'quirky-plugin.json'), JSON.stringify({
    id: 'acme.gated',
    apiVersion: '1.2.0',
    name: 'Gated fixture',
    version: '1.0.0',
    contributes: {
      setting: [
        { id: 'enabled', type: 'boolean', default: false, title: 'Enable fixture' },
        { id: 'panel', type: 'boolean', default: true, title: 'Show panel', menu: 'view', whenSetting: 'enabled' },
        { id: 'plain', type: 'boolean', default: true, title: 'Show plain', menu: 'view' }
      ]
    }
  }))
  harness = await startHarness({ home })
  const client = await harness.connect('cli')
  const call = (method: string, params: Record<string, unknown>) => client.callAny(method, params)
  const listed = await client.callAny('setting.list', { pluginId: 'acme.gated' }) as Array<{ id: string; whenSetting?: string }>
  expect(listed.find((entry) => entry.id === 'setting:acme.gated/panel')?.whenSetting).toBe('enabled')

  expect((await loadViewMenuSettings(call)).map((item) => item.id)).toEqual(['setting:acme.gated/plain'])
  await expect(toggleViewMenuSetting(call, 'setting:acme.gated/panel')).rejects.toThrow()
  expect(((await client.callAny('setting.get', { id: 'setting:acme.gated/panel' })) as { value: boolean }).value).toBe(true)

  await client.callAny('setting.set', { id: 'setting:acme.gated/enabled', value: true })
  expect((await loadViewMenuSettings(call)).map((item) => item.id)).toEqual(['setting:acme.gated/panel', 'setting:acme.gated/plain'])
  await toggleViewMenuSetting(call, 'setting:acme.gated/panel')
  expect(((await client.callAny('setting.get', { id: 'setting:acme.gated/panel' })) as { value: boolean }).value).toBe(false)
}, 20_000)
