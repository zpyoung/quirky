import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const call = (client: BrowserTestHarness['client'], name: string, params: Record<string, unknown> = {}) =>
  client.callAny(`quirky.browser/${name}`, params)

type CliResult = { code: number; stdout: string; stderr: string }

async function runBrowserCli(h: BrowserTestHarness, argv: string[]): Promise<CliResult> {
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

type PaneCommand = { id: string; action: string; url?: string; level?: number }
type BrowserPane = {
  id: string
  worktreeId: string
  mode: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  tabId: string
  command: PaneCommand | null
}
type PaneState = { tabs: BrowserPane[]; active: string | null }
type HostTab = {
  id: string
  kind?: string
  viewId?: string
  key?: string
  input?: Record<string, unknown>
}
type HostGroup = { kind: 'group'; id: string; tabs: HostTab[]; activeTab: string | null }
type HostSplit = { kind: 'split'; first: HostTree; second: HostTree }
type HostTree = HostGroup | HostSplit
type TerminalWorkspace = { id: string; activeGroup: string; root: HostTree }

function groupsIn(node: HostTree): HostGroup[] {
  return node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)]
}

function terminalTabs(workspace: TerminalWorkspace): HostTab[] {
  return groupsIn(workspace.root).flatMap((group) => group.tabs)
}

function activeTerminalTab(workspace: TerminalWorkspace): string | null {
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

async function terminalWorkspace(h: BrowserTestHarness, worktree: string): Promise<TerminalWorkspace> {
  const result = await h.client.callAny('quirky.terminal/workspace', { workspace: `id:${worktree}` }) as { workspace: TerminalWorkspace }
  return result.workspace
}

function expectHostedTab(workspace: TerminalWorkspace, pane: BrowserPane): void {
  expect(pane.tabId).toBeTruthy()
  const hosted = terminalTabs(workspace).find((tab) => tab.id === pane.tabId)
  expect(hosted).toBeDefined()
  expect(hosted).toMatchObject({
    id: pane.tabId,
    kind: 'view',
    viewId: 'view:quirky.browser/page',
    key: `browser:${pane.id}`,
    input: { pane: pane.id }
  })
  expect(activeTerminalTab(workspace)).toBe(pane.tabId)
}

function cliJson<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`CLI exited ${result.code}: ${result.stderr}${result.stdout}`)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as T
}

