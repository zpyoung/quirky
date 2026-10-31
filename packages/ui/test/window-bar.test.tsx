import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Ask, type Repo, type Session, type Worktree } from '@quirky/protocol'
import { chromium } from 'playwright'
import { renderToStaticMarkup } from 'react-dom/server'
import { Banner } from '../../../plugins/quirky.feedback/src/mode/Banner'
import { makeTempDir } from '../../daemon/test/plugins/fixtures'
import { launchableAgents, projectCounts, scopeLabel, worktreeRowState } from '../src/shell/WindowBar'
import { attentionStoreFor } from '../src/shell/attention'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

const BAR = '[aria-label="Window bar"]'
const SEARCH = 'Search commands, tools, views, and worktrees'

afterEach(closeWindows)

function builtinPlugins(): string {
  const builtins = makeTempDir('ui-window-bar-builtins-')
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.cli', 'quirky.sidebar-extras', 'quirky.ask', 'quirky.agents']) {
    symlinkSync(resolve(import.meta.dir, '../../../plugins', id), join(builtins, id))
  }
  installUiPlugin(
    builtins,
    'quirky.session',
    { view: [{ id: 'worktree', title: 'Session worktree' }] },
    provide('view:quirky.session/worktree', `element.textContent = 'session ' + JSON.stringify(props.input ?? null)`)
  )
  return builtins
}

async function bootBar(captureUnselectedMarkup = false) {
  const env = await bootWindow(() => {}, { builtinPluginsDir: builtinPlugins() })
  const repos = await Promise.all(['alpha', 'beta'].map(async (name) => {
    const path = makeTempDir(`ui-window-bar-${name}-`)
    return env.agent.callAny('quirky.repo/add', { path, folder: true }) as Promise<Repo>
  }))
  const attention = attentionStoreFor(env.win.connection, env.win.host)
  await env.win.waitFor(() => (attention.getSnapshot().worktrees?.length ?? 0) >= 2)
  const worktrees = attention.getSnapshot().worktrees!
  const [first, second] = repos.map((repo) => worktrees.find((worktree) => worktree.repoId === repo.id)!)
  let unselectedMarkup: string | undefined
  if (captureUnselectedMarkup) {
    await env.win.waitFor(() => env.win.document.querySelector(BAR)?.textContent?.includes('No worktree selected'))
    unselectedMarkup = bar(env).outerHTML
  }
  await env.agent.callAny('quirky.worktree/navigate', { worktree: first!.id })
  await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === first!.id)
  return { env, attention, repos: repos as [Repo, Repo], first: first!, second: second!, unselectedMarkup }
}

