import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { PtySnapshot } from '@quirky/protocol'
import {
  FEATURE_MS,
  bufferLines,
  focusTerminal,
  focusedSession,
  press,
  runCommand,
  splitPane,
  startFeatures,
  stopAll,
  termOf,
  viewReport,
  waitFor,
  waitReady,
  waitForScreen,
  type Features
} from './features-support'

afterEach(stopAll)

/** The session of the one pane the window shows, with its terminal ready for keys. */
async function firstPane(f: Features) {
  const report = await viewReport(f, 'a mounted pane')
  const session = focusedSession(report)
  await focusTerminal(f, session)
  return { session, pane: report.focusedPane! }
}

const numbered = (lines: string[]) => lines.filter((line) => /^\d+$/.test(line))

test(
  'SC-34: clear and reset',
  async () => {
    const f = await startFeatures()
    const { h } = f
    const { session } = await firstPane(f)
    await h.run(session, 'seq 1 500')
    await h.run(session, `printf '\\033[?1000h\\033[?1006h'`)
    const term = termOf(f, session)
    await waitFor('mouse reporting on in the pane', () => (term.modes.mouseTrackingMode !== 'none' ? true : undefined))
    await waitForScreen(f, session, 'line 500', (lines) => lines.includes('500'))
    expect(numbered(bufferLines(term)).length).toBeGreaterThan(400)

    await press('mod+k')
    const cleared = await waitForScreen(f, session, 'a cleared screen', (lines) => numbered(lines).length === 0)
    expect(cleared.filter((line) => line !== '').length).toBeLessThanOrEqual(2)
    expect(term.buffer.active.baseY).toBe(0)

    const rows = (await h.screen(session)).filter((line) => line !== '')
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(numbered(await h.screen(session))).toEqual([])
    expect(numbered((await h.ok(['terminal', 'history', session, '--lines', '600'])).split('\n'))).toEqual([])
    const reopened = await h.attach(session)
    expect(reopened.replayText).not.toContain('250')
    await reopened.detach()
    expect((await h.json<PtySnapshot>(['terminal', 'snapshot', session])).modes.mouseTracking).toBe(true)
    expect(term.modes.mouseTrackingMode).not.toBe('none')

    await waitReady(h, session)
    const commandOutput = await h.run(session, 'echo kept-text')
    const resetMarker = commandOutput.filter((line) => /^@@\d+@@$/.test(line)).at(-1)!
    await waitForScreen(f, session, 'kept-text', (lines) => lines.includes('kept-text'))
    // The shell-computed marker follows the content without appearing in the typed command.
    await waitForScreen(f, session, resetMarker, (lines) => lines.includes(resetMarker))
    expect(await runCommand(f, 'reset-terminal')).toEqual({ ok: true })
    await waitFor('modes off in the pane', () => (term.modes.mouseTrackingMode === 'none' ? true : undefined))
    const modes = (await h.json<PtySnapshot>(['terminal', 'snapshot', session])).modes
    expect(modes).toMatchObject({ mouseTracking: false, bracketedPaste: false, applicationCursor: false })
    expect(term.modes.bracketedPasteMode).toBe(false)
    expect(bufferLines(term)).toContain(resetMarker)
    expect(bufferLines(term)).toContain('kept-text')
    expect(await h.screen(session)).toContain('kept-text')
  },
  FEATURE_MS
)

test(
  'SC-35: zoom per pane',
  async () => {
    const f = await startFeatures()
    const { session: firstSession, pane } = await firstPane(f)
    const second = await splitPane(f.h, pane, 'right')
    await viewReport(f, 'two mounted panes', (report) => report.panes.length === 2 && report.focusedPane === second.pane.id)
    await focusTerminal(f, second.pane.session)
    const sizes = async (what: string, wanted: [number, number]) => {
      const report = await viewReport(f, what, (r) => r.panes.map((p) => p.fontSize).join() === wanted.join())
      return report.panes.map((p) => [p.pane, p.fontSize])
    }
    expect(await sizes('both panes at 14', [14, 14])).toEqual([
      [pane, 14],
      [second.pane.id, 14]
    ])

    for (let step = 0; step < 3; step += 1) await press('mod+=')
    expect(await sizes('the second pane at 17', [14, 17])).toEqual([
      [pane, 14],
      [second.pane.id, 17]
    ])
    expect(termOf(f, second.pane.session).options.fontSize).toBe(17)
    expect(termOf(f, firstSession).options.fontSize).toBe(14)

    await press('mod+0')
    await sizes('the second pane back at 14', [14, 14])
    for (let step = 0; step < 20; step += 1) await press('mod+-')
    await sizes('the second pane at the floor', [14, 8])
    for (let step = 0; step < 40; step += 1) await press('mod+shift+=')
    await sizes('the second pane at the ceiling', [14, 32])

    await runCommand(f, 'zoom-reset')
    await sizes('the second pane reset through the command', [14, 14])
    await runCommand(f, 'zoom-in', { pane })
    await sizes('the first pane zoomed through the command', [15, 14])
    await runCommand(f, 'zoom-out', { pane })
    await sizes('the first pane back', [14, 14])

    expect(f.calls.filter((call) => call.method === 'setting.set')).toEqual([])
    expect((await f.h.call<{ value: number }>('setting.get', { id: 'setting:quirky.terminal/font-size' })).value).toBe(14)
  },
  FEATURE_MS
)

