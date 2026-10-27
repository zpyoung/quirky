import type { SubmitSignal } from './types'

/** Quiet time after bracketed paste is enabled before a quiet-window signal counts as ready. */
const QUIET_WINDOW_MS = 1500
/** How long OpenCode's input box may show without its agent row before Enter is trusted anyway. */
const OPENCODE_AGENT_ROW_GRACE_MS = 5000

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
const DECTCEM_SHOW_CURSOR = '\x1b[?25h'
const DECSET_ALT_SCREEN = '\x1b[?1049h'
const DECRST_ALT_SCREEN = '\x1b[?1049l'
// U+276F, also the default prompt glyph of starship and pure, hence the alternate-screen anchor
const COMPOSER_PROMPT_GLYPH = '❯'
// U+256D, the top-left corner of ZCode's composer box
const ZCODE_COMPOSER_BOX_CORNER = '╭'

/**
 * Watches an agent's startup output for the moment its input can take a paste (or, for the
 * `opencode-agent-row` submit signal, an Enter). Timestamps are caller-supplied milliseconds, so a
 * runner and a test can drive it on any clock.
 */
export type ReadyScanner = {
  /** Feeds the next output chunk. Chunks may split escape sequences and UTF-8 characters anywhere. */
  push(chunk: Uint8Array | string, at: number): void
  /** Whether the signal has fired by `at`, counting a quiet window or grace that has run out. */
  isReady(at: number): boolean
  /** When the scanner could next turn ready with no further output, or null if it cannot. */
  nextCheckAt(): number | null
}

/** The signal fired by marker output, or by silence once the quiet window has passed. */
export function createReadyScanner(signal: SubmitSignal): ReadyScanner {
  const inner = createStreamScanner(signal)
  const decoder = new TextDecoder()
  let ready = false
  let quietDeadline: number | null = null
  let graceDeadline: number | null = null

  const readyAt = (at: number): boolean =>
    ready || (quietDeadline !== null && at >= quietDeadline) || (graceDeadline !== null && at >= graceDeadline)

  return {
    push(chunk, at) {
      if (ready) {
        return
      }
      if (readyAt(at)) {
        ready = true
        return
      }
      const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      const scan = inner.observe(text)
      if (scan.ready) {
        ready = true
        return
      }
      if (scan.armQuietTimer) {
        quietDeadline = at + QUIET_WINDOW_MS
      }
      if (scan.readyAfterMs === null) {
        graceDeadline = null
      } else if (scan.readyAfterMs !== undefined && graceDeadline === null) {
        graceDeadline = at + scan.readyAfterMs
      }
    },
    isReady: readyAt,
    nextCheckAt() {
      if (ready) {
        return null
      }
      const deadlines = [quietDeadline, graceDeadline].filter((d): d is number => d !== null)
      return deadlines.length === 0 ? null : Math.min(...deadlines)
    }
  }
}

type Scan = {
  ready: boolean
  /** The quiet window should (re)start from this chunk. */
  armQuietTimer: boolean
  /** Ready after this many ms unless the signal fires first; null withdraws an armed one. */
  readyAfterMs?: number | null
}

type StreamScanner = { observe: (data: string) => Scan }

type SingleSignal = Exclude<SubmitSignal, 'opencode-agent-row' | 'codex-composer-prompt'>

type SignalSpec = {
  /** A composer marker that only counts while an anchor mode is held; null for quiet-window-only. */
  marker: { anchor: string; anchorEnd: string; text: string } | null
  /** Bytes that arm the quiet window, or null when the signal has none. */
  quietAnchor: string | null
}