const bar = (env: WindowEnv) => env.win.document.querySelector<HTMLElement>(BAR)!
const barButtons = (env: WindowEnv) => [...bar(env).querySelectorAll<HTMLButtonElement>('button')]
const nameOf = (button: Element) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
const barButton = (env: WindowEnv, name: string) => barButtons(env).find((button) => nameOf(button) === name)
const rowsOf = (env: WindowEnv) => [...env.win.document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')]
const rowText = (row: Element) => {
  const copy = row.cloneNode(true) as HTMLElement
  for (const mark of copy.querySelectorAll('.ui-project-tile, .ui-status-dot, [aria-label="Current"]')) mark.remove()
  return (copy.textContent ?? '').replace(/✓$/, '').replace(/\s+/g, ' ').trim()
}
const rowNamed = (env: WindowEnv, label: string) => rowsOf(env).find((row) => rowText(row).startsWith(label))

async function click(env: WindowEnv, element: HTMLElement | undefined): Promise<void> {
  expect(element).toBeDefined()
  element!.click()
  await Bun.sleep(0)
}

function recordCommands(env: WindowEnv): string[] {
  const ran: string[] = []
  const host = env.win.host
  const run = host.runCommand.bind(host)
  host.runCommand = (id: string, args?: unknown) => {
    ran.push(args === undefined ? id : `${id} ${JSON.stringify(args)}`)
    return run(id, args)
  }
  return ran
}

describe('window bar', () => {
  test.skipIf(!existsSync(chromium.executablePath()))('header controls stay separated and reachable at native widths', async () => {
    const { env } = await bootBar()
    await env.win.waitFor(() => barButton(env, '0 pending questions'))
    const markup = bar(env).outerHTML
    const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
    try {
      const page = await browser.newPage({ viewport: { width: 1054, height: 80 } })
      const styles = await Promise.all([
        '../src/design-system/tokens.css',
        '../src/design-system/components.css',
        '../src/shell/chrome.css'
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))
      const css = `${styles.join('\n')}\nbody { margin: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }`
      const labelSets = [
        { project: 'alpha', worktree: 'main' },
        {
          project: 'extraordinarily-long-project-label-for-window-bar-layout',
          worktree: 'extraordinarily-long-worktree-label-for-window-bar-layout'
        }
      ]

      for (const theme of ['dark', 'light']) {
        for (const width of [646, 768, 769, 1054]) {
          for (const labels of labelSets) {
            await page.setViewportSize({ width, height: 80 })
            await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="app" data-theme="${theme}">${markup}</div></body></html>`)
            await page.locator(BAR).evaluate((header, labels) => {
              const [project, worktree] = header.querySelectorAll<HTMLElement>('.window-bar__label')
              project!.textContent = labels.project
              worktree!.textContent = labels.worktree
            }, labels)

            const geometry = await page.locator(BAR).evaluate((header) => {
              const headerRect = header.getBoundingClientRect()
              const buttons = [...header.querySelectorAll<HTMLButtonElement>('button')].map((button) => {
                const rect = button.getBoundingClientRect()
                return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
              })
              return {
                header: { left: headerRect.left, right: headerRect.right, top: headerRect.top, bottom: headerRect.bottom },
                buttons
              }
            })
            expect(geometry.buttons.length).toBeGreaterThan(1)
            for (let index = 0; index < geometry.buttons.length; index++) {
              const button = geometry.buttons[index]!
              expect(button.left).toBeGreaterThanOrEqual(geometry.header.left)
              expect(button.right).toBeLessThanOrEqual(geometry.header.right)
              expect(button.top).toBeGreaterThanOrEqual(geometry.header.top)
              expect(button.bottom).toBeLessThanOrEqual(geometry.header.bottom)
              expect(button.width).toBeGreaterThan(0)
              expect(button.height).toBeGreaterThan(0)
              for (let previous = 0; previous < index; previous++) {
                expect(button.left).toBeGreaterThanOrEqual(geometry.buttons[previous]!.right)
              }
            }

            const search = page.getByRole('button', { name: SEARCH, exact: true })
            expect(await search.isVisible()).toBe(true)
            expect(await search.locator('svg').isVisible()).toBe(true)
            for (const control of [
              page.locator(`${BAR} .window-bar__switcher`).nth(0),
              page.locator(`${BAR} .window-bar__switcher`).nth(1),
              page.getByRole('button', { name: 'New worktree', exact: true }),
              page.getByRole('button', { name: 'Back', exact: true }),
              page.getByRole('button', { name: 'Forward', exact: true }),
              page.getByRole('button', { name: 'New agent', exact: true }),
              page.getByRole('button', { name: 'Choose agent', exact: true })
            ]) {
              expect(await control.isVisible()).toBe(true)
            }
          }
        }
      }
    } finally {
      await browser.close()
    }
  }, 60_000)
  test.skipIf(!existsSync(chromium.executablePath()))('feedback banner clears toolbar controls and leaves Exit reachable', async () => {
    const { env, unselectedMarkup } = await bootBar(true)
    const toolbarMarkups = [unselectedMarkup!, bar(env).outerHTML]
    const bannerMarkup = renderToStaticMarkup(<Banner onExit={() => {}} />)
    const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
    try {
      const page = await browser.newPage({ viewport: { width: 1054, height: 100 } })
      const styles = await Promise.all([
        '../src/design-system/tokens.css',
        '../src/design-system/components.css',
        '../src/shell/chrome.css'
      ].map((path) => Bun.file(new URL(path, import.meta.url)).text()))
      const css = `${styles.join('\n')}\nbody { margin: 0; font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }`

      for (const toolbarMarkup of toolbarMarkups) {
        for (const width of [646, 768, 1054, 1568]) {
          await page.setViewportSize({ width, height: 100 })
          await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body><div class="app" data-theme="dark">${toolbarMarkup}${bannerMarkup}</div></body></html>`)

          const layout = await page.evaluate(() => {
            const toolbar = document.querySelector<HTMLElement>('[aria-label="Window bar"]')!
            const banner = document.querySelector<HTMLElement>('[data-feedback-banner]')!
            const toolbarRect = toolbar.getBoundingClientRect()
            const bannerRect = banner.getBoundingClientRect()
            const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button')].map((button) => {
              const rect = button.getBoundingClientRect()
              const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              return {
                name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
                intersectsBanner: rect.left < bannerRect.right && rect.right > bannerRect.left &&
                  rect.top < bannerRect.bottom && rect.bottom > bannerRect.top,
                centerReceivesPointer: hit === button || button.contains(hit)
              }
            })
            return {
              bannerGap: bannerRect.top - toolbarRect.bottom,
              overlappingButtons: buttons.filter((button) => button.intersectsBanner).map((button) => button.name),
              blockedButtons: buttons.filter((button) => !button.centerReceivesPointer).map((button) => button.name)
            }
          })

          expect(layout.overlappingButtons).toEqual([])
          expect(layout.bannerGap).toBeGreaterThanOrEqual(12)
          expect(layout.blockedButtons).toEqual([])

          const exit = page.getByRole('button', { name: 'Exit', exact: true })
          await exit.evaluate((button) => button.addEventListener('click', () => button.setAttribute('data-exit-clicked', ''), { once: true }))
          await exit.click()
          expect(await exit.getAttribute('data-exit-clicked')).not.toBeNull()
        }
      }
    } finally {
      await browser.close()
    }
  }, 60_000)


  test('the bar drags, every control opts out, and the controls keep their order', async () => {
    const { env, attention, first } = await bootBar()
    await env.win.waitFor(() => barButton(env, '0 pending questions'))
    const selected = attention.getSnapshot().worktrees!.find((worktree) => worktree.id === first.id)!

    expect(bar(env).classList.contains('electrobun-webkit-app-region-drag')).toBe(true)
    const controls = [...bar(env).querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role="button"], [tabindex]')]
    expect(controls.length).toBeGreaterThan(0)
    for (const control of controls) expect(control.classList.contains('electrobun-webkit-app-region-no-drag')).toBe(true)

    expect(barButtons(env).map(nameOf)).toEqual([
      'All projects',
      selected.name,
      'New worktree',
      'Back',
      'Forward',
      'New agent',
      'Choose agent',
      '0 pending questions',
      SEARCH,
      'More'
    ])
  })

  test('the bar shows no agent status and New agent runs the default agent command', async () => {
    const { env } = await bootBar()
    const ran = recordCommands(env)
    await env.win.waitFor(() => barButton(env, 'New agent'))
    // the needs-you indicator is the bar's only status dot
    expect(bar(env).querySelectorAll('.ui-status-dot')).toHaveLength(1)
    expect(bar(env).textContent).not.toMatch(/working|running|waiting/i)

    await click(env, barButton(env, 'New agent'))
    expect(ran).toEqual(['command:quirky.agents/new-agent-tab'])
  })

  test('the New agent caret opens a menu that ends with Agent settings', async () => {
    const { env } = await bootBar()
    await env.win.waitFor(() => barButton(env, 'Choose agent'))
    await click(env, barButton(env, 'Choose agent'))
    await env.win.waitFor(() => rowNamed(env, 'Agent settings…'))
    expect(rowsOf(env).at(-1)?.textContent).toBe('Agent settings…')
  })

  test('Settings is reachable only through More', async () => {
    const { env } = await bootBar()
    await env.win.waitFor(() => barButton(env, 'More'))
    expect(env.win.document.querySelector('button[aria-label="Settings"]')).toBeNull()

    await click(env, barButton(env, 'More'))
    const settings = await env.win.waitFor(() => rowNamed(env, 'Settings'))
    expect(settings.getAttribute('role')).toBe('menuitem')
    await click(env, settings)
    await env.win.waitFor(() => env.win.document.querySelector('[role="dialog"]')?.textContent?.includes('Settings'))
  })

  test('Search opens the palette', async () => {
    const { env } = await bootBar()
    await env.win.waitFor(() => barButton(env, SEARCH))
    await click(env, barButton(env, SEARCH))
    await env.win.waitFor(() => env.win.document.querySelector('.ui-dialog input'))
  })

  test('Search qualifies its shortcut as available outside the terminal', async () => {
    const { env } = await bootBar()
    const search = await env.win.waitFor(() => barButton(env, SEARCH))

    expect(search.querySelector('kbd')?.textContent).toBe('⌘K')
    expect(search.textContent).toContain('(outside terminal)')
  })

  test('New worktree and Add project run their commands', async () => {
    const { env } = await bootBar()
    const ran = recordCommands(env)
    await env.win.waitFor(() => barButton(env, 'New worktree'))

    await click(env, barButton(env, 'New worktree'))
    expect(ran).toEqual(['command:quirky.worktree/new-worktree'])

    await click(env, barButton(env, 'All projects'))
    await env.win.waitFor(() => rowNamed(env, 'Add project…'))
    await click(env, rowNamed(env, 'Add project…'))
    expect(ran).toEqual(['command:quirky.worktree/new-worktree', 'command:quirky.worktree/add-project'])

    await click(env, barButtons(env)[1])
    await env.win.waitFor(() => rowNamed(env, 'New worktree…'))
    await click(env, rowNamed(env, 'New worktree…'))
    expect(ran.at(-1)).toBe('command:quirky.worktree/new-worktree')
  })

  test('the project switcher lists All projects and each project with its counts, then narrows and widens', async () => {
    const { env, attention, repos, first, second } = await bootBar()
    await env.win.waitFor(() => barButton(env, 'All projects'))
    expect(barButton(env, 'All projects')).toBeDefined()

    await click(env, barButton(env, 'All projects'))
    await env.win.waitFor(() => rowNamed(env, 'All projects'))
    const alpha = repos[0].displayName ?? repos[0].name
    const beta = repos[1].displayName ?? repos[1].name
    const listed = attention.getSnapshot().repos!.map((repo) => repo.displayName ?? repo.name)
    expect(rowsOf(env).map(rowText)).toEqual([
      'All projects2 worktrees',
      ...listed.map((name) => `${name}1 worktree`),
      'Add project…'
    ])

    await click(env, rowNamed(env, beta))
    await env.win.waitFor(() => attention.getSnapshot().filterRepoIds.join() === repos[1].id)
    expect(await env.agent.callAny('quirky.worktree/options', {})).toMatchObject({ filterRepoIds: [repos[1].id] })
    await env.win.waitFor(() => attention.getSnapshot().selectedWorktreeId === second.id)
    expect(barButton(env, beta)).toBeDefined()

    await env.agent.callAny('quirky.worktree/setOptions', { filterRepoIds: repos.map((repo) => repo.id) })
    await env.win.waitFor(() => barButton(env, '2 projects'))

    await env.agent.callAny('quirky.worktree/setOptions', { filterRepoIds: [] })
    await env.win.waitFor(() => barButton(env, 'All projects'))
    expect(attention.getSnapshot().selectedWorktreeId).toBe(second.id)
    expect(first.id).not.toBe(second.id)
  })

  test('the worktree switcher offers New worktree then worktrees grouped by project', async () => {
    const { env, attention, first, second } = await bootBar()
    await env.win.waitFor(() => barButtons(env)[1])
    await click(env, barButtons(env)[1])
    await env.win.waitFor(() => rowNamed(env, 'New worktree…'))
    expect(env.win.document.querySelector('.ui-popup input')?.getAttribute('aria-label')).toBe('Search worktrees and actions')
    const entries = [...env.win.document.querySelectorAll('.ui-popup .qt-menu [role="menuitem"], .ui-popup .qt-menu-heading')]
    const grouped = attention.getSnapshot().repos!.flatMap((repo) => {
      const member = attention.getSnapshot().worktrees!.find((worktree) => worktree.repoId === repo.id)!
      return [repo.displayName ?? repo.name, `${member.name}Activity unavailable`]
    })
    expect(entries.map(rowText)).toEqual(['New worktree…⌘N', ...grouped])

    await click(env, rowNamed(env, second.name))
    await env.win.waitFor(() => env.win.host.getState().layout.worktree === second.id)
    expect(first.id).not.toBe(second.id)
  })
})

