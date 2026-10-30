import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, useState, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { CONTEXT_MENU_SEPARATOR, PopupMenu, type PopupItem } from '../src/design-system'

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLDivElement
let anchor: HTMLButtonElement

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM decides whether `input` events are supported when it loads, so it must load after happy-dom
  createRoot = (await import('react-dom/client')).createRoot
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  anchor = document.createElement('button')
  anchor.textContent = 'anchor'
  document.body.appendChild(anchor)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const rerender = (node: ReactNode) => act(async () => root!.render(node))
const render = async (node: ReactNode) => {
  await rerender(null)
  await rerender(node)
}
const key = (element: Element, value: string) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
  })
const press = (target: Element, type = 'pointerdown') =>
  act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
  })
const popups = () => [...document.querySelectorAll('.ui-popup')]
const rows = () => [...document.querySelectorAll('.ui-popup [role="menuitem"]')].map((row) => row.textContent)
const picked: string[] = []
const item = (label: string, extra: Partial<PopupItem> = {}): PopupItem => ({ label, onSelect: () => picked.push(label), ...extra })

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

async function withGeometry(viewport: { width: number; height: number }, anchorRect: DOMRect, popup: { width: number; height: number }, run: () => Promise<void>) {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const original = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport.width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: viewport.height })
  anchor.getBoundingClientRect = () => anchorRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      return this.classList.contains('ui-popup') ? rect(0, 0, popup.width, popup.height) : original.call(this)
    }
  })
  try {
    await run()
  } finally {
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: original })
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
  }
}

