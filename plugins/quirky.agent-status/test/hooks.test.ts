import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcError, RpcErrorCode, type PluginContext } from '@quirky/protocol'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { testCliContext } from '../../quirky.session/test/support'
import { commands } from '../cli'
import { HooksService } from '../src/hooks'
import { INSTALLERS, installerFor } from '../src/install/registry'
import { geminiInstaller } from '../src/install/other-json'
import { Rig, waitFor } from './support'

const HOOKS = 'setting:quirky.agent-status/hooks'

const ENV_NAMES = [
  'HOME',
  'XDG_CONFIG_HOME',
  'GROK_HOME',
  'COPILOT_HOME',
  'HERMES_HOME',
  'KIMI_CODE_HOME',
  'DSH_HOME',
  'JCODE_HOME',
  'KIRO_HOME',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'MIMOCODE_HOME',
  'PI_CODING_AGENT_DIR',
  'PRIME_AGENT_CODING_AGENT_DIR',
  'QUIRKY_TEST_FAKE_AGENTS'
]
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

type Presence = 'on' | 'disabled' | 'missing'
type Setup = { agent: string; status: string; changed: string[]; note?: string; message?: string }
type Removal = { agent: string; changed: string[]; message?: string }
type Status = { agent: string; status: string; files: string[]; message?: string }

let userHome: string
let rig: Rig | undefined

beforeEach(() => {
  for (const name of ENV_NAMES) delete process.env[name]
  userHome = makeTempDir('qas-user-')
  process.env.HOME = userHome
})

afterEach(async () => {
  await rig?.cleanup()
  rig = undefined
  removeTempDirs()
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const listing = (presence: Record<string, Presence>) =>
  Object.entries(presence).map(([id, state]) => ({ id, installed: state !== 'missing', enabled: state === 'on' }))

/**
 * Starts a daemon with the fake quirky.agents reporting `presence`. By default the agents appear
 * after activation, so the startup install has nothing to do; `atStartup` has them there from the start.
 */
async function start(presence: Record<string, Presence>, options: { atStartup?: boolean } = {}): Promise<Rig> {
  if (options.atStartup) process.env.QUIRKY_TEST_FAKE_AGENTS = JSON.stringify(listing(presence))
  rig = await Rig.start({ sessions: [] })
  if (!options.atStartup) await rig.client.callAny('quirky.agents/setAgents', { agents: listing(presence) })
  return rig
}

const put = (rel: string, content: string | object): string => {
  const path = join(userHome, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  return path
}

const setup = async (agent?: string) =>
  (await rig!.client.callAny('quirky.agent-status/hooksSetup', agent ? { agent } : {})) as Setup[]
const remove = async (agent?: string) =>
  (await rig!.client.callAny('quirky.agent-status/hooksRemove', agent ? { agent } : {})) as Removal[]
const status = async () => (await rig!.client.callAny('quirky.agent-status/hooksStatus', {})) as Status[]
const statusOf = async (agent: string) => (await status()).find((entry) => entry.agent === agent)?.status

const failure = async (promise: Promise<unknown>): Promise<RpcError> => {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected a failure')
}

describe('the registry', () => {
  test('lists every installer once and leaves out the agents that use the per-launch settings file', () => {
    const agents = INSTALLERS.map((installer) => installer.agent)
    expect(new Set(agents).size).toBe(agents.length)
    expect([...agents].sort()).toEqual(
      [
        'amp', 'antigravity', 'codebuddy', 'codex', 'command-code', 'copilot', 'cursor', 'devin', 'droid', 'dsh', 'gemini', 'grok',
        'hermes', 'jcode', 'kimi', 'kiro', 'mimo-code', 'muse', 'omp', 'openclaude', 'opencode', 'opencode2', 'pi', 'prime-agent',
        'qoder', 'qoder-cn', 'qwen-code', 'zcode'
      ]
    )
    expect(installerFor('claude')).toBeUndefined()
    expect(installerFor('claude-agent-teams')).toBeUndefined()
    expect(installerFor('gemini')).toBe(geminiInstaller)
  })
})

describe('SC-24: setting up one agent is safe to rerun', () => {
  test('gemini setup twice changes nothing the second time, and remove restores the file', async () => {
    const original = { theme: 'dark', hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'notify.sh' }] }] } }
    const path = put('.gemini/settings.json', original)
    const originalBytes = readFileSync(path, 'utf8')
    await start({ gemini: 'on' })

    const first = await setup('gemini')
    expect(first).toEqual([{ agent: 'gemini', status: 'installed', changed: [path] }])
    const installed = JSON.parse(readFileSync(path, 'utf8'))
    expect(installed.theme).toBe('dark')
    expect(Object.keys(installed.hooks).sort()).toEqual(['AfterAgent', 'AfterTool', 'BeforeAgent', 'BeforeTool'])
    expect(installed.hooks.AfterAgent[0]).toEqual(original.hooks.AfterAgent[0])
    const afterFirst = readFileSync(path, 'utf8')

    expect(await setup('gemini')).toEqual([{ agent: 'gemini', status: 'installed', changed: [] }])
    expect(readFileSync(path, 'utf8')).toBe(afterFirst)

    expect(await remove('gemini')).toEqual([{ agent: 'gemini', changed: [path] }])
    expect(readFileSync(path, 'utf8')).toBe(originalBytes)
    expect(await remove('gemini')).toEqual([{ agent: 'gemini', changed: [] }])
  })

  test('the CLI prints the changed path under ~, then the agent line', async () => {
    const path = put('.gemini/settings.json', { theme: 'dark' })
    await start({ gemini: 'on' })
    const { ctx, lines } = testCliContext(rig!.client, { env: { HOME: userHome } })

    await commands['hooks-setup']!({ positionals: ['gemini'], flags: {} }, ctx)
    await commands['hooks-setup']!({ positionals: ['gemini'], flags: {} }, ctx)
    await commands['hooks-remove']!({ positionals: ['gemini'], flags: {} }, ctx)

    expect(lines).toEqual(['changed ~/.gemini/settings.json\ngemini: installed', 'gemini: installed', 'changed ~/.gemini/settings.json\ngemini: removed'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'dark' })
  })
})

