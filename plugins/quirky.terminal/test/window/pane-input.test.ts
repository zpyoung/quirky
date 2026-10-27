import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'
import { PASTE_CHUNK_BYTES, PASTE_DIRECT_BYTES } from '../../src/window/pane/paste'

let mounted: MountedPane | null = null
let clipboard: { written: string[]; text: string }

beforeAll(loadPane)
afterAll(unloadPane)
beforeEach(() => {
  startRecording()
  clipboard = { written: [], text: '' }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => void clipboard.written.push(text),
      readText: async () => clipboard.text
    }
  })
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(over = {}, handlers = paneHandlers(), settingOverrides = {}) {
  const fake = fakeContext(handlers, settingOverrides)
  mounted = await mountPane(fake, over)
  return { fake, pane: mounted }
}

const written = (fake: ReturnType<typeof fakeContext>) => fake.callsTo('quirky.terminal/write').map((call) => call.params.data as string)

async function key(pane: MountedPane, init: KeyboardEventInit & { location?: number }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  await act(async () => void pane.textarea().dispatchEvent(event))
  return event
}

describe('SC-62: byte translations', () => {
  test.each([
    ['Shift+Enter', { key: 'Enter', keyCode: 13, shiftKey: true }, '\x1b\r'],
    ['Ctrl+Backspace', { key: 'Backspace', keyCode: 8, ctrlKey: true }, '\x17'],
    ['Alt+Backspace', { key: 'Backspace', keyCode: 8, altKey: true }, '\x1b\x7f'],
    ['Cmd+Backspace', { key: 'Backspace', keyCode: 8, metaKey: true }, '\x15'],
    ['Cmd+Delete', { key: 'Delete', keyCode: 46, metaKey: true }, '\x0b'],
    ['Cmd+Left', { key: 'ArrowLeft', keyCode: 37, metaKey: true }, '\x01'],
    ['Cmd+Right', { key: 'ArrowRight', keyCode: 39, metaKey: true }, '\x05'],
    ['Alt+Left', { key: 'ArrowLeft', keyCode: 37, altKey: true }, '\x1bb'],
    ['Alt+Right', { key: 'ArrowRight', keyCode: 39, altKey: true }, '\x1bf']
  ] as const)('%s writes the readline bytes exactly once', async (_name, init, bytes) => {
    const { fake, pane } = await mount()
    const event = await key(pane, init)
    expect(written(fake)).toEqual([bytes])
    expect(event.defaultPrevented).toBe(true)
  })

  test('keys outside the list reach xterm untouched', async () => {
    const { fake, pane } = await mount()
    const event = await key(pane, { key: 'Enter', keyCode: 13 })
    expect(written(fake)).toEqual(['\r'])
    expect(event.defaultPrevented).toBe(true)
    await key(pane, { key: 'a', keyCode: 65, ctrlKey: true })
    expect(written(fake)).toEqual(['\r', '\x01'])
  })

  test('Shift+Enter sends the kitty sequence after the program pushed kitty flags', async () => {
    const { fake, pane } = await mount()
    await act(async () => void pane.term().write('\x1b[>1u'))
    await pane.flush()
    await key(pane, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(written(fake)).toEqual(['\x1b[13;2u'])
    await act(async () => void pane.term().write('\x1b[<u'))
    await pane.flush()
    await key(pane, { key: 'Enter', keyCode: 13, shiftKey: true })
    expect(written(fake).at(-1)).toBe('\x1b\r')
  })

  test('Cmd+Up and Cmd+Down scroll the scrollback to its top and bottom', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\r\n'))
    await pane.flush()
    const buffer = () => pane.term().buffer.active
    expect(buffer().viewportY).toBe(buffer().baseY)
    await key(pane, { key: 'ArrowUp', keyCode: 38, metaKey: true })
    expect(buffer().viewportY).toBe(0)
    await key(pane, { key: 'ArrowDown', keyCode: 40, metaKey: true })
    expect(buffer().viewportY).toBe(buffer().baseY)
    expect(written(fake)).toEqual([])
  })

  test('a read-only pane writes nothing for a translated key', async () => {
    const { fake, pane } = await mount({ interactive: false })
    await key(pane, { key: 'Backspace', keyCode: 8, metaKey: true })
    expect(written(fake)).toEqual([])
  })

  test('option-as-alt left sends ESC plus the key while the left Option key is held', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'option-as-alt': 'left' }) })
    await key(pane, { key: 'Alt', keyCode: 18, altKey: true, location: 1 })
    const event = await key(pane, { key: 'å', keyCode: 65, code: 'KeyA', altKey: true })
    expect(written(fake)).toEqual(['\x1ba'])
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('SC-37: pasting', () => {
  const pasteEvent = (text: string) => {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } })
    return event
  }

  test('a paste event is taken over: xterm never sees it and the hidden input stays empty', async () => {
    const { fake, pane } = await mount()
    pane.textarea().value = 'stale'
    const event = pasteEvent('hello\nworld')
    await act(async () => void pane.textarea().dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(written(fake)).toEqual(['hello\rworld'])
    expect(pane.textarea().value).toBe('')
  })

  test('10 KiB is one write', async () => {
    const { fake, pane } = await mount()
    await act(async () => void pane.textarea().dispatchEvent(pasteEvent('x'.repeat(10 * 1024))))
    expect(written(fake)).toHaveLength(1)
  })

  test('200 KiB arrives complete and in order in 16 KiB writes, each awaited', async () => {
    let inFlight = 0
    let overlapped = false
    const handlers = paneHandlers({}, {
      'quirky.terminal/write': async () => {
        inFlight += 1
        if (inFlight > 1) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 0))
        inFlight -= 1
        return { ok: true }
      }
    })
    const { fake, pane } = await mount({}, handlers)
    const text = Array.from({ length: 200 * 1024 }, (_, index) => String.fromCharCode(97 + (index % 26))).join('')
    await act(async () => {
      await pane.handle().paste(text)
    })
    const writes = written(fake)
    expect(writes.length).toBe(13)
    expect(writes.every((chunk) => chunk.length <= PASTE_CHUNK_BYTES)).toBe(true)
    expect(writes.join('')).toBe(text)
    expect(overlapped).toBe(false)
  })

  test('20 MiB is refused with a toast and writes nothing', async () => {
    const { fake, pane } = await mount()
    await act(async () => {
      await pane.handle().paste('a'.repeat(20 * 1024 * 1024))
    })
    expect(written(fake)).toEqual([])
    expect(fake.toasts[0]!.title).toBe('Paste is larger than 16 MiB')
  })

  test('bracketed markers wrap the text only when the program turned the mode on', async () => {
    const { fake, pane } = await mount()
    await act(async () => {
      await pane.handle().paste('one')
    })
    await act(async () => void pane.term().write('\x1b[?2004h'))
    await pane.flush()
    await act(async () => {
      await pane.handle().paste('two')
    })
    await act(async () => void pane.term().write('\x1b[?2004l'))
    await pane.flush()
    await act(async () => {
      await pane.handle().paste('three')
    })
    expect(written(fake)).toEqual(['one', '\x1b[200~two\x1b[201~', 'three'])
  })

  test('a chunked bracketed paste is wrapped once across its chunks', async () => {
    const { fake, pane } = await mount()
    await act(async () => void pane.term().write('\x1b[?2004h'))
    await pane.flush()
    await act(async () => {
      await pane.handle().paste('y'.repeat(PASTE_DIRECT_BYTES + 100))
    })
    const writes = written(fake)
    expect(writes[0]).toBe('\x1b[200~')
    expect(writes.at(-1)).toBe('\x1b[201~')
    expect(writes.slice(1, -1).join('')).toBe('y'.repeat(PASTE_DIRECT_BYTES + 100))
  })

  test('a write that fails ends the paste with a toast and closes the bracket', async () => {
    let calls = 0
    const handlers = paneHandlers({}, {
      'quirky.terminal/write': async (params) => {
        calls += 1
        if (calls === 3 && params.data !== '\x1b[201~') throw new Error('gone')
        return { ok: true }
      }
    })
    const { fake, pane } = await mount({}, handlers)
    await act(async () => void pane.term().write('\x1b[?2004h'))
    await pane.flush()
    await act(async () => {
      await pane.handle().paste('z'.repeat(PASTE_DIRECT_BYTES * 2))
    })
    expect(fake.toasts[0]!.title).toBe('Paste failed')
    expect(written(fake).at(-1)).toBe('\x1b[201~')
  })

  test('a pane that is not interactive ignores a paste', async () => {
    const { fake, pane } = await mount({ interactive: false })
    await act(async () => {
      await pane.handle().paste('nope')
    })
    expect(written(fake)).toEqual([])
  })

  test('pastes are serialized in the order they arrive', async () => {
    const { fake, pane } = await mount()
    await act(async () => {
      await Promise.all([pane.handle().paste('a'), pane.handle().paste('b'), pane.handle().paste('c')])
    })
    expect(written(fake)).toEqual(['a', 'b', 'c'])
  })
})

