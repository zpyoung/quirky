import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { run } from '../../../packages/cli/src/main'
import { createDaemonLink } from '../../../packages/cli/src/link'
import { NATIVE_BROWSER_PREVIEW_SCHEME, isNativeBrowserPreviewUrl } from '@quirky/protocol'
import { startBrowserHarness, type BrowserTestHarness } from './harness'
import type { PaneState, PaneTab } from '../src/pane-contract'

const call = async (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  await h.client.callAny(`quirky.browser/${name}`, params) as PaneTab

async function runBrowserCli(h: BrowserTestHarness, argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const client = await h.daemon.connect('cli')
  const code = await run({
    argv,
    env: { QUIRKY_HOME: h.home },
    cwd: h.home,
    writer: { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } },
    link: createDaemonLink(async () => client, {}),
    openDesktopApp: async () => ({ ok: false, reason: 'not used' })
  })
  return { code, stdout, stderr }
}

/** Acknowledges the pending command the way the renderer does once the guest settles. */
async function settle(h: BrowserTestHarness, pane: PaneTab, url: string, history: { canGoBack?: boolean; canGoForward?: boolean } = {}): Promise<PaneTab> {
  return await call(h, 'paneReport', {
    pane: pane.id,
    tabId: pane.tabId,
    ...(pane.command ? { command: pane.command.id } : {}),
    url,
    title: 'Settled',
    loading: false,
    canGoBack: history.canGoBack ?? false,
    canGoForward: history.canGoForward ?? false
  })
}

function storedPaneRows(home: string): string[] {
  const rows: string[] = []
  const visit = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) visit(path)
      else if (/\.(db|sqlite3?)$/.test(name)) {
        const db = new Database(path, { readonly: true })
        try {
          const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_pane_tabs'").get()
          if (table) for (const row of db.query('SELECT data FROM browser_pane_tabs').all() as Array<{ data: string }>) rows.push(row.data)
        } finally {
          db.close()
        }
      }
    }
  }
  visit(home)
  return rows
}

test('a Native pane converts to an isolated workspace preview and Back/Forward cross the conversion', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('preview-flow')
    const root = realpathSync(join(h.home, 'projects', 'preview-flow'))
    mkdirSync(join(root, 'report', 'assets'), { recursive: true })
    writeFileSync(join(root, 'report', 'index.html'), '<!doctype html><title>Report</title>')
    writeFileSync(join(root, 'report', 'second.html'), '<!doctype html><title>Second</title>')

    const opened = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: 'https://example.com/start' })
    const web = await settle(h, opened, 'https://example.com/start')
    expect(web.convertedFrom).toBeUndefined()

    const previewed = await call(h, 'panePreview', { pane: web.id, path: 'report/index.html' })
    expect(previewed.document?.path).toBe(join(root, 'report', 'index.html'))
    expect(previewed.document?.grant).toMatchObject({ root: join(root, 'report'), entry: 'index.html', entryOnly: false })
    expect(previewed.url).toBe(previewed.document!.url)
    expect(isNativeBrowserPreviewUrl(previewed.url, previewed.document!.grant.id)).toBe(true)
    expect(previewed.command).toMatchObject({ action: 'navigate', url: previewed.url })
    expect(previewed.convertedFrom).toEqual({ kind: 'url', url: 'https://example.com/start' })
    expect(previewed.sourcePath).toBe(join(root, 'report', 'index.html'))
    expect(previewed.canGoBack).toBe(false)
    expect(h.spawnCount()).toBe(0)

    // The isolated guest may only report addresses inside its own grant.
    await expect(call(h, 'paneReport', {
      pane: previewed.id, tabId: previewed.tabId, command: previewed.command!.id, url: 'https://evil.example/'
    })).rejects.toThrow('outside its grant')
    const inGrant = previewed.url.replace('index.html', 'second.html')
    let doc = await settle(h, previewed, inGrant, { canGoBack: true })
    expect(doc.url).toBe(inGrant)

    // Guest history comes first: Back stays inside the preview while the guest can go back.
    const guestBack = await call(h, 'paneControl', { pane: doc.id, action: 'back' })
    expect(guestBack.command?.action).toBe('back')
    expect(guestBack.document).toBeDefined()
    doc = await settle(h, guestBack, previewed.url, { canGoBack: false, canGoForward: true })

    // Then Back crosses the conversion and Forward re-crosses it.
    const returned = await call(h, 'paneControl', { pane: doc.id, action: 'back' })
    expect(returned.document).toBeUndefined()
    expect(returned.url).toBe('https://example.com/start')
    expect(returned.command).toMatchObject({ action: 'navigate', url: 'https://example.com/start' })
    expect(returned.convertedFrom).toBeUndefined()
    expect(returned.convertedTo).toEqual({ kind: 'document', path: join(root, 'report', 'index.html') })
    const back = await settle(h, returned, 'https://example.com/start')

    const advanced = await call(h, 'paneControl', { pane: back.id, action: 'forward' })
    expect(advanced.document?.path).toBe(join(root, 'report', 'index.html'))
    expect(advanced.document?.grant.id).not.toBe(previewed.document!.grant.id)
    expect(advanced.convertedFrom).toEqual({ kind: 'url', url: 'https://example.com/start' })
    expect(advanced.convertedTo).toBeUndefined()
    const reDoc = await settle(h, advanced, advanced.url)

    // Typing an address on a document page converts back to browsing, recording where it came from.
    const typed = await call(h, 'paneNavigate', { pane: reDoc.id, input: 'example.org/next' })
    expect(typed.document).toBeUndefined()
    expect(typed.url).toBe('https://example.org/next')
    expect(typed.convertedFrom).toEqual({ kind: 'document', path: join(root, 'report', 'index.html') })

    // A grant URL never reaches history or storage.
    const state = await h.client.callAny('quirky.browser/paneState', { worktree: `id:${worktree}` }) as PaneState
    expect(state.history.some((entry) => entry.url.startsWith(`${NATIVE_BROWSER_PREVIEW_SCHEME}:`))).toBe(false)
    expect(storedPaneRows(h.home).some((row) => row.includes(`${NATIVE_BROWSER_PREVIEW_SCHEME}:`))).toBe(false)
  } finally {
    await h.cleanup()
  }
}, 30_000)

