import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'

const PLUGIN_DIR = join(import.meta.dir, '..')
const ENV_NAMES = ['HOME', 'QUIRKY_AGENT_SEARCH_DIRS', 'QUIRKY_TEST_AGENT_TIME_SCALE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

const fixtures: Fixture[] = []

type Manifest = { id: string } & Record<string, unknown>

type Options = {
  /** Fake executables placed on the login shell's PATH. */
  installed?: string[]
  /** Installed plugins, written before the daemon starts. */
  plugins?: Manifest[]
  /** Adds a stand-in for `quirky.session` that can spawn a PTY session and announce its removal. */
  fakeSession?: boolean
  timeScale?: number
  /** Leaves workspace trust on; off by default so a launch writes no trust record. */
  trust?: boolean
}

type Fixture = {
  h: Harness
  client: QuirkyClient
  events: QuirkyEvent[]
  logs: string[]
  /** The temporary HOME the daemon sees. */
  userHome: string
  bin: string
  call(method: string, params?: Record<string, unknown>): Promise<any>
  changes(): number
  install(...names: string[]): void
  setLoginPath(dirs: string[]): void
}

function makeExecutable(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, name), 0o755)
}

const FAKE_SESSION_MAIN = `export async function activate(context: any) {
  context.provide('method:quirky.session/spawn', async (params: any) => {
    await context.pty.spawn(params.sessionId, { argv: ['/bin/true'], cwd: '/tmp', env: {}, cols: 80, rows: 24 })
    return { ok: true }
  })
  context.provide('method:quirky.session/remove', (params: any) => {
    context.emit('removed', { sessionId: params.sessionId })
    return { ok: true }
  })
}
`

async function start(options: Options = {}): Promise<Fixture> {
  const home = mkdtempSync('/tmp/qag-s-')
  const userHome = join(home, 'user')
  const bin = join(home, 'bin')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(bin, { recursive: true })
  for (const name of options.installed ?? []) makeExecutable(bin, name)

  const pathFile = join(home, 'login-path')
  writeFileSync(pathFile, bin)
  const shell = join(home, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\ncat ${pathFile}\n`)
  chmodSync(shell, 0o755)

  const builtin = join(home, 'builtin')
  mkdirSync(builtin)
  symlinkSync(PLUGIN_DIR, join(builtin, 'quirky.agents'))
  if (options.fakeSession) {
    const manifest = {
      id: 'quirky.session',
      name: 'Session (test fake)',
      version: '0.0.0',
      main: 'main.ts',
      contributes: {
        method: [
          { id: 'spawn', params: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
          { id: 'remove', params: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } }
        ],
        event: [{ id: 'removed' }]
      }
    }
    writePlugin(builtin, manifest, { 'main.ts': FAKE_SESSION_MAIN })
  }
  for (const manifest of options.plugins ?? []) {
    writePlugin(join(home, 'plugins'), { name: manifest.id, version: '1.0.0', ...manifest })
  }

  process.env.HOME = userHome
  process.env.QUIRKY_AGENT_SEARCH_DIRS = ''
  if (options.timeScale === undefined) delete process.env.QUIRKY_TEST_AGENT_TIME_SCALE
  else process.env.QUIRKY_TEST_AGENT_TIME_SCALE = String(options.timeScale)

  const logs: string[] = []
  const h = await startHarness({ home, shell, builtinPluginsDir: builtin, log: (line) => logs.push(line) })
  if (options.trust !== true) {
    const setup = await h.connect('cli')
    await setup.callAny('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
  }
  const { client, events } = await h.connectWithEvents('ui')
  const fixture: Fixture = {
    h,
    client,
    events,
    logs,
    userHome,
    bin,
    call: (method, params = {}) => client.callAny(method, params),
    changes: () => events.filter((event) => event.type === 'quirky.agents/changed').length,
    install: (...names) => names.forEach((name) => makeExecutable(bin, name)),
    setLoginPath: (dirs) => writeFileSync(pathFile, dirs.join(':'))
  }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.h.cleanup()
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const A = (method: string) => `quirky.agents/${method}`

/** The RPC error a call rejects with. */
async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to fail')
}

const find = (listing: { agents: any[] }, id: string) => listing.agents.find((agent) => agent.id === id)

const settle = () => Bun.sleep(150)

const agentManifest = (id: string, entries: Record<string, unknown>[], extra: Record<string, unknown> = {}): Manifest => ({
  id,
  contributes: { agent: entries },
  ...extra
})

describe('catalog and listing', () => {
  test('SC-1: lists the 45 built-in agents in auto-pick order with what each can do', async () => {
    const t = await start({ installed: ['claude', 'codex'], trust: true })
    const listing = await t.call(A('list'))

    expect(listing.defaultAgent).toBe('auto')
    expect(listing.workspaceTrust).toBe(true)
    expect(listing.permissions.summary).toBe('yolo')
    expect(listing).not.toHaveProperty('problems')

    expect(find(listing, 'claude')).toMatchObject({
      label: 'Claude',
      installed: true,
      promptMode: 'argv',
      resumable: true,
      canFork: true,
      command: 'claude',
      commandOverridden: false,
      args: '--dangerously-skip-permissions',
      argsOverridden: false,
      permissions: { mode: 'yolo', hasAuto: true }
    })
    expect(find(listing, 'claude').homepage).toBe('https://code.claude.com/docs')
    expect(find(listing, 'aider')).toMatchObject({ installed: false, promptMode: 'stdin-after-start', resumable: false })
    expect(find(listing, 'opencode').permissions.mode).toBeNull()
    expect(find(listing, 'goose')).toMatchObject({ showEnv: true, env: { GOOSE_MODE: 'auto' } })
  })

  test('SC-1: get returns one agent and refuses an unknown one', async () => {
    const t = await start({ installed: ['codex'] })
    expect(await t.call(A('get'), { agent: 'codex' })).toMatchObject({ id: 'codex', installed: true, label: 'Codex' })
    const error = await failure(t.call(A('get'), { agent: 'nope' }))
    expect(error).toMatchObject({ code: RpcErrorCode.NotFound, message: 'unknown agent: nope' })
  })

  test('SC-2: a plugin adds an agent that is listed and planned', async () => {
    const t = await start({
      installed: ['acme-bot'],
      plugins: [agentManifest('acme.agents', [{ id: 'acme-bot', label: 'Acme Bot', detect: 'acme-bot', prompt: 'flag-prompt', yolo: '--yes' }])]
    })
    const listing = await t.call(A('list'))
    expect(listing.agents).toHaveLength(46)
    expect(listing.agents.at(-1)).toMatchObject({ id: 'acme-bot', plugin: 'acme.agents', installed: true, promptMode: 'flag-prompt' })

    const plan = await t.call(A('plan'), { agent: 'acme-bot', prompt: 'fix it' })
    expect(plan.command).toBe("acme-bot --yes --prompt 'fix it'")
    expect(plan.promptDelivery).toBe('command-line')
    const launch = await t.call(A('prepareLaunch'), { agent: 'acme-bot', cwd: t.userHome, prompt: 'fix it', hookArgs: [], hookEnv: {} })
    expect(launch.command).toBe("acme-bot --yes --prompt 'fix it'")
  })

  test('SC-3: a plugin replaces one built-in agent and removes another', async () => {
    const t = await start({
      installed: ['codex'],
      plugins: [
        {
          id: 'acme.override',
          overrides: [
            { id: 'agent:quirky.agents/codex', label: 'Codex', detect: 'codex', launch: 'codex --profile acme', prompt: 'argv', yolo: '--yolo-acme' }
          ]
        },
        { id: 'acme.trim', disables: ['agent:quirky.agents/aider'] }
      ]
    })
    const listing = await t.call(A('list'))
    expect(listing.agents).toHaveLength(44)
    expect(find(listing, 'aider')).toBeUndefined()
    expect(find(listing, 'codex')).toMatchObject({ plugin: 'acme.override', command: 'codex --profile acme' })
    expect(listing.agents.findIndex((agent: any) => agent.id === 'codex')).toBe(3)
    const plan = await t.call(A('plan'), { agent: 'codex' })
    expect(plan.command).toBe('codex --profile acme --yolo-acme')
    expect(await failure(t.call(A('get'), { agent: 'aider' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('SC-4: a malformed or duplicate entry is left out and reported with all', async () => {
    const t = await start({
      plugins: [
        agentManifest('acme.bad', [{ id: 'broken', label: 'Broken', prompt: 'argv' }]),
        agentManifest('acme.dupe', [{ id: 'claude', label: 'Claude Two', detect: 'claude', prompt: 'argv' }])
      ]
    })
    const plain = await t.call(A('list'))
    expect(plain.agents).toHaveLength(45)
    expect(find(plain, 'claude').plugin).toBe('quirky.agents')
    expect(plain).not.toHaveProperty('problems')

    const all = await t.call(A('list'), { all: true })
    expect(all.agents).toHaveLength(45)
    expect(all.problems).toEqual([
      { plugin: 'acme.bad', id: 'broken', status: 'invalid', error: 'detect command is required' },
      {
        plugin: 'acme.dupe',
        id: 'claude',
        status: 'conflict',
        error: 'agent claude is already provided by quirky.agents; use overrides to replace a built-in agent'
      }
    ])
    expect(t.logs.some((line) => line.includes('skipped agent acme.bad/broken: detect command is required'))).toBe(true)
  })

  test('a catalog change announces changed and rebuilds the listing', async () => {
    const t = await start({
      installed: ['acme-bot'],
      plugins: [agentManifest('acme.agents', [{ id: 'acme-bot', label: 'Acme Bot', detect: 'acme-bot', prompt: 'argv' }])]
    })
    expect(find(await t.call(A('list')), 'acme-bot')).toBeDefined()
    const before = t.changes()

    await t.call('plugin.disable', { id: 'acme.agents' })
    await waitFor(() => t.changes() > before)
    expect(find(await t.call(A('list')), 'acme-bot')).toBeUndefined()

    await t.call('plugin.enable', { id: 'acme.agents' })
    await waitFor(() => t.changes() > before + 1)
    expect(find(await t.call(A('list')), 'acme-bot')).toMatchObject({ installed: true })
  })
})

describe('detection', () => {
  test('SC-5: installed agents come from the login shell PATH and the search directories, and nothing runs', async () => {
    const t = await start({ installed: ['claude'] })
    const extra = join(t.h.home, 'install-dir')
    makeExecutable(extra, 'qwen')
    makeExecutable(extra, 'kimi-code')
    const ranMarker = join(t.h.home, 'ran')
    writeFileSync(join(extra, 'qwen'), `#!/bin/sh\ntouch ${ranMarker}\n`)
    process.env.QUIRKY_AGENT_SEARCH_DIRS = extra

    const listing = await t.call(A('refresh'))
    expect(listing.agents.filter((agent: any) => agent.installed).map((agent: any) => agent.id)).toEqual([
      'claude',
      'claude-agent-teams',
      'kimi',
      'qwen-code'
    ])
    expect(existsSync(ranMarker)).toBe(false)
  })

  test('SC-7: list keeps its answer until refresh, which re-detects and announces changed', async () => {
    const t = await start({ installed: ['claude'] })
    expect(find(await t.call(A('list')), 'gemini').installed).toBe(false)

    t.install('gemini')
    expect(find(await t.call(A('list')), 'gemini').installed).toBe(false)

    const before = t.changes()
    const refreshed = await t.call(A('refresh'))
    expect(find(refreshed, 'gemini').installed).toBe(true)
    await waitFor(() => t.changes() > before)
    expect(find(await t.call(A('list')), 'gemini').installed).toBe(true)
  })

  test('SC-7: refresh reads the login shell PATH again', async () => {
    const t = await start({ installed: ['claude'] })
    const second = join(t.h.home, 'second-bin')
    makeExecutable(second, 'amp')
    expect(find(await t.call(A('list')), 'amp').installed).toBe(false)

    t.setLoginPath([t.bin, second])
    expect(find(await t.call(A('refresh')), 'amp').installed).toBe(true)
  })

  test('an agent found only outside the login PATH launches by its absolute path', async () => {
    const t = await start({ installed: ['claude'] })
    const extra = join(t.h.home, 'install-dir')
    makeExecutable(extra, 'gemini')
    process.env.QUIRKY_AGENT_SEARCH_DIRS = extra
    await t.call(A('refresh'))

    const launch = await t.call(A('prepareLaunch'), { agent: 'gemini', cwd: t.userHome, hookArgs: [], hookEnv: {} })
    expect(launch.command.startsWith(`${join(extra, 'gemini')} `) || launch.command.startsWith(`'${join(extra, 'gemini')}' `)).toBe(true)
    expect(launch.record.command).toBe('gemini')
    const plain = await t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, hookArgs: [], hookEnv: {} })
    expect(plain.command.startsWith('claude ')).toBe(true)
  })
})

