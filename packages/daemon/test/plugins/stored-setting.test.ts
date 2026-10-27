import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { removeTempDirs, writePlugin } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

const reader = (settings: object[]) => ({
  id: 'acme.reader',
  name: 'Reader',
  version: '1.0.0',
  main: 'main.ts',
  contributes: {
    method: [{ id: 'read', params: { type: 'object', additionalProperties: true } }],
    ...(settings.length > 0 ? { setting: settings } : {})
  }
})

const SOURCE = `
export function activate(context: any) {
  context.provide('method:acme.reader/read', (params: any) => {
    const value = context.storedSettingValue(params.id)
    return { defined: value !== undefined, value: value === undefined ? null : value }
  })
}
`

describe('PluginContext.storedSettingValue', () => {
  test('returns the stored value of a setting no plugin declares any more', async () => {
    const home = makeTempHome('qd-stored-')
    const plugins = join(home, 'plugins')
    writePlugin(plugins, reader([{ id: 'old', type: 'boolean', title: 'Old', default: true }]), { 'main.ts': SOURCE })
    h = await startHarness({ home, builtinPluginsDir: null })
    let client = await h.connect()
    await client.callAny('setting.set', { id: 'setting:acme.reader/old', value: false })
    for (const c of h.clients) c.close()
    await h.daemon.stop()
    h.pty.stop()

    writePlugin(plugins, reader([]), { 'main.ts': SOURCE })
    h = await startHarness({ home, builtinPluginsDir: null })
    client = await h.connect()
    expect(await client.callAny('acme.reader/read', { id: 'setting:acme.reader/old' })).toEqual({ defined: true, value: false })
  })

  test('is undefined when nothing is stored, even for a declared setting with a default', async () => {
    const home = makeTempHome('qd-stored-')
    writePlugin(join(home, 'plugins'), reader([{ id: 'kept', type: 'boolean', title: 'Kept', default: true }]), { 'main.ts': SOURCE })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    expect(await client.callAny('acme.reader/read', { id: 'setting:acme.reader/kept' })).toEqual({ defined: false, value: null })
    expect(await client.callAny('acme.reader/read', { id: 'setting:acme.reader/never' })).toEqual({ defined: false, value: null })
  })
})