describe('SC-38: dropping files', () => {
  const dropEvent = (data: { files?: { path?: string }[]; text?: Record<string, string> }) => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: data.files ?? [], types: ['Files'], getData: (type: string) => data.text?.[type] ?? '' }
    })
    return event
  }
  const host = (pane: MountedPane) => pane.element.querySelector('[data-terminal-pane]')!

  test('types the escaped paths at the cursor without Enter', async () => {
    const { fake, pane } = await mount()
    const event = dropEvent({ files: [{ path: '/tmp/w/api/a b.txt' }, { path: '/tmp/w/api/c.txt' }] })
    await act(async () => void host(pane).dispatchEvent(event))
    expect(written(fake)).toEqual(["'/tmp/w/api/a b.txt' /tmp/w/api/c.txt"])
    expect(event.defaultPrevented).toBe(true)
  })

  test('file URLs in the URI list are typed too', async () => {
    const { fake, pane } = await mount()
    await act(async () => void host(pane).dispatchEvent(dropEvent({ text: { 'text/uri-list': 'file:///tmp/x%20y.txt\r\n' } })))
    expect(written(fake)).toEqual(["'/tmp/x y.txt'"])
  })

  test('a drop without file paths is left to its owner', async () => {
    const { fake, pane } = await mount()
    const event = dropEvent({ text: { 'text/plain': 'a pane header' } })
    await act(async () => void host(pane).dispatchEvent(event))
    expect(written(fake)).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  test('a read-only pane types nothing', async () => {
    const { fake, pane } = await mount({ interactive: false })
    await act(async () => void host(pane).dispatchEvent(dropEvent({ files: [{ path: '/tmp/a' }] })))
    expect(written(fake)).toEqual([])
  })
})

