import { afterEach, expect, test } from 'bun:test'
import type { DesktopShellBridge } from '@quirky/protocol'
import {
  FEATURE_MS,
  bufferLines,
  focusTerminal,
  focusedSession,
  layoutOf,
  press,
  runCommand,
  startFeatures,
  stopAll,
  tabsOf,
  termOf,
  until,
  viewReport,
  waitFor,
  waitForScreen,
  type Features
} from './features-support'

afterEach(stopAll)

async function firstPane(f: Features) {
  const report = await viewReport(f, 'a mounted pane')
  const session = focusedSession(report)
  await focusTerminal(f, session)
  return { session, pane: report.focusedPane! }
}

const writes = (f: Features, from = 0) => f.calls.slice(from).filter((call) => call.method === 'quirky.terminal/write')
const setSetting = (f: Features, name: string, value: string) => f.h.ok(['setting', 'set', `setting:quirky.terminal/${name}`, value])

/** The window's own view of the context keys the plugin sets, which a key press is checked against. */
const contextKey = (f: Features, key: string): boolean | undefined => (f.win.host as unknown as { contextValues: Map<string, boolean> }).contextValues.get(key)

test(
  'SC-37: native Cmd+V bypasses WebKit clipboard permission and preserves bracketed paste mode',
  async () => {
    let text = ''
    let nativeFailure = false
    const unsupported = async (): Promise<never> => { throw new Error('not used in this clipboard scenario') }
    const desktopBridge: DesktopShellBridge = {
      capabilities: {
        directoryPicker: false, auxiliaryWindows: false, revealItem: false,
        notifications: { permission: false, click: false, dismiss: false }
      },
      nativeDropPaths: async () => null,
      readClipboardText: async () => {
        if (nativeFailure) throw new Error('native pasteboard unavailable')
        return text
      },
      pickFolder: unsupported, openWindow: unsupported, closeWindow: unsupported,
      revealItem: unsupported, activateOwner: unsupported
    }
    const f = await startFeatures({ desktopBridge })
    const { session } = await firstPane(f)
    // A mounted pane is not yet proof that the replay/input gate has opened.
    await f.h.run(session, ':')
    let webReads = 0
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          webReads++
          throw new DOMException('WKWebView denied clipboard access', 'NotAllowedError')
        }
      }
    })
    const term = termOf(f, session)
    for (const bracketed of [false, true]) {
      const parsed = Promise.withResolvers<void>()
      term.write(`\x1b[?2004${bracketed ? 'h' : 'l'}`, parsed.resolve)
      await parsed.promise
      expect(term.modes.bracketedPasteMode).toBe(bracketed)
      text = bracketed ? 'native-bracketed' : 'native-plain'
      await focusTerminal(f, session)
      const from = f.calls.length
      expect((await press('mod+v')).defaultPrevented).toBe(true)
      await waitFor('native paste or permission failure', () =>
        writes(f, from).length > 0 || document.body.textContent?.includes('Could not paste') ? true : undefined)
      const expected = bracketed ? `\x1b[200~${text}\x1b[201~` : text
      expect(writes(f, from).map((call) => call.params.data)).toEqual([expected])
      await waitForScreen(f, session, 'native clipboard text at the actual PTY prompt', (rows) => rows.some((row) => row.includes(text)))
      expect(webReads).toBe(0)
      expect(document.body.textContent).not.toContain('Could not paste')
    }
    nativeFailure = true
    const beforeFailure = f.calls.length
    await runCommand(f, 'paste')
    expect(writes(f, beforeFailure)).toEqual([])
    expect(webReads).toBe(0)
    await until(f, () => document.body.textContent?.includes('native pasteboard unavailable'))
  },
  FEATURE_MS
)

