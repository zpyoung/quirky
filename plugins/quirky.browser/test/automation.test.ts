import { existsSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { expect, spyOn, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { PaneService } from '../src/pane-service'

const call = (client: BrowserTestHarness['client'], name: string, params: Record<string, unknown> = {}) =>
  client.callAny(`quirky.browser/${name}`, params)

async function newPage(h: BrowserTestHarness, url = `${h.fixtureUrl}events`, profile?: string) {
  return await call(h.client, 'tabCreate', { url, ...(profile ? { profile } : {}) }) as { browserPageId: string }
}

async function runBrowserCli(h: BrowserTestHarness, argv: string[]) {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, { yes: argv.includes('--yes') }),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

type Outcome<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }
function settle<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason })
  )
}

async function signalBefore(signal: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs)
  try { return await Promise.race([signal.then(() => true), timeout.promise]) }
  finally { clearTimeout(timer) }
}

type BrowserPageState = {
  browserPageId: string
  worktreeId: string | null
  profileId: string
  index: number
  url: string
}
type BrowserPaneState = {
  id: string
  worktreeId: string
  mode: string
  page: string | null
  profileId: string
  partition: string
  tabId: string
}
type BrowserPaneList = { tabs: BrowserPaneState[]; active: string | null }
type HostTab = { id: string; kind?: string; viewId?: string; key?: string; input?: Record<string, unknown> }
type HostGroup = { kind: 'group'; id: string; tabs: HostTab[]; activeTab: string | null }
type HostSplit = { kind: 'split'; first: HostTree; second: HostTree }
type HostTree = HostGroup | HostSplit
type TerminalWorkspace = { id: string; activeGroup: string; root: HostTree }
type WindowState = { layout: Record<string, unknown> & { view?: unknown; worktree?: string } }
type StandInWindow = { client: QuirkyClient; connId: number }

function groupsIn(node: HostTree): HostGroup[] {
  return node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)]
}

function activeTerminalTab(workspace: TerminalWorkspace): string | null {
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

async function terminalWorkspace(h: BrowserTestHarness, worktree: string): Promise<TerminalWorkspace> {
  const result = await h.client.callAny('quirky.terminal/workspace', { workspace: worktree === 'floating' ? 'floating' : `id:${worktree}` }) as { workspace: TerminalWorkspace }
  return result.workspace
}

function expectHostedTab(workspace: TerminalWorkspace, pane: BrowserPaneState): void {
  expect(pane.tabId).toBeTruthy()
  const hosted = groupsIn(workspace.root).flatMap((group) => group.tabs).find((tab) => tab.id === pane.tabId)
  expect(hosted).toMatchObject({
    id: pane.tabId,
    kind: 'view',
    viewId: 'view:quirky.browser/page',
    key: `browser:${pane.id}`,
    input: { pane: pane.id }
  })
  expect(activeTerminalTab(workspace)).toBe(pane.tabId)
}

async function standInWindow(h: BrowserTestHarness, name: string): Promise<StandInWindow> {
  const client = await h.daemon.connect('ui', name)
  const { connId } = await client.callAny('ui.window.self', {}) as { connId: number }
  return { client, connId }
}

async function showWorktree(h: BrowserTestHarness, connId: number, worktree: string): Promise<void> {
  await h.client.callAny('ui.window.view.open', {
    connId,
    id: 'view:quirky.session/worktree',
    input: { worktree }
  })
}

async function windowState(h: BrowserTestHarness, connId: number): Promise<WindowState> {
  return await h.client.callAny('ui.window.state', { connId }) as WindowState
}

async function waitUntilWindowGone(h: BrowserTestHarness, connId: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = await h.client.callAny('ui.state', {}) as { windows: Array<{ connId: number }> }
    if (!state.windows.some((window) => window.connId === connId)) return
    // The daemon removes UI connections asynchronously; polling its live state observes that teardown.
    await Bun.sleep(10)
  }
  throw new Error(`UI window ${connId} remained connected after close`)
}

test('C1: profile metadata is lazy and each isolated profile owns one Chrome/helper pair', async () => {
  const h = await startBrowserHarness()
  try {
    const profilesBeforeUse = await call(h.client, 'profileList') as { profiles: Array<{ id: string; scope: string }> }
    expect(profilesBeforeUse.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'default', scope: 'default' })]))
    expect(h.spawnCount()).toBe(0)

    const isolated = await call(h.client, 'profileCreate', { name: 'Review' }) as { profile: { id: string; scope: string } }
    expect(isolated.profile.scope).toBe('isolated')
    expect(h.spawnCount()).toBe(0)

    const [first, second] = await Promise.all([
      newPage(h, `${h.fixtureUrl}events`, isolated.profile.id),
      newPage(h, `${h.fixtureUrl}events`, isolated.profile.id)
    ])
    expect(first.browserPageId).not.toBe(second.browserPageId)
    expect(h.spawnCount()).toBe(2)
    const anotherPage = await newPage(h, `${h.fixtureUrl}first`, isolated.profile.id)
    expect(anotherPage.browserPageId).not.toBe(first.browserPageId)
    expect(h.spawnCount()).toBe(2)

    const defaultPage = await newPage(h)
    expect(defaultPage.browserPageId).toBeTruthy()
    expect(h.spawnCount()).toBe(4)
    const commands = h.spawnCommands()
    expect(commands.filter((command) => command.length === 1)).toHaveLength(2)
    const chrome = commands.filter((command) => command.includes('--headless=new'))
    expect(chrome).toHaveLength(2)
    const dataDir = join(h.home, 'plugin-data', 'quirky.browser', 'profiles')
    const ownedDirectories = chrome.map((command) => {
      const argument = command.find((arg) => arg.startsWith('--user-data-dir='))
      if (!argument) throw new Error('Owned Chrome has no profile directory')
      return realpathSync(argument.slice('--user-data-dir='.length))
    })
    expect(new Set(ownedDirectories).size).toBe(2)
    for (const directory of ownedDirectories) {
      const ownedPath = relative(realpathSync(h.home), directory)
      expect(ownedPath !== '..' && !ownedPath.startsWith(`..${sep}`) && !isAbsolute(ownedPath)).toBe(true)
    }
    expect(existsSync(join(dataDir, isolated.profile.id, 'chrome-profile'))).toBe(true)
  } finally { await h.cleanup() }
}, 90_000)