test(
  'SC-36: selecting and copying',
  async () => {
    const f = await startFeatures()
    const { h } = f
    const { session, pane } = await firstPane(f)
    await h.run(session, `printf '  alpha\\n  beta\\n'`)
    const lines = await waitForScreen(f, session, 'the indented lines', (rows) => rows.includes('  beta'))
    const term = termOf(f, session)
    const row = lines.indexOf('  alpha')
    expect(lines[row + 1]).toBe('  beta')

    // happy-dom does no layout, so the drag across both lines is the selection it would make
    term.select(0, row, term.cols + '  beta'.length)
    expect(term.getSelection()).toBe('  alpha\n  beta')
    await press('mod+c')
    expect(f.clipboard.writes.at(-1)).toBe('alpha\nbeta')
    expect(await runCommand(f, 'copy')).toEqual({ text: 'alpha\nbeta' })

    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/trim-gutter-on-copy', 'false'])
    await waitFor('the setting to reach the window', async () => ((await runCommand(f, 'copy')).text === '  alpha\n  beta' ? true : undefined))
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/trim-gutter-on-copy', 'true'])
    await waitFor('the gutter to be trimmed again', async () => ((await runCommand(f, 'copy')).text === 'alpha\nbeta' ? true : undefined))

    term.clearSelection()
    const writes = f.clipboard.writes.length
    await press('mod+c')
    expect(await runCommand(f, 'copy')).toEqual({ text: '' })
    expect(f.clipboard.writes).toHaveLength(writes)

    expect(term.options.wordSeparator).toBe(" ()[]{}',\"`")
    expect(term.options.macOptionClickForcesSelection).toBe(true)
    const select = (term as unknown as { _core: { _selectionService: { _selectWordAt(at: [number, number], whitespace: boolean): void } } })._core._selectionService
    select._selectWordAt([4, row], true)
    expect(term.getSelection()).toBe('alpha')

    term.clearSelection()
    await press('mod+a')
    expect(term.hasSelection()).toBe(true)
    expect(term.getSelection()).toContain('  alpha')
    term.clearSelection()
    expect(await runCommand(f, 'select-all', { pane })).toEqual({ ok: true })
    expect(term.getSelection()).toContain('  beta')

    term.clearSelection()
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/copy-on-select', 'true'])
    await waitFor('copy on select to reach the window', async () => {
      term.select(2, row, 5)
      const host = term.element!.closest('[data-terminal-pane]')!
      host.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
      await Bun.sleep(50)
      return f.clipboard.writes.at(-1) === 'alpha' && f.clipboard.writes.length > writes ? true : undefined
    })
  },
  FEATURE_MS
)

/**
 * Starts a raw-mode reader of `bytes` bytes into `file` and waits until it is reading. The shell
 * assembles its two markers, so the typed command line never contains what is waited for.
 */
async function readBytes(f: Features, session: string, bytes: number, file: string, bracketed: boolean): Promise<void> {
  const on = bracketed ? `printf '\\033[?2004h'; ` : ''
  await f.h.type(session, `${on}stty raw -echo; printf 'READY-%s' ${bytes}; head -c ${bytes} > ${file}; stty sane; printf '\\033[?2004l'; printf 'done-%s' ${bytes}; echo`)
  await waitForScreen(f, session, `READY-${bytes}`, (rows) => rows.some((row) => row.includes(`READY-${bytes}`)))
}

/** Waits until the reader started by `readBytes` has all its bytes. */
const readDone = (f: Features, session: string, bytes: number, timeoutMs?: number) =>
  waitForScreen(f, session, `done-${bytes}`, (rows) => rows.some((row) => row.includes(`done-${bytes}`)), timeoutMs)

const fileText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '')
const pasteEvent = (text: string) => {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } })
  return event
}
const writesSince = (f: Features, from: number) => f.calls.slice(from).filter((call) => call.method === 'quirky.terminal/write').map((call) => call.params.data as string)