describe('PopupMenu', () => {
  test('renders as a menu without search and as a dialog with search, so native browser panes are masked', async () => {
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => {}} />)
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await render(<PopupMenu anchor={anchor} items={[item('One')]} searchPlaceholder="Search projects" title="Projects" onClose={() => {}} />)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-label')).toBe('Projects')
    expect(dialog.querySelector('input')!.getAttribute('placeholder')).toBe('Search projects')
  })

  test('masks the whole popup over native browser panes, so its title is covered too', async () => {
    await render(<PopupMenu anchor={anchor} title="Projects" items={[{ label: 'One' }]} onClose={() => {}} />)
    const masked = document.querySelector('[data-quirky-native-mask]')
    expect(masked?.contains(document.querySelector('.ui-popup__title'))).toBe(true)
    expect(masked?.contains(document.querySelector('[role="menu"]'))).toBe(true)
  })

  test('shows the title, section headings, shortcuts, lead, subtitle and trailing content', async () => {
    await render(
      <PopupMenu
        anchor={anchor}
        title="Worktrees"
        onClose={() => {}}
        items={[
          { label: 'Recent', heading: true },
          item('main', { lead: <i data-lead />, subtitle: '3 working', trailing: <b data-trailing>2</b>, key: '⌘1' }),
          CONTEXT_MENU_SEPARATOR,
          item('Add project')
        ]}
      />
    )
    const popup = document.querySelector('.ui-popup')!
    expect(popup.querySelector('.ui-popup__title')!.textContent).toBe('Worktrees')
    expect(popup.querySelector('.qt-menu-heading')!.textContent).toBe('Recent')
    const row = popup.querySelector('[role="menuitem"]')!
    expect(row.querySelector('[data-lead]')).not.toBeNull()
    expect(row.querySelector('[data-trailing]')!.textContent).toBe('2')
    expect(row.textContent).toContain('3 working')
    expect(row.textContent).toContain('⌘1')
    expect(popup.querySelector('[role="separator"]')).not.toBeNull()
  })

  test('marks the selected row with the pill and nothing else', async () => {
    await render(<PopupMenu anchor={anchor} items={[item('One'), item('Two', { selected: true })]} onClose={() => {}} />)
    const marked = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.hasAttribute('data-current'))
    expect(marked).toEqual([false, true])
  })

  test('keyboard navigation and Enter come from the shared list and close the popup', async () => {
    picked.length = 0
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One'), item('Two')]} onClose={() => (closes += 1)} />)
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(document.activeElement).toBe(menu)
    await key(menu, 'ArrowDown')
    await key(menu, 'ArrowDown')
    await key(menu, 'Enter')
    expect(picked).toEqual(['Two'])
    expect(closes).toBe(1)
    expect(popups()).toHaveLength(0)
  })

  test('opening a second popup closes the first even when its owner ignores onClose', async () => {
    const closed: string[] = []
    const second = document.createElement('button')
    document.body.appendChild(second)
    await rerender(
      <>
        <PopupMenu anchor={anchor} title="First" items={[item('A')]} onClose={() => closed.push('first')} />
      </>
    )
    expect(popups()).toHaveLength(1)
    await rerender(
      <>
        <PopupMenu anchor={anchor} title="First" items={[item('A')]} onClose={() => closed.push('first')} />
        <PopupMenu anchor={second} title="Second" items={[item('B')]} onClose={() => closed.push('second')} />
      </>
    )
    expect(popups()).toHaveLength(1)
    expect(popups()[0]!.querySelector('.ui-popup__title')!.textContent).toBe('Second')
    expect(closed).toEqual(['first'])
  })

  test('a popup opened by state after another leaves exactly one', async () => {
    function Harness() {
      const [which, setWhich] = useState<'a' | 'b' | null>(null)
      return (
        <>
          <button id="a" onClick={() => setWhich('a')} />
          <button id="b" onClick={() => setWhich('b')} />
          {which && <PopupMenu key={which} anchor={anchor} title={which} items={[item(which)]} onClose={() => setWhich(null)} />}
        </>
      )
    }
    await render(<Harness />)
    await act(async () => document.getElementById('a')!.click())
    await act(async () => document.getElementById('b')!.click())
    expect(popups()).toHaveLength(1)
    expect(popups()[0]!.querySelector('.ui-popup__title')!.textContent).toBe('b')
  })

  test('Escape closes the popup and returns focus to the anchor, from the list or the search field', async () => {
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => (closes += 1)} />)
    await key(document.querySelector('[role="menu"]')!, 'Escape')
    expect(closes).toBe(1)
    expect(popups()).toHaveLength(0)
    expect(document.activeElement).toBe(anchor)

    anchor.blur()
    await render(<PopupMenu anchor={anchor} searchPlaceholder="Search" items={[item('One')]} onClose={() => (closes += 1)} />)
    const input = document.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(input)
    await key(input, 'Escape')
    expect(closes).toBe(2)
    expect(document.activeElement).toBe(anchor)
  })

  test('Escape pressed while focus is still on the anchor also closes it', async () => {
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => (closes += 1)} />)
    anchor.focus()
    await key(anchor, 'Escape')
    expect(closes).toBe(1)
    expect(document.activeElement).toBe(anchor)
  })

  test('a pointer press outside closes it, while a press inside or on the anchor does not', async () => {
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => (closes += 1)} />)
    await press(document.querySelector('.ui-popup')!)
    await press(anchor)
    expect(closes).toBe(0)
    await press(document.body)
    expect(closes).toBe(1)
    expect(popups()).toHaveLength(0)
  })

  test('a mouse press outside closes it too', async () => {
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => (closes += 1)} />)
    await press(container, 'mousedown')
    expect(closes).toBe(1)
  })

  test('closes when the anchor leaves the DOM, and at once if it was never attached', async () => {
    let closes = 0
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => (closes += 1)} />)
    await act(async () => {
      anchor.remove()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(closes).toBe(1)
    expect(popups()).toHaveLength(0)

    await render(<PopupMenu anchor={document.createElement('button')} items={[item('One')]} onClose={() => (closes += 1)} />)
    expect(closes).toBe(2)
    expect(popups()).toHaveLength(0)
  })

  test('search filters labels and subtitles, keeps only the headings that still have rows, and Enter picks the first match', async () => {
    picked.length = 0
    await render(
      <PopupMenu
        anchor={anchor}
        searchPlaceholder="Search"
        onClose={() => {}}
        items={[
          { label: 'Alpha group', heading: true },
          item('apple', { subtitle: 'fruit stand' }),
          item('banana'),
          CONTEXT_MENU_SEPARATOR,
          { label: 'Beta group', heading: true },
          item('carrot', { subtitle: 'Orchard' })
        ]}
      />
    )
    const input = document.querySelector<HTMLInputElement>('input')!
    const type = (value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    expect(rows()).toHaveLength(3)
    await type('ORCH')
    expect(rows()).toEqual(['carrotOrchard'])
    expect([...document.querySelectorAll('.qt-menu-heading')].map((heading) => heading.textContent)).toEqual(['Beta group'])
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(0)
    await type('nan')
    expect(rows()).toEqual(['banana'])
    await key(input, 'Enter')
    expect(picked).toEqual(['banana'])
  })

  test('a search with no matches shows an empty line instead of crashing, and recovers', async () => {
    await render(<PopupMenu anchor={anchor} searchPlaceholder="Search" items={[item('One'), { label: 'Group', heading: true }, item('Two')]} onClose={() => {}} />)
    const input = document.querySelector<HTMLInputElement>('input')!
    const type = (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await type('zzz')
    expect(rows()).toEqual([])
    expect(document.querySelector('.ui-popup__empty')).not.toBeNull()
    await key(input, 'ArrowDown')
    await key(input, 'Enter')
    expect(popups()).toHaveLength(1)
    await type('')
    expect(document.querySelector('.ui-popup__empty')).toBeNull()
    expect(rows()).toHaveLength(2)
  })

  test('an empty item list renders without a crash', async () => {
    await render(<PopupMenu anchor={anchor} items={[]} onClose={() => {}} />)
    expect(popups()).toHaveLength(1)
  })

  test('is placed under the anchor, flipped above near the bottom, and clamped to the viewport', async () => {
    const left = () => document.querySelector<HTMLElement>('.ui-popup')!.style.left
    const top = () => document.querySelector<HTMLElement>('.ui-popup')!.style.top
    await withGeometry({ width: 800, height: 600 }, rect(100, 50, 40, 20), { width: 200, height: 100 }, async () => {
      await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => {}} />)
      expect([left(), top()]).toEqual(['100px', '70px'])
    })
    await withGeometry({ width: 800, height: 600 }, rect(100, 560, 40, 20), { width: 200, height: 100 }, async () => {
      await render(<PopupMenu anchor={anchor} items={[item('Two')]} onClose={() => {}} />)
      expect(top()).toBe('460px')
    })
    await withGeometry({ width: 800, height: 600 }, rect(750, 50, 40, 20), { width: 200, height: 100 }, async () => {
      await render(<PopupMenu anchor={anchor} items={[item('Three')]} onClose={() => {}} />)
      expect(left()).toBe('600px')
    })
    await withGeometry({ width: 800, height: 120 }, rect(10, 50, 40, 20), { width: 200, height: 100 }, async () => {
      await render(<PopupMenu anchor={anchor} items={[item('Four')]} onClose={() => {}} />)
      expect(top()).toBe('20px')
    })
  })

  test('carries the anchor\'s local theme so a themed gallery section styles its popup', async () => {
    const section = document.createElement('section')
    section.dataset.theme = 'light'
    const local = document.createElement('button')
    section.appendChild(local)
    document.body.appendChild(section)
    await render(<PopupMenu anchor={local} items={[item('One')]} onClose={() => {}} />)
    expect(document.querySelector('.ui-popup')!.getAttribute('data-theme')).toBe('light')
    await render(<PopupMenu anchor={anchor} items={[item('One')]} onClose={() => {}} />)
    expect(document.querySelector('.ui-popup')!.hasAttribute('data-theme')).toBe(false)
  })
})
