import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AffixInput, DisclosureButton, Dialog, Kbd, LinkButton, ReachMeter, SegmentedControl, TagButton, type ChoiceOption } from '../src/design-system'

const OPTIONS: ChoiceOption[] = [
  { value: 'a', label: 'Alpha', title: 'First' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
  { value: 'd', label: 'Delta', caution: true, title: 'Widest' }
]

let root: Root
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
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

const render = (node: Parameters<Root['render']>[0]) => act(async () => root.render(node))
const radios = () => [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
const checked = () => radios().find((radio) => radio.getAttribute('aria-checked') === 'true')?.textContent
const press = (element: Element, key: string) => act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })

function Meter({ initial = 'b', onPick }: { initial?: string; onPick?: (value: string) => void }) {
  const [value, setValue] = useState(initial)
  return h(ReachMeter, { label: 'Reach', options: OPTIONS, value, onChange: (next: string) => { setValue(next); onPick?.(next) } })
}

describe('ReachMeter', () => {
  test('is a radiogroup that fills segments up to the value and marks the current one', async () => {
    await render(h(Meter))
    expect(container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Reach')
    expect(checked()).toBe('Beta')
    expect([...container.querySelectorAll('.ui-reach-meter__segment--in')].map((node) => node.textContent)).toEqual(['Alpha', 'Beta'])
    expect(container.querySelector('.ui-reach-meter__segment--current')?.textContent).toBe('Beta')
    expect(radios().map((radio) => radio.title)).toEqual(['First', '', '', 'Widest'])
    expect(container.querySelector('.ui-reach-meter__segment--caution')?.textContent).toBe('Delta')
  })

  test('keeps one tab stop on the current segment', async () => {
    await render(h(Meter))
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1])
  })

  test('selects on click and on arrow, Home and End keys, wrapping at the ends, and moves focus with it', async () => {
    const picks: string[] = []
    await render(h(Meter, { onPick: (value: string) => picks.push(value) }))
    await act(async () => radios()[1].focus())
    await press(radios()[1], 'ArrowRight')
    expect(checked()).toBe('Gamma')
    expect(document.activeElement).toBe(radios()[2])
    await press(radios()[2], 'End')
    expect(checked()).toBe('Delta')
    await press(radios()[3], 'ArrowDown')
    expect(checked()).toBe('Alpha')
    await press(radios()[0], 'ArrowLeft')
    expect(checked()).toBe('Delta')
    await press(radios()[3], 'Home')
    expect(checked()).toBe('Alpha')
    await act(async () => radios()[2].click())
    expect(checked()).toBe('Gamma')
    expect(picks).toEqual(['c', 'd', 'a', 'd', 'a', 'c'])
  })

  test('ignores other keys', async () => {
    await render(h(Meter))
    await press(radios()[1], 'a')
    expect(checked()).toBe('Beta')
  })

  test('makes the first segment the tab stop when the value matches none', async () => {
    await render(h(ReachMeter, { label: 'Reach', options: OPTIONS, value: 'zzz', onChange: () => {} }))
    expect(checked()).toBeUndefined()
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1])
  })
})

describe('SegmentedControl', () => {
  test('shows no choice when value is null and picks on click', async () => {
    const picks: string[] = []
    await render(h(SegmentedControl, { label: 'Pick', options: OPTIONS, value: null, onChange: (value: string) => picks.push(value) }))
    expect(checked()).toBeUndefined()
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1])
    await act(async () => radios()[3].click())
    expect(picks).toEqual(['d'])
    expect(container.querySelector('.ui-segmented__option--caution')?.textContent).toBe('Delta')
  })

  test('arrow keys move focus without choosing, so a confirm-gated option is not triggered in passing', async () => {
    const picks: string[] = []
    await render(h(SegmentedControl, { label: 'Pick', options: OPTIONS, value: 'a', onChange: (value: string) => picks.push(value) }))
    await act(async () => radios()[0].focus())
    await press(radios()[0], 'ArrowLeft')
    expect(document.activeElement).toBe(radios()[3])
    await press(radios()[3], 'ArrowRight')
    expect(document.activeElement).toBe(radios()[0])
    expect(picks).toEqual([])
    expect(checked()).toBe('Alpha')
  })
})


describe('AffixInput', () => {
  test('renders a decorative prefix, the input and a suffix control inside one field', async () => {
    await render(h(AffixInput, { prefixText: 'Done when', 'aria-label': 'Check', mono: true, defaultValue: 'x', suffix: h(TagButton, null, 'runs it') }))
    const field = container.querySelector('.ui-affix-input')!
    expect(field.className).toContain('ui-affix-input--mono')
    expect(field.querySelector('.ui-affix-input__prefix')?.getAttribute('aria-hidden')).toBe('true')
    expect(field.querySelector('input')?.getAttribute('aria-label')).toBe('Check')
    expect(field.querySelector('.ui-affix-input__suffix button')?.textContent).toBe('runs it')
  })

  test('works without a prefix or suffix', async () => {
    await render(h(AffixInput, { 'aria-label': 'Plain' }))
    expect(container.querySelector('.ui-affix-input__prefix')).toBeNull()
    expect(container.querySelector('.ui-affix-input__suffix')).toBeNull()
  })
})

describe('small controls', () => {
  test('LinkButton and TagButton are type=button and carry their tone and handlers', async () => {
    let clicks = 0
    await render(h('div', null, h(LinkButton, { tone: 'failing', onClick: () => { clicks += 1 } }, 'Go to it'), h(TagButton, { onClick: () => { clicks += 1 } }, 'judges it')))
    const [link, tag] = [...container.querySelectorAll('button')]
    expect(link.type).toBe('button')
    expect(link.className).toContain('ui-link-button--failing')
    expect(tag.className).toContain('ui-tag-button')
    await act(async () => { link.click(); tag.click() })
    expect(clicks).toBe(2)
  })

  test('DisclosureButton exposes its label and expanded state', async () => {
    await render(h(DisclosureButton, { label: 'Show details for x', expanded: false }))
    const button = container.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('Show details for x')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    await render(h(DisclosureButton, { label: 'Hide details for x', expanded: true }))
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('button')!.className).toContain('ui-disclosure-button--open')
  })

  test('Kbd renders a kbd element', async () => {
    await render(h(Kbd, null, '⌘ ↵'))
    expect(container.querySelector('kbd.ui-kbd')?.textContent).toBe('⌘ ↵')
  })
})

describe('Dialog extra-wide size and description', () => {
  test('xwide gets its own class and the description labels the dialog', async () => {
    await render(h(Dialog, { open: true, title: 'Sheet', size: 'xwide', description: 'Why this exists', children: 'body' }))
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.className).toContain('ui-dialog--xwide')
    expect(dialog.className).not.toContain('ui-dialog--wide')
    const description = container.querySelector('.ui-dialog__description')!
    expect(description.textContent).toBe('Why this exists')
    expect(dialog.getAttribute('aria-describedby')).toBe(description.id)
  })

  test('without a description the header and aria stay as before', async () => {
    await render(h(Dialog, { open: true, title: 'Plain', size: 'wide', children: 'body' }))
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.getAttribute('aria-describedby')).toBeNull()
    expect(container.querySelector('.ui-dialog__heading')).toBeNull()
    expect(dialog.className).toContain('ui-dialog--wide')
  })
})
