import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { Buffer } from 'node:buffer'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { diffViewKey } from '../../src/shared/view-input'
import { boot, shutdown, viewTabs, DIFF_VIEW, type World } from './world'
import { buttonText, byLabel, click, modifiedEditor, modS, q, qa, text, toasts } from './dom'

const { scratch } = isolateGitConfig()
const SLOW = 90_000

afterEach(shutdown)

const MATH_BASE = 'a\nb\nc\nd\ne\n'
const MATH_ON_DISK = 'a\nb\nchanged\nd\ne\n'
const MATH_TWO_CHANGES = 'a\nB\nc\nd\nE\n'

const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const card = (path: string) => q(`[data-git-view-root] section[data-path="${path}"]`)
const revertButtons = (path: string) => qa('button[name="reject"]', card(path) ?? document)

async function openChangedMath(world: World, content = MATH_ON_DISK): Promise<EditorView> {
  world.write('math.ts', content)
  await world.run('open-diff', { path: 'math.ts' })
  await world.win.waitFor(() => card('math.ts') && q('[contenteditable]', card('math.ts')!))
  return modifiedEditor(EditorView, card('math.ts')!)
}

const revertDialog = () => qa('[role="dialog"]').find((dialog) => text(dialog).includes('Revert this change?'))

async function confirmRevert(world: World, answer: 'Revert' | 'Cancel'): Promise<void> {
  const dialog = await world.win.waitFor(revertDialog)
  await click(buttonText(answer, dialog))
  await world.win.waitFor(() => revertDialog() === undefined)
}

async function pressRevert(button: HTMLElement | undefined): Promise<void> {
  if (!button) throw new Error('missing Revert button')
  button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
}

test('Revert asks first, then writes the base version of that change to disk', async () => {
  const world = await boot(scratch, { published: false })
  await openChangedMath(world)
  expect(revertButtons('math.ts')).toHaveLength(1)
  expect(text(revertButtons('math.ts')[0])).toBe('↶ Revert')

  await pressRevert(revertButtons('math.ts')[0])
  await confirmRevert(world, 'Cancel')
  expect(readFileSync(join(world.dir, 'math.ts'), 'utf8')).toBe(MATH_ON_DISK)

  await pressRevert(revertButtons('math.ts')[0])
  await confirmRevert(world, 'Revert')
  await world.win.waitFor(() => readFileSync(join(world.dir, 'math.ts'), 'utf8') === MATH_BASE)
  expect(world.git('status', '--porcelain')).toBe('')
  expect(world.problems()).toEqual([])
}, SLOW)

test('reverting one of two changes keeps the other on disk and in the card', async () => {
  const world = await boot(scratch, { published: false })
  const editor = await openChangedMath(world, MATH_TWO_CHANGES)
  expect(revertButtons('math.ts')).toHaveLength(2)

  await pressRevert(revertButtons('math.ts')[0])
  await confirmRevert(world, 'Revert')
  const expected = MATH_TWO_CHANGES.replace('B\n', 'b\n')
  await world.win.waitFor(() => readFileSync(join(world.dir, 'math.ts'), 'utf8') === expected)
  await world.win.waitFor(() => editor.state.sliceDoc() === expected)
  await world.win.waitFor(() => revertButtons('math.ts').length === 1)
  expect(world.problems()).toEqual([])
}, SLOW)

test('reverting a change that is already committed writes the base lines back as an uncommitted edit', async () => {
  const world = await boot(scratch, { published: false })
  world.commit({ 'math.ts': MATH_ON_DISK }, 'change math')
  await world.run('open-diff', { path: 'math.ts', source: 'branch' })
  await world.win.waitFor(() => card('math.ts') && revertButtons('math.ts').length === 1)

  await pressRevert(revertButtons('math.ts')[0])
  await confirmRevert(world, 'Revert')
  await world.win.waitFor(() => readFileSync(join(world.dir, 'math.ts'), 'utf8') === MATH_BASE)
  expect(world.git('status', '--porcelain')).toBe('M math.ts')
}, SLOW)

test('a revert whose write fails puts the card back and says so', async () => {
  const world = await boot(scratch, { published: false })
  const editor = await openChangedMath(world)
  const path = join(world.dir, 'math.ts')
  rmSync(path)
  mkdirSync(path)

  await pressRevert(revertButtons('math.ts')[0])
  await confirmRevert(world, 'Revert')
  await world.win.waitFor(() => toasts().some((message) => message.includes('Revert failed')))
  expect(editor.state.sliceDoc()).toBe(MATH_ON_DISK)
  expect(statSync(path).isDirectory()).toBe(true)
}, SLOW)

