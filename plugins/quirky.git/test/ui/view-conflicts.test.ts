import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, byText, click, expectOpened, failure, fakeContext, layoutFor, mountView, settle, status } = s

const twoBlocks = [
  'a',
  '<<<<<<< HEAD',
  'x',
  '=======',
  'y',
  '>>>>>>> topic',
  'mid',
  '<<<<<<< HEAD',
  'x2',
  '||||||| base',
  'b2',
  '=======',
  'y2',
  '>>>>>>> topic',
  'end',
  ''
].join('\n')

const conflictFile = (overrides: Record<string, unknown> = {}) => ({
  path: 'math.ts',
  kind: 'both_modified',
  state: 'unresolved',
  content: twoBlocks,
  hash: 'h1',
  operation: 'merge',
  ...overrides
})

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null

const openFile = async (result = conflictFile()) => {
  fake.handlers['quirky.git/conflictFile'] = () => result
  mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
  await settle()
  return mounted
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
})
afterEach(() => {
  mounted?.unmount()
  mounted = null
})

const counter = (root: ParentNode) => root.querySelector('.qgv-counter')?.textContent
const view = (root: ParentNode) => s.EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!

describe('quirky.git conflict file view', () => {
  test('SC-44: shows the banner, the 1 / 2 counter and tinted marker lines with their labels', async () => {
    const { element, report } = await openFile()
    expect(fake.callsTo('quirky.git/conflictFile')[0].params).toEqual({ worktree: 'w1', path: 'math.ts' })
    expect(element.querySelector('.qgv-banner')?.textContent).toContain('Unresolved conflict · Both modified')
    expect(counter(element)).toBe('1 / 2')
    expect(report()).toMatchObject({ mode: 'conflict-file', path: 'math.ts', conflicts: 2, currentConflict: 1 })
    expect(element.querySelectorAll('.qg-conflict-marker').length).toBe(7)
    expect(element.querySelectorAll('.qg-conflict-current').length).toBe(2)
    expect(element.querySelectorAll('.qg-conflict-base').length).toBe(1)
    expect(element.querySelectorAll('.qg-conflict-incoming').length).toBe(2)
    const labels = [...element.querySelectorAll('.qg-conflict-label')].map((l) => l.textContent)
    expect(labels).toEqual([
      'Current change',
      'Incoming change',
      'End conflict',
      'Current change',
      'Common ancestor',
      'Incoming change',
      'End conflict'
    ])
  })

  test('SC-44: Next conflict moves to 2 / 2 then wraps to 1 / 2, and Previous wraps the other way', async () => {
    const { element, report } = await openFile()
    await click(byLabel(element, 'Next conflict'))
    expect(counter(element)).toBe('2 / 2')
    expect(report().currentConflict).toBe(2)
    expect(view(element).state.doc.lineAt(view(element).state.selection.main.head).number).toBe(8)
    await click(byLabel(element, 'Next conflict'))
    expect(counter(element)).toBe('1 / 2')
    await click(byLabel(element, 'Previous conflict'))
    expect(counter(element)).toBe('2 / 2')
  })

  test('SC-44: the next-conflict and previous-conflict commands do the same', async () => {
    const { report } = await openFile()
    for (const [id, expected] of [
      ['next-conflict', 2],
      ['next-conflict', 1],
      ['previous-conflict', 2],
      ['previous-conflict', 1]
    ] as const) {
      await act(async () => void (await fake.run(id)))
      await settle()
      expect(report().currentConflict).toBe(expected)
    }
  })

  test('SC-44: the counter follows the cursor when it is placed inside a block', async () => {
    const { element } = await openFile()
    const editor = view(element)
    act(() => editor.dispatch({ selection: { anchor: editor.state.doc.line(9).from } }))
    await settle()
    expect(counter(element)).toBe('2 / 2')
  })

  test('SC-44: resolving the markers by hand empties the counter and disables the arrows', async () => {
    const { element } = await openFile()
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'merged\n' } }))
    await settle()
    expect(counter(element)).toBe('0 / 0')
    expect(byLabel(element, 'Next conflict')?.disabled).toBe(true)
    expect(element.querySelectorAll('.qg-conflict-marker').length).toBe(0)
  })

  test('SC-44: a "deleted by them" file asks whether to keep it', async () => {
    const { element } = await openFile(conflictFile({ kind: 'deleted_by_them', content: 'kept\n' }))
    expect(element.textContent).toContain('Deleted by them')
    expect(element.textContent).toContain('Decide whether to keep the file or accept deletion')
  })

  test('SC-44: a conflict with no working file says there is nothing to edit', async () => {
    const { element } = await openFile(conflictFile({ kind: 'both_deleted', content: null, hash: null }))
    expect(element.textContent).toContain('No working-tree file is available to edit for this conflict.')
    expect(element.querySelector('.cm-editor')).toBeNull()
    expect(byLabel(element, 'Next conflict')).toBeNull()
  })

  test('SC-41: a resolved-locally file says git no longer lists it', async () => {
    const { element } = await openFile(conflictFile({ state: 'resolved_locally' }))
    expect(element.textContent).toContain('Resolved locally conflict · Both modified')
    expect(element.textContent).toContain('Session-local continuity state. Git is no longer reporting this file as unmerged.')
  })

  test('SC-41: Mod+S saves the file with the hash it was read with, and the next save the new hash', async () => {
    const { element, report } = await openFile()
    fake.handlers['quirky.git/save'] = () => ({ hash: 'h2' })
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'merged\n' } }))
    await settle()
    expect(report().dirty).toBe(true)
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    await act(async () => {
      editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...mod, bubbles: true }))
    })
    await settle()
    expect(fake.callsTo('quirky.git/save')[0].params).toEqual({ worktree: 'w1', path: 'math.ts', content: 'merged\n', expected: 'h1' })
    expect(report().dirty).toBe(false)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'more ' } }))
    await act(async () => void (await fake.run('save')))
    expect(fake.callsTo('quirky.git/save')[1].params.expected).toBe('h2')
  })

  test('SC-61: a save refused with changed-on-disk shows the banner; Overwrite saves without the precondition', async () => {
    const { element, report } = await openFile()
    fake.handlers['quirky.git/save'] = (params) => {
      if ('expected' in params) throw failure('changed', 'changed-on-disk')
      return { hash: 'h3' }
    }
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'x' } }))
    await act(async () => void (await fake.run('save')))
    await settle()
    expect(element.querySelector('.qgv-stale')).not.toBeNull()
    expect(report().stale).toBe(true)
    await click(byText(element, 'Overwrite'))
    expect(element.querySelector('.qgv-stale')).toBeNull()
    expect(fake.callsTo('quirky.git/save').map((c) => 'expected' in c.params)).toEqual([true, false])
  })

  test('SC-61: Reload from Disk takes the file as it is now', async () => {
    const { element } = await openFile()
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'x' } }))
    await act(async () => void (await fake.run('save')))
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ content: 'fresh\n', hash: 'h5' })
    await click(byText(element, 'Reload from Disk'))
    expect(view(element).state.sliceDoc()).toBe('fresh\n')
    expect(element.querySelector('.qgv-stale')).toBeNull()
  })

  test('a refresh that finds the file changed on disk under a draft flags it stale', async () => {
    const { element, report } = await openFile()
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'x' } }))
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ content: 'agent\n', hash: 'h6' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(report().stale).toBe(true)
    expect(view(element).state.sliceDoc().startsWith('x')).toBe(true)
  })

  test('a refresh that finds the file state changed updates the banner without rebuilding the editor', async () => {
    const { element } = await openFile()
    const before = element.querySelector('.cm-editor')
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ state: 'resolved_locally' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(element.textContent).toContain('Resolved locally conflict')
    expect(element.querySelector('.cm-editor')).toBe(before)
  })

  test('a file that cannot be read shows the error', async () => {
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw new Error('math.ts is binary')
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(mounted.element.textContent).toContain('Error loading conflict file: math.ts is binary')
  })

  test('Close returns to the sessions', async () => {
    const { element } = await openFile()
    await click(byLabel(element, 'Close'))
    expectOpened(fake, s.SESSIONS_VIEW, { worktree: 'w1' })
  })
})

