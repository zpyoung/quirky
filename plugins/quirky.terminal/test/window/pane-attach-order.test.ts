import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { bytesToBase64, encodeTerminalOutput, QuirkyClient } from '@quirky/protocol'
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
      'quirky.terminal/attach': () => ({ streamId: 7, replay: bytesToBase64(new TextEncoder().encode('unmounted-replay')) }),
      'quirky.terminal/detach': (params) => client.callAny('quirky.terminal/detach', params)
    }))
    const rejectedFake = fakeContext(paneHandlers({}, {
      'quirky.terminal/attach': () => Promise.reject(new Error('gone'))
    }))
    // constructor and buffer access mirror the protocol's frame fixtures without opening a socket
    let detachReplyId = 0
    let subscriptions = 0
    const client = new (QuirkyClient as unknown as new (
      transport: { send(text: string): void; close(): void }
    ) => QuirkyClient)({
      send(text) {
        const message: unknown = JSON.parse(text)
        if (!message || typeof message !== 'object' || !('id' in message) || typeof message.id !== 'number') throw new Error('invalid fixture request')
        detachReplyId = message.id
      },
      close() {}
    })
    const bufferedClient = client as unknown as {
      handleMessage(data: unknown): void
      streamBuffers: Map<number, Uint8Array[]>
      streamHandlers: Map<number, unknown>
    }
    detachedFake.context.onStream = (id, handler, options) => {
      subscriptions++
      return client.onTerminalOutput(id, handler, options)
    }

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
      bufferedClient.handleMessage(encodeTerminalOutput(7, new TextEncoder().encode('output while addon loads')))
      expect(bufferedClient.streamBuffers.has(7)).toBe(true)
      const detachedIndex = mountedPanes.indexOf(detachedPane)
      if (detachedIndex >= 0) mountedPanes.splice(detachedIndex, 1)
      await detachedPane.unmount()
      detachedFake.context.onStream = () => {
        subscriptions++
        throw new Error('quirky.terminal is not active')
      }
      bufferedClient.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: detachReplyId, result: { ok: true } }))

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
      expect(subscriptions).toBe(0)
      expect(bufferedClient.streamHandlers.has(7)).toBe(false)
      expect(bufferedClient.streamBuffers.has(7)).toBe(false)
      expect(terminalText(detachedTerminal)).not.toContain('unmounted-replay')
      expect(terminalText(rejectedPane.term())).toBe(rejectedTextBeforeAddon)
    } finally {
      client.close()
      releaseImageModule()
      await settle()
    }
  })
})