test(
  'SC-37: pasting',
  async () => {
    const f = await startFeatures()
    const { session } = await firstPane(f)
    const textarea = () => termOf(f, session).textarea!
    const START = '\x1b[200~'
    const END = '\x1b[201~'
    const body = (kib: number) => Array.from({ length: kib * 16 }, (_, line) => `line ${String(line).padStart(5, '0')} ${'x'.repeat(48)}`).join('\n')

    const small = body(10)
    const smallFile = `${f.h.home}/paste-small.bin`
    await readBytes(f, session, START.length + small.length + END.length, smallFile, true)
    textarea().value = 'stale'
    const from = f.calls.length
    const event = pasteEvent(small)
    textarea().dispatchEvent(event)
    await readDone(f, session, START.length + small.length + END.length)
    expect(event.defaultPrevented).toBe(true)
    expect(textarea().value).toBe('')
    expect(writesSince(f, from)).toEqual([`${START}${small.replaceAll('\n', '\r')}${END}`])
    expect(fileText(smallFile)).toBe(`${START}${small.replaceAll('\n', '\r')}${END}`)

    const large = body(200)
    const expected = large.replaceAll('\n', '\r')
    const largeFile = `${f.h.home}/paste-large.bin`
    await readBytes(f, session, START.length + expected.length + END.length, largeFile, true)
    const fromLarge = f.calls.length
    expect(await runCommand(f, 'paste', { text: large })).toEqual({ ok: true })
    await readDone(f, session, START.length + expected.length + END.length, 60_000)
    const chunks = writesSince(f, fromLarge)
    expect(chunks[0]).toBe(START)
    expect(chunks.at(-1)).toBe(END)
    const middle = chunks.slice(1, -1)
    expect(middle.length).toBeGreaterThanOrEqual(Math.ceil(expected.length / (16 * 1024)))
    expect(Math.max(...middle.map((chunk) => new TextEncoder().encode(chunk).length))).toBeLessThanOrEqual(16 * 1024)
    expect(middle.join('')).toBe(expected)
    expect(fileText(largeFile)).toBe(`${START}${expected}${END}`)

    const plain = body(1)
    const plainFile = `${f.h.home}/paste-plain.bin`
    await readBytes(f, session, plain.length, plainFile, false)
    const fromPlain = f.calls.length
    await runCommand(f, 'paste', { text: plain })
    await readDone(f, session, plain.length)
    expect(writesSince(f, fromPlain)).toEqual([plain.replaceAll('\n', '\r')])
    expect(fileText(plainFile)).toBe(plain.replaceAll('\n', '\r'))

    const fromHuge = f.calls.length
    textarea().dispatchEvent(pasteEvent('y'.repeat(20 * 1024 * 1024)))
    await waitFor('the refusal toast', () => ([...document.querySelectorAll('.toast-title')].some((toast) => toast.textContent === 'Paste is larger than 16 MiB') ? true : undefined))
    expect(writesSince(f, fromHuge)).toEqual([])
    expect(textarea().value).toBe('')
  },
  FEATURE_MS
)

test(
  'SC-38: dropping files types their paths',
  async () => {
    const f = await startFeatures()
    const { session } = await firstPane(f)
    // A mounted/focused pane can still be parsing replay with its input gate muted.
    // Wait for a shell-computed marker in this xterm, not just the host's ready state.
    const output = await f.h.run(session, ':')
    const readyMarker = output.filter((line) => /^@@\d+@@$/.test(line)).at(-1)!
    await waitForScreen(f, session, readyMarker, (lines) => lines.includes(readyMarker))
    const spaced = '/tmp/a b.txt'
    const plain = '/tmp/c.txt'
    const host = termOf(f, session).element!.closest('[data-terminal-pane]')!
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [{ path: spaced }, { path: plain }], types: ['Files'], getData: () => '' } })
    host.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    const typed = `'${spaced}' ${plain}`
    await waitFor('the paths at the prompt', async () => ((await f.h.screen(session)).some((line) => line.endsWith(typed)) ? true : undefined))
    // The echoed paths prove delivery; the exact write below proves no Enter was sent.
    const rows = await f.h.screen(session)
    expect(rows.filter((line) => line.includes(typed))).toHaveLength(1)
    expect(rows.some((line) => line.includes('command not found') || line.includes('no such file'))).toBe(false)
    expect(f.calls.filter((call) => call.method === 'quirky.terminal/write').map((call) => call.params.data)).toEqual([typed])
  },
  FEATURE_MS
)
