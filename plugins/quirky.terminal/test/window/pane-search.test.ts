import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { RpcErrorCode } from '@quirky/protocol'
import { fakeContext, loadPane, mountPane, paneHandlers, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'

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

const seq = (to: number) => Array.from({ length: to }, (_, index) => `${index + 1}`).join('\r\n') + '\r\n'

async function mountWithOutput() {
  const fake = fakeContext(paneHandlers())
  mounted = await mountPane(fake)
  await fake.push(101, seq(200))
  await mounted.flush()
  return { fake, pane: mounted }
}

const status = (pane: MountedPane) => pane.element.querySelector('[data-pane-search-status]')!.textContent
const input = (pane: MountedPane) => pane.element.querySelector('input')!

/** Types into the box; happy-dom lacks the `oninput` support React checks, so its change plugin needs focus and a keyup. */
async function type(pane: MountedPane, value: string) {
  await act(async () => void input(pane).focus())
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(pane), value)
    input(pane).dispatchEvent(new Event('input', { bubbles: true }))
    input(pane).dispatchEvent(new Event('keyup', { bubbles: true }))
  })
}

async function press(target: Element, init: KeyboardEventInit) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
}

const toggle = (pane: MountedPane, title: string) => pane.element.querySelector(`button[title="${title}"]`) as HTMLButtonElement

describe('the search box', () => {
  test('SC-42: opens empty with 0/0 and focuses its field', async () => {
    const { pane } = await mountWithOutput()
    expect(pane.element.querySelector('input')).toBeNull()
    await act(async () => pane.handle().search())
    expect(status(pane)).toBe('0/0')
    expect(document.activeElement).toBe(input(pane))
    expect(pane.lastReport().search).toEqual({ query: '', regex: false, caseSensitive: false, current: 0, total: 0, more: false })
  })

  test('SC-42: typing 19 finds 12 matches and Enter steps forward, Shift+Enter wraps backwards', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    await type(pane, '19')
    expect(status(pane)).toBe('1/12')
    await press(input(pane), { key: 'Enter' })
    expect(status(pane)).toBe('2/12')
    await press(input(pane), { key: 'Enter' })
    expect(status(pane)).toBe('3/12')
    await press(input(pane), { key: 'Enter', shiftKey: true })
    await press(input(pane), { key: 'Enter', shiftKey: true })
    expect(status(pane)).toBe('1/12')
    await press(input(pane), { key: 'Enter', shiftKey: true })
    expect(status(pane)).toBe('12/12')
    expect(pane.lastReport().search).toMatchObject({ query: '19', current: 12, total: 12, more: false })
  })

  test('SC-42: Regex turns ^1.9$ into 10 matches and a miss reads No results', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    await type(pane, '^1.9$')
    expect(status(pane)).toBe('No results')
    await act(async () => void toggle(pane, 'Regex').click())
    expect(status(pane)).toBe('1/10')
    expect(toggle(pane, 'Regex').getAttribute('aria-pressed')).toBe('true')
    await type(pane, 'zzz')
    expect(status(pane)).toBe('No results')
  })

  test('Case sensitive narrows the matches', async () => {
    const fake = fakeContext(paneHandlers())
    mounted = await mountPane(fake)
    await fake.push(101, 'Abc\r\nabc\r\nABC\r\n')
    await mounted.flush()
    await act(async () => mounted!.handle().search())
    await type(mounted, 'abc')
    expect(status(mounted)).toBe('1/3')
    await act(async () => void toggle(mounted!, 'Case sensitive').click())
    expect(status(mounted)).toBe('1/1')
  })


  test('SC-42: Escape closes the box and clears the highlight', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search('19'))
    expect(status(pane)).toBe('1/12')
    await press(input(pane), { key: 'Escape' })
    expect(pane.element.querySelector('input')).toBeNull()
    expect(pane.lastReport().search).toBeNull()
    expect(pane.term().hasSelection()).toBe(false)
  })

  test('SC-42: Cmd+F with the box open focuses its field', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    pane.textarea().focus()
    expect(document.activeElement).toBe(pane.textarea())
    await act(async () => pane.handle().search())
    expect(document.activeElement).toBe(input(pane))
  })

  test('SC-73: Enter and Cmd+G in the box step the match', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    await type(pane, '19')
    await press(input(pane), { key: 'Enter' })
    expect(status(pane)).toBe('2/12')
    await press(input(pane), { key: 'g', metaKey: true })
    expect(status(pane)).toBe('3/12')
    await press(input(pane), { key: 'g', metaKey: true, shiftKey: true })
    expect(status(pane)).toBe('2/12')
  })

  test('keys typed in the box do not reach other listeners', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    let seen = 0
    document.addEventListener('keydown', () => void (seen += 1))
    await press(input(pane), { key: 'a' })
    expect(seen).toBe(0)
  })

  test('more matches than xterm highlights read as N+', async () => {
    const fake = fakeContext(paneHandlers())
    mounted = await mountPane(fake)
    await fake.push(101, 'x\r\n'.repeat(1500))
    await mounted.flush()
    await act(async () => mounted!.handle().search('x'))
    expect(status(mounted)).toBe('1000+')
    expect(mounted.lastReport().search).toMatchObject({ total: 1000, more: true })
  })

  test('a query over 1,000 characters is not searched', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search())
    await type(pane, '1'.repeat(1001))
    expect(input(pane).value).toBe('')
    expect(status(pane)).toBe('0/0')
  })

  test('an invalid regex does not take the pane down', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search('(', { regex: true }))
    expect(status(pane)).toBe('No results')
    await act(async () => pane.handle().searchNext())
    expect(pane.element.querySelector('[data-terminal-pane]')).not.toBeNull()
  })

  test('an exception inside the search addon is swallowed', async () => {
    const { pane } = await mountWithOutput()
    const { SearchAddon } = await import('@xterm/addon-search')
    const original = SearchAddon.prototype.findNext
    SearchAddon.prototype.findNext = () => {
      throw new Error('This API only accepts positive integers')
    }
    try {
      await act(async () => pane.handle().search('19'))
      await act(async () => pane.handle().searchNext())
      expect(status(pane)).toBe('No results')
    } finally {
      SearchAddon.prototype.findNext = original
    }
  })
})

