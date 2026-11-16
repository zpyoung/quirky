import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { QuirkyClient, UiModel } from '@quirky/protocol'
import { connectDaemon, isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from './fixtures'
import { prepareRuntimeAssets, runtimeAssetEnvironment, snapshotRuntimeAssets, verifyRuntimeAssets, type AssetSnapshot, type RuntimeAssets } from './runtime-assets'

const checkout = resolve(import.meta.dir, '../..')
let scratch = ''
let repo = ''
const scopes: ProcessScope[] = []
const assets: RuntimeAssets[] = []
const snapshots: AssetSnapshot[] = []
const models: UiModel[] = []
const ports: number[] = []
const clients: QuirkyClient[] = []
const servers: Bun.Server<undefined>[] = []
let sourceBefore = ''

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function sourceFingerprint(): string {
  const paths = ['packages/ui/dist/sentinel', 'plugins/acme.fixture/dist/sentinel', 'plugins/acme.headless/main.ts']
  return JSON.stringify(paths.map(path => {
    const file = join(repo, path)
    const stat = statSync(file)
    return [path, stat.ino, stat.mtimeMs, createHash('sha256').update(readFileSync(file)).digest('hex')]
  }))
}

async function build(index: number): Promise<void> {
  const scope = scopes[index]!
  const env = runtimeAssetEnvironment(createIsolatedRuntimeEnvironment(scope.home, { repoRoot: checkout }), assets[index]!)
  const child = scope.spawn([process.execPath, join(checkout, 'packages/ui/build.ts')], { cwd: checkout, env, stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect({ code, detail: code === 0 ? '' : out + err }).toEqual({ code: 0, detail: '' })
}

async function boot(index: number): Promise<void> {
  const scope = scopes[index]!
  const env = runtimeAssetEnvironment(createIsolatedRuntimeEnvironment(scope.home, { repoRoot: checkout }), assets[index]!)
  const child = scope.spawn([process.execPath, join(checkout, 'packages/daemon/src/main.ts')], { cwd: checkout, env, stdout: 'pipe', stderr: 'pipe' })
  const logs = new Response(child.stderr).text()
  const reader = child.stdout.getReader()
  let output = ''
  while (!output.includes('quirkyd listening on')) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`fixture daemon did not start: ${await logs}`)
    output += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  const runtime = readRuntime(scope.home)
  if (!runtime || !await isDaemonAlive(runtime, 1_000)) throw new Error('fixture runtime is not healthy')
  const client = await connectDaemon({ home: scope.home, role: 'cli', name: 'runtime-assets-test', autostart: false })
  clients.push(client)
  models[index] = await client.call('ui.contributions', {})
  ports[index] = runtime.port
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'quirky-runtime-assets-e2e-'))
  repo = join(scratch, 'checkout')
  put(join(repo, 'packages/ui/dist/sentinel'), 'checkout-shell')
  put(join(repo, 'plugins/acme.fixture/dist/sentinel'), 'checkout-plugin')
  put(join(repo, 'plugins/acme.fixture/quirky-plugin.json'), JSON.stringify({
    id: 'acme.fixture', name: 'Fixture', version: '1.0.0', apiVersion: '1.12.0', activation: 'startup', main: 'main.ts', ui: 'dist/ui.js',
    contributes: { view: [{ id: 'page', title: 'Fixture page' }] }
  }))
  put(join(repo, 'plugins/acme.fixture/main.ts'), 'export function activate() {}\n')
  put(join(repo, 'plugins/acme.fixture/src/ui.tsx'), [
    "import { version } from 'pdfjs-dist/package.json'",
    "import { greeting } from './greeting'",
    "export const info = [version, greeting]",
    "export const load = () => import('./lazy')",
    "export const worker = new URL('./pdf.worker.min.mjs', import.meta.url)",
    "export function activate() {}"
  ].join('\n'))
  put(join(repo, 'plugins/acme.fixture/src/greeting.ts'), "export const greeting = 'capture-A'\n")
  put(join(repo, 'plugins/acme.fixture/src/lazy.ts'), "export const lazy = 'split fixture'\n")
  put(join(repo, 'plugins/acme.fixture/src/viewers/ViewerSurface.tsx'), 'export {}\n')
  symlinkSync(join(checkout, 'plugins/quirky.editor/node_modules'), join(repo, 'plugins/acme.fixture/node_modules'))
  symlinkSync(join(checkout, 'node_modules'), join(repo, 'node_modules'))
  put(join(repo, 'plugins/acme.headless/quirky-plugin.json'), JSON.stringify({ id: 'acme.headless', name: 'Headless', version: '1.0.0', apiVersion: '1.12.0', main: 'main.ts', activation: 'startup' }))
  put(join(repo, 'plugins/acme.headless/main.ts'), 'export function activate() {}\n')
  sourceBefore = sourceFingerprint()
  scopes.push(createProcessScope(), createProcessScope())
  assets.push(...await Promise.all(scopes.map(scope => prepareRuntimeAssets({ repoRoot: repo, home: scope.home, skipBuild: false }))))
  put(join(assets[1]!.pluginsDir, 'acme.fixture/src/greeting.ts'), "export const greeting = 'capture-B'\n")
  await Promise.all([build(0), build(1)])
  snapshots.push(...assets.map(snapshotRuntimeAssets))
  await Promise.all([boot(0), boot(1)])
}, 120_000)