test('C2: API and CLI create, inspect, select, list, and close pages in explicit worktree scope', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('BrowserCore')
    const createdProfile = await runBrowserCli(h, ['browser', 'tab', 'profile', 'create', '--label', 'CLI Review', '--json'])
    expect(createdProfile.code).toBe(0)
    const profile = JSON.parse(createdProfile.stdout) as { profile: { id: string; scope: string } }
    expect(profile.profile.scope).toBe('isolated')

    const createPage = async (url: string) => {
      const result = await runBrowserCli(h, ['browser', 'tab', 'create', '--url', url, '--worktree', worktree, '--profile', profile.profile.id, '--json'])
      expect(result.code).toBe(0)
      return JSON.parse(result.stdout) as { browserPageId: string }
    }
    const first = await createPage(`${h.fixtureUrl}events`)
    const second = await createPage(`${h.fixtureUrl}first`)
    expect((await runBrowserCli(h, ['browser', 'tab', 'show', '--page', first.browserPageId, '--json'])).code).toBe(0)

    const switched = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--json'])
    expect(switched.code).toBe(0)
    const current = await runBrowserCli(h, ['browser', 'tab', 'current', '--worktree', worktree, '--json'])
    expect(JSON.parse(current.stdout)).toMatchObject({ tab: { browserPageId: first.browserPageId } })
    const listed = await runBrowserCli(h, ['browser', 'tab', 'list', '--worktree', 'all', '--json'])
    expect((JSON.parse(listed.stdout) as { tabs: Array<{ browserPageId: string }> }).tabs.map((tab) => tab.browserPageId))
      .toEqual(expect.arrayContaining([first.browserPageId, second.browserPageId]))

    const conflict = call(h.client, 'tabSwitch', { page: first.browserPageId, index: 0 })
    await expect(conflict).rejects.toBeInstanceOf(Error)
    const cliConflict = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--index', '0', '--json'])
    expect(cliConflict.code).not.toBe(0)
    const unscopedFill = call(h.client, 'fill', { element: '#text', value: 'no-target' })
    await expect(unscopedFill).rejects.toBeInstanceOf(Error)
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'seed' })
    const currentBeforeFocus = await call(h.client, 'tabCurrent', { worktree }) as { tab: { browserPageId: string } }
    const panesBeforeFocus = await call(h.client, 'paneState', { worktree }) as BrowserPaneList
    const unsupportedFocus = call(h.client, 'tabSwitch', { page: first.browserPageId, focus: true })
    await expect(unsupportedFocus).rejects.toThrow('browser_client_unavailable: no Quirky window is connected to show the page')
    const unsupportedFocusCli = await runBrowserCli(h, ['browser', 'tab', 'switch', '--page', first.browserPageId, '--focus', '--json'])
    expect(unsupportedFocusCli.code).not.toBe(0)
    expect(`${unsupportedFocusCli.stderr}${unsupportedFocusCli.stdout}`)
      .toContain('browser_client_unavailable: no Quirky window is connected to show the page')
    expect(await call(h.client, 'tabCurrent', { worktree })).toEqual(currentBeforeFocus)
    expect(await call(h.client, 'paneState', { worktree })).toEqual(panesBeforeFocus)
    const closed = await runBrowserCli(h, ['browser', 'tab', 'close', '--page', second.browserPageId, '--yes', '--json'])
    expect(closed.code).toBe(0)
    const missing = call(h.client, 'tabShow', { page: second.browserPageId })
    await expect(missing).rejects.toBeInstanceOf(Error)
    const missingCli = await runBrowserCli(h, ['browser', 'tab', 'show', '--page', second.browserPageId, '--json'])
    expect(missingCli.code).not.toBe(0)
  } finally { await h.cleanup() }
}, 90_000)