describe('choosing the agent', () => {
  test('SC-8: the default, then auto-pick order, then a shell', async () => {
    const t = await start({ installed: ['codex', 'gemini'] })
    const pick = async (params: Record<string, unknown> = {}) => (await t.call(A('pick'), params)).agent

    expect(await pick()).toBe('codex')

    await t.call(A('setDefault'), { agent: 'gemini' })
    expect(await pick()).toBe('gemini')

    await t.call(A('setDefault'), { agent: 'claude' })
    expect(await pick()).toBe('codex')

    await t.call(A('setDefault'), { agent: 'shell' })
    expect(await pick()).toBe('shell')

    await t.call(A('setDefault'), { agent: 'auto' })
    await t.call(A('setEnabled'), { agent: 'codex', enabled: false })
    expect(await pick()).toBe('gemini')
    expect(await pick({ preferred: 'codex' })).toBe('gemini')
    expect(await pick({ preferred: 'gemini' })).toBe('gemini')
  })

  test('SC-8: an unusable preferred agent falls back to the stored default, then to auto-pick order', async () => {
    const t = await start({ installed: ['codex', 'gemini'] })
    const pick = async (params: Record<string, unknown> = {}) => (await t.call(A('pick'), params)).agent
    await t.call(A('setDefault'), { agent: 'gemini' })
    expect(await pick({ preferred: 'claude' })).toBe('gemini')
    expect(await pick({ preferred: 'no-such-agent' })).toBe('gemini')
    await t.call(A('setEnabled'), { agent: 'codex', enabled: false })
    expect(await pick({ preferred: 'codex' })).toBe('gemini')
    await t.call(A('setDefault'), { agent: 'auto' })
    expect(await pick({ preferred: 'claude' })).toBe('gemini')
  })

  test('SC-8: with nothing installed a launch gets a shell', async () => {
    const t = await start()
    expect((await t.call(A('pick'))).agent).toBe('shell')
  })

  test('SC-9: the agent tab treats a shell default as auto and refuses when nothing fits', async () => {
    const t = await start({ installed: ['codex'] })
    await t.call(A('setDefault'), { agent: 'shell' })
    expect((await t.call(A('pick'), { forAgentTab: true })).agent).toBe('codex')

    await t.call(A('setEnabled'), { agent: 'codex', enabled: false })
    expect(await failure(t.call(A('pick'), { forAgentTab: true }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'No installed agent is enabled.'
    })
  })

  test('SC-10: disabling an agent hides it, resets the default and refuses a launch by name', async () => {
    const t = await start({ installed: ['claude', 'codex'] })
    await t.call(A('setDefault'), { agent: 'claude' })
    expect((await t.call(A('list'))).defaultAgent).toBe('claude')
    const before = t.changes()

    const disabled = await t.call(A('setEnabled'), { agent: 'claude', enabled: false })
    expect(disabled).toMatchObject({ id: 'claude', enabled: false, isDefault: false })
    const listing = await t.call(A('list'))
    expect(listing.defaultAgent).toBe('auto')
    expect(find(listing, 'claude').enabled).toBe(false)
    expect((await t.call(A('pick'))).agent).toBe('claude-agent-teams')
    await settle()
    expect(t.changes()).toBe(before + 1)

    const refusal = await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, hookArgs: [], hookEnv: {} }))
    expect(refusal).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'agent claude is disabled' })

    await t.call(A('setEnabled'), { agent: 'claude', enabled: true })
    const restored = await t.call(A('list'))
    expect(find(restored, 'claude').enabled).toBe(true)
    expect(restored.defaultAgent).toBe('auto')
  })

  test('SC-10: disabling an already-disabled default resets the default, and setDefault refuses a disabled agent', async () => {
    const t = await start({ installed: ['claude', 'codex'] })
    await t.call(A('setEnabled'), { agent: 'claude', enabled: false })
    const refusal = await failure(t.call(A('setDefault'), { agent: 'claude' }))
    expect(refusal).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'agent claude is disabled' })

    await t.call('setting.set', { id: 'setting:quirky.agents/default-agent', value: 'claude' })
    await waitFor(() => t.changes() >= 2)
    expect((await t.call(A('list'))).defaultAgent).toBe('claude')
    const before = t.changes()

    await t.call(A('setEnabled'), { agent: 'claude', enabled: false })
    expect((await t.call(A('list'))).defaultAgent).toBe('auto')
    await waitFor(() => t.changes() > before)
  })

  test('setDefault refuses an unknown agent, and a repeat or a no-op change announces nothing', async () => {
    const t = await start({ installed: ['codex'] })
    expect(await failure(t.call(A('setDefault'), { agent: 'nope' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'unknown agent: nope'
    })

    await t.call(A('setDefault'), { agent: 'codex' })
    await settle()
    const settled = t.changes()
    expect(settled).toBe(1)

    await t.call(A('setDefault'), { agent: 'codex' })
    await t.call(A('setEnabled'), { agent: 'codex', enabled: true })
    await settle()
    expect(t.changes()).toBe(settled)
  })

  test('a stored default that names an agent outside the catalog reads as auto', async () => {
    const t = await start({
      installed: ['acme-bot'],
      plugins: [agentManifest('acme.agents', [{ id: 'acme-bot', label: 'Acme Bot', detect: 'acme-bot', prompt: 'argv' }])]
    })
    await t.call(A('setDefault'), { agent: 'acme-bot' })
    expect((await t.call(A('list'))).defaultAgent).toBe('acme-bot')

    const before = t.changes()
    await t.call('plugin.disable', { id: 'acme.agents' })
    await waitFor(() => t.changes() > before)
    const listing = await t.call(A('list'))
    expect(listing.defaultAgent).toBe('auto')
    expect((await t.call(A('pick'))).agent).toBe('shell')
  })

  test('changing a setting from outside announces changed once', async () => {
    const t = await start({ installed: ['codex'], trust: true })
    await t.call('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
    await waitFor(() => t.changes() === 1)
    expect((await t.call(A('list'))).workspaceTrust).toBe(false)
    await settle()
    expect(t.changes()).toBe(1)
  })
})

describe('configuration', () => {
  test('SC-11: a command override replaces the whole command and clearing it restores the default', async () => {
    const t = await start({ installed: ['claude'] })
    const info = await t.call(A('configure'), { agent: 'claude', command: 'my-claude' })
    expect(info).toMatchObject({ command: 'my-claude', commandOverridden: true })
    expect((await t.call(A('plan'), { agent: 'claude' })).command.startsWith('my-claude ')).toBe(true)

    const cleared = await t.call(A('configure'), { agent: 'claude', command: 'claude' })
    expect(cleared).toMatchObject({ command: 'claude', commandOverridden: false })
    expect((await t.call(A('plan'), { agent: 'claude' })).command.startsWith('claude ')).toBe(true)
    expect(await t.call(A('get'), { agent: 'claude' })).toMatchObject({ commandOverridden: false })

    await t.call(A('configure'), { agent: 'claude', command: 'my-claude' })
    const reset = await t.call(A('configure'), { agent: 'claude', reset: ['command'] })
    expect(reset).toMatchObject({ command: 'claude', commandOverridden: false })

    await t.call(A('configure'), { agent: 'claude', command: 'my-claude' })
    expect(await t.call(A('configure'), { agent: 'claude', command: '' })).toMatchObject({ commandOverridden: false })
  })

  test('SC-11: a command that does not tokenize is refused and stores nothing', async () => {
    const t = await start()
    const error = await failure(t.call(A('configure'), { agent: 'claude', command: 'my-claude "x' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message.startsWith('Agent command override is invalid: ')).toBe(true)
    expect(await t.call(A('get'), { agent: 'claude' })).toMatchObject({ commandOverridden: false })
  })

  test('SC-12: arguments are stored as given and an unbalanced quote is refused', async () => {
    const t = await start({ installed: ['claude'] })
    const text = `--model "haiku 5" $(touch /tmp/pwned) ; rm -rf x`
    const info = await t.call(A('configure'), { agent: 'claude', args: text })
    expect(info).toMatchObject({ args: text, argsOverridden: true, permissions: { mode: 'custom' } })
    expect((await t.call(A('plan'), { agent: 'claude' })).command).toBe(
      "claude --model 'haiku 5' '$(touch' '/tmp/pwned)' ';' rm -rf x"
    )

    const error = await failure(t.call(A('configure'), { agent: 'claude', args: '--model "haiku' }))
    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'CLI arguments are invalid: unterminated quote' })
    expect((await t.call(A('get'), { agent: 'claude' })).args).toBe(text)
  })

  test('SC-13: an agent environment comes from its default or the saved override', async () => {
    const t = await start({ installed: ['goose', 'codex'] })
    const goose = await t.call(A('prepareLaunch'), { agent: 'goose', cwd: t.userHome, hookArgs: [], hookEnv: {} })
    expect(goose.env).toEqual({ GOOSE_MODE: 'auto' })

    const info = await t.call(A('configure'), { agent: 'codex', env: { CODEX_HOME: '/tmp/ch' } })
    expect(info).toMatchObject({ env: { CODEX_HOME: '/tmp/ch' }, envOverridden: true })
    const codex = await t.call(A('prepareLaunch'), { agent: 'codex', cwd: t.userHome, hookArgs: [], hookEnv: { FROM_HOOK: '1', CODEX_HOME: null } })
    expect(codex.env).toEqual({ CODEX_HOME: null, FROM_HOOK: '1' })
    expect(codex.record.env).toEqual({ CODEX_HOME: '/tmp/ch' })

    const plain = await t.call(A('prepareLaunch'), { agent: 'codex', cwd: t.userHome, hookArgs: [], hookEnv: {} })
    expect(plain.env).toEqual({ CODEX_HOME: '/tmp/ch' })
  })

  test('SC-13: a reserved environment name is refused when saved', async () => {
    const t = await start()
    for (const name of ['PATH', 'ZDOTDIR', 'QUIRKY_HOME']) {
      const error = await failure(t.call(A('configure'), { agent: 'codex', env: { [name]: 'x' } }))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.message).toContain(name)
    }
    expect(await t.call(A('get'), { agent: 'codex' })).toMatchObject({ envOverridden: false })
  })

  test('configure refuses an unknown agent and a call that changes nothing announces nothing', async () => {
    const t = await start()
    expect(await failure(t.call(A('configure'), { agent: 'nope', args: '' }))).toMatchObject({ code: RpcErrorCode.NotFound })

    await t.call(A('configure'), { agent: 'codex', args: '--model x' })
    await settle()
    const settled = t.changes()
    expect(settled).toBe(1)
    await t.call(A('configure'), { agent: 'codex', args: '--model x' })
    await t.call(A('configure'), { agent: 'codex', reset: ['env'] })
    await settle()
    expect(t.changes()).toBe(settled)

    const reset = await t.call(A('configure'), { agent: 'codex', reset: ['args'] })
    expect(reset).toMatchObject({ argsOverridden: false, args: '--dangerously-bypass-approvals-and-sandbox' })
  })

  test('an empty arguments text is Manual and keeps the key', async () => {
    const t = await start()
    const info = await t.call(A('configure'), { agent: 'codex', args: '' })
    expect(info).toMatchObject({ args: '', argsOverridden: true, permissions: { mode: 'manual' } })
    expect((await t.call(A('plan'), { agent: 'codex' })).command).toBe('codex')
  })
})

