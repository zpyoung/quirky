import { afterEach, expect, test } from 'bun:test'
import {
  FEATURE_MS,
  focusTerminal,
  focusedSession,
  press,
  runCommand,
  startFeatures,
  stopAll,
  termOf,
  typeInto,
  viewReport,
  waitFor,
  waitForScreen,
  type Features
} from './features-support'

afterEach(stopAll)

/** A window with one pane that has printed 1..`last`, focused. */
async function withNumbers(last = 200) {
  const f = await startFeatures()
  const report = await viewReport(f, 'a mounted pane')
  const session = focusedSession(report)
  await f.h.run(session, `seq 1 ${last}`)
  await waitForScreen(f, session, `line ${last}`, (rows) => rows.includes(String(last)))
  await focusTerminal(f, session)
  return { f, session, pane: report.focusedPane! }
}

const searchOf = async (f: Features, what: string, check: (search: NonNullable<Awaited<ReturnType<typeof viewReport>>['panes'][number]['search']>) => boolean = () => true) =>
  (await viewReport(f, what, (report) => report.panes[0]!.search !== null && check(report.panes[0]!.search))).panes[0]!.search!

const statusText = () => document.querySelector('[data-pane-search-status]')?.textContent
const box = () => document.querySelector<HTMLInputElement>('[data-pane-search] input')!
const enter = (shift = false) => press(shift ? 'shift+enter' : 'enter', box())
const toggle = (title: string) => document.querySelector<HTMLButtonElement>(`[data-pane-search] button[title="${title}"]`)!
const reads = (text: string) => waitFor(`the counter to read ${text}`, () => (statusText() === text ? true : undefined))

test(
  'SC-42: searching a pane',
  async () => {
    const { f, session } = await withNumbers()

    const opened = await press('mod+f')
    expect(opened.defaultPrevented).toBe(true)
    expect(await searchOf(f, 'an empty search box')).toEqual({ query: '', regex: false, caseSensitive: false, current: 0, total: 0, more: false })
    expect(statusText()).toBe('0/0')
    expect(document.activeElement).toBe(box())

    await typeInto(box(), '19')
    await reads('1/12')
    await enter()
    await reads('2/12')
    await enter()
    await reads('3/12')
    for (const expected of ['2/12', '1/12', '12/12']) {
      await enter(true)
      await reads(expected)
    }
    expect(await searchOf(f, 'the last match', (search) => search.current === 12)).toMatchObject({ query: '19', current: 12, total: 12, more: false })

    const term = termOf(f, session)
    const active = term.element!.querySelectorAll<HTMLElement>('.xterm-find-active-result-decoration')
    expect(active).toHaveLength(1)
    const others = [...term.element!.querySelectorAll<HTMLElement>('.xterm-find-result-decoration:not(.xterm-find-active-result-decoration)')]
    expect(others.length).toBeGreaterThan(0)
    expect(term.options.overviewRulerWidth).toBeGreaterThan(0)

    await typeInto(box(), '^1.9$')
    await reads('No results')
    await toggle('Regex').click()
    await reads('1/10')
    expect(toggle('Regex').getAttribute('aria-pressed')).toBe('true')
    await typeInto(box(), 'zzz')
    await reads('No results')
    await typeInto(box(), '')
    await reads('0/0')

    await press('mod+f', box())
    await press('mod+f')
    expect(document.activeElement).toBe(box())

    await press('escape', box())
    expect(await viewReport(f, 'the box closed', (report) => report.panes[0]!.search === null)).toBeDefined()
    expect(document.querySelector('[data-pane-search]')).toBeNull()
    expect(term.element!.querySelectorAll('.xterm-find-result-decoration')).toHaveLength(0)
  },
  FEATURE_MS
)

test(
  'SC-42: more matches than xterm highlights read N+',
  async () => {
    const { f } = await withNumbers(2500)
    await runCommand(f, 'search', { query: '1' })
    const search = await searchOf(f, 'a capped count', (candidate) => candidate.more)
    expect(search.total).toBeGreaterThanOrEqual(1000)
    expect(statusText()).toMatch(/^\d+\+$/)
  },
  FEATURE_MS
)