test('the Review tab is named Review in the tab strip, apart from an open editor tab', async () => {
  const world = await boot(scratch, { published: false })
  world.write('README.md', 'changed readme\n')
  await world.agent.callAny('quirky.editor/open', { worktree: `id:${world.feat.id}`, path: 'README.md', mode: 'source' })
  await world.win.waitFor(() => [...document.querySelectorAll('.qt-tab-title')].some((element) => element.textContent === 'README.md'))

  await world.run('open-diff', { path: 'README.md' })
  await world.win.waitFor(() => card('README.md'))
  const titles = [...document.querySelectorAll('.qt-tab-title')].map((element) => element.textContent)
  expect(titles.filter((title) => title === 'README.md')).toHaveLength(1)
  expect(titles.filter((title) => title === 'Review')).toHaveLength(1)
}, SLOW)

test('palette, branch and history opens all land in the worktree\'s one Review tab', async () => {
  const world = await boot(scratch, { published: false })
  world.commit({ 'math.ts': MATH_ON_DISK }, 'change math')
  const commit = world.git('rev-parse', 'HEAD')
  world.write('a.ts', 'changed a\n')

  await world.run('open-diff', { path: 'a.ts' })
  await world.win.waitFor(() => card('a.ts'))
  const [first] = await viewTabs(world, DIFF_VIEW)

  await world.run('open-changes')
  await world.run('open-branch-changes')
  await world.run('open-diff', { path: 'math.ts', source: 'branch' })
  await world.run('open-commit', { commit })
  await world.win.waitFor(() => text(q('[data-git-view-root] .ui-scope-chip')).includes(`Commit ${commit.slice(0, 7)}`))

  const tabs = await viewTabs(world, DIFF_VIEW)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]!.id).toBe(first!.id)
  expect(qa('[data-review-tab]')).toHaveLength(1)

  await world.run('open-changes')
  await world.win.waitFor(() => q('[data-git-view-root] .ui-scope-chip') === null && card('a.ts'))
}, SLOW)

test('restoring two legacy diff tabs leaves one Review tab showing both asks', async () => {
  const world = await boot(scratch, { published: false })
  world.write('math.ts', MATH_ON_DISK)
  world.write('a.ts', 'changed a\n')
  await world.win.waitFor(() => q('[data-git-panel]'))
  const workspaceId = `id:${world.feat.id}`
  type Workspace = { revision: number; activeGroup: string }
  const workspace = async () => ((await world.agent.callAny('quirky.terminal/workspace', { workspace: workspaceId })) as { workspace: Workspace }).workspace
  /** Runs a revision-checked call, again when another tab moved the revision first. */
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
    const legacy = { worktree: world.feat.id, ...input }
    const { tab } = await withRevision(
      async ({ activeGroup, revision }) =>
        (await world.agent.callAny('quirky.terminal/openViewTab', {
          workspace: workspaceId,
          group: activeGroup,
          viewId: DIFF_VIEW,
          key: diffViewKey(legacy as never),
          input: legacy,
          title: 'Diff',
          reuse: true,
          activate,
          closeMethod: 'quirky.git/diffCloseGuard',
          closeParams: { worktree: world.feat.id, dirty: false },
          closeContext: true,
          revision
        })) as { tab: string }
    )
    await withRevision(({ revision }) =>
      world.agent.callAny('quirky.terminal/rekeyViewTabs', {
        workspace: workspaceId,
        viewId: DIFF_VIEW,
        changes: [{ tab, key: diffViewKey(legacy as never), input: { ...legacy, tabId: tab } }],
        revision
      })
    )
    return tab
  }
  await openLegacy({ mode: 'file', source: 'unstaged', path: 'math.ts' })
  await world.win.waitFor(() => qa('[data-review-tab]').length === 1)
  const second = await openLegacy({ mode: 'combined', area: 'unstaged' }, false)
  await withRevision(({ activeGroup, revision }) =>
    world.agent.callAny('quirky.terminal/moveTab', { tab: second, split: 'right', of: activeGroup, revision })
  )
  await world.agent.callAny('quirky.terminal/activateTab', { tab: second })

  await world.win.waitFor(async () => {
    const tabs = await viewTabs(world, DIFF_VIEW)
    return tabs.length === 1 && tabs[0]!.id !== second
  })
  await world.win.waitFor(() => qa('.qt-tab-title').some((title) => text(title) === 'Review'))
  expect(qa('[data-review-tab]')).toHaveLength(1)
  await world.win.waitFor(() => card('math.ts') && card('a.ts'))
  expect(toasts()).toEqual([])
  expect(world.problems()).toEqual([])
}, SLOW)