afterAll(async () => {
  for (const server of servers) await server.stop(true)
  for (const client of clients) client.close()
  await Promise.all(scopes.map(scope => scope.cleanup()))
  for (const scope of scopes) expect(existsSync(scope.home)).toBe(false)
  try {
    if (sourceBefore) expect(sourceFingerprint()).toBe(sourceBefore)
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}, 30_000)

function verify(index = 0, port = ports[index]!, timeoutMs = 10_000, signal?: AbortSignal) {
  return verifyRuntimeAssets(assets[index]!, snapshots[index]!, models[index]!, { port, timeoutMs, signal })
}

function proxy(change: (path: string, bytes: Uint8Array) => Response | undefined) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const response = await fetch(`http://127.0.0.1:${ports[0]}${path}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    return change(path, bytes) ?? new Response(bytes, { status: response.status })
  } })
  servers.push(server)
  return server.port!
}

function corrupt(bytes: Uint8Array) {
  const copy = bytes.slice()
  copy[0] = copy[0] === 120 ? 121 : 120
  return copy
}

test('real builder and isolated daemons serve every staged asset, including split modules and PDF workers', async () => {
  expect(assets[0]!.uiDir).not.toBe(assets[1]!.uiDir)
  expect(assets[0]!.pluginsDir).not.toBe(assets[1]!.pluginsDir)
  expect(models[0]!.modules['acme.fixture']!.url).toBe('/plugins/acme.fixture/dist/ui.js')
  const snapshot = snapshotRuntimeAssets(assets[0]!)
  expect([...snapshot.keys()].some(path => /chunk-.*\.js$/.test(path))).toBe(true)
  expect(snapshot.has('/plugins/acme.fixture/dist/pdf.worker.min.mjs')).toBe(true)
  expect(existsSync(join(assets[0]!.pluginsDir, 'acme.headless/dist'))).toBe(false)
  const moduleA = await (await fetch(`http://127.0.0.1:${ports[0]}/plugins/acme.fixture/dist/ui.js`)).text()
  const moduleB = await (await fetch(`http://127.0.0.1:${ports[1]}/plugins/acme.fixture/dist/ui.js`)).text()
  expect(moduleA).toContain('capture-A')
  expect(moduleB).toContain('capture-B')
  const worker = await fetch(`http://127.0.0.1:${ports[0]}/plugins/acme.fixture/dist/pdf.worker.min.mjs`)
  expect(Buffer.from(await worker.arrayBuffer())).toEqual(readFileSync(join(assets[0]!.pluginsDir, 'acme.fixture/dist/pdf.worker.min.mjs')))
  const index = await (await fetch(`http://127.0.0.1:${ports[0]}/index.html`)).text()
  expect(Buffer.byteLength(index)).toBeGreaterThan(snapshot.get('/index.html')!.size)
  expect(index).toContain('<link rel="modulepreload" href="/plugins/acme.fixture/dist/ui.js">')
  await verify(0)
  await verify(1)
  expect(sourceFingerprint()).toBe(sourceBefore)
}, 30_000)

test('wrong shell and plugin roots fail independently despite correct local output', async () => {
  for (const target of ['/main.js', '/plugins/acme.fixture/dist/ui.js', '/plugins/acme.fixture/dist/pdf.worker.min.mjs',
    ...[...snapshotRuntimeAssets(assets[0]!).keys()].filter(path => path.startsWith('/plugins/') && /chunk-.*\.js$/.test(path))]) {
    const port = proxy((path, bytes) => path === target ? new Response(corrupt(bytes)) : undefined)
    await expect(verify(0, port)).rejects.toThrow(`runtime assets: served bytes differ ${target}`)
  }
}, 30_000)

