import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ILink } from '@xterm/xterm'
import {
  FEATURE_MS,
  bufferLines,
  focusTerminal,
  focusedSession,
  linksOn,
  openedLinks,
  startFeatures,
  stopAll,
  termOf,
  viewReport,
  waitFor,
  waitForScreen,
  type Features
} from './features-support'

afterEach(stopAll)

const URL_TEXT = 'https://example.com/x'
const DOCS = 'https://example.com/docs'

/** A window whose shell has printed a URL, an existing path with a position, an OSC 8 link and a missing path. */
async function withLinks() {
  const f = await startFeatures()
  const { h } = f
  mkdirSync(join(h.repo, 'src'))
  writeFileSync(join(h.repo, 'src', 'app.ts'), 'export {}\n')
  const root = realpathSync(h.repo)
  const report = await viewReport(f, 'a mounted pane')
  const session = focusedSession(report)
  await h.run(session, `printf '%s\\n' ${URL_TEXT}; printf '%s\\n' src/app.ts:12:4; printf '\\033]8;;${DOCS}\\033\\\\docs\\033]8;;\\033\\\\\\n'; printf '%s\\n' src/missing.ts`)
  const rows = await waitForScreen(f, session, 'the printed links', (lines) => lines.includes('src/missing.ts'))
  const rowOf = (text: string) => rows.indexOf(text) + 1
  await focusTerminal(f, session)
  return { f, session, root, rowOf }
}

const hint = () => document.querySelector('[data-pane-link-hint]')?.textContent ?? null
const popover = () => document.querySelector('[data-pane-link-popover]')
const popoverLabels = () => [...document.querySelectorAll('[data-pane-link-popover] button')].map((button) => button.textContent)
const mouse = (init: MouseEventInit = {}) => new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, ...init })

async function linkAt(f: Features, session: string, row: number, startsWith: string): Promise<ILink> {
  const found = (await linksOn(f, session, row)).find((link) => link.text.startsWith(startsWith))
  if (!found) throw new Error(`no link starting ${startsWith} on row ${row}`)
  return found
}

test(
  'SC-40: links are found, hinted and survive a failing finder',
  async () => {
    const { f, session, root, rowOf } = await withLinks()

    const url = await linkAt(f, session, rowOf(URL_TEXT), URL_TEXT)
    expect(url.range).toMatchObject({ start: { x: 1 }, end: { x: URL_TEXT.length } })
    url.hover!(new MouseEvent('mousemove'), url.text)
    await waitFor('the URL hint', () => (hint() === URL_TEXT ? true : undefined))
    url.leave!(new MouseEvent('mousemove'), url.text)
    await waitFor('the hint to go', () => (hint() === null ? true : undefined))

    const path = await linkAt(f, session, rowOf('src/app.ts:12:4'), 'src/app.ts')
    expect(path.text).toBe('src/app.ts:12:4')
    path.hover!(new MouseEvent('mousemove'), path.text)
    await waitFor('the path hint', () => (hint() === `${root}/src/app.ts:12:4` ? true : undefined))
    path.leave!(new MouseEvent('mousemove'), path.text)

    expect(await linksOn(f, session, rowOf('src/missing.ts'))).toEqual([])
    const asked = f.calls.filter((call) => call.method === 'quirky.terminal/pathsExist').flatMap((call) => call.params.paths as string[])
    expect(asked).toContain(`${root}/src/missing.ts`)

    const handler = termOf(f, session).options.linkHandler!
    const range = { start: { x: 1, y: rowOf('docs') }, end: { x: 4, y: rowOf('docs') } }
    handler.hover!(new MouseEvent('mousemove'), DOCS, range)
    await waitFor('the OSC 8 hint', () => (hint() === DOCS ? true : undefined))
    handler.leave!(new MouseEvent('mousemove'), DOCS, range)
    expect(bufferLines(termOf(f, session)).some((line) => line === 'docs')).toBe(true)

    // a daemon that fails the existence check leaves URLs working and the pane typing
    const failing = f.rejectCalls('quirky.terminal/pathsExist')
    await f.h.run(session, `printf '%s %s\\n' ${URL_TEXT} src/other.ts`)
    const fresh = await waitForScreen(f, session, 'the new line', (rows) => rows.includes(`${URL_TEXT} src/other.ts`))
    const row = fresh.indexOf(`${URL_TEXT} src/other.ts`) + 1
    expect((await linksOn(f, session, row)).map((link) => link.text)).toEqual([URL_TEXT])
    failing.restore()
    await f.h.run(session, 'echo still-typing')
    await waitForScreen(f, session, 'a working pane', (rows) => rows.includes('still-typing'))
  },
  FEATURE_MS
)

const settingNow = (f: Features, id: string) => f.win.host.getState().settings.find((setting) => setting.id === id)?.value