test('the header toggles the layout for this tab only, and the menu writes the wrap and whitespace settings', async () => {
  const world = await boot(scratch, { published: false, files: { 'math.ts': numbered(60) } })
  world.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  await world.run('open-diff', { path: 'math.ts' })
  await world.win.waitFor(() => card('math.ts') && q('[contenteditable]', card('math.ts')!))
  const editors = () => qa('[role="textbox"][contenteditable]', card('math.ts')!).length
  const settingValue = async (name: string) =>
    ((await world.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value
  const before = await settingValue('diffDefaultView')

  await click(byLabel('Switch to side-by-side diff'))
  await world.win.waitFor(() => editors() === 2)
  expect(byLabel('Switch to inline diff')).not.toBeNull()
  expect(await settingValue('diffDefaultView')).toBe(before)

  const item = (name: string) => qa('[role="menuitemcheckbox"]').find((candidate) => text(candidate).endsWith(name))
  await click(byLabel('More actions'))
  await click(item('Word wrap'))
  expect(await settingValue('diffWordWrap')).toBe(true)
  await click(byLabel('More actions'))
  await click(item('Show whitespace'))
  expect(await settingValue('diffShowWhitespace')).toBe(true)
}, SLOW)

test('SC-57: a change whose merge base cannot be read says so instead of looking empty', async () => {
  const world = await boot(scratch, { files: { 'math.ts': numbered(60) } })
  world.commit({ 'math.ts': numbered(60, { 3: 'line three' }) }, 'change math')
  const blob = world.git('rev-parse', 'origin/main:math.ts')
  const common = world.git('rev-parse', '--git-common-dir')
  const loose = join(common.startsWith('/') ? common : join(world.dir, common), 'objects', blob.slice(0, 2), blob.slice(2))
  rmSync(loose)

  await world.run('open-diff', { path: 'math.ts', source: 'branch' })
  await world.win.waitFor(() => q('[data-git-view-root] [role="alert"]'))
  expect(q('[data-git-view-root] [contenteditable]')).toBeNull()
}, SLOW)

const header = (path: string) => q('header', card(path) ?? document)
const reviewMark = async (world: World, path: string) => {
  const model = (await world.agent.callAny('quirky.git/review', { worktree: world.feat.id })) as { files: Array<{ path: string; mark: string }> }
  return model.files.find((file) => file.path === path)?.mark
}

test('a save from a card keeps the file reviewed, and a write from anywhere else does not', async () => {
  const world = await boot(scratch, { published: false })
  const editor = await openChangedMath(world)
  await click(buttonText('Mark reviewed', header('math.ts')!))
  await world.win.waitFor(async () => (await reviewMark(world, 'math.ts')) === 'reviewed')
  await click(await world.win.waitFor(() => byLabel('Expand math.ts')))

  const saved = 'a\nb\nedited in the card\nd\ne\n'
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: saved } })
  await world.win.waitFor(() => text(header('math.ts')).includes('Unsaved'))
  await modS(editor)
  await world.win.waitFor(() => readFileSync(join(world.dir, 'math.ts'), 'utf8') === saved)
  await world.win.waitFor(() => !text(header('math.ts')).includes('Unsaved'))
  expect(await reviewMark(world, 'math.ts')).toBe('reviewed')
  expect(text(header('math.ts'))).toContain('✓ Reviewed')

  world.write('math.ts', 'a\nb\nagent edit\nd\ne\n')
  await world.win.waitFor(async () => (await reviewMark(world, 'math.ts')) === 'changed')
  expect(world.problems()).toEqual([])
}, SLOW)

async function dirtyReviewTab(world: World): Promise<{ id: string; editor: EditorView }> {
  const editor = await openChangedMath(world)
  editor.dispatch({ changes: { from: 0, insert: 'unsaved draft\n' } })
  const tab = await world.win.waitFor(async () => {
    const [candidate] = await viewTabs(world, DIFF_VIEW)
    const params = (candidate as { closeParams?: { dirty?: unknown } } | undefined)?.closeParams
    return params?.dirty === true ? candidate : null
  })
  return { id: tab.id, editor }
}

