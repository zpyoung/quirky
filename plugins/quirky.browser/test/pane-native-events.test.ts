import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from 'bun:test'
import type { QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneNativeAction, PaneNativeDecision, PaneState, PaneTab } from '../src/pane-contract'

// The browser window relays Native page requests as a UI caller; the CLI answers like a person would.
type Rig = { h: BrowserTestHarness; ui: QuirkyClient; pane: string; worktree: string; actions: PaneNativeAction[]; stop(): Promise<void> }

async function startNativePane(extra: Parameters<typeof startBrowserHarness>[0] = {}): Promise<Rig> {
  const h = await startBrowserHarness(extra)
  try {
    const ui = await h.daemon.connect('ui')
    const worktree = await h.addFolderWorktree('native-events')
    const opened = await h.client.callAny('quirky.browser/paneOpen', { worktree: `id:${worktree}`, url: 'https://site.test/', mode: 'native' }) as PaneTab
    const actions: PaneNativeAction[] = []
    await ui.call('events.subscribe', {})
    const unsubscribe = ui.onEvent((event: QuirkyEvent) => {
      if (event.type === 'quirky.browser/paneNative') actions.push(event.data as PaneNativeAction)
    })
    return { h, ui, pane: opened.id, worktree, actions, async stop() { unsubscribe(); await h.cleanup() } }
  } catch (error) {
    await h.cleanup()
    throw error
  }
}

const relay = (rig: Rig, request: Record<string, unknown>) =>
  rig.ui.callAny('quirky.browser/paneNativeRequest', { pane: rig.pane, request }) as Promise<PaneNativeDecision>

const update = (rig: Rig, params: Record<string, unknown>) =>
  rig.ui.callAny('quirky.browser/paneNativeUpdate', { pane: rig.pane, ...params }) as Promise<{ updated: boolean }>

const respond = (rig: Rig, client: QuirkyClient, params: Record<string, unknown>) =>
  client.callAny('quirky.browser/paneRespond', { pane: rig.pane, ...params })

async function paneTab(rig: Rig): Promise<PaneTab> {
  const state = await rig.h.client.callAny('quirky.browser/paneState', { worktree: `id:${rig.worktree}` }) as PaneState
  const tab = state.tabs.find((candidate) => candidate.id === rig.pane)
  if (!tab) throw new Error('native pane disappeared')
  return tab
}

async function waitFor<T>(read: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for native pane state')
    await Bun.sleep(20)
  }
}

test('a Native dialog becomes one origin-naming prompt whose answer, with Unicode text, goes back to the view', async () => {
  const rig = await startNativePane()
  try {
    await expect(rig.h.client.callAny('quirky.browser/paneNativeRequest', {
      pane: rig.pane, request: { id: '1', kind: 'alert', origin: 'https://site.test', frameUrl: '', message: 'hi' }
    })).rejects.toThrow(/browser window/)

    const decision = await relay(rig, { id: '7', kind: 'prompt', origin: 'https://site.test', frameUrl: 'https://site.test/', message: 'Your name?', defaultText: 'x' })
    expect(decision.answer).toBeNull()
    const prompt = (await paneTab(rig)).prompts[0]
    expect(prompt).toMatchObject({ id: decision.prompt, kind: 'prompt', origin: 'https://site.test', message: 'Your name?', defaultValue: 'x' })

    const flood = await relay(rig, { id: '8', kind: 'confirm', origin: 'https://site.test', frameUrl: '', message: 'again?' })
    expect(flood).toEqual({ prompt: null, answer: { accept: false } })

    await respond(rig, rig.h.client, { prompt: decision.prompt, accept: true, text: 'héllo 世界' })
    const answer = await waitFor(() => rig.actions.find((action) => action.action === 'answer' && action.id === '7'))
    expect(answer).toEqual({ pane: rig.pane, action: 'answer', id: '7', prompt: decision.prompt!, kind: 'prompt', accept: true, text: 'héllo 世界' })
    expect((await paneTab(rig)).prompts).toEqual([])
    await expect(respond(rig, rig.h.client, { prompt: decision.prompt, accept: true })).rejects.toBeInstanceOf(Error)
  } finally {
    await rig.stop()
  }
}, 60_000)

