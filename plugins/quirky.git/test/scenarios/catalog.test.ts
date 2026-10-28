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
  'branches', 'history', 'commitFiles', 'conflictFile', 'save', 'submoduleStatus', 'hugeFolders', 'ignoreFolder', 'reveal',
  'notes', 'addNote', 'editNote', 'deleteNote', 'clearNotes', 'describeClearNotes', 'formatNotes', 'noteTargets', 'sendNotes',
  'generateCommitMessage', 'cancelGenerate', 'aiFix', 'aiFixPreview', 'aiRecipe', 'setAiRecipe'
]

describe('SC-66: the API lists every method with its schema (CLI)', () => {
  test('CLI catalog marks destructive Git operations and preserves typed discard flags', async () => {
    s = await startScenario(scratch)
    const doc = JSON.parse((await s.cli(['api', '--json'])).stdout) as ApiCatalog
    const git = doc.methods.filter((method) => method.plugin === 'quirky.git')

    expect(git.filter((method) => method.destructive).map((method) => method.name).sort()).toEqual([
      'quirky.git/abort',
      'quirky.git/clearNotes',
      'quirky.git/discard',
      'quirky.git/forcePush'
    ])
    for (const name of ['describeDiscard', 'describeForcePush', 'describeAbort', 'status', 'compare', 'history']) {
      expect(git.find((method) => method.name === `quirky.git/${name}`)?.readOnly, name).toBe(true)
    }
    for (const name of ['stage', 'unstage', 'commit', 'save', 'continue']) {
      expect(git.find((method) => method.name === `quirky.git/${name}`)?.readOnly, name).toBeUndefined()
    }

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
    expect(ofKind('view').map((c) => [c.name, c.data.title]).sort()).toEqual([
      ['ai-settings', 'Source Control AI defaults'],
      ['diff', 'Diff']
    ])
    expect(ofKind('keybinding').map((c) => [c.name, c.data.key, c.data.command]).sort()).toEqual([
      ['add-review-note', 'mod+shift+a', 'add-review-note'],
      ['next-change', 'f7', 'next-change'],
      ['previous-change', 'shift+f7', 'previous-change'],
      ['show', 'mod+shift+g', 'show']
    ])
    expect(ofKind('command').map((c) => c.name).sort()).toEqual([
      'add-review-note', 'ai-settings', 'collapse-all', 'load-diff', 'next-change', 'next-conflict', 'open-branch-changes', 'open-changes', 'open-commit', 'open-diff',
      'overwrite', 'previous-change', 'previous-conflict', 'refresh-compare', 'reload-from-disk', 'revert-change', 'review-conflicts',
      'save', 'select', 'send-review-notes', 'set-filter', 'show', 'toggle-history'
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
      combinedDiffFileTree: 'hidden',
      'ai-enabled': true,
      'ai-custom-command': ''
    })
    expect(ofKind('setting').find((c) => c.name === 'groupOrder')!.data).toMatchObject({
      title: 'Source Control Group Order',
      values: ['changes-first', 'staged-first', 'untracked-first']
    })
    expect(ofKind('command').find((c) => c.name === 'ai-settings')!.data).toMatchObject({ title: 'Source Control AI Settings' })
    expect(ofKind('command').find((c) => c.name === 'open-diff')!.data.args).toMatchObject({
      properties: { path: { type: 'string' }, source: { type: 'string' } },
      required: ['path']
    })
  })
})
