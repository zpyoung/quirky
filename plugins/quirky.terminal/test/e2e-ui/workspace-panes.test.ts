import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CELL,
  SCENARIO_MS,
  cleanupUi,
  fails,
  findTab,
  fire,
  layoutOf,
  leavesOf,
  mouse,
  openTab,
  paneShape,
  panesOf,
  pwdOf,
  splitPane,
  startUi,
  tabsOf,
  terminal,
  waitFor,
  type Ui
} from './support'

afterEach(cleanupUi)

const shapeOf = async (ui: Ui, tab: string) => paneShape(findTab(await layoutOf(ui.h), tab).root)
const style = (ui: Ui, pane: string) => ui.q(`[data-pane="${pane}"]`)!.style
const px = (value: string) => Number.parseFloat(value)
/** The columns the stubbed fit gives a pane, from the box the window drew. */
const colsDrawn = (ui: Ui, pane: string) => Math.floor(px(style(ui, pane).width) / CELL.width)
const near = (actual: string, expected: number, within = 2) => expect(Math.abs(px(actual) - expected)).toBeLessThanOrEqual(within)

/** `[rows, cols]` of a session's terminal as its own shell reports them. */
async function ptySize(ui: Ui, session: string): Promise<[number, number]> {
  const lines = await ui.h.run(session, 'stty size')
  const line = lines.filter((row) => /^\d+ \d+$/.test(row)).at(-1)!
  const [rows, cols] = line.split(' ').map(Number)
  return [rows!, cols!]
}

/** Makes `tab` current in the window and waits until `pane` of it is drawn. */
async function show(ui: Ui, tab: string, pane: string) {
  await terminal(ui.h, 'tab', 'activate', tab)
  await ui.sync()
  await ui.el(`[data-pane="${pane}"]`)
  await ui.refit()
}

test(
  'SC-23: splitting right and down',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const web = join(h.repo, 'web')
    mkdirSync(web)
    const build = await openTab(h, ['--title', 'Build'])
    await h.run(build.session, 'cd web')
    await waitFor('the host to know the directory', async () => ((await h.hostRow(build.session))?.cwd === web ? true : undefined))
    await show(ui, build.tab.id, build.pane.id)
    await ui.term(build.pane.id)!.focus()

    await ui.chord('mod+d')
    const right = await ui.waitLayout('two panes', (ws) => leavesOf(findTab(ws, build.tab.id).root).length === 2)
    const second = leavesOf(findTab(right, build.tab.id).root)[1]!
    expect(await shapeOf(ui, build.tab.id)).toEqual(['right', 0.5, build.pane.id, second.id])
    expect(findTab(right, build.tab.id).activePane).toBe(second.id)
    expect((await h.sessionRecord(second.session)).cwd).toBe(web)
    await waitFor('the new pane drawn and focused', () => (ui.q(`[data-pane="${second.id}"][data-active="true"]`) ? true : undefined))
    near(style(ui, build.pane.id).width, 499)
    near(style(ui, second.id).left, 501)
    near(style(ui, second.id).width, 499)
    expect(await pwdOf(h, second.session)).toBe(web)

    await ui.chord('mod+shift+d')
    const down = await ui.waitLayout('three panes', (ws) => leavesOf(findTab(ws, build.tab.id).root).length === 3)
    const third = leavesOf(findTab(down, build.tab.id).root).at(-1)!
    expect(await shapeOf(ui, build.tab.id)).toEqual(['right', 0.5, build.pane.id, ['down', 0.5, second.id, third.id]])
    expect(findTab(down, build.tab.id).activePane).toBe(third.id)
    expect((await h.sessionRecord(third.session)).cwd).toBe(web)
    await waitFor('the right column split', () => (ui.q(`[data-pane="${third.id}"]`) ? true : undefined))
    near(style(ui, second.id).height, 299)
    near(style(ui, third.id).top, 301)
    near(style(ui, third.id).height, 299)
    near(style(ui, third.id).left, 501)

    const viaCommand = await openTab(h, ['--title', 'Command'])
    await show(ui, viaCommand.tab.id, viaCommand.pane.id)
    expect(await ui.run('split-right')).toEqual({ ok: true })
    await ui.waitLayout('a split by the command', (ws) => leavesOf(findTab(ws, viaCommand.tab.id).root).length === 2)
    expect(await ui.run('split-down')).toEqual({ ok: true })
    await ui.waitLayout('a second split by the command', (ws) => leavesOf(findTab(ws, viaCommand.tab.id).root).length === 3)
    const commandTab = findTab(await layoutOf(h), viaCommand.tab.id)
    const [c1, c2, c3] = leavesOf(commandTab.root)
    expect(paneShape(commandTab.root)).toEqual(['right', 0.5, c1!.id, ['down', 0.5, c2!.id, c3!.id]])

    const viaCli = await openTab(h, ['--title', 'Cli'])
    const split = await splitPane(h, viaCli.pane.id, 'right')
    expect(await shapeOf(ui, viaCli.tab.id)).toEqual(['right', 0.5, viaCli.pane.id, split.pane.id])
    expect((await h.sessionRecord(split.pane.session)).cwd).toBe(h.repo)
    expect(panesOf(await layoutOf(h))).toHaveLength(1 + 3 + 3 + 2)
  },
  SCENARIO_MS
)

