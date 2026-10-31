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
    expect(q(rowItem(element, 'notes.txt'), '[aria-label="Git status untracked"]')?.textContent).toBe('U')
    unmount()
  })

  test('clicking a row marks it selected, so the opened file shows in the list', async () => {
    const { element, unmount } = await open()
    const main = q(rowItem(element, 'src/math.ts'), '.ui-list-row__main') as HTMLElement
    expect(q(rowItem(element, 'src/math.ts'), '.ui-list-row--selected')).toBeNull()
    await act(async () => { main.click() })
    await settle()
    expect(q(rowItem(element, 'src/math.ts'), '.ui-list-row--selected')).not.toBeNull()
    expect(q(rowItem(element, 'notes.txt'), '.ui-list-row--selected')).toBeNull()
    unmount()
  })

  test('line counts and actions stay in the DOM with their labels, inside the hover reveal', async () => {
    const { element, unmount } = await open()
    const row = rowItem(element, 'src/math.ts')
    const reveal = q(row, '.git-row__reveal')!
    expect(q(reveal, '[aria-label="5 additions"]')?.textContent).toBe('+5')
    expect(byLabel(reveal, 'Stage src/math.ts')).not.toBeNull()
    expect(byLabel(reveal, 'Discard changes src/math.ts')).not.toBeNull()
    expect(q(row, '.git-row__status')?.closest('.git-row__reveal')).toBeNull()
    unmount()
  })

  test('the actions still work', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Stage src/math.ts'))
    expect(fake.called('quirky.git/stage')).toHaveLength(1)
    unmount()
  })

  test('section header actions sit in a reveal and keep their labels', async () => {
    const { element, unmount } = await open()
    const header = q(element, '[data-section="unstaged"] .ui-section-header')!
    expect(qa(header, '[data-section-action]').length).toBeGreaterThan(0)
    expect(byLabel(header, 'Discard all')?.closest('.git-section__reveal')).not.toBeNull()
    expect(byLabel(header, 'Collapse Changes')?.closest('.git-section__reveal') ?? null).toBeNull()
    expect(q(header, '[data-section-count]')).not.toBeNull()
    unmount()
  })
})

describe('git-rows.css', () => {
  const css = readFileSync(STYLESHEET, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selectors: selector!.split(',').map((part) => part.trim()),
    body: body!.replace(/\s+/g, ' ').trim()
  }))

  test('hides with opacity 0 and reveals on hover and on focus within, never by display or visibility', () => {
    const hidden = rules.filter((rule) => /(^|;|\s)opacity: 0(;|$)/.test(rule.body))
    expect(hidden.length).toBeGreaterThan(0)
    const shown = rules.filter((rule) => /(^|;|\s)opacity: 1(;|$)/.test(rule.body)).flatMap((rule) => rule.selectors)
    expect(shown.some((selector) => selector.includes(':hover'))).toBe(true)
    expect(shown.some((selector) => selector.includes(':focus-within'))).toBe(true)
    expect(css).not.toMatch(/display:\s*none/)
    expect(css).not.toMatch(/visibility:\s*hidden/)
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
})
