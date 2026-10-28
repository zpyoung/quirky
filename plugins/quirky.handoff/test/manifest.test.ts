import { afterEach, describe, expect, test } from 'bun:test'
import { checkSchemaDeclaration, parseContributionId, type PluginInfo, type UiModel } from '@quirky/protocol'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkUiKindEntry } from '../../../packages/daemon/src/plugins/ui-kinds'
import manifest from '../quirky-plugin.json'
import { builtinsDir, startHarness, type Harness } from '../../../packages/daemon/test/helpers'

const contributes = manifest.contributes as Record<string, any[]>
const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'QUIRKY_HOME', 'QUIRKY_VAULT_SOURCE_HOME', 'QUIRKY_AGENT_SEARCH_DIRS'] as const

describe('the window side of the manifest', () => {

  test('SC-1: every contributed UI entry passes the kernel validation', () => {
    const errors: string[] = []
    for (const kind of ['overlay', 'view', 'menu-item', 'command']) {
      for (const entry of contributes[kind]!) checkUiKindEntry(kind, `${kind} ${entry.id}`, entry, errors)
    }
    expect(errors).toEqual([])
  })

  test('SC-1: the menu item runs a command this plugin declares', () => {
    const parsed = parseContributionId(contributes['menu-item']![0].command)
    expect(parsed).toMatchObject({ kind: 'command', namespace: 'quirky.handoff', name: 'open' })
    expect(contributes.command!.map((entry) => entry.id)).toContain('open')
  })

  test('SC-63: declared command arguments are valid objects and required handoff inputs remain stable', () => {
    for (const entry of contributes.command!) {
      if (entry.args !== undefined) expect(checkSchemaDeclaration(entry.args, 'args', { object: true })).toEqual([])
    }
    const byId = (id: string) => contributes.command!.find((entry) => entry.id === id)!
    expect(byId('open').args.required).toEqual(['session'])
    expect(byId('open-archived').args.required).toEqual(['source'])
    expect(byId('set').args.required).toEqual(['field', 'value'])
    expect(byId('cancel').args.properties.via.enum).toEqual(['button', 'escape'])
    expect(byId('jump').args.properties).toHaveProperty('lineage')
  })
})

describe('the daemon loading the manifest', () => {
  let rig: Harness | undefined
  let root: string | undefined
  let priorEnvironment: Map<string, string | undefined> | undefined
  afterEach(async () => {
    try {
      await rig?.cleanup()
    } finally {
      rig = undefined
      if (root) rmSync(root, { recursive: true, force: true })
      root = undefined
      if (priorEnvironment) {
        for (const [name, value] of priorEnvironment) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
      priorEnvironment = undefined
    }
  })

  test('SC-1: the plugin loads without errors and the pane menu item reaches the UI contributions', async () => {
    root = mkdtempSync(join(tmpdir(), 'handoff-manifest-'))
    const home = join(root, 'quirky-home')
    const user = join(root, 'user-home')
    const xdg = join(root, 'xdg-config')
    const source = join(root, 'source-home')
    const agentSearch = join(root, 'agent-bin')
    for (const path of [home, user, xdg, source, agentSearch]) mkdirSync(path, { recursive: true })
    priorEnvironment = new Map(ENV_KEYS.map((name) => [name, process.env[name]] as const))
    process.env.HOME = user
    process.env.XDG_CONFIG_HOME = xdg
    process.env.QUIRKY_HOME = home
    process.env.QUIRKY_VAULT_SOURCE_HOME = source
    process.env.QUIRKY_AGENT_SEARCH_DIRS = agentSearch
    rig = await startHarness({ home, builtinPluginsDir: builtinsDir() })
    const client = await rig.connect('cli')
    const plugins = (await client.callAny('plugin.list', {})) as PluginInfo[]
    const info = plugins.find((plugin) => plugin.id === 'quirky.handoff')!
    expect(info.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
    expect(info.state).not.toBe('invalid')

    const model = (await client.callAny('ui.contributions', {})) as UiModel
    expect(model.menuItems).toContainEqual(expect.objectContaining({
      id: 'menu-item:quirky.handoff/hand-off',
      plugin: 'quirky.handoff',
      menu: 'quirky.terminal/pane',
      command: 'command:quirky.handoff/open'
    }))
    expect(model.overlays.map((overlay) => overlay.id)).toContain('overlay:quirky.handoff/dialog')
    expect(model.views.map((view) => view.id)).toContain('view:quirky.handoff/settings')
  })
})

