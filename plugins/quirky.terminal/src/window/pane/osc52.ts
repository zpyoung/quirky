import type { IBase64, IClipboardProvider } from '@xterm/addon-clipboard'
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm'

/** The most base64 text one OSC 52 write may carry. */
export const OSC52_MAX_BASE64 = 128 * 1024

/**
 * The base64 codec for OSC 52 writes; payloads over the cap decode to an empty string, which
 * `createOsc52Provider` ignores.
 */
export function createOsc52Base64(): IBase64 {
  return {
    encodeText: (data) => btoa(String.fromCharCode(...new TextEncoder().encode(data))),
    decodeText(data) {
      if (data.length > OSC52_MAX_BASE64) return ''
      try {
        const binary = atob(data)
        return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)))
      } catch {
        return ''
      }
    }
  }
}

/**
 * A clipboard provider that lets programs write the clipboard and never read it: an empty write
 * does not clear what the person copied. Its `readText` is only a backstop; the addon would
 * still reply to a query with an empty response, so load `createOsc52QueryGuard` after it.
 */
export function createOsc52Provider(write: (text: string) => void | Promise<void>): IClipboardProvider {
  return {
    readText: () => '',
    writeText: (_selection, text) => (text ? write(text) : undefined)
  }
}

/**
 * An addon that consumes OSC 52 queries (`?` as the data) so they are never answered. xterm runs
 * the most recently registered handler first, so load this after the clipboard addon; writes
 * fall through to it.
 */
export function createOsc52QueryGuard(): ITerminalAddon {
  let registration: IDisposable | undefined
  return {
    activate(terminal: Terminal) {
      registration = terminal.parser.registerOscHandler(52, (data) => data.split(';')[1] === '?')
    },
    dispose() {
      registration?.dispose()
      registration = undefined
    }
  }
}
