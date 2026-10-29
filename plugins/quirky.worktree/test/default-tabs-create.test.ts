import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { QuirkyClient, Repo, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { makeOrigin, makeProject } from './fixtures/repos'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { isTerminalTab, type GroupNode, type Tab, type Workspace } from '../../quirky.terminal/src/layout/types'

const { scratch } = isolateGitConfig()
const plugins = ['quirky.cli', 'quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.git']
let harness: PluginHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function start(): Promise<{ repo: Repo; dir: string; root: string; t: PluginHarness; ui: QuirkyClient }> {
  const t = await startPluginHarness({
    realGit: true,
    plugins,
    fakeSession: false,
    home: makeHomeWithoutAutoHooks('qw-default-tabs-home-')
  })
  harness = t
  const root = makeTempDir('qw-default-tabs-root-')
  await t.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const config = [
    'defaultTabs:',
    '  - title: Development',
    '    color: "#aabbcc"',
    '    command: printf development',
    '  - title: Tests',
    '    color: "#334455"',
    '    command: printf tests'
  ].join('\n')
  const origin = makeOrigin(join(scratch(), 'default-tabs-origin.git'), { files: { 'a.txt': 'one\n', 'orca.yaml': `${config}\n` } })
  const dir = makeProject(join(scratch(), 'default-tabs-project'), { origin })
  const repo = await t.client.callAny('quirky.repo/add', { path: dir }) as Repo
  const ui = await t.connectAs({}, 'ui')
  return { repo, dir, root, t, ui }
}

test('create applies selected shared default tabs through the terminal owner without stealing focus', async () => {
  const { repo, t, ui } = await start()
  const { connId } = await ui.callAny('ui.window.self', {}) as { connId: number }
  const before = await ui.callAny('ui.window.state', { connId }) as { layout: { view: unknown } }
  const hooks = await t.client.callAny('quirky.repo/hooks', { repo: repo.id, ref: 'HEAD' }) as {
    defaultTabs?: Array<{ title?: string; color?: string; command?: string }>
  }
  expect(hooks.defaultTabs).toEqual([
    { title: 'Development', color: '#aabbcc', command: 'printf development' },
    { title: 'Tests', color: '#334455', command: 'printf tests' }
  ])

  const result = await t.client.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'selected-tabs',
    defaultTabs: ['2'],
    trustSetup: true
  }) as WorktreeCreateResult

  const terminal = await t.client.callAny('quirky.terminal/workspace', { workspace: result.worktree.id }) as { workspace: Workspace }
  const pendingGroups: GroupNode[] = [terminal.workspace.root]
  const tabs: Tab[] = []
  while (pendingGroups.length > 0) {
    const node = pendingGroups.pop()!
    if (node.kind === 'split') pendingGroups.push(node.first, node.second)
    else tabs.push(...node.tabs)
  }
  const terminalTabs = tabs.filter(isTerminalTab)
  expect(terminalTabs).toHaveLength(1)
  expect(terminalTabs[0]).toMatchObject({ defaultTitle: 'Tests', color: '#334455' })
  expect((await t.client.callAny('quirky.session/list', { worktree: result.worktree.id }) as Array<{ agent: string }>).map((session) => session.agent)).toEqual(['shell'])
  expect((await ui.callAny('ui.window.state', { connId }) as { layout: { view: unknown } }).layout.view).toEqual(before.layout.view)
  expect(git(result.worktree.path, 'status', '--short')).toBe('')
})

test('invalid default-tab selections and untrusted shared commands refuse before creating a worktree', async () => {
  const { repo, dir, t } = await start()
  for (const params of [{ defaultTabs: ['missing'] }, { defaultTabs: ['1', '1'] }]) {
    await expect(t.client.callAny('quirky.worktree/create', { repo: repo.id, name: 'invalid-tabs', ...params })).rejects.toThrow()
    expect(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  }
  await expect(t.client.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'untrusted-tabs',
    defaultTabs: ['1']
  })).rejects.toThrow()
  expect(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
})
