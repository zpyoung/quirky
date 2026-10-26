import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { base64ToBytes, type UiPluginContext } from '@quirky/protocol'
import { createInputGate, writeReplay } from './replayGate'
import { readTerminalColors } from './terminalTheme'

type Props = {
  context: UiPluginContext
  /** The element whose `--terminal-*` custom properties give the colors. */
  themeSource: Element
  sessionId: string
  scrollback: number
  /** False once the process has exited, so keystrokes are not sent to a dead session. */
  interactive: boolean
}

const RESIZE_DEBOUNCE_MS = 50

/**
 * One xterm instance attached to one session's output. The parent mounts only the active tab,
 * so mounting attaches and unmounting detaches and disposes.
 */
export function TerminalPane({ context, themeSource, sessionId, scrollback, interactive }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const interactiveRef = useRef(interactive)
  interactiveRef.current = interactive
  const scrollbackRef = useRef(scrollback)
  scrollbackRef.current = scrollback
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (termRef.current) termRef.current.options.scrollback = scrollback
  }, [scrollback])

  useEffect(() => {
    const element = host.current
    if (!element) return

    const term = new Terminal({
      scrollback: scrollbackRef.current,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { ...readTerminalColors(themeSource) }
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
      void context.call('quirky.terminal/write', { session: sessionId, data }).catch(() => {})
    })
    term.onResize(({ cols, rows }) => {
      void context.call('quirky.terminal/resize', { session: sessionId, cols, rows }).catch(() => {})
    })

    const detach = (id: number) => void context.call('quirky.terminal/detach', { streamId: id }).catch(() => {})
    context
      .call('quirky.terminal/attach', { session: sessionId, cols: term.cols, rows: term.rows })
      .then((value) => {
        const result = value as { streamId: number; replay: string }
        if (disposed) {
          detach(result.streamId)
          return
        }
        streamId = result.streamId
        writeReplay(term, base64ToBytes(result.replay), inputGate)
        unsubscribe = context.onStream(result.streamId, (bytes) => term.write(bytes))
      })
      .catch((error: Error) => {
        if (!disposed) term.write(`\r\n\x1b[31mCould not attach: ${error.message}\x1b[0m\r\n`)
      })

    // the host may apply the new theme variables after this listener runs
    let themeTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribeEvents = context.subscribe((event) => {
      if (event.type !== 'theme.changed') return
      clearTimeout(themeTimer)
      themeTimer = setTimeout(() => {
        if (!disposed) term.options.theme = { ...readTerminalColors(themeSource) }
      }, 0)
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
      clearTimeout(themeTimer)
      observer.disconnect()
      unsubscribeEvents()
      unsubscribe?.()
      if (streamId !== null) detach(streamId)
      termRef.current = null
      term.dispose()
    }
  }, [context, themeSource, sessionId])

  return <div className="terminal-host" ref={host} />
}
