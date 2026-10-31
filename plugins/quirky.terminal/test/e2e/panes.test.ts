import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PtySnapshot } from '@quirky/protocol'
import {
  SCENARIO_MS,
  cleanupAll,
  fails,
  findTab,
  layoutOf,
  leavesOf,
  openTab,
  paneShape,
  panesOf,
  pwdOf,
  restartDaemon,
  splitPane,
  startE2e,
  tabsOf,
  terminal,
  typeAsPerson,
  waitFor,
  waitForLayout,
  waitReady,
  type PaneLeaf
} from './support'

afterEach(cleanupAll)

/** Opens the tab "Build" holding pane-A | (pane-B / pane-C), pane-C active. */
async function buildTab(h: Awaited<ReturnType<typeof startE2e>>) {
  const build = await openTab(h, ['--title', 'Build'])
  const b = await splitPane(h, build.pane.id, 'right')
  const c = await splitPane(h, b.pane.id, 'down')
  return { tab: build.tab, a: build.pane, b: b.pane, c: c.pane }
}

const tabShape = async (h: Awaited<ReturnType<typeof startE2e>>, tab: string) => paneShape(findTab(await layoutOf(h), tab).root)

test(
  'SC-23: splitting right and down starts shells in the pane\'s directory',
  async () => {
    const h = await startE2e()
    mkdirSync(join(h.repo, 'web'))
    const web = join(h.repo, 'web')
    const build = await openTab(h, ['--title', 'Build'])
    await h.run(build.session, 'cd web')
    await waitFor('the host to see the new directory', async () => ((await h.hostRow(build.session))?.cwd === web ? true : undefined))

    const right = await splitPane(h, build.pane.id, 'right')
    expect(await tabShape(h, build.tab.id)).toEqual(['right', 0.5, build.pane.id, right.pane.id])
    expect(findTab(await layoutOf(h), build.tab.id).activePane).toBe(right.pane.id)
    expect(await pwdOf(h, right.pane.session)).toBe(web)

    const down = await splitPane(h, right.pane.id, 'down')
    expect(await tabShape(h, build.tab.id)).toEqual(['right', 0.5, build.pane.id, ['down', 0.5, right.pane.id, down.pane.id]])
    expect(findTab(await layoutOf(h), build.tab.id).activePane).toBe(down.pane.id)
    expect(await pwdOf(h, down.pane.session)).toBe(web)

    const bad = await fails(h, ['terminal', 'pane', 'split', build.pane.id, '--direction', 'sideways'])
    expect(bad.code).toBeGreaterThan(0)
    expect(panesOf(await layoutOf(h))).toHaveLength(3)
  },
  SCENARIO_MS
)

test(
  'SC-24: resizing a split sets the pane\'s share',
  async () => {
    const h = await startE2e()
    const build = await openTab(h)
    const right = await splitPane(h, build.pane.id, 'right')
    const tab = build.tab.id

    await terminal(h, 'pane', 'resize', build.pane.id, '--ratio', '0.3')
    expect(await tabShape(h, tab)).toEqual(['right', 0.3, build.pane.id, right.pane.id])
    await terminal(h, 'pane', 'resize', right.pane.id, '--ratio', '0.3')
    expect(await tabShape(h, tab)).toEqual(['right', 0.7, build.pane.id, right.pane.id])
    await terminal(h, 'pane', 'resize', build.pane.id, '--ratio', '0.33333')
    expect(await tabShape(h, tab)).toEqual(['right', 0.333, build.pane.id, right.pane.id])

    const before = await layoutOf(h)
    for (const ratio of ['0', '1', '1.5', '-0.2']) {
      const refused = await fails(h, ['terminal', 'pane', 'resize', build.pane.id, '--ratio', ratio])
      expect(refused.code, ratio).toBe(1)
    }
    expect(await layoutOf(h)).toEqual(before)
  },
  SCENARIO_MS
)

test(
  'SC-25: equalize weighs each side by its panes',
  async () => {
    const h = await startE2e()
    const build = await openTab(h)
    const second = await splitPane(h, build.pane.id, 'right')
    const third = await splitPane(h, second.pane.id, 'right')
    expect(await tabShape(h, build.tab.id)).toEqual(['right', 0.5, build.pane.id, ['right', 0.5, second.pane.id, third.pane.id]])

    await terminal(h, 'pane', 'equalize', '--tab', build.tab.id)
    expect(await tabShape(h, build.tab.id)).toEqual(['right', 0.333, build.pane.id, ['right', 0.5, second.pane.id, third.pane.id]])
  },
  SCENARIO_MS
)

