import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { ContextMenu } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, press, q, qa, rowOf, settle, statusOf } = s
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { postSendRequest, SendMenu } = await import('../../src/notes/SendMenu')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
  act(() => postSendRequest(null))
})

type TestNote = { id: string; worktreeId: string; path: string; startLine: number; line: number; body: string; createdAt: number; updatedAt: number | null }
const note = (id: string, path: string, startLine: number, line = startLine, body = `Note ${id}`): TestNote => ({
  id,
  worktreeId: 'feat',
  path,
  startLine,
  line,
  body,
  createdAt: 1,
  updatedAt: null
})

const TARGETS = {
  sessions: [
    { session: 's1', agent: 'claude', label: 'Claude', title: 'fix tests', status: 'working', state: 'working', lastActivityAt: Date.now() - 2 * 60_000 - 500, sendable: true },
    { session: 's2', agent: 'codex', label: 'Codex', title: 'review', status: 'waiting', state: 'waiting', lastActivityAt: Date.now(), sendable: false, reason: 'Codex is waiting for approval.' }
  ],
  agents: [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ]
}

type Fake = ReturnType<typeof fakeContext>

/** The panel over math.ts (unstaged), notes.txt (untracked), util.ts (staged) and README.md (only on the branch). */
async function open(noteCounts: Record<string, number>, configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([entry('math.ts', 'unstaged'), entry('notes.txt', 'untracked'), entry('util.ts', 'staged')])
  fake.compare = compareOf({ entries: [{ path: 'README.md', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })
  fake.noteCounts = { ...noteCounts }
  fake.on('quirky.git/noteTargets', () => TARGETS)
  configure(fake)
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const shelf = (root: ParentNode) => q(root, 'section[aria-label="Notes"]')
const menus = () => qa(document.body, '[role="menu"]')
const menuButtons = (menu: Element) => qa(menu as HTMLElement, '[role="menuitem"]') as HTMLButtonElement[]
const menuItem = (menu: Element, label: string) => menuButtons(menu).find((button) => button.textContent?.trim().startsWith(label)) ?? null
const menuText = (menu: Element) => menu.textContent ?? ''
const hover = (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
const key = async (name: string) => press(document.activeElement ?? document.body, name)

describe('NA-13: the panel has no notes shelf', () => {
  test('with notes there is no shelf and no Notes menu item; the ship bar is the one reader of the notes', async () => {
    const { fake, element, unmount } = await open({ 'math.ts': 2, 'util.ts': 1 })
    expect(shelf(element)).toBeNull()
    expect(q(element, '[data-note-row]')).toBeNull()
    await click(byLabel(element, 'More source control actions'))
    expect(qa(document.body, '[role="menu"] [role="menuitem"]').map((b) => (b.textContent ?? '').replace('✓', ''))).toEqual(['List', 'Tree', 'Change base…', 'Refresh', 'Revert all…'])
    expect(fake.called('quirky.git/notes')).toHaveLength(1)
    unmount()
  })

  test('the ship bar offers "Send N notes to agent" above the message field, and only while notes exist', async () => {
    const withNotes = await open({ 'math.ts': 2 }, (f) => f.on('quirky.git/notes', () => ({ notes: [note('n1', 'math.ts', 1), note('n2', 'math.ts', 3)] })))
    const send = byLabel(withNotes.element, 'Send 2 notes to agent')
    expect(send?.textContent).toBe('Send 2 notes to agent ▾')
    expect(send!.compareDocumentPosition(byLabel(withNotes.element, 'Commit message')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    withNotes.unmount()
    document.body.innerHTML = ''

    const without = await open({})
    expect(q(without.element, '[aria-label^="Send "]')).toBeNull()
    without.unmount()
  })
})

describe('NA-9: rows count notes by path', () => {
  test('every row of a path shows the count; rows without notes show none', async () => {
    const { element, unmount } = await open({ 'math.ts': 2, 'util.ts': 1 }, (fake) => {
      fake.status = statusOf([entry('math.ts', 'unstaged'), entry('util.ts', 'staged'), entry('util.ts', 'unstaged'), entry('plain.ts', 'unstaged')])
    })
    const count = (path: string) => q(rowOf(element, path)!, '[data-note-count]')
    expect(count('math.ts')?.textContent).toBe('✎2')
    expect(count('math.ts')?.title).toBe('2 notes')
    expect(count('util.ts')?.textContent).toBe('✎1')
    expect(count('util.ts')?.title).toBe('1 note')
    expect(count('plain.ts')).toBeNull()
    unmount()
  })

  test('a file that is only committed on the branch counts too', async () => {
    const { element, unmount } = await open({ 'README.md': 1 })
    expect(q(rowOf(element, 'README.md')!, '[data-note-count]')?.title).toBe('1 note')
    unmount()
  })

  test('the count follows the review model when notes change', async () => {
    const { fake, element, unmount } = await open({ 'math.ts': 1 })
    expect(q(rowOf(element, 'math.ts')!, '[data-note-count]')?.textContent).toBe('✎1')
    fake.noteCounts['math.ts'] = 3
    await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'feat' } } as never))
    await settle()
    expect(q(rowOf(element, 'math.ts')!, '[data-note-count]')?.textContent).toBe('✎3')
    delete fake.noteCounts['math.ts']
    await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'feat' } } as never))
    await settle()
    expect(q(rowOf(element, 'math.ts')!, '[data-note-count]')).toBeNull()
    unmount()
  })
})