test(
  'SC-24: resizing with a divider',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const left = await openTab(h, ['--title', 'Build'])
    const right = await splitPane(h, left.pane.id, 'right')
    await show(ui, left.tab.id, left.pane.id)
    const split = findTab(await layoutOf(h), left.tab.id).root
    if (split.kind !== 'split') throw new Error('expected a split')
    const divider = await ui.el(`[data-divider="${split.id}"]`)
    await ui.refit()
    const resizes = () => ui.callsTo('resize')
    const baseline = resizes().length
    expect((await ui.paneInfo(left.pane.id))!.cols).toBe(colsDrawn(ui, left.pane.id))
    const revision = (await layoutOf(h)).revision

    fire(divider, mouse('mousedown', { button: 0, clientX: 500, clientY: 100 }))
    fire(window, mouse('mousemove', { clientX: 400, clientY: 100 }))
    fire(window, mouse('mousemove', { clientX: 300, clientY: 100 }))
    await ui.refit()
    expect(style(ui, left.pane.id).width).toBe('300px')
    await waitFor('the pane refit while dragging', async () => ((await ui.view())!.panes.find((entry) => entry.pane === left.pane.id)!.cols === 30 ? true : undefined))
    expect(resizes().length).toBe(baseline)
    expect(ui.callsTo('resizeSplit')).toEqual([])
    expect(findTab(await layoutOf(h), left.tab.id).root).toMatchObject({ ratio: 0.5 })

    fire(window, mouse('mouseup', { clientX: 300, clientY: 100 }))
    const resized = await ui.waitLayout('the split at 0.3', (ws) => (findTab(ws, left.tab.id).root as { ratio: number }).ratio === 0.3)
    expect(ui.callsTo('resizeSplit')).toEqual([{ split: split.id, ratio: 0.3, revision }])
    await waitFor('one resize per shell', () => (resizes().length === baseline + 2 ? true : undefined))
    await ui.refit()
    expect(resizes().length).toBe(baseline + 2)
    expect(resizes().slice(baseline).map((call) => call.session).sort()).toEqual([left.session, right.pane.session].sort())
    expect(resizes().slice(baseline).map((call) => [call.session, call.cols, call.rows])).toEqual(
      expect.arrayContaining([
        [left.session, 30, 30],
        [right.pane.session, colsDrawn(ui, right.pane.id), 30]
      ])
    )
    expect(await ptySize(ui, left.session)).toEqual([30, 30])
    expect(await ptySize(ui, right.pane.session)).toEqual([30, colsDrawn(ui, right.pane.id)])
    expect(findTab(resized, left.tab.id).root).toMatchObject({ ratio: 0.3 })

    fire(divider, mouse('mousedown', { button: 0, clientX: 300, clientY: 100 }))
    fire(window, mouse('mousemove', { clientX: 10, clientY: 100 }))
    await ui.settle()
    expect(style(ui, left.pane.id).width).toBe('50px')
    fire(window, mouse('mouseup', { clientX: 10, clientY: 100 }))
    await ui.waitLayout('the split at the minimum', (ws) => (findTab(ws, left.tab.id).root as { ratio: number }).ratio === 0.05)

    fire(divider, mouse('dblclick'))
    await ui.waitLayout('the split back at 0.5', (ws) => (findTab(ws, left.tab.id).root as { ratio: number }).ratio === 0.5)
    await waitFor('both shells sized for the halves', async () => {
      const [a, b] = await Promise.all([ptySize(ui, left.session), ptySize(ui, right.pane.session)])
      return a[1] === colsDrawn(ui, left.pane.id) && b[1] === colsDrawn(ui, right.pane.id) ? true : undefined
    })

    await terminal(h, 'pane', 'resize', left.pane.id, '--ratio', '0.3')
    expect(findTab(await layoutOf(h), left.tab.id).root).toMatchObject({ ratio: 0.3 })
    await waitFor('the window redrawn', () => (style(ui, left.pane.id).width === '300px' ? true : undefined))
  },
  SCENARIO_MS
)