test(
  'SC-26: moving a pane to another edge or tab keeps its session',
  async () => {
    const h = await startE2e()
    const lone = await openTab(h, ['--title', 'Terminal 1'])
    const build = await openTab(h, ['--title', 'Build'])
    const right = await splitPane(h, build.pane.id, 'right')
    await h.run(right.pane.session, 'echo moved-marker')

    await terminal(h, 'pane', 'move', right.pane.id, '--to-pane', build.pane.id, '--edge', 'top')
    expect(await tabShape(h, build.tab.id)).toEqual(['down', 0.5, right.pane.id, build.pane.id])
    expect(findTab(await layoutOf(h), build.tab.id).activePane).toBe(right.pane.id)
    expect((await h.screen(right.pane.session)).includes('moved-marker')).toBe(true)

    await terminal(h, 'pane', 'move', right.pane.id, '--to-tab', lone.tab.id)
    const ws = await layoutOf(h)
    expect(paneShape(findTab(ws, lone.tab.id).root)).toEqual(['right', 0.5, lone.pane.id, right.pane.id])
    expect(findTab(ws, build.tab.id).root).toMatchObject({ kind: 'pane', id: build.pane.id })
    expect(panesOf(ws).find((pane) => pane.id === right.pane.id)!.session).toBe(right.pane.session)
    expect((await h.screen(right.pane.session)).includes('moved-marker')).toBe(true)
    expect((await h.hostRow(right.pane.session))?.state).toBe('running')

    const onlyPane = await fails(h, ['terminal', 'pane', 'move', build.pane.id, '--to-tab', lone.tab.id])
    expect(onlyPane.stderr).toBe("quirky: the last pane of a tab can't be moved out\n")
    const onSelf = await fails(h, ['terminal', 'pane', 'move', right.pane.id, '--to-pane', right.pane.id, '--edge', 'left'])
    expect(onSelf.code).toBe(1)
  },
  SCENARIO_MS
)

test(
  'SC-27: expanding a pane fills the tab and keeps the others running',
  async () => {
    const h = await startE2e()
    const { tab, a, b, c } = await buildTab(h)
    await terminal(h, 'pane', 'focus', b.id)

    await terminal(h, 'pane', 'expand', b.id)
    let current = findTab(await layoutOf(h), tab.id)
    expect(current.expandedPane).toBe(b.id)
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`pane ${b.id}`)
    for (const pane of [a, b, c]) expect((await h.hostRow(pane.session))?.state).toBe('running')

    await restartDaemon(h)
    current = findTab(await layoutOf(h), tab.id)
    expect(current.expandedPane).toBe(b.id)

    await terminal(h, 'pane', 'focus', '--next')
    current = findTab(await layoutOf(h), tab.id)
    expect(current.expandedPane).toBeNull()
    expect(current.activePane).toBe(c.id)

    await terminal(h, 'pane', 'expand', c.id)
    await terminal(h, 'pane', 'collapse', c.id)
    expect(findTab(await layoutOf(h), tab.id).expandedPane).toBeNull()

    const single = await openTab(h)
    const refused = await fails(h, ['terminal', 'pane', 'expand', single.pane.id])
    expect(refused.code).toBe(1)
    expect(findTab(await layoutOf(h), single.tab.id).expandedPane).toBeNull()
  },
  SCENARIO_MS
)

test(
  'SC-28: focusing the next and previous pane wraps',
  async () => {
    const h = await startE2e()
    const { tab, a, b, c } = await buildTab(h)
    const active = async () => findTab(await layoutOf(h), tab.id).activePane
    expect(await active()).toBe(c.id)

    await terminal(h, 'pane', 'focus', '--next')
    expect(await active()).toBe(a.id)
    await terminal(h, 'pane', 'focus', '--previous')
    expect(await active()).toBe(c.id)
    await terminal(h, 'pane', 'focus', '--previous')
    expect(await active()).toBe(b.id)
    await terminal(h, 'pane', 'focus', a.id)
    expect(await active()).toBe(a.id)
  },
  SCENARIO_MS
)

