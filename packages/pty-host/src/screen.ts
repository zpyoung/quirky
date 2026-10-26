import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

export interface ScreenSnapshot {
  ansi: string
  cols: number
  rows: number
  cursor: { x: number; y: number }
  modes: { alternateScreen: boolean; bracketedPaste: boolean; mouseTracking: boolean; applicationCursor: boolean }
}

export interface ScreenOptions {
  cols: number
  rows: number
  scrollback?: number
  onReply?(bytes: Uint8Array): void
}

interface StyleSource {
  getFgColorMode(): number
  getFgColor(): number
  getBgColorMode(): number
  getBgColor(): number
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isOverline(): number
}

interface EmulatorInternals {
  _core?: {
    buffer?: { savedX?: number; savedY?: number; savedCurAttrData?: StyleSource }
    _inputHandler?: { _curAttrData?: StyleSource }
  }
}

const COLOR_MODE_P16 = 0x1000000
const COLOR_MODE_P256 = 0x2000000
const COLOR_MODE_RGB = 0x3000000

function colorParams(mode: number, color: number, base: 30 | 40): string[] {
  if (mode === COLOR_MODE_P16) return [String((color < 8 ? base : base + 52) + (color & 7))]
  if (mode === COLOR_MODE_P256) return [String(base + 8), '5', String(color)]
  if (mode === COLOR_MODE_RGB) return [String(base + 8), '2', String((color >> 16) & 255), String((color >> 8) & 255), String(color & 255)]
  return []
}

/** A full SGR sequence (reset first) that puts a terminal into `style`. */
function sgr(style: StyleSource): string {
  const params = ['0']
  if (style.isBold()) params.push('1')
  if (style.isDim()) params.push('2')
  if (style.isItalic()) params.push('3')
  if (style.isUnderline()) params.push('4')
  if (style.isBlink()) params.push('5')
  if (style.isInverse()) params.push('7')
  if (style.isInvisible()) params.push('8')
  if (style.isStrikethrough()) params.push('9')
  if (style.isOverline()) params.push('53')
  params.push(...colorParams(style.getFgColorMode(), style.getFgColor(), 30))
  params.push(...colorParams(style.getBgColorMode(), style.getBgColor(), 40))
  return `\x1b[${params.join(';')}m`
}

const encoder = new TextEncoder()

/**
 * One session's emulated terminal screen: parses output, answers terminal queries, and serializes
 * the visible screen as an exact snapshot. With a scrollback it doubles as the scratch emulator
 * the history reader renders log windows into.
 */
export class Screen {
  /** While true, replies the emulator generates for terminal queries are dropped, not passed to `onReply`. */
  seeding = false

  private readonly term: Terminal
  private readonly addon = new SerializeAddon()

  constructor(options: ScreenOptions) {
    const { cols, rows, scrollback = 0, onReply } = options
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true })
    this.term.loadAddon(this.addon as never)
    this.term.onData((reply) => {
      if (!this.seeding) onReply?.(encoder.encode(reply))
    })
  }

  write(data: Uint8Array | string, callback?: () => void): void {
    this.term.write(data, callback)
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows)
  }

  /** Resolves once everything written so far has been parsed. */
  settled(): Promise<void> {
    return new Promise((resolve) => this.term.write('', resolve))
  }

  /** The visible screen as ANSI that, written into a fresh terminal of the same size, reproduces it. */
  snapshot(): ScreenSnapshot {
    const { cols, rows } = this.term
    return {
      ansi: this.serialize({ scrollback: 0 }),
      cols,
      rows,
      cursor: this.cursor(),
      modes: {
        alternateScreen: this.isAlternate,
        bracketedPaste: this.term.modes.bracketedPasteMode,
        mouseTracking: this.term.modes.mouseTrackingMode !== 'none',
        applicationCursor: this.term.modes.applicationCursorKeysMode
      }
    }
  }

  /**
   * The whole buffer, with up to `scrollback` rows above the viewport (all of them when omitted),
   * then the DEC saved cursor and an absolute cursor position.
   */
  serialize(options?: { scrollback?: number }): string {
    const { x, y } = this.cursor()
    const core = (this.term as unknown as EmulatorInternals)._core
    const current = core?._inputHandler?._curAttrData
    let ansi = this.addon.serialize({ scrollback: options?.scrollback })

    const { savedX = 0, savedY = 0, savedCurAttrData } = core?.buffer ?? {}
    if (savedX !== 0 || savedY !== 0) {
      ansi += `\x1b[${savedY + 1};${savedX + 1}H${savedCurAttrData ? sgr(savedCurAttrData) : ''}\x1b7`
    }

    // the addon's relative cursor move is one column off after a full last row (xterm.js #6165),
    // and no cursor move can recreate a pending wrap, so print the row's last character again
    ansi += x >= this.term.cols ? this.pendingWrapCursor(y) : `\x1b[${y + 1};${x + 1}H`
    return current ? ansi + sgr(current) : ansi
  }

  /** Every row of the active buffer, oldest first. */
  lines(): Array<{ text: string; wrapped: boolean }> {
    const buffer = this.term.buffer.active
    const rows: Array<{ text: string; wrapped: boolean }> = []
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
    }
    return rows
  }

  /** Rows above the viewport in the normal buffer. */
  get scrollbackRows(): number {
    return this.term.buffer.normal.length - this.term.rows
  }

  get isAlternate(): boolean {
    return this.term.buffer.active.type === 'alternate'
  }

  dispose(): void {
    this.term.dispose()
  }

  private pendingWrapCursor(y: number): string {
    const buffer = this.term.buffer.active
    const line = buffer.getLine(buffer.baseY + y)
    let col = this.term.cols - 1
    let cell = line?.getCell(col)
    if (cell && cell.getWidth() === 0) cell = line?.getCell(--col)
    if (!cell || !cell.getChars()) return `\x1b[${y + 1};${this.term.cols}H`
    return `\x1b[${y + 1};${col + 1}H${sgr(cell)}${cell.getChars()}`
  }

  private cursor(): { x: number; y: number } {
    const buffer = this.term.buffer.active
    return { x: buffer.cursorX, y: buffer.cursorY }
  }
}
