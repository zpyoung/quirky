import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { base64ToBytes } from '@quirky/protocol'
import type { Connection } from '../connection'
import { usePluginState } from '../context'
import { createInputGate, writeReplay } from '../lib/replayGate'
import { terminalColors } from '../lib/terminalTheme'

type Props = {
  connection: Connection
  sessionId: string
  scrollback: number
  /** Changes on every reconnect so the pane attaches again on the new socket. */
  epoch: number
  /** False once the process has exited, so keystrokes are not sent to a dead session. */
  interactive: boolean
}

const RESIZE_DEBOUNCE_MS = 50

/**
 * One xterm instance attached to one session's output. The parent mounts only the active tab,
 * so mounting attaches and unmounting detaches and disposes.
 */
export function TerminalPane({ connection, sessionId, scrollback, epoch, interactive }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  const colors = terminalColors(usePluginState().themeVariables)
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const client = connection.client
    if (!client) return

    const term = new Terminal({
      scrollback,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { ...colorsRef.current }
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // the DOM renderer stays in place
    }
    fit.fit()

    let disposed = false
    let streamId: number | null = null
    let unsubscribe: (() => void) | null = null

    const inputGate = createInputGate()
    term.onData((data) => {
      if (!interactiveRef.current || !inputGate.allows()) return
      void client.call('terminal.write', { sessionId, data }).catch(() => {})
    })
    term.onResize(({ cols, rows }) => {
      void client.call('terminal.resize', { sessionId, cols, rows }).catch(() => {})
    })

    client
      .call('terminal.attach', { sessionId, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (disposed) {
          void client.call('terminal.detach', { streamId: result.streamId }).catch(() => {})
          return
        }
        streamId = result.streamId
        writeReplay(term, base64ToBytes(result.replay), inputGate)
        unsubscribe = client.onTerminalOutput(result.streamId, (bytes) => term.write(bytes))
      })
      .catch((error: Error) => {
        if (!disposed) term.write(`\r\n\x1b[31mCould not attach: ${error.message}\x1b[0m\r\n`)
      })

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!disposed && element.clientWidth > 0 && element.clientHeight > 0) fit.fit()
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(element)
    term.focus()

    return () => {
      disposed = true
      clearTimeout(resizeTimer)
      observer.disconnect()
      unsubscribe?.()
      if (streamId !== null && !client.isClosed) {
        void client.call('terminal.detach', { streamId }).catch(() => {})
      }
      termRef.current = null
      term.dispose()
    }
  }, [connection, sessionId, scrollback, epoch])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = { ...colors }
  }, [colors.background, colors.foreground, colors.cursor])

  return <div className="terminal-host" ref={host} />
}
