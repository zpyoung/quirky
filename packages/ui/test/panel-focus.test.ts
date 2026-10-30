import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

type Tracker = typeof import('../src/shell/panel-focus')
let focus: Tracker

beforeAll(async () => {
  GlobalRegistrator.register()
  focus = await import('../src/shell/panel-focus')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

let stop: (() => void) | null = null

beforeEach(() => {
  document.body.innerHTML = `
    <div class="shell-workspace">
      <section data-tool-panel="worktrees"><button id="a-button">a</button><p id="a-text">text</p></section>
      <section data-tool-panel="changes"><button id="b-button">b</button></section>
      <div class="shell-main-region"><div id="center-child" tabindex="0">center</div></div>
      <footer id="outside"><button id="outside-button">out</button></footer>
    </div>`
})

afterEach(() => {
  stop?.()
  stop = null
  document.body.innerHTML = ''
})

const focused = () => [...document.querySelectorAll(`[${focus.PANEL_FOCUS_ATTRIBUTE}]`)]
const pointerdown = (selector: string) =>
  document.querySelector(selector)!.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }))
const focusin = (selector: string) =>
  document.querySelector(selector)!.dispatchEvent(new Event('focusin', { bubbles: true }))

test('pointerdown and focusin move the attribute between panels and the center card, one holder at a time', () => {
  stop = focus.trackPanelFocus(document)
  expect(focused()).toHaveLength(0)

  pointerdown('#a-text')
  expect(focused().map((element) => element.getAttribute('data-tool-panel'))).toEqual(['worktrees'])

  focusin('#center-child')
  expect(focused()).toHaveLength(1)
  expect(focused()[0]!.classList.contains('shell-main-region')).toBe(true)

  focusin('#b-button')
  expect(focused().map((element) => element.getAttribute('data-tool-panel'))).toEqual(['changes'])

  pointerdown('#center-child')
  expect(focused()).toHaveLength(1)
  expect(focused()[0]!.classList.contains('shell-main-region')).toBe(true)
})

test('the attribute is set when the press happens, before any later phase can stop the event', () => {
  stop = focus.trackPanelFocus(document)
  document.querySelector('#a-button')!.addEventListener('pointerdown', (event) => event.stopPropagation())
  pointerdown('#a-button')
  expect(focused()).toHaveLength(1)
})

test('a press outside every panel and the center card leaves the attribute where it was', () => {
  stop = focus.trackPanelFocus(document)
  pointerdown('#b-button')
  pointerdown('#outside-button')
  focusin('#outside-button')
  expect(focused().map((element) => element.getAttribute('data-tool-panel'))).toEqual(['changes'])
})

test('an unmounted holder is not remembered, and the next focus leaves exactly one holder', () => {
  const tracker = focus.createPanelFocusTracker(document)
  stop = tracker.dispose
  pointerdown('#a-button')
  const dead = tracker.current()
  expect(dead?.getAttribute('data-tool-panel')).toBe('worktrees')

  dead!.remove()
  expect(tracker.current()).toBeNull()
  expect(focused()).toHaveLength(0)

  pointerdown('#b-button')
  expect(tracker.current()?.getAttribute('data-tool-panel')).toBe('changes')
  expect(focused()).toHaveLength(1)
})

test('an element already holding focus when tracking starts is marked', () => {
  const button = document.querySelector<HTMLButtonElement>('#b-button')!
  button.focus()
  stop = focus.trackPanelFocus(document)
  expect(focused().map((element) => element.getAttribute('data-tool-panel'))).toEqual(['changes'])
})

test('disposing stops tracking and removes the attribute', () => {
  const dispose = focus.trackPanelFocus(document)
  pointerdown('#a-button')
  dispose()
  expect(focused()).toHaveLength(0)
  pointerdown('#b-button')
  expect(focused()).toHaveLength(0)
})
