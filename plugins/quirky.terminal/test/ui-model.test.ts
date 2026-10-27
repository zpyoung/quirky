import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginInfo, QuirkyClient, Repo, UiKeybinding, UiModel, Worktree } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '../../../packages/git/src/testing'
import { builtinsDir, startHarness, makeTempHome, type Harness } from '../../../packages/daemon/test/helpers'
import manifest from '../quirky-plugin.json'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import { isTerminalTab } from '../src/layout/types'
import type { PaneLeaf, TerminalTab, Workspace } from '../src/layout/types'

const findGroupTabs = (workspace: Workspace): TerminalTab[] => groupsInOrder(workspace.root).flatMap((group) => group.tabs.filter(isTerminalTab))

let h: Harness
let client: QuirkyClient
let model: UiModel
let scratch: string
let main: Worktree

beforeAll(async () => {
  scratch = realpathSync(mkdtempSync('/tmp/qtm-'))
  const apiDir = join(scratch, 'api')
  mkdirSync(apiDir)
  const git = createFakeGit()
  git.addRepo(apiDir)
  useTestGit(git)
  h = await startHarness({ home: makeTempHome('qtm-'), builtinPluginsDir: builtinsDir() })
  client = await h.connect('ui')
  model = (await client.call('ui.contributions', {})) as UiModel
  const agent = await h.connect('cli', 'setup')
  ;(await agent.callAny('quirky.repo/add', { path: apiDir })) as Repo
  main = ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((worktree) => worktree.isMain)!
})

afterAll(async () => {
  useTestGit(null)
  await h?.cleanup()
  rmSync(scratch, { recursive: true, force: true })
})

const byKey = (chord: string): UiKeybinding[] => model.keybindings.filter((binding) => binding.key === chord)

