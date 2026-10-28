import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitStatusEntry } from '@quirky/protocol'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, byText, click, edit, expectOpened, failure, fakeContext, layoutFor, mountView, numbered, settle, status, stubIntersectionObserver, textDiff } = s

const small = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts']
const row = (path: string, extra: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path,
  area: 'unstaged',
  status: 'modified',
  added: 2,
  removed: 1,
  ...extra
})
const entries = (): GitStatusEntry[] => [
  row('conflict.ts', { area: 'conflicts', conflict: { kind: 'both_modified', state: 'unresolved' } }),
  ...small.map((path) => row(path)),
  row('big.txt', { added: 12_000, removed: 0 })
]

const diffOf = (path: string) =>
  textDiff({ path, original: numbered(30, path), modified: numbered(30, path).replace('1\n', 'one\n') })

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null
let observer: ReturnType<typeof stubIntersectionObserver>
let loading: { active: number; peak: number; order: string[] }

const open = async (input: object = { worktree: 'w1', mode: 'combined', area: 'unstaged' }) => {
  mounted = mountView(fake, input)
  await settle()
  return mounted
}

const sectionOf = (root: ParentNode, path: string) => root.querySelector<HTMLElement>(`section[data-path="${path}"]`)!

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  observer = stubIntersectionObserver()
  loading = { active: 0, peak: 0, order: [] }
  fake.handlers['quirky.git/status'] = () => status(entries())
  fake.handlers['quirky.git/diff'] = async (params) => {
    loading.active++
    loading.peak = Math.max(loading.peak, loading.active)
    loading.order.push(params.path as string)
    await Promise.resolve()
    loading.active--
    return diffOf(params.path as string)
  }
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
  observer.restore()
})

