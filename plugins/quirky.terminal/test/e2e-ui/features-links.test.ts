import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mouse } from './support'
import type { ILink } from '@xterm/xterm'
import {
  FEATURE_MS,
  bufferLines,
  focusTerminal,
  focusedSession,
  groupsOf,
  layoutOf,
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
  writeFileSync(join(h.repo, 'src', 'app.ts'), `${Array.from({ length: 12 }, (_, index) => `// line ${index + 1}`).join('\n')}\n`)
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
const editorOpenCalls = (f: Features) => f.calls.filter((call) => call.method === 'quirky.editor/open')

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
    url.activate(mouse('mouseup'), url.text)
    await waitFor('the URL popover', () => (popover() ? true : undefined))
    expect(popoverLabels()).toEqual(['Open', 'Copy Link'])
    expect(clicks()).toEqual([])
    buttonNamed('Open').click()
    await waitFor('the URL to be opened', () => (clicks().length === 1 ? true : undefined))
    expect(clicks()).toEqual([{ target: URL_TEXT, reveal: false }])
    url.activate(mouse('mouseup'), url.text)
    await waitFor('the popover again', () => (popover() ? true : undefined))
    buttonNamed('Copy Link').click()
    await waitFor('the link on the clipboard', () => (f.clipboard.writes.at(-1) === URL_TEXT ? true : undefined))

    path.activate(mouse('mouseup'), path.text)
    await waitFor('the file popover', () => (popover() ? true : undefined))
    expect(popoverLabels()).toEqual(['Open with Default App', 'Reveal in Finder', 'Copy Path'])
    buttonNamed('Reveal in Finder').click()
    await waitFor('the file to be revealed', () => (clicks().length === 2 ? true : undefined))
    path.activate(mouse('mouseup'), path.text)
    await waitFor('the popover again', () => (popover() ? true : undefined))
    buttonNamed('Copy Path').click()
    await waitFor('the path on the clipboard', () => (f.clipboard.writes.at(-1) === file ? true : undefined))
    expect(clicks()).toEqual([
      { target: URL_TEXT, reveal: false },
      { target: file, reveal: true }
    ])

    // Command opens directly; Shift+Command uses the alternate browser destination, never clipboard copy.
    url.activate(mouse('mouseup', { metaKey: true }), url.text)
    await waitFor('the URL Cmd-click to open', () => (clicks().length === 3 ? true : undefined))
    const writes = f.clipboard.writes.length
    url.activate(mouse('mouseup', { metaKey: true, shiftKey: true }), url.text)
    await waitFor('the alternate browser destination', () => (clicks().length === 4 ? true : undefined))
    expect(clicks().at(-1)).toEqual({ target: URL_TEXT, reveal: false })
    expect(f.clipboard.writes).toHaveLength(writes)
    path.activate(mouse('mouseup', { metaKey: true, shiftKey: true }), path.text)
    await waitFor('the file to be revealed', () => (clicks().length === 5 ? true : undefined))
    expect(clicks().at(-1)).toEqual({ target: file, reveal: true })

    // A middle click follows its setting, while other click combinations do nothing.
    url.activate(mouse('mouseup', { button: 1 }), url.text)
    await waitFor('the middle URL to open', () => (clicks().length === 6 ? true : undefined))
    expect(clicks().at(-1)).toEqual({ target: URL_TEXT, reveal: false })
    url.activate(mouse('mouseup', { altKey: true }), url.text)
    url.activate(mouse('mouseup', { button: 2 }), url.text)
    path.activate(mouse('mouseup', { altKey: true }), path.text)
    expect(clicks()).toHaveLength(6)
    expect(popover()).toBeNull()

    // the plain click setting: Open opens, Leave to terminal does nothing
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/link-click', 'open'])
    await waitFor('the setting in the window', () => (settingNow(f, 'setting:quirky.terminal/link-click') === 'open' ? true : undefined))
    const beforePlainOpen = clicks().length
    url.activate(mouse('mouseup'), url.text)
    await waitFor('a plain click to open', () => (clicks().length === beforePlainOpen + 1 ? true : undefined))
    expect(clicks().at(-1)).toEqual({ target: URL_TEXT, reveal: false })
    await f.h.ok(['setting', 'set', 'setting:quirky.terminal/link-click', 'terminal'])
    await waitFor('the setting in the window', () => (settingNow(f, 'setting:quirky.terminal/link-click') === 'terminal' ? true : undefined))
    const before = clicks().length
    url.activate(mouse('mouseup'), url.text)
    path.activate(mouse('mouseup'), path.text)
    expect(clicks()).toHaveLength(before)
    expect(popover()).toBeNull()

    // CLI open-link keeps its explicit default-app behavior.
    const viaCli = await f.h.ok(['terminal', 'open-link', file])
    expect(viaCli).toBe(`opened ${file}\n`)
    expect(clicks().at(-1)).toEqual({ target: file, reveal: false })
    await f.h.ok(['terminal', 'open-link', file, '--reveal'])
    expect(clicks().at(-1)).toEqual({ target: file, reveal: true })
  },
  FEATURE_MS
)