test(
  'SC-26: moving a pane by its header',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const right = await splitPane(h, build.pane.id, 'right')
    await h.run(right.pane.session, 'echo kept-me')

    await show(ui, one.tab.id, one.pane.id)
    expect(ui.q('[aria-label="Move pane"]')).toBeNull()
    await show(ui, build.tab.id, build.pane.id)
    const grip = await ui.el('[data-pane-header] [aria-label="Move pane"]')
    expect(ui.qa('[aria-label="Move pane"]')).toHaveLength(1)
    expect(ui.q(`[data-pane="${right.pane.id}"] [data-pane-header]`)).not.toBeNull()

    fire(grip, mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    fire(window, mouse('mousemove', { clientX: 702, clientY: 102 }))
    await ui.settle()
    expect(ui.q('[data-drop-preview]')).toBeNull()
    fire(window, mouse('mousemove', { clientX: 250, clientY: 20 }))
    const preview = await ui.el('[data-drop-preview]')
    expect([preview.style.left, preview.style.top]).toEqual(['0px', '0px'])
    near(preview.style.width, 499)
    near(preview.style.height, 300)
    fire(window, mouse('mouseup', { clientX: 250, clientY: 20 }))
    const above = await ui.waitLayout('the pane above', (ws) => leavesOf(findTab(ws, build.tab.id).root)[0]!.id === right.pane.id)
    expect(paneShape(findTab(above, build.tab.id).root)).toEqual(['down', 0.5, right.pane.id, build.pane.id])
    expect(ui.callsTo('movePane')).toEqual([{ pane: right.pane.id, toPane: build.pane.id, edge: 'top' }])
    await ui.gone('[data-drop-preview]')
    await waitFor('the panes redrawn', () => (style(ui, right.pane.id).top === '0px' && px(style(ui, build.pane.id).top) > 290 ? true : undefined))
    expect(ui.term(right.pane.id)).not.toBeNull()
    await waitFor('the moved pane keeps its screen', () => (ui.paneText(right.pane.id).some((line) => line === 'kept-me') ? true : undefined))

    await ui.sync()
    const gripAgain = await ui.el('[data-pane-header] [aria-label="Move pane"]')
    const tabEl = ui.q(`[data-tab="${one.tab.id}"]`)!
    fire(gripAgain, mouse('mousedown', { button: 0, clientX: 700, clientY: 100 }))
    fire(tabEl, mouse('mousemove', { clientX: 40, clientY: 10 }))
    await ui.settle()
    expect(tabEl.className).toContain('qt-drop-target')
    fire(tabEl, mouse('mouseup', { clientX: 40, clientY: 10 }))
    const moved = await ui.waitLayout('the pane in Terminal 1', (ws) => leavesOf(findTab(ws, one.tab.id).root).length === 2)
    expect(ui.callsTo('movePane')[1]).toEqual({ pane: right.pane.id, toTab: one.tab.id })
    expect(leavesOf(findTab(moved, one.tab.id).root).map((pane) => pane.session)).toContain(right.pane.session)
    expect(leavesOf(findTab(moved, build.tab.id).root).map((pane) => pane.id)).toEqual([build.pane.id])
    expect((await h.hostRow(right.pane.session))?.state).not.toBe('exited')
    expect((await h.screen(right.pane.session)).includes('kept-me')).toBe(true)
    await terminal(h, 'tab', 'activate', one.tab.id)
    await waitFor('the screen in the new tab', () => (ui.paneText(right.pane.id).some((line) => line === 'kept-me') ? true : undefined))

    await show(ui, build.tab.id, build.pane.id)
    expect(ui.q('[aria-label="Move pane"]')).toBeNull()
    const cli = await openTab(h, ['--title', 'Cli'])
    const second = await splitPane(h, cli.pane.id, 'right')
    await terminal(h, 'pane', 'move', second.pane.id, '--to-pane', cli.pane.id, '--edge', 'top')
    expect(await shapeOf(ui, cli.tab.id)).toEqual(['down', 0.5, second.pane.id, cli.pane.id])
  },
  SCENARIO_MS
)