describe('menus: submenus open on hover and ArrowRight and close on ArrowLeft and Escape', () => {
  async function mountMenu() {
    const picked: string[] = []
    let closed = 0
    const items: ContextMenuItem[] = [
      { label: 'Alpha', submenu: [{ label: 'One', onSelect: () => void picked.push('One') }, { label: 'Two', enabled: false }, { label: 'Three', onSelect: () => void picked.push('Three') }] },
      { label: 'Beta', onSelect: () => void picked.push('Beta') }
    ]
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(createElement(ContextMenu, { x: 10, y: 10, label: 'Test', items, onClose: () => void closed++ })))
    await settle()
    return { picked, closed: () => closed, unmount: () => act(async () => root.unmount()) }
  }

  test('hovering a row with a submenu opens it and hovering another row closes it', async () => {
    const menu = await mountMenu()
    expect(menus()).toHaveLength(1)
    await hover(menuItem(menus()[0]!, 'Alpha')!)
    expect(menus().map((m) => m.getAttribute('aria-label'))).toEqual(['Test', 'Alpha'])
    expect(menuItem(menus()[0]!, 'Alpha')?.getAttribute('aria-haspopup')).toBe('menu')
    await hover(menuItem(menus()[0]!, 'Beta')!)
    expect(menus()).toHaveLength(1)
    await menu.unmount()
  })

  test('ArrowRight opens a submenu; arrow keys skip disabled rows and Enter selects an enabled row', async () => {
    const menu = await mountMenu()
    await key('ArrowDown')
    await key('ArrowRight')
    expect(menus()).toHaveLength(2)
    const child = menus()[1]!
    expect(menuButtons(child).find((button) => button.disabled)?.textContent).toContain('Two')
    await key('ArrowDown')
    await key('ArrowDown')
    expect(child.querySelector('[role="menuitem"][data-highlighted]')?.textContent).toContain('Three')
    await key('Enter')
    expect(menu.picked).toEqual(['Three'])
    expect(menu.closed()).toBe(1)
    await menu.unmount()
  })

  test('ArrowLeft returns from a submenu and Escape closes the submenu before the menu', async () => {
    const menu = await mountMenu()
    await key('ArrowDown')
    await key('ArrowRight')
    await key('ArrowLeft')
    expect(menus()).toHaveLength(1)
    await key('ArrowRight')
    await key('Escape')
    expect(menus()).toHaveLength(1)
    expect(menu.closed()).toBe(0)
    await key('Escape')
    expect(menus()).toHaveLength(1)
    expect(menu.closed()).toBe(1)
    await menu.unmount()
  })

  test('picking a submenu row runs it and closes the menu; clicking the row that owns a submenu does not close', async () => {
    const menu = await mountMenu()
    await click(menuItem(menus()[0]!, 'Alpha')!)
    expect(menu.closed()).toBe(0)
    expect(menus()).toHaveLength(2)
    await click(buttonText(document.body, 'Three'))
    expect(menu.picked).toEqual(['Three'])
    expect(menu.closed()).toBe(1)
    await menu.unmount()
  })
  test('an outside mousedown closes the menu even when its target stops propagation', async () => {
    const pane = document.createElement('div')
    pane.addEventListener('mousedown', (event) => event.stopPropagation())
    pane.tabIndex = 0
    document.body.append(pane)
    const menu = await mountMenu()
    await act(async () => void pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu.closed()).toBe(1)
    await menu.unmount()
    pane.remove()
  })
})

