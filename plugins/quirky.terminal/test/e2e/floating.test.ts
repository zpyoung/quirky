import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import {
  SCENARIO_MS,
  cleanupAll,
  fails,
  layoutOf,
  openTab,
  pwdOf,
  restartDaemon,
  startE2e,
  tabsOf,
  waitFor,
  type E2eHarness,
  type FloatingState
} from './support'

const scratch: string[] = []
afterEach(async () => {
  await cleanupAll()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const state = (h: E2eHarness) => h.json<FloatingState>(['terminal', 'floating', 'state'])
const floatingEvents = (h: E2eHarness) => h.events.filter((event) => event.type === 'quirky.terminal/floating')

test(
  'SC-55: showing the floating workspace and opening a terminal in it',
  async () => {
    const h = await startE2e({ cleanShell: true })
    const dir = realpathSync(mkdtempSync('/tmp/qf-'))
    scratch.push(dir)
    expect(await state(h)).toEqual({ enabled: true, open: false, maximized: false, bounds: null, button: null })

    const shown = await h.json<FloatingState>(['terminal', 'floating', 'show'])
    expect(shown).toMatchObject({ enabled: true, open: true, maximized: false, bounds: null })
    expect(await state(h)).toMatchObject({ open: true, maximized: false })
    expect(await h.ok(['terminal', 'floating', 'state'])).toMatch(/open: true\nmaximized: false\nbounds: default/)
    expect((await layoutOf(h, 'floating')).root).toMatchObject({ kind: 'group', tabs: [] })

    const first = await openTab(h, ['--workspace', 'floating'])
    expect(first.tab.defaultTitle).toBe('Terminal 1')
    expect(realpathSync(await pwdOf(h, first.session))).toBe(realpathSync(h.home))
    const record = await h.sessionRecord(first.session)
    expect(record).toMatchObject({ worktreeId: 'floating', kind: 'terminal' })
    expect(tabsOf(await layoutOf(h, 'main'))).toEqual([])

    await h.ok(['setting', 'set', 'setting:quirky.terminal/floating-cwd', dir])
    const second = await openTab(h, ['--workspace', 'floating'])
    expect(second.tab.defaultTitle).toBe('Terminal 2')
    expect(realpathSync(await pwdOf(h, second.session))).toBe(dir)
    const listed = await h.json<{ id: string }[]>(['session', 'list', '--worktree', 'floating'])
    expect(listed.map((session) => session.id).sort()).toEqual([first.session, second.session].sort())

    await h.ok(['setting', 'set', 'setting:quirky.terminal/floating-enabled', 'false'])
    expect((await state(h)).enabled).toBe(false)
  },
  SCENARIO_MS
)

test(
  'SC-56: maximize, restore, move and resize store each change once and keep the minimum size',
  async () => {
    const h = await startE2e()
    await h.connect()
    await h.json<FloatingState>(['terminal', 'floating', 'show'])
    const before = floatingEvents(h).length

    const maximized = await h.json<FloatingState>(['terminal', 'floating', 'maximize'])
    expect(maximized).toMatchObject({ open: true, maximized: true })
    await waitFor('the floating event', () => (floatingEvents(h).length === before + 1 ? true : undefined))
    expect((floatingEvents(h).at(-1) as { data: unknown }).data).toMatchObject({ state: { maximized: true } })

    const hidden = await h.json<FloatingState>(['terminal', 'floating', 'hide'])
    expect(hidden).toMatchObject({ open: false, maximized: true })
    expect(await h.json<FloatingState>(['terminal', 'floating', 'toggle'])).toMatchObject({ open: true, maximized: true })
    expect(await h.json<FloatingState>(['terminal', 'floating', 'restore'])).toMatchObject({ open: true, maximized: false })

    const moved = await h.json<FloatingState>(['terminal', 'floating', 'bounds', '--x', '100', '--y', '80', '--width', '700', '--height', '400'])
    expect(moved.bounds).toEqual({ x: 100, y: 80, width: 700, height: 400 })
    const events = floatingEvents(h).length
    for (const [width, height] of [
      [419, 400],
      [700, 279]
    ]) {
      const refused = await fails(h, ['terminal', 'floating', 'bounds', '--x', '0', '--y', '0', '--width', String(width), '--height', String(height)])
      expect(refused.stderr).toContain('bounds must be at least 420x280')
    }
    const smallest = await h.json<FloatingState>(['terminal', 'floating', 'bounds', '--x', '0', '--y', '0', '--width', '420', '--height', '280'])
    expect(smallest.bounds).toEqual({ x: 0, y: 0, width: 420, height: 280 })
    await waitFor('one event for the accepted bounds', () => (floatingEvents(h).length === events + 1 ? true : undefined))
    expect((await state(h)).bounds).toEqual(smallest.bounds)

    await h.json<FloatingState>(['terminal', 'floating', 'hide'])
    await h.json<FloatingState>(['terminal', 'floating', 'show'])
    expect(await h.json<FloatingState>(['terminal', 'floating', 'maximize'])).toMatchObject({ open: true, maximized: true })
  },
  SCENARIO_MS
)

test(
  'SC-57: the floating workspace survives a daemon restart',
  async () => {
    const h = await startE2e({ cleanShell: true })
    await h.json<FloatingState>(['terminal', 'floating', 'show'])
    await h.json<FloatingState>(['terminal', 'floating', 'maximize'])
    await h.json<FloatingState>(['terminal', 'floating', 'bounds', '--x', '40', '--y', '30', '--width', '800', '--height', '500'])
    const { session, tab } = await openTab(h, ['--workspace', 'floating'])
    await h.run(session, 'echo still-here')
    const before = await layoutOf(h, 'floating')
    const stateBefore = await state(h)

    await restartDaemon(h)
    expect(await state(h)).toEqual(stateBefore)
    expect(stateBefore).toMatchObject({ open: true, maximized: true, bounds: { x: 40, y: 30, width: 800, height: 500 } })
    expect(await layoutOf(h, 'floating')).toEqual(before)
    expect(tabsOf(await layoutOf(h, 'floating')).map((candidate) => candidate.id)).toEqual([tab.id])
    expect((await h.screen(session)).includes('still-here')).toBe(true)
  },
  SCENARIO_MS
)