test(
  'SC-27: expanding a pane',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const b = await splitPane(h, build.pane.id, 'right')
    const c = await splitPane(h, b.pane.id, 'down')
    await terminal(h, 'pane', 'focus', b.pane.id)
    await show(ui, build.tab.id, build.pane.id)
    await ui.term(b.pane.id)!.focus()
    const expanded = async () => findTab(await layoutOf(h), build.tab.id).expandedPane
    expect(ui.qa('[data-pane]')).toHaveLength(3)

    await ui.chord('mod+shift+enter')
    await ui.waitLayout('the pane expanded', (ws) => findTab(ws, build.tab.id).expandedPane === b.pane.id)
    await waitFor('only the expanded pane drawn', () => (ui.qa('[data-pane]').map((element) => element.dataset.pane).join() === b.pane.id ? true : undefined))
    expect(ui.q(`[data-tab="${build.tab.id}"] [aria-label="Collapse expanded pane"]`)).not.toBeNull()
    near(style(ui, b.pane.id).width, 1000)
    near(style(ui, b.pane.id).height, 600)
    for (const other of [build.pane, c.pane]) expect((await h.hostRow(other.session))?.state).not.toBe('exited')
    expect((await ui.view())!.panes.map((entry) => entry.pane)).toEqual([b.pane.id])

    await ui.chord('mod+]')
    const next = await ui.waitLayout('collapsed and moved on', (ws) => findTab(ws, build.tab.id).expandedPane === null)
    expect(findTab(next, build.tab.id).activePane).toBe(c.pane.id)
    await waitFor('all three drawn again', () => (ui.qa('[data-pane]').length === 3 ? true : undefined))

    await ui.run('toggle-expand-pane')
    await ui.waitLayout('C expanded', (ws) => findTab(ws, build.tab.id).expandedPane === c.pane.id)
    await ui.chord('mod+shift+enter')
    await ui.waitLayout('C collapsed', (ws) => findTab(ws, build.tab.id).expandedPane === null)

    await show(ui, one.tab.id, one.pane.id)
    await ui.term(one.pane.id)!.focus()
    const calls = ui.callsTo('expandPane').length
    await ui.chord('mod+shift+enter')
    await ui.settle()
    expect(ui.callsTo('expandPane').length).toBe(calls)
    expect(findTab(await layoutOf(h), one.tab.id).expandedPane).toBeNull()

    await terminal(h, 'pane', 'expand', b.pane.id)
    expect(await expanded()).toBe(b.pane.id)
    await ui.restartDaemon()
    expect(await expanded()).toBe(b.pane.id)
    await terminal(h, 'tab', 'activate', build.tab.id)
    const back = await ui.waitView('the expanded pane drawn after the restart', (view) => view.panes.length === 1 && view.panes[0]!.pane === b.pane.id)
    expect(back.layout!.revision).toBe((await layoutOf(h)).revision)
    await terminal(h, 'pane', 'collapse', b.pane.id)
    expect(await expanded()).toBeNull()
  },
  SCENARIO_MS
)

