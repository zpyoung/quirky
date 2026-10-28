import { afterEach, expect, test } from 'bun:test'
import type { UiKeybinding, UiModel } from '@quirky/protocol'
import { startHarness, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writePlugin } from './fixtures'

const running: Harness[] = []
afterEach(async () => {
  for (const harness of running.splice(0)) await harness.cleanup()
  removeTempDirs()
})

async function fixture() {
  const home = makeTempDir('qd-key-home-')
  const builtin = makeTempDir('qd-keys-')
  writePlugin(builtin, {
    id: 'acme.keys', name: 'Keys', version: '1.0.0', ui: 'ui.js',
    contributes: {
      command: [{ id: 'first', title: 'First' }, { id: 'second', title: 'Second' }],
      keybinding: [
        { id: 'first', key: 'mod+k', command: 'first', when: 'terminalFocus' },
        { id: 'second', key: 'mod+j', command: 'second', when: 'terminalFocus' }
      ]
    }
  }, { 'ui.js': 'export function activate() {}' })
  const start = async () => {
    const harness = await startHarness({ home, builtinPluginsDir: builtin })
    running.push(harness)
    return harness
  }
  const harness = await start()
  const client = await harness.connect()
  return { home, builtin, harness, client, start }
}

const first = 'keybinding:acme.keys/first'
const second = 'keybinding:acme.keys/second'

test('moving a binding frees its old chord and wins its new collision; disabling and resetting restores inheritance', async () => {
  const { client } = await fixture()
  const moved = await client.callAny('keybinding.set', { id: first, key: 'mod+j' }) as UiKeybinding[]
  expect(moved.find((entry) => entry.id === first)).toMatchObject({ key: 'mod+j', status: 'active', when: 'terminalFocus' })
  expect(moved.find((entry) => entry.id === second)).toMatchObject({ status: 'shadowed', shadowedBy: first })
  expect(moved.filter((entry) => entry.status === 'active').map((entry) => entry.key)).toEqual(['mod+j'])
  const disabled = await client.callAny('keybinding.set', { id: first, key: null }) as UiKeybinding[]
  expect(disabled.find((entry) => entry.id === first)?.status).toBe('unbound')
  expect(disabled.find((entry) => entry.id === second)?.status).toBe('active')
  const reset = await client.callAny('keybinding.reset', { id: first }) as UiKeybinding[]
  expect(reset.find((entry) => entry.id === first)).toMatchObject({ key: 'mod+k', status: 'active' })
  expect(reset.find((entry) => entry.id === second)?.status).toBe('active')
})

test('overrides persist across daemon restart and invalid writes preserve the effective mapping', async () => {
  const { harness, client, start } = await fixture()
  await client.callAny('keybinding.set', { id: first, key: 'shift+mod+l' })
  await expect(client.callAny('keybinding.set', { id: first, key: 'mod++' })).rejects.toThrow()
  await expect(client.callAny('keybinding.set', { id: 'keybinding:missing/unknown', key: 'mod+x' })).rejects.toThrow()
  client.close()
  await harness.daemon.stop()
  harness.pty.stop()
  const next = await start()
  const reopened = await next.connect()
  const model = await reopened.callAny('ui.contributions', {}) as UiModel
  expect(model.keybindings.find((entry) => entry.id === first)).toMatchObject({ key: 'mod+shift+l', status: 'active' })
  expect((await reopened.callAny('keybinding.list', {}) as UiKeybinding[]).find((entry) => entry.id === first)?.key).toBe('mod+shift+l')
})
