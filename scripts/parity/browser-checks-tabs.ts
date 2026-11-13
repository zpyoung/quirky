import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { BrowserFailure } from './browser-world'
import type { BrowserCheck, CheckContext } from './browser-run'

type Tab = { browserPageId: string; profileId: string; worktreeId: string; index: number; title: string; url: string; active: boolean }
type Profiles = { profiles: Array<{ id: string; label: string; scope: string }> }
type PageReceipt = { browserPageId: string; profileId?: string }
type PaneTab = { id: string; page?: string | null; mode: string; profileId: string }
type PaneState = { tabs: PaneTab[] }
type TerminalTab = { id: string; kind?: string; viewId?: string; key?: string }
type TerminalGroup = { kind: 'group'; id: string; activeTab: string | null; tabs: TerminalTab[] }
type TerminalNode = TerminalGroup | { kind: 'split'; first: TerminalNode; second: TerminalNode }
type TerminalWorkspace = { workspace: { activeGroup: string; root: TerminalNode } }
type UiState = { windows: Array<{ connId: number }> }
type WindowState = { layout: { view: unknown; worktree?: string } }
type PageList = { tabs: Tab[] }

async function connectClient(c: CheckContext, role: 'cli' | 'ui') {
  const runtime = readRuntime(c.world.home)
  if (!runtime) throw new BrowserFailure('daemon-exited', 'temporary browser daemon runtime is unavailable')
  return await QuirkyClient.connect(rpcUrl(runtime), role === 'ui'
    ? { role, name: 'browser-parity-stand-in' }
    : { role, worktreeId: c.world.worktreeA })
}

async function uiState(client: QuirkyClient) {
  const state = await client.callAny('ui.state', {}) as UiState
  if (!state || !Array.isArray(state.windows)) throw new BrowserFailure('wrong-page', 'ui.state did not return its windows')
  return state
}

async function waitForNoWindows(client: QuirkyClient) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await uiState(client)).windows.length === 0) return
    await Bun.sleep(25)
  }
  throw new BrowserFailure('wrong-page', 'stand-in UI window remained connected')
}

async function paneState(c: CheckContext, worktree: string) {
  return await c.call<PaneState>('pane state', { worktree }, '')
}