test('previews refuse files the grant model cannot scope safely and store only the document path', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('preview-scope')
    const root = realpathSync(join(h.home, 'projects', 'preview-scope'))
    mkdirSync(join(root, '.hidden'), { recursive: true })
    writeFileSync(join(root, 'top.html'), '<!doctype html><title>Top</title>')
    writeFileSync(join(root, 'notes.txt'), 'notes')
    writeFileSync(join(root, '.hidden', 'page.html'), '<!doctype html>')
    const outside = join(h.home, 'outside.html')
    writeFileSync(outside, '<!doctype html>')
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}` })

    await expect(call(h, 'panePreview', { pane: pane.id, path: outside })).rejects.toThrow('canonical worktree root')
    await expect(call(h, 'panePreview', { pane: pane.id, path: 'notes.txt' })).rejects.toThrow('.html or .htm')
    await expect(call(h, 'panePreview', { pane: pane.id, path: '.hidden/page.html' })).rejects.toThrow('hidden folders')
    await expect(call(h, 'panePreview', { pane: pane.id, path: 'missing.html' })).rejects.toThrow('existing worktree file')
    const unchanged = await h.client.callAny('quirky.browser/paneState', { worktree: `id:${worktree}` }) as PaneState
    expect(unchanged.tabs.find((tab) => tab.id === pane.id)?.document).toBeUndefined()

    // At the worktree root the grant reads the file alone: secrets live beside it.
    const top = await call(h, 'panePreview', { pane: pane.id, path: join(root, 'top.html') })
    expect(top.document?.grant).toMatchObject({ root, entry: 'top.html', entryOnly: true })
    expect(top.convertedFrom).toEqual({ kind: 'url', url: 'about:blank' })
    const rows = storedPaneRows(h.home).map((row) => JSON.parse(row) as Partial<PaneTab>)
    const stored = rows.find((row) => row.id === pane.id)
    expect(stored?.document).toEqual({ path: join(root, 'top.html') } as unknown as PaneTab['document'])
    expect(stored?.url).toBe('about:blank')

  } finally {
    await h.cleanup()
  }
}, 30_000)

test('the browser pane preview CLI command converts through the same API', async () => {
  const h = await startBrowserHarness()
  try {
    const worktree = await h.addFolderWorktree('preview-cli')
    const root = realpathSync(join(h.home, 'projects', 'preview-cli'))
    mkdirSync(join(root, 'site'), { recursive: true })
    writeFileSync(join(root, 'site', 'index.html'), '<!doctype html><title>Site</title>')
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}` })
    const result = await runBrowserCli(h, ['browser', 'pane', 'preview', '--pane', pane.id, '--path', 'site/index.html', '--json'])
    expect(result.code).toBe(0)
    const converted = JSON.parse(result.stdout) as PaneTab
    expect(converted.document?.path).toBe(join(root, 'site', 'index.html'))
    expect(converted.convertedFrom).toEqual({ kind: 'url', url: 'about:blank' })
  } finally {
    await h.cleanup()
  }
}, 30_000)
