import { describe, expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { Screen } from '../src/screen'

const ESC = '\x1b'

function fresh(cols: number, rows: number, scrollback = 0): Terminal {
  return new Terminal({ cols, rows, scrollback, allowProposedApi: true })
}

function feed(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

interface Cell {
  text: string
  fg: number
  fgMode: number
}

function cells(term: Terminal): Cell[][] {
  const buffer = term.buffer.active
  const rows: Cell[][] = []
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y)!
    const row: Cell[] = []
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)!
      row.push({ text: cell.getChars(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode() })
    }
    rows.push(row)
  }
  return rows
}

async function roundTrip(screen: Screen, cols: number, rows: number): Promise<Terminal> {
  await screen.settled()
  const copy = fresh(cols, rows)
  await feed(copy, screen.snapshot().ansi)
  return copy
}

async function expectSameScreen(screen: Screen, cols: number, rows: number): Promise<Terminal> {
  const copy = await roundTrip(screen, cols, rows)
  const { cursor } = screen.snapshot()
  expect(cells(copy)).toEqual(cells(screenTerminal(screen)))
  expect({ x: copy.buffer.active.cursorX, y: copy.buffer.active.cursorY }).toEqual(cursor)
  return copy
}

// the emulator behind a Screen, which the round-trip is compared against
function screenTerminal(screen: Screen): Terminal {
  return (screen as unknown as { term: Terminal }).term
}

describe('Screen snapshot', () => {
  test('plain coloured text round-trips', async () => {
    const screen = new Screen({ cols: 20, rows: 5 })
    screen.write(`${ESC}[31mred${ESC}[0m plain ${ESC}[38;5;200mpink${ESC}[0m\r\n${ESC}[38;2;10;20;30mrgb${ESC}[0m`)
    await expectSameScreen(screen, 20, 5)
    expect(screen.snapshot().cursor).toEqual({ x: 3, y: 1 })
  })

  test('a full last row with the cursor at its end keeps the cursor column', async () => {
    const screen = new Screen({ cols: 10, rows: 3 })
    screen.write('\r\n\r\n')
    screen.write('0123456789')
    await screen.settled()
    const before = screen.snapshot().cursor
    const copy = await expectSameScreen(screen, 10, 3)
    expect(copy.buffer.active.cursorX).toBe(before.x)
    expect(copy.buffer.active.cursorY).toBe(2)
  })

  test('a pending wrap on an upper row survives, so the next character wraps', async () => {
    const screen = new Screen({ cols: 10, rows: 4 })
    screen.write(`${ESC}[33m0123456789${ESC}[0m\r\nbelow${ESC}[1;11H${ESC}[34m`)
    screen.write(`${ESC}[1;10H${ESC}[33m9`)
    await screen.settled()
    const copy = await expectSameScreen(screen, 10, 4)
    const original = screenTerminal(screen)
    await Promise.all([feed(copy, 'Z'), feed(original, 'Z')])
    expect(cells(copy)).toEqual(cells(original))
  })

  test('the DEC saved cursor is restored by ESC 8 in a fresh terminal', async () => {
    const screen = new Screen({ cols: 20, rows: 5 })
    screen.write(`${ESC}[3;7H${ESC}7${ESC}[1;1Hhello${ESC}[5;3H`)
    await screen.settled()
    const copy = await roundTrip(screen, 20, 5)
    await feed(copy, `${ESC}8`)
    expect({ x: copy.buffer.active.cursorX, y: copy.buffer.active.cursorY }).toEqual({ x: 6, y: 2 })
  })

  test('saved attributes survive when the saved cursor is at the origin', async () => {
    const screen = new Screen({ cols: 10, rows: 3 })
    screen.write(`${ESC}[31m${ESC}7${ESC}[0mhello`)
    await screen.settled()
    const copy = await roundTrip(screen, 10, 3)
    for (const term of [screenTerminal(screen), copy]) {
      await feed(term, `${ESC}8X`)
      const cell = term.buffer.active.getLine(0)!.getCell(0)!
      expect({ text: cell.getChars(), fg: cell.getFgColor(), fgMode: cell.getFgColorMode() }).toEqual({
        text: 'X',
        fg: 1,
        fgMode: 0x1000000
      })
    }
  })

  test('the saved cursor row is viewport-relative after the screen has scrolled', async () => {
    const screen = new Screen({ cols: 10, rows: 3, scrollback: 100 })
    screen.write(`1\r\n2\r\n3\r\n4\r\n5\r\n${ESC}[1;3H${ESC}7${ESC}[3;1H`)
    await screen.settled()
    const copy = await roundTrip(screen, 10, 3)
    for (const term of [screenTerminal(screen), copy]) {
      await feed(term, `${ESC}8`)
      expect({ x: term.buffer.active.cursorX, y: term.buffer.active.cursorY }).toEqual({ x: 2, y: 0 })
    }
  })

  test('output inside a scroll region round-trips', async () => {
    const screen = new Screen({ cols: 10, rows: 8 })
    screen.write('top\r\n')
    screen.write(`${ESC}[2;5r${ESC}[2;1H`)
    for (let i = 1; i <= 7; i++) screen.write(`line${i}\r\n`)
    await expectSameScreen(screen, 10, 8)
  })

  test('alternate screen, modes, colours and cursor round-trip', async () => {
    const screen = new Screen({ cols: 20, rows: 6 })
    screen.write('shell prompt$ ')
    screen.write(`${ESC}[?1049h${ESC}[?2004h${ESC}[?1000h${ESC}[?1006h${ESC}[?1h`)
    screen.write(`${ESC}[2J${ESC}[H${ESC}[32mframe${ESC}[0m${ESC}[3;4H${ESC}[34mbox${ESC}[0m${ESC}[5;7H`)
    await screen.settled()
    const snapshot = screen.snapshot()
    expect(snapshot.modes).toEqual({
      alternateScreen: true,
      bracketedPaste: true,
      mouseTracking: true,
      applicationCursor: true
    })
    expect(screen.isAlternate).toBe(true)
    const copy = await expectSameScreen(screen, 20, 6)
    expect(copy.buffer.active.type).toBe('alternate')
    expect(copy.modes.bracketedPasteMode).toBe(true)
    expect(copy.modes.applicationCursorKeysMode).toBe(true)
    expect(copy.modes.mouseTrackingMode).not.toBe('none')
    expect(snapshot.cursor).toEqual({ x: 6, y: 4 })
  })

  test('modes are off for a plain screen', async () => {
    const screen = new Screen({ cols: 10, rows: 3 })
    screen.write('hi')
    await screen.settled()
    expect(screen.snapshot().modes).toEqual({
      alternateScreen: false,
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false
    })
  })
})