test(
  'SC-1: in-worktree path links open the file in the editor at the requested position',
  async () => {
    const { f, session, root, rowOf } = await withLinks()
    const path = await linkAt(f, session, rowOf('src/app.ts:12:4'), 'src/app.ts')
    path.activate(mouse('mouseup', { metaKey: true }), path.text)

    const openCall = await waitFor('editor open API call', () => editorOpenCalls(f).at(-1))
    expect(openCall.params).toMatchObject({ worktree: `id:${f.worktree}`, path: 'src/app.ts', line: 12, column: 4, focus: true })
    expect(openedLinks(f)).toEqual([])

    type EditorState = {
      buffers: { id: string; relativePath: string; tabId: string | null }[]
      tabs: { tabId: string; bufferId: string; mode: 'edit' | 'preview' }[]
    }
    const opened = await waitFor('editor buffer and tab state', async () => {
      const state = await f.h.call<EditorState>('quirky.editor/state', { worktree: `id:${f.worktree}` })
      const buffer = state.buffers.find((entry) => entry.relativePath === 'src/app.ts')
      const mapping = buffer && state.tabs.find((entry) => entry.bufferId === buffer.id)
      return buffer && mapping ? { buffer, mapping } : undefined
    })
    expect(opened.buffer.tabId).toBe(opened.mapping.tabId)
    const workspace = await layoutOf(f.h, `id:${f.worktree}`)
    const view = groupsOf(workspace).flatMap((group) => group.tabs).find((tab) => tab.id === opened.mapping.tabId)
    expect(view).toMatchObject({ kind: 'view', viewId: 'view:quirky.editor/document', input: { bufferId: opened.buffer.id } })
    if (!view || !('kind' in view) || view.kind !== 'view') throw new Error('the editor view tab was not added to the terminal workspace')
    const closeButton = document.querySelector(`[data-tab="${view.id}"] .qt-tab-close`) as HTMLButtonElement | null
    if (!closeButton) throw new Error('the hosted view tab close control was not mounted')
    closeButton.click()
    const closeRequest = await waitFor('editor close command with the actual tab ID', () =>
      f.calls.find((call) => call.method === 'quirky.editor/close' && call.params.tabId === view.id)
    )
    expect(closeRequest.params).toMatchObject({ bufferId: opened.buffer.id, tabId: view.id })
    await waitFor('the hosted view tab to close', async () => {
      const current = await layoutOf(f.h, `id:${f.worktree}`)
      return groupsOf(current).some((group) => group.tabs.some((tab) => tab.id === view.id)) ? undefined : current
    })
  },
  FEATURE_MS
)

test(
  'SC-9: worktree-owned editor row drops paste an absolute shell-safe path only into their owner workspace',
  async () => {
    const { f, session, root } = await withLinks()
    const path = join(root, 'src', 'a b.ts')
    writeFileSync(path, 'export {}\n')
    const mime = 'application/x-quirky-worktree-paths'
    const writes = () => f.calls.filter((call) => call.method === 'quirky.terminal/write' && call.params.session === session)
    const drop = (worktreeId: string, relativePath: string) => {
      const dataTransfer = {
        files: [],
        types: [mime],
        getData: (type: string) => type === mime ? JSON.stringify({ worktreeId, paths: [relativePath] }) : ''
      }
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
      const element = termOf(f, session).element
      if (!element) throw new Error('terminal element was not mounted')
      element.dispatchEvent(event)
    }

    const before = writes().length
    drop(f.worktree, 'src/a b.ts')
    const pasted = await waitFor('the owner worktree path to reach the shell', () => writes().slice(before).find((call) => call.params.data === `'${path}'`))
    expect(pasted.params.data).toBe(`'${path}'`)

    const afterOwnedDrop = writes().length
    drop('another-worktree', 'src/a b.ts')
    expect(writes()).toHaveLength(afterOwnedDrop)
  },
  FEATURE_MS
)
