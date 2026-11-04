import { afterEach, describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_TOKEN_HEADER, type PluginInfo, type ToolGateDecision } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from './helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './plugins/fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type PostOptions = { agent?: string; query?: string; body?: string; token?: string | null }

type GatePlugin = { id: string; agents?: string[]; provider: string }

function gatePlugin({ id, agents, provider }: GatePlugin): { manifest: { id: string } & Record<string, unknown>; behavior: ModuleBehavior } {
  return {
    manifest: { id, contributes: { 'tool-gate': [{ id: 'gate', ...(agents ? { agents } : {}) }] } },
    behavior: { activate: `context.provide('tool-gate:${id}/gate', ${provider})` }
  }
}

async function boot(plugins: GatePlugin[] = []) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const plugin of plugins) {
    const { manifest, behavior } = gatePlugin(plugin)
    writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  }
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const base = `http://127.0.0.1:${harness.runtime.port}`
  return {
    harness,
    marker,
    post(options: PostOptions = {}) {
      const token = options.token === undefined ? harness.runtime.hookToken : options.token
      return fetch(`${base}/gate/${options.agent ?? 'claude'}?${options.query ?? 'session=s1&event=PreToolUse&deadline=5000'}`, {
        method: 'POST',
        body: options.body ?? '{"tool_name":"Bash"}',
        headers: token === null ? {} : { [HOOK_TOKEN_HEADER]: token }
      })
    },
    async decide(options?: PostOptions) {
      const response = await this.post(options)
      expect(response.status).toBe(200)
      return (await response.json()) as ToolGateDecision
    }
  }
}

const allow = `async (request) => ({ decision: 'allow', reason: JSON.stringify(request), encoded: '{"ok":true}', exitCode: 0 })`

describe('/gate route', () => {
  test('401 without the hook token and with a wrong one', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ token: null })).status).toBe(401)
    expect((await s.post({ token: 'wrong' })).status).toBe(401)
  })

  test('400 on a body that is not JSON', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ body: 'not json' })).status).toBe(400)
  })

  test('400 without a session', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    expect((await s.post({ query: 'event=PreToolUse' })).status).toBe(400)
  })

  test('no provider: 200 with an unavailable decision and no encoded answer', async () => {
    const s = await boot()
    const decision = await s.decide()
    expect(decision.decision).toBe('unavailable')
    expect(decision.encoded).toBeNull()
    expect(decision.reason).not.toBe('')
  })

  test('hands the provider the request and returns its decision', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({ agent: 'codex', query: 'session=s9&event=Stop&deadline=7000', body: '{"a":1}' })
    expect(decision).toMatchObject({ decision: 'allow', encoded: '{"ok":true}', exitCode: 0 })
    expect(JSON.parse(decision.reason)).toEqual({
      agent: 'codex',
      sessionId: 's9',
      event: 'Stop',
      deadlineMs: 7000,
      payload: { a: 1 }
    })
  })

  test('takes the event from the payload when the query has none', async () => {
    const s = await boot([{ id: 'acme.gate', provider: allow }])
    const decision = await s.decide({ query: 'session=s1', body: '{"hook_event_name":"PreToolUse"}' })
    expect(JSON.parse(decision.reason).event).toBe('PreToolUse')
  })

  test('a provider that throws yields unavailable, never allow', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `async () => { throw new Error('boom') }` }])
    const decision = await s.decide()
    expect(decision).toMatchObject({ decision: 'unavailable', encoded: null })
    expect(decision.reason).toContain('boom')
  })

  test('a provider that returns something else yields unavailable', async () => {
    const s = await boot([{ id: 'acme.gate', provider: `async () => ({ decision: 'maybe' })` }])
    expect((await s.decide()).decision).toBe('unavailable')
  })

  test('a provider that outlives deadlineMs yields unavailable and its signal aborts', async () => {
    const s = await boot([
      {
        id: 'acme.gate',
        provider: `(request, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => { record('aborted'); resolve({ decision: 'allow', reason: 'late', encoded: '{}' }) })
        })`
      }
    ])
    const started = Date.now()
    const decision = await s.decide({ query: 'session=s1&event=PreToolUse&deadline=300' })
    expect(decision).toMatchObject({ decision: 'unavailable', encoded: null })
    expect(Date.now() - started).toBeLessThan(3000)
    await waitFor(() => (readMarker(s.marker).includes('aborted') ? true : undefined))
  })

  test('a provider limited to other agents is not asked', async () => {
    const s = await boot([{ id: 'acme.gate', agents: ['claude'], provider: allow }])
    expect((await s.decide({ agent: 'claude' })).decision).toBe('allow')
    expect((await s.decide({ agent: 'codex' })).decision).toBe('unavailable')
  })

  test('only POST is accepted', async () => {
    const s = await boot()
    const response = await fetch(`http://127.0.0.1:${s.harness.runtime.port}/gate/claude?session=s1`)
    expect(response.status).toBe(405)
  })
})

describe('tool-gate registration', () => {
  test('a second plugin declaring tool-gate is invalid with a clear error and the first still answers', async () => {
    const s = await boot([
      { id: 'acme.first', provider: allow },
      { id: 'acme.second', provider: allow }
    ])
    const client = await s.harness.connect()
    const listed = (await client.call('plugin.list', {})) as PluginInfo[]
    const first = listed.find((plugin) => plugin.id === 'acme.first')!
    const second = listed.find((plugin) => plugin.id === 'acme.second')!
    expect(first.state).not.toBe('invalid')
    expect(second.state).toBe('invalid')
    expect(second.diagnostics.map((item) => item.message)).toEqual(['only one plugin may declare tool-gate; acme.first already does'])
    expect((await s.decide()).decision).toBe('allow')
  })

  test('tool-gate rejects unknown fields and a malformed agents list', async () => {
    const home = makeTempHome()
    const marker = join(makeTempDir(), 'marker.log')
    writeModulePlugin(join(home, 'plugins'), marker, {
      id: 'acme.bad',
      contributes: { 'tool-gate': [{ id: 'gate', agents: 'claude', extra: 1 }] }
    })
    h = await startHarness({ home, builtinPluginsDir: null })
    const client = await h.connect()
    const bad = ((await client.call('plugin.list', {})) as PluginInfo[]).find((plugin) => plugin.id === 'acme.bad')!
    expect(bad.state).toBe('invalid')
    const messages = bad.diagnostics.map((item) => item.message).join('\n')
    expect(messages).toContain('unknown field `extra`')
    expect(messages).toContain('agents must be a list of agent names')
  })
})

describe('quirky-gate shim installation', () => {
  test('the daemon writes an executable quirky-gate next to quirky-hook', async () => {
    const s = await boot()
    const hook = statSync(join(s.harness.home, 'bin', 'quirky-hook'))
    const gate = statSync(join(s.harness.home, 'bin', 'quirky-gate'))
    expect(gate.mode & 0o777).toBe(0o755)
    expect(hook.mode & 0o777).toBe(0o755)
  })
})
