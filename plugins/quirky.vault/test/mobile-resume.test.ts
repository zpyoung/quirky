import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startHarness, builtinsDir, type Harness } from '../../../packages/daemon/test/helpers'
import { writeEveryAgentFixture } from './fixtures/scanner-fixtures'
import type { PublicListResult } from '../src/types'
import type { Session } from '@quirky/protocol'

let harness: Harness | undefined
let root: string | undefined
let environment: Map<string, string | undefined> | undefined

afterEach(async () => {
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

test('mobile history omits launch credentials while local resume metadata remains available', async () => {
  root = mkdtempSync(join(tmpdir(), 'quirky-mobile-vault-'))
  const userHome = join(root, 'user')
  const sourceHome = join(root, 'sources')
  const home = join(root, 'quirky')
  const agentBin = join(root, 'agents')
  for (const dir of [userHome, sourceHome, home, agentBin]) mkdirSync(dir, { recursive: true })
  const patch = { HOME: userHome, QUIRKY_HOME: home, QUIRKY_VAULT_SOURCE_HOME: sourceHome, QUIRKY_AGENT_SEARCH_DIRS: agentBin, QUIRKY_MOBILE_PORT: '0', CODEX_HOME: join(sourceHome, '.codex') }
  environment = new Map(Object.keys(patch).map(key => [key, process.env[key]]))
  Object.assign(process.env, patch)
  await writeEveryAgentFixture(sourceHome, { cwdRoot: join(root, 'working') })
  harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  const local = await harness.connect('cli')
  await local.callAny('quirky.agents/configure', { agent: 'claude', command: '/usr/bin/true', args: '', env: { MOBILE_PRIVATE_CREDENTIAL: 'server-only-owned-secret' } })
  const listed = await local.callAny('quirky.vault/list', { host: 'local', unlimited: true }) as PublicListResult
  const source = listed.sessions.find(session => session.agent === 'claude')
  if (!source) throw new Error('owned Claude source fixture was not indexed')
  const mobile = await harness.connect('mobile')
  const resumed = await mobile.callAny('quirky.vault/resume', { id: source.id }) as Session
  expect(resumed.id).toEqual(expect.any(String))
  expect(resumed.worktreeId).toEqual(expect.any(String))
  expect(JSON.stringify(resumed)).not.toContain('server-only-owned-secret')
  expect(resumed.launch).toBeUndefined()
  const localSession = await local.callAny('quirky.session/get', { session: resumed.id }) as Session
  expect(localSession.launch?.env.MOBILE_PRIVATE_CREDENTIAL).toBe('server-only-owned-secret')
}, 30000)
