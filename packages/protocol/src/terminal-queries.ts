/** The parts of an `@xterm/xterm` or `@xterm/headless` Terminal that answering a query needs. */
export type QueryAnsweringTerminal = {
  parser: {
    registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void }
  }
  input(data: string, wasUserInput?: boolean): void
}

/**
 * Answers XTVERSION (`CSI > q`) the way xterm.js 6.1 does, naming the terminal `xterm.js(<version>)`.
 * Programs such as Claude Code only check for synchronized output (DEC 2026) after a terminal names
 * itself, and xterm.js 6.0 never does. The reply leaves through the terminal's `onData`, like its
 * own query replies, so callers' input gates apply to it unchanged.
 */
export function answerXtversion(term: QueryAnsweringTerminal, xtermVersion: string): { dispose(): void } {
  return term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    const ps = params[0]
    if (typeof ps === 'number' && ps > 0) return true
    term.input(`\x1bP>|xterm.js(${xtermVersion})\x1b\\`, false)
    return true
  })
}
