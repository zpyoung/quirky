import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES,
  NATIVE_BROWSER_PREVIEW_SCHEME,
  nativeBrowserPreviewUrl,
  type NativeBrowserPreviewGrant
} from '@quirky/protocol'
import { createNativeBrowserHandlers, type NativeBrowserViewPort } from '../src/bun/native-browser'
import { createWorkspacePreviewHandler, type WorkspacePreviewHandler } from '../src/bun/workspace-preview'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-workspace-preview-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const worktree = join(base, 'worktree')
const docs = join(worktree, 'docs')
mkdirSync(join(docs, 'assets'), { recursive: true })
mkdirSync(join(docs, '.git'), { recursive: true })
writeFileSync(join(worktree, '.env'), 'SECRET=1')
writeFileSync(join(worktree, 'root.html'), '<!doctype html><title>Root</title>')
writeFileSync(join(worktree, 'sibling.css'), 'body{}')
writeFileSync(join(docs, 'index.html'), '<!doctype html><title>Report</title><link rel=stylesheet href="assets/site.css">')
writeFileSync(join(docs, 'assets', 'site.css'), 'body{color:red}')
writeFileSync(join(docs, 'assets', 'data #1.json'), '{"ok":true}')
writeFileSync(join(docs, '.git', 'config'), '[core]')
writeFileSync(join(docs, 'blob.bin'), 'binary')
symlinkSync(join(worktree, '.env'), join(docs, 'linked-secret.txt'))

const GRANT = 'a'.repeat(32)
const folderGrant: NativeBrowserPreviewGrant = { id: GRANT, root: docs, entry: 'index.html', entryOnly: false }

async function fetchPreview(handler: WorkspacePreviewHandler, path: string, init?: RequestInit): Promise<Response> {
  return await handler(new Request(`${NATIVE_BROWSER_PREVIEW_SCHEME}://${GRANT}/${path}`, init))
}

