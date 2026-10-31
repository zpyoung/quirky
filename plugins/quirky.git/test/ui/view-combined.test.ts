import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync } from 'node:fs'
import { registerDom } from './register-dom'
import type { GitStatusEntry } from '@quirky/protocol'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const sharedStyles = document.createElement('style')
sharedStyles.textContent = readFileSync(new URL('../../../../packages/ui/src/design-system/components.css', import.meta.url), 'utf8')

const { act, byLabel, byText, click, edit, failure, fakeContext, layoutFor, mountView, numbered, settle, status, stubIntersectionObserver, textDiff } = s

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
  document.head.appendChild(sharedStyles)
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
  sharedStyles.remove()
})

describe('quirky.git combined diff', () => {

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

  test('SC-62: unresolved conflicts are excluded from the two-way diff sections', async () => {
    const { element } = await open()
    expect(element.querySelector('section[data-path="conflict.ts"]')).toBeNull()
    expect(sectionOf(element, 'f1.ts')).not.toBeNull()
    expect(loading.order).not.toContain('conflict.ts')
  })


  test('SC-62: Collapse All hides every section and becomes Expand All; the command does the same', async () => {
    const { element, report } = await open()
    const sectionToggle = (path: string) => sectionOf(element, path).querySelector<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])')
    expect(report().collapsed).toBe(false)
    await click(byText(element, 'Collapse All'))
    expect(report().collapsed).toBe(true)
    for (const path of [...small, 'big.txt']) {
      expect(sectionToggle(path)?.getAttribute('aria-expanded')).toBe('false')
      expect(getComputedStyle(sectionOf(element, path).querySelector<HTMLElement>(':scope > div')!).display).toBe('none')
    }
    expect(byText(element, 'Expand All')).not.toBeNull()
    await click(byText(element, 'Expand All'))
    expect(report().collapsed).toBe(false)
    for (const path of [...small, 'big.txt']) {
      expect(sectionToggle(path)?.getAttribute('aria-expanded')).toBe('true')
      expect(getComputedStyle(sectionOf(element, path).querySelector<HTMLElement>(':scope > div')!).display).toBe('flex')
    }
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
    expect(sectionOf(element, 'f2.ts').querySelector<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])')?.getAttribute('aria-expanded')).toBe('false')
    expect(sectionOf(element, 'f1.ts').querySelector<HTMLButtonElement>('button[aria-expanded]:not([aria-haspopup])')?.getAttribute('aria-expanded')).toBe('true')
    const content = sectionOf(element, 'f2.ts').querySelector<HTMLElement>(':scope > div')!
    expect(getComputedStyle(content).display).toBe('none')
    expect(getComputedStyle(sectionOf(element, 'f1.ts').querySelector<HTMLElement>(':scope > div')!).display).toBe('flex')
    await click(byLabel(element, 'Expand f2.ts'))
    expect(getComputedStyle(content).display).toBe('flex')
  })

  test('SC-64: load-diff still works on a collapsed section', async () => {
    const { report } = await open()
    await act(async () => void (await fake.run('collapse-all', { collapsed: true })))
    await act(async () => void (await fake.run('load-diff', { path: 'big.txt' })))
    expect(report()).toMatchObject({ collapsed: true })
    expect(report().loadedSections).toContain('big.txt')
  })

  test('SC-62: toolbar controls update settings and menu checked states', async () => {
    const { element } = await open()
    await click(byLabel(element, 'Switch to side-by-side diff'))
    expect(fake.settings.diffDefaultView).toBe('side-by-side')
    expect(byLabel(element, 'Switch to inline diff')).not.toBeNull()
    expect(sectionOf(element, 'f1.ts').querySelectorAll('.cm-mergeViewEditor').length).toBe(2)
    const menuItems = () => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    await click(byLabel(element, 'More actions'))
    expect(menuItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
    await click(menuItems()[0])
    expect(fake.settings.diffWordWrap).toBe(true)
    expect(sectionOf(element, 'f1.ts').querySelector('.cm-lineWrapping')).not.toBeNull()
    await click(byLabel(element, 'More actions'))
    expect(menuItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    await click(menuItems()[1])
    expect(fake.settings.diffShowWhitespace).toBe(true)
    await click(byLabel(element, 'More actions'))
    expect(menuItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false'])
    await click(byLabel(element, 'Switch to inline diff'))
    expect(fake.settings.diffDefaultView).toBe('inline')
    expect(byLabel(element, 'Switch to side-by-side diff')).not.toBeNull()
    expect(sectionOf(element, 'f1.ts').querySelectorAll('.cm-mergeViewEditor').length).toBe(0)
  })

  test('SC-62: the file tree menu option toggles its setting and lists files', async () => {
    const { element } = await open()
    expect(element.querySelector('nav[aria-label=Files]')).toBeNull()
    const menuItems = () => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
    await click(byLabel(element, 'More actions'))
    expect(menuItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false'])
    await click(menuItems()[2])
    expect(fake.settings.combinedDiffFileTree).toBe('shown')
    const items = [...element.querySelectorAll('nav[aria-label="Files"] button[aria-pressed]')].map((i) => i.textContent)
    expect(items).toEqual([...small, 'big.txt'])
    await click(byLabel(element, 'More actions'))
    expect(menuItems().map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'false', 'true'])
    await click(menuItems()[2])
    expect(fake.settings.combinedDiffFileTree).toBe('hidden')
    expect(element.querySelector('nav[aria-label=Files]')).toBeNull()
  })

  test('SC-62: the file tree starts shown when the setting says so', async () => {
    fake.settings.combinedDiffFileTree = 'shown'
    const { element } = await open()
    expect(element.querySelector('nav[aria-label=Files]')).not.toBeNull()
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

  test('a commit subject keeps its case and its header preserves padding and the full title', async () => {
    const style = document.createElement('style')
    style.textContent = [
      readFileSync(new URL('../../../../packages/ui/src/design-system/tokens.css', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../../packages/ui/src/design-system/components.css', import.meta.url), 'utf8')
    ].join('\n')
    document.head.appendChild(style)
    try {
      const subject = 'Refactor HTTP response handling'
      fake.handlers['quirky.git/commitFiles'] = () => ({
        commit: 'c'.repeat(40),
        parent: null,
        entries: [{ path: 'a.ts', status: 'added', added: 1, removed: 0, binary: false }]
      })
      const { element } = await open({ worktree: 'w1', mode: 'combined', commit: 'ccccccc', title: subject })
      const heading = element.querySelector<HTMLElement>('h2')!
      const header = heading.parentElement!
      expect(getComputedStyle(heading.firstElementChild ?? heading).textTransform).toBe('none')
      expect(heading.textContent).toBe(subject)
      expect(heading.title).toBe(subject)
      expect(Number.parseFloat(getComputedStyle(header).paddingTop)).toBeGreaterThan(0)
    } finally {
      style.remove()
    }
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
    const seen: unknown[] = []
    for (const id of ['next-change', 'next-change', 'next-change', 'next-change', 'previous-change', 'previous-change']) {
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
