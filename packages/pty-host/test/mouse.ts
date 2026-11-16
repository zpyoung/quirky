import type { Terminal } from '@xterm/headless'

type MouseService = {
  activeEncoding: string
  triggerMouseEvent(event: Record<string, unknown>): boolean
}

function mouseService(term: Terminal): MouseService {
  return (term as unknown as { _core: { coreMouseService: MouseService } })._core.coreMouseService
}

/** The name of the mouse report encoding `term` is using: `DEFAULT`, `SGR` or `SGR_PIXELS`. */
export function mouseEncoding(term: Terminal): string {
  return mouseService(term).activeEncoding
}

/**
 * The report `term` sends for one wheel-up notch, prefixed with the channel it came out on.
 * X10 reports leave on `onBinary`, which panes do not forward, so the channel is part of the result.
 */
export function wheelUp(term: Terminal): Promise<string> {
  return new Promise((resolve) => {
    const subs = [
      term.onData((data) => finish(`data:${data}`)),
      term.onBinary((data) => finish(`binary:${data}`))
    ]
    function finish(report: string) {
      for (const sub of subs) sub.dispose()
      resolve(report)
    }
    // button 4 is the wheel and action 0 is up in xterm's CoreMouseButton and CoreMouseAction
    const sent = mouseService(term).triggerMouseEvent({ col: 10, row: 5, x: 0, y: 0, button: 4, action: 0, ctrl: false, alt: false, shift: false })
    if (!sent) finish('none')
  })
}
