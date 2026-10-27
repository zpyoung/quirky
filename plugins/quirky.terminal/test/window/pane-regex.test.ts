import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { isSafeRegex } from '../../src/window/pane/regexSafety'
import { fakeContext, loadPane, mountPane, paneHandlers, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'

describe('isSafeRegex', () => {
  const unsafe = ['(a+)+$', '(a*)*b', '(a+)*', '(\\w+\\s?)+$', '(.*a){20}', '(a|aa)+$', '(a|a)*', '(\\d+|\\w+)*x', '([a-z]+)+@', '(?:a+)+', '(x+x+)+y', '.*.*.*.*.*x']
  const safe = ['^1.9$', 'foo|bar', 'error:? \\d+', '(foo|bar)+', '(\\d+\\.){3}\\d+', '[a-z]+@[a-z]+\\.com', '(ab?)+', '\\berror\\b.*failed', '(?:abc){2,3}', '^\\s*$', 'a{2,5}', '(', '[', '\\']

  for (const pattern of unsafe) test(`rejects ${pattern}`, () => expect(isSafeRegex(pattern)).toBe(false))
  for (const pattern of safe) test(`accepts ${pattern}`, () => expect(isSafeRegex(pattern)).toBe(true))

  test('judges alternatives that differ only in case as alike when the search ignores case', () => {
    expect(isSafeRegex('(a|A)+$', true)).toBe(true)
    expect(isSafeRegex('(a|A)+$', false)).toBe(false)
  })

  test('a quantifier-like brace that is not a quantifier is a literal', () => {
    expect(isSafeRegex('(x{)+')).toBe(true)
  })
})

let mounted: MountedPane | null = null

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

const status = (pane: MountedPane) => pane.element.querySelector('[data-pane-search-status]')!.textContent

describe('a catastrophic regex search', () => {
  test('returns at once without running the addon and says why', async () => {
    mounted = await mountPane(fakeContext(paneHandlers()))
    await new Promise<void>((resolve) => mounted!.term().write('a'.repeat(28) + '!', resolve))
    const { SearchAddon } = await import('@xterm/addon-search')
    const original = SearchAddon.prototype.findNext
    let calls = 0
    SearchAddon.prototype.findNext = function (this: InstanceType<typeof SearchAddon>, term, options) {
      if (term !== '') calls += 1
      return original.call(this, term, options)
    }
    try {
      const started = performance.now()
      await act(async () => mounted!.handle().search('(a+)+$', { regex: true }))
      await act(async () => mounted!.handle().searchNext())
      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      SearchAddon.prototype.findNext = original
    }
    expect(calls).toBe(0)
    expect(status(mounted)).toBe('Regex too complex')
    expect(mounted.lastReport().search).toMatchObject({ query: '(a+)+$', regex: true, current: 0, total: 0 })
  })

  test('the same text is searched as plain text when Regex is off', async () => {
    mounted = await mountPane(fakeContext(paneHandlers()))
    await new Promise<void>((resolve) => mounted!.term().write('x (a+)+$ y\r\n', resolve))
    await act(async () => mounted!.handle().search('(a+)+$'))
    expect(status(mounted)).toBe('1/1')
  })

  test('a safe regex still finds its matches', async () => {
    mounted = await mountPane(fakeContext(paneHandlers()))
    await new Promise<void>((resolve) => mounted!.term().write('one\r\ntwo\r\nthree\r\n', resolve))
    await act(async () => mounted!.handle().search('^t(wo|hree)$', { regex: true }))
    expect(status(mounted)).toBe('1/2')
  })
})