describe('SC-26: what setup says about skipped agents and unreadable configs', () => {
  test('reports agent_disabled, cli_not_found and error, and leaves the unparseable file alone', async () => {
    const broken = put('.factory/settings.json', '{ not json')
    await start({ gemini: 'disabled', droid: 'on' })

    const results = await setup()
    const by = (agent: string) => results.find((entry) => entry.agent === agent)!
    expect(by('gemini')).toEqual({ agent: 'gemini', status: 'agent_disabled', changed: [] })
    expect(by('cursor')).toEqual({ agent: 'cursor', status: 'cli_not_found', changed: [] })
    expect(by('droid')).toEqual({ agent: 'droid', status: 'error', changed: [], message: 'Could not parse ~/.factory/settings.json' })
    expect(readFileSync(broken, 'utf8')).toBe('{ not json')
    expect(existsSync(join(userHome, '.gemini'))).toBe(false)
    expect(results.map((entry) => entry.agent)).toEqual(INSTALLERS.map((installer) => installer.agent))
  })

  test('status lists every agent with one of the six values', async () => {
    put('.factory/settings.json', '{ not json')
    await start({ gemini: 'disabled', droid: 'on', codex: 'on' })
    await setup('codex')

    const entries = await status()
    expect(entries.map((entry) => entry.agent)).toEqual(INSTALLERS.map((installer) => installer.agent))
    const by = (agent: string) => entries.find((entry) => entry.agent === agent)!
    expect(by('codex').status).toBe('installed')
    expect(by('codex').files).toEqual([join(userHome, '.codex', 'hooks.json')])
    expect(by('gemini').status).toBe('agent_disabled')
    expect(by('cursor').status).toBe('cli_not_found')
    expect(by('droid')).toMatchObject({ status: 'error', message: 'Could not parse ~/.factory/settings.json' })
    expect(by('kimi').status).toBe('cli_not_found')
    const allowed = ['installed', 'not-installed', 'agent_disabled', 'cli_not_found', 'hooks_disabled', 'error']
    for (const entry of entries) expect(allowed).toContain(entry.status)
  })

  test('a detected, enabled agent with nothing installed is not-installed', async () => {
    await start({ cursor: 'on' })
    expect(await statusOf('cursor')).toBe('not-installed')
  })

  test('setting up one named agent that is not detected reports why instead of installing', async () => {
    await start({ cursor: 'missing', gemini: 'disabled' })
    expect(await setup('cursor')).toEqual([{ agent: 'cursor', status: 'cli_not_found', changed: [] }])
    expect(await setup('gemini')).toEqual([{ agent: 'gemini', status: 'agent_disabled', changed: [] }])
    expect(existsSync(join(userHome, '.cursor'))).toBe(false)
  })

  test('the CLI prints one line per agent for status', async () => {
    put('.factory/settings.json', '{ not json')
    await start({ droid: 'on' })
    const { ctx, lines } = testCliContext(rig!.client)
    await commands['hooks-status']!({ positionals: [], flags: {} }, ctx)
    const rows = lines[0]!.split('\n')
    expect(rows).toHaveLength(INSTALLERS.length)
    expect(rows).toContain('droid: error — Could not parse ~/.factory/settings.json')
    expect(rows).toContain('cursor: cli_not_found')
  })
})