test('an unanswered Native prompt fails closed at its deadline, and navigation declines a pending one', async () => {
  const rig = await startNativePane({ promptTimeoutMs: 150 })
  try {
    const decision = await relay(rig, { id: '11', kind: 'confirm', origin: 'https://site.test', frameUrl: '', message: 'Sure?' })
    const timedOut = await waitFor(() => rig.actions.find((action) => action.action === 'answer' && action.id === '11'))
    expect(timedOut).toMatchObject({ accept: false, kind: 'confirm', prompt: decision.prompt })
    expect((await paneTab(rig)).prompts).toEqual([])
    await expect(respond(rig, rig.h.client, { prompt: decision.prompt, accept: true })).rejects.toBeInstanceOf(Error)
  } finally {
    await rig.stop()
  }

  const second = await startNativePane()
  try {
    await relay(second, { id: '12', kind: 'alert', origin: 'https://site.test', frameUrl: '', message: 'stuck' })
    await second.h.client.callAny('quirky.browser/paneNavigate', { pane: second.pane, input: 'https://other.test/' })
    expect(await waitFor(() => second.actions.find((action) => action.id === '12'))).toMatchObject({ accept: false })
    expect((await paneTab(second)).prompts).toEqual([])

    const expired = await relay(second, { id: '13', kind: 'confirm', origin: 'https://other.test', frameUrl: '', message: 'Sure?' })
    expect(await update(second, { expired: '13' })).toEqual({ updated: true })
    expect((await paneTab(second)).prompts).toEqual([])
    await expect(respond(second, second.h.client, { prompt: expired.prompt, accept: true })).rejects.toBeInstanceOf(Error)
  } finally {
    await second.stop()
  }
}, 60_000)

test('Native sign-in credentials never reach the daemon, and only the window completes sign-in', async () => {
  const rig = await startNativePane()
  try {
    const decision = await relay(rig, { id: '21', kind: 'auth', origin: 'https://site.test', host: 'site.test', realm: 'Pane fixture', isProxy: false, previousFailureCount: 0 })
    expect((await paneTab(rig)).prompts[0]?.message).toContain('Pane fixture')
    await expect(respond(rig, rig.h.client, { prompt: decision.prompt, accept: true, username: 'ada', password: 'auth-secret' })).rejects.toThrow(/never sent to the daemon/)
    await expect(respond(rig, rig.h.client, { prompt: decision.prompt, accept: true })).rejects.toThrow(/browser window/)
    await respond(rig, rig.ui, { prompt: decision.prompt, accept: true })
    const answer = await waitFor(() => rig.actions.find((action) => action.id === '21'))
    expect(answer).toMatchObject({ kind: 'auth', accept: true, prompt: decision.prompt })
    expect(JSON.stringify([answer, await paneTab(rig)])).not.toContain('auth-secret')
  } finally {
    await rig.stop()
  }
}, 60_000)

test('Native certificate exceptions proceed only for loopback, and external apps need an allow-listed scheme, a gesture and the UI', async () => {
  const rig = await startNativePane()
  try {
    const remote = await relay(rig, { id: '31', kind: 'certificate', origin: 'https://example.test', host: 'example.test', error: 'untrusted' })
    expect((await paneTab(rig)).prompts[0]).toMatchObject({ kind: 'certificate', canProceed: false })
    await expect(respond(rig, rig.ui, { prompt: remote.prompt, accept: true })).rejects.toThrow(/loopback/)
    expect(await waitFor(() => rig.actions.find((action) => action.id === '31'))).toMatchObject({ accept: false })

    const loopback = await relay(rig, { id: '32', kind: 'certificate', origin: 'https://127.0.0.1:8443', host: '127.0.0.1', error: 'self-signed' })
    expect((await paneTab(rig)).prompts[0]).toMatchObject({ kind: 'certificate', canProceed: true })
    await respond(rig, rig.ui, { prompt: loopback.prompt, accept: true })
    expect(await waitFor(() => rig.actions.find((action) => action.id === '32'))).toMatchObject({ accept: true })

    for (const [id, url, userGesture] of [['41', 'javascript:alert(1)', true], ['42', 'file:///etc/passwd', true], ['43', 'zoommtg://zoom.us/join', false], ['44', 'unknownapp://x', true]] as const) {
      expect(await relay(rig, { id, kind: 'external', origin: 'https://site.test', url, scheme: url.split(':')[0], userGesture })).toEqual({ prompt: null, answer: { accept: false } })
    }
    const external = await relay(rig, { id: '45', kind: 'external', origin: 'https://site.test', url: 'zoommtg://zoom.us/join?confno=1', scheme: 'zoommtg', userGesture: true })
    expect((await paneTab(rig)).prompts[0]).toMatchObject({ kind: 'external', origin: 'https://site.test' })
    await expect(respond(rig, rig.h.client, { prompt: external.prompt, accept: true })).rejects.toThrow(/browser UI/)
    await respond(rig, rig.ui, { prompt: external.prompt, accept: true })
    expect(await waitFor(() => rig.actions.find((action) => action.id === '45'))).toMatchObject({ kind: 'external', accept: true })
  } finally {
    await rig.stop()
  }
}, 60_000)

