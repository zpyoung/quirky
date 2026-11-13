import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { bytesToBase64 } from '@quirky/protocol'
import type { Terminal } from '@xterm/xterm'
import { fakeContext, loadPane, mountPane, paneHandlers, settings, settle, startRecording, stopRecording, unloadPane, type MountedPane } from './pane-support'

let mountedPanes: MountedPane[] = []
let imageAddonConstructed = false
const imageActivationText = new WeakMap<Terminal, string>()
const imageModuleGate = Promise.withResolvers<{ ImageAddon: typeof TestImageAddon }>()
let imageModuleReleased = false

function terminalText(terminal: Terminal): string {
  const buffer = terminal.buffer.active
  return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) ?? '').join('\n')
}

class TestImageAddon {
  constructor() {
    imageAddonConstructed = true
  }

  activate(terminal: Terminal): void {
    imageActivationText.set(terminal, terminalText(terminal))
  }

  dispose(): void {}
}

function releaseImageModule(): void {
  if (imageModuleReleased) return
  imageModuleReleased = true
  imageModuleGate.resolve({ ImageAddon: TestImageAddon })
}

// The pane loads this optional chunk dynamically; a static import would run before the mock could be registered.
mock.module('@xterm/addon-image', () => imageModuleGate.promise)

beforeAll(loadPane)
afterAll(async () => {
  await unloadPane()
  mock.restore()
})
beforeEach(startRecording)
afterEach(async () => {
  for (const pane of mountedPanes.splice(0)) await pane.unmount()
  stopRecording()
  document.body.innerHTML = ''
})

describe('pane attach and image addon ordering', () => {
  test('attaches before the image addon, replays after activation, and ignores late completion after unmount or failure', async () => {
    const constructedAtAttach: boolean[] = []
    const attachedFake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => {
        constructedAtAttach.push(imageAddonConstructed)
        return { streamId: 41, replay: bytesToBase64(new TextEncoder().encode('hello')) }
      }
    }))
    const detachedFake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => ({ streamId: 7, replay: bytesToBase64(new TextEncoder().encode('unmounted-replay')) })
    }))
    const rejectedFake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => Promise.reject(new Error('gone'))
    }))

    try {
      const attachedPane = await mountPane(attachedFake, { settings: settings({ 'inline-images': true, scrollback: 4000 }) })
      mountedPanes.push(attachedPane)
      const detachedPane = await mountPane(detachedFake)
      mountedPanes.push(detachedPane)
      const rejectedPane = await mountPane(rejectedFake)
      mountedPanes.push(rejectedPane)
      await settle()
      await rejectedPane.flush()

      const attachedTerminal = attachedPane.term()
      const detachedTerminal = detachedPane.term()
      const attachedCall = attachedFake.callsTo('quirky.terminal/attach')[0]
      expect(attachedCall).toBeDefined()
      expect(constructedAtAttach).toEqual([false])
      expect(attachedCall?.params).toEqual({
        session: 's1',
        cols: attachedTerminal.cols,
        rows: attachedTerminal.rows,
        historyLines: 4000
      })

      expect(detachedFake.callsTo('quirky.terminal/attach')).toHaveLength(1)
      const detachedIndex = mountedPanes.indexOf(detachedPane)
      if (detachedIndex >= 0) mountedPanes.splice(detachedIndex, 1)
      await detachedPane.unmount()

      const rejectedTextBeforeAddon = terminalText(rejectedPane.term())
      expect(rejectedTextBeforeAddon).toContain('Could not attach: gone')

      releaseImageModule()
      await settle()
      await attachedPane.flush()
      await rejectedPane.flush()

      expect(imageAddonConstructed).toBe(true)
      expect(imageActivationText.has(attachedTerminal)).toBe(true)
      expect(imageActivationText.get(attachedTerminal)).not.toContain('hello')
      expect(terminalText(attachedTerminal)).toContain('hello')

      expect(detachedFake.callsTo('quirky.terminal/detach').map((call) => call.params)).toEqual([{ streamId: 7 }])
      expect(detachedFake.streams.has(7)).toBe(false)
      expect(terminalText(detachedTerminal)).not.toContain('unmounted-replay')
      expect(terminalText(rejectedPane.term())).toBe(rejectedTextBeforeAddon)
    } finally {
      releaseImageModule()
      await settle()
    }
  })
})
