import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ActivityMark,
  BulkBar,
  Checkbox,
  HoverCard,
  NoticeLine,
  SwatchGroup,
  TagChip,
  TagChips,
} from '../src/design-system'
import { fitTagChipCount } from '../src/design-system/worktree-primitives'
import type { UiActivityMarkState, UiTagColor } from '../src/design-system/contracts'

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

const hues: UiTagColor[] = ['blue', 'violet', 'teal', 'coral', 'magenta', 'mint', 'sand', 'rose']

describe('ActivityMark', () => {
  const states: UiActivityMarkState[] = ['running', 'waiting', 'error', 'idle', 'asleep']

  test('is an image named by its label with a distinct class per state', async () => {
    const seen = new Set<string>()
    for (const state of states) {
      await render(h(ActivityMark, { state, label: `Agent ${state}` }))
      const mark = container.querySelector('[role="img"]')!
      expect(mark.getAttribute('aria-label')).toBe(`Agent ${state}`)
      expect(mark.getAttribute('data-state')).toBe(state)
      seen.add(mark.className)
    }
    expect(seen.size).toBe(states.length)
  })
  test('supports optional ring tones and leaves the unringed mark unchanged', async () => {
    for (const ring of ['accent', 'needs-you'] as const) {
      await render(h(ActivityMark, { state: 'running', label: 'Agent running', ring }))
      expect(container.querySelector('.ui-activity-mark')?.getAttribute('data-ring')).toBe(ring)
    }

    await render(h(ActivityMark, { state: 'running', label: 'Agent running' }))
    const mark = container.querySelector('.ui-activity-mark')!
    expect(mark.hasAttribute('data-ring')).toBe(false)
    expect(mark.className).toBe('ui-activity-mark ui-activity-mark--running')
  })

  test('sets a title only when provided', async () => {
    await render(h(ActivityMark, { state: 'running', label: 'Agent running', title: 'x' }))
    expect(container.querySelector('.ui-activity-mark')?.getAttribute('title')).toBe('x')

    await render(h(ActivityMark, { state: 'running', label: 'Agent running' }))
    expect(container.querySelector('.ui-activity-mark')?.hasAttribute('title')).toBe(false)
  })
})

describe('TagChip', () => {
  test('shows the name and exposes the hue, grey when null', async () => {
    await render(h('div', null, h(TagChip, { name: 'Release', color: 'violet' }), h(TagChip, { name: 'Misc', color: null })))
    const [violet, grey] = [...container.querySelectorAll('.ui-tag-chip')]
    expect(violet!.textContent).toBe('Release')
    expect(violet!.getAttribute('data-color')).toBe('violet')
    expect(grey!.getAttribute('data-color')).toBe('grey')
  })
})

describe('TagChips', () => {
  const tags = ['one', 'two', 'three', 'four'].map((name, i) => ({ id: `t${i}`, name, color: null }))

  test('renders max whole chips and a +N remainder, defaulting to two', async () => {
    await render(h(TagChips, { tags }))
    expect([...container.querySelectorAll('.ui-tag-chip')].map((chip) => chip.textContent)).toEqual(['one', 'two'])
    const more = container.querySelector('.ui-tag-chips__more')!
    expect(more.textContent).toBe('+2')
    expect(more.getAttribute('aria-label')).toBe('2 more tags')
  })

  test('shows every chip and no remainder when they all fit', async () => {
    await render(h(TagChips, { tags, max: 4 }))
    expect(container.querySelectorAll('.ui-tag-chip').length).toBe(4)
    expect(container.querySelector('.ui-tag-chips__more')).toBeNull()
  })

  test('renders nothing for no tags', async () => {
    await render(h(TagChips, { tags: [] }))
    expect(container.querySelector('.ui-tag-chips')).toBeNull()
  })

  test('chips never truncate mid-word', () => {
    const css = readFileSync(new URL('../src/design-system/worktree-primitives.css', import.meta.url), 'utf8')
    const chip = /\.ui-tag-chip\s*\{[^}]*\}/.exec(css)![0]
    expect(chip).toContain('white-space: nowrap')
    expect(chip).not.toContain('text-overflow')
    expect(chip).not.toContain('overflow')
  })
})