async function closeNewPanes(c: CheckContext, worktree: string, baseline: Set<string> | undefined, tracked: Set<string>) {
  const paneIds = new Set(tracked)
  const failures: string[] = []
  if (baseline) {
    try {
      const current = await paneState(c, worktree)
      for (const pane of current.tabs) if (!baseline.has(pane.id)) paneIds.add(pane.id)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const pane of paneIds) {
    if (baseline?.has(pane)) continue
    try {
      if (!(await c.call<boolean>('pane close', { pane }, ''))) failures.push(`pane ${pane} did not close`)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}

async function closeNewPages(c: CheckContext, baseline: Set<string> | undefined, tracked: Set<string>) {
  const pageIds = new Set(tracked)
  const failures: string[] = []
  if (baseline) {
    try {
      const current = await c.call<PageList>('tab list', { worktree: 'all' }, '')
      for (const tab of current.tabs) if (!baseline.has(tab.browserPageId)) pageIds.add(tab.browserPageId)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  for (const page of pageIds) {
    if (baseline?.has(page)) continue
    try {
      const closed = await c.call<{ closed: boolean }>('tab close', { yes: true }, page)
      if (!closed.closed) failures.push(`page ${page} did not close`)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}

async function finishProbe(
  c: CheckContext,
  observer: QuirkyClient | undefined,
  ui: QuirkyClient | undefined,
  worktree: string,
  baselinePanes: Set<string> | undefined,
  baselinePages: Set<string> | undefined,
  createdPanes: Set<string>,
  createdPages: Set<string>
) {
  const failures: string[] = []
  try {
    await closeNewPanes(c, worktree, baselinePanes, createdPanes)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  try {
    await closeNewPages(c, baselinePages, createdPages)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  try {
    ui?.close()
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  }
  if (observer) {
    try {
      await waitForNoWindows(observer)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    } finally {
      observer.close()
    }
  }
  if (failures.length) throw new Error(failures.join('; '))
}

function terminalGroups(node: TerminalNode): TerminalGroup[] {
  if (node.kind === 'group') return [node]
  return [...terminalGroups(node.first), ...terminalGroups(node.second)]
}

function hostedBrowserTabIsActive(workspace: TerminalWorkspace, pane: string) {
  const groups = terminalGroups(workspace.workspace.root)
  const hosted = groups.flatMap((group) => group.tabs).find((tab) =>
    tab.kind === 'view' && tab.viewId === 'view:quirky.browser/page' && tab.key === `browser:${pane}`
  )
  const activeGroup = groups.find((group) => group.id === workspace.workspace.activeGroup)
  return Boolean(hosted && activeGroup?.activeTab === hosted.id)
}

async function terminalWorkspace(client: QuirkyClient, worktree: string) {
  return await client.callAny('quirky.terminal/workspace', { workspace: worktree }) as TerminalWorkspace
}

async function windowState(client: QuirkyClient, connId: number) {
  return await client.callAny('ui.window.state', { connId }) as WindowState
}

async function windowConnId(client: QuirkyClient) {
  return (await client.callAny('ui.window.self', {}) as { connId: number }).connId
}

async function pageIds(c: CheckContext) {
  return new Set((await c.call<PageList>('tab list', { worktree: 'all' }, '')).tabs.map((tab) => tab.browserPageId))
}

async function paneIds(c: CheckContext, worktree: string) {
  return new Set((await paneState(c, worktree)).tabs.map((tab) => tab.id))
}

function paneForPage(state: PaneState, page: string) {
  return state.tabs.filter((pane) => pane.page === page)
}

function viewForWorktree(worktree: string) {
  return { id: 'view:quirky.session/worktree', input: { worktree } }
}


async function location(c: CheckContext, title: string, path: string) {
  const observed = await c.observe<{ title: string; url: string }>('({title:document.title,url:location.href})')
  c.equal(observed, { title, url: `${c.world.fixture.origin}${path}` })
  c.assert(c.world.fixture.requests.some(request => request.path === path), `fixture did not receive ${path}`)
  return observed
}

export const tabChecks: BrowserCheck[] = [
  { id: 'tab-profile-create', async run(c) {
    const a = await c.call<{ profile: { id: string; label: string; scope: string } }>('tab profile create', { label: 'Parity A' }, '')
    const b = await c.call<{ profile: { id: string; label: string; scope: string } }>('tab profile create', { label: 'Parity B' }, '')
    c.state.profileA = a.profile.id; c.state.profileB = b.profile.id
    c.assert(a.profile.id !== b.profile.id, 'profiles must be independent')
    const profiles = (await c.call<Profiles>('tab profile list', {}, '')).profiles
    c.assert(profiles.some(p => p.id === a.profile.id && p.label === 'Parity A' && p.scope === 'isolated'), 'Parity A missing')
    c.assert(profiles.some(p => p.id === b.profile.id && p.label === 'Parity B' && p.scope === 'isolated'), 'Parity B missing')
    return { profiles }
  } },
  { id: 'tab-create', async run(c) {
    c.state.pageA = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    c.state.pageB = (await c.call<PageReceipt>('tab create', { profile: c.state.profileB, worktree: c.world.worktreeB, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: 'all' }, '')).tabs
    for (const [page, profile, worktree] of [[c.state.pageA, c.state.profileA, c.world.worktreeA], [c.state.pageB, c.state.profileB, c.world.worktreeB]]) {
      const tab = tabs.find(tab => tab.browserPageId === page)
      c.assert(tab?.profileId === profile && tab.worktreeId === worktree && tab.title === 'Parity fixture', 'created page ownership or title mismatch')
    }
    return { tabs }
  } },
  { id: 'tab-list', async run(c) {
    const a = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeA }, '')).tabs
    const b = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeB }, '')).tabs
    c.equal(a.map(tab => tab.browserPageId), [c.state.pageA]); c.equal(b.map(tab => tab.browserPageId), [c.state.pageB])
    return { a, b }
  } },
  { id: 'tab-show', async run(c) {
    const { tab } = await c.call<{ tab: Tab }>('tab show')
    c.equal(tab.browserPageId, c.state.pageA); c.equal(tab.profileId, c.state.profileA); c.equal(tab.worktreeId, c.world.worktreeA)
    return { tab, page: await location(c, 'Parity fixture', '/page') }
  } },
  { id: 'tab-current', async run(c) {
    const { tab } = await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')
    c.equal(tab.browserPageId, c.state.pageA)
    return { tab, shown: await c.call('tab show') }
  } },
  { id: 'tab-switch', async run(c) {
    const disposable = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    c.state.disposable = disposable
    await c.call('tab switch', {}, c.state.pageA)
    c.equal((await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')).tab.browserPageId, c.state.pageA)
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeA }, '')).tabs
    const target = tabs.find(tab => tab.browserPageId === disposable)
    c.assert(target, 'disposable page absent')
    await c.call('tab switch', { index: target!.index, worktree: c.world.worktreeA }, '')
    c.equal((await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')).tab.browserPageId, disposable)
    await c.call('tab switch', {}, c.state.pageA)
    return { selectedByPage: c.state.pageA, selectedByReturnedIndex: target!.index, disposable }
  } },
  { id: 'tab-switch-focus', async run(c) {
    let observer: QuirkyClient | undefined
    let ui: QuirkyClient | undefined
    let baselinePanes: Set<string> | undefined
    const createdPanes = new Set<string>()
    try {
      observer = await connectClient(c, 'cli')
      c.equal((await uiState(observer)).windows, [])
      const selectedBefore = await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')
      const panesBefore = await paneState(c, c.world.worktreeA)
      c.assert(paneForPage(panesBefore, c.state.pageA).length === 0, 'Page A already has a browser pane')
      baselinePanes = new Set(panesBefore.tabs.map((pane) => pane.id))

      const refusal = await c.probe('tab switch', { focus: true })
      const refusalText = JSON.stringify(refusal.result)
      c.assert(refusal.exitCode !== 0, 'focus without a window unexpectedly succeeded')
      c.assert(refusalText.includes('browser_client_unavailable') && refusalText.includes('no Quirky window is connected to show the page'), 'unexpected no-window focus error')
      c.equal((await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')).tab.browserPageId, selectedBefore.tab.browserPageId)
      c.equal(await paneState(c, c.world.worktreeA), panesBefore, 'no-window focus changed pane state')

      ui = await connectClient(c, 'ui')
      const connId = await windowConnId(ui)
      const focused = await c.probe('tab switch', { focus: true })
      c.assert(focused.exitCode === 0, `focus with a stand-in window failed: ${JSON.stringify(focused.result)}`)
      const result = focused.result as { switched: number; browserPageId: string; focused?: boolean; pane?: string; paneOpened?: boolean; client?: number }
      if (typeof result.pane !== 'string') throw new BrowserFailure('wrong-page', 'focus result omitted its pane ID')
      const pane = result.pane
      createdPanes.add(pane)
      const current = await c.call<{ tab: Tab }>('tab current', { worktree: c.world.worktreeA }, '')
      c.equal(current.tab.browserPageId, c.state.pageA)
      c.equal(result, { switched: current.tab.index, browserPageId: c.state.pageA, focused: true, pane, paneOpened: true, client: connId })

      const shown = await windowState(observer, connId)
      c.equal(shown.layout.view, viewForWorktree(c.world.worktreeA))
      c.equal(shown.layout.worktree, c.world.worktreeA)
      const state = await paneState(c, c.world.worktreeA)
      const matches = paneForPage(state, c.state.pageA)
      c.equal(matches.length, 1)
      c.equal(matches[0]!.id, pane)
      c.equal(matches[0]!.mode, 'watch')
      c.equal(matches[0]!.profileId, current.tab.profileId)
      c.assert(hostedBrowserTabIsActive(await terminalWorkspace(observer, c.world.worktreeA), pane), 'hosted browser tab is not active in the worktree workspace')

      const repeated = await c.probe('tab switch', { focus: true })
      c.assert(repeated.exitCode === 0, `repeated focus failed: ${JSON.stringify(repeated.result)}`)
      const repeatedResult = repeated.result as { switched: number; browserPageId: string; focused?: boolean; pane?: string; paneOpened?: boolean; client?: number }
      c.equal(repeatedResult, { switched: current.tab.index, browserPageId: c.state.pageA, focused: true, pane, paneOpened: false, client: connId })
      c.equal(paneForPage(await paneState(c, c.world.worktreeA), c.state.pageA).map((tab) => tab.id), [pane])
      return { noWindow: { error: refusal.result, selectionUnchanged: true, panesUnchanged: true }, first: result, repeated: repeatedResult, window: shown.layout, pane: matches[0] }
    } finally {
      await finishProbe(c, observer, ui, c.world.worktreeA, baselinePanes, undefined, createdPanes, new Set())
    }
  } },
  { id: 'tab-close', async run(c) {
    const disposable = c.state.disposable
    if (typeof disposable !== 'string') throw new BrowserFailure('wrong-page', 'disposable page was not created')
    const before = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: c.world.worktreeA }, '')).tabs
    const target = before.find(tab => tab.browserPageId === disposable)
    c.assert(target, 'disposable page absent before indexed close')
    await c.call('tab close', { index: target!.index, worktree: c.world.worktreeA, yes: true }, '')
    const tabs = (await c.call<{ tabs: Tab[] }>('tab list', { worktree: 'all' }, '')).tabs
    c.assert(!tabs.some(tab => tab.browserPageId === disposable), 'closed page remains listed')
    const show = await c.probe('tab show', {}, disposable)
    c.assert(show.exitCode !== 0, 'closed page remains addressable')
    return { removedId: disposable, closedReturnedIndex: target!.index, tabs, show: show.result }
  } },
  { id: 'tab-profile-list', async run(c) {
    const { profiles } = await c.call<Profiles>('tab profile list', {}, '')
    c.assert(profiles.some(p => p.id === c.state.profileA) && profiles.some(p => p.id === c.state.profileB), 'created profiles missing')
    return { profiles, a: await c.call('tab profile show') }
  } },
  { id: 'tab-profile-show', async run(c) {
    const profile = await c.call<{ browserPageId: string; profileId: string; worktreeId: string }>('tab profile show')
    c.equal(profile, { ...profile, browserPageId: c.state.pageA, profileId: c.state.profileA, worktreeId: c.world.worktreeA })
    return { profile, tab: await c.call('tab show') }
  } },
  { id: 'tab-profile-set', async run(c) {
    const disposable = (await c.call<PageReceipt>('tab create', { profile: c.state.profileA, url: `${c.world.fixture.origin}/page`, worktree: c.world.worktreeA }, '')).browserPageId
    c.state.disposable = disposable
    const moved = await c.call<PageReceipt>('tab profile set-page', { profile: c.state.profileB }, disposable)
    c.equal(moved.browserPageId, disposable); c.equal(moved.profileId, c.state.profileB)
    const { tab } = await c.call<{ tab: Tab }>('tab show', {}, disposable)
    c.equal(tab.profileId, c.state.profileB)
    c.equal((await c.call<{ tab: Tab }>('tab show')).tab.profileId, c.state.profileA)
    return { moved, tab }
  } },
  { id: 'tab-profile-use-default', async run(c) {
    const disposable = c.state.disposable
    if (typeof disposable !== 'string') throw new BrowserFailure('wrong-page', 'disposable page was not created')
    const moved = await c.call<PageReceipt>('tab profile use-default', {}, disposable)
    c.equal(moved.browserPageId, disposable); c.equal(moved.profileId, 'default')
    const shown = await c.call<{ profileId: string }>('tab profile show', {}, disposable)
    c.equal(shown.profileId, 'default')
    await c.call('tab close', { yes: true }, disposable)
    return { moved, shown }
  } },
  { id: 'tab-profile-clone', async run(c) {
    const destination = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Clone destination' }, '')
    await c.call('cookie set', { name: 'clone-proof', value: 'copied', url: c.world.fixture.origin, path: '/' })
    const copy = await c.call<PageReceipt>('tab profile clone', { profile: destination.profile.id })
    c.assert(copy.browserPageId !== c.state.pageA, 'clone reused source page')
    c.equal(copy.profileId, destination.profile.id)
    const cookies = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', {}, copy.browserPageId)
    c.assert(cookies.cookies.some(cookie => cookie.name === 'clone-proof' && cookie.value === 'copied'), 'clone cookie lost')
    await c.call('tab close', { yes: true }, copy.browserPageId)
    return { copy, cookies }
  } },
  { id: 'tab-profile-delete', async run(c) {
    const { profile } = await c.call<{ profile: { id: string } }>('tab profile create', { label: 'Delete proof' }, '')
    const page = (await c.call<PageReceipt>('tab create', { profile: profile.id, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    await c.call('cookie set', { name: 'delete-proof', value: 'preserved', url: c.world.fixture.origin, path: '/', expires: Math.floor(c.world.fixture.startedAt / 1000) + 86400 }, page)
    const walk = (root: string): string | undefined => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const path = join(root, entry.name)
        if (entry.name === profile.id && existsSync(join(path, 'chrome-profile'))) return join(path, 'chrome-profile')
        const found = walk(path)
        if (found) return found
      }
      return undefined
    }
    const chrome = walk(c.world.home)
    c.assert(chrome, 'owned Chrome profile directory not found')
    await c.call('tab close', { yes: true }, page)
    const deleted = await c.probe('tab profile delete', { profile: profile.id, yes: true }, '')
    const profiles = (await c.call<Profiles>('tab profile list', {}, '')).profiles
    if (deleted.exitCode === 0) {
      c.assert(!profiles.some(p => p.id === profile.id) && !existsSync(chrome!), 'delete receipt without data erasure')
      return { deleted: true, metadataRemoved: true, chromeRemoved: true }
    }
    const error = JSON.stringify(deleted.result)
    c.assert(error.includes('conflict') && error.includes('no Quirky window is open'), 'unexpected profile-delete refusal')
    c.assert(profiles.some(p => p.id === profile.id) && existsSync(chrome!), 'refused deletion changed profile metadata/data')
    const reopened = (await c.call<PageReceipt>('tab create', { profile: profile.id, worktree: c.world.worktreeA, url: `${c.world.fixture.origin}/page` }, '')).browserPageId
    const cookies = await c.call<{ cookies: Array<{ name: string; value: string }> }>('cookie get', {}, reopened)
    c.assert(cookies.cookies.some(cookie => cookie.name === 'delete-proof' && cookie.value === 'preserved'), 'lost-cookie after refused deletion')
    await c.call('tab close', { yes: true }, reopened)
    return { gap: 'Headless agents cannot delete profiles: Native storage clearance requires a live desktop acknowledgement; no Quirky window is open', refusal: deleted.result, metadataPreserved: true, chromeDirectoryPreserved: true, cookies }
  } },
  { id: 'goto', async run(c) {
    const navigated = await c.call('goto', { url: `${c.world.fixture.origin}/second` })
    return { navigated, observed: await location(c, 'Second', '/second') }
  } },
  { id: 'back', async run(c) {
    const navigated = await c.call('back')
    return { navigated, observed: await location(c, 'Parity fixture', '/page') }
  } },
  { id: 'forward', async run(c) {
    const navigated = await c.call('forward')
    return { navigated, observed: await location(c, 'Second', '/second') }
  } },
  { id: 'reload', async run(c) {
    const before = c.world.fixture.requests.filter(request => request.path === '/second').length
    const navigated = await c.call('reload')
    c.assert(c.world.fixture.requests.filter(request => request.path === '/second').length > before, 'reload did not request page')
    const observed = await location(c, 'Second', '/second')
    await c.call('goto', { url: `${c.world.fixture.origin}/page` })
    return { navigated, observed }
  } },
  { id: 'open-url', async run(c) {
    let observer: QuirkyClient | undefined
    let ui: QuirkyClient | undefined
    let baselinePanes: Set<string> | undefined
    let baselinePages: Set<string> | undefined
    const createdPanes = new Set<string>()
    const createdPages = new Set<string>()
    try {
      const local = await c.call<PageReceipt>('open-url', { url: `${c.world.fixture.origin}/page`, worktree: c.world.worktreeA }, '')
      createdPages.add(local.browserPageId)
      const { tab } = await c.call<{ tab: Tab }>('tab show', {}, local.browserPageId)
      c.equal(tab.profileId, 'default'); c.equal(tab.worktreeId, c.world.worktreeA)
      const title = await c.observe('document.title', local.browserPageId)
      c.equal(title, 'Parity fixture')
      const localPageId = local.browserPageId
      const localTab = tab
      const localTitle = title
      const closedLocal = await c.call<{ closed: boolean }>('tab close', { yes: true }, localPageId)
      c.assert(closedLocal.closed, 'local open-url page did not close')
      createdPages.delete(localPageId)

      observer = await connectClient(c, 'cli')
      c.equal((await uiState(observer)).windows, [])
      baselinePanes = await paneIds(c, c.world.worktreeA)
      baselinePages = await pageIds(c)
      ui = await connectClient(c, 'ui')
      const connId = await windowConnId(ui)
      const routed = await c.call<PageReceipt & { pane: string; client: number }>('open-url', {
        url: `${c.world.fixture.origin}/page`,
        worktree: c.world.worktreeA,
        client: 'caller'
      }, '')
      createdPages.add(routed.browserPageId)
      createdPanes.add(routed.pane)
      c.assert(routed.client === connId, 'open-url result named the wrong window')
      const { tab: routedTab } = await c.call<{ tab: Tab }>('tab show', {}, routed.browserPageId)
      c.equal({ profileId: routedTab.profileId, worktreeId: routedTab.worktreeId, url: routedTab.url }, {
        profileId: 'default',
        worktreeId: c.world.worktreeA,
        url: `${c.world.fixture.origin}/page`
      })
      const panes = await paneState(c, c.world.worktreeA)
      const matches = paneForPage(panes, routed.browserPageId)
      c.equal(matches.length, 1)
      c.equal(matches[0]!.id, routed.pane)
      c.equal(matches[0]!.mode, 'watch')
      c.equal(matches[0]!.profileId, routedTab.profileId)
      const shown = await windowState(observer, connId)
      c.equal(shown.layout.view, viewForWorktree(c.world.worktreeA))
      c.equal(shown.layout.worktree, c.world.worktreeA)
      c.assert(hostedBrowserTabIsActive(await terminalWorkspace(observer, c.world.worktreeA), routed.pane), 'hosted browser tab is not active in the worktree workspace')
      return { local: { tab: localTab, title: localTitle, scope: 'local managed Default-profile page' }, routed, pane: matches[0], window: shown.layout }
    } finally {
      await finishProbe(c, observer, ui, c.world.worktreeA, baselinePanes, baselinePages, createdPanes, createdPages)
    }
  } }
]