test('real transformed index has an exact streaming byte bound and digest', async () => {
  for (const target of ['/', '/index.html']) {
    const large = proxy((path, bytes) => path === target ? new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes)
      controller.enqueue(new Uint8Array([120]))
      controller.close()
    } })) : undefined)
    await expect(verify(0, large)).rejects.toThrow('runtime assets: response too large')
    const altered = proxy((path, bytes) => path === target ? new Response(corrupt(bytes)) : undefined)
    await expect(verify(0, altered)).rejects.toThrow('runtime assets: served bytes differ')
  }
}, 30_000)

test('HTTP errors, redirects and unbounded streams cannot certify a valid local snapshot', async () => {
  const target = '/plugins/acme.fixture/dist/ui.js'
  const missing = proxy(path => path === target ? new Response('missing', { status: 404 }) : undefined)
  await expect(verify(0, missing)).rejects.toThrow('runtime assets: HTTP 404')
  let redirected = false
  const redirect = proxy(path => {
    if (path === '/unexpected') redirected = true
    return path === target ? new Response(null, { status: 302, headers: { location: '/unexpected' } }) : undefined
  })
  await expect(verify(0, redirect)).rejects.toThrow('runtime assets: HTTP 302')
  expect(redirected).toBe(false)
  const oversized = proxy((path, bytes) => path === target ? new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes)
    controller.enqueue(new Uint8Array([0]))
    controller.close()
  } })) : undefined)
  await expect(verify(0, oversized)).rejects.toThrow('runtime assets: response too large')
}, 30_000)

test('timeouts and caller cancellation terminate pending real HTTP responses', async () => {
  let requested = Promise.withResolvers<void>()
  const producers: ReadableStreamDefaultController<Uint8Array>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    requested.resolve()
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      producers.push(controller)
      controller.enqueue(new Uint8Array([60]))
    } }))
  } })
  servers.push(server)
  try {
    await expect(verify(0, server.port!, 100)).rejects.toThrow(/timeout|timed out|exceeded/i)
    requested = Promise.withResolvers<void>()
    const abort = new AbortController()
    const pending = verify(0, server.port!, 10_000, abort.signal)
    await requested.promise
    abort.abort(new Error('caller stopped verification'))
    await expect(pending).rejects.toThrow('caller stopped verification')
  } finally {
    for (const producer of producers) {
      try { producer.close() } catch { /* client cancellation can already close its producer */ }
    }
  }
})

test('missing, added and replaced output is rejected without repairs', async () => {
  const runtime = assets[0]!
  const file = join(runtime.pluginsDir, 'acme.fixture/dist/ui.js')
  const original = readFileSync(file)
  const snapshot = snapshotRuntimeAssets(runtime)
  try {
    writeFileSync(file, corrupt(original))
    await expect(verifyRuntimeAssets(runtime, snapshot, models[0]!, { port: ports[0]!, timeoutMs: 10_000 })).rejects.toThrow('runtime assets: changed')
    rmSync(file)
    await expect(verifyRuntimeAssets(runtime, snapshot, models[0]!, { port: ports[0]!, timeoutMs: 10_000 })).rejects.toThrow('runtime assets: missing')
    writeFileSync(file, original)
    put(join(runtime.uiDir, 'unexpected.js'), 'added')
    await expect(verifyRuntimeAssets(runtime, snapshot, models[0]!, { port: ports[0]!, timeoutMs: 10_000 })).rejects.toThrow('runtime assets: changed')
  } finally {
    writeFileSync(file, original)
    rmSync(join(runtime.uiDir, 'unexpected.js'), { force: true })
  }
})

test('a failed owned build and cleanup leave the other completed capture readable', async () => {
  put(join(assets[0]!.pluginsDir, 'acme.fixture/src/ui.tsx'), 'invalid syntax !!!')
  const scope = scopes[0]!
  const env = runtimeAssetEnvironment(createIsolatedRuntimeEnvironment(scope.home, { repoRoot: checkout }), assets[0]!)
  const child = scope.spawn([process.execPath, join(checkout, 'packages/ui/build.ts')], { cwd: checkout, env, stdout: 'ignore', stderr: 'ignore' })
  expect(await child.exited).not.toBe(0)
  clients[0]!.close()
  await scope.cleanup()
  expect(existsSync(scope.home)).toBe(false)
  await verify(1)
  expect(sourceFingerprint()).toBe(sourceBefore)
}, 60_000)