test(
  'SC-28: focusing the next and previous pane',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const p2 = build.pane
    const p3 = (await splitPane(h, p2.id, 'right')).pane
    const p4 = (await splitPane(h, p3.id, 'down')).pane
    await show(ui, build.tab.id, p2.id)
    const active = async () => findTab(await layoutOf(h), build.tab.id).activePane
    const focusedInDom = () => document.activeElement?.closest('[data-pane]')?.getAttribute('data-pane')
    await waitFor('pane 4 focused', () => (focusedInDom() === p4.id ? true : undefined))
    const opacity = (pane: string) => ui.q(`[data-pane="${pane}"] [data-terminal-pane]`)!.style.opacity
    expect([opacity(p2.id), opacity(p3.id), opacity(p4.id)]).toEqual(['0.9', '0.9', '1'])

    const step = async (chord: string, pane: string) => {
      await ui.chord(chord)
      await ui.waitLayout(`${pane} active`, (ws) => findTab(ws, build.tab.id).activePane === pane)
      await waitFor(`${pane} focused`, () => (focusedInDom() === pane ? true : undefined))
      expect(opacity(pane)).toBe('1')
      await waitFor('the others dimmed', () => ([p2.id, p3.id, p4.id].filter((other) => other !== pane).every((other) => opacity(other) === '0.9') ? true : undefined))
    }
    await step('mod+]', p2.id)
    await step('mod+[', p4.id)
    await step('mod+[', p3.id)

    expect(await ui.run('focus-next-pane')).toEqual({ ok: true })
    await ui.waitLayout('pane 4 by the command', (ws) => findTab(ws, build.tab.id).activePane === p4.id)
    await terminal(h, 'pane', 'focus', '--next')
    expect(await active()).toBe(p2.id)
    await terminal(h, 'pane', 'focus', '--previous')
    expect(await active()).toBe(p4.id)
  },
  SCENARIO_MS
)

test(
  'SC-29: closing a pane',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const build = await openTab(h, ['--title', 'Build'])
    const p2 = build.pane
    const p3 = (await splitPane(h, p2.id, 'right')).pane
    const p4 = (await splitPane(h, p3.id, 'down')).pane
    await terminal(h, 'pane', 'focus', p3.id)
    await show(ui, build.tab.id, p2.id)
    await ui.term(p3.id)!.focus()

    await ui.chord('mod+w')
    const closed = await ui.waitLayout('pane 3 closed', (ws) => !panesOf(ws).some((pane) => pane.id === p3.id))
    expect(paneShape(findTab(closed, build.tab.id).root)).toEqual(['right', 0.5, p2.id, p4.id])
    expect(findTab(closed, build.tab.id).activePane).toBe(p4.id)
    await waitFor('its session gone', async () => ((await h.sessionRecords()).every((session) => session.id !== p3.session) ? true : undefined))
    await waitFor('pane 4 in the right column', () => (ui.q(`[data-pane="${p3.id}"]`) === null && px(style(ui, p4.id).height) >= 599 ? true : undefined))
    near(style(ui, p4.id).left, 501)
    near(style(ui, p4.id).top, 0)

    await terminal(h, 'pane', 'close', p4.id)
    expect(paneShape(findTab(await layoutOf(h), build.tab.id).root)).toBe(p2.id)
    await ui.sync()
    await ui.term(p2.id)!.focus()
    await ui.chord('mod+w')
    const gone = await ui.waitLayout('the tab closed', (ws) => !tabsOf(ws).some((tab) => tab.id === build.tab.id))
    expect(tabsOf(gone).map((tab) => tab.id)).toEqual([one.tab.id])

    const again = await openTab(h, ['--title', 'Again'])
    const extra = await splitPane(h, again.pane.id, 'right')
    await show(ui, again.tab.id, again.pane.id)
    expect(await ui.run('close-pane')).toEqual({ ok: true })
    const after = await ui.waitLayout('the focused pane closed', (ws) => leavesOf(findTab(ws, again.tab.id).root).length === 1)
    expect(leavesOf(findTab(after, again.tab.id).root)[0]!.id).toBe(again.pane.id)
    expect((await h.sessionRecords()).some((session) => session.id === extra.pane.session)).toBe(false)
  },
  SCENARIO_MS
)