describe('fitTagChipCount', () => {
  test('keeps the longest prefix of whole chips that fits beside the +N', () => {
    expect(fitTagChipCount([30, 30, 50, 40], 4, 20, 120, 0)).toBe(2)
    expect(fitTagChipCount([30, 30], 2, 20, 60, 0)).toBe(2)
  })

  test('counts the gap between items, including the one before +N', () => {
    expect(fitTagChipCount([30, 30], 3, 20, 100, 10)).toBe(2)
    expect(fitTagChipCount([30, 30], 3, 20, 99, 10)).toBe(1)
  })

  test('returns 0 when no whole chip fits, leaving only the +N', () => {
    expect(fitTagChipCount([30, 30], 2, 20, 40, 4)).toBe(0)
    expect(fitTagChipCount([30], 1, 20, -5, 0)).toBe(0)
  })

  test('a chip that fits alone still yields to the +N that tags beyond max need', () => {
    expect(fitTagChipCount([30], 3, 20, 40, 4)).toBe(0)
  })
})

describe('TagChips fitting', () => {
  const widthOf = (element: HTMLElement) => {
    if (element.classList.contains('ui-tag-chip')) return (element.textContent ?? '').length * 10
    if (element.classList.contains('ui-tag-chips__probe-more')) return 20
    return 0
  }
  let rowWidth = 200

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return widthOf(this) } })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('row') ? rowWidth : 0 }
    })
  })

  afterEach(() => {
    delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  })

  const tags = ['one', 'two', 'three', 'four'].map((name, i) => ({ id: `t${i}`, name, color: null }))
  const row = () => h('div', { className: 'row' }, h('span', { className: 'ui-name-share' }, 'name'), h(TagChips, { tags, max: 4, nameShare: 0.4 }))
  const visibleChips = () => [...container.querySelectorAll('.ui-tag-chips > .ui-tag-chip')].map((chip) => chip.textContent)

  test('shows only the chips that fit beside the name and counts the rest', async () => {
    rowWidth = 200
    await render(row())
    expect(visibleChips()).toEqual(['one', 'two'])
    expect(container.querySelector('.ui-tag-chips__more')!.textContent).toBe('+2')
  })

  test('a crowded row shows no chip and a +N for all of them', async () => {
    rowWidth = 60
    await render(row())
    expect(visibleChips()).toEqual([])
    expect(container.querySelector('.ui-tag-chips__more')!.textContent).toBe('+4')
  })

  test('a wide row shows every chip and no +N', async () => {
    rowWidth = 600
    await render(row())
    expect(visibleChips()).toEqual(['one', 'two', 'three', 'four'])
    expect(container.querySelector('.ui-tag-chips__more')).toBeNull()
  })

  test('chips kept off screen for measuring are hidden from assistive tech', async () => {
    rowWidth = 60
    await render(row())
    expect(container.querySelector('.ui-tag-chips__probes')!.getAttribute('aria-hidden')).toBe('true')
  })

  test('without a name to protect, the first max chips show whatever the width', async () => {
    rowWidth = 60
    await render(h('div', { className: 'row' }, h(TagChips, { tags, max: 3, nameShare: 0.4 })))
    expect(visibleChips()).toEqual(['one', 'two', 'three'])
  })
})

