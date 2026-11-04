import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ApiDescription, CliContext, ContributionInfo, PluginInfo } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'

const PLUGIN_DIR = resolve(import.meta.dir, '..')
const DEPENDENCIES = [
  'quirky.worktree', 'quirky.session', 'quirky.agent-status', 'quirky.agents', 'quirky.ask', 'quirky.checks',
  'quirky.git', 'quirky.hosting', 'quirky.structured', 'quirky.heimdall', 'quirky.notifications'
]

const harnesses = new Set<Harness>()
const tempDirs: string[] = []

afterEach(async () => {
  for (const harness of [...harnesses]) await harness.cleanup()
  harnesses.clear()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Built-ins holding the avatar and an empty plugin for each of its dependencies, so only the avatar's own code runs. */
function avatarPluginsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qav-bi-'))
  tempDirs.push(dir)
  symlinkSync(PLUGIN_DIR, join(dir, 'quirky.avatar'))
  for (const id of DEPENDENCIES) {
    mkdirSync(join(dir, id))
    writeFileSync(join(dir, id, 'quirky-plugin.json'), JSON.stringify({ id, apiVersion: '1.0.0', name: id, version: '0.1.0', activation: 'lazy' }))
  }
  return dir
}

async function startAvatar(): Promise<Harness> {
  const harness = await startHarness({ home: makeTempHome('qav-'), builtinPluginsDir: avatarPluginsDir() })
  harnesses.add(harness)
  return harness
}

const ids = (contributions: unknown) => (contributions as { id: string }[]).map((entry) => entry.id).sort()

describe('quirky.avatar as a built-in plugin', () => {
  test('loads as a valid startup built-in with its dependencies and no error diagnostics', async () => {
    const client = await (await startAvatar()).connect('cli')
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.avatar')!
    expect(info).toMatchObject({ source: 'builtin', activation: 'startup', apiVersion: '1.2.0', dependencies: DEPENDENCIES })
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(info.state).toBe('active')
  })

  test('the catalog lists its methods, event and CLI commands', async () => {
    const client = await (await startAvatar()).connect('cli')
    const api = (await client.call('api.describe', {})) as ApiDescription
    const methods = api.methods.filter((method) => method.plugin === 'quirky.avatar')
    expect(methods.map((method) => method.name)).toEqual([
      'quirky.avatar/eligibility',
      'quirky.avatar/handoff',
      'quirky.avatar/log',
      'quirky.avatar/mandate',
      'quirky.avatar/report',
      'quirky.avatar/resolveNeed',
      'quirky.avatar/setSettings',
      'quirky.avatar/settings',
      'quirky.avatar/sidebarStatus',
      'quirky.avatar/status',
      'quirky.avatar/takeBack'
    ])
    expect(api.events.filter((event) => event.plugin === 'quirky.avatar').map((event) => event.name)).toEqual(['quirky.avatar/changed'])
    expect(api.cli.groups.find((group) => group.plugin === 'quirky.avatar')).toEqual({ plugin: 'quirky.avatar', words: 'avatar', aliases: [] })
    expect(api.cli.commands.filter((command) => command.plugin === 'quirky.avatar').map((command) => command.words).sort()).toEqual([
      'avatar handoff',
      'avatar log',
      'avatar report',
      'avatar status',
      'avatar take-back'
    ])
  })

  test('declares the gate, hooks, jobs and every UI contribution', async () => {
    const client = await (await startAvatar()).connect('cli')
    const contributions = async (kind: string) => ids(await client.call('plugin.contributions', { kind } as never))
    expect(await contributions('tool-gate')).toEqual(['tool-gate:quirky.avatar/gate'])
    expect(await contributions('launch-hook')).toContain('launch-hook:quirky.avatar/gate-hooks')
    expect(await contributions('window-bar-item')).toEqual(['window-bar-item:quirky.avatar/pill'])
    expect(await contributions('panel')).toEqual(['panel:quirky.avatar/panel'])
    expect(await contributions('view')).toEqual(['view:quirky.avatar/avatar'])
    expect(await contributions('overlay')).toEqual(['overlay:quirky.avatar/sheet'])
    expect(await contributions('command')).toEqual(['command:quirky.avatar/handoff', 'command:quirky.avatar/open-report'])
    expect(await contributions('settings-section')).toEqual(['settings-section:quirky.avatar/avatar'])
    expect(await contributions('setting')).toEqual(
      [
        'default-level', 'switch-messaging', 'switch-history-rewrite', 'switch-deploys', 'house-rules', 'allow-commands',
        'deny-commands', 'deploy-commands', 'brain-agent', 'brain-model', 'judgment-timeout-seconds'
      ].map((name) => `setting:quirky.avatar/${name}`).sort()
    )
    const [gate] = (await client.call('plugin.contributions', { kind: 'tool-gate' } as never)) as unknown as ContributionInfo[]
    expect(gate!.data.agents).toEqual(['claude', 'codex', 'pi', 'omp'])
    const [panel] = (await client.call('plugin.contributions', { kind: 'panel' } as never)) as unknown as ContributionInfo[]
    expect(panel!.data.defaultSlot).toBe('left-bottom')
  })

  test('the watchdog runs every minute and the records check every 15 seconds', async () => {
    const client = await (await startAvatar()).connect('cli')
    const jobs = (await client.call('job.list', {})) as { id: string; plugin: string; intervalMs: number }[]
    expect(jobs.find((job) => job.id === 'job:quirky.avatar/watchdog')).toMatchObject({ plugin: 'quirky.avatar', intervalMs: 60_000 })
    expect(jobs.find((job) => job.id === 'job:quirky.avatar/records')).toMatchObject({ plugin: 'quirky.avatar', intervalMs: 15_000 })
    expect(await client.call('job.run', { id: 'job:quirky.avatar/watchdog' })).toMatchObject({ status: 'ok' })
  })

  test('its methods answer through the daemon, with stub results until a module replaces them', async () => {
    const client = await (await startAvatar()).connect('cli')
    const call = (method: string, params: Record<string, unknown> = {}) => client.call(method as never, params as never) as unknown as Promise<unknown>
    expect(await call('quirky.avatar/status')).toEqual({ handoffs: [], needsYouCount: 0 })
    expect(await call('quirky.avatar/eligibility')).toEqual([])
    expect(await call('quirky.avatar/sidebarStatus')).toEqual({})
    expect(await call('quirky.avatar/settings')).toMatchObject({ defaultLevel: 'full', judgmentTimeoutSeconds: 55 })
    await expect(call('quirky.avatar/mandate')).rejects.toMatchObject({ message: expect.stringContaining('worktreeId') })
  })
})

describe('quirky avatar CLI module', () => {
  test('has a handler for every declared command and each fails with not implemented', async () => {
    expect(Object.keys(commands).sort()).toEqual(['handoff', 'log', 'report', 'status', 'take-back'])
    const ctx = { fail: (message: string) => new Error(message) } as unknown as CliContext
    for (const handler of Object.values(commands)) {
      await expect(handler({ positionals: [], flags: {} }, ctx)).rejects.toThrow('not implemented')
    }
  })
})