const SIGNALS: Record<SingleSignal, SignalSpec> = {
  'render-cursor-after-bracketed-paste': {
    // the launching shell turns bracketed paste off before exec, so a cursor after that is its own
    marker: { anchor: DECSET_BRACKETED_PASTE, anchorEnd: DECRST_BRACKETED_PASTE, text: DECTCEM_SHOW_CURSOR },
    // opencode is silent for seconds before its composer mounts, so a quiet window would fire early
    quietAnchor: null
  },
  'grok-composer-prompt': {
    // leaving the alternate screen hands the terminal back to a shell whose prompt may be the glyph
    marker: { anchor: DECSET_ALT_SCREEN, anchorEnd: DECRST_ALT_SCREEN, text: COMPOSER_PROMPT_GLYPH },
    // inline rendering never switches screens, so the quiet floor keys off bracketed paste instead
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'dsh-composer-prompt': {
    marker: { anchor: DECSET_ALT_SCREEN, anchorEnd: DECRST_ALT_SCREEN, text: COMPOSER_PROMPT_GLYPH },
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'zcode-composer-prompt': {
    // a powerline shell prompt can draw the corner too
    marker: { anchor: DECSET_ALT_SCREEN, anchorEnd: DECRST_ALT_SCREEN, text: ZCODE_COMPOSER_BOX_CORNER },
    quietAnchor: DECSET_BRACKETED_PASTE
  },
  'render-quiet-after-bracketed-paste': { marker: null, quietAnchor: DECSET_BRACKETED_PASTE }
}

const STRUCTURAL: Record<'opencode-agent-row' | 'codex-composer-prompt', () => StreamScanner> = {
  'opencode-agent-row': () => {
    const scanner = createOpenCodeAgentRowScanner()
    return { observe: (data) => ({ ...scanner.observe(data), armQuietTimer: false }) }
  },
  'codex-composer-prompt': () => {
    const scanner = createCodexComposerScanner()
    return { observe: (data) => ({ ...scanner.observe(data), armQuietTimer: false }) }
  }
}

function createStreamScanner(signal: SubmitSignal): StreamScanner {
  return signal === 'opencode-agent-row' || signal === 'codex-composer-prompt'
    ? STRUCTURAL[signal]()
    : createSingleSignalScanner(SIGNALS[signal])
}

/** Longest anchor sequence minus one: the carry needed to rejoin one split across chunks. */
const ANCHOR_CARRY_CHARS = 7
const RECENT_CHARS = 512

function createSingleSignalScanner({ marker, quietAnchor }: SignalSpec): StreamScanner {
  let recent = ''
  let postAnchorRecent = ''
  let anchorCarry = ''
  let anchorHeld = false
  let sawQuietAnchor = false

  // the anchor is a mode the agent can leave, so it is tracked in stream order, segment by segment
  const markerInWindow = (window: string, carriedLength: number, anchor: string, end: string, text: string): boolean => {
    let cursor = 0
    while (cursor < window.length) {
      if (!anchorHeld) {
        const enterIndex = window.indexOf(anchor, cursor)
        if (enterIndex === -1) {
          return false
        }
        anchorHeld = true
        postAnchorRecent = ''
        cursor = enterIndex + anchor.length
        continue
      }
      const leaveIndex = window.indexOf(end, cursor)
      // carried chars only rejoin a split anchor; re-reading them could join a marker across the seam
      const segmentStart = Math.max(cursor, carriedLength)
      const segment = leaveIndex === -1 ? window.slice(segmentStart) : window.slice(segmentStart, leaveIndex)
      if ((postAnchorRecent + segment).includes(text)) {
        return true
      }
      if (leaveIndex === -1) {
        postAnchorRecent = (postAnchorRecent + segment).slice(-RECENT_CHARS)
        return false
      }
      anchorHeld = false
      postAnchorRecent = ''
      cursor = leaveIndex + end.length
    }
    return false
  }

  return {
    observe(data) {
      const combined = recent + data
      recent = combined.slice(-RECENT_CHARS)
      if (!sawQuietAnchor && quietAnchor !== null && combined.includes(quietAnchor)) {
        sawQuietAnchor = true
      }
      if (marker !== null) {
        const carriedLength = anchorCarry.length
        const window = anchorCarry + data
        anchorCarry = window.slice(-ANCHOR_CARRY_CHARS)
        if (markerInWindow(window, carriedLength, marker.anchor, marker.anchorEnd, marker.text)) {
          return { ready: true, armQuietTimer: false }
        }
      }
      return { ready: false, armQuietTimer: sawQuietAnchor }
    }
  }
}

const ESC = '\x1b'
// longest unfinished escape carried into the next read; anything longer is noise, not a split
const MAX_CARRIED_ESCAPE_CHARS = 512

const CSI_RE = /^\x1b\[([?>=<]?)([0-9;]*)([ -/]*[@-~])/
const UNFINISHED_CSI_RE = /^\x1b\[[?>=<]?[0-9;]*[ -/]*$/
const STRING_RE = /^\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)/
const STRING_START_RE = /^\x1b[\]PX^_]/
const STRING_END_RE = /\x07|\x1b\\/

type EscapeObserver = {
  onCsi: (privateMarker: string, params: string, final: string) => void
  onText: (text: string) => void
}

/** Incremental painted-text and CSI reader; terminal string payloads (titles, graphics) are never text. */
function createTerminalEscapeScanner(observer: EscapeObserver): { observe: (data: string) => void } {
  let carry = ''
  let stringPending = false

  const isUnfinishedEscape = (rest: string): boolean =>
    rest.length <= MAX_CARRIED_ESCAPE_CHARS &&
    (rest === ESC || UNFINISHED_CSI_RE.test(rest) || (STRING_START_RE.test(rest) && !STRING_END_RE.test(rest)))

  return {
    observe(data) {
      const input = carry + data
      carry = ''
      let index = 0
      if (stringPending) {
        const end = STRING_END_RE.exec(input)
        if (!end) {
          carry = input.endsWith(ESC) ? ESC : ''
          return
        }
        stringPending = false
        index = end.index + end[0].length
      }
      while (index < input.length) {
        const escapeAt = input.indexOf(ESC, index)
        if (escapeAt === -1) {
          observer.onText(input.slice(index))
          break
        }
        observer.onText(input.slice(index, escapeAt))
        const rest = input.slice(escapeAt)
        const sequence = CSI_RE.exec(rest) ?? STRING_RE.exec(rest)
        if (sequence) {
          if (sequence[0][1] === '[') {
            observer.onCsi(sequence[1], sequence[2], sequence[3])
          }
          index = escapeAt + sequence[0].length
          continue
        }
        if (STRING_START_RE.test(rest)) {
          stringPending = true
          carry = rest.endsWith(ESC) ? ESC : ''
          break
        }
        if (isUnfinishedEscape(rest)) {
          carry = rest
          break
        }
        index = escapeAt + 2
      }
    }
  }
}

const AGENT_ROW_SEPARATOR = '·'
const BOX_BOTTOM_LEFT = '╹'

/**
 * OpenCode's submit readiness: the `<agent> · <model>` row along the bottom of its input box is
 * painted only once its agent list has loaded, and until then it drops an Enter. The row's
 * separator sits on the line directly above the box's bottom-left corner, both placed by cursor
 * addressing inside the alternate screen; the footer path and tab strip can hold the separator too
 * but are on other lines. OpenCode 2 paints the corner first and the row in a later frame;
 * OpenCode 1 paints the row just before the corner in one synchronized frame.
 */
function createOpenCodeAgentRowScanner(): {
  observe: (data: string) => { ready: boolean; readyAfterMs: number | null }
} {
  let altScreen = false
  // once a full-screen app has left, a box cursor outside the alternate screen is the shell's
  let leftAltScreen = false
  let bracketedPaste = false
  let boxCursorShown = false
  let row: number | null = null
  let boxBottomRow: number | null = null
  let rowPainted = false
  // separator rows seen in the open synchronized frame, for OpenCode 1's row-before-corner order
  let framePendingRows = new Set<number>()

  const resetLayout = (): void => {
    row = null
    boxBottomRow = null
    rowPainted = false
    framePendingRows = new Set()
  }

  const onPrivateMode = (mode: string, set: boolean): void => {
    if (mode === '1049') {
      altScreen = set
      resetLayout()
      if (!set) {
        leftAltScreen = true
        boxCursorShown = false
      }
    } else if (mode === '2004') {
      bracketedPaste = set
      if (!set) {
        boxCursorShown = false
      }
    } else if (mode === '25' && set && bracketedPaste) {
      boxCursorShown = true
    } else if (mode === '2026') {
      framePendingRows = new Set()
    }
  }

  const onCsi = (privateMarker: string, params: string, final: string): void => {
    if (privateMarker === '?' && (final === 'h' || final === 'l')) {
      for (const mode of params.split(';')) {
        onPrivateMode(mode, final === 'h')
      }
    } else if (final === 'H' || final === 'f') {
      row = Math.max(1, Number(params.split(';')[0] || '1'))
    } else if (final === 'J' && params === '2') {
      boxBottomRow = null
      framePendingRows = new Set()
    }
  }

  const onText = (text: string): void => {
    if (!altScreen || row === null) {
      return
    }
    for (const char of text) {
      if (char === '\n') {
        row += 1
      } else if (char === AGENT_ROW_SEPARATOR) {
        if (boxBottomRow === row + 1) {
          rowPainted = true
        } else {
          framePendingRows.add(row)
        }
      } else if (char === BOX_BOTTOM_LEFT) {
        boxBottomRow = row
        if (framePendingRows.has(row - 1)) {
          rowPainted = true
        }
      }
    }
  }

  const scanner = createTerminalEscapeScanner({ onCsi, onText })
  return {
    observe(data) {
      scanner.observe(data)
      // narrow panes and transparent themes omit the row, so a shown box is trusted after a grace
      const graceApplies = boxCursorShown && !rowPainted && (altScreen || !leftAltScreen)
      return {
        ready: rowPainted && boxCursorShown,
        readyAfterMs: graceApplies ? OPENCODE_AGENT_ROW_GRACE_MS : null
      }
    }
  }
}

/** Codex's composer: the fullscreen loading frame has a composer too; only the live chat paints its footer. */
function createCodexComposerScanner(): { observe: (data: string) => { ready: boolean } } {
  let bracketedPaste = false
  let altScreen = false
  let leftAltScreen = false
  let synchronized = false
  let sawSynchronizedFrame = false
  let promptSeen = false
  let promptRow: number | null = null
  let footerRow: number | null = null
  let hintRow: number | null = null
  let row: number | null = null
  let cursorShown = false
  const paintedRows = new Set<number>()

  const resetLayout = (): void => {
    promptSeen = false
    promptRow = null
    footerRow = null
    hintRow = null
    row = null
    cursorShown = false
    paintedRows.clear()
  }
  const scanner = createTerminalEscapeScanner({
    onCsi: (privateMarker, params, final) => {
      if (privateMarker === '?' && (final === 'h' || final === 'l')) {
        const set = final === 'h'
        for (const mode of params.split(';')) {
          if (mode === '2004') {
            bracketedPaste = set
            if (!set) {
              resetLayout()
            }
          } else if (mode === '1049') {
            altScreen = set
            leftAltScreen = !set
            resetLayout()
          } else if (mode === '2026') {
            synchronized = set
            sawSynchronizedFrame = true
          } else if (mode === '25') {
            cursorShown = set
          }
        }
      } else if (final === 'H' || final === 'f') {
        row = Math.max(1, Number(params.split(';')[0] || '1'))
      } else if (final === 'J' && params === '2') {
        resetLayout()
      }
    },
    onText: (text) => {
      for (const char of text) {
        if (row !== null && !/\s/.test(char) && paintedRows.size < 128) {
          paintedRows.add(row)
        }
        if (char === '\n' && row !== null) {
          row += 1
        } else if (char === '›' && (bracketedPaste || altScreen)) {
          promptSeen = true
          promptRow = row
        } else if (char === '·' && promptRow !== null && row !== null && row > promptRow) {
          footerRow = row
        } else if (char === '?' && promptRow !== null && row !== null && row > promptRow) {
          hintRow = Math.max(hintRow ?? row, row)
        }
      }
    }
  })

  return {
    observe: (data) => {
      scanner.observe(data)
      const liveFullscreenComposer =
        altScreen &&
        !synchronized &&
        cursorShown &&
        promptRow !== null &&
        row !== null &&
        row >= promptRow &&
        hintRow !== null &&
        // single-item status lines have no separator; their reserved row is below the input padding
        ((footerRow !== null && footerRow === hintRow - 1 && row < footerRow) ||
          (row + 2 < hintRow && paintedRows.has(hintRow - 1)))
      // older inline builds do not paint synchronized fullscreen frames
      const legacyComposer = promptSeen && !leftAltScreen && (!altScreen || !sawSynchronizedFrame)
      return { ready: bracketedPaste && (liveFullscreenComposer || legacyComposer) }
    }
  }
}