describe('quirky.git conflict review view', () => {
  const conflict = (path: string, state: 'unresolved' | 'resolved_locally' = 'unresolved') => ({
    path,
    area: 'conflicts' as const,
    status: 'modified' as const,
    conflict: { kind: 'both_modified' as const, state }
  })

  const openReview = async () => {
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    return mounted
  }

  test('SC-45: lists the conflicts as Unresolved with the count and the snapshot time', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('b.ts')])
    const { element, report } = await openReview()
    const rows = [...element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)
    expect(rows).toEqual(['a.tsUnresolvedOpen', 'b.tsUnresolvedOpen'])
    expect(element.textContent).toMatch(/2 unresolved conflicts · Snapshot captured at .+\./)
    expect(element.querySelector('h3')?.textContent).toBe('Files')
    expect(report()).toMatchObject({ mode: 'conflicts', conflicts: 2 })
  })

  test('SC-45: Open shows the conflict file and carries the snapshot with it', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('b.ts')])
    const { element } = await openReview()
    await click(byText(element, 'Open'))
    const opened = fake.opened.at(-1) as { id: string; input: { review: { capturedAt: number } } }
    expect(typeof opened.input.review.capturedAt).toBe('number')
    expectOpened(fake, s.DIFF_VIEW, {
      worktree: 'w1',
      mode: 'conflict-file',
      path: 'a.ts',
      review: { entries: [{ path: 'a.ts', kind: 'both_modified' }, { path: 'b.ts', kind: 'both_modified' }], capturedAt: opened.input.review.capturedAt }
    })
  })

  test('SC-45: closing a file opened from the review returns to that review, not the sessions', async () => {
    const review = { entries: [{ path: 'a.ts', kind: 'both_modified' }], capturedAt: 1_700_000_000_000 }
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ path: 'a.ts' })
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'a.ts', review })
    await settle()
    await click(byLabel(mounted.element, 'Close'))
    expectOpened(fake, s.DIFF_VIEW, { worktree: 'w1', mode: 'conflicts', review })
  })

  test('SC-45: a review reopened with its snapshot keeps the snapshot and its time, so Refresh reads Gone', async () => {
    const capturedAt = new Date(2026, 9, 27, 6, 52, 9).getTime()
    const review = { entries: [{ path: 'a.ts', kind: 'both_modified' }, { path: 'b.ts', kind: 'both_modified' }], capturedAt }
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts', 'resolved_locally'), { path: 'a.ts', area: 'staged', status: 'modified' }])
    fake.handlers['quirky.git/conflictFile'] = () => ({ content: null })
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts', review })
    await settle()
    expect([...mounted.element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)).toEqual(['a.tsResolved', 'b.tsGone'])
    expect(mounted.element.textContent).toContain('All conflicts resolved')
  })

  test('a malformed review in the input is ignored, so the review takes a fresh snapshot', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts')])
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts', review: { entries: 'nope', capturedAt: 'x' } })
    await settle()
    expect([...mounted.element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)).toEqual(['a.tsUnresolvedOpen'])
  })

  test('SC-45: a reopened review that still has conflicts shows the original capture time', async () => {
    const capturedAt = new Date(2026, 9, 27, 6, 52, 9).getTime()
    const review = { entries: [{ path: 'a.ts', kind: 'both_modified' }], capturedAt }
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts')])
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts', review })
    await settle()
    expect(mounted.element.textContent).toContain(`Snapshot captured at ${new Date(capturedAt).toLocaleTimeString()}.`)
  })

  test('SC-45: after Refresh a resolved file reads Resolved and a removed one Gone, and the review says all are resolved', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('b.ts')])
    const { element, report } = await openReview()
    fake.handlers['quirky.git/status'] = () =>
      status([{ path: 'a.ts', area: 'staged', status: 'modified' }])
    fake.handlers['quirky.git/conflictFile'] = (params) => {
      expect(params.path).toBe('b.ts')
      return { path: 'b.ts', kind: 'both_modified', state: 'resolved_locally', content: null, hash: null, operation: 'merge' }
    }
    await click(byText(element, 'Refresh'))
    const rows = [...element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)
    expect(rows).toEqual(['a.tsResolved', 'b.tsGone'])
    expect(element.textContent).toContain('All conflicts resolved')
    expect(element.textContent).toContain('This review snapshot no longer has any live unresolved conflicts.')
    expect(element.textContent).not.toContain('unresolved conflicts ·')
    expect(report().conflicts).toBe(0)
    await click(byText(element, 'Source Control'))
    expect(fake.panelToggles.at(-1)).toEqual({ id: s.PANEL, open: true })
    await click(byText(element, 'Dismiss'))
    expectOpened(fake, s.SESSIONS_VIEW, { worktree: 'w1' })
  })

  test('SC-45: a path with no row that is still on disk reads Resolved; a staged deletion reads Gone', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('b.ts')])
    const { element } = await openReview()
    fake.handlers['quirky.git/status'] = () => status([{ path: 'b.ts', area: 'staged', status: 'deleted' }])
    fake.handlers['quirky.git/conflictFile'] = () => ({ content: 'same\n' })
    await click(byText(element, 'Refresh'))
    expect([...element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)).toEqual(['a.tsResolved', 'b.tsGone'])
  })

  test('SC-45: a conflict resolved locally counts as resolved; the snapshot keeps its files', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts')])
    const { element } = await openReview()
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts', 'resolved_locally'), conflict('new.ts')])
    await click(byText(element, 'Refresh'))
    expect([...element.querySelectorAll('.qgv-review-row')].map((r) => r.textContent)).toEqual(['a.tsResolved'])
  })

  test('SC-45: with no conflicts at open the snapshot says so', async () => {
    fake.handlers['quirky.git/status'] = () => status([])
    const { element } = await openReview()
    expect(element.textContent).toContain('No conflicts in this snapshot.')
    expect(element.textContent).not.toContain('All conflicts resolved')
  })

  test('a failed status read shows the error', async () => {
    fake.handlers['quirky.git/status'] = () => {
      throw new Error('not a repository')
    }
    const { element } = await openReview()
    expect(element.textContent).toContain('Error loading conflicts: not a repository')
  })
})
