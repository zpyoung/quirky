import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentHooks } from '../src/hooks/agent-hooks'
import {
  codexHooksInstalled, codexHooksPath, installCodexHooks, installPiExtensions, piExtensionPath, type AgentEnv
} from '../src/hooks/install'
import { makeTestApp, type FakeCalls, type TestApp } from './support'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'avatar-agent-hooks-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Agent = { id?: unknown; installed?: unknown; enabled?: unknown }
const listing = (...agents: unknown[]) => ({ defaultAgent: 'claude', agents })

function setup(options: {
  agents?: unknown[]
  fakeCalls?: FakeCalls
  settings?: Record<string, unknown>
  agentEnv?: AgentEnv
} = {}) {
  const fakeCalls = options.fakeCalls ?? { 'quirky.agents/list': () => listing(...(options.agents ?? [])) }
  const t = makeTestApp({ fakeCalls, settings: options.settings })
  const agentEnv = options.agentEnv ?? { home: scratch(), env: {} }
  const hooks = createAgentHooks({ app: t.app, agentEnv })
  return { t, agentEnv, hooks }
}

const readCodexFile = (agentEnv: AgentEnv): { hooks?: Record<string, HookEntry[]>; [key: string]: unknown } =>
  JSON.parse(readFileSync(codexHooksPath(agentEnv), 'utf8')) as { hooks?: Record<string, HookEntry[]>; [key: string]: unknown }
type HookEntry = { hooks?: { command?: string }[]; [key: string]: unknown }

function commandsFor(agentEnv: AgentEnv, event: string): string[] {
  return (readCodexFile(agentEnv).hooks?.[event] ?? []).flatMap((entry) =>
    (entry.hooks ?? []).flatMap((hook) => (typeof hook.command === 'string' ? [hook.command] : []))
  )
}

function avatarEntryCount(agentEnv: AgentEnv, event: string): number {
  return (readCodexFile(agentEnv).hooks?.[event] ?? []).filter((entry) =>
    (entry.hooks ?? []).some((hook) => hook.command?.includes('quirky-gate'))
  ).length
}

function captureLog(t: TestApp): string[] {
  const lines: string[] = []
  t.context.log = (message) => { lines.push(message) }
  return lines
}