const closeChoice = (label: string) => buttonText(label, q('[role="dialog"]') ?? document)
const reviewTabOpen = async (world: World, id: string) => (await viewTabs(world, DIFF_VIEW)).some((tab) => tab.id === id)

test('a Review tab with unsaved edits refuses a plain close, and the dialog can keep, save or drop them', async () => {
  const world = await boot(scratch, { published: false })
  const { id, editor } = await dirtyReviewTab(world)
  const refused = await world.agent.callAny('quirky.terminal/closeTab', { tab: id, yes: true }).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
  expect(refused).toContain('refused to close')
  expect(await reviewTabOpen(world, id)).toBe(true)

  const closeButton = () => q(`[data-tab="${id}"] button.qt-tab-close`) as HTMLButtonElement
  closeButton().click()
  await world.win.waitFor(() => closeChoice('Cancel'))
  await click(closeChoice('Cancel'))
  await world.win.waitFor(() => q('[role="dialog"]') === null)
  expect(await reviewTabOpen(world, id)).toBe(true)
  expect(editor.state.sliceDoc().startsWith('unsaved draft\n')).toBe(true)
  expect(readFileSync(join(world.dir, 'math.ts'), 'utf8')).toBe(MATH_ON_DISK)

  const draft = editor.state.sliceDoc()
  closeButton().click()
  await world.win.waitFor(() => closeChoice('Save'))
  await click(closeChoice('Save'))
  await world.win.waitFor(async () => !(await reviewTabOpen(world, id)))
  expect(readFileSync(join(world.dir, 'math.ts'), 'utf8')).toBe(draft)
}, SLOW)

test("Don't Save closes a Review tab with unsaved edits and leaves the disk alone", async () => {
  const world = await boot(scratch, { published: false })
  const { id } = await dirtyReviewTab(world)
  ;(q(`[data-tab="${id}"] button.qt-tab-close`) as HTMLButtonElement).click()
  await world.win.waitFor(() => closeChoice("Don't Save"))
  await click(closeChoice("Don't Save"))
  await world.win.waitFor(async () => !(await reviewTabOpen(world, id)))
  expect(readFileSync(join(world.dir, 'math.ts'), 'utf8')).toBe(MATH_ON_DISK)
}, SLOW)

test('a Markdown card previews its disk side with a relative image the window may load', async () => {
  const world = await boot(scratch, { published: false })
  const imageBytes = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cS6sAAAAASUVORK5CYII=',
    'base64'
  ))
  const guide = 'docs/Guide.md'
  const committed = '# Committed heading\n\nHEAD body.\n\n![Chart](images/chart.png)\n'
  const modified = '# Draft heading\n\nModified body.\n\n![Chart](images/chart.png)\n'
  world.write(guide, committed)
  mkdirSync(join(world.dir, 'docs', 'images'), { recursive: true })
  writeFileSync(join(world.dir, 'docs', 'images', 'chart.png'), imageBytes)
  world.git('add', 'docs')
  world.git('commit', '-q', '-m', 'Add Markdown guide and chart')
  world.write(guide, modified)

  await world.run('open-diff', { path: guide })
  await world.win.waitFor(() => card(guide) && q('[contenteditable]', card(guide)!))
  await click(buttonText('Preview', header(guide)!))
  await world.win.waitFor(() => q('[data-markdown-preview] img', card(guide)!))
  const preview = q('[data-markdown-preview]', card(guide)!)!
  expect(text(preview)).toContain('Draft heading')
  expect(text(preview)).toContain('Modified body.')
  expect(text(preview)).not.toContain('Committed heading')

  const src = q('img', preview)!.getAttribute('src')!
  const url = new URL(src, `http://127.0.0.1:${world.harness.runtime.port}`).toString()
  const served = await fetch(url)
  expect(served.status).toBe(200)
  expect([...new Uint8Array(await served.arrayBuffer())]).toEqual([...imageBytes])
  expect(readFileSync(join(world.dir, guide), 'utf8')).toBe(modified)

  await click(buttonText('Source', header(guide)!))
  await world.win.waitFor(async () => [404, 410].includes((await fetch(url)).status))
  expect(q('[data-markdown-preview]', card(guide)!)).toBeNull()
  expect(world.problems()).toEqual([])
}, SLOW)