test(
  'SC-60: terminal keys act only in a terminal',
  async () => {
    const f = await startFeatures()
    const { session } = await firstPane(f)
    await f.h.run(session, 'seq 1 30')
    await waitForScreen(f, session, 'line 30', (rows) => rows.includes('30'))
    const term = termOf(f, session)
    await waitFor('terminal focus', () => (contextKey(f, 'terminalFocus') ? true : undefined))

    // in the pane every key runs its terminal action
    const select = await press('mod+a')
    expect(select.defaultPrevented).toBe(true)
    expect(term.hasSelection()).toBe(true)
    const copy = await press('mod+c')
    expect(copy.defaultPrevented).toBe(true)
    await waitFor('the selection on the clipboard', () => (f.clipboard.writes.at(-1)?.includes('30') ? true : undefined))
    term.clearSelection()
    f.clipboard.text = 'from-clipboard'
    const fromPaste = f.calls.length
    expect((await press('mod+v')).defaultPrevented).toBe(true)
    await waitFor('the pasted text', () => (writes(f, fromPaste).some((call) => String(call.params.data).includes('from-clipboard')) ? true : undefined))
    expect((await press('mod+f')).defaultPrevented).toBe(true)
    const searching = await viewReport(f, 'an open search box', (report) => report.panes[0]!.search !== null)
    expect(searching.panes[0]!.search).toMatchObject({ query: '', current: 0, total: 0 })
    await runCommand(f, 'search-close')
    await viewReport(f, 'a closed search box', (report) => report.panes[0]!.search === null)
    await focusTerminal(f, session)
    await press('mod+k')
    await waitForScreen(f, session, 'a cleared screen', (rows) => !rows.includes('30'))
    await focusTerminal(f, session)
    await press('mod+d')
    const split = await viewReport(f, 'a split pane', (report) => report.panes.length === 2)
    const splitRevision = split.layout!.revision

    // in a text field the same keys are left to the browser, and the others do nothing
    document.querySelector<HTMLButtonElement>('button[aria-label="Settings"]')!.click()
    const field = await until(f, () => document.querySelector<HTMLInputElement>('[role="dialog"] input:not([type])'))
    field.focus()
    await waitFor('terminal focus to leave', () => (contextKey(f, 'terminalFocus') === false ? true : undefined))
    const baseline = f.calls.length
    const clipboardBefore = f.clipboard.writes.length
    for (const chord of ['mod+c', 'mod+a', 'mod+v']) expect((await press(chord, field)).defaultPrevented, chord).toBe(false)
    for (const chord of ['mod+f', 'mod+k', 'mod+d']) expect((await press(chord, field)).defaultPrevented, chord).toBe(false)
    await Bun.sleep(300)
    expect(writes(f, baseline)).toEqual([])
    expect(f.clipboard.writes).toHaveLength(clipboardBefore)
    expect(f.calls.slice(baseline).filter((call) => /^quirky\.terminal\/(splitPane|clearPane|closePane)$/.test(call.method))).toEqual([])
    const after = await viewReport(f, 'the same layout', (report) => report.layout!.revision >= splitRevision)
    expect(after.layout!.revision).toBe(splitRevision)
    expect(after.panes.map((pane) => pane.search)).toEqual([null, null])
  },
  FEATURE_MS
)

test(
  'SC-61: the shortcut policy',
  async () => {
    const f = await startFeatures()
    const { pane } = await firstPane(f)
    const tabCount = async () => tabsOf(await layoutOf(f.h, f.worktree)).length
    await waitFor('terminal focus', () => (contextKey(f, 'terminalFocus') ? true : undefined))

    expect(contextKey(f, 'terminalKeysFirst')).toBe(false)
    expect((await press('mod+t')).defaultPrevented).toBe(true)
    await waitFor('a second tab under App first', async () => ((await tabCount()) === 2 ? true : undefined))
    const second = await viewReport(f, 'the new tab focused', (report) => report.tabs.length === 2 && report.focusedPane !== pane)
    await focusTerminal(f, focusedSession(second))
    expect((await press('mod+r')).defaultPrevented).toBe(true)
    const renameField = await until(f, () => document.querySelector<HTMLInputElement>('input[aria-label="Tab title"]'))
    await press('escape', renameField)
    await focusTerminal(f, focusedSession(second))

    await setSetting(f, 'shortcut-policy', 'terminal-first')
    await waitFor('Terminal first in the window', () => (contextKey(f, 'terminalKeysFirst') === true ? true : undefined))
    const from = f.calls.length
    const newTab = await press('mod+t')
    const reopen = await press('mod+shift+t')
    const rename = await press('mod+r')
    expect([newTab.defaultPrevented, reopen.defaultPrevented, rename.defaultPrevented]).toEqual([true, true, true])
    await Bun.sleep(400)
    expect(await tabCount()).toBe(2)
    expect(f.calls.slice(from).filter((call) => /^quirky\.terminal\/(newTab|reopenTab)$/.test(call.method))).toEqual([])
    // a command chord reaches the terminal as a key, and xterm sends nothing for Cmd+letter
    expect(writes(f, from)).toEqual([])

    // terminal actions still run under Terminal first
    const focused = focusedSession(await viewReport(f, 'the focused pane'))
    await press('mod+f')
    await viewReport(f, 'a search box under Terminal first', (report) => report.panes.some((candidate) => candidate.search !== null))
    await runCommand(f, 'search-close')
    await focusTerminal(f, focused)
    await press('mod+a')
    expect(termOf(f, focused).hasSelection()).toBe(true)
    await press('mod+d')
    const split = await viewReport(f, 'a split under Terminal first', (report) => report.panes.length === 2)
    await focusTerminal(f, focusedSession(split))
    await press('mod+w')
    await viewReport(f, 'the split pane closed', (report) => report.panes.length === 1)
    expect(await tabCount()).toBe(2)

    await setSetting(f, 'shortcut-policy', 'app-first')
    await waitFor('App first again', () => (contextKey(f, 'terminalKeysFirst') === false ? true : undefined))
    await focusTerminal(f, focusedSession(await viewReport(f, 'the focused pane')))
    expect((await press('mod+t')).defaultPrevented).toBe(true)
    await waitFor('a third tab', async () => ((await tabCount()) === 3 ? true : undefined))
  },
  FEATURE_MS
)

