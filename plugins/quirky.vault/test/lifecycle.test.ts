import { afterEach, describe, expect, test } from 'bun:test'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())

const pluginState = async (vault: VaultRig) => {
  const plugins = (await vault.client.callAny('plugin.list', {})) as { id: string; state: string }[]
  return plugins.find((plugin) => plugin.id === 'quirky.vault')?.state
}

describe('vault worker lifecycle', () => {
  test('vault activation and browse create no search database before explicit consent', async () => {
    const vault = await start()
    expect(await pluginState(vault)).toBe('inactive')
    expect(vault.searchDatabaseExists()).toBe(false)

    await vault.call('list', { agents: ['claude'], unlimited: true })

    expect(await pluginState(vault)).toBe('active')
    expect(vault.searchDatabaseExists()).toBe(false)
    expect(vault.events.some((event) => event.type === 'quirky.vault/scanProgress')).toBe(true)
  })

  test('disabling closes the plugin-owned worker and re-enabling services a fresh request', async () => {
    const vault = await start()
    await vault.call('list', { agents: ['claude'], unlimited: true })
    await vault.client.callAny('plugin.disable', { id: 'quirky.vault' })
    expect(await pluginState(vault)).toBe('disabled')

    await vault.client.callAny('plugin.enable', { id: 'quirky.vault' })
    expect(await pluginState(vault)).toBe('inactive')
    const result = await vault.call<any>('list', { agents: ['claude'], unlimited: true })
    expect(result.sessions).toHaveLength(1)
    expect(await pluginState(vault)).toBe('active')
  })

  test('daemon shutdown drains plugin workers without a scanner child process', async () => {
    const vault = await start()
    await vault.call('list', { agents: ['claude'], unlimited: true })

    await expect(vault.h.daemon.stop()).resolves.toBeUndefined()
    vault.h.pty.stop()
    expect(vault.h.pty.requests.some((request) => request.type === 'create')).toBe(false)
  })
})