test(
  'SC-29: closing a pane ends its session and promotes the sibling',
  async () => {
    const h = await startE2e()
    const lone = await openTab(h)
    const { tab, a, b, c } = await buildTab(h)
    await terminal(h, 'pane', 'focus', b.id)

    const closed = await h.cli(['terminal', 'pane', 'close', b.id])
    expect(closed.code).toBe(0)
    expect(closed.stderr).toBe('')
    expect(await tabShape(h, tab.id)).toEqual(['right', 0.5, a.id, c.id])
    expect(findTab(await layoutOf(h), tab.id).activePane).toBe(c.id)
    await waitFor('the pane session to be gone', async () => !(await h.sessionRecords()).some((session) => session.id === b.session))

    await terminal(h, 'pane', 'close', lone.pane.id)
    const ws = await layoutOf(h)
    expect(tabsOf(ws).map((candidate) => candidate.id)).toEqual([tab.id])
    expect(ws.closed).toMatchObject([{ defaultTitle: 'Terminal 1' }])
  },
  SCENARIO_MS
)

test(
  'SC-30: a pane title is set, cleared and survives a restart',
  async () => {
    const h = await startE2e()
    const { tab, b } = await buildTab(h)
    const title = async () => leavesOf(findTab(await layoutOf(h), tab.id).root).find((pane) => pane.id === b.id)!.title

    await terminal(h, 'pane', 'title', b.id, 'logs')
    expect(await title()).toBe('logs')
    await restartDaemon(h)
    expect(await title()).toBe('logs')

    await terminal(h, 'pane', 'title', b.id, '')
    expect(await title()).toBeNull()
    await terminal(h, 'pane', 'title', b.id, 'again')
    await terminal(h, 'pane', 'title', b.id, '')
    expect(await title()).toBeNull()

    const tooLong = await fails(h, ['terminal', 'pane', 'title', b.id, 'x'.repeat(201)])
    expect(tooLong.stderr).toMatch(/at most 200/)
  },
  SCENARIO_MS
)

test(
  'SC-32: exit 0 closes the pane, except an untouched lone pane',
  async () => {
    const h = await startE2e({ zshrc: '[ -e "$HOME/boom" ] && exit 0\n' })
    const keep = await openTab(h)
    const split = await openTab(h)
    const second = await splitPane(h, split.pane.id, 'right')

    await typeAsPerson(h, second.pane.session, 'exit')
    const ws = await waitForLayout(h, 'the exited pane gone', (candidate) => !panesOf(candidate).some((pane) => pane.id === second.pane.id))
    expect(paneShape(findTab(ws, split.tab.id).root)).toBe(split.pane.id)
    await waitFor('its session to be closed', async () => !(await h.sessionRecords()).some((session) => session.id === second.pane.session))

    await typeAsPerson(h, split.pane.session, 'exit')
    await waitForLayout(h, 'the emptied tab gone', (candidate) => tabsOf(candidate).map((tab) => tab.id).join() === keep.tab.id)

    writeFileSync(join(h.home, 'boom'), '')
    const untouched = await openTab(h, [], { ready: false })
    const stayed = await waitForLayout(h, 'the exit recorded', (candidate) => panesOf(candidate).some((pane) => pane.id === untouched.pane.id && pane.exit !== null))
    expect(panesOf(stayed).find((pane) => pane.id === untouched.pane.id)!.exit).toEqual({ code: 0, signal: null })
    expect(tabsOf(stayed).map((tab) => tab.id)).toEqual([keep.tab.id, untouched.tab.id])
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`pane ${untouched.pane.id} ${untouched.session} exit 0`)
    expect((await h.sessionRecord(untouched.session)).status).toBe('exited')
    rmSync(join(h.home, 'boom'))
  },
  SCENARIO_MS
)