describe('SC-27: the Agent status hooks switch', () => {
  test('off removes every entry and status shows hooks_disabled; the restart touches nothing; on installs again', async () => {
    const both = { gemini: 'on', cursor: 'on' } as const
    await start(both)
    await setup()
    const gemini = join(userHome, '.gemini', 'settings.json')
    const cursor = join(userHome, '.cursor', 'hooks.json')
    expect(existsSync(gemini) && existsSync(cursor)).toBe(true)

    await rig!.client.callAny('setting.set', { id: HOOKS, value: false })
    await waitFor(() => !existsSync(gemini) && !existsSync(cursor))
    expect((await status()).every((entry) => entry.status === 'hooks_disabled')).toBe(true)

    // a Quirky entry written behind the switch's back survives a restart: startup never removes
    geminiInstaller.install({ home: userHome, env: process.env, quirkyHome: rig!.h.home })
    const before = readFileSync(gemini, 'utf8')
    const { home } = rig!.h
    process.env.QUIRKY_TEST_FAKE_AGENTS = JSON.stringify(listing(both))
    await rig!.stop()
    rig = await Rig.start({ home, sessions: [] })
    await Bun.sleep(100)
    expect(readFileSync(gemini, 'utf8')).toBe(before)
    expect(existsSync(cursor)).toBe(false)
    expect(await statusOf('gemini')).toBe('hooks_disabled')

    await rig.client.callAny('setting.set', { id: HOOKS, value: true })
    await waitFor(() => existsSync(cursor))
    expect(await statusOf('cursor')).toBe('installed')
  })

  test('setup while the switch is off refuses with the switch message', async () => {
    await start({ gemini: 'on' })
    await rig!.client.callAny('setting.set', { id: HOOKS, value: false })
    const error = await failure(setup('gemini'))
    expect(error.message).toContain('Agent status hooks are turned off')
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(existsSync(join(userHome, '.gemini'))).toBe(false)
  })

  test('remove still works while the switch is off', async () => {
    await start({ gemini: 'on' })
    await rig!.client.callAny('setting.set', { id: HOOKS, value: false })
    expect(await remove('gemini')).toEqual([{ agent: 'gemini', changed: [] }])
  })

  test('activation with the switch on installs for detected, enabled agents only', async () => {
    await start({ gemini: 'on', cursor: 'disabled', droid: 'missing' }, { atStartup: true })
    await waitFor(() => existsSync(join(userHome, '.gemini', 'settings.json')))
    await Bun.sleep(50)
    expect(existsSync(join(userHome, '.cursor'))).toBe(false)
    expect(existsSync(join(userHome, '.factory'))).toBe(false)
    expect(await statusOf('gemini')).toBe('installed')
  })

  test('activation with the switch on keeps going when a config cannot be read', async () => {
    put('.factory/settings.json', '{ not json')
    await start({ droid: 'on', gemini: 'on' }, { atStartup: true })
    await waitFor(() => existsSync(join(userHome, '.gemini', 'settings.json')))
    expect(readFileSync(join(userHome, '.factory', 'settings.json'), 'utf8')).toBe('{ not json')
  })
})

describe('SC-29: Codex asks for review', () => {
  test('setup prints the file and the note', async () => {
    await start({ codex: 'on' })
    const path = join(userHome, '.codex', 'hooks.json')
    expect(await setup('codex')).toEqual([
      { agent: 'codex', status: 'installed', changed: [path], note: 'Codex asks you to review these hooks once (/hooks)' }
    ])

    const { ctx, lines } = testCliContext(rig!.client, { env: { HOME: userHome } })
    await commands['hooks-setup']!({ positionals: ['codex'], flags: {} }, ctx)
    expect(lines).toEqual(['codex: installed — Codex asks you to review these hooks once (/hooks)'])
  })
})