test('C7: tab switch focus reveals and reuses Watch panes with their hosted tabs active', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('RevealFocus')
    const otherWorktree = await h.addFolderWorktree('RevealOther')
    const profile = (await call(h.client, 'profileCreate', { name: 'Reveal profile' }) as { profile: { id: string } }).profile
    const first = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`,
      profile: profile.id
    }) as { browserPageId: string }
    const second = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}first`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const firstPage = (await call(h.client, 'tabShow', { page: first.browserPageId }) as { tab: BrowserPageState }).tab
    const secondPage = (await call(h.client, 'tabShow', { page: second.browserPageId }) as { tab: BrowserPageState }).tab

    window = await standInWindow(h, 'Reveal focus')
    await showWorktree(h, window.connId, otherWorktree)

    const opened = await call(h.client, 'tabSwitch', { page: first.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(opened).toMatchObject({
      switched: firstPage.index,
      browserPageId: first.browserPageId,
      focused: true,
      paneOpened: true,
      client: window.connId
    })
    const firstPaneState = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(firstPaneState.tabs).toHaveLength(1)
    const firstPane = firstPaneState.tabs[0]!
    expect(firstPane).toMatchObject({ id: opened.pane, page: first.browserPageId, mode: 'watch', profileId: profile.id })
    expect(firstPage.profileId).toBe(profile.id)
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` }))
      .toMatchObject({ tab: { browserPageId: first.browserPageId } })
    expectHostedTab(await terminalWorkspace(h, worktree), firstPane)
    expect((await windowState(h, window.connId)).layout).toMatchObject({
      worktree,
      view: { id: 'view:quirky.session/worktree', input: { worktree } }
    })

    const repeated = await call(h.client, 'tabSwitch', { page: first.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(repeated).toEqual({ switched: firstPage.index, browserPageId: first.browserPageId, focused: true, pane: firstPane.id, paneOpened: false, client: window.connId })
    expect((await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList).tabs).toHaveLength(1)

    const secondFocused = await call(h.client, 'tabSwitch', {
      index: secondPage.index,
      worktree: `id:${worktree}`,
      focus: true
    }) as { switched: number; browserPageId: string; pane: string; paneOpened: boolean; client: number }
    expect(secondFocused).toMatchObject({
      switched: secondPage.index,
      browserPageId: second.browserPageId,
      focused: true,
      paneOpened: true,
      client: window.connId
    })
    const secondPaneState = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    const secondPane = secondPaneState.tabs.find((pane) => pane.id === secondFocused.pane)!
    expect(secondPane).toMatchObject({ page: second.browserPageId, mode: 'watch', profileId: 'default' })
    expectHostedTab(await terminalWorkspace(h, worktree), secondPane)

    const refocused = await call(h.client, 'tabSwitch', { page: first.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(refocused).toEqual({ switched: firstPage.index, browserPageId: first.browserPageId, focused: true, pane: firstPane.id, paneOpened: false, client: window.connId })
    const finalPanes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(finalPanes.tabs.filter((pane) => pane.page === first.browserPageId)).toEqual([firstPane])
    expectHostedTab(await terminalWorkspace(h, worktree), firstPane)
  } finally {
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C8: reveal reuses the newest matching pane and keeps all existing duplicates', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('RevealDuplicates')
    const otherWorktree = await h.addFolderWorktree('RevealDuplicatesOther')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const otherPage = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}first`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const firstPane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: page.browserPageId
    }) as BrowserPaneState
    const newestMatchingPane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: page.browserPageId
    }) as BrowserPaneState
    const unrelatedPane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'watch', page: otherPage.browserPageId
    }) as BrowserPaneState
    expect((await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList).active).toBe(unrelatedPane.id)
    const frozenTime = Date.now() + 60_000
    const dateNowSpy = spyOn(Date, 'now').mockReturnValue(frozenTime)
    try {
      for (const title of ['First report 1', 'First report 2', 'First report 3']) {
        await call(h.client, 'paneReport', { pane: firstPane.id, tabId: firstPane.tabId, title })
      }
      await call(h.client, 'paneReport', {
        pane: newestMatchingPane.id,
        tabId: newestMatchingPane.tabId,
        title: 'Most recently reported duplicate'
      })
    } finally {
      dateNowSpy.mockRestore()
    }
    expect((await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList).active).toBe(unrelatedPane.id)

    window = await standInWindow(h, 'Reveal duplicate selection')
    await showWorktree(h, window.connId, otherWorktree)
    const result = await call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }) as {
      pane: string; paneOpened: boolean; client: number
    }
    expect(result).toMatchObject({ pane: newestMatchingPane.id, paneOpened: false, client: window.connId })

    const panes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(panes.tabs.map((pane) => pane.id).sort()).toEqual([firstPane.id, newestMatchingPane.id, unrelatedPane.id].sort())
    expect(panes.tabs.filter((pane) => pane.page === page.browserPageId).map((pane) => pane.id).sort())
      .toEqual([firstPane.id, newestMatchingPane.id].sort())
    expect(panes.active).toBe(newestMatchingPane.id)
    expectHostedTab(await terminalWorkspace(h, worktree), newestMatchingPane)
  } finally {
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C9: caller worktree and explicit client routing choose the right stand-in window only', async () => {
  const h = await startBrowserHarness()
  let first: StandInWindow | undefined
  let second: StandInWindow | undefined
  let caller: QuirkyClient | undefined
  try {
    const worktree = await h.addFolderWorktree('CallerRouting')
    const otherWorktree = await h.addFolderWorktree('CallerRoutingOther')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    first = await standInWindow(h, 'Caller worktree window')
    second = await standInWindow(h, 'Other worktree window')
    await showWorktree(h, first.connId, worktree)
    await showWorktree(h, second.connId, otherWorktree)
    await second.client.callAny('ui.window.focused', { focused: true })
    caller = await QuirkyClient.connect(rpcUrl(h.daemon.runtime), { role: 'cli', worktreeId: worktree })

    const otherBefore = await windowState(h, second.connId)
    const callerRouted = await caller.callAny('quirky.browser/tabSwitch', {
      page: page.browserPageId, focus: true, client: 'caller'
    }) as { client: number; pane: string; paneOpened: boolean }
    expect(callerRouted).toMatchObject({ client: first.connId, paneOpened: true })
    expect((await windowState(h, first.connId)).layout).toMatchObject({
      worktree,
      view: { id: 'view:quirky.session/worktree', input: { worktree } }
    })
    expect((await windowState(h, second.connId)).layout).toEqual(otherBefore.layout)

    await showWorktree(h, second.connId, worktree)
    await first.client.callAny('ui.window.focused', { focused: false })
    await second.client.callAny('ui.window.focused', { focused: true })
    const firstBeforeFocusedTie = await windowState(h, first.connId)
    const focusedRouted = await caller.callAny('quirky.browser/tabSwitch', {
      page: page.browserPageId, focus: true, client: 'caller'
    }) as { client: number; pane: string; paneOpened: boolean }
    expect(focusedRouted).toMatchObject({ client: second.connId, paneOpened: false })
    expect((await windowState(h, first.connId)).layout).toEqual(firstBeforeFocusedTie.layout)

    const secondBeforeExplicit = await windowState(h, second.connId)
    const explicitRouted = await caller.callAny('quirky.browser/tabSwitch', {
      page: page.browserPageId, focus: true, client: String(first.connId)
    }) as { client: number; pane: string; paneOpened: boolean }
    expect(explicitRouted).toMatchObject({ client: first.connId, paneOpened: false })
    expect((await windowState(h, second.connId)).layout).toEqual(secondBeforeExplicit.layout)
  } finally {
    caller?.close()
    first?.client.close()
    second?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C10: invalid focus routing and disconnected clients preserve pages and pane state', async () => {
  const h = await startBrowserHarness()
  let first: StandInWindow | undefined
  let second: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('RoutingFailures')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const pageState = (await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: BrowserPageState }).tab
    const selected = await call(h.client, 'tabSwitch', { page: page.browserPageId })
    expect(selected).toEqual({ switched: pageState.index, browserPageId: page.browserPageId })
    const selectionBefore = await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })
    const panesBefore = await call(h.client, 'paneState', { worktree: `id:${worktree}` })

    await expect(call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }))
      .rejects.toThrow('browser_client_unavailable: no Quirky window is connected to show the page')
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })).toEqual(selectionBefore)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)
    await expect(call(h.client, 'tabSwitch', { page: page.browserPageId, client: 'caller' }))
      .rejects.toThrow('invalid_argument: client requires focus')

    for (const malformed of ['', ' 5', '05', '+5', '5.0', '1e1', 'Caller', 'all', '9007199254740993']) {
      await expect(call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true, client: malformed }))
        .rejects.toThrow('invalid_argument: client must be caller or a live window connection ID')
    }
    await expect(call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true, client: 5 }))
      .rejects.toThrow(/client.*string/i)
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })).toEqual(selectionBefore)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)

    const noFocus = await call(h.client, 'tabSwitch', { page: page.browserPageId })
    expect(noFocus).toEqual({ switched: pageState.index, browserPageId: page.browserPageId })
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)

    const beforeNoWindowUrl = await call(h.client, 'tabList', { worktree: 'all' })
    await expect(call(h.client, 'openUrl', {
      url: `${h.fixtureUrl}first`, worktree: `id:${worktree}`, client: 'caller'
    })).rejects.toThrow('browser_client_unavailable: no Quirky window is connected to show the page')
    expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(beforeNoWindowUrl)

    first = await standInWindow(h, 'Ambiguous first')
    second = await standInWindow(h, 'Ambiguous second')
    await showWorktree(h, first.connId, worktree)
    const otherWorktree = await h.addFolderWorktree('RoutingFailuresOther')
    await showWorktree(h, second.connId, otherWorktree)
    await second.client.callAny('ui.window.focused', { focused: true })
    const ids = [first.connId, second.connId].sort((a, b) => a - b)
    const ambiguous = `browser_client_ambiguous: windows ${ids[0]}, ${ids[1]} are connected and none is identified as the caller's; pass client <id>`
    const selectionBeforeAmbiguity = await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })
    const panesBeforeAmbiguity = await call(h.client, 'paneState', { worktree: `id:${worktree}` })
    await expect(call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true, client: 'caller' }))
      .rejects.toThrow(ambiguous)
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })).toEqual(selectionBeforeAmbiguity)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBeforeAmbiguity)

    const beforeAmbiguousUrl = await call(h.client, 'tabList', { worktree: 'all' })
    await expect(call(h.client, 'openUrl', {
      url: `${h.fixtureUrl}first`, worktree: `id:${worktree}`, client: 'caller'
    })).rejects.toThrow(ambiguous)
    expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(beforeAmbiguousUrl)

    const closedId = first.connId
    first.client.close()
    first = undefined
    await waitUntilWindowGone(h, closedId)
    await expect(call(h.client, 'tabSwitch', {
      page: page.browserPageId, focus: true, client: String(closedId)
    })).rejects.toThrow(`browser_client_unavailable: window ${closedId} is not connected`)
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })).toEqual(selectionBeforeAmbiguity)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBeforeAmbiguity)

    const beforeClosedUrl = await call(h.client, 'tabList', { worktree: 'all' })
    await expect(call(h.client, 'openUrl', {
      url: `${h.fixtureUrl}first`, worktree: `id:${worktree}`, client: String(closedId)
    })).rejects.toThrow(`browser_client_unavailable: window ${closedId} is not connected`)
    expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(beforeClosedUrl)
  } finally {
    first?.client.close()
    second?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C11: focus rejects a page without a worktree and open-url keeps its local result', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('NoWorktreeReveal')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const noWorktreePage = await call(h.client, 'tabCreate', { url: `${h.fixtureUrl}first` }) as { browserPageId: string }
    const pageState = (await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: BrowserPageState }).tab
    await call(h.client, 'tabSwitch', { page: page.browserPageId })
    const selectionBefore = await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })
    const panesBefore = await call(h.client, 'paneState', { worktree: `id:${worktree}` })
    await expect(call(h.client, 'tabSwitch', { page: noWorktreePage.browserPageId, focus: true }))
      .rejects.toThrow(`invalid_argument: page ${noWorktreePage.browserPageId} belongs to no worktree, so no browser pane can show it`)
    expect(await call(h.client, 'tabCurrent', { worktree: `id:${worktree}` })).toEqual(selectionBefore)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)

    window = await standInWindow(h, 'Local open-url')
    await showWorktree(h, window.connId, worktree)
    const windowBefore = await windowState(h, window.connId)
    const localUrl = `${h.fixtureUrl}first`
    const local = await call(h.client, 'openUrl', { url: localUrl, worktree: `id:${worktree}` }) as { browserPageId: string }
    expect(local).toEqual({ browserPageId: expect.any(String) })
    expect(await call(h.client, 'tabShow', { page: local.browserPageId }))
      .toMatchObject({ tab: { browserPageId: local.browserPageId, worktreeId: worktree, profileId: 'default', url: localUrl } })
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)
    expect((await windowState(h, window.connId)).layout).toEqual(windowBefore.layout)

    const beforeNoWorktreeUrl = await call(h.client, 'tabList', { worktree: 'all' })
    await expect(call(h.client, 'openUrl', {
      url: `${h.fixtureUrl}events`,
      cwd: h.home,
      client: 'caller'
    })).rejects.toThrow('invalid_argument: open-url with client needs a worktree; pass worktree or run inside one')
    expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(beforeNoWorktreeUrl)
    expect((await windowState(h, window.connId)).layout).toEqual(windowBefore.layout)
    expect(pageState.worktreeId).toBe(worktree)
  } finally {
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C12: routed open-url creates a Default Watch page and shows it in the caller worktree', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  let caller: QuirkyClient | undefined
  try {
    const worktree = await h.addFolderWorktree('OpenUrlCaller')
    window = await standInWindow(h, 'Open-url caller')
    await showWorktree(h, window.connId, worktree)
    caller = await QuirkyClient.connect(rpcUrl(h.daemon.runtime), { role: 'cli', worktreeId: worktree })
    const url = `${h.fixtureUrl}events`
    const opened = await caller.callAny('quirky.browser/openUrl', {
      url, worktree: `id:${worktree}`, client: 'caller'
    }) as { browserPageId: string; pane: string; client: number }
    expect(opened).toEqual({
      browserPageId: expect.any(String),
      pane: expect.any(String),
      client: window.connId
    })
    const page = (await call(h.client, 'tabShow', { page: opened.browserPageId }) as { tab: BrowserPageState }).tab
    expect(page).toMatchObject({ browserPageId: opened.browserPageId, worktreeId: worktree, profileId: 'default', url })
    const panes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(panes.tabs).toHaveLength(1)
    const pane = panes.tabs[0]!
    expect(pane).toMatchObject({ id: opened.pane, page: opened.browserPageId, mode: 'watch', profileId: 'default' })
    expectHostedTab(await terminalWorkspace(h, worktree), pane)
    expect((await windowState(h, window.connId)).layout).toMatchObject({
      worktree,
      view: { id: 'view:quirky.session/worktree', input: { worktree } }
    })
  } finally {
    caller?.close()
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C13: focus reveals a floating page without changing a window view', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('FloatingRevealOther')
    window = await standInWindow(h, 'Floating reveal')
    await showWorktree(h, window.connId, worktree)
    const windowBefore = await windowState(h, window.connId)
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: 'floating'
    }) as { browserPageId: string }
    const result = await call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }) as {
      browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(result).toMatchObject({
      browserPageId: page.browserPageId,
      focused: true,
      paneOpened: true,
      client: window.connId
    })
    expect(typeof result.pane).toBe('string')
    const panes = await call(h.client, 'paneState', { worktree: 'floating' }) as BrowserPaneList
    expect(panes.tabs).toHaveLength(1)
    expect(panes.tabs[0]).toMatchObject({ id: result.pane, page: page.browserPageId, mode: 'watch' })
    expectHostedTab(await terminalWorkspace(h, 'floating'), panes.tabs[0]!)
    expect(await h.client.callAny('quirky.terminal/floating', {})).toMatchObject({ enabled: true, open: true })
    expect((await windowState(h, window.connId)).layout).toEqual(windowBefore.layout)
  } finally {
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)

