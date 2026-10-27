import { describe, expect, test } from 'bun:test'
import type { SubmitSignal } from '../../src/core/types'
import { createReadyScanner } from '../../src/core/ready'
import { GROK_INLINE_STARTUP_PTY_TRACE } from './fixtures/grok-inline-startup-pty-trace'
import { GROK_STARTUP_PTY_TRACE, type GrokStartupTraceChunk } from './fixtures/grok-startup-pty-trace'

const QUIET_MS = 1500
const OPENCODE_GRACE_MS = 5000
const HARD_TIMEOUT_MS = 8000

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const CODEX_PROMPT = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const CODEX_DYNAMIC_PROMPT = '\x1b[1m›\x1b[0m Implement {feature}'
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const ALT_SCREEN_LEAVE = '\x1b[?1049l'
const GROK_ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[?2004h\x1b[?25l'
const GROK_ALT_SCREEN_LEAVE = '\x1b[?1049l\x1b[?25h'
const GROK_COMPOSER_FRAME = '\x1b[38;2;80;80;88m│\x1b[38;2;200;200;200m❯ \x1b[0m'

type Step = { ready: boolean; due: number | null }
const NOT_READY: Step = { ready: false, due: null }
const READY: Step = { ready: true, due: null }
const QUIET: Step = { ready: false, due: QUIET_MS }
const GRACE: Step = { ready: false, due: OPENCODE_GRACE_MS }

/** A scanner on a clock that only moves when asked; `due` is ms from now until it could turn ready. */
function rig(signal: SubmitSignal) {
  const scanner = createReadyScanner(signal)
  let now = 0
  return {
    scanner,
    step(chunk: string | Uint8Array, advance = 0): Step {
      now += advance
      scanner.push(chunk, now)
      const next = scanner.nextCheckAt()
      return { ready: scanner.isReady(now), due: next === null ? null : next - now }
    }
  }
}

describe('render-cursor-after-bracketed-paste (opencode / mimo-code)', () => {
  const make = () => rig('render-cursor-after-bracketed-paste')

  test('is ready when show-cursor renders after bracketed paste in one chunk', () => {
    expect(make().step(`${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}`)).toEqual(READY)
  })

  test('does not fire on bracketed paste alone, then fires once show-cursor arrives', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
    expect(r.step('startup banner output')).toEqual(NOT_READY)
    expect(r.step(SHOW_CURSOR)).toEqual(READY)
  })

  test('resolves from a single replayed buffer holding both markers', () => {
    expect(make().step(`banner\n${DECSET_BRACKETED_PASTE}composer\n${SHOW_CURSOR}rest`)).toEqual(READY)
  })

  test('detects a bracketed-paste handshake split across a chunk boundary', () => {
    const r = make()
    expect(r.step('\x1b[?20')).toEqual(NOT_READY)
    expect(r.step('04h')).toEqual(NOT_READY)
    expect(r.step(SHOW_CURSOR)).toEqual(READY)
  })

  test('detects show-cursor split across a later chunk boundary', () => {
    const r = make()
    r.step(DECSET_BRACKETED_PASTE)
    expect(r.step('render noise \x1b[?')).toEqual(NOT_READY)
    expect(r.step('25h')).toEqual(READY)
  })

  test('never arms the quiet window during the silent pre-composer gap', () => {
    const r = make()
    r.step(DECSET_BRACKETED_PASTE)
    for (let i = 0; i < 5; i += 1) {
      expect(r.step(`setup output ${i}`, 400)).toEqual(NOT_READY)
    }
    expect(r.scanner.isReady(60_000)).toBe(false)
  })

  test('does not treat hide-cursor as the ready signal', () => {
    expect(make().step(`${DECSET_BRACKETED_PASTE}${HIDE_CURSOR}`)).toEqual(NOT_READY)
  })

  test('never joins a show-cursor across a chunk seam from bytes it already scanned', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE).ready).toBe(false)
    expect(r.step('Search \x1b[?25').ready).toBe(false)
    expect(r.step('l more text').ready).toBe(false)
  })

  test('ignores a show-cursor after the shell turns bracketed paste back off to run a command', () => {
    const r = make()
    expect(r.step(`${DECSET_BRACKETED_PASTE}% opencode`).ready).toBe(false)
    expect(r.step(`${DECRST_BRACKETED_PASTE}\r\n`).ready).toBe(false)
    expect(r.step(`${HIDE_CURSOR}resolving${SHOW_CURSOR}`).ready).toBe(false)
    expect(r.step(`${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}`)).toEqual(READY)
  })

  test('ignores show-cursor that appears before bracketed paste is enabled', () => {
    const r = make()
    expect(r.step(SHOW_CURSOR)).toEqual(NOT_READY)
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
  })
})