describe('permission modes', () => {
  test('SC-14: untouched arguments mean Yolo', async () => {
    const t = await start()
    const commands: Record<string, string> = {
      claude: 'claude --dangerously-skip-permissions',
      codex: 'codex --dangerously-bypass-approvals-and-sandbox',
      gemini: 'gemini --yolo',
      aider: 'aider --yes-always',
      devin: 'devin --permission-mode bypass --respect-workspace-trust false',
      goose: 'goose',
      opencode: 'opencode'
    }
    for (const [agent, command] of Object.entries(commands)) {
      expect((await t.call(A('plan'), { agent })).command).toBe(command)
    }
    expect((await t.call(A('plan'), { agent: 'goose' })).env).toEqual({ GOOSE_MODE: 'auto' })
  })

  test('SC-15: bulk modes change only preset agents, and Auto only those that have it', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'claude', args: '--model haiku' })
    await settle()

    const auto = await t.call(A('setPermissions'), { mode: 'auto' })
    expect(auto.summary).toBe('auto')
    expect(auto.changed.sort()).toEqual(['claude-agent-teams', 'codex'])
    let listing = await t.call(A('list'))
    expect(find(listing, 'codex').args).toBe('--approve-for-me')
    expect(find(listing, 'claude-agent-teams').args).toBe('--permission-mode auto')
    expect(find(listing, 'claude').args).toBe('--model haiku')
    expect(find(listing, 'gemini').args).toBe('--yolo')
    expect(listing.permissions.summary).toBe('auto')

    const manual = await t.call(A('setPermissions'), { mode: 'manual' })
    expect(manual.summary).toBe('manual')
    expect(manual.changed).toContain('goose')
    expect(manual.changed).not.toContain('claude')
    listing = await t.call(A('list'))
    expect(find(listing, 'codex')).toMatchObject({ args: '', argsOverridden: true })
    expect(find(listing, 'gemini').args).toBe('')
    expect(find(listing, 'goose')).toMatchObject({ env: {}, envOverridden: true })
    expect(find(listing, 'claude').args).toBe('--model haiku')
    expect(listing.permissions.summary).toBe('manual')

    await settle()
    const settled = t.changes()
    const again = await t.call(A('setPermissions'), { mode: 'manual' })
    expect(again).toEqual({ summary: 'manual', changed: [] })
    await settle()
    expect(t.changes()).toBe(settled)
  })

  test('SC-15: a mix of preset modes reads as mixed', async () => {
    const t = await start()
    await t.call(A('setPermissions'), { mode: 'manual', agent: 'codex' })
    expect((await t.call(A('list'))).permissions.summary).toBe('mixed')
  })

  test('SC-16: per-agent modes, custom rows and errors', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'claude', args: '--model haiku' })

    const refused = async (params: Record<string, unknown>) => failure(t.call(A('setPermissions'), params))
    expect(await refused({ mode: 'yolo', agent: 'claude' })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'claude has custom arguments; pass --replace-custom to replace them'
    })
    expect(await refused({ mode: 'auto', agent: 'gemini' })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'gemini has no Auto mode'
    })
    expect(await refused({ mode: 'yolo', agent: 'opencode' })).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'opencode has no permission modes'
    })
    expect(await refused({ mode: 'yolo', agent: 'nope' })).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'unknown agent: nope'
    })

    const replaced = await t.call(A('setPermissions'), { mode: 'yolo', agent: 'claude', replaceCustom: true })
    expect(replaced.changed).toEqual(['claude'])
    expect((await t.call(A('get'), { agent: 'claude' })).args).toBe('--dangerously-skip-permissions')
  })

  test('SC-17: opencode never receives the Claude bypass flag', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'opencode', args: '--dangerously-skip-permissions --model x' })
    expect((await t.call(A('plan'), { agent: 'opencode' })).command).toBe('opencode --model x')
  })
})

