import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode } from '@quirky/protocol'
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

const counter = (root: ParentNode) => root.querySelector('[aria-label^="Conflict "], [aria-label="0 conflicts"]')?.textContent
const view = (root: ParentNode) => s.EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!

describe('quirky.git conflict file view', () => {
  test('SC-44: shows the banner, the 1 / 2 counter and tinted marker lines with their labels', async () => {
    const { element, report } = await openFile()
    expect(fake.callsTo('quirky.git/conflictFile')[0].params).toEqual({ worktree: 'w1', path: 'math.ts' })
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict · Both modified')
    expect(counter(element)).toBe('1 / 2')
    expect(report()).toMatchObject({ mode: 'conflict-file', path: 'math.ts', conflicts: 2, currentConflict: 1 })
    expect(element.querySelectorAll('.ui-editor-conflict-marker').length).toBe(7)
    expect(element.querySelectorAll('.ui-editor-conflict-current').length).toBe(2)
    expect(element.querySelectorAll('.ui-editor-conflict-base').length).toBe(1)
    expect(element.querySelectorAll('.ui-editor-conflict-incoming').length).toBe(2)
    const labels = [...element.querySelectorAll('.ui-editor-conflict-label')].map((l) => l.textContent)
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
    expect(element.querySelectorAll('.ui-editor-conflict-marker').length).toBe(0)
  })

  for (const kind of ['deleted_by_them', 'deleted_by_us'] as const) {
    test(`SC-44: ${kind} conflicts offer explicit resolution choices`, async () => {
      const { element } = await openFile(conflictFile({ kind, content: 'current\n' }))
      expect(byText(element, 'Keep file')).not.toBeNull()
      expect(byText(element, 'Accept deletion')).not.toBeNull()
    })

    test(`SC-44: ${kind} with no working file disables Keep and explains why`, async () => {
      const { element } = await openFile(conflictFile({ kind, content: null, hash: null }))
      const keep = byText(element, 'Keep file')
      expect(keep?.disabled).toBe(true)
      expect(keep?.title?.toLowerCase()).toContain('working')
      expect(keep?.title?.toLowerCase()).toContain('file')
      expect(byText(element, 'Accept deletion')?.disabled).toBe(false)
    })

    test(`SC-44: resolved ${kind} hides the resolution choices`, async () => {
      const { element } = await openFile(conflictFile({ kind, state: 'resolved_locally' }))
      expect(byText(element, 'Keep file')).toBeNull()
      expect(byText(element, 'Accept deletion')).toBeNull()
    })
  }

  test('SC-44: Keep saves the dirty working file before staging it', async () => {
    let fresh = conflictFile({ kind: 'deleted_by_them', content: 'ours\n' })
    const { element, report } = await openFile(fresh)
    fake.handlers['quirky.git/conflictFile'] = () => fresh
    fake.handlers['quirky.git/save'] = () => {
      fresh = conflictFile({ kind: 'deleted_by_them', content: 'kept\n', hash: 'h2' })
      return { hash: 'h2' }
    }
    fake.handlers['quirky.git/stage'] = () => {
      fresh = conflictFile({ kind: 'deleted_by_them', state: 'resolved_locally', content: 'kept\n', hash: 'h2' })
      fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } })
    }
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept\n' } }))

    await click(byText(element, 'Keep file'))

    expect(fake.calls.filter((call) => call.method === 'quirky.git/save' || call.method === 'quirky.git/stage').map((call) => call.method)).toEqual([
      'quirky.git/save',
      'quirky.git/stage'
    ])
    expect(fake.callsTo('quirky.git/save')[0].params.expected).toBe('h1')
    expect(fake.callsTo('quirky.git/stage')[0].params.paths).toEqual(['math.ts'])
    expect(report()).toMatchObject({ dirty: false, stale: false })
    expect(byText(element, 'Keep file')).toBeNull()
    expect(byText(element, 'Accept deletion')).toBeNull()
  })

  test('SC-44: Keep refuses to stage when the file disappears after it was opened', async () => {
    const { element } = await openFile(conflictFile({ kind: 'deleted_by_them', content: 'ours\n' }))
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ kind: 'deleted_by_them', content: null, hash: null })

    await click(byText(element, 'Keep file'))

    expect(fake.callsTo('quirky.git/stage')).toHaveLength(0)
    expect(fake.toasts.length > 0 || element.querySelector('[role="alert"]') !== null).toBe(true)
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict')
  })

  test('SC-44: a failed guarded save prevents Keep from staging and leaves the conflict unresolved', async () => {
    const { element, report } = await openFile(conflictFile({ kind: 'deleted_by_them', content: 'ours\n' }))
    fake.handlers['quirky.git/save'] = () => {
      throw failure('The file changed on disk.', 'changed-on-disk')
    }
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'draft ' } }))

    await click(byText(element, 'Keep file'))

    expect(fake.callsTo('quirky.git/stage')).toHaveLength(0)
    expect(report()).toMatchObject({ dirty: true, stale: true })
    expect(element.querySelector('[role="alert"]')).not.toBeNull()
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict')
    expect(byText(element, 'Keep file')).not.toBeNull()
    expect(byText(element, 'Accept deletion')).not.toBeNull()
  })

  test('SC-44: Accept deletion refreshes resolution and clears a dirty draft', async () => {
    let fresh = conflictFile({ kind: 'deleted_by_us', content: 'incoming\n' })
    const { element, report } = await openFile(fresh)
    fake.handlers['quirky.git/conflictFile'] = () => fresh
    fake.handlers['quirky.git/acceptConflictDeletion'] = () => {
      fresh = conflictFile({ kind: 'deleted_by_us', state: 'resolved_locally', content: null, hash: null })
      fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } })
      return { ok: true }
    }
    act(() => view(element).dispatch({ changes: { from: 0, insert: 'draft ' } }))

    await click(byText(element, 'Accept deletion'))

    expect(fake.callsTo('quirky.git/acceptConflictDeletion')[0].params.expected).toBe('h1')
    expect(fake.callsTo('quirky.git/save')).toHaveLength(0)
    expect(report()).toMatchObject({ dirty: false, stale: false })
    expect(byText(element, 'Keep file')).toBeNull()
    expect(byText(element, 'Accept deletion')).toBeNull()
  })

  test('SC-44: Accept deletion uses the saved file version after saving an edit', async () => {
    let fresh = conflictFile({ kind: 'deleted_by_them', content: 'ours\n' })
    const { element, report } = await openFile(fresh)
    fake.handlers['quirky.git/conflictFile'] = () => fresh
    fake.handlers['quirky.git/save'] = () => {
      fresh = conflictFile({ kind: 'deleted_by_them', content: 'edited\n', hash: 'h2' })
      return { hash: 'h2' }
    }
    fake.handlers['quirky.git/acceptConflictDeletion'] = (params) => {
      if (params.expected !== fresh.hash) throw failure('The file changed on disk.', 'changed-on-disk')
      fresh = conflictFile({ kind: 'deleted_by_them', state: 'resolved_locally', content: null, hash: null })
      return { ok: true }
    }
    act(() => view(element).dispatch({ changes: { from: 0, to: view(element).state.doc.length, insert: 'edited\n' } }))
    await act(async () => void (await fake.run('save')))
    await settle()

    await click(byText(element, 'Accept deletion'))

    expect(report()).toMatchObject({ dirty: false, stale: false })
    expect(byText(element, 'Accept deletion')).toBeNull()
  })

  test('SC-44: both resolution choices are disabled while deletion is pending and failure leaves it unresolved', async () => {
    const { promise, reject } = Promise.withResolvers<void>()
    const { element } = await openFile(conflictFile({ kind: 'deleted_by_them', content: 'ours\n' }))
    fake.handlers['quirky.git/acceptConflictDeletion'] = () => promise

    await click(byText(element, 'Accept deletion'))
    expect(byText(element, 'Keep file')?.disabled).toBe(true)
    expect(byText(element, 'Accept deletion')?.disabled).toBe(true)
    reject(failure('Deletion could not be staged.'))
    await settle()

    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict')
    expect(byText(element, 'Keep file')?.disabled).toBe(false)
    expect(byText(element, 'Accept deletion')?.disabled).toBe(false)
    expect(fake.toasts.length > 0 || element.querySelector('[role="alert"]') !== null).toBe(true)
  })

  test('SC-44: a conflict with no working file says there is nothing to edit', async () => {
    const { element } = await openFile(conflictFile({ kind: 'both_deleted', content: null, hash: null }))
    expect(element.textContent).toContain('No working-tree file is available to edit for this conflict.')
    expect(element.querySelector('.cm-editor')).toBeNull()
    expect(byLabel(element, 'Next conflict')).toBeNull()
  })

  test('SC-41: refreshing a staged deleted conflict presents plain resolved state without conflict actions', async () => {
    const { element, report } = await openFile(conflictFile({ kind: 'deleted_by_them' }))
    const editor = view(element)
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ kind: 'deleted_by_them', state: 'resolved_locally' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    const statusText = element.querySelector('[role="status"]')?.textContent ?? ''
    expect(statusText).toContain('Resolved')
    expect(statusText.toLowerCase()).not.toContain('conflict')
    expect(element.querySelector('h2')?.textContent?.toLowerCase()).not.toContain('conflict')
    expect(element.textContent).not.toContain('Decide whether to keep the file or accept deletion')
    expect(counter(element)).toBeUndefined()
    expect(byLabel(element, 'Previous conflict')).toBeNull()
    expect(byLabel(element, 'Next conflict')).toBeNull()
    expect(view(element)).toBe(editor)
    expect(report()).toMatchObject({ conflicts: 0, currentConflict: null })
  })

  for (const outcome of ['resolved_locally', 'operation-ended'] as const) {
    test(`SC-44: refreshing a modify/delete conflict to ${outcome} removes both resolution choices`, async () => {
      const { element } = await openFile(conflictFile({ kind: 'deleted_by_them', content: 'ours\n' }))
      expect(byText(element, 'Keep file')).not.toBeNull()
      expect(byText(element, 'Accept deletion')).not.toBeNull()
      fake.handlers['quirky.git/conflictFile'] = () => {
        if (outcome === 'operation-ended') throw Object.assign(failure('math.ts is no longer conflicted.', 'not-found'), { code: RpcErrorCode.NotFound })
        return conflictFile({ kind: 'deleted_by_them', state: 'resolved_locally', content: 'ours\n' })
      }
      fake.handlers['quirky.git/status'] = () => ({ ...status(), operation: outcome === 'operation-ended' ? 'none' : 'merge' })

      await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
      await settle()

      expect(byText(element, 'Keep file')).toBeNull()
      expect(byText(element, 'Accept deletion')).toBeNull()
    })
  }

  test('SC-41: a failed file refresh clears conflict UI only after status confirms the operation ended', async () => {
    const { element, report } = await openFile()
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, insert: 'draft ' } }))
    const draft = editor.state.sliceDoc()
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(failure('math.ts is no longer conflicted.', 'not-found'), { code: RpcErrorCode.NotFound })
    }
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    const statusText = element.querySelector('[role="status"]')?.textContent ?? ''
    expect(statusText.toLowerCase()).toContain('operation ended')
    expect(element.querySelector('h2')?.textContent?.toLowerCase()).not.toContain('conflict')
    expect(counter(element)).toBeUndefined()
    expect(byLabel(element, 'Previous conflict')).toBeNull()
    expect(byLabel(element, 'Next conflict')).toBeNull()
    expect(view(element)).toBe(editor)
    expect(view(element).state.sliceDoc()).toBe(draft)
    expect(report()).toMatchObject({ dirty: true, conflicts: 0, currentConflict: null })
  })

  test('SC-41: a transient file refresh error keeps conflict UI while status reports an active merge', async () => {
    const { element, report } = await openFile()
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw new Error('temporary read failure')
    }
    fake.handlers['quirky.git/status'] = () => ({ ...status(), operation: 'merge' })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()

    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict')
    expect(counter(element)).toBe('1 / 2')
    expect(report()).toMatchObject({ conflicts: 2 })
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
    expect(element.querySelector('[role="alert"]')).not.toBeNull()
    expect(report().stale).toBe(true)
    await click(byText(element, 'Overwrite'))
    expect(element.querySelector('[role="alert"]')).toBeNull()
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
    expect(element.querySelector('[role="alert"]')).toBeNull()
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

  test('a conflict tab remounted after Continue shows Git operation ended instead of a load error', async () => {
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is not in conflict.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => status()
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(mounted.element.querySelector('[role="status"]')?.textContent).toContain('Git operation ended')
    expect(mounted.element.textContent).toContain('No working-tree file is available.')
    expect(mounted.element.textContent).not.toContain('Error loading conflict file')
  })

  test('a NotFound refresh with an active conflict does not end the operation', async () => {
    const { element, report } = await openFile()
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is not in conflict.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => ({
      ...status([{ path: 'math.ts', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'unresolved' } }]),
      operation: 'merge'
    })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Unresolved conflict')
    expect(element.textContent).not.toContain('Git operation ended')
    expect(counter(element)).toBe('1 / 2')
    expect(report()).toMatchObject({ conflicts: 2, currentConflict: 1 })
  })

  test('status can resolve a loaded file when its refresh fails', async () => {
    const { element, report } = await openFile()
    const editor = view(element)
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is no longer conflicted.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => ({
      ...status([{ path: 'math.ts', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'resolved_locally' } }]),
      operation: 'merge'
    })
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Resolved')
    expect(element.textContent).not.toContain('Git operation ended')
    expect(counter(element)).toBeUndefined()
    expect(view(element)).toBe(editor)
    expect(report()).toMatchObject({ conflicts: 0, currentConflict: null })
  })

  test('an initial NotFound stays visible when status is unavailable', async () => {
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is not in conflict.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => {
      throw new Error('status unavailable')
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(mounted.element.textContent).toContain('Error loading conflict file: math.ts is not in conflict.')
    expect(mounted.element.textContent).not.toContain('Git operation ended')
  })

  test('a hosted conflict draft survives tab remounts and retains its original save precondition', async () => {
    const input = { worktree: 'w1', mode: 'conflict-file', path: 'math.ts', tabId: 'draft-remount' }
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile()
    mounted = mountView(fake, input)
    await settle()
    const editor = view(mounted.element)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved resolution\n' } }))
    await settle()
    mounted.unmount()
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ content: 'external resolution\n', hash: 'h2' })
    mounted = mountView(fake, input)
    await settle()
    expect(view(mounted.element).state.sliceDoc()).toBe('unsaved resolution\n')
    expect(mounted.report()).toMatchObject({ dirty: true, stale: true })
    fake.handlers['quirky.git/save'] = () => ({ hash: 'h3' })
    await act(async () => void (await fake.run('save')))
    expect(fake.callsTo('quirky.git/save').at(-1)?.params).toMatchObject({ content: 'unsaved resolution\n', expected: 'h1' })
    mounted.unmount()
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ content: 'unsaved resolution\n', hash: 'h3' })
    mounted = mountView(fake, input)
    await settle()
    expect(mounted.report()).toMatchObject({ dirty: false, stale: false })
  })

  test('a remounted modify/delete draft keeps both resolution choices available', async () => {
    const input = { worktree: 'w1', mode: 'conflict-file', path: 'math.ts', tabId: 'modify-delete-draft' }
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ kind: 'deleted_by_them', content: 'ours\n' })
    mounted = mountView(fake, input)
    await settle()
    s.edit(mounted.element, 'unsaved resolution\n')
    await settle()
    mounted.unmount()
    mounted = mountView(fake, input)
    await settle()
    expect(view(mounted.element).state.sliceDoc()).toBe('unsaved resolution\n')
    expect(['Keep file', 'Accept deletion'].map((label) => byText(mounted!.element, label)?.disabled)).toEqual([false, false])
  })

  for (const action of ['Keep file', 'Accept deletion']) {
    test(`${action} stops pending work after the conflict tab unmounts`, async () => {
      const result = conflictFile({ kind: 'deleted_by_them', content: 'ours\n' })
      const { element } = await openFile(result)
      const pending = Promise.withResolvers<typeof result>()
      fake.handlers[action === 'Keep file' ? 'quirky.git/conflictFile' : 'quirky.git/acceptConflictDeletion'] = () => pending.promise
      await click(byText(element, action))
      const reads = fake.callsTo('quirky.git/conflictFile').length
      mounted!.unmount()
      mounted = null
      await act(async () => {
        pending.resolve(result)
        await settle()
      })
      expect(fake.callsTo('quirky.git/stage')).toHaveLength(0)
      expect(fake.callsTo('quirky.git/conflictFile')).toHaveLength(reads)
    })
  }

  test('a restored conflict draft keeps genuine read failures visible until a successful refresh', async () => {
    const input = { worktree: 'w1', mode: 'conflict-file', path: 'math.ts', tabId: 'draft-read-error' }
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile()
    mounted = mountView(fake, input)
    await settle()
    s.edit(mounted.element, 'unsaved resolution\n')
    await settle()
    mounted.unmount()
    fake.handlers['quirky.git/conflictFile'] = () => { throw new Error('math.ts is binary') }
    fake.handlers['quirky.git/status'] = () => ({ ...status(), operation: 'merge' })
    mounted = mountView(fake, input)
    await settle()
    expect(mounted.element.textContent).toContain('Error loading conflict file: math.ts is binary')
    expect(view(mounted.element).state.sliceDoc()).toBe('unsaved resolution\n')
    expect(mounted.report().dirty).toBe(true)
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile()
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(mounted.element.textContent).not.toContain('Error loading conflict file')
    expect(view(mounted.element).state.sliceDoc()).toBe('unsaved resolution\n')
    fake.handlers['quirky.git/save'] = () => ({ hash: 'h2' })
    await act(async () => void (await fake.run('save')))
  })

  test('a save completing after unmount cannot erase a newer hosted draft', async () => {
    const input = { worktree: 'w1', mode: 'conflict-file', path: 'math.ts', tabId: 'pending-save-remount' }
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile()
    mounted = mountView(fake, input)
    await settle()
    s.edit(mounted.element, 'resolution A\n')
    await settle()
    const pendingSave = Promise.withResolvers<{ hash: string }>()
    fake.handlers['quirky.git/save'] = () => pendingSave.promise
    const saving = fake.run('save')
    await settle()
    mounted.unmount()
    mounted = mountView(fake, input)
    await settle()
    s.edit(mounted.element, 'resolution B\n')
    await settle()
    mounted.unmount()
    mounted = null
    await act(async () => {
      pendingSave.resolve({ hash: 'h2' })
      await saving
    })
    fake.handlers['quirky.git/conflictFile'] = () => conflictFile({ content: 'resolution A\n', hash: 'h2' })
    mounted = mountView(fake, input)
    await settle()
    expect(view(mounted.element).state.sliceDoc()).toBe('resolution B\n')
    expect(mounted.report()).toMatchObject({ dirty: true, stale: true })
    fake.handlers['quirky.git/save'] = () => ({ hash: 'h3' })
    await act(async () => void (await fake.run('overwrite')))
  })

  test('finishing an operation keeps an unsaved conflict draft available', async () => {
    const { element, report } = await openFile()
    const editor = view(element)
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved resolution\n' } }))
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is not in conflict.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => status()
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Git operation ended')
    expect(counter(element)).toBeUndefined()
    expect(byLabel(element, 'Previous conflict')).toBeNull()
    expect(byLabel(element, 'Next conflict')).toBeNull()
    expect(view(element)).toBe(editor)
    expect(view(element).state.sliceDoc()).toBe('unsaved resolution\n')
    expect(report()).toMatchObject({ dirty: true, conflicts: 0, currentConflict: null })
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
    const rows = [...element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)
    expect(rows).toEqual(['a.tsUnresolvedOpen', 'b.tsUnresolvedOpen'])
    expect(element.textContent).toMatch(/2 unresolved conflicts · Snapshot captured at .+\./)
    expect(element.querySelector('nav[aria-label="Files"] h2')?.textContent).toBe('Files')
    expect(report()).toMatchObject({ mode: 'conflicts', conflicts: 2 })
  })

  test('SC-45: opening a file persists the normal hosted review snapshot on its originating tab', async () => {
    // ui-backed imports require the registered dom
    const hosted = (await import('./panel-support')).fakeContext(layoutFor('w1'))
    const { openHostedDiff } = await import('../../src/view/hosted-tabs')
    const reviewInput = await openHostedDiff(hosted.context, { worktree: 'w1', mode: 'conflicts' })
    expect(reviewInput.tabId).toBeDefined()
    expect(reviewInput).not.toHaveProperty('review')
    const groupId = reviewInput.groupId!
    for (const method of ['quirky.terminal/workspace', 'quirky.terminal/openViewTab', 'quirky.terminal/rekeyViewTabs']) {
      fake.handlers[method] = (params) => hosted.context.call(method, params)
    }
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('b.ts')])
    const initialReview = mountView(fake, reviewInput)
    mounted = initialReview
    await settle()
    await click(byText(initialReview.element, 'Open'))

    const result = (await hosted.context.call('quirky.terminal/workspace', { workspace: 'id:w1' })) as {
      workspace: {
        activeGroup: string
        root: {
          kind: string
          activeTab: string | null
          tabs: Array<{ id: string; viewId: string; preview: boolean; input: Record<string, unknown> }>
        }
      }
    }
    expect(result.workspace.root.kind).toBe('group')
    expect(result.workspace.activeGroup).toBe(groupId)
    const tabs = result.workspace.root.tabs
    const reviewTab = tabs.find((tab) => tab.id === reviewInput.tabId)
    const opened = tabs.find((tab) => tab.input.mode === 'conflict-file')
    expect(tabs).toHaveLength(2)
    expect(reviewTab).toBeDefined()
    expect(opened).toBeDefined()
    if (!reviewTab || !opened) throw new Error('Expected both the originating review tab and opened conflict file tab.')
    expect(reviewTab).toMatchObject({ preview: false, input: { groupId, mode: 'conflicts' } })
    const persistedReview = reviewTab.input.review as { entries: Array<{ path: string; kind: string }>; capturedAt: number }
    expect(persistedReview.entries).toEqual([
      { path: 'a.ts', kind: 'both_modified' },
      { path: 'b.ts', kind: 'both_modified' }
    ])
    expect(persistedReview.capturedAt).toBeGreaterThan(0)
    expect(opened).toMatchObject({
      viewId: s.DIFF_VIEW,
      preview: false,
      input: { worktree: 'w1', mode: 'conflict-file', path: 'a.ts', groupId, review: persistedReview }
    })
    expect(result.workspace.root.activeTab).toBe(opened.id)

    initialReview.unmount()
    mounted = null
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts'), conflict('new.ts')])
    fake.handlers['quirky.git/conflictFile'] = (params) => {
      expect(params.path).toBe('b.ts')
      return { content: null }
    }
    const resumedReview = mountView(fake, reviewTab.input)
    mounted = resumedReview
    await settle()
    expect([...resumedReview.element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((row) => row.textContent)).toEqual([
      'a.tsUnresolvedOpen',
      'b.tsGone'
    ])
    expect(resumedReview.element.textContent).toContain(
      `Snapshot captured at ${new Date(persistedReview.capturedAt).toLocaleTimeString()}.`
    )
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
    expect([...mounted.element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)).toEqual(['a.tsResolved', 'b.tsGone'])
    expect(mounted.element.textContent).toContain('All conflicts resolved')
  })

  test('a malformed review in the input is ignored, so the review takes a fresh snapshot', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts')])
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts', review: { entries: 'nope', capturedAt: 'x' } })
    await settle()
    expect([...mounted.element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)).toEqual(['a.tsUnresolvedOpen'])
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
    const rows = [...element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)
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
    expect([...element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)).toEqual(['a.tsResolved', 'b.tsGone'])
  })

  test('SC-45: a conflict resolved locally counts as resolved; the snapshot keeps its files', async () => {
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts')])
    const { element } = await openReview()
    fake.handlers['quirky.git/status'] = () => status([conflict('a.ts', 'resolved_locally'), conflict('new.ts')])
    await click(byText(element, 'Refresh'))
    expect([...element.querySelectorAll('nav[aria-label="Files"] [data-path]')].map((r) => r.textContent)).toEqual(['a.tsResolved'])
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
