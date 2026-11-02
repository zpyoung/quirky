import { afterEach, expect, test } from 'bun:test'
import { git, isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { noteViewInput } from '../../src/notes/open-note'
import { diffViewKey } from '../../src/shared/view-input'
import { byLabel, click, messageBox, primary, primaryNow, q, qa, rowOf, text, type } from './dom'
import { boot, openView, shutdown, startGitHubFixture, viewTabs, DIFF_VIEW, type GitHubFixture, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000

let fixture: GitHubFixture | null = null

afterEach(async () => {
  try {
    await shutdown()
  } finally {
    await fixture?.restore()
    fixture = null
  }
})

const reviewTitles = () => qa('.qt-tab-title').filter((title) => text(title) === 'Review')

/** The worktree has exactly one Review tab, in the terminal's workspace and in the tab strip. */
async function expectOneReviewTab(w: World): Promise<string> {
  const tabs = await viewTabs(w, DIFF_VIEW)
  expect(tabs).toHaveLength(1)
  expect(reviewTitles()).toHaveLength(1)
  expect(qa('[data-review-tab]')).toHaveLength(1)
  return tabs[0]!.id
}

test('criterion 2: a row, the palette, a commit and a note all land in the worktree\'s one Review tab', async () => {
  const w = await boot(scratch, { published: false })
  w.commit({ 'math.ts': 'a\nb\nchanged\nd\ne\n' }, 'change math')
  const commit = w.git('rev-parse', 'HEAD')
  w.write('a.ts', 'changed a\n')
  w.write('b.ts', 'changed b\n')
  const { note } = (await w.agent.callAny('quirky.git/addNote', {
    worktree: w.feat.id, path: 'b.ts', startLine: 1, line: 1, body: 'Check this'
  })) as { note: { id: string } }
  await w.win.waitFor(() => rowOf('a.ts') && rowOf('b.ts'))
  expect(await viewTabs(w, DIFF_VIEW)).toHaveLength(0)

  await click(rowOf('a.ts'))
  await w.win.waitFor(() => qa('[data-review-tab]').length === 1)
  const review = await expectOneReviewTab(w)

  await click(rowOf('b.ts'))
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="b.ts"][data-active]'))
  expect(await expectOneReviewTab(w)).toBe(review)

  await w.run('open-changes')
  expect(await expectOneReviewTab(w)).toBe(review)

  await click(byLabel('Expand Commits'))
  const commitButton = await w.win.waitFor(() => q('[data-commit-row] button[aria-pressed]'))
  await click(commitButton)
  await w.win.waitFor(() => text(q('[data-git-view-root] .ui-scope-chip')).includes(`Commit ${commit.slice(0, 7)}`))
  expect(await expectOneReviewTab(w)).toBe(review)

  // a note has no entry point in the panel, so its open arrives the way the tab host receives one
  const fromNote = { worktree: w.feat.id, ...noteViewInput('a.ts', note.id, [], null) }
  const workspace = `id:${w.feat.id}`
  const { workspace: current } = (await w.agent.callAny('quirky.terminal/workspace', { workspace })) as {
    workspace: { activeGroup: string; revision: number }
  }
  await w.agent.callAny('quirky.terminal/openViewTab', {
    workspace,
    group: current.activeGroup,
    viewId: DIFF_VIEW,
    key: diffViewKey(fromNote),
    input: fromNote,
    title: 'Review',
    reuse: true,
    activate: true,
    closeMethod: 'quirky.git/diffCloseGuard',
    closeParams: { worktree: w.feat.id, dirty: false },
    closeContext: true,
    revision: current.revision
  })
  expect(await expectOneReviewTab(w)).toBe(review)

  await w.run('open-changes')
  await w.win.waitFor(() => q('[data-git-view-root] .ui-scope-chip') === null)
  expect(await expectOneReviewTab(w)).toBe(review)
  expect(w.problems()).toEqual([])
}, SLOW)

test('criterion 2: restoring a layout with a legacy file tab and a legacy combined tab leaves one Review tab', async () => {
  const w = await boot(scratch, { published: false })
  w.write('math.ts', 'a\nb\nchanged\nd\ne\n')
  w.write('a.ts', 'changed a\n')
  await w.win.waitFor(() => q('[data-git-panel]'))
  const workspaceId = `id:${w.feat.id}`
  type Workspace = { revision: number; activeGroup: string }
  const workspace = async () =>
    ((await w.agent.callAny('quirky.terminal/workspace', { workspace: workspaceId })) as { workspace: Workspace }).workspace
  const withRevision = async <T>(call: (state: Workspace) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call(await workspace())
      } catch (error) {
        if (attempt >= 3) throw error
      }
    }
  }
  /** A diff tab as an older version left it: the legacy mode's key and an input that names its own tab. */
  const openLegacy = async (input: Record<string, unknown>, activate = true) => {
    const legacy = { worktree: w.feat.id, ...input }
    const { tab } = await withRevision(
      async ({ activeGroup, revision }) =>
        (await w.agent.callAny('quirky.terminal/openViewTab', {
          workspace: workspaceId,
          group: activeGroup,
          viewId: DIFF_VIEW,
          key: diffViewKey(legacy as never),
          input: legacy,
          title: 'Diff',
          reuse: true,
          activate,
          closeMethod: 'quirky.git/diffCloseGuard',
          closeParams: { worktree: w.feat.id, dirty: false },
          closeContext: true,
          revision
        })) as { tab: string }
    )
    await withRevision(({ revision }) =>
      w.agent.callAny('quirky.terminal/rekeyViewTabs', {
        workspace: workspaceId,
        viewId: DIFF_VIEW,
        changes: [{ tab, key: diffViewKey(legacy as never), input: { ...legacy, tabId: tab } }],
        revision
      })
    )
    return tab
  }

  await openLegacy({ mode: 'file', source: 'unstaged', path: 'math.ts' })
  await w.win.waitFor(() => qa('[data-review-tab]').length === 1)
  const second = await openLegacy({ mode: 'combined', area: 'unstaged' }, false)
  await withRevision(({ activeGroup, revision }) =>
    w.agent.callAny('quirky.terminal/moveTab', { tab: second, split: 'right', of: activeGroup, revision })
  )
  await w.agent.callAny('quirky.terminal/activateTab', { tab: second })

  await w.win.waitFor(async () => {
    const tabs = await viewTabs(w, DIFF_VIEW)
    return tabs.length === 1 && tabs[0]!.id !== second
  })
  await w.win.waitFor(() => reviewTitles().length === 1)
  await expectOneReviewTab(w)
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="math.ts"]') && q('[data-git-view-root] section[data-path="a.ts"]'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('criterion 3: from one uncommitted file with no upstream, Commit, Publish branch and Create PR take three clicks', async () => {
  fixture = startGitHubFixture(scratch())
  const w = await boot(scratch, { published: false, noPanel: true })
  w.git('remote', 'set-url', 'origin', 'https://github.com/test-owner/test-repo.git')
  fixture.installTransport(w.originDir)
  if (git(w.dir, 'for-each-ref', '--format=%(upstream:short)', 'refs/heads/zoe/feat') !== '') git(w.dir, 'branch', '--unset-upstream', 'zoe/feat')
  fixture.setLookup('zoe/feat', { kind: 'none' })
  await w.agent.callAny('ui.panel.open', { id: 'panel:quirky.git/source-control' })
  await w.win.waitFor(() => q('[data-git-panel]'))
  w.write('math.ts', 'a\nB\nc\nd\ne\n')

  const label = async (expected: string) => {
    await w.win.waitFor(() => primaryNow().label === expected && primaryNow().enabled)
    await w.win.waitFor(async () => {
      const reported = (await w.report())?.primary
      return reported?.label === expected && reported.enabled === true
    })
    expect(primaryNow().label).toBe(expected)
  }
  let clicks = 0
  const clickShip = async () => {
    clicks += 1
    await click(primary())
  }

  await label('Commit 1 file')
  await type(messageBox(), 'Update math')

  await clickShip()
  await label('Publish branch')
  expect(w.git('log', '-1', '--format=%s')).toBe('Update math')

  await clickShip()
  await label('Create PR')
  expect(w.git('rev-parse', 'origin/zoe/feat')).toBe(w.git('rev-parse', 'HEAD'))

  await clickShip()
  const view = await w.win.waitFor(async () => {
    const shown = await openView(w)
    return shown?.id === 'view:quirky.reviews/create' ? shown : undefined
  })
  expect(view.input).toEqual({ worktree: w.feat.id })
  expect(clicks).toBe(3)
  expect(w.problems()).toEqual([])
}, SLOW)
