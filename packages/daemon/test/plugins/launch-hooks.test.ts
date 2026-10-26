import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Plugin = { manifest: { id: string } & Record<string, unknown>; behavior?: ModuleBehavior }

/** Starts a daemon with only the given installed plugins, a repo with one worktree, and a CLI client. */
async function boot(plugins: Plugin[], options: { launchHookTimeoutMs?: number } = {}) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of plugins) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const harness = await startHarness({ home, builtinPluginsDir: null, ...options })
  h = harness
  const client: QuirkyClient = await harness.connect()
  harness.git.addRepo('/fake/alpha')
  const repo = await client.call('repo.add', { path: '/fake/alpha' })
  const [worktree] = await client.call('worktree.list', { repoId: repo.id })

  async function createSession(agent: 'claude' | 'shell', prompt?: string) {
    const session = await client.call('session.create', { worktreeId: worktree!.id, agent, ...(prompt ? { prompt } : {}) })
    const request = harness.pty.requests.find((r) => r.type === 'create' && r.sessionId === session.id)
    if (!request || request.type !== 'create') throw new Error('no create request')
    return { session, request }
  }
  return { harness, client, home, lines: () => readMarker(marker), createSession }
}

const hookPlugin = (id: string, hook: string, source: string, agents?: string[]): Plugin => ({
  manifest: { id, contributes: { 'launch-hook': [{ id: hook, ...(agents ? { agents } : {}) }] } },
  behavior: { activate: `context.provide('launch-hook:${id}/${hook}', ${source})` }
})

const envHook = hookPlugin('acme.env', 'vars', "() => ({ env: { ACME_TOKEN: 'abc' }, args: ['--model', 'opus'] })", ['claude'])

describe('launch hooks', () => {
  test('SC-22: a launch hook adds environment and arguments to an agent session', async () => {
    const s = await boot([envHook])
    const { request } = await s.createSession('claude', 'hi')
    expect(request.env.ACME_TOKEN).toBe('abc')
    expect(request.argv[0]).toBe('/bin/zsh')
    expect(request.argv[3]).toBe(
      `export PATH="${s.home}/bin:$PATH"; exec claude --settings '${s.home}/hooks/claude-settings.json' '--model' 'opus' 'hi'`
    )
    expect(request.argv[3]).toMatch(/exec claude --settings '[^']+' '--model' 'opus' 'hi'$/)
  })

  test("SC-23: a hook for other agents doesn't run, or load", async () => {
    const s = await boot([envHook])
    const { request } = await s.createSession('shell')
    expect(request.env.ACME_TOKEN).toBeUndefined()
    expect(s.lines()).toEqual([])
  })

  test('SC-24: several hooks run in ID order and see each other\'s changes', async () => {
    const s = await boot([
      hookPlugin('acme.b', 'second', "(launch) => ({ env: { STAGE: (launch.env.STAGE ?? '') + 'b' } })"),
      hookPlugin('acme.a', 'first', "() => ({ env: { STAGE: 'a' } })")
    ])
    const { request } = await s.createSession('claude')
    expect(request.env.STAGE).toBe('ab')
  })

  test("SC-25: a hook can't change the kernel's variables, and a broken hook doesn't block the launch", async () => {
    const timeoutMs = 300
    const s = await boot(
      [
        hookPlugin('acme.a', 'reserved', "() => ({ env: { QUIRKY_SESSION_ID: 'x', PATH: '/evil', OK: '1' } })"),
        hookPlugin('acme.b', 'throws', "() => { throw new Error('nope') }"),
        hookPlugin('acme.c', 'hangs', '() => new Promise(() => {})')
      ],
      { launchHookTimeoutMs: timeoutMs }
    )
    const started = Date.now()
    const { session, request } = await s.createSession('claude', 'hi')
    expect(Date.now() - started).toBeLessThan(timeoutMs + 1500)

    expect(request.env.QUIRKY_SESSION_ID).toBe(session.id)
    expect(request.env.PATH.startsWith(`${s.home}/bin:`)).toBe(true)
    expect(request.env.PATH).not.toContain('/evil')
    expect(request.env.OK).toBe('1')

    const plugins = await s.client.call('plugin.list', {})
    const warnings = (id: string) =>
      plugins
        .find((plugin) => plugin.id === id)!
        .diagnostics.filter((diagnostic) => diagnostic.level === 'warning')
        .map((diagnostic) => diagnostic.message)
    expect(warnings('acme.a')).toEqual([
      'launch hook launch-hook:acme.a/reserved tried to set reserved variable QUIRKY_SESSION_ID',
      'launch hook launch-hook:acme.a/reserved tried to set reserved variable PATH'
    ])
    expect(warnings('acme.b')).toEqual(['launch hook launch-hook:acme.b/throws failed: nope'])
    expect(warnings('acme.c')).toEqual(['launch hook launch-hook:acme.c/hangs timed out after 300 ms'])
  })

  test("SC-26: a disabled hook isn't applied", async () => {
    const s = await boot([envHook])
    await s.client.call('plugin.disable', { id: 'launch-hook:acme.env/vars' })
    const { request } = await s.createSession('claude', 'hi')
    expect(request.env.ACME_TOKEN).toBeUndefined()
    expect(request.argv[3]).not.toContain('--model')
  })
})