test(
  'SC-33: a non-zero exit keeps the pane with its exit code, and Restart starts a fresh shell',
  async () => {
    const h = await startE2e()
    mkdirSync(join(h.repo, 'web'))
    const web = join(h.repo, 'web')
    const ended = await openTab(h, ['--title', 'Ended'])
    const running = await openTab(h, ['--title', 'Running'])

    await h.run(ended.session, 'cd web')
    await waitFor('the host to see the new directory', async () => ((await h.hostRow(ended.session))?.cwd === web ? true : undefined))
    await h.type(ended.session, 'exit 3')
    const ws = await waitForLayout(h, 'the exit recorded', (candidate) => panesOf(candidate).some((pane) => pane.id === ended.pane.id && pane.exit !== null))
    expect(panesOf(ws).find((pane) => pane.id === ended.pane.id)!.exit).toEqual({ code: 3, signal: null })
    expect(tabsOf(ws)).toHaveLength(2)
    expect(await h.ok(['terminal', 'layout', '--worktree', 'main'])).toContain(`pane ${ended.pane.id} ${ended.session} exit 3`)
    expect((await h.json<{ pane: PaneLeaf }>(['terminal', 'pane', 'get', ended.pane.id])).pane.exit).toEqual({ code: 3, signal: null })
    expect((await h.screen(ended.session)).some((line) => line.endsWith('exit 3'))).toBe(true)

    const stillRunning = await fails(h, ['terminal', 'pane', 'restart', running.pane.id])
    expect(stillRunning.stderr).toBe(`quirky: pane ${running.pane.id} is still running\n`)

    const restarted = await terminal(h, 'pane', 'restart', ended.pane.id)
    const pane = panesOf(restarted.workspace).find((candidate) => candidate.id === ended.pane.id)!
    expect(pane.exit).toBeNull()
    expect(pane.session).not.toBe(ended.session)
    await waitReady(h, pane.session)
    expect(await pwdOf(h, pane.session)).toBe(web)
    await waitFor('the ended session to be closed', async () => !(await h.sessionRecords()).some((session) => session.id === ended.session))

    await h.type(pane.session, 'exit 4')
    await waitForLayout(h, 'the second exit recorded', (candidate) => panesOf(candidate).some((p) => p.id === ended.pane.id && p.exit?.code === 4))
    const closed = await h.cli(['terminal', 'pane', 'close', ended.pane.id])
    expect(closed.code).toBe(0)
    expect(closed.stderr).toBe('')
    expect(tabsOf(await layoutOf(h)).map((tab) => tab.id)).toEqual([running.tab.id])
  },
  SCENARIO_MS
)

test(
  'SC-71: exit 3 in a lone pane and in a split pane keeps both with exit code 3',
  async () => {
    const h = await startE2e()
    const lone = await openTab(h, ['--title', 'Lone'])
    const split = await openTab(h, ['--title', 'Split'])
    const second = await splitPane(h, split.pane.id, 'right')

    await h.type(lone.session, 'exit 3')
    await h.type(second.pane.session, 'exit 3')
    const ws = await waitForLayout(h, 'both exits recorded', (candidate) => panesOf(candidate).filter((pane) => pane.exit !== null).length === 2)
    for (const id of [lone.pane.id, second.pane.id]) {
      expect(panesOf(ws).find((pane) => pane.id === id)!.exit, id).toEqual({ code: 3, signal: null })
    }
    expect(panesOf(ws).find((pane) => pane.id === split.pane.id)!.exit).toBeNull()
    expect(paneShape(findTab(ws, split.tab.id).root)).toEqual(['right', 0.5, split.pane.id, second.pane.id])
    expect(tabsOf(ws)).toHaveLength(2)
    for (const session of [lone.session, second.pane.session]) {
      expect(await h.sessionRecord(session)).toMatchObject({ status: 'exited', exitCode: 3 })
    }
  },
  SCENARIO_MS
)

test(
  'SC-34: clear empties the pane and its history, and reset turns the modes off',
  async () => {
    const h = await startE2e()
    const { session, pane } = await openTab(h)
    await h.run(session, 'seq 1 500')
    await h.run(session, `printf '\\033[?1000h\\033[?1006h'`)
    await waitFor('mouse reporting to be on', async () => ((await h.json<PtySnapshot>(['terminal', 'snapshot', session])).modes.mouseTracking ? true : undefined))
    expect((await h.ok(['terminal', 'history', session, '--lines', '600'])).split('\n')).toContain('250')

    const cleared = await h.cli(['terminal', 'pane', 'clear', pane.id])
    expect(cleared.code).toBe(0)
    const rows = (await h.screen(session)).filter((line) => line !== '')
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(rows.some((line) => /^\d+$/.test(line))).toBe(false)
    const history = (await h.ok(['terminal', 'history', session, '--lines', '600'])).split('\n')
    expect(history.some((line) => /^\d+$/.test(line))).toBe(false)
    const reopened = await h.attach(session)
    expect(reopened.replayText).not.toContain('250')
    await reopened.detach()
    expect((await h.json<PtySnapshot>(['terminal', 'snapshot', session])).modes.mouseTracking).toBe(true)

    await h.run(session, 'echo kept-text')
    const before = await h.screen(session)
    const reset = await h.cli(['terminal', 'pane', 'reset', pane.id])
    expect(reset.code).toBe(0)
    const modes = (await h.json<PtySnapshot>(['terminal', 'snapshot', session])).modes
    expect(modes).toMatchObject({ mouseTracking: false, bracketedPaste: false, applicationCursor: false })
    expect(await h.screen(session)).toEqual(before)
  },
  SCENARIO_MS
)
