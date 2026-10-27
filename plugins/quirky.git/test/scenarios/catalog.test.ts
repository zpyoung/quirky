import { afterEach, describe, expect, test } from 'bun:test'
import type { ApiCatalog, ContributionInfo } from '@quirky/protocol'
import { isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined
afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

const METHODS = [
  'status', 'diff', 'stage', 'unstage', 'discard', 'describeDiscard', 'commit', 'push', 'forcePush', 'describeForcePush',
  'pull', 'fastForward', 'fetch', 'sync', 'rebaseFromBase', 'continue', 'abort', 'describeAbort', 'compare', 'setBase',
  'branches', 'history', 'commitFiles', 'conflictFile', 'save', 'submoduleStatus', 'hugeFolders', 'ignoreFolder', 'reveal'
]

describe('SC-66: the API lists every method with its schema (CLI)', () => {
  test('quirky api --json lists each quirky.git method with params, result and description, and flags the destructive ones', async () => {
    s = await startScenario(scratch)
    const doc = JSON.parse((await s.cli(['api', '--json'])).stdout) as ApiCatalog
    const git = doc.methods.filter((method) => method.plugin === 'quirky.git')
    expect(git.map((method) => method.name.replace('quirky.git/', '')).sort()).toEqual([...METHODS].sort())

    for (const method of git) {
      expect(method.description, method.name).toBeTruthy()
      expect(method.params.type, method.name).toBe('object')
      expect(method.result, method.name).toBeDefined()
      for (const [name, schema] of Object.entries(method.params.properties ?? {})) {
        expect(schema.description, `${method.name} ${name}`).toBeTruthy()
      }
    }
    expect(git.filter((method) => method.destructive).map((method) => method.name).sort()).toEqual([
      'quirky.git/abort',
      'quirky.git/discard',
      'quirky.git/forcePush'
    ])
    for (const name of ['describeDiscard', 'describeForcePush', 'describeAbort', 'status', 'compare', 'history']) {
      expect(git.find((method) => method.name === `quirky.git/${name}`)?.readOnly, name).toBe(true)
    }
    for (const name of ['stage', 'unstage', 'commit', 'save', 'continue']) {
      expect(git.find((method) => method.name === `quirky.git/${name}`)?.readOnly, name).toBeUndefined()
    }

    const commands = doc.commands.filter((command) => command.plugin === 'quirky.git').map((command) => command.command.replace('git ', ''))
    expect(commands.sort()).toEqual([...METHODS].sort())
    const discard = doc.commands.find((command) => command.command === 'git discard')!
    expect(discard.flags.find((flag) => flag.name === 'paths')).toMatchObject({ type: 'string', repeatable: true })
    expect(discard.flags.find((flag) => flag.name === 'area')).toMatchObject({ enum: ['staged', 'unstaged', 'untracked'] })
  })

  test('quirky git --help lists the same commands', async () => {
    s = await startScenario(scratch)
    const help = (await s.cli(['git', '--help'])).stdout
    for (const name of METHODS) expect(help, name).toContain(name)
  })

  test('the window contributions: commands, keybindings, settings and the diff view', async () => {
    s = await startScenario(scratch)
    const contributions = (await s.client.callAny('plugin.contributions', { pluginId: 'quirky.git' })) as ContributionInfo[]
    const ofKind = (kind: string) => contributions.filter((c) => c.kind === kind)
    expect(ofKind('view').map((c) => [c.name, c.data.title])).toEqual([['diff', 'Diff']])
    expect(ofKind('keybinding').map((c) => [c.name, c.data.key, c.data.command]).sort()).toEqual([
      ['next-change', 'f7', 'next-change'],
      ['previous-change', 'shift+f7', 'previous-change'],
      ['show', 'mod+shift+g', 'show']
    ])
    expect(ofKind('command').map((c) => c.name).sort()).toEqual([
      'collapse-all', 'load-diff', 'next-change', 'next-conflict', 'open-branch-changes', 'open-changes', 'open-commit', 'open-diff',
      'overwrite', 'previous-change', 'previous-conflict', 'refresh-compare', 'reload-from-disk', 'revert-change', 'review-conflicts',
      'save', 'select', 'set-filter', 'show', 'toggle-history'
    ])
    const settings = Object.fromEntries(ofKind('setting').map((c) => [c.name, c.data.default]))
    expect(settings).toEqual({
      groupOrder: 'changes-first',
      compareBase: 'repository-default',
      viewMode: 'list',
      diffDefaultView: 'inline',
      diffWordWrap: false,
      diffShowWhitespace: false,
      diffCollapseUnchanged: false,
      combinedDiffFileTree: 'hidden'
    })
    expect(ofKind('setting').find((c) => c.name === 'groupOrder')!.data).toMatchObject({
      title: 'Source Control Group Order',
      values: ['changes-first', 'staged-first', 'untracked-first']
    })
    expect(ofKind('command').find((c) => c.name === 'open-diff')!.data.args).toMatchObject({
      properties: { path: { type: 'string' }, source: { type: 'string' } },
      required: ['path']
    })
  })
})