describe('opencode-agent-row', () => {
  // Frame shapes from an OpenCode 2 cold start: the box with its bottom-left corner on row 25, then
  // a later frame painting `<agent> · <model>` on row 24 above it.
  const frame = (body: string): string => `\x1b[?2026h${HIDE_CURSOR}${body}\x1b[22;27H${SHOW_CURSOR}\x1b[?2026l`
  const BOX = `${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${frame(
    '\x1b[21;24H┃\x1b[22;24H┃\x1b[23;24H┃\x1b[24;24H┃\x1b[25;24H╹'
  )}`
  const AGENT_ROW = frame('\x1b[24;27HBuild\x1b[24;33H·\x1b[24;35HSome Model')
  const make = () => rig('opencode-agent-row')

  test('is not ready on the input box and its cursor alone, and asks for the grace timer', () => {
    expect(make().step(BOX)).toEqual(GRACE)
  })

  test('turns ready once the grace has passed without the row', () => {
    const r = make()
    r.step(BOX)
    expect(r.scanner.nextCheckAt()).toBe(OPENCODE_GRACE_MS)
    expect(r.scanner.isReady(OPENCODE_GRACE_MS - 1)).toBe(false)
    expect(r.scanner.isReady(OPENCODE_GRACE_MS)).toBe(true)
  })

  test('is ready once the row directly above the box corner paints its separator', () => {
    const r = make()
    r.step(BOX)
    expect(r.step(AGENT_ROW)).toEqual(READY)
  })

  test('is ready when OpenCode 1 paints the row before the corner in the same frame', () => {
    const opencode1Box = frame('\x1b[23;27HBuild\x1b[23;33H·\x1b[24;24H╹')
    expect(make().step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${opencode1Box}`).ready).toBe(true)
  })

  test('pairs a separator with a later corner only inside the same synchronized frame', () => {
    const separatorFrame = frame('\x1b[23;33H·')
    const cornerFrame = frame('\x1b[24;24H╹')
    expect(
      make().step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${separatorFrame}${cornerFrame}`).ready
    ).toBe(false)
  })

  test('ignores a separator in the footer path under the box', () => {
    const r = make()
    r.step(BOX)
    expect(r.step(frame('\x1b[26;24H~/col·lecció/work'))).toEqual(GRACE)
  })

  test('ignores a separator in a session tab title', () => {
    const r = make()
    r.step(BOX)
    expect(r.step(frame('\x1b[1;4Hx\x1b[1;5H·\x1b[1;6Hy'))).toEqual(GRACE)
  })

  test('ignores a separator a shell prompt draws before OpenCode enters the alternate screen', () => {
    const r = make()
    expect(r.step(`${DECSET_BRACKETED_PASTE}~ · main % opencode${DECRST_BRACKETED_PASTE}`)).toEqual(NOT_READY)
    expect(r.step(BOX).ready).toBe(false)
  })

  test('does not keep a row from an earlier alternate-screen session', () => {
    const r = make()
    const rowWithoutCursor = '\x1b[25;24H╹\x1b[24;33H\u00b7'
    expect(r.step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${rowWithoutCursor}`).ready).toBe(false)
    r.step(ALT_SCREEN_LEAVE)
    expect(r.step(BOX)).toEqual(GRACE)
  })

  test('does not latch a part an earlier session established and then revoked', () => {
    const leftApp = make()
    leftApp.step(`${ALT_SCREEN_ENTER}x · y${ALT_SCREEN_LEAVE}`)
    expect(leftApp.step(BOX)).toEqual(GRACE)
    const shell = make()
    shell.step(`${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}${DECRST_BRACKETED_PASTE}`)
    expect(shell.step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}footer · path`).ready).toBe(false)
  })

  test('withdraws the grace when OpenCode leaves the alternate screen before its row', () => {
    const r = make()
    expect(r.step(BOX)).toEqual(GRACE)
    expect(r.step(`${ALT_SCREEN_LEAVE}${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}`)).toEqual(NOT_READY)
    expect(r.step(BOX)).toEqual(GRACE)
  })

  test('withdraws the grace timer when bracketed paste is turned off', () => {
    const r = make()
    expect(r.step(BOX)).toEqual(GRACE)
    expect(r.step(DECRST_BRACKETED_PASTE)).toEqual(NOT_READY)
  })

  test('withdraws readiness-to-be when bracketed paste is turned off before the row', () => {
    const r = make()
    r.step(BOX)
    r.step(DECRST_BRACKETED_PASTE, 1000)
    expect(r.scanner.isReady(OPENCODE_GRACE_MS + 1)).toBe(false)
  })

  test('needs the box cursor shown while bracketed paste is held, not one a shell showed', () => {
    const r = make()
    r.step(`${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}${DECRST_BRACKETED_PASTE}`)
    const rowWithoutCursor = '\x1b[25;24H╹\x1b[24;33H·'
    expect(r.step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${rowWithoutCursor}`).ready).toBe(false)
  })

  test('never arms the quiet window', () => {
    const r = make()
    r.step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}some frame`)
    expect(r.scanner.nextCheckAt()).toBeNull()
    expect(r.scanner.isReady(60_000)).toBe(false)
  })
})

