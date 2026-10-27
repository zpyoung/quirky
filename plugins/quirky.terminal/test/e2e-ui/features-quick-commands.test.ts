import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuickCommand } from '../../src/layout/types'
import { startAgentsE2E, type E2E } from '../../../quirky.agents/test/support/e2e'
import {
  FEATURE_MS,
  QUICK_COMMANDS_PANEL,
  attachFeatures,
  focusTerminal,
  focusedSession,
  groupsOf,
  layoutOf,
  leavesOf,
  reportOf,
  runCommand,
  startFeatures,
  stopAll,
  tabsOf,
  typeInto,
  until,
  viewReport,
  waitFor,
  waitForScreen,
  type Features
} from './features-support'

let agents: E2E | undefined
afterEach(async () => {
  await stopAll()
  await agents?.cleanup()
  agents = undefined
})

type Panel = { count: number; filter: string; query: string; rows: { id: string; label: string; scope: string }[] }
type Commands = { commands: QuickCommand[] }

const EMPTY_TEXT = 'No quick commands saved. Run them from the Quick Commands button in the tab bar, or right-click inside any terminal.'

const byText = <T extends Element>(selector: string, text: string): T | undefined => [...document.querySelectorAll<T>(selector)].find((element) => element.textContent?.trim() === text)
/** The menu row whose label reads `text`, whether or not it has a shortcut or an arrow after it. */
const menuRow = (scope: string, text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(`${scope} .qt-menu-label`)].find((label) => label.textContent === text)?.closest('button') ?? undefined
const dialog = (title: string) => document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${title}"]`)
const field = <T extends Element>(name: string) => document.querySelector<T>(`.qc-dialog [name="${name}"]`)!
const panelReport = (f: Features, what: string, check: (report: Panel) => boolean = () => true) => reportOf<Panel>(f, QUICK_COMMANDS_PANEL, what, check)
const addCommand = (f: Features, fields: Record<string, unknown>) => f.h.call<Commands>('quirky.terminal/addQuickCommand', { scope: 'global', ...fields })

test(
  'SC-49: the Quick Commands panel and adding a command',
  async () => {
    const f = await startFeatures()
    const mark = f.calls.length
    await f.h.ok(['ui', 'open-panel', QUICK_COMMANDS_PANEL])
    const empty = await panelReport(f, 'the empty panel', (report) => report.count === 0)
    expect(empty).toEqual({ count: 0, filter: 'all', query: '', rows: [] })
    await waitFor('the empty text', () => (document.querySelector('.qc-empty')?.textContent === EMPTY_TEXT ? true : undefined))

    // the dialog preselects Project only when it opens after the panel has found the repo
    await waitFor('the panel to find the repo', () => (f.calls.slice(mark).some((call) => call.method === 'quirky.worktree/resolve' && call.settled) ? true : undefined))
    await Bun.sleep(100)
    byText<HTMLButtonElement>('button', 'Add Command')!.click()
    await until(f, () => dialog('Add Quick Command'))
    const open = dialog('Add Quick Command')!
    expect(open.querySelector('h2')?.textContent).toBe('Add Quick Command')
    expect(open.querySelector('p')?.textContent).toBe('Saved items appear in the tab bar menu for one-click run.')
    const save = byText<HTMLButtonElement>('.qc-dialog-foot button', 'Save')!
    expect(save.disabled).toBe(true)
    expect(field<HTMLInputElement>('label').maxLength).toBe(80)
    expect(field<HTMLTextAreaElement>('command').maxLength).toBe(4000)
    expect(field<HTMLSelectElement>('agent').disabled).toBe(true)
    expect(field<HTMLInputElement>('action').checked).toBe(true)
    expect(field<HTMLButtonElement>('appendEnter').getAttribute('aria-checked')).toBe('true')
    await waitFor('Project preselected for api', () => (document.querySelector<HTMLInputElement>('.qc-dialog [name="scope"][value="repo"]')?.checked ? true : undefined))
    await waitFor('the repo name beside Project', () => (open.textContent?.includes('Projectapi') ? true : undefined))

    await typeInto(field('label'), 'Hello')
    expect(save.disabled).toBe(true)
    await typeInto(field('command'), 'echo hello')
    expect(save.disabled).toBe(false)
    const confirm = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
    open.dispatchEvent(confirm)
    await waitFor('the dialog to close', () => (dialog('Add Quick Command') ? undefined : true))

    const shown = await panelReport(f, 'the new command', (report) => report.count === 1)
    expect(shown.rows).toEqual([{ id: 'hello', label: 'Hello', scope: 'repo' }])
    const row = document.querySelector('.qc-row[data-command="hello"]')!
    expect(row.querySelector('.qc-label')?.textContent).toBe('Hello')
    expect(row.querySelector('.qc-badge')?.textContent).toBe('Project')
    expect(row.querySelector('.qc-body')?.textContent).toBe('echo hello')
    expect(row.querySelector('.qc-hint')?.textContent).toBe('Enter')
    const stored = (await f.h.json<Commands>(['terminal', 'quick-command', 'list', '--all'])).commands
    expect(stored).toMatchObject([{ id: 'hello', label: 'Hello', kind: 'terminal', command: 'echo hello', appendEnter: true, scope: 'repo' }])
    expect(stored[0]!.repo).toBeTruthy()

    // the same command added from the CLI shows up in the open panel, and the panel narrows its list
    await f.h.ok(['terminal', 'quick-command', 'add', '--label', 'Test', '--command', 'echo test'])
    await panelReport(f, 'both commands', (report) => report.count === 2)
    const searchBox = document.querySelector<HTMLInputElement>('input[aria-label="Search quick commands"]')!
    await typeInto(searchBox, 'hel')
    expect((await panelReport(f, 'a narrowed list', (report) => report.query === 'hel')).rows.map((r) => r.id)).toEqual(['hello'])
    await typeInto(searchBox, '')
    const scope = document.querySelector<HTMLSelectElement>('select[aria-label="Filter by scope"]')!
    scope.value = 'global'
    scope.dispatchEvent(new Event('change', { bubbles: true }))
    expect((await panelReport(f, 'the global filter', (report) => report.filter === 'global')).rows.map((r) => r.id)).toEqual(['test'])
    scope.value = 'repo'
    scope.dispatchEvent(new Event('change', { bubbles: true }))
    expect((await panelReport(f, 'the project filter', (report) => report.filter === 'repo')).rows.map((r) => r.id)).toEqual(['hello'])
  },
  FEATURE_MS
)