describe('the built-ins as the window sees them', () => {
  test('the terminal plugin is valid, with no error diagnostics', async () => {
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const terminal = plugins.find((plugin) => plugin.id === 'quirky.terminal')!
    expect(terminal.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  test('SC-63: every binding of the terminal plugin and the session plugin is active, none shadowed or unbound', () => {
    const bindings = model.keybindings.filter((binding) => binding.plugin === 'quirky.terminal' || binding.plugin === 'quirky.session')
    const own = bindings.filter((binding) => binding.plugin === 'quirky.terminal')
    expect(own).toHaveLength(manifest.contributes.keybinding.length)
    expect(bindings.filter((binding) => binding.status !== 'active')).toEqual([])
    expect(model.keybindings.filter((binding) => binding.status !== 'active')).toEqual([])
  })

  test('SC-63: terminal-scope keys carry the terminalFocus condition and the app-scope keys carry none', () => {
    const conditional = model.keybindings.filter((binding) => binding.plugin === 'quirky.terminal' && binding.when !== undefined)
    expect(conditional.every((binding) => binding.when === 'terminalFocus')).toBe(true)
    expect(conditional.map((binding) => binding.key).sort()).toEqual(
      ['mod+c', 'mod+a', 'mod+v', 'mod+f', 'mod+g', 'mod+shift+g', 'mod+k', 'mod+]', 'mod+[', 'mod+shift+enter', 'mod+w', 'mod+d', 'mod+shift+d', 'mod+=', 'mod+shift+=', 'mod+-', 'mod+0'].sort()
    )
    const plain = model.keybindings.filter((binding) => binding.plugin === 'quirky.terminal' && binding.when === undefined).map((binding) => binding.key)
    expect(plain).toEqual(expect.arrayContaining(['mod+r', 'mod+shift+t', 'ctrl+tab', 'ctrl+pagedown', 'ctrl+pageup', 'mod+alt+a', 'mod+alt+shift+a', 'ctrl+1', 'ctrl+9']))
  })

  test('SC-63: mod+w has two active groups, the session close-session and the terminal close-pane under terminalFocus', () => {
    expect(
      byKey('mod+w')
        .map((binding) => [binding.plugin, binding.command, binding.when ?? null, binding.status])
        .sort()
    ).toEqual([
      ['quirky.session', 'command:quirky.session/close-session', null, 'active'],
      ['quirky.terminal', 'command:quirky.terminal/close-pane', 'terminalFocus', 'active']
    ])
  })

  test('SC-63: mod+t and the mod+digit keys still run the session commands, now implemented by the terminal plugin', () => {
    expect(byKey('mod+t').map((binding) => [binding.command, binding.status])).toEqual([['command:quirky.session/new-shell', 'active']])
    for (let n = 1; n <= 9; n += 1) {
      expect(byKey(`mod+${n}`).map((binding) => [binding.command, binding.status])).toEqual([[`command:quirky.session/select-tab-${n}`, 'active']])
      expect(byKey(`ctrl+${n}`).map((binding) => [binding.command, binding.status])).toEqual([[`command:quirky.session/select-tab-${n}`, 'active']])
    }
    const owners = Object.fromEntries(model.commands.filter((command) => /\/(new-shell|close-session|select-tab(-\d)?)$/.test(command.id)).map((command) => [command.id, command.plugin]))
    expect(Object.values(owners)).toHaveLength(12)
    expect(new Set(Object.values(owners))).toEqual(new Set(['quirky.terminal']))
  })

  test('SC-70: the worktree view is the terminal plugin\'s workspace, and the session plugin keeps its other view', () => {
    const view = model.views.find((entry) => entry.id === 'view:quirky.session/worktree')!
    expect(view).toMatchObject({ plugin: 'quirky.terminal', title: 'Worktree' })
    expect(model.views.find((entry) => entry.id === 'view:quirky.session/structured')?.plugin).toBe('quirky.session')
  })

  test('the panels and the floating overlay are declared and the module may provide every command', () => {
    expect(model.panels.filter((entry) => entry.plugin === 'quirky.terminal').map((entry) => entry.id).sort()).toEqual([
      'panel:quirky.terminal/quick-commands',
      'panel:quirky.terminal/sessions'
    ])
    expect(model.overlays.map((entry) => [entry.id, entry.plugin, entry.title])).toEqual([['overlay:quirky.terminal/floating', 'quirky.terminal', 'Floating Workspace']])
    const provides = model.modules['quirky.terminal']!.provides
    expect(provides).toEqual(
      expect.arrayContaining([
        'view:quirky.session/worktree',
        'overlay:quirky.terminal/floating',
        'panel:quirky.terminal/quick-commands',
        'command:quirky.session/new-shell',
        'command:quirky.session/select-tab-9',
        ...manifest.contributes.command.map((command) => `command:quirky.terminal/${command.id}`)
      ])
    )
  })

  test('a mod+w press resolves like the window does: the terminal binding while a terminal has focus, the session one otherwise', () => {
    const active = byKey('mod+w').filter((binding) => binding.status === 'active')
    const applicable = (terminalFocus: boolean) => active.filter((binding) => binding.when === undefined || terminalFocus)
    const pick = (terminalFocus: boolean) => {
      const list = applicable(terminalFocus)
      return (list.find((binding) => binding.when !== undefined) ?? list[0])!.command
    }
    expect(pick(true)).toBe('command:quirky.terminal/close-pane')
    expect(pick(false)).toBe('command:quirky.session/close-session')
  })
})

describe('the pane methods over the daemon', () => {
  test('clearPane and resetPane accept a revision, answer with the unchanged workspace and keep the revision', async () => {
    const agent = await h.connect('cli', 'revision')
    const first = (await agent.callAny('quirky.terminal/workspace', { workspace: main.id, ensure: true })) as { workspace: Workspace }
    const pane = (paneLeaves(findGroupTabs(first.workspace)[0]!.root)[0] as PaneLeaf).id
    const { revision } = first.workspace

    for (const method of ['clearPane', 'resetPane']) {
      const result = (await agent.callAny(`quirky.terminal/${method}`, { pane, revision })) as { workspace: Workspace }
      expect(Object.keys(result)).toEqual(['workspace'])
      expect(result.workspace.revision).toBe(revision)
      expect(result.workspace.id).toBe(first.workspace.id)
    }
    await expect(agent.callAny('quirky.terminal/clearPane', { pane, revision: revision + 5 })).rejects.toThrow(`workspace ${main.id} is at revision ${revision}`)
    const after = (await agent.callAny('quirky.terminal/workspace', { workspace: main.id })) as { workspace: Workspace }
    expect(after.workspace.revision).toBe(revision)
  })
})