const worktree = (overrides: Partial<Worktree> & { id: string }): Worktree => ({
  repoId: 'r1', path: '/w', branch: 'main', head: 'abc', isMain: false, name: overrides.id, kind: 'git', displayName: null,
  comment: '', status: 'in-progress', pinned: false, unread: false, parentId: null, createdAt: 0, createdBy: 'external',
  baseRef: null, keepBranch: false, removing: false, groupId: null, projectGroupId: null, lastActivityAt: 0, instanceId: 'i',
  ...overrides
})

const session = (worktreeId: string, status: Session['status'], extra: Partial<Session> = {}): Session => ({
  id: `s-${worktreeId}-${status}`, kind: 'agent', agent: 'claude', worktreeId, cwd: '/w', title: '', status, createdAt: 0,
  lastActivityAt: 0, exitCode: null, exitSignal: null, exitCause: null, restorable: false, ...extra
} as Session)

const summary = (display: string, label: string, extra: Record<string, unknown> = {}) => ({
  state: display === 'waiting' ? 'waiting' : display === 'done' ? 'done' : 'working',
  display, label, detail: '', progress: null, stateStartedAt: 0, evidenceAt: 1_000, restoredUnconfirmed: false, ...extra
}) as unknown as Session['agentStatus']

describe('worktree rows map status and activity like the Worktrees panel', () => {
  const now = 2_000

  test('a pending question wins, then removal, sleep, the agent glyph, and finally idle', () => {
    expect(worktreeRowState(worktree({ id: 'a' }), [session('a', 'running')], 2, now)).toMatchObject({ status: 'needs-you', needsYou: 2 })
    expect(worktreeRowState(worktree({ id: 'a', removing: true }), [], 0, now)).toEqual({ status: 'queued', activity: 'Deleting…', needsYou: 0 })
    expect(worktreeRowState({ ...worktree({ id: 'a' }), sleeping: true } as Worktree, [session('a', 'running')], 0, now))
      .toEqual({ status: 'idle', activity: 'Sleeping', needsYou: 0 })
    expect(worktreeRowState(worktree({ id: 'a' }), [], 0, now)).toEqual({ status: 'idle', activity: 'Idle', needsYou: 0 })
    expect(worktreeRowState({ ...worktree({ id: 'a' }), archivedAt: 5 } as Worktree, [], 0, now)).toEqual({ status: 'idle', activity: 'Archived', needsYou: 0 })
    expect(worktreeRowState(worktree({ id: 'a' }), null, 0, now)).toEqual({ status: 'queued', activity: 'Activity unavailable', needsYou: 0 })
  })

  test('the most urgent session sets the dot and names its agent in the activity line', () => {
    const working = session('a', 'running', { id: 's1', title: 'Claude', agentStatus: summary('working', 'Running tests') })
    const done = session('a', 'running', { id: 's2', title: 'Codex', agentStatus: summary('done', 'Finished') })
    expect(worktreeRowState(worktree({ id: 'a' }), [done, working], 0, now)).toEqual({
      status: 'working',
      activity: 'Claude · Running tests',
      needsYou: 0
    })
    const waiting = session('a', 'running', { id: 's3', title: '', agent: 'codex', agentStatus: summary('waiting', '') })
    expect(worktreeRowState(worktree({ id: 'a' }), [working, waiting], 0, now)).toEqual({
      status: 'needs-you',
      activity: 'codex · Needs you',
      needsYou: 0
    })
    expect(worktreeRowState(worktree({ id: 'a' }), [session('a', 'exited')], 0, now)).toEqual({ status: 'idle', activity: 'claude · Exited', needsYou: 0 })
    expect(worktreeRowState(worktree({ id: 'a' }), [session('a', 'starting')], 0, now)).toEqual({ status: 'queued', activity: 'claude · Running', needsYou: 0 })
  })

  test('an unfinished state without evidence for half an hour stops being vouched for', () => {
    const stale = session('a', 'running', { title: 'Claude', agentStatus: summary('working', 'Running tests') })
    const later = 1_000 + 31 * 60 * 1000
    expect(worktreeRowState(worktree({ id: 'a' }), [stale], 0, later)).toEqual({
      status: 'idle',
      activity: 'Claude · No recent update',
      needsYou: 0
    })
  })
})