/** A tab "Build" with panes A | (B / C), drawn in the window. */
async function threePanes(ui: Ui) {
  const build = await openTab(ui.h, ['--title', 'Build'])
  const b = await splitPane(ui.h, build.pane.id, 'right')
  const c = await splitPane(ui.h, b.pane.id, 'down')
  await show(ui, build.tab.id, build.pane.id)
  return { build, a: build.pane, b: b.pane, c: c.pane }
}

const titleOfPane = async (ui: Ui, pane: string) => panesOf(await layoutOf(ui.h)).find((entry) => entry.id === pane)?.title ?? null

test(
  'SC-30: a pane title',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const { b } = await threePanes(ui)
    const titleNow = () => titleOfPane(ui, b.id)

    await ui.contextMenu(`[data-pane="${b.id}"]`)
    await ui.pick('Set Title…')
    const input = await ui.el<HTMLInputElement>('input[aria-label="Pane title"]')
    expect(ui.callsTo('focusPane')).toEqual([{ pane: b.id }])
    await ui.fill(input, 'logs')
    await ui.key(input, 'Enter')
    await waitFor('the title stored', async () => ((await titleNow()) === 'logs' ? true : undefined))
    expect(ui.callsTo('setPaneTitle')).toEqual([{ pane: b.id, title: 'logs' }])
    await waitFor('the header showing it', () => (ui.q(`[data-pane-header="${b.id}"] .qt-pane-title`)?.textContent === 'logs' ? true : undefined))
    expect(ui.q(`[data-pane-header="${b.id}"] [aria-label="Remove title"]`)).not.toBeNull()
    expect(ui.q(`[data-pane-header="${b.id}"] [aria-label="Close Pane"]`)).toBeNull()

    await ui.restartDaemon()
    expect(await titleNow()).toBe('logs')

    await ui.sync()
    await ui.run('set-pane-title')
    const again = await ui.el<HTMLInputElement>('input[aria-label="Pane title"]')
    expect(again.value).toBe('logs')
    await ui.fill(again, 'nope')
    await ui.key(again, 'Escape')
    await ui.gone('input[aria-label="Pane title"]')
    expect(ui.callsTo('setPaneTitle')).toHaveLength(1)
    expect(await titleNow()).toBe('logs')

    await ui.contextMenu(`[data-pane="${b.id}"]`)
    expect((await ui.waitView('the pane menu', (view) => view.menu?.kind === 'pane')).menu!.items.map((item) => item.label)).toContain('Clear Pane Title')
    await ui.pick('Clear Pane Title')
    await waitFor('the title gone', async () => ((await titleNow()) === null ? true : undefined))
    await waitFor('close back in the header', () => (ui.q(`[data-pane-header="${b.id}"] [aria-label="Close Pane"]`) ? true : undefined))
    expect(ui.q(`[data-pane-header="${b.id}"] .qt-pane-title`)).toBeNull()

    await terminal(h, 'pane', 'title', b.id, 'logs')
    await waitFor('the CLI title', async () => ((await titleNow()) === 'logs' ? true : undefined))
    await terminal(h, 'pane', 'title', b.id, '')
    await waitFor('the CLI title cleared', async () => ((await titleNow()) === null ? true : undefined))
  },
  SCENARIO_MS
)