describe('codex-composer-prompt', () => {
  const make = () => rig('codex-composer-prompt')

  test('is ready on the composer glyph after bracketed paste and never arms the quiet timer', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
    expect(r.step(CODEX_PROMPT)).toEqual(READY)
  })

  test('detects the composer glyph inside a large first render chunk', () => {
    expect(make().step(`${DECSET_BRACKETED_PASTE}${CODEX_PROMPT}${'x'.repeat(900)}`)).toEqual(READY)
  })

  test('is ready when Codex renders its composer before enabling bracketed paste', () => {
    const r = make()
    expect(r.step(`${ALT_SCREEN_ENTER}${CODEX_DYNAMIC_PROMPT}`)).toEqual(NOT_READY)
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(READY)
  })

  test('forgets a pre-anchor glyph when Codex leaves the alternate screen', () => {
    const r = make()
    r.step(`${ALT_SCREEN_ENTER}${CODEX_DYNAMIC_PROMPT}${ALT_SCREEN_LEAVE}`)
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
  })

  test('ignores a stale shell glyph before bracketed paste is enabled', () => {
    const r = make()
    expect(r.step('› codex\r\nstartup output')).toEqual(NOT_READY)
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
  })

  test('never arms the quiet-window fallback', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(NOT_READY)
    expect(r.step('noise')).toEqual(NOT_READY)
    expect(r.scanner.isReady(60_000)).toBe(false)
  })
})