/** Starts a raw-mode `cat -v` that stops after `count` bytes; the markers are assembled by the shell. */
async function catBytes(f: Features, session: string, count: number, tag: string, prelude = ''): Promise<void> {
  await f.h.type(session, `${prelude}stty raw -echo; printf 'READY-%s' ${tag}; dd bs=1 count=${count} 2>/dev/null | cat -v; stty sane; printf '\\033[<u'; printf 'END-%s' ${tag}; echo`)
  await waitForScreen(f, session, `READY-${tag}`, (rows) => rows.some((row) => row.includes(`READY-${tag}`)))
}

const joined = (term: ReturnType<typeof termOf>) => bufferLines(term).join('')

test(
  'SC-62: byte translations',
  async () => {
    const f = await startFeatures()
    const { session } = await firstPane(f)
    const term = termOf(f, session)
    await catBytes(f, session, 13, 'one')
    const steps: [string, string][] = [
      ['shift+enter', '^[^M'],
      ['ctrl+backspace', '^W'],
      ['alt+backspace', '^[^?'],
      ['mod+backspace', '^U'],
      ['mod+delete', '^K'],
      ['mod+left', '^A'],
      ['mod+right', '^E'],
      ['alt+left', '^[b'],
      ['alt+right', '^[f']
    ]
    for (const [chord] of steps) expect((await press(chord)).defaultPrevented, chord).toBe(true)
    const expected = steps.map(([, shown]) => shown).join('')
    // cat -v holds its output until its input ends, so the whole run is read at once
    await waitForScreen(f, session, 'the reader to finish', (rows) => rows.some((row) => row.includes('END-one')))
    expect(joined(term)).toContain(`READY-one${expected}`)
    expect((await f.h.ok(['terminal', 'read', session])).replaceAll('\n', '')).toContain(`READY-one${expected}`)

    // kitty keyboard flags change Shift+Enter
    await catBytes(f, session, 7, 'two', `printf '\\033[>1u'; `)
    await press('shift+enter')
    await waitForScreen(f, session, 'the second reader to finish', (rows) => rows.some((row) => row.includes('END-two')))
    expect(joined(term)).toContain('READY-two^[[13;2u')

    // Cmd+Up and Cmd+Down scroll the scrollback and send nothing
    await f.h.run(session, 'seq 1 300')
    await waitForScreen(f, session, 'line 300', (rows) => rows.includes('300'))
    const from = f.calls.length
    await press('mod+up')
    await waitFor('the top of the scrollback', () => (term.buffer.active.viewportY === 0 ? true : undefined))
    expect(term.buffer.active.baseY).toBeGreaterThan(0)
    await press('mod+down')
    await waitFor('the bottom of the scrollback', () => (term.buffer.active.viewportY === term.buffer.active.baseY ? true : undefined))
    expect(writes(f, from)).toEqual([])
  },
  FEATURE_MS
)

