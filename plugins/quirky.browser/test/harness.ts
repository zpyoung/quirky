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
  fixtureUrl: string
  spawnCount: () => number
  spawnCommands: () => string[][]
  fixtureGate: (id: string) => { requested: Promise<void>; release(): void }
  addFolderWorktree(name: string): Promise<string>
  cleanup(): Promise<void>
}

export type FixtureGate = { requested: Promise<void>; release(): void }
export type FixtureServer = { url: string; gate(id: string): FixtureGate; stop(): void }

export function startFixtureServer(): FixtureServer {
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  const gates = new Map<string, { requested: Promise<void>; announce(): void; released: Promise<void>; release(): void }>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path === '/first') return html('<!doctype html><title>First</title><h1>First</h1>')
      if (path === '/second') return html('<!doctype html><title>Second</title><h1>Second</h1>')
      if (path === '/tall') return html('<!doctype html><title>Tall</title><div style="height:2600px;background:linear-gradient(red,blue)">tall</div>')
      if (path.startsWith('/gate/')) {
        const gate = gates.get(path.slice('/gate/'.length))
        if (!gate) return new Response('fixture gate was not registered', { status: 404 })
        gate.announce()
        await gate.released
        return html('<!doctype html><title>Gate</title><h1>Gate</h1><input id="text" value="seed">')
      }
      if (path === '/events') {
        return html(`<!doctype html><title>Events</title>
          <label for="text">Text field</label><input id="text" value="seed">
          <button id="submit" onclick="document.querySelector('#result').textContent='clicked'">Submit</button>
          <output id="result"></output>`)
      }
      return html('<!doctype html><title>Blank fixture</title><main>fixture</main>')
    }
  })
  return {
    url: server.url.href,
    gate(id) {
      const requested = Promise.withResolvers<void>()
      const released = Promise.withResolvers<void>()
      if (gates.has(id)) throw new Error(`fixture gate ${id} already exists`)
      gates.set(id, { requested: requested.promise, announce: requested.resolve, released: released.promise, release: released.resolve })
      return { requested: requested.promise, release: released.resolve }
    },
    stop: () => server.stop(true)
  }
}

function createTestPluginDir(builtinPluginsDir: string): void {
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.editor']) symlinkSync(join(PLUGINS, id), join(builtinPluginsDir, id))
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
  const launched: string[][] = []
  const overrides: BrowserTestOverrides = {
    runtimeRoot: BROWSER,
    spawn(command, options) {
      launched.push([...command])
      return scope.spawn(command, options)
    },
    chromeArguments: ['--use-mock-keychain'],
    chromePath: null,
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
      fixtureUrl: fixture.url,
      spawnCount: () => launched.length,
      spawnCommands: () => launched.map((command) => [...command]),
      fixtureGate: (id) => fixture.gate(id),
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
