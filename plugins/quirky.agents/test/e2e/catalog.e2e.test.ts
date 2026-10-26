import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyEvent, Session } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type StartOptions } from '../support/e2e'

type AgentRow = {
  id: string
  label: string
  plugin: string
  installed: boolean
  enabled: boolean
  isDefault: boolean
  promptMode: string
  resumable: boolean
  homepage: string | null
  install: string | null
  permissions: { mode: string | null; hasAuto: boolean }
}

type Listing = {
  defaultAgent: string
  permissions: { summary: string }
  agents: AgentRow[]
  problems?: { plugin: string; id: string; status: string; error: string }[]
}

const FIXTURES = join(import.meta.dir, 'fixtures')
const MANIFEST = join(import.meta.dir, '../../quirky-plugin.json')

let e2e: E2E | undefined
const scratch: string[] = []

afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function start(options?: StartOptions): Promise<E2E> {
  e2e = await startAgentsE2E(options)
  return e2e
}

async function cliJson<T>(harness: E2E, args: string[]): Promise<T> {
  const result = await harness.cli([...args, '--json'])
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

const listing = (harness: E2E, ...flags: string[]) => cliJson<Listing>(harness, ['agents', 'list', ...flags])

const installedIds = (value: Listing) => value.agents.filter((agent) => agent.installed).map((agent) => agent.id)

async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

async function installPlugin(harness: E2E, name: string): Promise<void> {
  await harness.call('plugin.install', { path: join(FIXTURES, name), yes: true })
}

async function recordEvents(harness: E2E): Promise<QuirkyEvent[]> {
  const events: QuirkyEvent[] = []
  harness.client.onEvent((event) => events.push(event))
  await harness.client.call('events.subscribe', {})
  return events
}

const createSession = (harness: E2E, params: Record<string, unknown> = {}) =>
  harness.call('quirky.session/create', { worktree: `path:${harness.repo}`, ...params }) as Promise<Session>

const startCount = (harness: E2E, name: string) => harness.fakeLog(name).filter((event) => event.type === 'start').length

function startArgv(harness: E2E, name: string): string[] {
  const started = harness.fakeLog(name).find((event) => event.type === 'start')
  if (started?.type !== 'start') throw new Error(`fake ${name} never started`)
  return started.argv
}

function executable(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('catalog', () => {
  test(
    'SC-1: the catalog lists the 45 built-in agents with what each can do',
    async () => {
      const harness = await start({ fakes: { claude: true, codex: true } })
      const result = await listing(harness)

      expect(result.defaultAgent).toBe('auto')
      expect(result.permissions.summary).toBe('yolo')
      expect(result.agents).toHaveLength(45)
      const manifestOrder = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { contributes: { agent: { id: string }[] } }).contributes.agent.map((entry) => entry.id)
      expect(result.agents.map((agent) => agent.id)).toEqual(manifestOrder)

      for (const agent of result.agents) {
        expect(agent.plugin).toBe('quirky.agents')
        expect(agent.enabled).toBe(true)
        expect(agent.isDefault).toBe(false)
        expect(agent.label.length).toBeGreaterThan(0)
        expect(agent).toHaveProperty('homepage')
        expect(agent).toHaveProperty('install')
      }
      expect(installedIds(result)).toEqual(['claude', 'claude-agent-teams', 'codex'])

      const byId = new Map(result.agents.map((agent) => [agent.id, agent]))
      expect(byId.get('claude')).toMatchObject({ installed: true, promptMode: 'argv', resumable: true, permissions: { mode: 'yolo' } })
      expect(byId.get('codex')?.installed).toBe(true)
      expect(byId.get('aider')).toMatchObject({ installed: false, promptMode: 'stdin-after-start', resumable: false })
      expect(byId.get('opencode')?.permissions.mode).toBeNull()
    },
    60_000
  )

  test(
    'SC-2: a plugin adds an agent, and it launches',
    async () => {
      const harness = await start({ fakes: { 'acme-bot': true } })
      await installPlugin(harness, 'acme.agents')

      const added = await waitFor(async () => (await listing(harness)).agents.find((agent) => agent.id === 'acme-bot'), 15_000, 'acme-bot in the catalog')
      expect(added).toMatchObject({ installed: true, plugin: 'acme.agents' })

      const session = await createSession(harness, { agent: 'acme-bot', prompt: 'fix it' })
      expect(session).toMatchObject({ agent: 'acme-bot', status: 'running', promptDelivery: 'command-line' })

      await harness.waitForFakeLog('acme-bot', (events) => events.some((event) => event.type === 'start'), 15_000)
      expect(startArgv(harness, 'acme-bot')).toEqual(['--yes', '--prompt', 'fix it'])
    },
    60_000
  )

  test(
    'SC-3: a plugin replaces or removes a built-in agent',
    async () => {
      const harness = await start()
      await installPlugin(harness, 'acme.override')
      await installPlugin(harness, 'acme.trim')

      const result = await waitFor(async () => {
        const value = await listing(harness)
        return value.agents.length === 44 ? value : undefined
      }, 15_000, 'aider to leave the catalog')
      expect(result.agents.some((agent) => agent.id === 'aider')).toBe(false)
      expect(result.agents.find((agent) => agent.id === 'codex')?.plugin).toBe('acme.override')

      const plan = await cliJson<{ command: string }>(harness, ['agents', 'plan', 'codex'])
      expect(plan.command.startsWith('codex --profile acme')).toBe(true)
    },
    60_000
  )

  test(
    'SC-4: a malformed or duplicate agent entry is skipped and reported',
    async () => {
      const harness = await start()
      await installPlugin(harness, 'acme.bad')
      await installPlugin(harness, 'acme.dupe')

      const all = await waitFor(async () => {
        const value = await listing(harness, '--all')
        return (value.problems ?? []).length >= 2 ? value : undefined
      }, 15_000, 'both problems to be reported')

      const plain = await listing(harness)
      expect(plain.agents).toHaveLength(45)
      expect(plain.agents.find((agent) => agent.id === 'claude')?.plugin).toBe('quirky.agents')
      expect(plain.agents.some((agent) => agent.id === 'broken')).toBe(false)
      expect(plain.problems).toBeUndefined()

      const broken = all.problems!.find((problem) => problem.id === 'broken')
      expect(broken).toMatchObject({ plugin: 'acme.bad', status: 'invalid' })
      expect(broken!.error).toContain('detect command is required')
      const dupe = all.problems!.find((problem) => problem.plugin === 'acme.dupe')
      expect(dupe).toMatchObject({ id: 'claude', status: 'conflict' })
      expect(dupe!.error).toContain('quirky.agents')
      expect(dupe!.error).toContain('overrides')
    },
    60_000
  )
})

describe('detection', () => {
  test(
    'SC-5: detection finds commands on the login shell PATH and in install directories',
    async () => {
      const root = realpathSync(mkdtempSync('/tmp/qs-'))
      scratch.push(root)
      const loginBin = join(root, 'loginbin')
      const localBin = join(root, 'localbin')
      const bunBin = join(root, 'bunbin')
      const marker = join(root, 'ran')
      for (const [dir, name] of [
        [loginBin, 'claude'],
        [localBin, 'qwen'],
        [bunBin, 'kimi-code']
      ] as const) {
        executable(join(dir, name), `echo ${name} >> ${marker}`)
      }
      const loginShell = join(root, 'login-sh')
      executable(loginShell, `[ "$1" = "-l" ] && shift\nPATH="${loginBin}:$PATH" exec /bin/sh "$@"`)

      const harness = await start({
        searchDirs: `${localBin}:${bunBin}`,
        extraEnv: { SHELL: loginShell, PATH: '/usr/bin:/bin' }
      })
      const result = await listing(harness)

      expect(installedIds(result)).toEqual(['claude', 'claude-agent-teams', 'kimi', 'qwen-code'])
      expect(existsSync(marker)).toBe(false)
    },
    60_000
  )

  test(
    'SC-6: required commands and aliases decide installed',
    async () => {
      const harness = await start({ fakes: { 'dsh-tui': true, qodercn: true, claude: true } })
      const before = await listing(harness)
      const state = (value: Listing, id: string) => value.agents.find((agent) => agent.id === id)?.installed

      expect(state(before, 'dsh')).toBe(false)
      expect(state(before, 'qoder-cn')).toBe(true)
      expect(state(before, 'claude-agent-teams')).toBe(true)

      harness.removeFake('claude')
      const refreshed = await cliJson<Listing>(harness, ['agents', 'refresh'])
      expect(state(refreshed, 'claude')).toBe(false)
      expect(state(refreshed, 'claude-agent-teams')).toBe(false)

      harness.addFake('dsh')
      const withDsh = await cliJson<Listing>(harness, ['agents', 'refresh'])
      expect(state(withDsh, 'dsh')).toBe(true)
    },
    60_000
  )

  test(
    'SC-7: refresh picks up a newly installed agent',
    async () => {
      const harness = await start()
      const events = await recordEvents(harness)
      const gemini = (value: Listing) => value.agents.find((agent) => agent.id === 'gemini')?.installed

      expect(gemini(await listing(harness))).toBe(false)
      harness.addFake('gemini')
      expect(gemini(await listing(harness))).toBe(false)

      const refreshed = await cliJson<Listing>(harness, ['agents', 'refresh'])
      expect(gemini(refreshed)).toBe(true)
      await waitFor(() => events.some((event) => event.type === 'quirky.agents/changed'), 5000, 'quirky.agents/changed')
      expect(gemini(await listing(harness))).toBe(true)
    },
    60_000
  )
})

describe('choosing the agent', () => {
  test(
    'SC-8: a launch without an agent uses the default, then auto-pick, then a shell',
    async () => {
      const harness = await start({ fakes: { codex: true, gemini: true } })
      const setDefault = (agent: string) => harness.call('quirky.agents/setDefault', { agent })
      const expectStarts = async (name: string, count: number) => {
        await waitFor(() => startCount(harness, name) === count, 15_000, `${name} to have started ${count} time(s)`)
      }

      await setDefault('auto')
      expect((await createSession(harness)).agent).toBe('codex')
      await expectStarts('codex', 1)

      await setDefault('gemini')
      expect((await createSession(harness)).agent).toBe('gemini')
      await expectStarts('gemini', 1)

      await setDefault('claude')
      expect((await createSession(harness)).agent).toBe('codex')
      await expectStarts('codex', 2)

      await setDefault('shell')
      expect((await createSession(harness)).agent).toBe('shell')

      await setDefault('auto')
      await harness.call('quirky.agents/setEnabled', { agent: 'codex', enabled: false })
      expect((await createSession(harness)).agent).toBe('gemini')
      await expectStarts('gemini', 2)
      expect(startCount(harness, 'codex')).toBe(2)

      harness.removeFake('codex')
      harness.removeFake('gemini')
      await harness.call('quirky.agents/refresh', {})
      expect((await createSession(harness)).agent).toBe('shell')
      expect(startCount(harness, 'gemini')).toBe(2)
    },
    90_000
  )

  test(
    'SC-10: a disabled agent is hidden and can not be launched by name',
    async () => {
      const harness = await start({ fakes: { claude: true, codex: true } })
      const events = await recordEvents(harness)
      expect((await cliJson<Listing>(harness, ['agents', 'default', 'claude'])).defaultAgent).toBe('claude')

      const disabled = await harness.cli(['agents', 'disable', 'claude'])
      expect(disabled.code).toBe(0)
      await waitFor(() => events.some((event) => event.type === 'quirky.agents/changed'), 5000, 'quirky.agents/changed')

      const after = await listing(harness)
      expect(after.defaultAgent).toBe('auto')
      expect(after.agents.find((agent) => agent.id === 'claude')).toMatchObject({ enabled: false, isDefault: false })
      const picked = (params: Record<string, unknown>) => (harness.call('quirky.agents/pick', params) as Promise<{ agent: string }>).then((result) => result.agent)
      expect(await picked({})).not.toBe('claude')
      expect(await picked({ forAgentTab: true })).not.toBe('claude')

      const refused = await harness.cli(['session', 'new', '--agent', 'claude'])
      expect(refused.code).not.toBe(0)
      expect(refused.stderr + refused.stdout).toContain('agent claude is disabled')
      expect(await cliJson<Session[]>(harness, ['session', 'list'])).toEqual([])
      expect(startCount(harness, 'claude')).toBe(0)

      const enabled = await harness.cli(['agents', 'enable', 'claude'])
      expect(enabled.code).toBe(0)
      const restored = await listing(harness)
      expect(restored.agents.find((agent) => agent.id === 'claude')?.enabled).toBe(true)
      expect(restored.defaultAgent).toBe('auto')
    },
    60_000
  )
})