test(
  'SC-31: split pane headers keep pane controls while lone panes use the tab strip to close',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const { a, b, c } = await threePanes(ui)
    await terminal(h, 'pane', 'title', b.id, 'logs')
    await terminal(h, 'pane', 'focus', b.id)
    await ui.sync()

    await waitFor('one header', () => (ui.qa('[data-pane-header]').length === 1 ? true : undefined))
    const header = ui.q(`[data-pane="${b.id}"] [data-pane-header]`)!
    expect(ui.qa('[data-pane-header]').map((element) => element.dataset.paneHeader)).toEqual([b.id])
    expect(header.querySelector('.qt-pane-title')!.textContent).toBe('logs')
    expect(header.querySelector('[aria-label="Expand pane"]')).not.toBeNull()
    expect(header.querySelector('[aria-label="Move pane"]')).not.toBeNull()
    expect(header.querySelector('[aria-label="Remove title"]')).not.toBeNull()
    for (const other of [a, c]) expect(ui.q(`[data-pane="${other.id}"] [data-pane-header]`)).toBeNull()

    await terminal(h, 'pane', 'focus', c.id)
    await waitFor('the header on pane C', () => (ui.qa('[data-pane-header]').map((element) => element.dataset.paneHeader).join() === c.id ? true : undefined))
    const untitled = ui.q(`[data-pane="${c.id}"] [data-pane-header]`)!
    expect(untitled.querySelector('[aria-label="Close Pane"]')).not.toBeNull()
    expect(untitled.querySelector('.qt-pane-title')).toBeNull()

    await show(ui, one.tab.id, one.pane.id)
    expect(ui.q(`[data-pane="${one.pane.id}"] [data-pane-header]`)).toBeNull()
    expect(ui.q(`[data-pane="${one.pane.id}"] [aria-label="Close tab"]`)).toBeNull()
    const tabClose = ui.q<HTMLButtonElement>(`[data-tab="${one.tab.id}"] .qt-tab-close`)
    expect(tabClose).not.toBeNull()
    tabClose!.click()
    await ui.waitLayout('the lone tab closed', (ws) => !tabsOf(ws).some((tab) => tab.id === one.tab.id))
    expect(ui.callsTo('closeTab')).toEqual([{ tab: one.tab.id, yes: true }])
  },
  SCENARIO_MS
)

