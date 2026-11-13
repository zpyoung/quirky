import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { version as xtermVersion } from '@xterm/xterm/package.json'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { answerXtversion, base64ToBytes, RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
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
const RESYNC_RESET_PREFIX = new Uint8Array([0x18, 0x1b, 0x5c, 0x1b, 0x63, 0x1b, 0x5b, 0x33, 0x4a])
const MAX_RESYNC_RETRIES = 3
const RESYNC_INITIAL_WAIT_MS = 250
const RESYNC_COOLDOWN_MS = 2_000

type TerminalAttachResult = { streamId: number; replay: string; live?: boolean }

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const combined = new Uint8Array(first.length + second.length)
  combined.set(first)
  combined.set(second, first.length)
  return combined
}

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
    answerXtversion(term, xtermVersion)
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
    let resyncTargetStreamId: number | null = null
    let lastResyncAt = -Infinity
    let resyncTimer: ReturnType<typeof setTimeout> | null = null
    let resyncing = false
    let pendingLag = false
    let resyncFailures = 0

    const inputGate = createInputGate()
    term.onData((data) => {
      if (readOnly || !interactiveRef.current || !inputGate.allows()) return
      void context.call('quirky.terminal/write', { session: sessionId, data }).catch(() => {})
    })
    term.onResize(({ cols, rows }) => {
      void context.call('quirky.terminal/resize', { session: sessionId, cols, rows }).catch(() => {})
    })

    const detach = (id: number) => void context.call('quirky.terminal/detach', { streamId: id }).catch(() => {})
    function handleLag(laggedStreamId: number): void {
      if (disposed || readOnly || laggedStreamId !== streamId) return
      unsubscribe?.()
      unsubscribe = null
      if (resyncing) {
        pendingLag = true
        return
      }
      if (resyncTimer !== null) return
      resyncTimer = setTimeout(() => void runResync(), Math.max(RESYNC_INITIAL_WAIT_MS, lastResyncAt + RESYNC_COOLDOWN_MS - Date.now()))
    }

    function subscribe(id: number): () => void {
      return context.onStream(id, (bytes) => term.write(bytes), { onLagged: () => handleLag(id) })
    }

    async function runResync(): Promise<void> {
      resyncTimer = null
      if (disposed || readOnly || streamId === null) return
      const targetStreamId = streamId
      streamId = null
      resyncTargetStreamId = targetStreamId
      resyncing = true
      pendingLag = false
      lastResyncAt = Date.now()
      try {
        const resynced = (await context.call('quirky.terminal/resync', { streamId: targetStreamId, historyLines: scrollbackRef.current })) as TerminalAttachResult
        resyncTargetStreamId = null
        resyncing = false
        resyncFailures = 0
        if (disposed) {
          detach(resynced.streamId)
          return
        }
        writeReplay(term, concatBytes(RESYNC_RESET_PREFIX, base64ToBytes(resynced.replay)), inputGate)
        if (resynced.live === false) {
          readOnly = true
          streamId = null
          detach(resynced.streamId)
          return
        }
        streamId = resynced.streamId
        unsubscribe = subscribe(resynced.streamId)
        if (pendingLag) {
          pendingLag = false
          handleLag(resynced.streamId)
        }
      } catch (error) {
        resyncing = false
        const failedStreamId = resyncTargetStreamId
        resyncTargetStreamId = null
        if (disposed) {
          if (failedStreamId !== null) detach(failedStreamId)
          return
        }
        if (readOnly) return
        const errorCode = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
        if (errorCode === RpcErrorCode.NotFound) {
          resyncFailures = 0
          streamId = null
          try {
            const attached = (await context.call('quirky.terminal/attach', {
              session: sessionId,
              cols: term.cols,
              rows: term.rows,
              historyLines: scrollbackRef.current
            })) as TerminalAttachResult
            if (disposed) {
              detach(attached.streamId)
              return
            }
            streamId = attached.streamId
            writeReplay(term, concatBytes(RESYNC_RESET_PREFIX, base64ToBytes(attached.replay)), inputGate)
            if (attached.live === false) {
              readOnly = true
              return
            }
            unsubscribe = subscribe(attached.streamId)
          } catch (attachError) {
            if (!disposed) {
              const message = attachError instanceof Error ? attachError.message : String(attachError)
              term.write(`\r\n\x1b[31mCould not attach: ${message}\x1b[0m\r\n`)
            }
          }
          return
        }
        resyncFailures += 1
        if (resyncFailures <= MAX_RESYNC_RETRIES) {
          streamId = targetStreamId
          handleLag(targetStreamId)
          return
        }
        streamId = null
        detach(targetStreamId)
        const message = error instanceof Error ? error.message : String(error)
        term.write(`\r\n\x1b[31mCould not resync: ${message}\x1b[0m\r\n`)
      }
    }
    context
      .call('quirky.terminal/attach', { session: sessionId, cols: term.cols, rows: term.rows, historyLines: scrollbackRef.current })
      .then((value) => {
        const result = value as TerminalAttachResult
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
        unsubscribe = subscribe(result.streamId)
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
      if (resyncTimer !== null) {
        clearTimeout(resyncTimer)
        resyncTimer = null
      }
      unsubscribe?.()
      if (streamId !== null) detach(streamId)
      termRef.current = null
      term.dispose()
    }
  }, [context, themeSource, sessionId])

  return <div className="terminal-host" ref={host} />
}