describe('arguments and output', () => {
  test('an unknown agent is invalid-params for setup and remove', async () => {
    await start({ gemini: 'on' })
    for (const call of [() => setup('nope'), () => remove('nope'), () => setup('claude')]) {
      const error = await failure(call())
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
    }
  })

  test('--json prints the method result', async () => {
    await start({ gemini: 'on' })
    const { ctx, lines } = testCliContext(rig!.client, { json: true })
    await commands['hooks-setup']!({ positionals: ['gemini'], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!)).toEqual([{ agent: 'gemini', status: 'installed', changed: [join(userHome, '.gemini', 'settings.json')] }])
  })

  test('remove prints a line for an agent with nothing to remove', async () => {
    await start({})
    const { ctx, lines } = testCliContext(rig!.client)
    await commands['hooks-remove']!({ positionals: ['cursor'], flags: {} }, ctx)
    expect(lines).toEqual(['cursor: nothing to remove'])
  })
  test('runtime hook setup and removal execute on the owner target and phone-only routing never falls back', async () => {
    const source = await Rig.start({ sessions: [] })
    const target = await Rig.start({ sessions: [] })
    try {
      await target.client.callAny('quirky.agents/setAgents', { agents: listing({ gemini: 'on' }) })
      const targetIdentity = {
        id: 'runtime-target-id',
        name: 'Target owner',
        endpoint: 'wss://target.invalid',
        grantId: 'owner-grant-id'
      }
      const { ctx, lines } = testCliContext(source.client, { env: { HOME: userHome } })
      const localCall = ctx.call
      const routed: { runtime: string; method: string; params: Record<string, unknown> }[] = []
      ctx.call = async (method, params = {}) => {
        if (method !== 'quirky.cli/runtimeCall') return localCall(method, params)
        const runtime = params.runtime
        const remoteMethod = params.method
        const remoteParams = params.params
        if (typeof runtime !== 'string' || typeof remoteMethod !== 'string' ||
          typeof remoteParams !== 'object' || remoteParams === null || Array.isArray(remoteParams)) {
          throw new Error('malformed runtime call')
        }
        routed.push({ runtime, method: remoteMethod, params: remoteParams as Record<string, unknown> })
        if (runtime === 'phone-only') throw ctx.fail('phone grants cannot administer owner runtimes')
        return { runtime: targetIdentity, result: await target.client.callAny(remoteMethod, remoteParams as Record<string, unknown>) }
      }

      const original = { theme: 'remote-owner' }
      const path = put('.gemini/settings.json', original)
      await commands['hooks-setup']!({ positionals: ['gemini'], flags: { host: 'runtime:target-owner' } }, ctx)
      expect(routed[0]).toEqual({
        runtime: 'target-owner',
        method: 'quirky.agent-status/hooksSetup',
        params: { agent: 'gemini' }
      })
      expect(lines[0]).toContain('Target owner')
      expect(readFileSync(path, 'utf8')).toContain('quirky-hook')

      await commands['hooks-remove']!({ positionals: ['gemini'], flags: { host: 'runtime:target-owner' } }, ctx)
      expect(routed[1]).toEqual({
        runtime: 'target-owner',
        method: 'quirky.agent-status/hooksRemove',
        params: { agent: 'gemini' }
      })
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original)

      const phoneFailure = await failure(commands['hooks-setup']!({
        positionals: ['gemini'],
        flags: { host: 'runtime:phone-only' }
      }, ctx))
      expect(phoneFailure.message).toBe('phone grants cannot administer owner runtimes')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(original)
    } finally {
      await source.cleanup()
      await target.cleanup()
    }
  })
})

describe('the hooks service on its own', () => {
  const stub = (call: PluginContext['call'], logged: string[]): PluginContext =>
    ({
      home: makeTempDir('qas-q-'),
      call,
      log: (line: string) => logged.push(line),
      getSetting: () => true,
      error: (_kind: string, message: string) => new Error(message)
    }) as unknown as PluginContext

  test('startup survives quirky.agents being unavailable and installs nothing', async () => {
    const logged: string[] = []
    const service = new HooksService(stub(() => Promise.reject(new Error('method not found')), logged))
    service.begin()
    await service.startup
    expect(logged.some((line) => line.includes('could not read the agent list'))).toBe(true)
    expect(existsSync(join(userHome, '.gemini'))).toBe(false)
    expect((await service.status()).every((entry) => entry.status === 'cli_not_found')).toBe(true)
  })

  test('startup installs for detected, enabled agents and can be awaited', async () => {
    const service = new HooksService(
      stub(async () => ({ agents: [{ id: 'gemini', installed: true, enabled: true }] }), [])
    )
    service.begin()
    await service.startup
    expect(existsSync(join(userHome, '.gemini', 'settings.json'))).toBe(true)
  })

  test('startup does nothing while the switch is off', async () => {
    const context = { ...stub(async () => ({ agents: [{ id: 'gemini', installed: true, enabled: true }] }), []), getSetting: () => false }
    const service = new HooksService(context as PluginContext)
    service.begin()
    await service.startup
    expect(existsSync(join(userHome, '.gemini'))).toBe(false)
  })
})
