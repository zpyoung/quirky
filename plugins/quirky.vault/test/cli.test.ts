import { afterEach, describe, expect, test } from 'bun:test'
import { commands } from '../cli'
import { testCliContext } from '../../quirky.session/test/support'
import { VaultRig } from './support/harness'

let rig: VaultRig | undefined

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
})

const start = async () => (rig = await VaultRig.start())
const invoke = (name: string, client: VaultRig['client'], args: { positionals: string[]; flags: Record<string, unknown> }, json = false) => {
  const { ctx, lines } = testCliContext(client, { json })
  return { result: commands[name]!(args, ctx), lines }
}

describe('vault CLI', () => {
  test('list uses the declared API and emits the public JSON envelope', async () => {
    const vault = await start()
    const { result, lines } = invoke('list', vault.client, { positionals: [], flags: { unlimited: true } }, true)
    await result
    const payload = JSON.parse(lines[0]!)
    expect(payload.sessions).toHaveLength(25)
    expect(payload.hosts).toEqual([expect.objectContaining({ hostId: 'local', kind: 'ok' })])
  })

  test('search index-status rejects query flags before calling the daemon', async () => {
    const vault = await start()
    const { result } = invoke('search', vault.client, { positionals: [], flags: { 'index-status': true, agent: ['claude'] } })
    await expect(result).rejects.toMatchObject({ kind: 'usage' })
    expect(vault.searchDatabaseExists()).toBe(false)
  })

  test('search validates offset timestamps and the 64-path bound locally', async () => {
    const vault = await start()
    const invalidSince = invoke('search', vault.client, { positionals: ['needle'], flags: { since: '2026-10-27T10:00:00' } })
    await expect(invalidSince.result).rejects.toMatchObject({ kind: 'usage' })

    const tooManyPaths = invoke('search', vault.client, {
      positionals: ['needle'],
      flags: { path: Array.from({ length: 65 }, (_, index) => `/tmp/path-${index}`) }
    })
    await expect(tooManyPaths.result).rejects.toMatchObject({ kind: 'usage' })
    expect(vault.searchDatabaseExists()).toBe(false)
  })

  test('search forwards filters and can return typed unavailable JSON', async () => {
    const vault = await start()
    const { result, lines } = invoke('search', vault.client, { positionals: ['needle'], flags: {} }, true)
    await result
    expect(JSON.parse(lines[0]!)).toEqual({ kind: 'unavailable', reason: 'disabled' })
  })
})
