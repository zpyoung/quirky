import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { InlineError, ReviewMark, ScopeChip, SplitButton, type ContextMenuItem } from '../src/design-system'

let root: Root | null = null
let container: HTMLDivElement

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const render = (node: ReactNode) => act(async () => root!.render(node))
const click = (element: Element) => act(async () => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
const key = (element: Element, value: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
})
const byLabel = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!

describe('ReviewMark', () => {
  test.each([
    ['none', '○', 'Not reviewed'],
    ['reviewed', '✓', 'Reviewed'],
    ['changed', '●', 'Changed since review'],
  ] as const)('renders the %s state as an image with a default label', async (state, glyph, label) => {
    await render(h(ReviewMark, { state }))
    const mark = container.querySelector('[role="img"]')!
    expect(mark.getAttribute('aria-label')).toBe(label)
    expect(mark.textContent).toBe(glyph)
    expect(mark.className).toContain(`ui-review-mark--${state}`)
  })

  test('uses a caller label over the default', async () => {
    await render(h(ReviewMark, { state: 'reviewed', label: 'Reviewed at 10:02' }))
    expect(container.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Reviewed at 10:02')
  })
})

describe('SplitButton', () => {
  const items: ContextMenuItem[] = [
    { id: 'commit-all', label: 'Commit all 3 files' },
    { id: 'create-pr', label: 'Create PR', enabled: false, detail: 'no GitHub remote' },
  ]
  const mount = (overrides: Partial<Parameters<typeof SplitButton>[0]> = {}) => {
    const calls = { click: 0, chosen: [] as string[] }
    const node = h(SplitButton, {
      label: 'Commit 2 staged files',
      onClick: () => { calls.click += 1 },
      menuLabel: 'More ship steps',
      items,
      onChoose: (id: string) => calls.chosen.push(id),
      ...overrides,
    })
    return { calls, node }
  }

  test('renders the primary label and a caret named by menuLabel', async () => {
    const { calls, node } = mount()
    await render(node)
    const primary = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Commit 2 staged files')!
    await click(primary)
    expect(calls.click).toBe(1)
    expect(byLabel('More ship steps')).not.toBeNull()
  })

  test('disables the primary button and marks it busy', async () => {
    const { node } = mount({ disabled: true, busy: true, title: 'Working' })
    await render(node)
    const primary = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Commit 2 staged files')!
    expect(primary.disabled).toBe(true)
    expect(primary.getAttribute('aria-busy')).toBe('true')
    expect(primary.getAttribute('title')).toBe('Working')
  })

  test('lists a disabled item with its reason and chooses an enabled one', async () => {
    const { calls, node } = mount()
    await render(node)
    const caret = byLabel('More ship steps')
    await click(caret)
    const menu = document.querySelector('[role="menu"]')!
    const rows = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    const disabled = rows.find((r) => r.textContent!.includes('Create PR'))!
    expect(disabled.disabled).toBe(true)
    expect(disabled.textContent).toContain('no GitHub remote')

    await click(rows.find((r) => r.textContent!.includes('Commit all 3 files'))!)
    expect(calls.chosen).toEqual(['commit-all'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(caret)
  })

  test('chooses a nested item and returns focus to the caret', async () => {
    const nested: ContextMenuItem[] = [
      { label: 'Other', submenu: [{ id: 'child', label: 'Child' }] },
    ]
    const { calls, node } = mount({ items: nested })
    await render(node)
    const caret = byLabel('More ship steps')
    await click(caret)
    const rowNamed = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((r) => r.textContent!.includes(text))!
    await click(rowNamed('Other'))
    await click(rowNamed('Child'))
    expect(calls.chosen).toEqual(['child'])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(caret)
  })

  test('closes on Escape and returns focus to the caret', async () => {
    const { node } = mount()
    await render(node)
    const caret = byLabel('More ship steps')
    await click(caret)
    await key(document.querySelector('[role="menu"]')!, 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(caret)
  })
  test('hands the caret corner to a caller-owned menu', async () => {
    const anchors: Array<{ x: number; y: number }> = []
    await render(h(SplitButton, {
      label: 'Pull 1 commit',
      onClick: () => {},
      menuLabel: 'More ship steps',
      menuOpen: false,
      onOpenMenu: (anchor) => anchors.push(anchor),
    }))
    const caret = byLabel('More ship steps')
    expect(caret.getAttribute('aria-expanded')).toBe('false')
    await click(caret)
    expect(anchors).toEqual([{ x: 0, y: 0 }])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(caret.getAttribute('aria-expanded')).toBe('false')
  })

  test('reports the caller-owned menu as expanded', async () => {
    await render(h(SplitButton, {
      label: 'Pull 1 commit',
      onClick: () => {},
      menuLabel: 'More ship steps',
      menuOpen: true,
      onOpenMenu: () => {},
    }))
    expect(byLabel('More ship steps').getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  test('does not open a caller-owned menu while busy', async () => {
    let opened = 0
    await render(h(SplitButton, {
      label: 'Pulling',
      busy: true,
      onClick: () => {},
      menuLabel: 'More ship steps',
      menuOpen: false,
      onOpenMenu: () => { opened += 1 },
    }))
    const caret = byLabel('More ship steps')
    expect(caret.disabled).toBe(true)
    await click(caret)
    expect(opened).toBe(0)
  })
})

describe('InlineError', () => {
  test('renders an alert and dismisses', async () => {
    let dismissed = 0
    await render(h(InlineError, { message: 'Push failed', onDismiss: () => { dismissed += 1 } }))
    const alert = container.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Push failed')
    expect(container.querySelectorAll('button').length).toBe(1)
    await click(byLabel('Dismiss'))
    expect(dismissed).toBe(1)
  })

  test('renders its action as a button', async () => {
    let acted = 0
    await render(h(InlineError, { message: 'Push failed', action: { label: 'Retry', onAction: () => { acted += 1 } }, onDismiss: () => {} }))
    const action = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
    await click(action)
    expect(acted).toBe(1)
  })
})

describe('ScopeChip', () => {
  test('names its remove button after the label by default', async () => {
    let removed = 0
    await render(h(ScopeChip, { label: 'Commit f5429a1', onRemove: () => { removed += 1 } }))
    expect(container.textContent).toContain('Commit f5429a1')
    await click(byLabel('Remove Commit f5429a1'))
    expect(removed).toBe(1)
  })

  test('honours removeLabel', async () => {
    await render(h(ScopeChip, { label: 'Commit f5429a1', removeLabel: 'Back to worktree review', onRemove: () => {} }))
    expect(byLabel('Back to worktree review')).not.toBeNull()
  })
})