describe('Screen query replies', () => {
  test('replies reach onReply unless seeding', async () => {
    const replies: string[] = []
    const screen = new Screen({ cols: 10, rows: 3, onReply: (bytes) => replies.push(new TextDecoder().decode(bytes)) })
    screen.write(`ab${ESC}[6n`)
    await screen.settled()
    expect(replies).toEqual([`${ESC}[1;3R`])

    screen.seeding = true
    screen.write(`${ESC}[6n`)
    await screen.settled()
    expect(replies).toHaveLength(1)

    screen.seeding = false
    screen.write(`${ESC}[6n`)
    await screen.settled()
    expect(replies).toHaveLength(2)
  })
})

describe('Screen scrollback', () => {
  test('serialize with scrollback reproduces earlier lines in a fresh terminal', async () => {
    const screen = new Screen({ cols: 20, rows: 5, scrollback: 100 })
    for (let i = 1; i <= 50; i++) screen.write(`line ${i}\r\n`)
    await screen.settled()
    expect(screen.scrollbackRows).toBeGreaterThan(40)

    const copy = fresh(20, 5, 100)
    await feed(copy, screen.serialize({ scrollback: 100 }))
    const texts = (term: Terminal) =>
      Array.from({ length: term.buffer.active.length }, (_, y) => term.buffer.active.getLine(y)!.translateToString(true))
    expect(texts(copy)).toEqual(texts(screenTerminal(screen)))
    expect(texts(copy)).toContain('line 1')
    expect(texts(copy)).toContain('line 50')
    expect(copy.buffer.active.cursorY).toBe(screenTerminal(screen).buffer.active.cursorY)
    expect(copy.buffer.active.cursorX).toBe(screenTerminal(screen).buffer.active.cursorX)
  })

  test('lines reports wrapped rows', async () => {
    const screen = new Screen({ cols: 10, rows: 5, scrollback: 10 })
    screen.write('x'.repeat(25) + '\r\nshort')
    await screen.settled()
    const lines = screen.lines()
    expect(lines.slice(0, 4)).toEqual([
      { text: 'x'.repeat(10), wrapped: false },
      { text: 'x'.repeat(10), wrapped: true },
      { text: 'x'.repeat(5), wrapped: true },
      { text: 'short', wrapped: false }
    ])
    expect(lines).toHaveLength(5)
  })

  test('a screen with scrollback 0 keeps none', async () => {
    const screen = new Screen({ cols: 20, rows: 5 })
    for (let i = 0; i < 200; i++) screen.write(`line ${i}\r\n`)
    await screen.settled()
    expect(screen.scrollbackRows).toBe(0)
  })
})