test(
  'SC-33: a non-zero exit keeps the pane with an overlay',
  async () => {
    const ui = await startUi()
    const { h } = ui
    await ui.firstTab()
    const web = join(h.repo, 'web')
    mkdirSync(web)
    const build = await openTab(h, ['--title', 'Build', '--cwd', web])
    const right = await splitPane(h, build.pane.id, 'right')
    const third = await splitPane(h, right.pane.id, 'down')
    await show(ui, build.tab.id, build.pane.id)
    const paneState = async (pane: string) => panesOf(await layoutOf(h)).find((entry) => entry.id === pane)

    await h.type(right.pane.session, 'echo before-exit; exit 3')
    await ui.waitLayout('the pane exited with 3', (ws) => panesOf(ws).find((entry) => entry.id === right.pane.id)?.exit?.code === 3)
    expect((await paneState(right.pane.id))!.exit).toEqual({ code: 3, signal: null })
    const overlay = await ui.el(`[data-exit-overlay="${right.pane.id}"]`)
    expect(overlay.textContent).toContain('Terminal exited')
    expect(overlay.textContent).toContain('The shell process ended with exit code 3. Its output is preserved.')
    expect([...overlay.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Close', 'Restart'])
    expect((await ui.waitView('the overlay reported', (view) => view.panes.some((entry) => entry.exitOverlay))).panes.find((entry) => entry.pane === right.pane.id)!.exitOverlay).toBe(true)
    await waitFor('the output preserved', () => (ui.paneText(right.pane.id).includes('before-exit') ? true : undefined))
    expect(findTab(await layoutOf(h), build.tab.id).root.kind).toBe('split')

    ;[...overlay.querySelectorAll('button')].find((button) => button.textContent === 'Restart')!.click()
    const restarted = await ui.waitLayout('a fresh shell', (ws) => {
      const entry = panesOf(ws).find((candidate) => candidate.id === right.pane.id)
      return entry !== undefined && entry.exit === null && entry.session !== right.pane.session
    })
    const fresh = panesOf(restarted).find((entry) => entry.id === right.pane.id)!
    expect(ui.callsTo('restartPane')).toEqual([{ pane: right.pane.id }])
    expect((await h.sessionRecord(fresh.session)).cwd).toBe(web)
    await ui.gone(`[data-exit-overlay="${right.pane.id}"]`)

    const running = await fails(h, ['terminal', 'pane', 'restart', fresh.id])
    expect(running).toEqual({ code: 1, stderr: `quirky: pane ${fresh.id} is still running\n` })

    await h.type(third.pane.session, 'exit 3')
    await ui.waitLayout('the third pane exited', (ws) => panesOf(ws).find((entry) => entry.id === third.pane.id)?.exit?.code === 3)
    const second = await ui.el(`[data-exit-overlay="${third.pane.id}"]`)
    ;[...second.querySelectorAll('button')].find((button) => button.textContent === 'Close')!.click()
    await ui.waitLayout('the pane closed', (ws) => !panesOf(ws).some((entry) => entry.id === third.pane.id))
    expect(ui.callsTo('closePane')).toEqual([{ pane: third.pane.id, yes: true }])

    await h.type(fresh.session, 'exit 4')
    await ui.waitLayout('the fresh pane exited', (ws) => panesOf(ws).find((entry) => entry.id === fresh.id)?.exit?.code === 4)
    await terminal(h, 'pane', 'restart', fresh.id)
    expect((await paneState(fresh.id))!.exit).toBeNull()
  },
  SCENARIO_MS
)

test(
  'SC-39: the pane menu',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    const { build, a, b } = await threePanes(ui)
    await h.run(b.session, 'echo menu-check')

    await ui.contextMenu(`[data-pane="${b.id}"]`, { clientX: 10, clientY: 10 })
    const menu = (await ui.waitView('the pane menu', (view) => view.menu?.kind === 'pane')).menu!
    expect(menu.target).toBe(b.id)

    await ui.pick('Copy Terminal ID')
    await ui.contextMenu(`[data-pane="${b.id}"]`)
    await ui.pick('Copy Pane ID')
    expect(ui.clipboard.written).toEqual([b.session, b.id])


    await ui.contextMenu(`[data-pane="${a.id}"]`)
    await ui.pick('Split Terminal Down')
    const split = await ui.waitLayout('a pane below', (ws) => leavesOf(findTab(ws, build.tab.id).root).length === 4)
    expect(ui.callsTo('splitPane')).toEqual([{ pane: a.id, direction: 'down' }])
    expect(paneShape(findTab(split, build.tab.id).root)).toEqual(['right', 0.5, ['down', 0.5, a.id, expect.any(String)], ['down', 0.5, b.id, expect.any(String)]])

    await show(ui, one.tab.id, one.pane.id)
    await ui.contextMenu(`[data-pane="${one.pane.id}"]`)
    await ui.waitView('the lone pane menu', (view) => view.menu?.target === one.pane.id)
    await ui.run('close-menu')
    await ui.waitView('the menu closed', (view) => view.menu === null)

    await ui.run('open-menu', { kind: 'pane', target: one.pane.id })
    expect((await ui.waitView('the pane menu by command', (view) => view.menu?.kind === 'pane')).menu!.target).toBe(one.pane.id)
    await ui.run('close-menu')
  },
  SCENARIO_MS
)

test(
  'SC-39: with Right-click to Paste on, right-click pastes and Ctrl-click opens the menu',
  async () => {
    const ui = await startUi()
    const { h } = ui
    const one = await ui.firstTab()
    await h.ok(['setting', 'set', 'setting:quirky.terminal/right-click-paste', 'true'])
    ui.clipboard.text = 'echo pasted-by-right-click'
    const host = await ui.el(`[data-pane="${one.pane.id}"] [data-terminal-pane]`)
    // the window learns of the setting from an event; until then a right-click opens the menu
    await waitFor('the text pasted at the prompt', async () => {
      fire(host, mouse('contextmenu'))
      await ui.settle()
      if (ui.q('[role="menu"]')) await ui.run('close-menu')
      return (await h.screen(one.session)).some((line) => line.endsWith('echo pasted-by-right-click')) ? true : undefined
    })
    await ui.run('close-menu')
    expect((await ui.view())!.menu).toBeNull()

    fire(host, mouse('contextmenu', { ctrlKey: true }))
    const menu = (await ui.waitView('the menu on Ctrl-click', (view) => view.menu?.kind === 'pane')).menu!
    expect(menu.target).toBe(one.pane.id)
    await ui.run('close-menu')
  },
  SCENARIO_MS
)