describe('quirky.git combined diff', () => {
  test('SC-62: reads "Changes" with the file count, and the toolbar has the named buttons', async () => {
    const { element } = await open()
    expect(element.querySelector('h2')?.textContent).toBe('Changes')
    expect(element.querySelector('[aria-label="8 changed files"]')?.textContent).toBe('8 changed files')
    const labels = [...(element.querySelector('h2')?.closest('header')?.querySelectorAll('button') ?? [])].map((b) => b.textContent)
    expect(labels).toEqual([
      'Open Branch Diff',
      'Collapse All',
      'Side by Side',
      'Wrap On',
      'Whitespace On',
      'Show file tree',
      '✕'
    ])
  })

  test('SC-62: the first six sections load at once, one at a time, and the rest wait for the scroll', async () => {
    const { element } = await open()
    expect(loading.order).toEqual(small.slice(0, 6))
    expect(loading.peak).toBe(1)
    expect(sectionOf(element, 'f7.ts').textContent).toContain('Loading diff...')
    expect(sectionOf(element, 'f1.ts').querySelector('.cm-editor')).not.toBeNull()
  })

  test('SC-62: a section loads when it scrolls into view, with the status read once', async () => {
    const { element } = await open()
    await observer.reveal(sectionOf(element, 'f7.ts'))
    expect(loading.order.at(-1)).toBe('f7.ts')
    expect(sectionOf(element, 'f7.ts').querySelector('.cm-editor')).not.toBeNull()
    expect(fake.callsTo('quirky.git/status').length).toBe(1)
  })

  test('SC-62: a large section shows the prompt and loads on "Load diff"', async () => {
    const { element, report } = await open()
    const big = sectionOf(element, 'big.txt')
    await observer.reveal(big)
    expect(loading.order).not.toContain('big.txt')
    expect(big.textContent).toContain('Large diffs are not rendered by default.')
    await click(byText(big, 'Load diff'))
    expect(loading.order).toContain('big.txt')
    expect(report().loadedSections).toContain('big.txt')
    expect(big.textContent).not.toContain('Large diffs')
  })

  test('SC-64: the load-diff command loads the section like its button', async () => {
    const { report } = await open()
    await act(async () => void (await fake.run('load-diff', { path: 'big.txt' })))
    expect(report().loadedSections).toContain('big.txt')
    await expect(fake.run('load-diff', { path: 'nope.ts' })).rejects.toThrow('No section for nope.ts.')
    await expect(fake.run('load-diff')).rejects.toThrow('load-diff needs a path.')
  })

  test('SC-62: a section whose size is unknown loads on request, and says so', async () => {
    fake.handlers['quirky.git/status'] = () => status([{ path: 'mystery.ts', area: 'unstaged', status: 'modified' }])
    const { element } = await open()
    expect(element.textContent).toContain("This diff's size isn't known yet, so it loads on request.")
    expect(loading.order).toEqual([])
    await click(byText(element, 'Load diff'))
    expect(loading.order).toEqual(['mystery.ts'])
  })

  test('SC-62: unresolved conflicts are left out with the notice and Review conflicts', async () => {
    const { element } = await open()
    expect(element.querySelector('section[data-path="conflict.ts"]')).toBeNull()
    const text = element.textContent ?? ''
    expect(text).toContain('Conflicted files are reviewed separately')
    expect(text).toContain('1 unresolved conflicts were excluded from this diff view.')
    await click(byText(element, 'Review conflicts'))
    expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'conflicts' })
  })

  test('SC-62: each section header shows the path, counts, copy path and Open diff', async () => {
    const { element } = await open()
    const head = sectionOf(element, 'f1.ts').querySelector('header')!
    expect(head.querySelector('[title="f1.ts"]')?.textContent).toBe('f1.ts')
    expect(head.querySelector('[aria-label="Added 2 lines"]')?.textContent).toBe('+2')
    expect(head.querySelector('[aria-label="Removed 1 line"]')?.textContent).toBe('-1')
    expect(byText(head, 'Copy path')).not.toBeNull()
    await click(byText(head, 'Open diff'))
    expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'f1.ts' })
  })

  test('SC-62: Collapse All hides every section and becomes Expand All; the command does the same', async () => {
    const { element, report } = await open()
    expect(report().collapsed).toBe(false)
    await click(byText(element, 'Collapse All'))
    expect(report().collapsed).toBe(true)
    expect([...element.querySelectorAll<HTMLElement>('section[data-path] > div[hidden]')].every((b) => b.hidden)).toBe(true)
    expect(byText(element, 'Expand All')).not.toBeNull()
    await click(byText(element, 'Expand All'))
    expect(report().collapsed).toBe(false)
    await act(async () => void (await fake.run('collapse-all', { collapsed: true })))
    await settle()
    expect(report().collapsed).toBe(true)
    await act(async () => void (await fake.run('collapse-all')))
    await settle()
    expect(report().collapsed).toBe(false)
    await act(async () => void (await fake.run('collapse-all', { collapsed: false })))
    await settle()
    expect(report().collapsed).toBe(false)
  })

  test('SC-62: a single section collapses from its chevron', async () => {
    const { element } = await open()
    await click(byLabel(element, 'Collapse f2.ts'))
    expect(sectionOf(element, 'f2.ts').querySelector<HTMLElement>(':scope > div[hidden]')!.hidden).toBe(true)
    expect(sectionOf(element, 'f1.ts').querySelector<HTMLElement>(':scope > div[hidden]')!.hidden).toBe(false)
  })

  test('SC-64: load-diff still works on a collapsed section', async () => {
    const { report } = await open()
    await act(async () => void (await fake.run('collapse-all', { collapsed: true })))
    await act(async () => void (await fake.run('load-diff', { path: 'big.txt' })))
    expect(report()).toMatchObject({ collapsed: true })
    expect(report().loadedSections).toContain('big.txt')
  })

  test('SC-62: the toolbar toggles write their settings and flip their labels', async () => {
    const { element } = await open()
    await click(byText(element, 'Side by Side'))
    expect(fake.settings.diffDefaultView).toBe('side-by-side')
    expect(byText(element, 'Inline')).not.toBeNull()
    expect(sectionOf(element, 'f1.ts').querySelectorAll('.cm-mergeViewEditor').length).toBe(2)
    await click(byText(element, 'Wrap On'))
    expect(fake.settings.diffWordWrap).toBe(true)
    expect(byText(element, 'Wrap Off')).not.toBeNull()
    await click(byText(element, 'Whitespace On'))
    expect(fake.settings.diffShowWhitespace).toBe(true)
    expect(byText(element, 'Whitespace Off')).not.toBeNull()
    await click(byText(element, 'Inline'))
    expect(fake.settings.diffDefaultView).toBe('inline')
  })

  test('SC-62: Show file tree lists the files and writes combinedDiffFileTree', async () => {
    const { element } = await open()
    expect(element.querySelector('nav[aria-label=Files]')).toBeNull()
    await click(byText(element, 'Show file tree'))
    expect(fake.settings.combinedDiffFileTree).toBe('shown')
    const items = [...element.querySelectorAll('nav[aria-label="Files"] button[aria-pressed]')].map((i) => i.textContent)
    expect(items).toEqual([...small, 'big.txt'])
    expect(byText(element, 'Hide file tree')).not.toBeNull()
    await click(byText(element, 'Hide file tree'))
    expect(element.querySelector('nav[aria-label=Files]')).toBeNull()
  })

  test('SC-62: the file tree starts shown when the setting says so', async () => {
    fake.settings.combinedDiffFileTree = 'shown'
    const { element } = await open()
    expect(element.querySelector('nav[aria-label=Files]')).not.toBeNull()
  })

  test('SC-62: Open Branch Diff opens the branch combined diff, titled with its base', async () => {
    const { element } = await open()
    await click(byText(element, 'Open Branch Diff'))
    expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'branch' })
    mounted!.unmount()
    fake.handlers['quirky.git/compare'] = () => ({
      status: 'ready',
      base: 'origin/main',
      baseSource: 'detected',
      message: null,
      baseOid: 'b'.repeat(40),
      headOid: 'a'.repeat(40),
      mergeBase: 'b'.repeat(40),
      ahead: 1,
      behind: 0,
      entries: [{ path: 'util.ts', status: 'added', added: 3, removed: 0, binary: false }],
      added: 3,
      removed: 0
    })
    const branch = await open({ worktree: 'w1', mode: 'combined', area: 'branch' })
    expect(branch.element.querySelector('h2')?.textContent).toBe('Branch Changes (origin/main)')
    expect(fake.callsTo('quirky.git/diff').at(-1)?.params).toEqual({ worktree: 'w1', path: 'util.ts', source: 'branch' })
    expect(byText(branch.element, 'Open All Changes')).not.toBeNull()
    expect(branch.element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
    await click(byText(branch.element, 'Open All Changes'))
    expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'combined', area: 'all' })
  })

  test('SC-62: a branch compare that is not ready says why', async () => {
    fake.handlers['quirky.git/compare'] = () => ({
      status: 'invalid-base',
      base: 'nope',
      baseSource: 'param',
      message: 'Base ref nope was not found.',
      baseOid: null,
      headOid: null,
      mergeBase: null,
      ahead: 0,
      behind: 0,
      entries: [],
      added: 0,
      removed: 0
    })
    const { element } = await open({ worktree: 'w1', mode: 'combined', area: 'branch' })
    expect(element.textContent).toContain('Base ref nope was not found.')
  })

  test('SC-62: All changes lists staged, unstaged and untracked, then the branch', async () => {
    fake.handlers['quirky.git/status'] = () =>
      status([
        row('s.ts', { area: 'staged' }),
        row('u.ts'),
        row('n.txt', { area: 'untracked', status: 'untracked', added: 1, removed: 0 })
      ])
    fake.handlers['quirky.git/compare'] = () => ({
      status: 'ready',
      base: 'main',
      baseSource: 'detected',
      message: null,
      baseOid: 'b'.repeat(40),
      headOid: 'a'.repeat(40),
      mergeBase: 'b'.repeat(40),
      ahead: 1,
      behind: 0,
      entries: [{ path: 'c.ts', status: 'modified', added: 1, removed: 0, binary: false }],
      added: 1,
      removed: 0
    })
    const { element } = await open({ worktree: 'w1', mode: 'combined', area: 'all' })
    expect([...element.querySelectorAll('section')].map((e) => e.dataset.path)).toEqual(['s.ts', 'u.ts', 'n.txt', 'c.ts'])
    const sources = fake.callsTo('quirky.git/diff').map((c) => c.params.source)
    expect(sources).toEqual(['staged', 'unstaged', 'unstaged', 'branch'])
    expect(element.querySelector('h2')?.textContent).toBe('All Changes')
  })

  test('a commit\'s combined diff reads commitFiles and diffs each file against that commit', async () => {
    const oid = 'c'.repeat(40)
    fake.handlers['quirky.git/commitFiles'] = () => ({
      commit: oid,
      parent: null,
      entries: [{ path: 'a.ts', status: 'added', added: 1, removed: 0, binary: false }]
    })
    const { element } = await open({ worktree: 'w1', mode: 'combined', commit: 'ccccccc' })
    expect(fake.callsTo('quirky.git/commitFiles')[0].params).toEqual({ worktree: 'w1', commit: 'ccccccc' })
    expect(fake.callsTo('quirky.git/diff')[0].params).toEqual({ worktree: 'w1', path: 'a.ts', source: 'commit', commit: oid })
    expect(element.querySelector('h2')?.textContent).toBe('Commit ccccccc')
    expect(byText(element, 'Open Branch Diff')).toBeNull()
  })

  test('no changes: says so', async () => {
    fake.handlers['quirky.git/status'] = () => status([])
    const { element } = await open()
    expect(element.textContent).toContain('No changes to display')
  })

  test('a section that fails to load shows git\'s message and retries', async () => {
    let fail = true
    fake.handlers['quirky.git/status'] = () => status([row('f1.ts')])
    fake.handlers['quirky.git/diff'] = () => {
      if (fail) throw new Error('bad object')
      return diffOf('f1.ts')
    }
    const { element } = await open()
    expect(element.textContent).toContain('Error loading diff: bad object')
    fail = false
    await click(byText(element, 'Retry'))
    expect(element.querySelector('.cm-editor')).not.toBeNull()
  })

  test('a failed status read shows the error', async () => {
    fake.handlers['quirky.git/status'] = () => {
      throw new Error('not a repository')
    }
    const { element } = await open()
    expect(element.textContent).toContain('Error loading diff: not a repository')
  })

  test('SC-60: F7 and Shift+F7 walk the changes across sections and wrap', async () => {
    const twoChanges = (path: string) =>
      textDiff({
        path,
        original: numbered(30, path),
        modified: numbered(30, path).replace(`${path} 3\n`, 'three\n').replace(`${path} 25\n`, 'twenty-five\n')
      })
    const handler = fake.handlers['quirky.git/diff']
    fake.handlers['quirky.git/diff'] = async (params) =>
      params.path === 'f1.ts' || params.path === 'f2.ts' ? twoChanges(params.path) : handler(params)
    const { report } = await open()
    const seen: unknown[] = [report().currentChange]
    for (const id of ['next-change', 'next-change', 'next-change', 'previous-change', 'previous-change']) {
      await act(async () => void (await fake.run(id)))
      await settle()
      seen.push(report().currentChange)
    }
    expect(seen).toEqual([1, 2, 1, 2, 1, 2])
  })

  test('a refresh revalidates each loaded section once, and the counts follow the status', async () => {
    const { element } = await open()
    fake.handlers['quirky.git/status'] = () =>
      status(entries().map((e) => (e.path === 'f1.ts' ? row('f1.ts', { added: 5, removed: 5 }) : e)))
    const before = fake.callsTo('quirky.git/diff').length
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(fake.callsTo('quirky.git/diff').slice(before).map((c) => c.params.path)).toEqual(small.slice(0, 6))
    expect(sectionOf(element, 'f1.ts').querySelector('[aria-label="Added 5 lines"]')?.textContent).toBe('+5')
    expect(sectionOf(element, 'f1.ts').querySelector('[aria-label="Removed 5 lines"]')?.textContent).toBe('-5')
  })

  test('a loaded section whose file is rewritten with the same counts shows the new content', async () => {
    const { element } = await open()
    const rewritten = diffOf('f1.ts').modified.replace('one', 'uno')
    fake.handlers['quirky.git/diff'] = (params) =>
      params.path === 'f1.ts' ? textDiff({ ...diffOf('f1.ts'), modified: rewritten, modifiedHash: 'hash-2' }) : diffOf(params.path as string)
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(s.modifiedEditor(element, 0).state.sliceDoc()).toBe(rewritten)
    expect(s.modifiedEditor(element, 1).state.sliceDoc()).toBe(diffOf('f2.ts').modified)
  })

  test('a section with edits whose file is rewritten under it is flagged stale and keeps the edits', async () => {
    const { element, report } = await open()
    edit(element, 'mine\n', 0)
    await settle()
    fake.handlers['quirky.git/diff'] = (params) =>
      params.path === 'f1.ts' ? textDiff({ ...diffOf('f1.ts'), modified: 'agent\n', modifiedHash: 'hash-2' }) : diffOf(params.path as string)
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(sectionOf(element, 'f1.ts').querySelector('[role="alert"]')).not.toBeNull()
    expect(report().stale).toBe(true)
    expect(s.modifiedEditor(element, 0).state.sliceDoc()).toBe('mine\n')
  })
})