describe('Checkbox', () => {
  test('reports the toggled value and names the input by its label', async () => {
    const seen: boolean[] = []
    await render(h(Checkbox, { checked: false, label: 'Select feat/a', onChange: (value: boolean) => seen.push(value) }))
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(container.querySelector('label')!.textContent).toBe('Select feat/a')
    await click(input)
    expect(seen).toEqual([true])
  })

  test('indeterminate is mixed to assistive tech and a click selects', async () => {
    const seen: boolean[] = []
    await render(h(Checkbox, { checked: false, indeterminate: true, label: 'Select all', onChange: (value: boolean) => seen.push(value) }))
    const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(input.getAttribute('aria-checked')).toBe('mixed')
    expect(input.indeterminate).toBe(true)
    await click(input)
    expect(seen).toEqual([true])
  })

  test('hideLabel keeps an accessible name without visible text', async () => {
    await render(h(Checkbox, { checked: true, label: 'Select feat/a', hideLabel: true, onChange: () => undefined }))
    const input = container.querySelector<HTMLInputElement>('input')!
    expect(input.getAttribute('aria-checked')).toBe('true')
    expect(input.getAttribute('aria-label')).toBe('Select feat/a')
    expect(container.querySelector('.ui-checkbox__text')).toBeNull()
  })
  test('needs-you tone marks the label and keeps the checked value', async () => {
    await render(h(Checkbox, { checked: true, label: 'Message people', onChange: () => undefined, tone: 'needs-you' }))
    const label = container.querySelector('label')!
    expect(label.classList.contains('ui-checkbox--needs-you')).toBe(true)
    expect(container.querySelector<HTMLInputElement>('input')!.checked).toBe(true)

    await render(h(Checkbox, { checked: true, label: 'Message people', onChange: () => undefined }))
    expect(container.querySelector('label')!.classList.contains('ui-checkbox--needs-you')).toBe(false)
  })

  test('uses an accessible name without replacing the visible label', async () => {
    await render(h(Checkbox, {
      checked: false,
      label: 'Message people',
      accessibleName: 'Message people (fix-desktop)',
      onChange: () => undefined
    }))
    expect(container.querySelector('input')!.getAttribute('aria-label')).toBe('Message people (fix-desktop)')
    expect(container.querySelector('.ui-checkbox__text')?.textContent).toBe('Message people')
  })

  test('uses the label or accessibleName as the hidden label checkbox name', async () => {
    await render(h(Checkbox, { checked: true, label: 'Select row', hideLabel: true, onChange: () => undefined }))
    expect(container.querySelector('input')!.getAttribute('aria-label')).toBe('Select row')

    await render(h(Checkbox, { checked: true, label: 'Select row', hideLabel: true, accessibleName: 'Select row (group)', onChange: () => undefined }))
    expect(container.querySelector('input')!.getAttribute('aria-label')).toBe('Select row (group)')
  })
})

