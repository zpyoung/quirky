import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import { act } from 'react'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { byLabel, click, entry, fakeContext, layoutFor, mountPanel, q, qa, settle, statusOf } = s

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const STYLESHEET = new URL('../../../../packages/ui/src/design-system/git-rows.css', import.meta.url)

async function open() {
  const fake = fakeContext(layoutFor('feat'))
  fake.status = statusOf([
    entry('src/math.ts', 'unstaged', 'modified', { added: 5 }),
    entry('notes.txt', 'untracked', 'untracked'),
    entry('gone.md', 'unstaged', 'deleted')
  ])
  const mounted = mountPanel(fake)
  await settle()
  return { fake, ...mounted }
}

const rowItem = (root: ParentNode, path: string) => q(root, `[data-row-path="${path}"]`)!

describe('Changes rows are quiet', () => {
  test('a row draws a file icon and one status letter that keeps its label', async () => {
    const { element, unmount } = await open()
    const row = rowItem(element, 'src/math.ts')
    expect(q(row, 'svg.ui-file-icon')?.getAttribute('data-icon')).toBeTruthy()
    expect(q(row, '.ui-status-dot')).toBeNull()
    const letter = q(row, '[aria-label="Git status modified"]')!
    expect(letter.textContent).toBe('M')
    expect(letter.classList.contains('ui-badge')).toBe(false)
    expect(q(rowItem(element, 'gone.md'), '[aria-label="Git status deleted"]')?.textContent).toBe('D')
    expect(q(rowItem(element, 'notes.txt'), '[aria-label="Git status added"]')?.textContent).toBe('A')
    unmount()
  })

  test('clicking a row marks it selected, so the opened file shows in the list', async () => {
    const { element, unmount } = await open()
    const row = rowItem(element, 'src/math.ts')
    expect(q(row, '.ui-list-row--selected')).toBeNull()
    expect(row.getAttribute('aria-selected')).toBe('false')
    await act(async () => { row.click() })
    await settle()
    expect(q(row, '.ui-list-row--selected')).not.toBeNull()
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(q(rowItem(element, 'notes.txt'), '.ui-list-row--selected')).toBeNull()
    unmount()
  })

  test('selecting another row moves the highlight, so one row at a time looks selected', async () => {
    const { element, unmount } = await open()
    const selectedPaths = () => qa(element, '[data-row-path]')
      .filter((row) => q(row, '.ui-list-row--selected') !== null)
      .map((row) => row.getAttribute('data-row-path'))
    await act(async () => { rowItem(element, 'src/math.ts').click() })
    await settle()
    expect(selectedPaths()).toEqual(['src/math.ts'])
    await act(async () => { rowItem(element, 'notes.txt').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
    await settle()
    expect(selectedPaths()).toEqual(['notes.txt'])
    unmount()
  })

  test('line counts are always in the row and actions only on the selected row, outside any hover reveal', async () => {
    const { element, unmount } = await open()
    const row = rowItem(element, 'src/math.ts')
    expect(q(row, '[aria-label="5 additions"]')?.textContent).toBe('+5')
    expect(q(row, '.git-row__actions')).toBeNull()
    await click(row)
    const actions = q(row, '.git-row__actions')!
    expect(byLabel(actions, 'Revert src/math.ts')).not.toBeNull()
    expect(byLabel(actions, 'Open src/math.ts')).not.toBeNull()
    expect(q(row, '.git-row__reveal')).toBeNull()
    expect(q(row, '.git-row__status')?.closest('.git-row__actions')).toBeNull()
    unmount()
  })

  test('the actions still work', async () => {
    const { fake, element, unmount } = await open()
    await click(rowItem(element, 'src/math.ts'))
    await click(byLabel(element, 'Open src/math.ts'))
    expect(fake.called('quirky.editor/open')).toHaveLength(1)
    await click(byLabel(element, 'Revert src/math.ts'))
    expect(q(document.body, '[role="dialog"]')).not.toBeNull()
    unmount()
  })

  test('the row actions leave the single tab stop alone', async () => {
    const { element, unmount } = await open()
    await click(rowItem(element, 'src/math.ts'))
    expect(qa(element, '.git-row__actions button').every((button) => button.tabIndex === -1)).toBe(true)
    unmount()
  })
})

describe('git-rows.css', () => {
  const css = readFileSync(STYLESHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector!.split(',').map((part) => part.trim()),
    body: body!.replace(/\s+/g, ' ').trim()
  }))

  const displayOf = (body: string) => /(^|;|\s)display:\s*([\w-]+)/.exec(body)?.[2]
  const hidesByDisplayOrVisibility = (body: string) => displayOf(body) === 'none' || /visibility:\s*hidden/.test(body)

  test('nothing reveals on hover: no reveal rule and no hover rule on the row actions', () => {
    expect(rules.filter((rule) => rule.selectors.some((selector) => /__reveal\b/.test(selector)))).toEqual([])
    expect(rules.filter((rule) => rule.selectors.some((selector) => selector.includes('.git-row:hover')))).toEqual([])
  })

  // the selected row is the only one with buttons, so nothing reveals on hover
  test('the row actions are display none except on a selected row, with no hover reveal and no other hiding rule', () => {
    const actions = rules.filter((rule) => rule.selectors.some((selector) => selector.includes('.git-row__actions')))
    const hiding = rules.filter((rule) => hidesByDisplayOrVisibility(rule.body))
    expect(hiding.map((rule) => rule.selectors)).toEqual([['.git-rows .git-row__actions']])
    expect(displayOf(hiding[0]!.body)).toBe('none')
    const shown = actions.filter((rule) => displayOf(rule.body) !== undefined && displayOf(rule.body) !== 'none')
    expect(shown.length).toBeGreaterThan(0)
    for (const rule of shown) for (const selector of rule.selectors) expect(selector).toContain('[aria-selected="true"]')
    for (const rule of actions) for (const selector of rule.selectors) expect(selector).not.toContain(':hover')
  })

  test('every selector is scoped under a git panel class', () => {
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) for (const selector of rule.selectors) expect(selector).toMatch(/\.git-(rows|section)\b|\[data-git-panel\]/)
  })

  test('a destructive button is filled red only on its own hover or focus', () => {
    const filled = rules.filter((rule) => /background: var\(--ui-failing\)/.test(rule.body)).flatMap((rule) => rule.selectors)
    expect(filled.length).toBeGreaterThan(0)
    for (const selector of filled) expect(selector).toMatch(/:(hover|focus-visible)/)
  })

  test('the row end keeps its controls on one line', () => {
    const end = rules.find((rule) => rule.selectors.includes('.git-rows .git-row__end'))
    expect(end?.body).toContain('flex-wrap: nowrap')
  })
})