describe('grok-composer-prompt', () => {
  const make = () => rig('grok-composer-prompt')

  test('is ready on the composer glyph after the alternate-screen switch', () => {
    const r = make()
    expect(r.step(GROK_ALT_SCREEN_ENTER)).toEqual(QUIET)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(READY)
  })

  test('SC-21: a glyph before the alternate screen never counts', () => {
    const r = make()
    expect(r.step(`${DECSET_BRACKETED_PASTE}\x1b[32m❯\x1b[0m grok\r\n`)).toEqual(QUIET)
    expect(r.step(GROK_ALT_SCREEN_ENTER)).toEqual(QUIET)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(READY)
  })

  test('resolves from a single replayed buffer holding both markers', () => {
    expect(make().step(`${GROK_ALT_SCREEN_ENTER}logo frames${GROK_COMPOSER_FRAME}`)).toEqual(READY)
  })

  test('keeps arming the quiet window so a missed composer frame still delivers', () => {
    const r = make()
    r.step(GROK_ALT_SCREEN_ENTER)
    expect(r.step('logo shimmer frame')).toEqual(QUIET)
  })

  test('arms the quiet window from DECSET 2004 when grok renders inline', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(QUIET)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(QUIET)
  })

  test('does not treat a legacy-console `> ` prompt as the glyph', () => {
    const r = make()
    r.step(GROK_ALT_SCREEN_ENTER)
    expect(r.step('\x1b[38;2;80;80;88m│\x1b[0m> ')).toEqual(QUIET)
  })

  test('disarms when grok leaves the alternate screen before painting a composer', () => {
    const r = make()
    r.step(GROK_ALT_SCREEN_ENTER)
    expect(r.step(GROK_ALT_SCREEN_LEAVE)).toEqual(QUIET)
    expect(r.step('\x1b[32m❯\x1b[0m ')).toEqual(QUIET)
  })

  test('ignores a shell prompt after an rc-file program used the alternate screen', () => {
    const r = make()
    expect(r.step(`rc pager${GROK_ALT_SCREEN_ENTER}paged${GROK_ALT_SCREEN_LEAVE}`)).toEqual(QUIET)
    expect(r.step(`${DECSET_BRACKETED_PASTE}\x1b[32m❯\x1b[0m grok\r\n`)).toEqual(QUIET)
    expect(r.step(GROK_ALT_SCREEN_ENTER)).toEqual(QUIET)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(READY)
  })

  test('ignores a glyph that precedes the alt-screen switch inside one chunk', () => {
    expect(make().step(`❯ ${GROK_ALT_SCREEN_ENTER}`)).toEqual(QUIET)
  })

  test('does not fire on a glyph that lands after the leave inside one chunk', () => {
    const r = make()
    r.step(GROK_ALT_SCREEN_ENTER)
    expect(r.step(`${GROK_ALT_SCREEN_LEAVE}\x1b[32m❯\x1b[0m `)).toEqual(QUIET)
  })

  test('detects the alt-screen anchor split across a chunk boundary', () => {
    const r = make()
    expect(r.step('\x1b[?10')).toEqual(NOT_READY)
    expect(r.step('49h')).toEqual(NOT_READY)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(READY)
  })
})

describe('dsh-composer-prompt', () => {
  test('has the grok shape: glyph after the alternate screen, quiet window as the floor', () => {
    const r = rig('dsh-composer-prompt')
    expect(r.step(`${DECSET_BRACKETED_PASTE}❯ shell`)).toEqual(QUIET)
    expect(r.step(ALT_SCREEN_ENTER)).toEqual(QUIET)
    expect(r.step(GROK_COMPOSER_FRAME)).toEqual(READY)
  })
})

