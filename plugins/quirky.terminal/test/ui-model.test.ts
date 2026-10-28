import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginInfo, QuirkyClient, Repo, UiModel, Worktree } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '../../../packages/git/src/testing'
import { builtinsDir, startHarness, makeTempHome, type Harness } from '../../../packages/daemon/test/helpers'
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

describe('the built-ins as the window sees them', () => {
  test('the terminal plugin is valid, with no error diagnostics', async () => {
    const plugins = (await client.call('plugin.list', {})) as PluginInfo[]
    const terminal = plugins.find((plugin) => plugin.id === 'quirky.terminal')!
    expect(terminal.diagnostics.filter((diagnostic) => diagnostic.level === 'error')).toEqual([])
  })

  test('SC-70: the worktree view is the terminal plugin\'s workspace, and the session plugin keeps its other view', () => {
    const view = model.views.find((entry) => entry.id === 'view:quirky.session/worktree')!
    expect(view).toMatchObject({ plugin: 'quirky.terminal', title: 'Worktree' })
    expect(model.views.find((entry) => entry.id === 'view:quirky.session/structured')?.plugin).toBe('quirky.session')
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