describe('agent hooks', () => {
  test('29 installs Codex hooks when Codex is present, creating its config directory', async () => {
    const { agentEnv, hooks } = setup({ agents: [{ id: 'codex', installed: true, enabled: true }] })
    expect(existsSync(join(agentEnv.home, '.codex'))).toBe(false)

    await hooks.sync()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
  })

  for (const [label, agents] of [
    ['not installed', [{ id: 'codex', installed: false, enabled: true }]],
    ['disabled', [{ id: 'codex', installed: true, enabled: false }]],
    ['not listed', []]
  ] as const) {
    test(`30 leaves the agent home empty when Codex is ${label}`, async () => {
      const { agentEnv, hooks } = setup({ agents: [...agents] })

      await hooks.sync()

      expect(readdirSync(agentEnv.home)).toEqual([])
    })
  }

  test('31 logs a listing failure once and resolves without writing', async () => {
    const { t, agentEnv, hooks } = setup({ fakeCalls: {} })
    const lines = captureLog(t)

    await expect(hooks.sync()).resolves.toBeUndefined()

    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(1)
    expect(readdirSync(agentEnv.home)).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('avatar gate: could not list agents: ')).toBe(true)
  })

  test('32 installs pi only when it is listed and its agent directory exists', async () => {
    const { agentEnv, hooks } = setup({ agents: [{ id: 'pi', installed: true, enabled: true }] })
    mkdirSync(join(agentEnv.home, '.pi', 'agent'), { recursive: true })
    mkdirSync(join(agentEnv.home, '.omp', 'agent'), { recursive: true })

    await hooks.sync()

    expect(existsSync(piExtensionPath('pi', agentEnv))).toBe(true)
    expect(existsSync(piExtensionPath('omp', agentEnv))).toBe(false)
  })

  test('32 does not create a pi agent directory when pi is listed but has never been installed', async () => {
    const { agentEnv, hooks } = setup({ agents: [{ id: 'pi', installed: true, enabled: true }] })

    await hooks.sync()

    expect(readdirSync(agentEnv.home)).toEqual([])
  })

  test('33 treats a missing enabled field as enabled', async () => {
    const { agentEnv, hooks } = setup({ agents: [{ id: 'codex', installed: true }] })

    await hooks.sync()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
  })

  test('34 writes Codex commands with the configured judgment deadline', async () => {
    const { agentEnv, hooks } = setup({
      agents: [{ id: 'codex', installed: true, enabled: true }],
      settings: { 'judgment-timeout-seconds': 30 }
    })

    await hooks.sync()

    for (const event of ['PreToolUse', 'PermissionRequest']) {
      const commands = commandsFor(agentEnv, event)
      expect(commands).toHaveLength(1)
      expect(commands[0]?.includes('codex 35000')).toBe(true)
    }
  })

  test('35 removes only avatar-owned entries and extensions when switched off, without listing agents', async () => {
    const { t, agentEnv, hooks } = setup({ settings: { 'agent-hooks': false } })
    installCodexHooks(agentEnv, 55)
    const doc = readCodexFile(agentEnv)
    const userEntry = { matcher: '*', hooks: [{ type: 'command', command: 'user-hook' }] }
    doc.hooks = { ...doc.hooks, PreToolUse: [...(doc.hooks?.PreToolUse ?? []), userEntry] }
    writeFileSync(codexHooksPath(agentEnv), `${JSON.stringify(doc, null, 2)}\n`)
    mkdirSync(join(agentEnv.home, '.pi', 'agent'), { recursive: true })
    installPiExtensions(agentEnv)

    await hooks.sync()

    expect(readCodexFile(agentEnv).hooks).toEqual({ PreToolUse: [userEntry] })
    expect(existsSync(piExtensionPath('pi', agentEnv))).toBe(false)
    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
  })

  test('36 resolves without writing or listing when switched off and nothing is installed', async () => {
    const { t, agentEnv, hooks } = setup({ settings: { 'agent-hooks': false } })

    await hooks.sync()

    expect(readdirSync(agentEnv.home)).toEqual([])
    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
  })

  test('37 follows live changes to the agent-hooks setting', async () => {
    const { t, agentEnv, hooks } = setup({ agents: [{ id: 'codex', installed: true, enabled: true }] })
    await hooks.sync()
    expect(codexHooksInstalled(agentEnv)).toBe(true)

    t.settings['agent-hooks'] = false
    await t.deliver({ type: 'setting.changed', id: 'setting:quirky.avatar/agent-hooks', value: false })
    await hooks.idle()
    expect(codexHooksInstalled(agentEnv)).toBe(false)

    t.settings['agent-hooks'] = true
    await t.deliver({ type: 'setting.changed', id: 'setting:quirky.avatar/agent-hooks', value: true })
    await hooks.idle()
    expect(codexHooksInstalled(agentEnv)).toBe(true)
  })

  test('38 follows live changes to the judgment timeout', async () => {
    const { t, agentEnv, hooks } = setup({
      agents: [{ id: 'codex', installed: true, enabled: true }],
      settings: { 'judgment-timeout-seconds': 55 }
    })
    await hooks.sync()

    t.settings['judgment-timeout-seconds'] = 30
    await t.deliver({ type: 'setting.changed', id: 'setting:quirky.avatar/judgment-timeout-seconds', value: 30 })
    await hooks.idle()

    for (const event of ['PreToolUse', 'PermissionRequest']) {
      expect(commandsFor(agentEnv, event)[0]?.includes('codex 35000')).toBe(true)
    }
  })

  test('39 ignores unrelated setting changes and other event types', async () => {
    const { t, hooks } = setup({ agents: [{ id: 'codex', installed: true, enabled: true }] })
    const listingCallsBefore = t.calls.filter((call) => call.method === 'quirky.agents/list').length

    await t.deliver({ type: 'setting.changed', id: 'setting:quirky.avatar/house-rules', value: 'new rule' })
    await t.deliver({ type: 'notify', title: 'notice', body: 'body', desktop: false })
    await hooks.idle()

    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(listingCallsBefore)
  })

  test('40 logs an unreadable Codex hooks file and still installs pi', async () => {
    const { t, agentEnv, hooks } = setup({
      agents: [
        { id: 'codex', installed: true, enabled: true },
        { id: 'pi', installed: true, enabled: true }
      ]
    })
    mkdirSync(join(agentEnv.home, '.codex'), { recursive: true })
    writeFileSync(codexHooksPath(agentEnv), '{ not json')
    mkdirSync(join(agentEnv.home, '.pi', 'agent'), { recursive: true })
    const lines = captureLog(t)

    await hooks.sync()

    expect(readFileSync(codexHooksPath(agentEnv), 'utf8')).toBe('{ not json')
    expect(existsSync(piExtensionPath('pi', agentEnv))).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('avatar gate: could not install the Codex hooks: ')).toBe(true)
  })

  test('serializes three concurrent sync calls and keeps one Codex entry per event', async () => {
    let activeListings = 0
    let maxActiveListings = 0
    const listingBlocked = Promise.withResolvers<void>()
    const { agentEnv, hooks } = setup({
      fakeCalls: {
        'quirky.agents/list': async () => {
          activeListings++
          maxActiveListings = Math.max(maxActiveListings, activeListings)
          await listingBlocked.promise
          activeListings--
          return listing({ id: 'codex', installed: true, enabled: true })
        }
      }
    })
    const pending = [hooks.sync(), hooks.sync(), hooks.sync()]

    await Promise.resolve()
    listingBlocked.resolve()
    await Promise.all(pending)

    expect(maxActiveListings).toBe(1)
    for (const event of ['PreToolUse', 'PermissionRequest']) expect(avatarEntryCount(agentEnv, event)).toBe(1)
  })

  test('does not reject on a pi installation failure and logs that operation', async () => {
    const { t, agentEnv, hooks } = setup({
      agents: [
        { id: 'codex', installed: true, enabled: true },
        { id: 'pi', installed: true, enabled: true }
      ],
      agentEnv: { home: scratch(), env: {} }
    })
    const piAgentFile = join(scratch(), 'pi-agent-is-a-file')
    writeFileSync(piAgentFile, 'not a directory')
    agentEnv.env.PI_CODING_AGENT_DIR = piAgentFile
    const lines = captureLog(t)

    await expect(hooks.sync()).resolves.toBeUndefined()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('avatar gate: could not install the pi and omp extension: ')).toBe(true)
  })

  test('logs a Codex removal failure and still removes the pi extension when switched off', async () => {
    const { t, agentEnv, hooks } = setup({ settings: { 'agent-hooks': false } })
    mkdirSync(join(agentEnv.home, '.codex'), { recursive: true })
    writeFileSync(codexHooksPath(agentEnv), '{ not json')
    mkdirSync(join(agentEnv.home, '.pi', 'agent'), { recursive: true })
    installPiExtensions(agentEnv)
    const lines = captureLog(t)

    await hooks.sync()

    expect(readFileSync(codexHooksPath(agentEnv), 'utf8')).toBe('{ not json')
    expect(existsSync(piExtensionPath('pi', agentEnv))).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.startsWith('avatar gate: could not remove the Codex hooks: ')).toBe(true)
    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
  })

  test('42 does not list or write after disposal, including after a setting event', async () => {
    const { t, agentEnv, hooks } = setup({ agents: [{ id: 'codex', installed: true, enabled: true }] })
    hooks.dispose()

    await hooks.sync()
    await t.deliver({ type: 'setting.changed', id: 'setting:quirky.avatar/agent-hooks', value: false })
    await hooks.idle()

    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
    expect(readdirSync(agentEnv.home)).toEqual([])
  })

  test('43 does not touch the real home in tests and honors both safe directory overrides', async () => {
    const codexHome = scratch()
    const piAgentDir = scratch()
    const agentEnv: AgentEnv = {
      home: homedir(),
      env: { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piAgentDir }
    }
    const { t, hooks } = setup({
      agents: [
        { id: 'codex', installed: true, enabled: true },
        { id: 'pi', installed: true, enabled: true }
      ],
      agentEnv
    })

    await hooks.sync()

    expect(readdirSync(codexHome)).toEqual([])
    expect(readdirSync(piAgentDir)).toEqual([])
    expect(t.calls.filter((call) => call.method === 'quirky.agents/list')).toHaveLength(0)
  })

  for (const [label, response] of [
    ['a null listing', null],
    ['a listing without an agents array', { defaultAgent: 'claude' }],
    ['a listing with a non-array agents field', { agents: { id: 'codex', installed: true } }]
  ] as const) {
    test(`treats ${label} as no installed agents`, async () => {
      const { agentEnv, hooks } = setup({ fakeCalls: { 'quirky.agents/list': () => response } })

      await hooks.sync()

      expect(readdirSync(agentEnv.home)).toEqual([])
    })
  }

  test('skips listing entries that are not objects or have no string id', async () => {
    const { agentEnv, hooks } = setup({
      fakeCalls: {
        'quirky.agents/list': () => listing(null, 'codex', {}, { id: 7, installed: true }, { id: 'codex', installed: 'true' })
      }
    })

    await hooks.sync()

    expect(readdirSync(agentEnv.home)).toEqual([])
  })

  test('treats an error reading agent-hooks as enabled', async () => {
    const { t, agentEnv, hooks } = setup({
      agents: [{ id: 'codex', installed: true, enabled: true }],
      settings: { 'judgment-timeout-seconds': 30 }
    })
    t.context.getSetting = (name) => {
      if (name === 'agent-hooks') throw new Error('setting unavailable')
      return t.settings[name]
    }

    await hooks.sync()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
  })

  test('keeps installed Codex hooks when a later listing reports Codex absent', async () => {
    let agents: Agent[] = [{ id: 'codex', installed: true, enabled: true }]
    const { agentEnv, hooks } = setup({ fakeCalls: { 'quirky.agents/list': () => listing(...agents) } })
    await hooks.sync()
    expect(codexHooksInstalled(agentEnv)).toBe(true)

    agents = []
    await hooks.sync()

    expect(codexHooksInstalled(agentEnv)).toBe(true)
  })
})