describe('zcode-composer-prompt', () => {
  const make = () => rig('zcode-composer-prompt')

  test('is ready on the composer box corner after the alternate-screen switch', () => {
    const r = make()
    expect(r.step(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}banner`)).toEqual(QUIET)
    expect(r.step('\x1b[2;1H╭──────╮')).toEqual(READY)
  })

  test('a powerline corner drawn before the alternate screen never counts', () => {
    const r = make()
    expect(r.step(`${DECSET_BRACKETED_PASTE}╭─ ~/work`)).toEqual(QUIET)
    expect(r.step(ALT_SCREEN_ENTER)).toEqual(QUIET)
  })

  test('a corner after leaving the alternate screen never counts', () => {
    const r = make()
    r.step(ALT_SCREEN_ENTER)
    expect(r.step(`${ALT_SCREEN_LEAVE}╭─ ~/work`).ready).toBe(false)
  })

  test('the glyph signals do not accept each other markers', () => {
    const grok = rig('grok-composer-prompt')
    grok.step(ALT_SCREEN_ENTER)
    expect(grok.step('╭──╮').ready).toBe(false)
    const zcode = make()
    zcode.step(ALT_SCREEN_ENTER)
    expect(zcode.step('❯ ').ready).toBe(false)
  })
})

describe('a stream that never carries DECSET 2004', () => {
  const ANCHORLESS_OPENCODE_FRAME = `${HIDE_CURSOR}\x1b[2J\x1b[H opencode ${SHOW_CURSOR}`

  test('never reports opencode ready from show-cursor frames alone', () => {
    const r = rig('render-cursor-after-bracketed-paste')
    for (let frame = 0; frame < 5; frame += 1) {
      expect(r.step(ANCHORLESS_OPENCODE_FRAME)).toEqual(NOT_READY)
    }
  })

  test('never arms the default quiet window either', () => {
    expect(rig('render-quiet-after-bracketed-paste').step(ANCHORLESS_OPENCODE_FRAME)).toEqual(NOT_READY)
  })

  test('never reports the Codex composer glyph ready without its anchor', () => {
    expect(rig('codex-composer-prompt').step(`${ALT_SCREEN_ENTER}${CODEX_PROMPT}`)).toEqual(NOT_READY)
  })
})

describe('render-quiet-after-bracketed-paste (default)', () => {
  const make = () => rig('render-quiet-after-bracketed-paste')

  test('arms the quiet timer after bracketed paste and never reports a signal', () => {
    const r = make()
    expect(r.step(DECSET_BRACKETED_PASTE)).toEqual(QUIET)
    expect(r.step(SHOW_CURSOR)).toEqual(QUIET)
  })

  test('does nothing until bracketed paste is enabled', () => {
    expect(make().step('pre-handshake output')).toEqual(NOT_READY)
  })

  test('SC-21: turns ready only once the quiet window has passed since the last output', () => {
    const scanner = createReadyScanner('render-quiet-after-bracketed-paste')
    scanner.push(DECSET_BRACKETED_PASTE, 100)
    expect(scanner.nextCheckAt()).toBe(100 + QUIET_MS)
    expect(scanner.isReady(100 + QUIET_MS - 1)).toBe(false)
    scanner.push('more output', 900)
    expect(scanner.nextCheckAt()).toBe(900 + QUIET_MS)
    expect(scanner.isReady(100 + QUIET_MS)).toBe(false)
    expect(scanner.isReady(900 + QUIET_MS - 1)).toBe(false)
    expect(scanner.isReady(900 + QUIET_MS)).toBe(true)
  })

  test('a chunk that arrives after the window has passed finds the scanner already ready', () => {
    const scanner = createReadyScanner('render-quiet-after-bracketed-paste')
    scanner.push(DECSET_BRACKETED_PASTE, 0)
    scanner.push('late output', 5000)
    expect(scanner.isReady(5000)).toBe(true)
    expect(scanner.nextCheckAt()).toBeNull()
  })

  test('stays ready once ready', () => {
    const scanner = createReadyScanner('render-quiet-after-bracketed-paste')
    scanner.push(DECSET_BRACKETED_PASTE, 0)
    expect(scanner.isReady(QUIET_MS)).toBe(true)
    scanner.push('output after', QUIET_MS + 10)
    expect(scanner.isReady(QUIET_MS + 10)).toBe(true)
  })
})

describe('marker signals report ready at the push time, with nothing left to wait for', () => {
  test('nextCheckAt is null once a marker has fired', () => {
    const scanner = createReadyScanner('grok-composer-prompt')
    scanner.push(GROK_ALT_SCREEN_ENTER, 0)
    scanner.push(GROK_COMPOSER_FRAME, 200)
    expect(scanner.isReady(200)).toBe(true)
    expect(scanner.nextCheckAt()).toBeNull()
  })
})

describe('chunk boundaries', () => {
  const encoder = new TextEncoder()
  const CODEX_FULLSCREEN = `${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${CODEX_PROMPT}`
  const streams: Array<{ signal: SubmitSignal; stream: string; ready: boolean }> = [
    { signal: 'render-cursor-after-bracketed-paste', stream: `x${DECSET_BRACKETED_PASTE}y${SHOW_CURSOR}`, ready: true },
    { signal: 'render-cursor-after-bracketed-paste', stream: `${DECSET_BRACKETED_PASTE}Search \x1b[?25l more`, ready: false },
    { signal: 'grok-composer-prompt', stream: `${GROK_ALT_SCREEN_ENTER}logo${GROK_COMPOSER_FRAME}`, ready: true },
    { signal: 'grok-composer-prompt', stream: `❯ shell${GROK_ALT_SCREEN_ENTER}${GROK_ALT_SCREEN_LEAVE}❯ `, ready: false },
    { signal: 'dsh-composer-prompt', stream: `${ALT_SCREEN_ENTER}${GROK_COMPOSER_FRAME}`, ready: true },
    { signal: 'zcode-composer-prompt', stream: `${ALT_SCREEN_ENTER}╭──╮`, ready: true },
    { signal: 'codex-composer-prompt', stream: `${DECSET_BRACKETED_PASTE}${CODEX_PROMPT}`, ready: true },
    { signal: 'codex-composer-prompt', stream: CODEX_FULLSCREEN, ready: true }
  ]

  test.each(streams)('$signal reads the same one byte at a time as in one piece ($stream)', ({ signal, stream, ready }) => {
    const whole = createReadyScanner(signal)
    whole.push(stream, 0)
    expect(whole.isReady(0)).toBe(ready)
    const bytes = encoder.encode(stream)
    const split = createReadyScanner(signal)
    for (const byte of bytes) {
      split.push(new Uint8Array([byte]), 0)
    }
    expect(split.isReady(0)).toBe(ready)
  })

  test('every two-way split of a grok stream finds the glyph', () => {
    const bytes = encoder.encode(`pre${GROK_ALT_SCREEN_ENTER}logo${GROK_COMPOSER_FRAME}`)
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const scanner = createReadyScanner('grok-composer-prompt')
      scanner.push(bytes.slice(0, cut), 0)
      scanner.push(bytes.slice(cut), 0)
      expect(scanner.isReady(0)).toBe(true)
    }
  })

  test('a multi-byte glyph split inside its UTF-8 bytes is still recognised', () => {
    const glyph = encoder.encode('❯')
    expect(glyph.length).toBe(3)
    const scanner = createReadyScanner('grok-composer-prompt')
    scanner.push(GROK_ALT_SCREEN_ENTER, 0)
    scanner.push(glyph.slice(0, 1), 0)
    expect(scanner.isReady(0)).toBe(false)
    scanner.push(glyph.slice(1, 2), 0)
    expect(scanner.isReady(0)).toBe(false)
    scanner.push(glyph.slice(2), 0)
    expect(scanner.isReady(0)).toBe(true)
  })

  test('bytes and strings can be mixed', () => {
    const scanner = createReadyScanner('render-cursor-after-bracketed-paste')
    scanner.push(encoder.encode('\x1b[?200'), 0)
    scanner.push('4h', 0)
    scanner.push(encoder.encode(SHOW_CURSOR), 0)
    expect(scanner.isReady(0)).toBe(true)
  })

  test('an escape sequence split in the middle of a Codex frame still reads the frame', () => {
    const scanner = createReadyScanner('codex-composer-prompt')
    const frame = encoder.encode(`${DECSET_BRACKETED_PASTE}${CODEX_PROMPT}`)
    scanner.push(frame.slice(0, 5), 0)
    scanner.push(frame.slice(5, 20), 0)
    scanner.push(frame.slice(20), 0)
    expect(scanner.isReady(0)).toBe(true)
  })

  test('the quiet-window anchor split across chunks arms the window at the second chunk', () => {
    const scanner = createReadyScanner('render-quiet-after-bracketed-paste')
    scanner.push('\x1b[?20', 0)
    expect(scanner.nextCheckAt()).toBeNull()
    scanner.push('04h', 50)
    expect(scanner.nextCheckAt()).toBe(50 + QUIET_MS)
  })
})

// Replays recorded grok startup output: grok shimmers its logo until the session opens, so the
// plain quiet window never settles and only the composer marker (alternate-screen mode) or the
// quiet floor (inline mode) can deliver before the hard timeout.
describe('grok startup trace replay', () => {
  const chunkData = (chunk: GrokStartupTraceChunk): string => chunk.data ?? 'x'.repeat(chunk.bytes ?? 0)

  /**
   * The ms offset at which a runner would have pasted: the marker frame, or the first quiet window
   * that elapses without another chunk. null means the hard timeout wins, and a quiet window that
   * lands past it is too late.
   */
  function replayReadyAtMs(signal: SubmitSignal, trace: GrokStartupTraceChunk[]): number | null {
    const scanner = createReadyScanner(signal)
    for (const chunk of trace) {
      const due = scanner.nextCheckAt()
      const settledAt = due !== null ? Math.min(due, HARD_TIMEOUT_MS) : HARD_TIMEOUT_MS
      if (chunk.t >= settledAt) {
        return due !== null && due <= HARD_TIMEOUT_MS ? due : null
      }
      scanner.push(chunkData(chunk), chunk.t)
      if (scanner.isReady(chunk.t)) {
        return chunk.t
      }
    }
    const due = scanner.nextCheckAt()
    return due !== null && due < HARD_TIMEOUT_MS ? due : null
  }

  describe('alternate-screen mode', () => {
    test('delivers on the composer frame instead of waiting out the hard timeout', () => {
      const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)
      expect(readyAt).not.toBeNull()
      expect(readyAt).toBeLessThan(1000)
    })

    test('never settles the quiet window under the shimmering logo', () => {
      expect(replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_STARTUP_PTY_TRACE)).toBeNull()
    })

    test('fires on the same frame that paints the composer box', () => {
      const composerFrame = GROK_STARTUP_PTY_TRACE.find((chunk) => chunk.data?.includes('❯'))
      expect(composerFrame).toBeDefined()
      expect(replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)).toBe(composerFrame?.t ?? null)
    })
  })

  describe('inline mode, no alternate screen', () => {
    test('still delivers through the quiet window when the marker never anchors', () => {
      const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)
      expect(readyAt).not.toBeNull()
      expect(readyAt).toBeLessThan(HARD_TIMEOUT_MS)
    })

    test('matches the default signal exactly, so inline launches keep their timing', () => {
      expect(replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)).toBe(
        replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_INLINE_STARTUP_PTY_TRACE)
      )
    })

    test('reports the hard timeout, not a late marker', () => {
      const lateMarker: GrokStartupTraceChunk[] = [
        { t: 0, data: '\x1b[?1049h' },
        { t: 8500, data: '\x1b[38;2;200;200;200m❯ ' }
      ]
      expect(replayReadyAtMs('grok-composer-prompt', lateMarker)).toBeNull()
    })

    test('records a startup with no alternate-screen switch', () => {
      expect(GROK_INLINE_STARTUP_PTY_TRACE.some((chunk) => chunk.data?.includes('\x1b[?1049h'))).toBe(false)
      expect(GROK_INLINE_STARTUP_PTY_TRACE.some((chunk) => chunk.data?.includes('❯'))).toBe(true)
    })
  })
})