test('C14: focus refuses to duplicate a Watch pane owned by the mobile renderer', async () => {
  const previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  process.env.QUIRKY_MOBILE_PORT = '0'
  let h: BrowserTestHarness | undefined
  let window: StandInWindow | undefined
  let mobileLease: { worktree: string; tabId: string; watchId: string } | undefined
  try {
    h = await startBrowserHarness({}, { includeMobile: true })
    const worktree = await h.addFolderWorktree('MobileOwnedReveal')
    window = await standInWindow(h, 'Mobile-owned reveal')
    await showWorktree(h, window.connId, worktree)
    const beforeWindow = await windowState(h, window.connId)
    const created = await h.client.callAny('quirky.mobile/browserWatchCreate', {
      worktree,
      url: `${h.fixtureUrl}events`
    }) as { tab: { tabId: string }; watchId: string }
    mobileLease = { worktree, tabId: created.tab.tabId, watchId: created.watchId }
    const beforePanes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    const owned = beforePanes.tabs.find((pane) => pane.tabId === created.tab.tabId)!
    if (!owned.page) throw new Error('mobile Watch creation did not produce a managed page')

    await expect(call(h.client, 'tabSwitch', { page: owned.page, focus: true }))
      .rejects.toThrow('browser_error: This Watch pane is owned by another renderer.')
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(beforePanes)
    expect((await windowState(h, window.connId)).layout).toEqual(beforeWindow.layout)
  } finally {
    try {
      if (h && mobileLease) await h.client.callAny('quirky.mobile/browserWatchStop', mobileLease)
    } finally {
      try {
        window?.client.close()
        if (h) await h.cleanup()
      } finally {
        if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
        else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
      }
    }
  }
}, 90_000)

