import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, modifiedEditor, q, qa, rowOf, stubIntersectionObserver, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 120_000
afterEach(shutdown)

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
const settingValue = async (w: World, name: string) => ((await w.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value

test('SC-62: View all opens a combined diff with lazy sections, a Load diff for the large file and the conflict left out', async () => {
  const w = await boot(scratch, { files: { ...BASE_FILES, 'big.txt': rows(12_000, 'before') } })
  const observer = stubIntersectionObserver()
  try {
    w.git('checkout', '-q', '-b', 'other')
    w.commit({ 'b.ts': 'theirs\n' }, 'theirs')
    w.git('checkout', '-q', 'zoe/feat')
    w.commit({ 'b.ts': 'ours\n' }, 'ours')
    Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
    expect(w.git('status', '--porcelain')).toContain('UU b.ts')
    w.write('big.txt', rows(12_000, 'after'))
    for (const path of ['README.md', 'math.ts', 'old.ts', 'a.ts', 'c.ts', 'd.ts']) w.write(path, `changed ${path}\n`)
    await w.win.waitFor(() => rowOf('big.txt') && rowOf('d.ts'))

    await click(q('[data-section="unstaged"] [aria-label="View all"]'))
    await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
    expect((await openView(w))!.input).toMatchObject({ mode: 'combined', area: 'unstaged' })
    const root = await w.win.waitFor(() => q('[data-git-view-root]'))
    const big = await w.win.waitFor(() => q('section[data-path="big.txt"]', root))
    await w.win.waitFor(() => {
      const sections = qa('section[data-path]', root)
      const loaded = qa('section[data-path] [data-diff-editor]', root).length
      return sections.length === 7 && loaded >= 5 && loaded <= 6 && buttonText('Load diff', big) !== undefined
    })

    const notice = await w.win.waitFor(() => qa('[role="region"]', root).find((region) => buttonText('Review conflicts', region) !== undefined))
    expect(buttonText('Review conflicts', notice)).toBeDefined()

    await observer.revealAll()
    await w.win.waitFor(() => qa('section[data-path] [data-diff-editor]', root).length === 6)
    expect(qa('section[data-path] [data-diff-editor]', root)).toHaveLength(6)
    expect(buttonText('Load diff', big)).toBeDefined()

    expect(q('[aria-label="Added 12000 lines"]', big)).not.toBeNull()
    expect(q('[aria-label="Removed 12000 lines"]', big)).not.toBeNull()

    expect(buttonText('Copy path', big)).toBeDefined()
    expect(buttonText('Open diff', big)).toBeDefined()
    await click(buttonText('Collapse All', root))
    await w.win.waitFor(() =>
      buttonText('Expand All', root) !== undefined &&
      qa('section[data-path] button[aria-expanded="false"]', root).length === 7
    )
    await click(buttonText('Expand All', root))
    await w.win.waitFor(() =>
      buttonText('Collapse All', root) !== undefined &&
      qa('section[data-path] button[aria-expanded="true"]', root).length === 7
    )
    await click(buttonText('Side by Side', q('[data-git-view-root]')!))
    expect(await settingValue(w, 'diffDefaultView')).toBe('side-by-side')
    await click(buttonText('Wrap On', q('[data-git-view-root]')!))
    expect(await settingValue(w, 'diffWordWrap')).toBe(true)
    await click(buttonText('Whitespace On', q('[data-git-view-root]')!))
    expect(await settingValue(w, 'diffShowWhitespace')).toBe(true)
    await click(buttonText('Show file tree', q('[data-git-view-root]')!))
    await w.win.waitFor(() => q('[data-git-view-root] nav[aria-label="Files"]'))
    expect(qa('[data-git-view-root] nav[aria-label="Files"] button[aria-pressed]')).toHaveLength(7)

    await click(buttonText('Load diff', big))
    await w.win.waitFor(() => q('[data-diff-editor]', big))
    await click(buttonText('Open diff', q('[data-git-view-root] section[data-path="a.ts"]')!))
    await w.win.waitFor(async () => (await openView(w))?.input?.mode === 'file')
    expect((await openView(w))!.input).toMatchObject({ source: 'unstaged', path: 'a.ts' })

    await w.run('open-changes', { area: 'unstaged' })
    await w.win.waitFor(async () => {
      const view = await openView(w)
      return view?.id === DIFF_VIEW && view.input?.mode === 'combined' && view.input?.area === 'unstaged'
    })
    await w.win.waitFor(() => {
      const title = q('[data-git-view-root] h2')
      return title !== null && text(title) === 'Changes'
    })
    expect(w.problems()).toEqual([])
  } finally {
    observer.restore()
  }
}, SLOW)

test('SC-62: unstaged sections of a combined diff are editable and save', async () => {
  const w = await boot(scratch)
  w.write('a.ts', 'changed a\n')
  await w.win.waitFor(() => rowOf('a.ts'))
  await w.run('open-changes', { area: 'unstaged' })
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="a.ts"] [contenteditable]'))
  const editor = modifiedEditor(EditorView, q('[data-git-view-root] section[data-path="a.ts"]')!)
  editor.dispatch({ changes: { from: 0, insert: 'mine ' } })
  expect(editor.state.sliceDoc()).toBe('mine changed a\n')
  expect(readFileSync(join(w.dir, 'a.ts'), 'utf8')).toBe('changed a\n')
  await w.run('save')
  await w.win.waitFor(() => readFileSync(join(w.dir, 'a.ts'), 'utf8') === 'mine changed a\n')
  expect(editor.state.sliceDoc()).toBe(readFileSync(join(w.dir, 'a.ts'), 'utf8'))
  expect(w.problems()).toEqual([])
}, SLOW)

const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const PNG_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('SC-63: big, image and binary diffs show their fallbacks, and a draft past the limit keeps its Save', async () => {
  const w = await boot(scratch, { files: { ...BASE_FILES, 'big.txt': rows(130_000, 'before') } })
  w.write('big.txt', rows(130_000, 'after'))
  writeFileSync(join(w.dir, 'logo.png'), PNG_A)
  writeFileSync(join(w.dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]))
  w.git('add', 'logo.png', 'blob.bin')
  w.git('commit', '-q', '-m', 'binaries')
  writeFileSync(join(w.dir, 'logo.png'), PNG_B)
  writeFileSync(join(w.dir, 'blob.bin'), Buffer.from([0, 9, 9, 0, 4, 4]))
  await w.win.waitFor(() => rowOf('big.txt') && rowOf('logo.png') && rowOf('blob.bin'), 20_000)
  await w.run('open-changes', { area: 'unstaged' })

  const big = await w.win.waitFor(() => q('[data-git-view-root] section[data-path="big.txt"]'))
  await w.run('load-diff', { path: 'big.txt' })
  await w.run('load-diff', { path: 'logo.png' })
  await w.run('load-diff', { path: 'blob.bin' })
  await w.win.waitFor(() => q('[role="status"]', big))
  expect(text(q('[role="status"]', big)!)).toContain('This diff is too large to display safely')

  await w.win.waitFor(() => q('[data-git-view-root] [role="group"][aria-label="Image diff"]'))
  expect(qa('[data-git-view-root] [role="group"][aria-label="Image diff"] figcaption').map(text)).toEqual(['Original', 'Modified'])
  expect(qa('[data-git-view-root] [role="group"][aria-label="Image diff"] img')).toHaveLength(2)

  expect(text(q('[role="status"]', q('[data-git-view-root] section[data-path="blob.bin"]')!))).toContain('Binary file changed')
}, SLOW)

test('SC-63: a draft that crosses the display limit is replaced by the fallback and saved with Save', async () => {
  const w = await boot(scratch)
  w.write('a.ts', 'one changed\n')
  await w.win.waitFor(() => rowOf('a.ts'))
  await click(rowOf('a.ts'))
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
  const draft = 'x'.repeat(6_000_001)
  const editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: draft } })
  await w.win.waitFor(() => q('[data-git-view-root] [role="region"]'), 10_000)
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]') === null)
  expect((buttonText('Save', q('[data-git-view-root] [role="region"]')!) as HTMLButtonElement).disabled).toBe(false)
  await click(buttonText('Save', q('[data-git-view-root] [role="region"]')!))
  await w.win.waitFor(() => (buttonText('Save', q('[data-git-view-root] [role="region"]') ?? document) as HTMLButtonElement | undefined)?.disabled === true, 15_000)
  expect(readFileSync(join(w.dir, 'a.ts'), 'utf8')).toBe(draft)
}, SLOW)