describe('driving search from commands', () => {
  test('SC-43: next and previous step from outside the box, and do nothing when closed or empty', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().searchNext())
    expect(pane.lastReport().search).toBeNull()
    await act(async () => pane.handle().search())
    await act(async () => pane.handle().searchNext())
    expect(status(pane)).toBe('0/0')
    await type(pane, '19')
    pane.textarea().focus()
    await act(async () => pane.handle().searchNext())
    await act(async () => pane.handle().searchNext())
    expect(status(pane)).toBe('3/12')
    await act(async () => pane.handle().searchPrevious())
    expect(status(pane)).toBe('2/12')
  })

  test('SC-44: search with a query reports current 1, then search-next reports 2 of 12', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search('19'))
    expect(pane.lastReport().search).toEqual({ query: '19', regex: false, caseSensitive: false, current: 1, total: 12, more: false })
    await act(async () => pane.handle().searchNext())
    expect(pane.lastReport().search).toMatchObject({ query: '19', current: 2, total: 12 })
  })

  test('SC-44: search options carry regex and case, and searchClose clears the report', async () => {
    const { pane } = await mountWithOutput()
    await act(async () => pane.handle().search('^1.9$', { regex: true }))
    expect(pane.lastReport().search).toMatchObject({ regex: true, current: 1, total: 10 })
    await act(async () => pane.handle().searchClose())
    expect(pane.lastReport().search).toBeNull()
  })

  test('SC-44: a query over 1,000 characters is refused with invalid-params', async () => {
    const { pane } = await mountWithOutput()
    let error: unknown
    try {
      pane.handle().search('x'.repeat(1001))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ name: 'RpcError', code: RpcErrorCode.InvalidParams })
    expect(pane.lastReport().search).toBeNull()
  })
})