describe('SwatchGroup', () => {
  const mount = async (value: UiTagColor | null) => {
    const seen: Array<UiTagColor | null> = []
    await render(h(SwatchGroup, { value, label: 'Tag color', onChange: (color: UiTagColor | null) => seen.push(color) }))
    return seen
  }
  const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')]

  test('is a labelled radiogroup of the eight hues plus grey with one tab stop', async () => {
    await mount('teal')
    const group = container.querySelector('[role="radiogroup"]')!
    expect(group.getAttribute('aria-label')).toBe('Tag color')
    expect(radios().map((radio) => radio.getAttribute('data-color'))).toEqual([...hues, 'grey'])
    expect(radios().filter((radio) => radio.getAttribute('aria-checked') === 'true').map((radio) => radio.getAttribute('data-color'))).toEqual(['teal'])
    expect(radios().filter((radio) => radio.tabIndex === 0).length).toBe(1)
    expect(radios().find((radio) => radio.tabIndex === 0)!.getAttribute('data-color')).toBe('teal')
  })

  test('null value checks grey', async () => {
    await mount(null)
    expect(radios().find((radio) => radio.getAttribute('aria-checked') === 'true')!.getAttribute('data-color')).toBe('grey')
  })

  test('arrow keys move selection and wrap, home and end jump', async () => {
    const seen = await mount('blue')
    await key(radios()[0]!, 'ArrowRight')
    await key(radios()[0]!, 'ArrowLeft')
    await key(radios()[0]!, 'End')
    await key(radios()[0]!, 'Home')
    expect(seen).toEqual(['violet', null, null, 'blue'])
  })

  test('clicking a swatch selects it', async () => {
    const seen = await mount(null)
    await click(radios()[3]!)
    expect(seen).toEqual(['coral'])
  })

  test('focus ring is two pixels wide', () => {
    const css = readFileSync(new URL('../src/design-system/worktree-primitives.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.ui-swatch:focus-visible\s*\{[^}]*var\(--ui-focus-width\)/)
  })
})

describe('NoticeLine', () => {
  test('is one line of text with link-style actions', async () => {
    const calls: string[] = []
    await render(h(NoticeLine, {
      children: 'View changed',
      actions: [{ label: 'Save', onAction: () => calls.push('save') }, { label: 'Revert', onAction: () => calls.push('revert') }],
    }))
    const line = container.querySelector('.ui-notice-line')!
    expect(line.textContent).toContain('View changed')
    const buttons = [...line.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Save', 'Revert'])
    expect(buttons.every((button) => button.type === 'button')).toBe(true)
    await click(buttons[1]!)
    expect(calls).toEqual(['revert'])
  })

  test('renders without actions', async () => {
    await render(h(NoticeLine, { children: 'Hidden: 3 asleep' }))
    expect(container.querySelectorAll('button').length).toBe(0)
  })
})

describe('HoverCard', () => {
  const anchor = () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    return button
  }

  test('renders nothing while closed', async () => {
    await render(h(HoverCard, { anchor: anchor(), open: false, children: 'Details' }))
    expect(document.querySelector('.ui-hover-card')).toBeNull()
  })

  test('renders a non-modal tooltip region and leaves focus where it was', async () => {
    const target = anchor()
    target.focus()
    await render(h(HoverCard, { anchor: target, open: true, children: 'Details' }))
    const card = document.querySelector<HTMLElement>('.ui-hover-card')!
    expect(card.getAttribute('role')).toBe('tooltip')
    expect(card.textContent).toBe('Details')
    expect(card.hasAttribute('tabindex')).toBe(false)
    expect(document.activeElement).toBe(target)
  })

  test('renders nothing without an anchor', async () => {
    await render(h(HoverCard, { anchor: null, open: true, children: 'Details' }))
    expect(document.querySelector('.ui-hover-card')).toBeNull()
  })
})

describe('BulkBar', () => {
  test('shows the count, runs actions and clears', async () => {
    const calls: string[] = []
    await render(h(BulkBar, {
      count: 3,
      actions: [{ label: 'Tag', onAction: () => calls.push('tag') }, { label: 'Archive', onAction: () => calls.push('archive') }],
      onClear: () => calls.push('clear'),
    }))
    const bar = container.querySelector('.ui-bulk-bar')!
    expect(bar.getAttribute('role')).toBe('region')
    expect(bar.textContent).toContain('3 selected')
    const buttons = [...bar.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Tag', 'Archive', 'Clear'])
    await click(buttons[1]!)
    await click(buttons[2]!)
    expect(calls).toEqual(['archive', 'clear'])
  })

  test('does not handle Escape itself', async () => {
    const calls: string[] = []
    await render(h(BulkBar, { count: 1, actions: [], onClear: () => calls.push('clear') }))
    await key(container.querySelector('.ui-bulk-bar')!, 'Escape')
    expect(calls).toEqual([])
  })
})

describe('worktree-primitives.css', () => {
  const css = readFileSync(new URL('../src/design-system/worktree-primitives.css', import.meta.url), 'utf8')

  test('animates only the running mark and stops it under reduced motion', () => {
    expect(css).toMatch(/animation:[^;]*1s linear infinite/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/)
    expect(css).not.toContain('transition: all')
  })

  test('uses a hue token for every tag color', () => {
    for (const hue of hues) expect(css).toContain(`var(--ui-hue-${hue})`)
  })
})