test('C2a: returned indices select and close interleaved worktree pages without crossing scope', async () => {
  const h = await startBrowserHarness()
  type Tab = { browserPageId: string; worktreeId: string; index: number; active: boolean }
  try {
    const worktreeA = await h.addFolderWorktree('IndexA')
    const worktreeB = await h.addFolderWorktree('IndexB')
    const first = await call(h.client, 'tabCreate', { worktree: worktreeA, url: `${h.fixtureUrl}events` }) as { browserPageId: string }
    const other = await call(h.client, 'tabCreate', { worktree: worktreeB, url: `${h.fixtureUrl}events` }) as { browserPageId: string }
    const last = await call(h.client, 'tabCreate', { worktree: worktreeA, url: `${h.fixtureUrl}events` }) as { browserPageId: string }
    const listedA = await call(h.client, 'tabList', { worktree: worktreeA }) as { tabs: Tab[] }
    const listedB = await call(h.client, 'tabList', { worktree: worktreeB }) as { tabs: Tab[] }
    expect(listedA.tabs.map(tab => tab.browserPageId)).toEqual([first.browserPageId, last.browserPageId])
    expect(listedB.tabs.map(tab => tab.browserPageId)).toEqual([other.browserPageId])

    for (const tab of listedA.tabs) {
      expect(await call(h.client, 'tabSwitch', { worktree: worktreeA, index: tab.index }))
        .toEqual({ browserPageId: tab.browserPageId, switched: tab.index })
      expect(await call(h.client, 'tabCurrent', { worktree: worktreeA }))
        .toMatchObject({ tab: { browserPageId: tab.browserPageId } })
    }

    const beforeRefusal = await call(h.client, 'tabList', { worktree: 'all' })
    for (const method of ['tabSwitch', 'tabClose']) {
      const index = listedB.tabs[0]!.index
      await expect(call(h.client, method, { worktree: worktreeA, index, ...(method === 'tabClose' ? { yes: true } : {}) }))
        .rejects.toThrow(`browser_tab_not_found: tab index ${index} does not exist`)
      expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(beforeRefusal)
    }

    for (const tab of [...listedA.tabs].sort((left, right) => right.index - left.index)) {
      expect(await call(h.client, 'tabClose', { worktree: worktreeA, index: tab.index, yes: true })).toEqual({ closed: true })
      await expect(call(h.client, 'tabShow', { page: tab.browserPageId })).rejects.toThrow('browser_tab_not_found')
      const remaining = await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Tab[] }
      expect(remaining.tabs.some(candidate => candidate.browserPageId === tab.browserPageId)).toBe(false)
      expect(remaining.tabs.some(candidate => candidate.browserPageId === other.browserPageId && candidate.worktreeId === worktreeB)).toBe(true)
    }
    expect(await call(h.client, 'tabList', { worktree: worktreeA })).toEqual({ tabs: [] })
    expect(await call(h.client, 'eval', { page: other.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'seed' })
  } finally { await h.cleanup() }
}, 90_000)

