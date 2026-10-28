import { afterEach, expect, test } from 'bun:test'
import { activeDocument, registerActiveDocument } from '../src/window/activeDocument'

const document = (bufferId: string, tabId: string, mode: 'source' | 'preview' = 'source') => ({
  bufferId,
  tabId,
  worktreeId: 'worktree',
  path: `${bufferId}.md`,
  mode,
  kind: 'markdown' as const,
  flush: async () => {},
  save: async () => {},
  focus: () => {},
  close: async () => true,
  runCommand: async () => { throw new Error('Ownership tests must not dispatch renderer commands') }
})

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

test('background-mounted tabs do not replace the focused document command target', () => {
  const first = document('first', 'tab-first')
  const second = document('second', 'tab-second')
  const firstMount = registerActiveDocument(first)
  firstMount.focus()
  const secondMount = registerActiveDocument(second)
  cleanups.push(firstMount.unregister, secondMount.unregister)

  expect(activeDocument()).toMatchObject({ bufferId: 'first', tabId: 'tab-first' })
  expect(activeDocument()?.mode).toBe('source')
})

test('unmounting the focused tab does not restore an unmounted predecessor', () => {
  const firstMount = registerActiveDocument(document('first', 'tab-first'))
  const secondMount = registerActiveDocument(document('second', 'tab-second'))
  cleanups.push(firstMount.unregister, secondMount.unregister)

  firstMount.focus()
  secondMount.focus()
  firstMount.unregister()
  expect(activeDocument()).toMatchObject({ bufferId: 'second', tabId: 'tab-second' })
  secondMount.blur()
  expect(activeDocument()).toBeNull()

  secondMount.focus()
  secondMount.unregister()
  expect(activeDocument()).toBeNull()
})

test('changing a mounted tab mode preserves focus and updates its ownership', () => {
  const mount = registerActiveDocument(document('markdown', 'tab-edit'))
  cleanups.push(mount.unregister)
  mount.focus()
  mount.update(document('markdown', 'tab-preview', 'preview'))

  expect(activeDocument()).toMatchObject({ bufferId: 'markdown', tabId: 'tab-preview', mode: 'preview' })
})
