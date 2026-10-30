import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CONTEXT_MENU_SEPARATOR, ContextMenu } from './index'

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

async function render(node: ReactNode) {
  await act(async () => root!.render(node))
}

async function withMenuGeometry(innerWidth: number, menuWidth: number, run: () => Promise<void>) {
  const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const boundsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
  try {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLElement) {
        if (this.classList.contains('qt-menu')) {
          return new DOMRect(0, 0, menuWidth, 100)
        }
        return getBoundingClientRect.call(this)
      }
    })
    await run()
  } finally {
    if (innerWidthDescriptor) Object.defineProperty(window, 'innerWidth', innerWidthDescriptor)
    else Reflect.deleteProperty(window, 'innerWidth')
    if (boundsDescriptor) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', boundsDescriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
  }
}

async function renderPositionedMenu(props: { x: number; align?: 'start' | 'end' }) {
  await render(<ContextMenu
    label="Geometry"
    x={props.x}
    y={20}
    align={props.align}
    items={[]}
    onClose={() => {}}
  />)
  return document.querySelector<HTMLElement>('.qt-menu-anchor')!
}

const key = async (element: Element, value: string) => act(async () => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
})

describe('shared context menu', () => {
  test('nested menus skip disabled rows, return focus on Escape, and activate from the keyboard', async () => {
    const actions: string[] = []
    const closes: string[] = []
    await render(<ContextMenu label="Actions" x={10} y={20} highlightFirst items={[
      { label: 'Unavailable', enabled: false, onSelect: () => actions.push('unavailable') },
      { label: 'More', submenu: [
        { label: 'Locked', enabled: false, onSelect: () => actions.push('locked') },
        { label: 'Run nested', onSelect: () => actions.push('nested') },
      ] },
      CONTEXT_MENU_SEPARATOR,
      { label: 'Run directly', onSelect: () => actions.push('direct') },
    ]} onClose={() => closes.push('close')} />)

    const parent = document.querySelector<HTMLElement>('[role="menu"][aria-label="Actions"]')!
    expect(document.activeElement).toBe(parent)
    expect(parent.querySelector('[role="menuitem"][data-highlighted]')?.textContent).toContain('More')
    await key(parent, 'ArrowRight')
    const submenu = document.querySelector<HTMLElement>('[role="menu"][aria-label="More"]')!
    expect(document.activeElement).toBe(submenu)
    expect(submenu.querySelector<HTMLButtonElement>('[aria-disabled="true"], button:disabled')?.disabled).toBe(true)

    await key(submenu, 'ArrowDown')
    expect(submenu.querySelector('[role="menuitem"][data-highlighted]')?.textContent).toContain('Run nested')
    await key(submenu, 'Escape')
    expect(document.activeElement).toBe(parent)
    expect(actions).toEqual([])
    expect(closes).toEqual([])
    await key(parent, 'ArrowDown')
    expect(parent.querySelector('[role="menuitem"][data-highlighted]')?.textContent).toContain('Run directly')
    await key(parent, 'ArrowUp')
    expect(parent.querySelector('[role="menuitem"][data-highlighted]')?.textContent).toContain('More')

    await key(parent, 'ArrowRight')
    const reopened = document.querySelector<HTMLElement>('[role="menu"][aria-label="More"]')!
    await key(reopened, 'ArrowDown')
    await key(reopened, 'Enter')
    expect(actions).toEqual(['nested'])
    expect(closes).toEqual(['close'])
  })

  test('composing Enter in the menu search field does not choose its highlighted row', async () => {
    const actions: string[] = []
    const closes: string[] = []
    await render(<ContextMenu
      label="Search actions"
      x={0}
      y={0}
      highlightFirst
      header={<input autoFocus aria-label="Search actions" />}
      items={[{ label: 'Run', onSelect: () => actions.push('run') }]}
      onClose={() => closes.push('close')}
    />)

    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search actions"]')!
    expect(document.activeElement).toBe(input)
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      Object.defineProperty(event, 'isComposing', { value: true })
      input.dispatchEvent(event)
    })
    expect(actions).toEqual([])
    expect(closes).toEqual([])
    expect(document.querySelector('[role="menu"]')).not.toBeNull()

    await key(input, 'Enter')
    expect(actions).toEqual(['run'])
    expect(closes).toEqual(['close'])
  })
  test('end-aligns the measured menu width to the requested right edge', async () => {
    await withMenuGeometry(640, 140, async () => {
      const anchor = await renderPositionedMenu({ x: 400, align: 'end' })
      expect(anchor.style.left).toBe('260px')
    })
  })

  test('clamps a left-overflowing end-aligned menu to the viewport', async () => {
    await withMenuGeometry(640, 140, async () => {
      const anchor = await renderPositionedMenu({ x: 80, align: 'end' })
      expect(anchor.style.left).toBe('0px')
    })
  })

  test('keeps start alignment as the default', async () => {
    await withMenuGeometry(640, 140, async () => {
      const anchor = await renderPositionedMenu({ x: 200 })
      expect(anchor.style.left).toBe('200px')
    })
  })

})
