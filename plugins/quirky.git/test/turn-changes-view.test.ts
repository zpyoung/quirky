import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './ui/register-dom'

registerDom()
const s = await import('./ui/support')
afterAll(() => GlobalRegistrator.unregister())

const { act, click, fakeContext, layoutFor, modifiedEditor, numbered, settle, textDiff, wait } = s
type Fake = ReturnType<typeof fakeContext>

const VIEW = 'view:quirky.git/turn-changes'
const INPUT = { worktree: 'w1', fromTree: 'a'.repeat(40), toTree: 'b'.repeat(40) }
const CHANGES = [
  { path: 'src/retry.ts', status: 'modified', added: 39, removed: 13, binary: false },
  { path: 'src/config.ts', status: 'modified', added: 6, removed: 0, binary: false },
  { path: 'logo.png', status: 'added', added: null, removed: null, binary: true },
  { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed', added: 1, removed: 1, binary: false }
]
const TARGETS = {
  sessions: [{ session: 'chat-1', agent: 'claude', label: 'Claude', title: 'webhooks', status: 'running', state: null, lastActivityAt: Date.now(), sendable: true }],
  agents: []
}
const DIFF = textDiff({ original: numbered(12), modified: numbered(12).replace('line 4\n', 'four\n'), source: 'trees', modifiedHash: null })

type TestNote = { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string; createdAt: number; updatedAt: number | null }

let fake: Fake
let mounted: { element: HTMLElement; unmount(): void } | null = null
let stored: TestNote[]

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => root.querySelector<T>(selector)
const qa = <T extends Element = HTMLElement>(root: ParentNode, selector: string) => [...root.querySelectorAll<T>(selector)]
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()

/** Serves the turn's changes, its diffs and an in-memory notes list that announces every change. */
function serve(notes: TestNote[] = []) {
  stored = [...notes]
  const changed = () => fake.emit({ type: 'quirky.git/notesChanged', data: { worktreeId: 'w1' } } as never)
  fake.handlers['quirky.git/treeChanges'] = () => ({ changes: CHANGES })
  fake.handlers['quirky.git/diff'] = (params) => ({ ...DIFF, path: params.path as string })
  fake.handlers['quirky.git/notes'] = () => ({ notes: stored })
  fake.handlers['quirky.git/noteTargets'] = () => TARGETS
  fake.handlers['quirky.git/addNote'] = (params) => {
    const line = params.line as number
    const added = { id: `n${stored.length + 1}`, worktreeId: 'w1', path: params.path as string, startLine: line, line, body: params.body as string, createdAt: 1, updatedAt: null }
    stored = [...stored, added]
    changed()
    return { note: added }
  }
  fake.handlers['quirky.git/sendNotes'] = () => {
    const sent = stored.map((note) => note.id)
    stored = []
    changed()
    return { sent, kept: [], target: { session: 'chat-1' }, delivery: 'sent' }
  }
}

async function open(input: unknown = INPUT) {
  const mount = fake.provided.get(VIEW) as ((element: HTMLElement, props: { input?: unknown }) => () => void) | undefined
  if (!mount) throw new Error(`activate did not provide ${VIEW}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | undefined
  act(() => {
    cleanup = mount(element, { input })
  })
  mounted = {
    element,
    unmount() {
      act(() => cleanup?.())
      element.remove()
    }
  }
  await settle()
  return element
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = fakeContext(layoutFor('w1'))
  serve()
})
afterEach(async () => {
  mounted?.unmount()
  mounted = null
  await settle()
})

const rowOf = (root: ParentNode, path: string) => q(root, `[data-turn-file="${CSS.escape(path)}"]`)!
const toggleOf = (root: ParentNode, path: string) => q<HTMLButtonElement>(rowOf(root, path), 'button.ui-list-row__main')!
const pill = (root: ParentNode) => text(q(root, '[data-turn-notes]'))

async function setValue(area: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** Hovers line `n` of the modified side and clicks its "+". */
async function addAt(root: ParentNode, n: number): Promise<void> {
  const view = modifiedEditor(root)
  const { node } = view.domAtPos(view.state.doc.line(n).from)
  const line = (node instanceof Element ? node : node.parentElement!).closest('.cm-line')!
  await act(async () => void line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })))
  await settle()
  await click(q(root, 'button[data-note-add]'))
}

describe('the turn-changes view lists what a turn changed', () => {
  test('is a view of the plugin, called with the trees of the turn', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    expect(manifest.contributes.view.map((view: { id: string }) => view.id)).toContain('turn-changes')

    await open()
    expect(fake.callsTo('quirky.git/treeChanges').map((call) => call.params)).toEqual([{ worktree: 'w1', from: INPUT.fromTree, to: INPUT.toTree }])
  })

  test('shows each file with its counts, the totals and the notes count', async () => {
    const element = await open()

    expect(text(q(element, 'header'))).toContain('4 files changed')
    expect(text(q(element, 'header'))).toContain('+46')
    expect(text(q(element, 'header'))).toContain('−14')
    expect(qa(element, '[data-turn-file]').map((row) => row.getAttribute('data-turn-file'))).toEqual(['src/retry.ts', 'src/config.ts', 'logo.png', 'src/new-name.ts'])
    expect(text(rowOf(element, 'src/retry.ts'))).toContain('+39')
    expect(text(rowOf(element, 'src/retry.ts'))).toContain('−13')
    expect(text(rowOf(element, 'logo.png'))).toContain('Binary')
    expect(text(rowOf(element, 'src/new-name.ts'))).toContain('src/old-name.ts → src/new-name.ts')
    expect(pill(element)).toContain('AI notes 0')
    expect(qa(element, 'button').find((button) => text(button) === 'Open in Changes panel')).toBeDefined()
    expect(q(element, '[data-turn-diff]')).toBeNull()
    expect(fake.callsTo('quirky.git/diff')).toEqual([])
  })

  test('a turn with no changed files says so', async () => {
    fake.handlers['quirky.git/treeChanges'] = () => ({ changes: [] })
    const element = await open()
    expect(text(element)).toBe('This turn changed no files.')
  })

  test('says the changes are loading while the read is pending', async () => {
    let release: (value: unknown) => void = () => {}
    fake.handlers['quirky.git/treeChanges'] = () => new Promise((resolve) => { release = resolve })
    const element = await open()
    expect(text(q(element, '[role="status"] .ui-notice-line'))).toBe('Loading changes...')

    await act(async () => release({ changes: CHANGES }))
    await settle()
    expect(q(element, '[role="status"] .ui-notice-line')).toBeNull()
    expect(qa(element, '[data-turn-file]').length).toBe(CHANGES.length)
  })

  test('a failed read shows the daemon message', async () => {
    fake.handlers['quirky.git/treeChanges'] = () => {
      throw s.failure('unknown tree ' + INPUT.toTree, 'unknown-tree')
    }
    const element = await open()
    expect(text(q(element, '[role="alert"]'))).toContain('unknown tree')
  })

  test('input without a tree shows nothing to review and calls nothing', async () => {
    const element = await open({ worktree: 'w1', fromTree: INPUT.fromTree })
    expect(text(element)).toBe('No turn to show.')
    expect(fake.callsTo('quirky.git/treeChanges')).toEqual([])
  })

  test('Open in Changes panel opens the panel', async () => {
    const element = await open()
    await click(qa(element, 'button').find((button) => text(button) === 'Open in Changes panel'))
    expect(fake.panelToggles).toEqual([{ id: 'panel:quirky.git/source-control', open: true }])
  })
})

describe('expanding a file shows its read-only diff', () => {
  test('reads the diff between the two trees and draws it', async () => {
    const element = await open()
    await click(toggleOf(element, 'src/retry.ts'))

    expect(fake.callsTo('quirky.git/diff').map((call) => call.params)).toEqual([
      { worktree: 'w1', path: 'src/retry.ts', source: 'trees', from: INPUT.fromTree, to: INPUT.toTree }
    ])
    await wait(10)
    const view = modifiedEditor(rowOf(element, 'src/retry.ts'))
    expect(view.state.doc.toString()).toBe(DIFF.modified)
    expect(view.state.readOnly).toBe(true)
    expect(toggleOf(element, 'src/retry.ts').getAttribute('aria-label')).toBe('Collapse src/retry.ts')
  })

  test('a renamed file is read from its old path', async () => {
    const element = await open()
    await click(toggleOf(element, 'src/new-name.ts'))
    expect(fake.callsTo('quirky.git/diff')[0]?.params).toMatchObject({ path: 'src/new-name.ts', oldPath: 'src/old-name.ts', source: 'trees' })
  })

  test('collapsing hides it and expanding again reads nothing twice per open', async () => {
    const element = await open()
    await click(toggleOf(element, 'src/config.ts'))
    expect(q(rowOf(element, 'src/config.ts'), '[data-turn-diff]')).not.toBeNull()
    await click(toggleOf(element, 'src/config.ts'))
    expect(q(rowOf(element, 'src/config.ts'), '[data-turn-diff]')).toBeNull()
  })

  test('a diff that cannot be read shows the message and Retry reads it again', async () => {
    let failing = true
    fake.handlers['quirky.git/diff'] = (params) => {
      if (failing) throw s.failure('git could not read the tree')
      return { ...DIFF, path: params.path as string }
    }
    const element = await open()
    await click(toggleOf(element, 'src/config.ts'))
    expect(text(q(rowOf(element, 'src/config.ts'), '[role="alert"]'))).toContain('git could not read the tree')

    failing = false
    await click(qa(rowOf(element, 'src/config.ts'), 'button').find((button) => text(button) === 'Retry'))
    await wait(10)
    expect(modifiedEditor(rowOf(element, 'src/config.ts')).state.doc.toString()).toBe(DIFF.modified)
  })
})

describe('commenting and sending', () => {
  test('a line comment joins the worktree notes and raises the count', async () => {
    serve([{ id: 'old', worktreeId: 'w1', path: 'README.md', startLine: 1, line: 1, body: 'earlier', createdAt: 0, updatedAt: null }])
    const element = await open()
    expect(pill(element)).toContain('AI notes 1')

    await click(toggleOf(element, 'src/retry.ts'))
    await wait(10)
    await addAt(element, 4)
    const draft = q(element, '[data-note-card="draft"]')!
    await setValue(q<HTMLTextAreaElement>(draft, 'textarea')!, 'Use 30 s')
    await act(async () => void q(draft, 'textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await wait(10)

    expect(fake.callsTo('quirky.git/addNote').map((call) => call.params)).toEqual([{ worktree: 'w1', path: 'src/retry.ts', line: 4, body: 'Use 30 s' }])
    expect(pill(element)).toContain('AI notes 2')
    expect(text(rowOf(element, 'src/retry.ts'))).toContain('✎ 1 note')
    expect(q(element, '[data-note-card="saved"]')).not.toBeNull()
  })

  test('Send offers the sessions and sends every note of the worktree to the one chosen', async () => {
    serve([
      { id: 'a', worktreeId: 'w1', path: 'src/retry.ts', startLine: 4, line: 4, body: 'one', createdAt: 0, updatedAt: null },
      { id: 'b', worktreeId: 'w1', path: 'src/config.ts', startLine: 2, line: 2, body: 'two', createdAt: 1, updatedAt: null }
    ])
    const element = await open()

    const send = q<HTMLButtonElement>(element, 'button[aria-label="Send 2 notes to agent"]')!
    expect(text(send)).toBe('Send 2 notes to agent ▾')
    expect(send.classList.contains('ui-icon-button')).toBe(false)
    await click(send)
    const menu = q(document.body, '[role="menu"]')!
    const target = qa<HTMLButtonElement>(menu, '[role="menuitem"]').find((item) => text(item).startsWith('Claude'))!
    await click(target)

    expect(fake.callsTo('quirky.git/sendNotes').map((call) => call.params)).toEqual([{ worktree: 'w1', scope: 'all', session: 'chat-1' }])
    await settle()
    expect(pill(element)).toContain('AI notes 0')
    expect(q(element, 'button[aria-label^="Send "]')).toBeNull()
    expect(fake.toasts.at(-1)).toEqual(['Notes sent.', ''])
  })

  test('with no notes there is nothing to send', async () => {
    const element = await open()
    expect(q(element, 'button[aria-label^="Send "]')).toBeNull()
  })
})