describe('SC-35: zoom', () => {
  test('three zoom-ins make 17 px for this pane only, reset returns to the setting, twenty zoom-outs stop at 8', async () => {
    const fake = fakeContext(paneHandlers())
    mounted = await mountPane(fake)
    const other = await mountPane(fake, { sessionId: 's2' })
    const [first, second] = [mounted, other]
    for (let step = 0; step < 3; step += 1) await act(async () => second.handle().zoomIn())
    expect(second.term().options.fontSize).toBe(17)
    expect(second.lastReport().fontSize).toBe(17)
    expect(first.term().options.fontSize).toBe(14)
    expect(first.lastReport().fontSize).toBe(14)
    await act(async () => second.handle().zoomReset())
    expect(second.term().options.fontSize).toBe(14)
    for (let step = 0; step < 20; step += 1) await act(async () => second.handle().zoomOut())
    expect(second.term().options.fontSize).toBe(8)
    for (let step = 0; step < 40; step += 1) await act(async () => second.handle().zoomIn())
    expect(second.term().options.fontSize).toBe(32)
    await other.unmount()
  })

  test('zoom starts from the font size setting and reset follows a changed setting', async () => {
    const { pane } = await mount({ settings: settings({ 'font-size': 20 }) })
    await act(async () => pane.handle().zoomIn())
    expect(pane.term().options.fontSize).toBe(21)
    await pane.rerender({ settings: settings({ 'font-size': 12 }) })
    expect(pane.term().options.fontSize).toBe(21)
    await act(async () => pane.handle().zoomReset())
    expect(pane.term().options.fontSize).toBe(12)
  })

  test('zoom is not sent to the daemon or saved', async () => {
    const { fake, pane } = await mount()
    await act(async () => pane.handle().zoomIn())
    expect(fake.calls.map((call) => call.method)).not.toContain('quirky.terminal/setSetting')
  })
})

