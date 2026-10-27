import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type QuirkyClient } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '@quirky/git/testing'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { setBrowserTestOverrides, takeBrowserTestOverrides, type BrowserTestOverrides } from './dependencies'

const ROOT = resolve(import.meta.dir, '../../..')
const PLUGINS = join(ROOT, 'plugins')
const BROWSER = join(PLUGINS, 'quirky.browser')

export type BrowserTestHarness = {
  home: string
  scope: ProcessScope
  daemon: Harness
  client: QuirkyClient
  sourceRoots: Record<string, string>
  fixtureUrl: string
  spawnCount: () => number
  addFolderWorktree(name: string): Promise<string>
  cleanup(): Promise<void>
}

export type FixtureServer = { url: string; stop(): void }

export function startFixtureServer(): FixtureServer {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/first') return html('<!doctype html><title>First</title><h1>First</h1>')
      if (path === '/second') return html('<!doctype html><title>Second</title><h1>Second</h1>')
      if (path === '/asset') return new Response('fixture-download-bytes', { headers: { 'content-type': 'application/octet-stream' } })
      if (path === '/download') return html('<!doctype html><title>Download</title><a id="download" href="/asset" download="fixture.bin">download</a>')
      if (path === '/tall') return html('<!doctype html><title>Tall</title><div style="height:2600px;background:linear-gradient(red,blue)">tall</div>')
      if (path === '/events') {
        return html(`<!doctype html><title>Events</title>
          <input id="text" value="seed"><input id="other"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
          <input id="check" type="checkbox"><div id="drag" draggable="true">drag</div><div id="drop">drop</div><input id="files" type="file">
          <button id="submit">Submit</button><p id="delayed" hidden>ready</p>
          <script>
            setTimeout(() => { document.querySelector('#delayed').hidden = false }, 150)
            console.log('one'); console.warn('two'); console.error('three')
            window.fixtureFetch = () => Promise.all([fetch('/one').then(r => r.text()), fetch('/two').then(r => r.text())])
          </script>`)
      }
      if (path === '/headers') return new Response(request.headers.get('x-fixture') ?? 'missing')
      if (path === '/auth') {
        const expected = `Basic ${Buffer.from('fixture-user:secret').toString('base64')}`
        if (request.headers.get('authorization') === expected) return new Response('authenticated')
        return new Response('authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="fixture"' } })
      }
      if (path === '/one' || path === '/two') return new Response(path.slice(1))
      return html('<!doctype html><title>Blank fixture</title><main>fixture</main>')
    }
  })
  return { url: server.url.href, stop: () => server.stop(true) }
}

function createTestPluginDir(builtinPluginsDir: string): void {
  for (const id of ['quirky.repo', 'quirky.worktree']) symlinkSync(join(PLUGINS, id), join(builtinPluginsDir, id))
  const pluginDir = join(builtinPluginsDir, 'quirky.browser')
  mkdirSync(pluginDir, { recursive: true })
  for (const name of ['quirky-plugin.json', 'package.json']) {
    cpSync(join(BROWSER, name), join(pluginDir, name))
  }
  const cliUrl = pathToFileURL(join(BROWSER, 'cli.ts')).href
  writeFileSync(join(pluginDir, 'cli.ts'), `export * from ${JSON.stringify(cliUrl)}\n`)
  const mainUrl = pathToFileURL(join(BROWSER, 'main.ts')).href
  const defaultsUrl = pathToFileURL(join(BROWSER, 'src', 'runtime', 'defaults.ts')).href
  const testingUrl = pathToFileURL(join(import.meta.dir, 'dependencies.ts')).href
  writeFileSync(join(pluginDir, 'main.ts'), `
import { createBrowserPlugin } from ${JSON.stringify(mainUrl)}
import { browserDependencies } from ${JSON.stringify(defaultsUrl)}
import { takeBrowserTestOverrides } from ${JSON.stringify(testingUrl)}
let browser
export function activate(context) {
  const overrides = takeBrowserTestOverrides(context.home)
  if (!overrides) throw new Error('missing browser test dependencies')
  browser = createBrowserPlugin(context, { ...browserDependencies(overrides.runtimeRoot), ...overrides })
}
export async function deactivate() { await browser?.deactivate() }
`)
}

export async function startBrowserHarness(extra: Partial<BrowserTestOverrides> = {}): Promise<BrowserTestHarness> {
  const scope = createProcessScope()
  const home = scope.home
  const fixture = startFixtureServer()
  const sourcesRoot = join(home, 'source-fixtures')
  const sourceRoots: Record<string, string> = {}
  for (const family of ['chrome', 'edge', 'arc', 'chromium', 'comet', 'helium', 'firefox', 'safari']) {
    sourceRoots[family] = join(sourcesRoot, family)
    mkdirSync(sourceRoots[family]!, { recursive: true, mode: 0o700 })
  }
  const launched: string[] = []
  const overrides: BrowserTestOverrides = {
    runtimeRoot: BROWSER,
    spawn(command, options) {
      launched.push(command[0] ?? '')
      return scope.spawn(command, options)
    },
    chromeArguments: ['--use-mock-keychain'],
    chromePath: null,
    sourceRoots,
    keyProvider: async () => Buffer.from('synthetic-safe-storage-key'),
    ...extra
  }
  setBrowserTestOverrides(home, overrides)

  const work = mkdtempSync(join(tmpdir(), 'quirky-browser-tests-'))
  const builtinPluginsDir = join(work, 'plugins')
  mkdirSync(builtinPluginsDir, { recursive: true })
  createTestPluginDir(builtinPluginsDir)
  const fakeGit = createFakeGit()
  useTestGit(fakeGit)
  let daemon: Harness | undefined
  try {
    daemon = await startHarness({ home, builtinPluginsDir })
    const client = await daemon.connect('cli')
    return {
      home,
      scope,
      daemon,
      client,
      sourceRoots,
      fixtureUrl: fixture.url,
      spawnCount: () => launched.length,
      async addFolderWorktree(name: string) {
        const path = join(home, 'projects', name)
        mkdirSync(path, { recursive: true })
        const added = await client.callAny('quirky.repo/add', { path, folder: true }) as { id: string }
        const worktrees = await client.callAny('quirky.worktree/list', {}) as Array<{ id: string; repoId: string; path: string }>
        const match = worktrees.find((worktree) => worktree.repoId === added.id)
        if (!match) throw new Error(`folder project ${name} did not produce a worktree`)
        return match.id
      },
      async cleanup() {
        setBrowserTestOverrides(home, undefined)
        fixture.stop()
        useTestGit(null)
        let error: unknown
        try { await daemon!.cleanup() } catch (cleanupError) { error = cleanupError }
        try { await scope.cleanup() } catch (cleanupError) { error ??= cleanupError }
        rmSync(work, { recursive: true, force: true })
        if (error) throw error
      }
    }
  } catch (error) {
    setBrowserTestOverrides(home, undefined)
    fixture.stop()
    useTestGit(null)
    if (daemon) await daemon.cleanup()
    await scope.cleanup()
    rmSync(work, { recursive: true, force: true })
    throw error
  }
}