test(
  'SC-41: what each click does',
  async () => {
    const { f, session, root, rowOf } = await withLinks()
    const url = await linkAt(f, session, rowOf(URL_TEXT), URL_TEXT)
    const path = await linkAt(f, session, rowOf('src/app.ts:12:4'), 'src/app.ts')
    const file = `${root}/src/app.ts`
    const clicks = () => openedLinks(f)
    const buttonNamed = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-pane-link-popover] button')].find((button) => button.textContent === label)!

    // a plain click offers the actions, and each does what it says
    url.activate(mouse(), url.text)
    await waitFor('the URL popover', () => (popover() ? true : undefined))
    expect(popoverLabels()).toEqual(['Open', 'Copy Link'])
    expect(clicks()).toEqual([])
    buttonNamed('Open').click()
    await waitFor('the URL to be opened', () => (clicks().length === 1 ? true : undefined))
    expect(clicks()).toEqual([{ target: URL_TEXT, reveal: false }])
    url.activate(mouse(), url.text)
    await waitFor('the popover again', () => (popover() ? true : undefined))
    buttonNamed('Copy Link').click()
    await waitFor('the link on the clipboard', () => (f.clipboard.writes.at(-1) === URL_TEXT ? true : undefined))

    path.activate(mouse(), path.text)
    await waitFor('the file popover', () => (popover() ? true : undefined))
    expect(popoverLabels()).toEqual(['Open with Default App', 'Reveal in Finder', 'Copy Path'])
    buttonNamed('Reveal in Finder').click()
    await waitFor('the file to be revealed', () => (clicks().length === 2 ? true : undefined))
    path.activate(mouse(), path.text)
    await waitFor('the popover again', () => (popover() ? true : undefined))
    buttonNamed('Copy Path').click()
    await waitFor('the path on the clipboard', () => (f.clipboard.writes.at(-1) === file ? true : undefined))
    expect(clicks()).toEqual([
      { target: URL_TEXT, reveal: false },
      { target: file, reveal: true }
    ])

    // Cmd-click opens, Shift-Cmd-click copies a URL and reveals a path
    url.activate(mouse({ metaKey: true }), url.text)
    path.activate(mouse({ metaKey: true }), path.text)
    await waitFor('both Cmd-clicks to open', () => (clicks().length === 4 ? true : undefined))
    const writes = f.clipboard.writes.length
    url.activate(mouse({ metaKey: true, shiftKey: true }), url.text)
    path.activate(mouse({ metaKey: true, shiftKey: true }), path.text)
    await waitFor('the URL to be copied and the file revealed', () => (clicks().length === 5 && f.clipboard.writes.length === writes + 1 ? true : undefined))
    expect(clicks().slice(2)).toEqual([
      { target: URL_TEXT, reveal: false },
      { target: file, reveal: false },
      { target: file, reveal: true }
    ])
    expect(f.clipboard.writes.at(-1)).toBe(URL_TEXT)

    // a middle click follows its setting (open), and other clicks do nothing
    url.activate(mouse({ button: 1 }), url.text)
    path.activate(mouse({ button: 1 }), path.text)
    await waitFor('the middle clicks to open', () => (clicks().length === 7 ? true : undefined))
    expect(clicks().slice(5)).toEqual([
      { target: URL_TEXT, reveal: false },
      { target: file, reveal: false }
    ])
    url.activate(mouse({ altKey: true }), url.text)
    url.activate(mouse({ button: 2 }), url.text)
    path.activate(mouse({ altKey: true }), path.text)
    await Bun.sleep(300)
    expect(clicks()).toHaveLength(7)
    expect(popover()).toBeNull()

    // the plain click setting: Open opens, Leave to terminal does nothing
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/link-click', 'open'])
    await waitFor('the setting in the window', () => (settingNow(f, 'setting:quirky.terminal/link-click') === 'open' ? true : undefined))
    await waitFor('a plain click to open', async () => {
      url.activate(mouse(), url.text)
      await Bun.sleep(100)
      return clicks().length > 7 ? true : undefined
    })
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/link-click', 'terminal'])
    await waitFor('the setting in the window', () => (settingNow(f, 'setting:quirky.terminal/link-click') === 'terminal' ? true : undefined))
    await Bun.sleep(300)
    const before = clicks().length
    url.activate(mouse(), url.text)
    path.activate(mouse(), path.text)
    await Bun.sleep(300)
    expect(clicks()).toHaveLength(before)
    expect(popover()).toBeNull()

    // the CLI does what Open does
    const viaCli = await f.h.ok(['terminal', 'open-link', file])
    expect(viaCli).toBe(`opened ${file}\n`)
    expect(clicks().at(-1)).toEqual({ target: file, reveal: false })
    await f.h.ok(['terminal', 'open-link', file, '--reveal'])
    expect(clicks().at(-1)).toEqual({ target: file, reveal: true })
  },
  FEATURE_MS
)