describe('plans', () => {
  test('SC-29: plan shows a launch without a session or a trust record', async () => {
    const t = await start({ installed: ['grok', 'claude'] })
    const folder = realpathSync(mkdtempSync('/tmp/qag-wt-'))
    try {
      const grok = await t.call(A('plan'), { agent: 'grok', prompt: 'help', cwd: folder })
      expect(grok.command).toBe("grok --permission-mode bypassPermissions -- 'help'")
      expect(grok.promptDelivery).toBe('command-line')
      expect(grok.paste).toBeNull()

      await t.call(A('plan'), { agent: 'claude', cwd: folder })
      expect(existsSync(join(t.userHome, '.claude.json'))).toBe(false)
      expect(t.h.pty.sessions.size).toBe(0)
      expect(t.h.pty.requests.filter((request) => request.type === 'create')).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('plan refuses a prompt with a NUL and an unknown agent, and a draft uses the native flag', async () => {
    const t = await start()
    expect(await failure(t.call(A('plan'), { agent: 'codex', prompt: 'a\0b' }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(await failure(t.call(A('plan'), { agent: 'nope' }))).toMatchObject({ code: RpcErrorCode.NotFound, message: 'unknown agent: nope' })

    const draft = await t.call(A('plan'), { agent: 'claude', prompt: 'hello', submitPrompt: false })
    expect(draft.command).toBe("claude --dangerously-skip-permissions --prefill 'hello'")
    const pasted = await t.call(A('plan'), { agent: 'aider', prompt: 'hello' })
    expect(pasted).toMatchObject({ promptDelivery: 'pending', paste: { text: 'hello', submit: true } })
  })

  test('prepareLaunch orders saved args and hook settings before the prompt', async () => {
    const t = await start()
    const settings = { hooks: { Stop: ['managed'] } }
    const launch = await t.call(A('prepareLaunch'), {
      agent: 'claude',
      cwd: t.userHome,
      prompt: 'go',
      hookArgs: ['--settings', JSON.stringify(settings)],
      hookEnv: {}
    })
    expect(launch.command).toBe(`claude --dangerously-skip-permissions --settings '${JSON.stringify(settings)}' 'go'`)
    expect(launch.record).toEqual({ command: 'claude', args: '--dangerously-skip-permissions', env: {} })
    expect(await failure(t.call(A('prepareLaunch'), { agent: 'nope', cwd: '/', hookArgs: [], hookEnv: {} }))).toMatchObject({
      code: RpcErrorCode.NotFound
    })
    expect(await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: '/', prompt: 'a\0', hookArgs: [], hookEnv: {} }))).toMatchObject({
      code: RpcErrorCode.InvalidParams
    })
  })

  test('prepareResume replays the launch record and resolves the executable again', async () => {
    const t = await start({ installed: ['codex'] })
    const record = { command: 'codex', args: '--model x', env: { CODEX_HOME: '/tmp/ch' } }
    const resume = await t.call(A('prepareResume'), {
      agent: 'codex',
      cwd: t.userHome,
      record,
      providerSession: { id: '0199a-thread', transcriptPath: null },
      fork: false,
      hookArgs: [],
      hookEnv: { A: '1' }
    })
    expect(resume.command).toBe('codex --model x resume 0199a-thread')
    expect(resume.env).toEqual({ CODEX_HOME: '/tmp/ch', A: '1' })
    expect(resume.record).toEqual(record)

    const bare = await t.call(A('prepareResume'), {
      agent: 'codex',
      cwd: t.userHome,
      record: null,
      providerSession: { id: 'abc' },
      fork: false,
      hookArgs: [],
      hookEnv: {}
    })
    expect(bare.command).toBe('codex resume abc')
    expect(bare.record).toEqual({ command: 'codex', args: '', env: {} })

    expect(
      await failure(
        t.call(A('prepareResume'), { agent: 'aider', cwd: '/', record: null, providerSession: { id: 'x' }, fork: false, hookArgs: [], hookEnv: {} })
      )
    ).toMatchObject({ code: RpcErrorCode.InvalidParams, message: "aider can't resume sessions" })
  })
})

describe('settingsOverlay', () => {
  test('returns current CLI JSON and file settings without launching or adding hook settings', async () => {
    const t = await start({ installed: ['claude'] })
    writeFileSync(join(t.userHome, 'cli-settings.json'), JSON.stringify({ statusLine: { command: 'file', padding: 2 }, hooks: { Stop: ['file'] } }))
    await t.call(A('configure'), {
      agent: 'claude',
      args: `--settings cli-settings.json --settings='${JSON.stringify({ statusLine: { format: 'cli' }, hooks: { Stop: ['cli'] } })}'`
    })

    const result = await t.call(A('settingsOverlay'), {
      agent: 'claude',
      cwd: t.userHome,
      model: 'opus',
      options: { effort: 'high' },
      extraArgs: '--add-dir docs'
    })

    expect(result).toEqual({
      settings: { statusLine: { command: 'file', padding: 2, format: 'cli' }, hooks: { Stop: ['cli'] } }
    })
    expect(t.h.pty.requests.filter((request) => request.type === 'create')).toEqual([])
  })

  test('uses the supplied replay record instead of current configuration', async () => {
    const t = await start({ installed: ['claude'] })
    writeFileSync(join(t.userHome, 'recorded.json'), JSON.stringify({ statusLine: { command: 'recorded', style: 'file' } }))
    await t.call(A('configure'), { agent: 'claude', args: `--settings='${JSON.stringify({ statusLine: { command: 'current' } })}'` })
    const record = {
      command: 'claude',
      args: `--settings recorded.json --settings '${JSON.stringify({ statusLine: { padding: 4 } })}'`,
      env: {}
    }

    const result = await t.call(A('settingsOverlay'), { agent: 'claude', cwd: t.userHome, record })

    expect(result).toEqual({ settings: { statusLine: { command: 'recorded', style: 'file', padding: 4 } } })
  })

  test('reports malformed settings files as invalid params without changing the file or configuration', async () => {
    const t = await start({ installed: ['claude'] })
    const path = join(t.userHome, 'broken.json')
    const bytes = '{ broken'
    writeFileSync(path, bytes)
    await t.call(A('configure'), { agent: 'claude', args: '--settings broken.json' })

    const error = await failure(t.call(A('settingsOverlay'), { agent: 'claude', cwd: t.userHome }))

    expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(error.message).toContain('broken.json')
    const launchError = await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, hookArgs: [], hookEnv: {} }))
    expect(launchError).toMatchObject({ code: RpcErrorCode.InvalidParams })
    const resumeError = await failure(
      t.call(A('prepareResume'), {
        agent: 'claude',
        cwd: t.userHome,
        record: { command: 'claude', args: '--settings broken.json', env: {} },
        providerSession: { id: 'provider', transcriptPath: null },
        fork: false,
        hookArgs: [],
        hookEnv: {}
      })
    )
    expect(resumeError).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect((await t.call(A('get'), { agent: 'claude' })).args).toBe('--settings broken.json')
  })
})

