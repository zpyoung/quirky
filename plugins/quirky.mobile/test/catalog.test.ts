import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { MobileTestClient } from './support/client'
import { makeBuiltinDir } from '../../quirky.session/test/support'

let harness: Harness | undefined
let phone: MobileTestClient | undefined
let root: string | undefined
let environment: Map<string, string | undefined> | undefined

afterEach(async () => {
  await phone?.close()
  phone = undefined
  await harness?.cleanup()
  harness = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
  for (const [key, value] of environment ?? []) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  environment = undefined
})

test('phone launcher catalog exposes availability without configured commands or credentials', async () => {
  root = mkdtempSync(join(tmpdir(), 'quirky-phone-catalog-'))
  const home = join(root, 'quirky')
  const user = join(root, 'user')
  const search = join(root, 'agents')
  for (const dir of [home, user, search]) mkdirSync(dir)
  writeFileSync(join(search, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const patch = { HOME: user, QUIRKY_HOME: home, QUIRKY_MOBILE_PORT: '0', QUIRKY_MOBILE_HOST: '127.0.0.1', QUIRKY_AGENT_SEARCH_DIRS: search, CODEX_HOME: join(user, '.codex'), CLAUDE_CONFIG_DIR: join(user, '.claude') }
  environment = new Map(Object.keys(patch).map(key => [key, process.env[key]]))
  Object.assign(process.env, patch)
  harness = await startHarness({ home, builtinPluginsDir: makeBuiltinDir(home, { real: ['quirky.mobile', 'quirky.agents'], fakes: [] }) })
  const local = await harness.connect('cli')
  await local.callAny('quirky.agents/configure', { agent: 'claude', command: '/usr/bin/true', args: '--private-launch-token=not-for-phone', env: { MOBILE_PRIVATE_CREDENTIAL: 'server-only-catalog-secret' } })
  const privateConfig = await local.callAny('quirky.agents/get', { agent: 'claude' }) as { env: Record<string, string> }
  expect(privateConfig.env.MOBILE_PRIVATE_CREDENTIAL).toBe('server-only-catalog-secret')
  const offer = await local.callAny('quirky.mobile/pair', { address: '127.0.0.1' }) as { pairingUrl: string; endpoint: string }
  const pairing = JSON.parse(Buffer.from(new URL(offer.pairingUrl).searchParams.get('code')!, 'base64url').toString())
  phone = MobileTestClient.connect(offer.endpoint, pairing.publicKeyB64, pairing.deviceToken)
  await phone.authenticated
  await expect(phone.call('quirky.agents/list')).rejects.toMatchObject({ code: -32001 })
  const catalog = await phone.call('quirky.mobile/agentCatalog') as { defaultAgent: string | null; agents: { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean; resumable: boolean }[] }
  const claude = catalog.agents.find(agent => agent.id === 'claude')
  expect(claude).toMatchObject({ id: 'claude', installed: true, enabled: true })
  expect(claude && Object.keys(claude).sort()).toEqual(['enabled', 'id', 'installed', 'isDefault', 'label', 'resumable'])
  expect(JSON.stringify(catalog)).not.toContain('server-only-catalog-secret')
  expect(JSON.stringify(catalog)).not.toContain('not-for-phone')
})