test(
  'SC-43: stepping through matches from the terminal',
  async () => {
    const { f, session } = await withNumbers()
    await press('mod+f')
    await typeInto(box(), '19')
    await reads('1/12')
    await focusTerminal(f, session)
    expect(document.activeElement).toBe(termOf(f, session).textarea!)

    expect((await press('mod+g')).defaultPrevented).toBe(true)
    expect(await searchOf(f, 'the second match', (search) => search.current === 2)).toMatchObject({ current: 2, total: 12 })
    await press('mod+g')
    expect(await searchOf(f, 'the third match', (search) => search.current === 3)).toMatchObject({ current: 3, total: 12 })
    await press('mod+shift+g')
    expect(await searchOf(f, 'the second match again', (search) => search.current === 2)).toMatchObject({ current: 2, total: 12 })

    await runCommand(f, 'search-close')
    await viewReport(f, 'a closed box', (report) => report.panes[0]!.search === null)
    await focusTerminal(f, session)
    const revision = f.calls.length
    await press('mod+g')
    await Bun.sleep(200)
    expect((await viewReport(f, 'still closed')).panes[0]!.search).toBeNull()
    expect(f.calls.slice(revision).filter((call) => call.method.startsWith('ui.'))).toEqual([])

    await press('mod+f')
    await reads('0/0')
    await focusTerminal(f, session)
    await press('mod+g')
    await Bun.sleep(200)
    expect(await searchOf(f, 'an empty box')).toMatchObject({ query: '', current: 0, total: 0 })
  },
  FEATURE_MS
)

test(
  'SC-44: an agent drives search',
  async () => {
    const { f, pane } = await withNumbers()
    const { h } = f
    expect(await runCommand(f, 'search', { query: '19' })).toEqual({ ok: true })
    expect(await runCommand(f, 'search-next')).toEqual({ ok: true })
    const state = JSON.parse(await h.ok(['ui', 'state', '--json'])) as { slots: { id: string; report: { panes: { pane: string; search: unknown }[] } }[] }
    const report = state.slots.find((slot) => slot.id === 'view:quirky.session/worktree')!.report
    expect(report.panes.find((candidate) => candidate.pane === pane)!.search).toMatchObject({ query: '19', current: 2, total: 12 })

    expect(await runCommand(f, 'search-previous')).toEqual({ ok: true })
    await searchOf(f, 'the first match', (search) => search.current === 1)
    expect(await runCommand(f, 'search', { query: '^1.9$', regex: true })).toEqual({ ok: true })
    expect(await searchOf(f, 'ten regex matches', (search) => search.total === 10)).toMatchObject({ regex: true, current: 1, total: 10 })
    expect(await runCommand(f, 'search', { query: 'Seq', caseSensitive: true })).toEqual({ ok: true })
    expect(await searchOf(f, 'a case sensitive miss', (search) => search.caseSensitive)).toMatchObject({ total: 0 })

    expect(await runCommand(f, 'search-close')).toEqual({ ok: true })
    await viewReport(f, 'a cleared search', (candidate) => candidate.panes[0]!.search === null)

    const tooLong = await h.cli(['ui', 'run', 'command:quirky.terminal/search', '--args', JSON.stringify({ query: 'x'.repeat(1001) })])
    expect(tooLong.code).not.toBe(0)
    expect(tooLong.stderr).toMatch(/longer than 1,000 characters/)
    expect((await viewReport(f, 'no search')).panes[0]!.search).toBeNull()
  },
  FEATURE_MS
)

test(
  'SC-73: Enter and Cmd+G in the search box step',
  async () => {
    const { f } = await withNumbers()
    await press('mod+f')
    await typeInto(box(), '19')
    await reads('1/12')
    box().focus()
    const stepped = await press('enter', box())
    expect(stepped.defaultPrevented).toBe(true)
    await reads('2/12')
    const viaKey = await press('mod+g', box())
    expect(viaKey.defaultPrevented).toBe(true)
    await reads('3/12')
    expect(await searchOf(f, 'the third match', (search) => search.current === 3)).toMatchObject({ current: 3, total: 12 })
  },
  FEATURE_MS
)