describe('the New agent caret', () => {
  const listing = {
    defaultAgent: 'claude',
    agents: [
      { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: false },
      { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true },
      { id: 'aider', label: 'Aider', installed: false, enabled: true, isDefault: false },
      { id: 'goose', label: 'Goose', installed: true, enabled: false, isDefault: false },
      { id: 'ghost', label: 'Ghost', installed: true, enabled: true, isDefault: false }
    ]
  }
  const commands = new Set(['codex', 'claude', 'aider', 'goose'].map((id) => `command:quirky.agents/new-${id}-tab`))

  test('offers installed enabled agents that have a tab command, the default first', () => {
    expect(launchableAgents(listing, commands).map((agent) => agent.id)).toEqual(['claude', 'codex'])
    expect(launchableAgents(null, commands)).toEqual([])
  })
})

describe('project scope and counts', () => {
  const repos = [
    { id: 'r1', name: 'api', displayName: null },
    { id: 'r2', name: 'web', displayName: 'Web app' }
  ] as Repo[]

  test('the switcher reads All projects, the one project, or a project count', () => {
    expect(scopeLabel([], repos)).toBe('All projects')
    expect(scopeLabel(['r1'], repos)).toBe('api')
    expect(scopeLabel(['r2'], repos)).toBe('Web app')
    expect(scopeLabel(['r1', 'r2'], repos)).toBe('2 projects')
    expect(scopeLabel(['gone'], repos)).toBe('Project unavailable')
  })

  test('each project counts its worktrees, working sessions and pending questions; All counts every one', () => {
    const worktrees = [worktree({ id: 'a', repoId: 'r1' }), worktree({ id: 'b', repoId: 'r1' }), worktree({ id: 'c', repoId: 'r2' })]
    const sessions = [session('a', 'working'), session('b', 'working'), session('c', 'running'), session('c', 'working')]
    const asks = [{ worktreeId: 'c' }, { worktreeId: 'c' }, { worktreeId: null }] as Ask[]
    const { all, byRepo } = projectCounts(repos, worktrees, sessions, asks)
    expect(all).toEqual({ worktrees: 3, working: 3, needsYou: 3 })
    expect(byRepo.get('r1')).toEqual({ worktrees: 2, working: 2, needsYou: 0 })
    expect(byRepo.get('r2')).toEqual({ worktrees: 1, working: 1, needsYou: 2 })
  })
})