test('C3: real navigation, eval, snapshot refs, fill, click, and viewport screenshot affect the page', async () => {
  const h = await startBrowserHarness()
  try {
    const page = await newPage(h, `${h.fixtureUrl}first`)
    const navigation = await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}events` }) as { url: string; title: string }
    expect(navigation).toEqual({ url: `${h.fixtureUrl}events`, title: 'Events' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: '({title: document.title, value: document.querySelector("#text").value})' }))
      .toEqual({ value: { title: 'Events', value: 'seed' } })

    const snapshot = await call(h.client, 'snapshot', { page: page.browserPageId }) as { refs: Array<{ ref: string; role: string; name: string }> }
    const textField = snapshot.refs.find((ref) => ref.name === 'Text field')
    const submit = snapshot.refs.find((ref) => ref.name === 'Submit')
    expect(textField).toBeDefined()
    expect(submit).toBeDefined()
    await call(h.client, 'tabSwitch', { page: page.browserPageId })
    await call(h.client, 'fill', { page: page.browserPageId, element: textField!.ref, value: 'filled through a public ref' })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: 'filled through a public ref' })
    await call(h.client, 'click', { page: page.browserPageId, element: submit!.ref })
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#result").textContent' }))
      .toEqual({ value: 'clicked' })

    await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}second` })
    const stale = call(h.client, 'click', { page: page.browserPageId, element: submit!.ref })
    await expect(stale).rejects.toBeInstanceOf(Error)
    const staleCli = await runBrowserCli(h, ['browser', 'click', '--page', page.browserPageId, '--element', submit!.ref, '--json'])
    expect(staleCli.code).not.toBe(0)
    await call(h.client, 'goto', { page: page.browserPageId, url: `${h.fixtureUrl}tall` })
    const image = await call(h.client, 'screenshot', { page: page.browserPageId, format: 'png' }) as { data: string; format: string }
    const png = Buffer.from(image.data, 'base64')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(image.format).toBe('png')
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBeGreaterThan(0)
    expect(height).toBeLessThan(2_600)
  } finally { await h.cleanup() }
}, 90_000)

test('C4: same-profile page selection and full commands are serialized atomically', async () => {
  let secondPageId: string | undefined
  const secondStarted = Promise.withResolvers<void>()
  const h = await startBrowserHarness({
    onOperation: (event) => {
      if (event.pageId === secondPageId && event.method === 'eval') secondStarted.resolve()
    }
  })
  const gate = h.fixtureGate('profile-lock')
  try {
    const first = await newPage(h)
    const second = await newPage(h)
    secondPageId = second.browserPageId

    const navigation = settle(call(h.client, 'goto', { page: first.browserPageId, url: `${h.fixtureUrl}gate/profile-lock` }))
    await gate.requested
    const evaluation = settle(call(h.client, 'eval', {
      page: second.browserPageId,
      expression: 'document.querySelector("#text").value = "second-page"; document.querySelector("#text").value'
    }))

    // This is an I/O watchdog for a profile-lock bypass: the second operation hook must stay blocked while the first page awaits its fixture response.
    expect(await signalBefore(secondStarted.promise, 150)).toBe(false)
    gate.release()
    expect((await navigation).status).toBe('fulfilled')
    expect((await evaluation).status).toBe('fulfilled')
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })).toEqual({ value: 'Gate' })
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'seed' })
    expect(await call(h.client, 'eval', { page: second.browserPageId, expression: 'document.querySelector("#text").value' })).toEqual({ value: 'second-page' })
  } finally {
    gate.release()
    await h.cleanup()
  }
}, 90_000)