describe('quirky.git combined diff: editable sections', () => {
  const modifiedText = (path: string) => diffOf(path).modified

  test('SC-62: an unstaged section saves like a single diff, and its header shows the M marker', async () => {
    const { element, report } = await open()
    fake.handlers['quirky.git/save'] = () => ({ hash: 'hash-2' })
    edit(element, 'mine\n', 1)
    await settle()
    expect(sectionOf(element, 'f2.ts').querySelector('[aria-label="Unsaved changes"]')).not.toBeNull()
    expect(sectionOf(element, 'f1.ts').querySelector('[aria-label="Unsaved changes"]')).toBeNull()
    expect(report().dirty).toBe(true)
    await act(async () => void (await fake.run('save')))
    await settle()
    expect(fake.callsTo('quirky.git/save').map((c) => c.params)).toEqual([
      { worktree: 'w1', path: 'f2.ts', content: 'mine\n', expected: 'hash-1' }
    ])
    expect(report().dirty).toBe(false)
    expect(sectionOf(element, 'f2.ts').querySelector('[aria-label="Unsaved changes"]')).toBeNull()
  })

  test('SC-62: a stale section shows its own bar with Reload from Disk and Overwrite', async () => {
    const { element, report } = await open()
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    edit(element, 'mine\n', 0)
    await act(async () => void (await fake.run('save')))
    await settle()
    const bar = sectionOf(element, 'f1.ts').querySelector('[role="alert"]')
    expect(bar?.textContent).toContain('This file changed on disk since this section loaded.')
    expect(report().stale).toBe(true)
    fake.handlers['quirky.git/save'] = () => ({ hash: 'hash-9' })
    await click(byText(sectionOf(element, 'f1.ts'), 'Overwrite'))
    expect(fake.callsTo('quirky.git/save').at(-1)?.params).toEqual({ worktree: 'w1', path: 'f1.ts', content: 'mine\n' })
    expect(report().stale).toBe(false)
  })

  test('SC-62: Reload from Disk on a section refetches just that file', async () => {
    const { element } = await open()
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    edit(element, 'mine\n', 0)
    await act(async () => void (await fake.run('save')))
    const before = fake.callsTo('quirky.git/diff').length
    await click(byText(sectionOf(element, 'f1.ts'), 'Reload from Disk'))
    expect(fake.callsTo('quirky.git/diff').slice(before).map((c) => c.params.path)).toEqual(['f1.ts'])
    expect(sectionOf(element, 'f1.ts').querySelector('[role="alert"]')).toBeNull()
    expect(s.modifiedEditor(element, 0).state.sliceDoc()).toBe(modifiedText('f1.ts'))
  })

  test('staged sections are read-only', async () => {
    fake.handlers['quirky.git/status'] = () => status([row('s.ts', { area: 'staged' })])
    const { element } = await open({ worktree: 'w1', mode: 'combined', area: 'staged' })
    expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
  })
})
