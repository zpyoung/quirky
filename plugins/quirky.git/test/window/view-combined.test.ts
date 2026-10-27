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
const sections = () => qa('.qgv-section').map((s) => s.getAttribute('data-path'))

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
    const report = await w.win.waitFor(async () => {
      const r = await w.viewReport()
      return r?.sections === 7 ? r : undefined
    })
    expect(text(q('.qgv-toolbar .qgv-title'))).toBe('Changes')
    expect(text(q('.qgv-count'))).toBe('7 changed files')
    expect(report.loadedSections.length).toBeLessThanOrEqual(6)
    await w.win.waitFor(async () => ((await w.viewReport())?.loadedSections.length ?? 0) >= 5)
    await Bun.sleep(100)
    expect((await w.viewReport()).loadedSections.length).toBeLessThanOrEqual(6)

    const notice = q('.qgv-notice')!
    expect(text(notice)).toContain('Conflicted files are reviewed separately')
    expect(text(notice)).toContain('1 unresolved conflicts were excluded from this diff view.')
    expect(buttonText('Review conflicts', notice)).toBeDefined()

    await observer.revealAll()
    await w.win.waitFor(async () => (await w.viewReport())?.loadedSections.length === 6)
    const big = q('.qgv-section[data-path="big.txt"]')!
    expect(text(big)).toContain('Large diffs are not rendered by default.')
    expect(text(q('.qgv-section-head', big))).toContain('+12000 -12000')
    expect(buttonText('Copy path', big)).toBeDefined()
    expect(buttonText('Open diff', big)).toBeDefined()

    await click(buttonText('Collapse All'))
    await w.win.waitFor(async () => (await w.viewReport())?.collapsed === true)
    expect(buttonText('Expand All')).toBeDefined()
    await click(buttonText('Expand All'))
    await w.win.waitFor(async () => (await w.viewReport())?.collapsed === false)

    await click(buttonText('Side by Side'))
    expect(await settingValue(w, 'diffDefaultView')).toBe('side-by-side')
    await click(buttonText('Wrap On'))
    expect(await settingValue(w, 'diffWordWrap')).toBe(true)
    await click(buttonText('Whitespace On'))
    expect(await settingValue(w, 'diffShowWhitespace')).toBe(true)
    await click(buttonText('Show file tree'))
    expect(await settingValue(w, 'combinedDiffFileTree')).toBe('shown')
    await w.win.waitFor(() => q('nav[aria-label="Files"]'))
    expect(qa('.qgv-tree-item')).toHaveLength(7)
    for (const label of ['Inline', 'Wrap Off', 'Whitespace Off', 'Hide file tree']) expect(buttonText(label)).toBeDefined()

    await click(buttonText('Load diff', big))
    await w.win.waitFor(async () => (await w.viewReport())?.loadedSections.includes('big.txt'))
    expect(text(q('.qgv-section[data-path="big.txt"]'))).not.toContain('Large diffs are not rendered by default.')

    await click(buttonText('Open diff', q('.qgv-section[data-path="a.ts"]')!))
    await w.win.waitFor(async () => (await openView(w))?.input?.mode === 'file')
    expect((await openView(w))!.input).toMatchObject({ source: 'unstaged', path: 'a.ts' })

    await w.run('open-changes', { area: 'unstaged' })
    await w.win.waitFor(async () => (await openView(w))?.input?.mode === 'combined')
    await click(await w.win.waitFor(() => buttonText('Open Branch Diff')))
    await w.win.waitFor(() => text(q('.qgv-toolbar .qgv-title')) === 'Branch Changes (origin/main)')
    expect(w.problems()).toEqual([])
  } finally {
    observer.restore()
  }
}, SLOW)

test('SC-62: unstaged sections of a combined diff are editable and save', async () => {
  const w = await boot(scratch)
  w.write('a.ts', 'changed a\n')
  await w.win.waitFor(() => rowOf('a.ts'))
  await click(q('[data-section="unstaged"] [aria-label="View all"]'))
  await w.win.waitFor(() => q('.qgv-section[data-path="a.ts"] .cm-editor'))
  const editor = modifiedEditor(EditorView, q('.qgv-section[data-path="a.ts"]')!)
  editor.dispatch({ changes: { from: 0, insert: 'mine ' } })
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
  await w.run('save')
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === false)
  expect(readFileSync(join(w.dir, 'a.ts'), 'utf8')).toBe('mine changed a\n')
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

  await click(rowOf('big.txt'))
  await w.win.waitFor(() => q('.qgv-too-large'))
  const large = q('.qgv-too-large')!
  expect(text(large)).toContain('This diff is too large to display safely.')
  expect(text(large)).toContain('Original lines')
  expect(text(large)).toContain('Modified lines')
  expect(text(large)).toContain('Characters')
  expect(text(large)).toContain('line count exceeds the safe display limit')
  expect(text(large)).toContain('Limits: 120,000 lines per side · 6,000,000 combined characters')
  await w.win.waitFor(async () => (await w.viewReport())?.tooLarge === true)

  await click(rowOf('logo.png'))
  await w.win.waitFor(() => q('.qgv-images'))
  expect(qa('.qgv-image-side figcaption').map(text)).toEqual(['Original', 'Modified'])
  expect(qa('.qgv-image-side img')).toHaveLength(2)

  await click(rowOf('blob.bin'))
  await w.win.waitFor(() => text(q('.qgv-notice')).includes('Binary file changed'))
  expect(text(q('.qgv-notice'))).toContain('Text diff is unavailable for this file.')
}, SLOW)

test('SC-63: a draft that crosses the display limit is replaced by the fallback and saved with Save', async () => {
  const w = await boot(scratch)
  w.write('a.ts', 'one changed\n')
  await w.win.waitFor(() => rowOf('a.ts'))
  await click(rowOf('a.ts'))
  await w.win.waitFor(() => q('.cm-editor'))
  const draft = 'x'.repeat(6_000_001)
  const editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: draft } })
  await w.win.waitFor(() => q('.qgv-overflow'), 10_000)
  expect(text(q('.qgv-overflow'))).toContain('This diff is too large to display safely.')
  expect(text(q('.qgv-overflow'))).toContain('character count exceeds the safe display limit')
  expect(text(q('.qgv-overflow'))).toContain('This draft crossed the safe display limit, but it can still be saved.')
  await w.win.waitFor(() => q('.cm-editor') === null)
  await w.win.waitFor(async () => {
    const r = await w.viewReport()
    return r?.tooLarge === true && r.dirty === true
  })

  await click(buttonText('Save', q('.qgv-overflow')!))
  await w.win.waitFor(() => (buttonText('Save', q('.qgv-overflow') ?? document) as HTMLButtonElement | undefined)?.disabled === true, 15_000)
  expect(readFileSync(join(w.dir, 'a.ts'), 'utf8')).toBe(draft)
}, SLOW)
