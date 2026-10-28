import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Repo, UiState, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { makeOrigin, makeProject } from './fixtures/repos'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

const { scratch } = isolateGitConfig()
const plugins = ['quirky.repo', 'quirky.worktree', 'quirky.session', 'quirky.terminal', 'quirky.git']
let harness: PluginHarness | undefined

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

async function start(): Promise<{ repo: Repo; dir: string; root: string; t: PluginHarness }> {
  const t = await startPluginHarness({
    realGit: true,
    plugins,
    fakeSession: true,
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
  await t.connectAs({}, 'ui')
  return { repo, dir, root, t }
}

test('create applies selected shared default tabs through the terminal owner without stealing focus', async () => {
  const { repo, dir, t } = await start()
  const before = await t.client.callAny('ui.state', {}) as UiState
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
  }) as WorktreeCreateResult & { creationReceipt: { defaultTabs?: Array<{ title: string; tab: string; session: string }> } }

  expect(result.creationReceipt.defaultTabs).toHaveLength(1)
  expect(result.creationReceipt.defaultTabs?.[0]).toMatchObject({ title: 'Tests' })
  expect((await t.client.callAny('quirky.session/list', { worktree: result.worktree.id }) as Array<{ agent: string }>).map((session) => session.agent)).toEqual(['shell'])
  expect((await t.client.callAny('ui.state', {}) as UiState).layout.view).toEqual(before.layout.view)
  expect(git(result.worktree.path, 'status', '--short')).toBe('')
  expect(dir).toBeDefined()
})

test('invalid default-tab selections and untrusted shared commands refuse before creating a worktree', async () => {
  const { repo, dir, t } = await start()
  for (const params of [{ defaultTabs: ['missing'] }, { defaultTabs: ['1', '1'] }]) {
    await expect(t.client.callAny('quirky.worktree/create', { repo: repo.id, name: 'invalid-tabs', ...params })).rejects.toThrow(/default tab|selection|duplicate/i)
    expect(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
  }
  await expect(t.client.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'untrusted-tabs',
    defaultTabs: ['1']
  })).rejects.toThrow(/not been trusted|hooks|trust/i)
  expect(git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree '))).toHaveLength(1)
})