test('C5: CLI values stay literal and exec accepts only shipping page commands', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('BrowserCli')
    const pageResult = await runBrowserCli(h, ['browser', 'tab', 'create', '--url', `${h.fixtureUrl}events`, '--worktree', worktree, '--json'])
    expect(pageResult.code).toBe(0)
    const page = JSON.parse(pageResult.stdout) as { browserPageId: string }

    const filePath = join(h.home, 'existing synthetic input.txt')
    writeFileSync(filePath, 'this content must not be read')
    const literal = `@file:${filePath}`
    const cliFill = await runBrowserCli(h, ['browser', 'fill', '--page', page.browserPageId, '--element', '#text', '--value', literal, '--json'])
    expect(cliFill.code).toBe(0)
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: literal })

    const supported = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', 'fill "#text" "exec-value"', '--json'])
    expect(supported.code).toBe(0)
    expect(await call(h.client, 'eval', { page: page.browserPageId, expression: 'document.querySelector("#text").value' }))
      .toEqual({ value: 'exec-value' })
    const alias = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', `navigate ${h.fixtureUrl}first`, '--json'])
    expect(alias.code).toBe(0)
    expect((await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: { url: string } }).tab.url).toBe(`${h.fixtureUrl}first`)

    for (const command of ['close', 'launch', 'tab new', '--cdp 9222 snapshot', '--session other click "#text"']) {
      const rejected = call(h.client, 'exec', { page: page.browserPageId, command })
      await expect(rejected).rejects.toBeInstanceOf(Error)
    }
    const unsupportedCli = await runBrowserCli(h, ['browser', 'exec', '--page', page.browserPageId, '--command', 'launch', '--json'])
    expect(unsupportedCli.code).not.toBe(0)

  } finally { await h.cleanup() }
}, 90_000)

