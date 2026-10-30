import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { base64ToBytes, type UiPluginContext } from '@quirky/protocol'
import { createInputGate, writeReplay } from './replayGate'
import { readTerminalTheme } from '@quirky/ui/terminal-theme'

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

    const initialColors = readTerminalTheme(themeSource)
    const term = new Terminal({
      scrollback: scrollbackRef.current,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { ...initialColors }
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
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
    let readOnly = false
    let streamId: number | null = null
    let unsubscribe: (() => void) | null = null

    const inputGate = createInputGate()
    term.onData((data) => {
      if (readOnly || !interactiveRef.current || !inputGate.allows()) return
      void context.call('quirky.terminal/write', { session: sessionId, data }).catch(() => {})
    })
    term.onResize(({ cols, rows }) => {
      void context.call('quirky.terminal/resize', { session: sessionId, cols, rows }).catch(() => {})
    })

    const detach = (id: number) => void context.call('quirky.terminal/detach', { streamId: id }).catch(() => {})
    context
      .call('quirky.terminal/attach', { session: sessionId, cols: term.cols, rows: term.rows, historyLines: scrollbackRef.current })
      .then((value) => {
        const result = value as { streamId: number; replay: string; live?: boolean }
        if (disposed) {
          detach(result.streamId)
          return
        }
        streamId = result.streamId
        writeReplay(term, base64ToBytes(result.replay), inputGate)
        if (result.live === false) {
          readOnly = true
          return
        }
        unsubscribe = context.onStream(result.streamId, (bytes) => term.write(bytes))
      })
      .catch((error: Error) => {
        if (!disposed) term.write(`\r\n\x1b[31mCould not attach: ${error.message}\x1b[0m\r\n`)
      })

    let applied = initialColors
    const applyTheme = () => {
      if (disposed) return
      const next = readTerminalTheme(themeSource)
      if (JSON.stringify(next) === JSON.stringify(applied)) return
      applied = next
      term.options.theme = { ...next }
    }
    // the shell writes the new theme's variables after its own async refresh, later than theme.changed arrives
    const themeObserver = new MutationObserver(applyTheme)
    themeObserver.observe(element.ownerDocument.documentElement, { attributes: true })
    themeObserver.observe(themeSource, { attributes: true })
    const unsubscribeEvents = context.subscribe((event) => {
      if (event.type === 'theme.changed') applyTheme()
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
      themeObserver.disconnect()
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