test(
  'SC-51: running from the tab strip',
  async () => {
    const f = await startFeatures()
    const { h } = f
    mkdirSync(join(h.repo, 'web'))
    await viewReport(f, 'a mounted pane')

    // with no commands the button is one Command button that opens the Add dialog
    const single = await until(f, () => document.querySelector<HTMLButtonElement>('.qc-strip .qc-single'))
    expect(single.textContent).toBe('Command')
    expect(single.title).toBe('Save a quick command for this repo')
    single.click()
    await until(f, () => dialog('Add Quick Command'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor('the dialog to close', () => (dialog('Add Quick Command') ? undefined : true))

    await addCommand(f, { label: 'Hello', command: 'echo hello' })
    const run = await until(f, () => document.querySelector<HTMLButtonElement>('.qc-strip [data-qc-run]'))
    expect(run.textContent).toBe('Hello')
    const before = new Set(tabsOf(await layoutOf(h, f.worktree)).map((tab) => tab.id))
    run.click()
    const ws = await waitFor('the Hello tab', async () => {
      const next = await layoutOf(h, f.worktree)
      return tabsOf(next).some((tab) => !before.has(tab.id)) ? next : undefined
    })
    const tab = tabsOf(ws).find((candidate) => !before.has(candidate.id))!
    expect(tab.defaultTitle).toBe('Hello')
    const session = leavesOf(tab.root)[0]!.session
    const rows = await h.waitForLine(session, 'hello')
    expect(rows.filter((line) => line === 'hello')).toHaveLength(1)
    expect(rows.filter((line) => /[%#] echo hello$/.test(line))).toHaveLength(1)
    expect(rows.findIndex((line) => /[%#] echo hello$/.test(line))).toBeLessThan(rows.indexOf('hello'))
    expect(ws.activeGroup).toBe(groupsOf(ws).find((group) => group.activeTab === tab.id)!.id)
    await waitForScreen(f, session, 'hello in the window', (lines) => lines.includes('hello'))

    // a multi-line command runs joined with "; ", from the chevron menu, and the button now reads it
    await addCommand(f, { label: 'Two lines', command: 'cd web\npwd' })
    const chevron = await until(f, () => document.querySelector<HTMLButtonElement>('.qc-strip button[aria-label="More quick commands"]'))
    const menu = await waitFor('the menu with both commands', async () => {
      if (!document.querySelector('.qc-menu')) chevron.click()
      await Bun.sleep(100)
      const open = document.querySelector('.qc-menu')
      if (open?.querySelector('[data-command="two-lines"]')) return open
      if (open) chevron.click()
      return undefined
    })
    expect(menu.querySelector('input')?.getAttribute('placeholder')).toBe('Search quick commands...')
    for (const label of ['Hello', 'Two lines']) {
      for (const action of ['Copy', 'Edit', 'Delete']) expect(menu.querySelector(`button[aria-label="${action} ${label}"]`), `${action} ${label}`).not.toBeNull()
    }
    expect(byText('.qc-menu-footer button', '+ Command')).toBeDefined()
    menu.querySelector<HTMLElement>('[data-command="two-lines"]')!.click()
    const multi = await waitFor('the second tab', async () => {
      const next = tabsOf(await layoutOf(h, f.worktree)).find((candidate) => candidate.defaultTitle === 'Two lines')
      return next ? leavesOf(next.root)[0]!.session : undefined
    })
    const multiRows = await h.waitForLine(multi, join(h.repo, 'web'))
    expect(multiRows.some((line) => line.endsWith('cd web; pwd'))).toBe(true)
    await waitFor('the button to read the last command', () => (document.querySelector('.qc-strip [data-qc-run]')?.textContent === 'Two lines' ? true : undefined))
    expect(groupsOf(await layoutOf(h, f.worktree))[0]!.lastQuickCommand).toBe('two-lines')

    // the CLI reaches the same outcome
    const viaCli = await h.json<{ session: string }>(['terminal', 'quick-command', 'run', 'hello'])
    const cliRows = await h.waitForLine(viaCli.session, 'hello')
    expect(cliRows.filter((line) => line === 'hello')).toHaveLength(1)
  },
  FEATURE_MS
)

const submenuRows = () => [...document.querySelectorAll('.qt-submenu [role="menuitem"]')].map((item) => ({ label: item.querySelector('.qt-menu-label')?.textContent, key: item.querySelector('.qt-menu-key')?.textContent ?? null }))

test(
  'SC-52: running from the pane menu',
  async () => {
    const f = await startFeatures()
    const { h } = f
    const report = await viewReport(f, 'a mounted pane')
    const session = focusedSession(report)
    const pane = report.focusedPane!
    const openPaneMenu = async () => {
      document.querySelector(`[data-pane="${pane}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }))
      await until(f, () => document.querySelector('.qt-menu'))
      menuRow('.qt-menu-anchor', 'Quick Commands')!.click()
      await until(f, () => document.querySelector('.qt-submenu'))
    }
    const closeMenu = async () => {
      await runCommand(f, 'close-menu')
      await waitFor('the menu to close', () => (document.querySelector('.qt-menu') ? undefined : true))
    }

    // with no commands the submenu says so and offers Add Quick Command…
    await openPaneMenu()
    expect(submenuRows()).toEqual([
      { label: 'No quick commands', key: null },
      { label: 'Add Quick Command…', key: null }
    ])
    menuRow('.qt-submenu', 'Add Quick Command…')!.click()
    await until(f, () => dialog('Add Quick Command'))
    byText<HTMLButtonElement>('.qc-dialog-foot button', 'Cancel')!.click()
    await waitFor('the dialog to close', () => (dialog('Add Quick Command') ? undefined : true))
    await closeMenu()

    await addCommand(f, { label: 'Hello', command: 'echo hello' })
    await addCommand(f, { label: 'Draft', command: 'echo draft', appendEnter: false })
    await focusTerminal(f, session)
    await waitFor('both commands in the menu', async () => {
      await closeMenu().catch(() => {})
      await openPaneMenu()
      return submenuRows().length === 3 ? true : undefined
    })
    expect(submenuRows()).toEqual([
      { label: 'Hello', key: null },
      { label: 'Draft', key: 'Insert' },
      { label: 'Add Quick Command…', key: null }
    ])
    const opened = await viewReport(f, 'the pane menu', (candidate) => candidate.menu?.kind === 'pane')
    expect(opened.menu!.items.map((item) => item.label)).toContain('Quick Commands')

    menuRow('.qt-submenu', 'Draft')!.click()
    await waitFor('the draft at the prompt', async () => ((await h.screen(session)).some((line) => /[%#] echo draft$/.test(line)) ? true : undefined))
    await Bun.sleep(500)
    expect((await h.screen(session)).includes('draft')).toBe(false)
    await waitForScreen(f, session, 'the draft in the window', (lines) => lines.some((line) => /[%#] echo draft$/.test(line)))

    // picking Hello types and runs it (the draft stays on the line, so clear it first)
    await h.call('quirky.terminal/write', { session, data: '\x15' })
    await closeMenu()
    await openPaneMenu()
    menuRow('.qt-submenu', 'Hello')!.click()
    await h.waitForLine(session, 'hello')
    expect((await h.screen(session)).filter((line) => line === 'hello')).toHaveLength(1)

    // the window command opens the same menu for an agent
    await runCommand(f, 'open-menu', { kind: 'pane', target: pane })
    expect((await viewReport(f, 'the opened menu', (candidate) => candidate.menu?.kind === 'pane' && candidate.menu.target === pane)).menu!.items.map((item) => item.label)).toContain('Quick Commands')
    await closeMenu()

    // and so does the CLI, which types the draft without running it
    await h.cli(['terminal', 'quick-command', 'run', 'draft', '--pane', pane])
    await waitFor('the draft typed by the CLI', async () => ((await h.screen(session)).some((line) => /[%#] echo draft$/.test(line)) ? true : undefined))
  },
  FEATURE_MS
)

test(
  'SC-53: agent prompt commands open an agent tab',
  async () => {
    agents = await startAgentsE2E({ fakes: { claude: true, aider: true } })
    const f = await attachFeatures(agents)
    const rows = ((await agents.call('quirky.agents/list', {})) as { agents: { id: string; label: string; installed: boolean; enabled: boolean; promptMode: string }[] }).agents
    const offered = rows.filter((row) => row.installed && row.enabled && row.promptMode !== 'stdin-after-start').map((row) => row.label)
    const typedAfter = rows.filter((row) => row.installed && row.promptMode === 'stdin-after-start').map((row) => row.label)
    expect(offered.length).toBeGreaterThan(0)
    expect(typedAfter.length).toBeGreaterThan(0)

    // the Add dialog offers only agents that take the prompt on the command line
    const single = await until(f, () => document.querySelector<HTMLButtonElement>('.qc-strip .qc-single'))
    single.click()
    await until(f, () => dialog('Add Quick Command'))
    const action = document.querySelector<HTMLInputElement>('.qc-dialog [name="action"][value="agent"]')!
    action.click()
    await waitFor('the agent select to open up', () => (field<HTMLSelectElement>('agent').disabled ? undefined : true))
    await waitFor('the agent options', () => ([...field<HTMLSelectElement>('agent').options].length > 1 ? true : undefined))
    const options = [...field<HTMLSelectElement>('agent').options].map((option) => option.textContent).filter((text) => text !== 'Choose agent')
    expect(options.sort()).toEqual([...offered].sort())
    for (const label of typedAfter) expect(options).not.toContain(label)
    byText<HTMLButtonElement>('.qc-dialog-foot button', 'Cancel')!.click()

    const added = await agents.cli(['terminal', 'quick-command', 'add', '--label', 'Review', '--kind', 'agent', '--agent', 'claude', '--command', 'review the diff', '--json'])
    expect(added.code, added.stderr).toBe(0)
    const refused = await agents.cli(['terminal', 'quick-command', 'add', '--label', 'Typed', '--kind', 'agent', '--agent', 'aider', '--command', 'hello'])
    expect(refused.code).toBe(1)

    // running it from the strip opens a Claude tab with the prompt as its first argument
    const run = await until(f, () => document.querySelector<HTMLButtonElement>('.qc-strip [data-qc-run]'))
    expect(run.textContent).toBe('Review')
    run.click()
    const report = await viewReport(f, 'a Claude tab', (candidate) => candidate.tabs.some((tab) => tab.agent === 'claude'))
    expect(report.tabs.filter((tab) => tab.agent === 'claude')).toHaveLength(1)
    const events = await agents.waitForFakeLog('claude', (log) => log.some((event) => event.type === 'start'), 20_000)
    const start = events.find((event) => event.type === 'start')
    if (start?.type !== 'start') throw new Error('claude never started')
    expect(start.argv.at(-1)).toBe('review the diff')

    const viaCli = await agents.cli(['terminal', 'quick-command', 'run', 'review', '--json'])
    expect(viaCli.code, viaCli.stderr).toBe(0)
    await viewReport(f, 'a second Claude tab', (candidate) => candidate.tabs.filter((tab) => tab.agent === 'claude').length === 2)
  },
  FEATURE_MS
)