describe('NA-17: the send menu offers scopes, then targets', () => {
  async function mountSend(fake: Fake, scopes: Array<{ id: string; label: string; notes: TestNote[]; params: Record<string, unknown> }>, props: Record<string, unknown> = {}) {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(createElement(SendMenu, { context: fake.context, worktree: 'feat', scopes, ...props } as never)))
    await settle()
    return { element, unmount: () => act(async () => root.unmount()) }
  }
  const two = [note('a', 'math.ts', 5), note('b', 'math.ts', 30)]
  const all = [...two, note('c', 'util.ts', 2)]
  const SCOPES = [
    { id: 'file', label: 'This file', notes: two, params: { scope: 'file', path: 'math.ts' } },
    { id: 'all', label: 'All unsent notes', notes: all, params: { scope: 'all' } }
  ]
  const trigger = (root: ParentNode) => byLabel(root, 'Send notes to an agent') as HTMLButtonElement

  test('two scopes: Send notes with counts, each opening Send notes to, then New agent', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    const { element, unmount } = await mountSend(fake, SCOPES)
    expect(trigger(element).title).toBe('Send notes to an agent')
    await click(trigger(element))
    expect(fake.called('quirky.git/noteTargets')[0]?.params).toEqual({ worktree: 'feat' })
    const top = menus()[0]!
    expect(menuText(top)).toContain('Send notes')

    await hover(menuItem(top, 'This file')!)
    const sub = menus()[1]!
    expect(menuText(sub)).toContain('Send notes to')
    const [s1, s2] = menuButtons(sub) as HTMLButtonElement[]
    expect((s1!.textContent ?? '').replace(/\s+/g, ' ').trim()).toContain('Working · 2m ago · fix tests')
    expect(q(s1!, '[role="img"][aria-label="Working"]')).not.toBeNull()
    expect(s1!.disabled).toBe(false)
    expect(s2!.disabled).toBe(true)
    expect(s2!.title).toBe('Codex is waiting for approval.')
    expect(q(s2!, '[role="img"][aria-label="Waiting"]')).not.toBeNull()
    await unmount()
  })

  test('a single scope shows its targets directly', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    expect(menuText(menus()[0]!)).toContain('Send notes to')
    expect(menuText(menus()[0]!)).toContain('New agent')
    await unmount()
  })

  test('sending to a session asks the daemon, toasts progress and holds the notes meanwhile', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    let release: (value: unknown) => void = () => {}
    fake.on('quirky.git/sendNotes', () => new Promise((resolve) => (release = resolve)))
    const { element, unmount } = await mountSend(fake, SCOPES)
    await click(trigger(element))
    await hover(menuItem(menus()[0]!, 'This file')!)
    await click(menuButtons(menus()[1]!)[0]!)
    expect(fake.called('quirky.git/sendNotes').map((c) => c.params)).toEqual([{ worktree: 'feat', scope: 'file', path: 'math.ts', session: 's1' }])
    expect(fake.toasts).toEqual([['Sending notes...', '']])
    expect(menus()).toHaveLength(0)
    expect(trigger(element).disabled).toBe(false)
    release({ sent: ['a', 'b'], kept: [], target: { session: 's1' }, delivery: 'pasted' })
    await settle()
    expect(fake.toasts).toEqual([['Sending notes...', ''], ['Notes sent.', '']])
    await unmount()
  })

  test('sending to a new agent passes the agent id; a refusal toasts the daemon message', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    fake.on('quirky.git/sendNotes', () => {
      throw failure('The agent did not receive the notes.')
    })
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    const agents = menuButtons(menus()[0]!).filter((button) => button.textContent?.trim().startsWith('Codex'))
    await click(agents[agents.length - 1])
    expect(fake.called('quirky.git/sendNotes').map((c) => c.params)).toEqual([{ worktree: 'feat', scope: 'all', agent: 'codex' }])
    expect(fake.toasts).toEqual([['Sending notes...', ''], ['Failed to send notes', 'The agent did not receive the notes.']])
    await unmount()
  })

  test('with every unsent note in flight the trigger reads Sending… and with none it reads All notes sent', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/noteTargets', () => TARGETS)
    let release: (value: unknown) => void = () => {}
    fake.on('quirky.git/sendNotes', () => new Promise((resolve) => (release = resolve)))
    const { element, unmount } = await mountSend(fake, [SCOPES[1]!])
    await click(trigger(element))
    await click(menuButtons(menus()[0]!).find((b) => b.textContent?.startsWith('Claude'))!)
    expect(trigger(element).disabled).toBe(true)
    expect(trigger(element).title).toBe('Sending…')
    release({ sent: ['a', 'b', 'c'], kept: [], target: { session: 's1' }, delivery: 'pasted' })
    await settle()
    expect(trigger(element).disabled).toBe(false)
    await unmount()

    const empty = await mountSend(fake, [{ ...SCOPES[1]!, notes: [] }])
    expect(trigger(empty.element).disabled).toBe(true)
    expect(trigger(empty.element).title).toBe('All notes sent')
    await empty.unmount()
  })
})