test('C6: actual switches invalidate refs, closed pages stay closed, and teardown cleans owned processes', async () => {
  let runningPageId: string | undefined
  let control: { crashHelper(profileId: string): Promise<void> } | undefined
  const runningStarted = Promise.withResolvers<void>()
  const h = await startBrowserHarness({
    onOperation: (event) => {
      if (event.pageId === runningPageId && event.method === 'eval') runningStarted.resolve()
    },
    onControl: (value) => { control = value }
  })
  try {
    const first = await newPage(h)
    const second = await newPage(h)
    const firstSnapshot = await call(h.client, 'snapshot', { page: first.browserPageId }) as { refs: Array<{ ref: string }> }
    const oldRef = firstSnapshot.refs[0]!.ref
    await call(h.client, 'tabSwitch', { page: second.browserPageId })
    const switchedRef = call(h.client, 'click', { page: first.browserPageId, element: oldRef })
    await expect(switchedRef).rejects.toBeInstanceOf(Error)

    const secondSnapshot = await call(h.client, 'snapshot', { page: second.browserPageId }) as { refs: Array<{ ref: string }> }
    const closedRef = secondSnapshot.refs[0]!.ref
    await call(h.client, 'tabClose', { page: second.browserPageId, yes: true })
    const clickClosed = call(h.client, 'click', { page: second.browserPageId, element: closedRef })
    await expect(clickClosed).rejects.toBeInstanceOf(Error)
    const showClosed = call(h.client, 'tabShow', { page: second.browserPageId })
    await expect(showClosed).rejects.toBeInstanceOf(Error)
    const closedCli = await runBrowserCli(h, ['browser', 'click', '--page', second.browserPageId, '--element', closedRef, '--json'])
    expect(closedCli.code).not.toBe(0)

    const runningPage = await newPage(h)
    runningPageId = runningPage.browserPageId
    const inFlight = settle(call(h.client, 'eval', {
      page: runningPage.browserPageId,
      expression: 'new Promise(resolve => setTimeout(() => resolve("late"), 20_000))'
    }))
    await runningStarted.promise
    const queued = settle(call(h.client, 'eval', { page: runningPage.browserPageId, expression: '2 + 2' }))
    await call(h.client, 'tabClose', { page: runningPage.browserPageId, yes: true })
    expect((await inFlight).status).toBe('rejected')
    expect((await queued).status).toBe('rejected')
    const pages = await call(h.client, 'tabList', { worktree: 'all' }) as { tabs: Array<{ browserPageId: string }> }
    const retainedSnapshot = await call(h.client, 'snapshot', { page: first.browserPageId }) as { refs: Array<{ ref: string }> }
    const retainedRef = retainedSnapshot.refs[0]!.ref
    expect(control).toBeDefined()
    await control!.crashHelper('default')
    const lostEpoch = call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })
    await expect(lostEpoch).rejects.toBeInstanceOf(Error)
    expect(await call(h.client, 'eval', { page: first.browserPageId, expression: 'document.title' })).toEqual({ value: 'Events' })
    expect(h.spawnCount()).toBe(4)
    const staleAfterLoss = call(h.client, 'click', { page: first.browserPageId, element: retainedRef })
    await expect(staleAfterLoss).rejects.toBeInstanceOf(Error)
    expect(pages.tabs.map((page) => page.browserPageId)).not.toContain(runningPage.browserPageId)
  } finally { await h.cleanup() }
}, 90_000)
test('C15: routed open-url rolls back its page and panes when the chosen window disconnects', async () => {
  const gateId = 'route-disconnect'
  let releaseGate: (() => void) | undefined
  let h: BrowserTestHarness | undefined
  let window: StandInWindow | undefined
  try {
    h = await startBrowserHarness()
    const worktree = await h.addFolderWorktree('OpenUrlDisconnect')
    const first = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}first`,
      worktree: `id:${worktree}`
    })
    await call(h.client, 'tabSwitch', { page: first.browserPageId })
    const olderPane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'native', url: 'about:blank'
    }) as BrowserPaneState
    const activePane = await call(h.client, 'paneOpen', {
      worktree: `id:${worktree}`, mode: 'native', url: 'about:blank'
    }) as BrowserPaneState
    await call(h.client, 'paneReport', {
      pane: olderPane.id,
      tabId: olderPane.tabId,
      url: 'about:blank',
      title: 'Reported background pane',
      loading: false
    })
    const panesBefore = await call(h.client, 'paneState', { worktree: `id:${worktree}` })
    expect((panesBefore as BrowserPaneList).active).toBe(activePane.id)
    const tabsBefore = await call(h.client, 'tabList', { worktree: 'all' })

    window = await standInWindow(h, 'Open-url disconnect')
    await showWorktree(h, window.connId, worktree)
    const urlGate = h.fixtureGate(gateId)
    releaseGate = urlGate.release
    const routed = settle(call(h.client, 'openUrl', {
      url: `${h.fixtureUrl}gate/${gateId}`,
      worktree: `id:${worktree}`,
      client: String(window.connId)
    }))
    await urlGate.requested
    const closedId = window.connId
    window.client.close()
    window = undefined
    await waitUntilWindowGone(h, closedId)
    urlGate.release()
    releaseGate = undefined

    const outcome = await routed
    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('routed open-url unexpectedly succeeded after its window disconnected')
    expect(outcome.reason).toBeInstanceOf(Error)
    expect((outcome.reason as Error).message)
      .toContain(`browser_client_unavailable: window ${closedId} disconnected before the page was shown`)
    expect(await call(h.client, 'tabList', { worktree: 'all' })).toEqual(tabsBefore)
    expect(await call(h.client, 'paneState', { worktree: `id:${worktree}` })).toEqual(panesBefore)
  } finally {
    releaseGate?.()
    window?.client.close()
    if (h) await h.cleanup()
  }
}, 90_000)
test('C16: reveal refreshes a reused Watch pane after its page profile changes', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  try {
    const worktree = await h.addFolderWorktree('RevealProfileRefresh')
    const otherWorktree = await h.addFolderWorktree('RevealProfileRefreshOther')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    const pageState = (await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: BrowserPageState }).tab
    const pageIdsBefore = (await call(h.client, 'tabList', { worktree: `id:${worktree}` }) as { tabs: BrowserPageState[] })
      .tabs.map((tab) => tab.browserPageId)
    expect(pageIdsBefore).toEqual([page.browserPageId])

    window = await standInWindow(h, 'Reveal profile refresh')
    await showWorktree(h, window.connId, otherWorktree)
    const opened = await call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(opened).toMatchObject({
      switched: pageState.index,
      browserPageId: page.browserPageId,
      focused: true,
      paneOpened: true,
      client: window.connId
    })
    const initialPanes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(initialPanes.tabs).toHaveLength(1)
    const pane = initialPanes.tabs[0]!
    expect(pane).toMatchObject({
      id: opened.pane,
      page: page.browserPageId,
      mode: 'watch',
      profileId: 'default',
      partition: 'persist:quirky-browser-default'
    })

    const isolated = (await call(h.client, 'profileCreate', { name: 'Reveal refreshed profile' }) as { profile: { id: string } }).profile
    expect(await call(h.client, 'tabProfileSet', { page: page.browserPageId, profile: isolated.id }))
      .toMatchObject({ browserPageId: page.browserPageId, profileId: isolated.id })

    const refocused = await call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(refocused).toEqual({
      switched: pageState.index,
      browserPageId: page.browserPageId,
      focused: true,
      pane: pane.id,
      paneOpened: false,
      client: window.connId
    })
    const refreshedPanes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(refreshedPanes.tabs).toHaveLength(1)
    expect(refreshedPanes.tabs[0]).toMatchObject({
      id: pane.id,
      page: page.browserPageId,
      mode: 'watch',
      profileId: isolated.id,
      partition: `persist:quirky-browser-${isolated.id}`
    })
    const pageIdsAfter = (await call(h.client, 'tabList', { worktree: `id:${worktree}` }) as { tabs: BrowserPageState[] })
      .tabs.map((tab) => tab.browserPageId)
    expect(pageIdsAfter).toEqual(pageIdsBefore)
    expect((await call(h.client, 'tabShow', { page: page.browserPageId }) as { tab: BrowserPageState }).tab.profileId)
      .toBe(isolated.id)
    expectHostedTab(await terminalWorkspace(h, worktree), refreshedPanes.tabs[0]!)

    await call(h.client, 'paneControl', { pane: pane.id, action: 'reload' })
  } finally {
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)
test('C17: concurrent reveals of one page share one Watch pane', async () => {
  const h = await startBrowserHarness()
  let window: StandInWindow | undefined
  const originalRevealPage = PaneService.prototype.revealPage
  let concurrentResults: Array<{ pane: string; opened: boolean }> = []
  const revealSpy = spyOn(PaneService.prototype, 'revealPage').mockImplementation(async function (
    this: PaneService,
    page: Parameters<typeof originalRevealPage>[0],
    caller: Parameters<typeof originalRevealPage>[1]
  ) {
    const results = await Promise.all([
      originalRevealPage.call(this, page, caller),
      originalRevealPage.call(this, page, caller)
    ])
    concurrentResults = results
    return results[0]!
  })
  try {
    const worktree = await h.addFolderWorktree('RevealConcurrent')
    const otherWorktree = await h.addFolderWorktree('RevealConcurrentOther')
    const page = await call(h.client, 'tabCreate', {
      url: `${h.fixtureUrl}events`,
      worktree: `id:${worktree}`
    }) as { browserPageId: string }
    window = await standInWindow(h, 'Concurrent reveal')
    await showWorktree(h, window.connId, otherWorktree)

    const result = await call(h.client, 'tabSwitch', { page: page.browserPageId, focus: true }) as {
      switched: number; browserPageId: string; focused: true; pane: string; paneOpened: boolean; client: number
    }
    expect(concurrentResults).toHaveLength(2)
    expect(concurrentResults[0]!.pane).toBe(concurrentResults[1]!.pane)
    expect([concurrentResults[0]!.opened, concurrentResults[1]!.opened].sort()).toEqual([false, true])
    expect(result).toMatchObject({
      browserPageId: page.browserPageId,
      focused: true,
      pane: concurrentResults[0]!.pane,
      client: window.connId
    })
    const panes = await call(h.client, 'paneState', { worktree: `id:${worktree}` }) as BrowserPaneList
    expect(panes.tabs).toHaveLength(1)
    expect(panes.tabs[0]).toMatchObject({ id: concurrentResults[0]!.pane, page: page.browserPageId, mode: 'watch' })
  } finally {
    revealSpy.mockRestore()
    window?.client.close()
    await h.cleanup()
  }
}, 90_000)
