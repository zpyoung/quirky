import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import { cleanupAll, startAccounts, type AccountsHarness } from '../../quirky.accounts/test/support/index'
import { makeTempDir, removeTempDirs, writeModulePlugin } from '../../../packages/daemon/test/plugins/fixtures'

afterEach(async () => {
  await cleanupAll()
  removeTempDirs()
})

const sessionPlugins = ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal']
const call = <T>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

test('trusted launch-hook home overrides are effective custom homes, while configured homes remain effective without a hook', async () => {
  const h = await startAccounts({ plugins: sessionPlugins })
  const configuredHome = join(h.home, 'explicit-claude-home')
  const hookHome = join(h.home, 'extension-claude-home')
  await call(h, 'quirky.agents/configure', { agent: 'claude', env: { CLAUDE_CONFIG_DIR: configuredHome } })

  const configured = await call<Session>(h, 'quirky.session/create', { agent: 'claude', worktree: 'floating', cwd: h.userHome })
  expect(h.harness.pty.sessions.get(configured.id)?.env.CLAUDE_CONFIG_DIR).toBe(configuredHome)
  expect(await call(h, 'quirky.accounts/sessionHome', { session: configured.id })).toEqual({ provider: 'claude', home: configuredHome })

  const sourceRoot = makeTempDir()
  const hook = writeModulePlugin(
    join(sourceRoot, 'plugins'),
    join(sourceRoot, 'marker.log'),
    { id: 'acme.claude-home', contributes: { 'launch-hook': [{ id: 'home', agents: ['claude'] }] } },
    {
      activate: `context.provide('launch-hook:acme.claude-home/home', () => ({ env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(hookHome)} } }))`
    }
  )
  await call(h, 'plugin.install', { path: hook, yes: true })

  const launched = await call<Session>(h, 'quirky.session/create', { agent: 'claude', worktree: 'floating', cwd: h.userHome })
  expect(h.harness.pty.sessions.get(launched.id)?.env.CLAUDE_CONFIG_DIR).toBe(hookHome)
  expect(launched.launch?.env.CLAUDE_CONFIG_DIR).toBe(configuredHome)
  expect(await call(h, 'quirky.accounts/sessionHome', { session: launched.id })).toEqual({ provider: 'claude', home: hookHome })
})