describe('workspace trust', () => {
  test('SC-36: prepareLaunch pre-writes the trust record into the user home when the setting is on', async () => {
    const t = await start({ installed: ['claude', 'copilot', 'codex'], trust: true })
    const folder = realpathSync(mkdtempSync('/tmp/qag-wt-'))
    try {
      writeFileSync(join(t.userHome, '.claude.json'), JSON.stringify({ theme: 'dark' }))
      await t.call(A('prepareLaunch'), { agent: 'claude', cwd: folder, hookArgs: [], hookEnv: {} })
      const claude = JSON.parse(readFileSync(join(t.userHome, '.claude.json'), 'utf8'))
      expect(claude.theme).toBe('dark')
      expect(claude.projects[folder].hasTrustDialogAccepted).toBe(true)

      await t.call(A('prepareLaunch'), { agent: 'copilot', cwd: folder, hookArgs: [], hookEnv: {} })
      const copilot = JSON.parse(readFileSync(join(t.userHome, '.copilot', 'config.json'), 'utf8'))
      expect(copilot.trustedFolders).toContain(folder)

      await t.call('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
      await t.call(A('prepareLaunch'), { agent: 'codex', cwd: folder, hookArgs: [], hookEnv: {} })
      expect(existsSync(join(t.userHome, '.codex'))).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('uses prepared provider homes for Claude and Codex trust writes', async () => {
    const t = await start({ installed: ['claude', 'codex'], trust: true })
    const folder = realpathSync(mkdtempSync('/tmp/qag-wt-'))
    const claudeHome = join(t.userHome, 'managed-claude')
    const codexHome = join(t.userHome, 'managed-codex')
    mkdirSync(claudeHome)
    mkdirSync(codexHome)
    const defaultClaude = join(t.userHome, '.claude.json')
    writeFileSync(defaultClaude, '{"theme":"default"}\n')
    const defaultClaudeBefore = readFileSync(defaultClaude, 'utf8')
    try {
      await t.call(A('prepareLaunch'), {
        agent: 'claude',
        cwd: folder,
        hookArgs: [],
        hookEnv: { CLAUDE_CONFIG_DIR: claudeHome }
      })
      const managedClaude = JSON.parse(readFileSync(join(claudeHome, '.claude.json'), 'utf8'))
      expect(managedClaude.projects[folder].hasTrustDialogAccepted).toBe(true)
      expect(readFileSync(defaultClaude, 'utf8')).toBe(defaultClaudeBefore)

      await t.call(A('prepareLaunch'), {
        agent: 'codex',
        cwd: folder,
        hookArgs: [],
        hookEnv: { CODEX_HOME: codexHome }
      })
      expect(readFileSync(join(codexHome, 'config.toml'), 'utf8')).toContain(`[projects."${folder}"]`)
      expect(existsSync(join(t.userHome, '.codex'))).toBe(false)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('a failed provider-home trust write does not log the private home path', async () => {
    const t = await start({ installed: ['claude'], trust: true })
    const folder = realpathSync(mkdtempSync('/tmp/qag-wt-'))
    const claudeHome = join(t.userHome, 'managed-private-home')
    writeFileSync(claudeHome, 'not a directory')
    try {
      const launch = await t.call(A('prepareLaunch'), {
        agent: 'claude',
        cwd: folder,
        hookArgs: [],
        hookEnv: { CLAUDE_CONFIG_DIR: claudeHome }
      })
      expect(launch.command.startsWith('claude')).toBe(true)
      const failure = t.logs.find((line) => line.includes('trust for claude failed: '))
      expect(failure).toBeDefined()
      expect(failure).not.toContain(claudeHome)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test('SC-36: an agent without a trust preset writes nothing', async () => {
    const t = await start({ trust: true })
    await t.call(A('prepareLaunch'), { agent: 'aider', cwd: t.userHome, hookArgs: [], hookEnv: {} })
    expect(readdirSync(t.userHome)).toEqual([])
  })

  test('SC-36: a failed trust write is logged and the launch goes on', async () => {
    const t = await start({ installed: ['claude'], trust: true })
    const folder = realpathSync(mkdtempSync('/tmp/qag-wt-'))
    try {
      mkdirSync(join(t.userHome, '.claude.json'))
      const launch = await t.call(A('prepareLaunch'), { agent: 'claude', cwd: folder, hookArgs: [], hookEnv: {} })
      expect(launch.command.startsWith('claude')).toBe(true)
      expect(t.logs.some((line) => line.includes('trust for claude failed: '))).toBe(true)
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('delivery', () => {
  const PASTE_ON = '\x1b[?2004h'
  const CURSOR = '\x1b[?25h'
  const cursorAgent = (extra: Record<string, unknown> = {}) =>
    agentManifest('acme.agents', [
      { id: 'acme-bot', label: 'Acme Bot', detect: 'acme-bot', prompt: 'stdin-after-start', readySignal: 'render-cursor-after-bracketed-paste', ...extra }
    ])

  test('deliver pastes once the agent signals ready, then submits', async () => {
    const t = await start({ fakeSession: true, timeScale: 0.05, plugins: [cursorAgent()] })
    await t.call('quirky.session/spawn', { sessionId: 's1' })
    const result = t.call(A('deliver'), { sessionId: 's1', agent: 'acme-bot', text: 'a\r\nb', submit: true })
    await Bun.sleep(100)
    t.h.pty.emit('s1', PASTE_ON + CURSOR)
    expect(await result).toEqual({ delivery: 'pasted' })
    expect(t.h.pty.inputs.map((input) => input.text)).toEqual(['\x1b[200~a\rb\x1b[201~', '\r'])
  })

  test('deliver gives up when the session is removed first', async () => {
    const t = await start({ fakeSession: true, timeScale: 0.05, plugins: [cursorAgent()] })
    await t.call('quirky.session/spawn', { sessionId: 's2' })
    const result = t.call(A('deliver'), { sessionId: 's2', agent: 'acme-bot', text: 'hi', submit: true })
    await Bun.sleep(100)
    await t.call('quirky.session/remove', { sessionId: 's2' })
    expect(await result).toEqual({ delivery: 'not-delivered' })
    expect(t.h.pty.inputs).toEqual([])
  })

  test('deliver with ready pastes at once without any ready signal', async () => {
    const t = await start({ fakeSession: true, timeScale: 0.05, plugins: [cursorAgent()] })
    await t.call('quirky.session/spawn', { sessionId: 's1' })
    const result = await t.call(A('deliver'), { sessionId: 's1', agent: 'acme-bot', text: 'hi', submit: false, ready: true })
    expect(result).toEqual({ delivery: 'pasted' })
    expect(t.h.pty.inputs.map((input) => input.text)).toEqual(['\x1b[200~hi\x1b[201~'])
  })

  test('submitPlan reports the entry\'s submit timing', async () => {
    const t = await start({
      plugins: [
        agentManifest('acme.agents', [
          { id: 'plain', label: 'Plain', detect: 'plain', prompt: 'stdin-after-start' },
          { id: 'fussy', label: 'Fussy', detect: 'fussy', prompt: 'stdin-after-start', submitRetryMs: 1200, enterWithPaste: true, lineSettleMs: 45 }
        ])
      ]
    })
    expect(await t.call(A('submitPlan'), { agent: 'plain', text: 'a\nb' })).toEqual({ enterWithPaste: false, delayMs: 501, retryMs: null })
    expect(await t.call(A('submitPlan'), { agent: 'fussy', text: 'a\nb' })).toEqual({ enterWithPaste: true, delayMs: 591, retryMs: 1200 })
  })

  test('submitPlan refuses an unknown agent', async () => {
    const t = await start()
    expect(await failure(t.call(A('submitPlan'), { agent: 'nope', text: 'x' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('deliver refuses an unknown agent', async () => {
    const t = await start()
    expect(await failure(t.call(A('deliver'), { sessionId: 's', agent: 'nope', text: 'x', submit: true }))).toMatchObject({
      code: RpcErrorCode.NotFound
    })
  })
})

describe('provider-owned model discovery', () => {
  test('only a bounded provider probe replaces the exact local catalog; empty, malformed and failed probes preserve it', async () => {
    const providerId = 'fixture-model-provider'
    const t = await start({
      installed: [providerId],
      plugins: [agentManifest('fixture.provider', [{
        id: providerId,
        label: 'Fixture provider',
        prompt: 'argv',
        detect: providerId,
        launchOptions: {
          model: { flag: ['--model', '{value}'] },
          options: [{
            id: 'effort',
            label: 'Effort',
            type: 'select',
            choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }],
            flag: ['--effort', '{value}']
          }],
          models: [{ id: 'seed-model', label: 'Seed model' }]
        },
        modelDiscovery: { args: ['models', '--json'], timeoutMs: 1_000, format: 'json' }
      }])]
    })
    const modelPath = join(t.userHome, 'provider-models.json')
    writeFileSync(modelPath, JSON.stringify({
      models: [{ id: 'opaque-model-7', label: 'Provider model', options: [{ id: 'effort', choices: ['high'] }] }]
    }))
    try {
      const executable = join(t.bin, providerId)
      writeFileSync(executable, `#!/bin/sh\ncat '${modelPath}'\n`)
      chmodSync(executable, 0o755)

      const discovered = await t.call(A('discoverModels'), { agent: providerId, host: 'local' })
      expect(discovered).toMatchObject({
        agent: providerId,
        authoritative: true,
        models: [{
          id: 'opaque-model-7',
          label: 'Provider model',
          options: [{ id: 'effort', choices: ['high'] }]
        }]
      })
      const updatedOptions = await t.call(A('options'), { agent: providerId })
      expect(updatedOptions.models.map((model: { id: string }) => model.id)).toEqual(['opaque-model-7'])
      expect(updatedOptions.models[0].options).toEqual([{ id: 'effort', label: 'Effort', type: 'select', choices: [{ value: 'high', label: 'High' }] }])
      const resolved = await t.call(A('resolveLaunch'), { agent: providerId, model: 'opaque-model-7', options: { effort: 'high' } })
      expect(resolved.added).toEqual(['--model', 'opaque-model-7', '--effort', 'high'])

      writeFileSync(modelPath, JSON.stringify({ models: [] }))
      const empty = await t.call(A('discoverModels'), { agent: providerId, host: 'local' })
      expect(empty).toMatchObject({ status: 'available', authoritative: false, models: [] })
      expect((await t.call(A('options'), { agent: providerId })).models.map((model: { id: string }) => model.id)).toEqual(['opaque-model-7'])

      writeFileSync(modelPath, '{malformed')
      expect(await t.call(A('discoverModels'), { agent: providerId, host: 'local' })).toMatchObject({
        status: 'unavailable',
        authoritative: false,
        models: []
      })
      expect((await t.call(A('options'), { agent: providerId })).models.map((model: { id: string }) => model.id)).toEqual(['opaque-model-7'])

      writeFileSync(executable, '#!/bin/sh\nexit 9\n')
      chmodSync(executable, 0o755)
      expect(await t.call(A('discoverModels'), { agent: providerId, host: 'local' })).toMatchObject({
        status: 'unavailable',
        authoritative: false,
        models: []
      })
      expect((await t.call(A('options'), { agent: providerId })).models.map((model: { id: string }) => model.id)).toEqual(['opaque-model-7'])

      expect(await t.call(A('discoverModels'), { agent: providerId, host: 'remote-unpaired' })).toMatchObject({
        status: 'unavailable',
        authoritative: false,
        models: []
      })
      expect(await failure(t.call(A('discoverModels'), {
        agent: providerId,
        host: 'local',
        models: [{ id: 'caller-selected', label: 'Not provider-owned' }]
      }))).toMatchObject({ code: RpcErrorCode.InvalidParams })
    } finally {
      rmSync(modelPath, { force: true })
    }
  }, 30_000)
  test('Gemini discovery uses the paginated Models API with its explicit key and keeps the last complete selector on failures', async () => {
    const t = await start({ installed: ['gemini'] })
    const selectedKey = 'fixture-gemini-selected-api-key'
    const geminiKey = 'fixture-gemini-configured-api-key'
    const ambientKey = 'fixture-gemini-ambient-api-key'
    const cursor = 'fixture-gemini-page-cursor'
    process.env.GEMINI_API_KEY = ambientKey
    process.env.GOOGLE_API_KEY = 'fixture-unselected-google-api-key'
    await t.call(A('configure'), { agent: 'gemini', env: { GEMINI_API_KEY: geminiKey, GOOGLE_API_KEY: selectedKey } })

    let mode: 'complete' | 'empty' | 'malformed' | 'failed-page' | 'repeated-cursor' = 'complete'
    const requests: { url: URL; key: string | null }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push({ url, key: new Headers(init?.headers).get('x-goog-api-key') })
      if (mode === 'empty') return Response.json({ models: [] })
      if (mode === 'malformed') {
        return Response.json({
          models: [{
            name: 'models/gemini-invalid',
            baseModelId: 'gemini-invalid',
            supportedGenerationMethods: 'generateContent'
          }]
        })
      }
      if (mode === 'failed-page') {
        if (url.searchParams.has('pageToken')) return new Response(`failure included ${selectedKey}`, { status: 503 })
        return Response.json({
          models: [{ name: 'models/would-replace', baseModelId: 'would-replace', supportedGenerationMethods: ['generateContent'] }],
          nextPageToken: cursor
        })
      }
      if (mode === 'repeated-cursor') {
        const suffix = url.searchParams.get('pageToken') ?? 'first'
        return Response.json({
          models: [{
            name: `models/gemini-loop-${suffix}`,
            baseModelId: `gemini-loop-${suffix}`,
            supportedGenerationMethods: ['generateContent']
          }],
          nextPageToken: 'fixture-gemini-repeated-cursor'
        })
      }
      if (!url.searchParams.has('pageToken')) {
        return Response.json({
          models: [
            {
              name: 'models/gemini-public-1-preview',
              baseModelId: 'gemini-public-1',
              displayName: 'Gemini Public One',
              description: 'First API-listed generation model',
              supportedGenerationMethods: ['generateContent']
            },
            {
              name: 'models/text-embedding-004',
              baseModelId: 'text-embedding-004',
              displayName: 'Embedding only',
              supportedGenerationMethods: ['embedContent']
            }
          ],
          nextPageToken: cursor
        })
      }
      return Response.json({
        models: [{
          name: 'models/gemini-public-2-preview',
          baseModelId: 'gemini-public-2',
          displayName: 'Gemini Public Two',
          supportedGenerationMethods: ['countTokens', 'generateContent']
        }]
      })
    }) as typeof fetch

    try {
      const discovered = await t.call(A('discoverModels'), { agent: 'gemini', host: 'local' })
      expect(discovered).toMatchObject({
        status: 'available',
        authoritative: true,
        models: [
          { id: 'gemini-public-1', label: 'Gemini Public One', description: 'First API-listed generation model', options: [] },
          { id: 'gemini-public-2', label: 'Gemini Public Two', options: [] }
        ]
      })
      expect(requests.map(({ url }) => [url.origin, url.pathname, url.searchParams.get('pageSize'), url.searchParams.get('pageToken')]))
        .toEqual([
          ['https://generativelanguage.googleapis.com', '/v1beta/models', '1000', null],
          ['https://generativelanguage.googleapis.com', '/v1beta/models', '1000', cursor]
        ])
      expect(requests.map(({ key }) => key)).toEqual([selectedKey, selectedKey])
      expect(requests.every(({ url }) => !url.searchParams.has('key'))).toBe(true)
      expect((await t.call(A('options'), { agent: 'gemini' })).models.map((model: { id: string }) => model.id))
        .toEqual(['gemini-public-1', 'gemini-public-2'])
      expect(await t.call(A('resolveLaunch'), { agent: 'gemini', model: 'gemini-public-2' }))
        .toMatchObject({ added: ['-m', 'gemini-public-2'] })

      const retainedIds = ['gemini-public-1', 'gemini-public-2']
      for (const [nextMode, expectedStatus] of [
        ['empty', 'available'],
        ['malformed', 'unavailable'],
        ['failed-page', 'unavailable'],
        ['repeated-cursor', 'unavailable']
      ] as const) {
        mode = nextMode
        const failed = await t.call(A('discoverModels'), { agent: 'gemini', host: 'local' })
        expect(failed).toMatchObject({ status: expectedStatus, authoritative: false, models: [] })
        expect((await t.call(A('options'), { agent: 'gemini' })).models.map((model: { id: string }) => model.id)).toEqual(retainedIds)
      }

      const publicOutput = JSON.stringify({ discovered, events: t.events, logs: t.logs, options: await t.call(A('options'), { agent: 'gemini' }) })
      for (const secret of [selectedKey, geminiKey, ambientKey, cursor, 'fixture-unselected-google-api-key', 'fixture-gemini-repeated-cursor']) {
        expect(publicOutput).not.toContain(secret)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  test('Gemini discovery never borrows an inherited API key without an explicit provider setting', async () => {
    const t = await start({ installed: ['gemini'] })
    const ambientKey = 'fixture-gemini-ambient-only-key'
    process.env.GEMINI_API_KEY = ambientKey
    process.env.GOOGLE_API_KEY = 'fixture-google-ambient-only-key'
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = Object.assign(async () => {
      requests += 1
      return Response.json({ models: [{ name: 'models/should-not-run', baseModelId: 'should-not-run', supportedGenerationMethods: ['generateContent'] }] })
    }, { preconnect: originalFetch.preconnect })
    try {
      const result = await t.call(A('discoverModels'), { agent: 'gemini', host: 'local' })
      expect(result).toMatchObject({ status: 'unavailable', authoritative: false, models: [] })
      expect(result.reason).toContain('explicit Gemini API key')
      expect(requests).toBe(0)
      expect(JSON.stringify({ result, events: t.events, logs: t.logs })).not.toContain(ambientKey)
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  test('Pi RPC discovery preserves provider-qualified models and exact thinking levels from the child protocol', async () => {
    const t = await start({ installed: ['pi'] })
    const statePath = join(t.userHome, 'pi-model-state.json')
    const recordPath = join(t.userHome, 'pi-rpc-record.json')
    const models = [
      { id: 'shared-model', provider: 'provider-one', name: 'Provider One Shared', reasoning: true, baseUrl: 'https://one.invalid?key=must-not-escape' },
      { id: 'shared-model', provider: 'provider-two', name: 'Provider Two Shared', reasoning: true },
      { id: 'plain-model', provider: 'provider-one', name: 'Provider One Plain', reasoning: false }
    ]
    const thinkingLevels = {
      'provider-one/shared-model': ['off', 'low', 'high'],
      'provider-two/shared-model': ['off', 'medium']
    }
    writeFileSync(statePath, JSON.stringify({ mode: 'complete', models, thinkingLevels }))
    const executable = join(t.bin, 'pi')
    writeFileSync(executable, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs')
const statePath = ${JSON.stringify(statePath)}
const recordPath = ${JSON.stringify(recordPath)}
let selected = null
let input = ''
const requests = []
const respond = (command, success, data, error) => {
  const response = { id: command.id, type: 'response', command: command.type, success }
  if (data !== undefined) response.data = data
  if (error !== undefined) response.error = error
  process.stdout.write(JSON.stringify(response) + '\\n')
}
const handle = (command) => {
  requests.push(command)
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  if (command.type === 'get_available_models') {
    if (state.mode === 'failure') return respond(command, false, undefined, 'fixture-pi-error-token')
    return respond(command, true, { models: state.mode === 'empty' ? [] : state.models })
  }
  if (command.type === 'set_model') {
    selected = state.models.find((model) => model.provider === command.provider && model.id === command.modelId)
    return selected ? respond(command, true, selected) : respond(command, false, undefined, 'model not available')
  }
  if (command.type === 'get_available_thinking_levels') {
    return respond(command, true, { levels: state.thinkingLevels[selected.provider + '/' + selected.id] || ['off'] })
  }
  return respond(command, false, undefined, 'unknown RPC command')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (line !== '') handle(JSON.parse(line))
  }
})
process.stdin.on('end', () => writeFileSync(recordPath, JSON.stringify({ args: process.argv.slice(2), requests })))
`)
    chmodSync(executable, 0o755)

    const discovered = await t.call(A('discoverModels'), { agent: 'pi', host: 'local' })
    expect(discovered).toMatchObject({
      status: 'available',
      authoritative: true,
      models: [
        { id: 'provider-one/shared-model', label: 'Provider One Shared', options: [{ id: 'effort', choices: ['off', 'low', 'high'] }] },
        { id: 'provider-two/shared-model', label: 'Provider Two Shared', options: [{ id: 'effort', choices: ['off', 'medium'] }] },
        { id: 'provider-one/plain-model', label: 'Provider One Plain', options: [] }
      ]
    })
    const options = await t.call(A('options'), { agent: 'pi' })
    expect(options.models.map((model: { id: string }) => model.id)).toEqual([
      'provider-one/shared-model',
      'provider-two/shared-model',
      'provider-one/plain-model'
    ])
    expect(options.models[0].options.find((option: { id: string; choices: { value: string }[] }) => option.id === 'effort')?.choices.map((choice: { value: string }) => choice.value))
      .toEqual(['off', 'low', 'high'])
    expect(await t.call(A('resolveLaunch'), {
      agent: 'pi',
      model: 'provider-two/shared-model',
      options: { effort: 'medium' }
    })).toMatchObject({
      added: ['--model', 'provider-two/shared-model', '--thinking', 'medium']
    })
    const record: { args: string[]; requests: { type: string }[] } = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(record.args).toEqual(['--mode', 'rpc', '--no-session'])
    expect(record.requests.map((request) => request.type)).toEqual([
      'get_available_models',
      'set_model', 'get_available_thinking_levels',
      'set_model', 'get_available_thinking_levels'
    ])

    for (const mode of ['empty', 'failure'] as const) {
      writeFileSync(statePath, JSON.stringify({ mode, models, thinkingLevels }))
      const incomplete = await t.call(A('discoverModels'), { agent: 'pi', host: 'local' })
      expect(incomplete).toMatchObject({
        status: mode === 'empty' ? 'available' : 'unavailable',
        authoritative: false,
        models: []
      })
      expect((await t.call(A('options'), { agent: 'pi' })).models.map((model: { id: string }) => model.id)).toEqual([
        'provider-one/shared-model',
        'provider-two/shared-model',
        'provider-one/plain-model'
      ])
    }
    const output = JSON.stringify({ discovered, options, events: t.events, logs: t.logs })
    expect(output).not.toContain('must-not-escape')
    expect(output).not.toContain('fixture-pi-error-token')
  }, 30_000)
  test('Codex discovery refuses to run under a raw inherited home when account preparation is unavailable', async () => {
    const previousCodexHome = process.env.CODEX_HOME
    const inheritedCodexHome = mkdtempSync('/tmp/qag-codex-home-')
    process.env.CODEX_HOME = inheritedCodexHome
    let t: Fixture | undefined
    try {
      t = await start({ installed: ['codex'] })
      // This harness loads quirky.agents without quirky.accounts, so provider preparation is unavailable.
      const refreshed = await t.call(A('refresh'))
      expect(find(refreshed, 'codex')).toMatchObject({ installed: true })
      const originalOptions = await t.call(A('options'), { agent: 'codex' })
      expect(originalOptions).toMatchObject({ supported: true, discoverable: true })
      expect(await failure(t.call('quirky.accounts/prepareProviderEnv', { agent: 'codex', cwd: t.userHome })))
        .toMatchObject({ code: RpcErrorCode.MethodNotFound })
      const marker = join(t.userHome, 'raw-codex-probe-ran')
      const executable = join(t.bin, 'codex')
      writeFileSync(executable, `#!/bin/sh\nprintf '%s' "$CODEX_HOME" > '${marker}'\n`)
      chmodSync(executable, 0o755)

      const discovered = await t.call(A('discoverModels'), { agent: 'codex', host: 'local' })
      expect(discovered).toMatchObject({ status: 'unavailable', authoritative: false, models: [] })
      expect(existsSync(marker)).toBe(false)
      expect((await t.call(A('options'), { agent: 'codex' })).models).toEqual(originalOptions.models)
    } finally {
      if (t) {
        try { await t.h.cleanup() } catch {}
        const index = fixtures.indexOf(t)
        if (index >= 0) fixtures.splice(index, 1)
      }
      rmSync(inheritedCodexHome, { recursive: true, force: true })
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
    }
  }, 30_000)
})

describe('launch settings', () => {
  const efforts = (info: any, model: string) =>
    info.models.find((entry: any) => entry.id === model).options.find((option: any) => option.id === 'effort')?.choices.map((choice: any) => choice.value)

  test('SC-1: options lists Claude\'s four models, each with the efforts it supports', async () => {
    const t = await start()
    const info = await t.call(A('options'), { agent: 'claude' })
    expect(info).toMatchObject({ agent: 'claude', label: 'Claude', supported: true, unlisted: 'accept', structured: true })
    expect(info.models.map((model: any) => [model.id, model.label, model.description])).toEqual([
      ['fable', 'Fable', 'Most capable for the hardest, longest-running tasks'],
      ['opus', 'Opus', 'Best for everyday, complex tasks'],
      ['sonnet', 'Sonnet', 'Efficient for routine tasks'],
      ['haiku', 'Haiku', 'Fastest for quick answers']
    ])
    expect(efforts(info, 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(info.models[1].options[0]).toMatchObject({ id: 'effort', label: 'Effort', type: 'select' })
    expect(info.models[1].options[0].choices.map((choice: any) => choice.label)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max'])
    expect(info.models[3].options).toEqual([])
    expect(info.unlistedOptions.map((option: any) => option.id)).toEqual(['effort'])
    expect(info.unlistedOptions[0].choices.map((choice: any) => choice.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  test('SC-2: Codex\'s effort list stops at each model\'s ceiling', async () => {
    const t = await start()
    const info = await t.call(A('options'), { agent: 'codex' })
    expect(info.models.map((model: any) => model.label)).toEqual(['GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna', 'GPT-5.5', 'GPT-5.2 Codex'])
    expect(info.models[0].options[0].label).toBe('Reasoning effort')
    const all = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    expect(efforts(info, 'gpt-5.6-sol')).toEqual(all)
    expect(efforts(info, 'gpt-5.6-terra')).toEqual(all)
    expect(efforts(info, 'gpt-5.6-luna')).toEqual(all.slice(0, 6))
    expect(efforts(info, 'gpt-5.5')).toEqual(all.slice(0, 5))
    expect(efforts(info, 'gpt-5.2-codex')).toEqual(all.slice(0, 5))
  })

  test('SC-3: a boolean option has no choices, and unknown agents are refused', async () => {
    const t = await start()
    const cursor: { models: { id: string; options: { id: string; type: string; choices: unknown }[] }[] } = await t.call(A('options'), { agent: 'cursor' })
    const fast = cursor.models.find((model) => model.id === 'gpt-5.3-codex')?.options.find((option) => option.id === 'fastMode')
    expect(fast).toMatchObject({ type: 'boolean', choices: null })
    expect(await failure(t.call(A('options'), { agent: 'nope' }))).toMatchObject({ code: RpcErrorCode.NotFound, message: 'unknown agent: nope' })
  })

  test('SC-4: options says which extra arguments each agent accepts', async () => {
    const t = await start()
    expect((await t.call(A('options'), { agent: 'claude' })).extraArgs).toEqual({
      supported: true,
      allowed: '--model, --effort, --add-dir',
      placeholder: '--model opus --effort high --add-dir docs',
      message: null
    })
    expect((await t.call(A('options'), { agent: 'codex' })).extraArgs).toEqual({
      supported: true,
      allowed: '--model, -c model_reasoning_effort=…',
      placeholder: '-m model-id -c model_reasoning_effort=high',
      message: null
    })
    expect((await t.call(A('options'), { agent: 'aider' })).extraArgs).toEqual({
      supported: false,
      allowed: null,
      placeholder: null,
      message: "Extra arguments aren't supported for this agent yet."
    })
  })

  test('SC-12: resolveLaunch uses the saved arguments and replaces the configured model flag', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'codex', args: '--model gpt-5.4 --search' })
    const result = await t.call(A('resolveLaunch'), { agent: 'codex', model: 'gpt-5.5' })
    expect(result.args).toBe('--search -m gpt-5.5')
    expect(result.added).toEqual(['-m', 'gpt-5.5'])
    expect(result.shadowed).toEqual([])
    expect(result.launchSettings).toMatchObject({ agent: 'codex', options: { model: { value: 'gpt-5.5', source: 'explicit' } }, summary: 'Codex · GPT-5.5' })
  })

  test('SC-6: resolveLaunch yields the flags, the structured options and the snapshot', async () => {
    const t = await start()
    const result = await t.call(A('resolveLaunch'), { agent: 'claude', model: 'opus', options: { effort: 'high' } })
    expect(result).toEqual({
      added: ['--model', 'opus', '--effort', 'high'],
      args: '--dangerously-skip-permissions --model opus --effort high',
      structured: { model: 'opus', effort: 'high' },
      shadowed: [],
      launchSettings: {
        agent: 'claude',
        options: { model: { value: 'opus', source: 'explicit' }, effort: { value: 'high', source: 'explicit' } },
        args: { value: '--dangerously-skip-permissions', source: 'inherited' },
        summary: 'Claude · Opus · Effort: high'
      }
    })
  })

  test('SC-8: no pick adds nothing, and a structured resolution has no arguments', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'claude', args: '' })
    expect(await t.call(A('resolveLaunch'), { agent: 'claude' })).toEqual({ added: [], args: '', structured: {}, shadowed: [], launchSettings: null })
    await t.call(A('configure'), { agent: 'claude', reset: ['args'] })
    expect((await t.call(A('resolveLaunch'), { agent: 'claude' })).launchSettings).toEqual({
      agent: 'claude',
      options: {},
      args: { value: '--dangerously-skip-permissions', source: 'inherited' },
      summary: 'Claude'
    })
    const structured = await t.call(A('resolveLaunch'), { agent: 'claude', model: 'opus', structured: true })
    expect(structured).toMatchObject({ added: [], args: '', structured: { model: 'opus' } })
  })

  test('SC-13: extra arguments beat a pick and the result says so', async () => {
    const t = await start()
    const result = await t.call(A('resolveLaunch'), { agent: 'claude', model: 'opus', options: { effort: 'low' }, extraArgs: '--effort high --add-dir docs' })
    expect(result.args).toBe('--dangerously-skip-permissions --effort high --add-dir docs --model opus')
    expect(result.shadowed).toEqual(['effort'])
    expect(result.structured).toEqual({ model: 'opus' })
  })

  test('SC-16: a command override that sets the model fails the launch', async () => {
    const t = await start()
    await t.call(A('configure'), { agent: 'claude', command: 'claude --model sonnet' })
    const message =
      'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
    expect(await failure(t.call(A('resolveLaunch'), { agent: 'claude', model: 'opus' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message })
    expect(await failure(t.call(A('resolveLaunch'), { agent: 'claude', extraArgs: '--model opus' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message })
    expect((await t.call(A('resolveLaunch'), { agent: 'claude' })).added).toEqual([])
  })

  test('SC-9: refusals are invalid-params with the message unchanged', async () => {
    const t = await start()
    const refused = async (params: Record<string, unknown>, message: string) =>
      expect(await failure(t.call(A('resolveLaunch'), params))).toMatchObject({ code: RpcErrorCode.InvalidParams, message })
    await refused({ agent: 'claude', model: 'haiku', options: { effort: 'low' } }, 'Agent claude model haiku does not support effort low.')
    await refused({ agent: 'codex', model: 'gpt-5.5', options: { effort: 'ultra' } }, 'Agent codex model gpt-5.5 does not support effort ultra.')
    await refused({ agent: 'aider', model: 'gpt-4o' }, 'Agent aider does not support launch-time model selection.')
    await refused({ agent: 'gemini', model: 'gemini-9' }, 'Agent gemini does not support model gemini-9.')
    await refused({ agent: 'claude', model: 'opus', options: { speed: 'fast' } }, 'Agent claude model opus does not support speed fast.')
    await refused({ agent: 'cursor', model: 'claude-opus-4-8', options: { thinking: 'maybe' } }, 'Agent cursor model claude-opus-4-8 does not support thinking maybe.')
    await refused({ agent: 'claude', extraArgs: '--verbose' }, '"--verbose" isn\'t allowed in extra arguments for Claude. Allowed: --model, --effort, --add-dir.')
    await refused({ agent: 'aider', extraArgs: '--model x' }, "Extra arguments aren't supported for this agent yet.")
    await refused({ agent: 'claude', model: 'opus', extraArgs: '--add-dir x', structured: true }, "Extra arguments can't be applied to a structured session.")
    expect(await failure(t.call(A('resolveLaunch'), { agent: 'nope' }))).toMatchObject({ code: RpcErrorCode.NotFound })
  })

  test('resolveLaunch previews a disabled agent, writes no trust record and emits no change', async () => {
    const t = await start({ trust: true })
    await t.call(A('setEnabled'), { agent: 'claude', enabled: false })
    await settle()
    const before = t.changes()
    const result = await t.call(A('resolveLaunch'), { agent: 'claude', model: 'opus' })
    expect(result.args).toBe('--dangerously-skip-permissions --model opus')
    await settle()
    expect(t.changes()).toBe(before)
    expect(existsSync(join(t.userHome, '.claude.json'))).toBe(false)
    expect(await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, model: 'opus', hookArgs: [], hookEnv: {} }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'agent claude is disabled'
    })
  })

  test('prepareLaunch and plan carry a pick into the command, the record and launchSettings', async () => {
    const t = await start()
    const hookSettings = JSON.stringify({ source: 'hook' })
    const launch = await t.call(A('prepareLaunch'), {
      agent: 'claude',
      cwd: t.userHome,
      prompt: 'go',
      model: 'opus',
      options: { effort: 'high' },
      hookArgs: ['--settings', hookSettings],
      hookEnv: {}
    })
    expect(launch.command).toBe(`claude --dangerously-skip-permissions --model opus --effort high --settings '${hookSettings}' 'go'`)
    expect(launch.record.args).toBe('--dangerously-skip-permissions --model opus --effort high')
    expect(launch.launchSettings.summary).toBe('Claude · Opus · Effort: high')

    const plan = await t.call(A('plan'), { agent: 'codex', model: 'gpt-5.5', options: { effort: 'low' }, extraArgs: '--model gpt-5.4' })
    expect(plan.command).toContain('--model gpt-5.4')
    expect(plan.command).not.toContain('-m gpt-5.5')
    expect(plan.launchSettings.options.model).toEqual({ source: 'extra-args' })
  })

  test('prepareLaunch refuses a bad pick as invalid-params and writes no trust record', async () => {
    const t = await start({ trust: true })
    expect(
      await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, model: 'haiku', options: { effort: 'low' }, hookArgs: [], hookEnv: {} }))
    ).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Agent claude model haiku does not support effort low.' })
    expect(await failure(t.call(A('plan'), { agent: 'claude', extraArgs: '--add-dir $(pwd)' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: '$(pwd) uses shell syntax that extra arguments don\'t allow.'
    })
    expect(existsSync(join(t.userHome, '.claude.json'))).toBe(false)
  })

  test('prepareLaunch refuses a model with a control character as invalid-params and writes no trust record', async () => {
    const t = await start({ trust: true })
    expect(
      await failure(t.call(A('prepareLaunch'), { agent: 'claude', cwd: t.userHome, model: 'opus\u0000x', hookArgs: [], hookEnv: {} }))
    ).toMatchObject({ code: RpcErrorCode.InvalidParams, message: "invalid launch selection: the model can't contain control characters" })
    expect(existsSync(join(t.userHome, '.claude.json'))).toBe(false)
  })
})