async function completeWithin<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const timeout = Promise.withResolvers<never>()
  // A wall-clock watchdog is required because a deadlocked daemon API call emits no signal; fake time cannot advance that external I/O.
  const timer = setTimeout(() => timeout.reject(new Error(`${label} did not settle within ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([promise, timeout.promise])
  } finally {
    clearTimeout(timer)
  }
}

test('pane lifecycle API and generated CLI keep hosted tabs scoped, navigate, report, and close to fallback', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-lifecycle-main')
    const otherWorktree = await h.addFolderWorktree('pane-lifecycle-other')
    const worktreeSelector = `id:${worktree}`
    const otherSelector = `id:${otherWorktree}`

    const apiOpened = await call(h.client, 'paneOpen', {
      worktree: worktreeSelector,
      url: 'https://example.com/first'
    }) as BrowserPane
    expect(typeof apiOpened.id).toBe('string')
    expect(apiOpened).toMatchObject({ worktreeId: worktree, mode: 'native', url: 'https://example.com/first' })
    expectHostedTab(await terminalWorkspace(h, worktree), apiOpened)
    const apiState = await call(h.client, 'paneState', { worktree: worktreeSelector }) as PaneState
    expect(apiState).toMatchObject({ active: apiOpened.id, tabs: [expect.objectContaining({ id: apiOpened.id, tabId: apiOpened.tabId })] })

    // Exercise the generated `browser pane ...` commands without explicitly activating the plugin.
    const sameWorktreeOpen = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'open', '--worktree', worktreeSelector, '--url', 'https://example.com/second', '--json'
    ]))
    const otherWorktreeOpen = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'open', '--worktree', otherSelector, '--url', 'https://example.org/other', '--json'
    ]))
    expect(sameWorktreeOpen).toMatchObject({ worktreeId: worktree, mode: 'native', url: 'https://example.com/second' })
    expect(otherWorktreeOpen).toMatchObject({ worktreeId: otherWorktree, mode: 'native', url: 'https://example.org/other' })
    expectHostedTab(await terminalWorkspace(h, worktree), sameWorktreeOpen)
    expectHostedTab(await terminalWorkspace(h, otherWorktree), otherWorktreeOpen)

    const scopedMain = cliJson<PaneState>(await runBrowserCli(h, [
      'browser', 'pane', 'state', '--worktree', worktreeSelector, '--json'
    ]))
    expect(scopedMain.tabs.map(({ id }) => id).sort()).toEqual([apiOpened.id, sameWorktreeOpen.id].sort())
    expect(scopedMain.active).toBe(sameWorktreeOpen.id)
    const scopedOther = cliJson<PaneState>(await runBrowserCli(h, [
      'browser', 'pane', 'state', '--worktree', otherSelector, '--json'
    ]))
    expect(scopedOther.tabs.map(({ id }) => id)).toEqual([otherWorktreeOpen.id])
    expect(scopedOther.active).toBe(otherWorktreeOpen.id)

    const zoomed = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'control', '--pane', sameWorktreeOpen.id, '--action', 'zoom', '--level', '1', '--json'
    ]))
    expect(zoomed.command).toMatchObject({ action: 'zoom', level: 1 })
    const zoomReport = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'report', '--pane', sameWorktreeOpen.id,
      '--tab-id', sameWorktreeOpen.tabId!, '--command', zoomed.command!.id, '--json'
    ]))
    expect(zoomReport.command).toBeNull()

    const normalized = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'navigate', '--pane', sameWorktreeOpen.id, '--input', 'localhost:3000', '--json'
    ]))
    expect(normalized.command).toMatchObject({ action: 'navigate', url: 'http://localhost:3000/' })
    const latest = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'navigate', '--pane', sameWorktreeOpen.id, '--input', 'example.com/latest', '--json'
    ]))
    expect(latest.command).toMatchObject({ action: 'navigate', url: 'https://example.com/latest' })

    const staleReport = await runBrowserCli(h, [
      'browser', 'pane', 'report', '--pane', sameWorktreeOpen.id,
      '--tab-id', sameWorktreeOpen.tabId!, '--command', normalized.command!.id,
      '--url', normalized.command!.url!, '--title', 'Stale report', '--json'
    ])
    expect(staleReport.code).not.toBe(0)
    const afterStaleReport = await call(h.client, 'paneState', { worktree: worktreeSelector }) as PaneState
    expect(afterStaleReport.tabs.find((pane) => pane.id === sameWorktreeOpen.id)?.command?.id).toBe(latest.command!.id)

    // This acknowledges the expected Native report contract; it does not claim a native WebView rendered.
    const reported = cliJson<BrowserPane>(await runBrowserCli(h, [
      'browser', 'pane', 'report', '--pane', sameWorktreeOpen.id,
      '--tab-id', sameWorktreeOpen.tabId!, '--command', latest.command!.id,
      '--url', latest.command!.url!, '--title', 'Expected native report',
      '--loading=false', '--can-go-back=true', '--json'
    ]))
    expect(reported).toMatchObject({
      url: 'https://example.com/latest',
      title: 'Expected native report',
      loading: false,
      canGoBack: true,
      command: null
    })

    const cliClosed = cliJson<boolean>(await runBrowserCli(h, [
      'browser', 'pane', 'close', '--pane', sameWorktreeOpen.id, '--yes', '--json'
    ]))
    expect(cliClosed).toBe(true)
    const terminalAfterClose = await terminalWorkspace(h, worktree)
    expect(terminalTabs(terminalAfterClose).some((tab) => tab.id === sameWorktreeOpen.tabId)).toBe(false)
    expect(terminalTabs(terminalAfterClose).some((tab) => tab.id === apiOpened.tabId)).toBe(true)
    expect(activeTerminalTab(terminalAfterClose)).toBe(apiOpened.tabId)
    const paneStateAfterClose = await call(h.client, 'paneState', { worktree: worktreeSelector }) as PaneState
    expect(paneStateAfterClose.tabs.map(({ id }) => id)).toEqual([apiOpened.id])
    expect(paneStateAfterClose.active).toBe(apiOpened.id)

    const repeatedClose = cliJson<boolean>(await runBrowserCli(h, [
      'browser', 'pane', 'close', '--pane', sameWorktreeOpen.id, '--yes', '--json'
    ]))
    expect(repeatedClose).toBe(true)
    expect(terminalTabs(await terminalWorkspace(h, worktree)).some((tab) => tab.id === sameWorktreeOpen.tabId)).toBe(false)
    const paneStateOtherAfterClose = await call(h.client, 'paneState', { worktree: otherSelector }) as PaneState
    expect(paneStateOtherAfterClose.tabs.map(({ id }) => id)).toEqual([otherWorktreeOpen.id])
    expect(paneStateOtherAfterClose.active).toBe(otherWorktreeOpen.id)
    expect(terminalTabs(await terminalWorkspace(h, otherWorktree)).some((tab) => tab.id === otherWorktreeOpen.tabId)).toBe(true)
    expect(h.spawnCount()).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 90_000)

test('closing a hosted tab through quirky.terminal/closeTab removes pane metadata without queue deadlock', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('pane-terminal-close-hook')
    const selector = `id:${worktree}`
    const first = await call(h.client, 'paneOpen', { worktree: selector, url: 'https://example.com/first' }) as BrowserPane
    const closing = await call(h.client, 'paneOpen', { worktree: selector, url: 'https://example.com/closing' }) as BrowserPane
    expectHostedTab(await terminalWorkspace(h, worktree), closing)

    const closeResult = await completeWithin(
      h.client.callAny('quirky.terminal/closeTab', { tab: closing.tabId, yes: true }) as Promise<{ workspace: TerminalWorkspace }>,
      5_000,
      'terminal-origin browser pane close hook'
    )
    expect(terminalTabs(closeResult.workspace).some((tab) => tab.id === closing.tabId)).toBe(false)
    expect(terminalTabs(closeResult.workspace).some((tab) => tab.id === first.tabId)).toBe(true)
    expect(activeTerminalTab(closeResult.workspace)).toBe(first.tabId)

    const panes = await call(h.client, 'paneState', { worktree: selector }) as PaneState
    expect(panes.tabs.map(({ id }) => id)).toEqual([first.id])
    expect(panes.active).toBe(first.id)
    expect(h.spawnCount()).toBe(0)
  } finally {
    await h.cleanup()
  }
}, 90_000)
