import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, byText, click, edit, expectOpened, failure, fakeContext, layoutFor, mountView, numbered, settle, textDiff, wait } = s

const far = {
  original: numbered(30),
  modified: numbered(30).replace('line 3\n', 'line three\n').replace('line 25\n', 'line twenty-five\n')
}
const input = { worktree: 'w1', mode: 'file', source: 'unstaged', path: 'math.ts' }

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null

const open = async (diff = textDiff(far), viewInput: object = input) => {
  fake.handlers['quirky.git/diff'] = () => diff
  mounted = mountView(fake, viewInput)
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

describe('quirky.git file diff view', () => {
  test('SC-60: loads the diff of the input and titles the view "<path> (diff)"', async () => {
    const { element } = await open()
    expect(fake.callsTo('quirky.git/diff')[0].params).toEqual({ worktree: 'w1', path: 'math.ts', source: 'unstaged' })
    expect(element.querySelector('.qgv-title')?.textContent).toBe('math.ts (diff)')
    expect(element.querySelector('.cm-editor')).not.toBeNull()
  })

  test('SC-60: a rename and a commit diff pass oldPath and commit to the daemon', async () => {
    await open(textDiff(), { worktree: 'w1', mode: 'file', source: 'commit', path: 'b.ts', oldPath: 'a.ts', commit: 'c'.repeat(40) })
    expect(fake.callsTo('quirky.git/diff')[0].params).toEqual({
      worktree: 'w1',
      path: 'b.ts',
      source: 'commit',
      oldPath: 'a.ts',
      commit: 'c'.repeat(40)
    })
  })

  test('SC-60: it opens on the first change and F7 / Shift+F7 walk the changes through the commands', async () => {
    const { report } = await open()
    expect(report()).toMatchObject({ mode: 'file', source: 'unstaged', path: 'math.ts', changes: 2, currentChange: 1 })
    await act(async () => void (await fake.run('next-change')))
    await settle()
    expect(report().currentChange).toBe(2)
    await act(async () => void (await fake.run('previous-change')))
    await settle()
    expect(report().currentChange).toBe(1)
  })

  test('SC-60: the Next and Previous change buttons do the same, and are disabled when nothing changed', async () => {
    const { element, report } = await open()
    await click(byLabel(element, 'Next change'))
    expect(report().currentChange).toBe(2)
    await click(byLabel(element, 'Previous change'))
    expect(report().currentChange).toBe(1)
    element.remove()
    mounted?.unmount()
    mounted = await open(textDiff({ original: 'same\n', modified: 'same\n' }))
    expect(byLabel(mounted.element, 'Next change')?.disabled).toBe(true)
    expect(byLabel(mounted.element, 'Previous change')?.disabled).toBe(true)
    expect(mounted.report()).toMatchObject({ changes: 0, currentChange: null })
  })

  test('SC-60: inline by default; the switch writes diffDefaultView and shows two panes', async () => {
    const { element } = await open()
    expect(element.querySelectorAll('.cm-mergeViewEditor').length).toBe(0)
    await click(byLabel(element, 'Switch to side-by-side diff'))
    expect(fake.calls.at(-1)).toEqual({ method: 'setting.set', params: { id: 'setting:quirky.git/diffDefaultView', value: 'side-by-side' } })
    expect(element.querySelectorAll('.cm-mergeViewEditor').length).toBe(2)
    await click(byLabel(element, 'Switch to inline diff'))
    expect(fake.settings.diffDefaultView).toBe('inline')
    expect(element.querySelectorAll('.cm-mergeViewEditor').length).toBe(0)
  })

  test('SC-60: the default view follows the setting, live', async () => {
    fake.settings.diffDefaultView = 'side-by-side'
    const { element } = await open()
    expect(element.querySelectorAll('.cm-mergeViewEditor').length).toBe(2)
    await act(async () =>
      fake.emit({ type: 'setting.changed', id: 'setting:quirky.git/diffDefaultView', value: 'inline' })
    )
    await settle()
    expect(element.querySelectorAll('.cm-mergeViewEditor').length).toBe(0)
  })

  test('SC-60: the menu has Word Wrap and Show Whitespace, which write their settings', async () => {
    const { element } = await open()
    expect(element.querySelector('[role=menu]')).toBeNull()
    await click(byLabel(element, 'More actions'))
    const items = [...element.querySelectorAll('[role=menuitemcheckbox]')]
    expect(items.map((i) => i.textContent)).toEqual(['Word Wrap', 'Show Whitespace'])
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['false', 'false'])
    await click(items[0])
    expect(fake.calls.at(-1)?.params).toEqual({ id: 'setting:quirky.git/diffWordWrap', value: true })
    expect(element.querySelector('.cm-lineWrapping')).not.toBeNull()
    await click(byLabel(element, 'More actions'))
    expect(element.querySelector('[role=menuitemcheckbox]')?.getAttribute('aria-checked')).toBe('true')
    await click(element.querySelectorAll('[role=menuitemcheckbox]')[1])
    expect(fake.settings.diffShowWhitespace).toBe(true)
  })

  test('SC-60: with Collapse Unchanged Regions on, unchanged runs fold into bands', async () => {
    fake.settings.diffCollapseUnchanged = true
    const { element } = await open()
    expect(element.querySelector('.cm-collapsedLines')).not.toBeNull()
  })

  test('SC-60: Close returns to the worktree\'s sessions', async () => {
    const { element } = await open()
    await click(byLabel(element, 'Close'))
    expectOpened(fake, 'view:quirky.session/worktree', { worktree: 'w1' })
  })

  test('SC-57: a diff that cannot be read says so with the daemon\'s message', async () => {
    fake.handlers['quirky.git/diff'] = () => {
      throw new Error('fatal: bad object 1234')
    }
    mounted = mountView(fake, { ...input, source: 'branch' })
    await settle()
    expect(mounted.element.textContent).toContain('Error loading diff: fatal: bad object 1234')
    expect(mounted.element.querySelector('.cm-editor')).toBeNull()
  })

  test('SC-63: a too-large diff shows the counts, the reason and the limits', async () => {
    const { element } = await open(
      textDiff({ original: '', modified: '', tooLarge: { originalLines: 3, modifiedLines: 130_000, characters: 900, reason: 'lines' } })
    )
    const text = element.textContent ?? ''
    expect(text).toContain('This diff is too large to display safely.')
    for (const label of ['Original lines', 'Modified lines', 'Characters']) expect(text).toContain(label)
    expect(text).toContain('130,000')
    expect(text).toContain('line count exceeds the safe display limit')
    expect(text).toContain('Limits: 120,000 lines per side · 6,000,000 combined characters')
    expect(element.querySelector('.cm-editor')).toBeNull()
    expect(mounted!.report().tooLarge).toBe(true)
  })

  test('SC-63: a binary file shows the binary notice', async () => {
    const { element } = await open(textDiff({ kind: 'binary', binary: true, original: '', modified: '' }))
    expect(element.textContent).toContain('Binary file changed')
    expect(element.textContent).toContain('Text diff is unavailable for this file.')
  })

  test('SC-63: an image shows both sides as panes, and "No preview" for a missing side', async () => {
    const { element } = await open(
      textDiff({ path: 'logo.png', kind: 'image', binary: true, mime: 'image/png', original: '', modified: 'iVBORw0KGgo=' })
    )
    const sides = [...element.querySelectorAll('.qgv-image-side')]
    expect(sides.map((side) => side.querySelector('figcaption')?.textContent)).toEqual(['Original', 'Modified'])
    expect(sides[0].textContent).toContain('No preview')
    expect(sides[1].querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  test('refreshes on quirky.git/changed: a clean view takes the new content', async () => {
    const { element } = await open()
    fake.handlers['quirky.git/diff'] = () => textDiff({ modified: far.modified + 'extra\n', modifiedHash: 'hash-2' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(fake.callsTo('quirky.git/diff').length).toBe(2)
    expect(element.textContent).toContain('extra')
  })

  test('a refetch that returned the same content keeps the editor (no rebuild)', async () => {
    const { element } = await open()
    const before = element.querySelector('.cm-editor')
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(element.querySelector('.cm-editor')).toBe(before)
  })

  test('unmounting stops listening to events', async () => {
    await open()
    expect(fake.listeners()).toBeGreaterThan(0)
    mounted!.unmount()
    mounted = null
    expect(fake.listeners()).toBe(0)
  })

  test('with no worktree in the input it asks for one', async () => {
    mounted = mountView(fake, {})
    await settle()
    expect(mounted.element.textContent).toBe('Open a worktree first.')
    expect(byText(mounted.element, 'Close')).toBeNull()
  })
})

describe('quirky.git editable file diff', () => {
  const editableDiff = () => textDiff(far)

  test('SC-61: an unstaged diff is editable and Cmd+S saves with the hash of the last load', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = () => ({ hash: 'hash-2' })
    edit(element, far.modified + 'more\n')
    await settle()
    expect(report().dirty).toBe(true)
    const view = s.modifiedEditor(element)
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    await act(async () => {
      view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...mod, bubbles: true }))
    })
    await settle()
    expect(fake.callsTo('quirky.git/save')[0].params).toEqual({
      worktree: 'w1',
      path: 'math.ts',
      content: far.modified + 'more\n',
      expected: 'hash-1'
    })
    expect(report()).toMatchObject({ dirty: false, stale: false })
  })

  test('SC-61: the next save carries the hash the last save returned', async () => {
    const { element } = await open(editableDiff())
    let n = 1
    fake.handlers['quirky.git/save'] = () => ({ hash: `hash-${++n}` })
    edit(element, 'first\n')
    await act(async () => void (await fake.run('save')))
    edit(element, 'second\n')
    await act(async () => void (await fake.run('save')))
    expect(fake.callsTo('quirky.git/save').map((c) => c.params.expected)).toEqual(['hash-1', 'hash-2'])
  })

  test('SC-61: the save command does nothing when there is nothing to save', async () => {
    await open(editableDiff())
    await act(async () => void (await fake.run('save')))
    expect(fake.callsTo('quirky.git/save')).toEqual([])
  })

  test('SC-61: a save refused with changed-on-disk shows the banner with Reload from Disk and Overwrite', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    edit(element, 'mine\n')
    await act(async () => void (await fake.run('save')))
    await settle()
    expect(element.querySelector('.qgv-stale')?.textContent).toContain(
      'This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.'
    )
    expect(byText(element, 'Reload from Disk')).not.toBeNull()
    expect(byText(element, 'Overwrite')).not.toBeNull()
    expect(report()).toMatchObject({ dirty: true, stale: true })
    expect(fake.toasts).toEqual([])
  })

  test('SC-61: Overwrite saves the draft without the precondition', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = (params) => {
      if ('expected' in params) throw failure('changed', 'changed-on-disk')
      return { hash: 'hash-9' }
    }
    edit(element, 'mine\n')
    await act(async () => void (await fake.run('save')))
    await click(byText(element, 'Overwrite'))
    expect(fake.callsTo('quirky.git/save').map((c) => 'expected' in c.params)).toEqual([true, false])
    expect(fake.callsTo('quirky.git/save')[1].params.content).toBe('mine\n')
    expect(element.querySelector('.qgv-stale')).toBeNull()
    expect(report()).toMatchObject({ dirty: false, stale: false })
  })

  test('SC-61: Reload from Disk discards the draft and shows the file as it is now', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    edit(element, 'mine\n')
    await act(async () => void (await fake.run('save')))
    fake.handlers['quirky.git/diff'] = () => textDiff({ ...far, modified: far.modified + 'agent\n', modifiedHash: 'hash-7' })
    await click(byText(element, 'Reload from Disk'))
    expect(element.querySelector('.qgv-stale')).toBeNull()
    expect(s.modifiedEditor(element).state.sliceDoc()).toBe(far.modified + 'agent\n')
    expect(report()).toMatchObject({ dirty: false, stale: false })
  })

  test('SC-61: the reload-from-disk and overwrite commands do what the banner buttons do', async () => {
    const { element } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = (params) => {
      if ('expected' in params) throw failure('changed', 'changed-on-disk')
      return { hash: 'hash-9' }
    }
    edit(element, 'mine\n')
    await act(async () => void (await fake.run('save')))
    await act(async () => void (await fake.run('overwrite')))
    await settle()
    expect(fake.callsTo('quirky.git/save').length).toBe(2)
    expect(element.querySelector('.qgv-stale')).toBeNull()
    edit(element, 'again\n')
    fake.handlers['quirky.git/save'] = () => {
      throw failure('changed', 'changed-on-disk')
    }
    await act(async () => void (await fake.run('save')))
    await act(async () => void (await fake.run('reload-from-disk')))
    await settle()
    expect(element.querySelector('.qgv-stale')).toBeNull()
    expect(s.modifiedEditor(element).state.sliceDoc()).toBe(far.modified)
  })

  test('SC-61: another failed save toasts and keeps the draft', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = () => {
      throw new Error('disk full')
    }
    edit(element, 'mine\n')
    await act(async () => void (await fake.run('save')))
    expect(fake.toasts).toEqual([['Save failed', 'disk full']])
    expect(report().dirty).toBe(true)
  })

  test('a poll that finds the file changed under a draft flags it stale instead of replacing the draft', async () => {
    const { element, report } = await open(editableDiff())
    edit(element, 'mine\n')
    await settle()
    fake.handlers['quirky.git/diff'] = () => textDiff({ ...far, modified: 'agent\n', modifiedHash: 'hash-5' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(report().stale).toBe(true)
    expect(s.modifiedEditor(element).state.sliceDoc()).toBe('mine\n')
  })

  test('SC-61: Revert Block puts the block back to the original text, unsaved, and the command does the same', async () => {
    const { element, report } = await open(editableDiff())
    expect(element.querySelectorAll('button[name=reject]').length).toBeGreaterThan(0)
    await act(async () => void (await fake.run('revert-change')))
    await settle()
    expect(s.modifiedEditor(element).state.sliceDoc()).toBe(far.modified.replace('line three\n', 'line 3\n'))
    expect(report()).toMatchObject({ dirty: true, changes: 1 })
    expect(fake.callsTo('quirky.git/save')).toEqual([])
  })

  test('SC-61: side by side has revert controls too', async () => {
    fake.settings.diffDefaultView = 'side-by-side'
    const { element } = await open(editableDiff())
    expect(element.querySelector('.cm-merge-revert')).not.toBeNull()
  })

  test('SC-61: staged, branch and commit diffs are read-only with no revert control', async () => {
    for (const source of ['staged', 'branch', 'commit']) {
      const { element } = await open(textDiff({ ...far, source: source as 'staged' }), { ...input, source })
      expect(element.querySelector('button[name=reject]')).toBeNull()
      expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
      await act(async () => void (await fake.run('revert-change')))
      expect(s.modifiedEditor(element).state.sliceDoc()).toBe(far.modified.slice(0, -1))
      mounted!.unmount()
      mounted = null
    }
  })

  test('SC-61: a file deleted from disk is shown read-only', async () => {
    const { element } = await open(textDiff({ ...far, modified: '', modifiedHash: null, modifiedDeleted: true }))
    expect(element.querySelector('.cm-content[contenteditable=true]')).toBeNull()
  })

  test('SC-63: a draft that crosses the live limit is replaced by the fallback, kept, and saved with Save', async () => {
    const { element, report } = await open(editableDiff())
    fake.handlers['quirky.git/save'] = () => ({ hash: 'hash-3' })
    // one long line: happy-dom would render all 120,000 short lines, which the real viewport never does
    const draft = 'x'.repeat(6_000_001)
    edit(element, draft)
    await wait(350)
    expect(element.querySelector('.cm-editor')).toBeNull()
    expect(element.textContent).toContain('This diff is too large to display safely.')
    expect(element.textContent).toContain('character count exceeds the safe display limit')
    expect(element.textContent).toContain('This draft crossed the safe display limit, but it can still be saved.')
    expect(report()).toMatchObject({ tooLarge: true, dirty: true })
    await click(byText(element, 'Save'))
    expect(fake.callsTo('quirky.git/save')[0].params).toEqual({
      worktree: 'w1',
      path: 'math.ts',
      content: draft,
      expected: 'hash-1'
    })
    expect(byText(element, 'Save')?.disabled).toBe(true)
  })

  test('a draft within the limits stays in the editor after the recount', async () => {
    const { element } = await open(editableDiff())
    edit(element, 'small\n')
    await wait(350)
    expect(element.querySelector('.cm-editor')).not.toBeNull()
    expect(element.textContent).not.toContain('too large')
  })
})