test('Native downloads reserve a collision-free Downloads name first, report progress and cancel only themselves', async () => {
  const rig = await startNativePane()
  try {
    const downloads = join(rig.h.home, 'Downloads')
    mkdirSync(downloads, { recursive: true })
    writeFileSync(join(downloads, 'report.pdf'), 'keep existing file')

    const first = await relay(rig, { id: '51', kind: 'download', origin: 'https://site.test', url: 'https://site.test/report.pdf', suggestedFilename: '../../report.pdf', mimeType: 'application/pdf', expectedBytes: 10 })
    expect(first.prompt).toBeNull()
    expect(first.answer?.accept).toBe(true)
    const firstPath = first.answer?.path
    if (!firstPath) throw new Error('download was not given a destination')
    expect(dirname(firstPath)).toBe(realpathSync(downloads))
    expect(firstPath.endsWith('report (1).pdf')).toBe(true)
    expect(existsSync(firstPath)).toBe(false)

    const second = await relay(rig, { id: '52', kind: 'download', origin: 'https://site.test', url: 'https://site.test/b.zip', suggestedFilename: 'b.zip', mimeType: '', expectedBytes: 0 })
    let tab = await paneTab(rig)
    expect(tab.downloads.map((download) => [download.name, download.state])).toEqual([['report (1).pdf', 'downloading'], ['b.zip', 'downloading']])

    await update(rig, { download: { id: '51', state: 'started', path: firstPath } })
    await update(rig, { download: { id: '51', state: 'progress', received: 4, total: 10 } })
    tab = await paneTab(rig)
    expect(tab.downloads[0]).toMatchObject({ received: 4, total: 10, state: 'downloading', path: firstPath })

    const secondEntry = tab.downloads[1]!
    await rig.h.client.callAny('quirky.browser/paneDownload', { pane: rig.pane, download: secondEntry.id, action: 'cancel' })
    expect(await waitFor(() => rig.actions.find((action) => action.action === 'cancelDownload'))).toEqual({ pane: rig.pane, action: 'cancelDownload', id: '52' })
    await update(rig, { download: { id: '52', state: 'failed', cancelled: true, error: 'cancelled' } })
    writeFileSync(firstPath, 'downloaded')
    await update(rig, { download: { id: '51', state: 'completed', path: firstPath } })
    tab = await paneTab(rig)
    expect(tab.downloads.map((download) => download.state)).toEqual(['completed', 'canceled'])
    expect(tab.downloads[0]).toMatchObject({ received: 10, path: firstPath })
    expect(second.answer?.path?.endsWith('b.zip')).toBe(true)

    await update(rig, { download: { id: '51', state: 'failed', error: 'late' } })
    expect((await paneTab(rig)).downloads[0]?.state).toBe('completed')
    await rig.h.client.callAny('quirky.browser/paneDownload', { pane: rig.pane, download: secondEntry.id, action: 'dismiss' })
    expect((await paneTab(rig)).downloads.map((download) => download.name)).toEqual(['report (1).pdf'])
  } finally {
    await rig.stop()
  }
}, 60_000)

test('Native popups open only for HTTP(S), at most four every two seconds', async () => {
  const rig = await startNativePane()
  try {
    const popup = (id: string, url: string) => relay(rig, { id, kind: 'popup', origin: 'https://site.test', url, method: 'POST', width: 480, height: 640 })
    expect(await popup('60', 'javascript:alert(1)')).toEqual({ prompt: null, answer: { accept: false } })
    for (const id of ['61', '62', '63', '64']) expect((await popup(id, 'https://accounts.test/oauth')).answer).toEqual({ accept: true })
    expect((await popup('65', 'https://accounts.test/oauth')).answer).toEqual({ accept: false })
    await Bun.sleep(2_100)
    expect((await popup('66', 'https://accounts.test/oauth')).answer).toEqual({ accept: true })
  } finally {
    await rig.stop()
  }
}, 60_000)