describe('workspace preview grant handler', () => {
  test('serves the entry and in-folder assets with the preview policy headers', async () => {
    const handler = createWorkspacePreviewHandler(folderGrant)
    const entry = await handler(new Request(nativeBrowserPreviewUrl(GRANT, 'index.html')))
    expect(entry.status).toBe(200)
    expect(entry.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(entry.headers.get('cache-control')).toBe('no-store')
    expect(entry.headers.get('x-content-type-options')).toBe('nosniff')
    expect(entry.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(await entry.text()).toContain('<title>Report</title>')

    const css = await fetchPreview(handler, 'assets/site.css')
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    const encoded = await fetchPreview(handler, 'assets/data%20%231.json')
    expect(await encoded.json()).toEqual({ ok: true })
    expect((await fetchPreview(handler, '')).status).toBe(200)
    const binary = await fetchPreview(handler, 'blob.bin')
    expect(binary.headers.get('content-type')).toBe('application/octet-stream')
  })

  test('re-reads the file on every request so reload shows the current disk', async () => {
    const handler = createWorkspacePreviewHandler(folderGrant)
    writeFileSync(join(docs, 'live.html'), 'first')
    expect(await (await fetchPreview(handler, 'live.html')).text()).toBe('first')
    writeFileSync(join(docs, 'live.html'), 'second')
    expect(await (await fetchPreview(handler, 'live.html')).text()).toBe('second')
  })

  test('refuses traversal, dotfiles, symlinks, other grants and non-GET methods', async () => {
    const handler = createWorkspacePreviewHandler(folderGrant)
    for (const path of ['../sibling.css', '%2e%2e/sibling.css', 'assets/..%2f..%2fsibling.css', '..%5csibling.css', '.git/config', '%2egit/config', 'linked-secret.txt', 'missing.html', 'assets']) {
      const response = await fetchPreview(handler, path)
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
    }
    const otherGrant = await handler(new Request(`${NATIVE_BROWSER_PREVIEW_SCHEME}://${'b'.repeat(32)}/index.html`))
    expect(otherGrant.status).toBe(404)
    const otherScheme = await handler(new Request(`https://${GRANT}/index.html`))
    expect(otherScheme.status).toBe(404)
    expect((await fetchPreview(handler, 'index.html', { method: 'POST', body: 'x' })).status).toBe(405)
    const head = await fetchPreview(handler, 'index.html', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  test('an entry-only grant at the worktree root reads the entry and nothing beside it', async () => {
    const handler = createWorkspacePreviewHandler({ id: GRANT, root: worktree, entry: 'root.html', entryOnly: true })
    expect((await fetchPreview(handler, 'root.html')).status).toBe(200)
    expect((await fetchPreview(handler, '')).status).toBe(200)
    expect((await fetchPreview(handler, 'sibling.css')).status).toBe(404)
    expect((await fetchPreview(handler, 'docs/index.html')).status).toBe(404)
    expect((await fetchPreview(handler, '.env')).status).toBe(404)
  })
})

class PreviewViewModel implements NativeBrowserViewPort {
  readonly windowId = 12
  readonly hostWebviewId = 34
  readonly sandbox = true
  readonly renderer = 'native' as const
  readonly partition = null
  readonly allowedProtocols = { views: true, appData: false }
  url = 'about:blank'
  navigationRules: string | null = null
  handler: WorkspacePreviewHandler | null = null
  removed = false
  userAgent: string | null = null
  // implements page requests so only the claim's own refusal can keep a preview out of them
  pageRequestKinds: string[] = []
  constructor(readonly id: number, readonly isolatedPreview: string | null = NATIVE_BROWSER_PREVIEW_SCHEME) {}
  setNativeRequestHandling(kinds: string[]): boolean { this.pageRequestKinds.push(...kinds); return true }
  respondToNativeRequest(): boolean { return true }
  on(): void {}
  setUserAgent(userAgent: string | null): boolean { this.userAgent = userAgent; return true }
  getStorageIdentifier(): string | null { return null }
  setIsolatedPreviewHandler(handler: WorkspacePreviewHandler | null): void { this.handler = handler }
  setNavigationRules(rules: string[]): void { this.navigationRules = JSON.stringify(rules) }
  setPageZoom(): void {}
  getPageZoom(): number { return 1 }
  remove(): void { this.removed = true }
}

describe('isolated preview claims', () => {
  const rig = (views: PreviewViewModel[]) => createNativeBrowserHandlers({
    getWindow: () => ({ id: 12, webview: { id: 34 } }),
    getView: (id) => views.find((view) => view.id === id && !view.removed) as NativeBrowserViewPort | undefined,
    sessionProxy: { supported: () => false, set: () => undefined },
    // a preview has no profile, so reaching its store at all is the bug this guards
    storage: {
      identifierFor: (partition) => { throw new Error(`preview touched profile storage: ${partition}`) },
      prepare: (partition) => { throw new Error(`preview touched profile storage: ${partition}`) },
      clear: (partition) => { throw new Error(`preview touched profile storage: ${partition}`) }
    },
    defaultUserAgent: () => null,
    sendPageEvent: () => undefined
  })

  test('claiming an SDK isolated preview installs its rules and a handler bound to the grant', async () => {
    const view = new PreviewViewModel(7)
    const handlers = rig([view])
    const claim = await handlers.claim({ viewId: 7, owner: 'owner', partition: '', preview: folderGrant, userAgent: null })
    expect(claim.pageRequests).toBe(false)
    expect(view.pageRequestKinds).toEqual([])
    expect(view.navigationRules).toBe(JSON.stringify(NATIVE_BROWSER_PREVIEW_NAVIGATION_RULES))
    expect(view.handler).not.toBeNull()
    expect((await fetchPreview(view.handler!, 'index.html')).status).toBe(200)
    expect((await fetchPreview(view.handler!, '../sibling.css')).status).toBe(404)
    await handlers.setZoom({ viewId: 7, owner: 'owner', level: 1 })
    await handlers.release({ viewId: 7, owner: 'owner' })
    expect(view.removed).toBe(true)
  })

  test('a preview grant never attaches to an ordinary browsing view, and a browsing claim never takes a preview', async () => {
    const ordinary = new PreviewViewModel(8, null)
    await expect(rig([ordinary]).claim({ viewId: 8, owner: 'owner', partition: '', preview: folderGrant, userAgent: null })).rejects.toThrow('owned sandboxed child')
    expect(ordinary.handler).toBeNull()

    const preview = new PreviewViewModel(9)
    await expect(rig([preview]).claim({
      viewId: 9,
      owner: 'owner',
      partition: `persist:quirky-browser-profile_${'c'.repeat(32)}`,
      userAgent: null
    })).rejects.toThrow('owned sandboxed child')
  })

  test('malformed grants are refused before the view is touched', async () => {
    for (const grant of [
      { ...folderGrant, id: 'short' },
      { ...folderGrant, root: 'relative/root' },
      { ...folderGrant, entry: '../escape.html' },
      { ...folderGrant, entry: 'a//b.html' }
    ]) {
      const view = new PreviewViewModel(10)
      await expect(rig([view]).claim({ viewId: 10, owner: 'owner', partition: '', preview: grant, userAgent: null })).rejects.toThrow('owned sandboxed child')
      expect(view.navigationRules).toBeNull()
      expect(view.handler).toBeNull()
    }
  })
})