describe('SC-36: selecting and copying', () => {
  async function withIndentedText() {
    const out = await mount()
    await out.fake.push(101, '  alpha\r\n  beta\r\n')
    await out.pane.flush()
    return out
  }

  test('copy returns the selection with the shared gutter trimmed and puts it on the clipboard', async () => {
    const { pane } = await withIndentedText()
    pane.term().select(0, 0, 86)
    let text = ''
    await act(async () => void (text = pane.handle().copy()))
    expect(text).toBe('alpha\nbeta')
    expect(clipboard.written).toEqual(['alpha\nbeta'])
  })

  test('with Trim Gutter off the selection is copied as it is', async () => {
    const { pane } = await mount({ settings: settings({ 'trim-gutter-on-copy': false }) })
    await pane.term().write('  alpha\r\n  beta\r\n')
    await pane.flush()
    pane.term().select(0, 0, 86)
    expect(pane.handle().copy()).toBe('  alpha\n  beta')
  })

  test('copy with nothing selected does nothing', async () => {
    const { pane } = await withIndentedText()
    expect(pane.handle().copy()).toBe('')
    expect(clipboard.written).toEqual([])
  })

  test('select all selects the whole buffer', async () => {
    const { pane } = await withIndentedText()
    await act(async () => pane.handle().selectAll())
    expect(pane.term().hasSelection()).toBe(true)
    expect(pane.term().getSelection()).toContain('alpha')
  })

  test('a native copy event carries the trimmed text', async () => {
    const { pane } = await withIndentedText()
    pane.term().select(0, 0, 86)
    const data: Record<string, string> = {}
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => void (data[type] = value) } })
    await act(async () => void pane.textarea().dispatchEvent(event))
    expect(data['text/plain']).toBe('alpha\nbeta')
    expect(event.defaultPrevented).toBe(true)
  })

  test('Copy on Select copies when a mouse selection ends, and not otherwise', async () => {
    const { pane } = await mount({ settings: settings({ 'copy-on-select': true }) })
    await pane.term().write('  alpha\r\n  beta\r\n')
    await pane.flush()
    const host = pane.element.querySelector('[data-terminal-pane]')!
    pane.term().select(0, 0, 86)
    expect(clipboard.written).toEqual([])
    await act(async () => void host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    await act(async () => void host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })))
    expect(clipboard.written).toEqual(['alpha\nbeta'])
  })

  test('Copy on Select off leaves the clipboard alone', async () => {
    const { pane } = await mount()
    await pane.term().write('text\r\n')
    await pane.flush()
    const host = pane.element.querySelector('[data-terminal-pane]')!
    pane.term().select(0, 0, 4)
    await act(async () => void host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })))
    await act(async () => void host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })))
    expect(clipboard.written).toEqual([])
  })

  test('Right-click to Paste pastes the clipboard and keeps the menu closed; Ctrl-click still reaches it', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'right-click-paste': true }) })
    clipboard.text = 'from clipboard'
    const host = pane.element.querySelector('[data-terminal-pane]')!
    let reached = 0
    pane.element.addEventListener('contextmenu', () => void (reached += 1))
    const plain = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    await act(async () => void host.dispatchEvent(plain))
    await act(async () => void new Promise((resolve) => setTimeout(resolve, 0)))
    expect(written(fake)).toEqual(['from clipboard'])
    expect(plain.defaultPrevented).toBe(true)
    expect(reached).toBe(0)
    await act(async () => void host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ctrlKey: true })))
    expect(reached).toBe(1)
    expect(written(fake)).toEqual(['from clipboard'])
  })

  test('without the setting a right-click is left to the menu', async () => {
    const { fake, pane } = await mount()
    let reached = 0
    pane.element.addEventListener('contextmenu', () => void (reached += 1))
    await act(async () => void pane.element.querySelector('[data-terminal-pane]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    expect(reached).toBe(1)
    expect(written(fake)).toEqual([])
  })
})

describe('OSC 52', () => {
  const osc52 = (text: string) => `\x1b]52;c;${btoa(text)}\x07`

  test('a write reaches the clipboard while the setting is on', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, osc52('copied by a program'))
    await pane.flush()
    expect(clipboard.written).toEqual(['copied by a program'])
  })

  test('a read is never answered with the clipboard', async () => {
    const { fake, pane } = await mount()
    clipboard.text = 'secret'
    await fake.push(101, '\x1b]52;c;?\x07')
    await pane.flush()
    await act(async () => void new Promise((resolve) => setTimeout(resolve, 0)))
    expect(written(fake).join('')).not.toContain(btoa('secret'))
  })

  test('the setting off blocks writes, and turning it on lets them through', async () => {
    const { fake, pane } = await mount({ settings: settings({ 'allow-osc52': false }) })
    await fake.push(101, osc52('blocked'))
    await pane.flush()
    expect(clipboard.written).toEqual([])
    await pane.rerender({ settings: settings({ 'allow-osc52': true }) })
    await fake.push(101, osc52('allowed'))
    await pane.flush()
    expect(clipboard.written).toEqual(['allowed'])
  })

  test('a write over 128 KiB of base64 is dropped', async () => {
    const { fake, pane } = await mount()
    await fake.push(101, osc52('a'.repeat(100 * 1024)))
    await pane.flush()
    expect(clipboard.written).toEqual([])
  })
})
