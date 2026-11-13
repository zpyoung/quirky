import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginCaller, PluginContext, PluginStore, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { createProcessRunner } from '../../../packages/process/src/runner'
import { PaneService } from '../src/pane-service'
import type { PaneNativeDecision, PaneTab } from '../src/pane-contract'
import { BrowserStore } from '../src/profiles/store'
import { createBrowserSpawn } from '../src/runtime/defaults'
import { BrowserRuntime, createExternalPrompt, type RuntimePanePrompt } from '../src/runtime/driver'
import { stopOwned } from '../src/runtime/process'
import type { CdpEvent } from '../src/runtime/cdp'

const openOptions = { timeoutMs: 30_000, maxOutputBytes: 1, overflow: 'truncate', killGraceMs: 2_000 } as const
const ui: PluginCaller = { role: 'ui' }
const cli: PluginCaller = { role: 'cli' }
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const platform = (value: string) => Object.defineProperty(process, 'platform', { ...descriptor, value })
const result = (overrides: Partial<RunResult> = {}): RunResult => ({
  stdout: new Uint8Array(), stdoutText: '', stderr: '', exitCode: 0, signal: null, durationMs: 1, ...overrides
})
function recording(answer: () => Promise<RunResult> = async () => result()) {
  const calls: { argv: readonly string[]; options: RunOptions | undefined }[] = []
  const process: ProcessRunner = { run(argv, options) { calls.push({ argv: [...argv], options }); return answer() } }
  return { process, calls }
}
const event = (url = 'mailto:alice@example.test?body=secret', userGesture = true) => ({ method: 'Page.windowOpen', params: { url, userGesture } })

async function promptly<T>(work: Promise<T>): Promise<T> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  const pending = Symbol('pending')
  const value = await Promise.race([work, Promise.resolve(pending)])
  expect(value).not.toBe(pending)
  return value as T
}

async function paneRig(runner: ProcessRunner, log?: (message: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'browser-open-runner-')))
  const database = new Database(':memory:')
  const store: PluginStore = {
    version: 1,
    run(sql, ...params) { const value = database.query(sql).run(...params); return { changes: value.changes, lastInsertRowid: Number(value.lastInsertRowid) } },
    get<T>(sql: string, ...params: (string | number | null | Uint8Array)[]) { return database.query(sql).get(...params) as T | null },
    all<T>(sql: string, ...params: (string | number | null | Uint8Array)[]) { return database.query(sql).all(...params) as T[] },
    exec(sql) { database.exec(sql) },
    transaction(work) { return database.transaction(work)() }
  }
  const logs: string[] = []
  const context = {
    home: root, dataDir: root,
    openStore(migrations: string[]) { for (const migration of migrations) store.exec(migration); return store },
    getSetting() { return undefined },
    call: async () => ({ tab: 'hosted-tab' }),
    emit() { return true },
    log(message: string) { logs.push(message) }
  } as unknown as PluginContext
  const dependencies = { runtimeRoot: root, process: { ...runner, spawn() { throw new Error('unexpected browser spawn') } }, spawn() { throw new Error('unexpected browser spawn') }, ...(log ? { log } : {}) }
  const runtime = new BrowserRuntime(new BrowserStore(root), dependencies, () => {})
  const downloads = join(root, 'Downloads')
  const panes = new PaneService(context, new BrowserStore(root), runtime, async () => 'worktree-1', async () => [{ id: 'worktree-1', name: 'Fixture', path: root }], downloads)
  try {
    const tab = await panes.call('paneOpen', { worktree: 'worktree-1', url: 'https://site.test/', mode: 'native' }, cli) as PaneTab
    const decision = await panes.call('paneNativeRequest', { pane: tab.id, request: { id: 'download-1', kind: 'download', origin: 'https://site.test', url: 'https://site.test/report.pdf', suggestedFilename: 'report.pdf', mimeType: 'application/pdf', expectedBytes: 4 } }, ui) as PaneNativeDecision
    const path = decision.answer?.path
    if (!path) throw new Error('download did not receive a destination')
    const download = panes.listPanes()[0]!.downloads[0]!.id
    return {
      root, path, downloads, tab, panes, runtime, logs, download,
      async complete() {
        writeFileSync(path, 'data')
        await panes.call('paneNativeUpdate', { pane: tab.id, download: { id: 'download-1', state: 'completed', path } }, ui)
      },
      open(action = 'open', caller = cli) { return panes.call('paneDownload', { pane: tab.id, download, action }, caller) },
      async cleanup() { await panes.deactivate(); database.close(); rmSync(root, { recursive: true, force: true }) }
    }
  } catch (error) {
    await panes.deactivate(); database.close(); rmSync(root, { recursive: true, force: true }); throw error
  }
}

describe('approved browser launches use injected runners', () => {
  let guard: { mockRestore(): void }
  beforeEach(() => {
    platform('darwin')
    guard = spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('unowned spawn forbidden') })
  })
  afterEach(() => { guard.mockRestore(); Object.defineProperty(process, 'platform', descriptor) })

  for (const action of ['open', 'reveal']) test(`completed download ${action} returns before the owned command exits`, async () => {
    const pending = Promise.withResolvers<RunResult>()
    const recordingRunner = recording(() => pending.promise)
    const rig = await paneRig(recordingRunner.process)
    try {
      await rig.complete()
      expect(await promptly(rig.open(action, action === 'open' ? ui : cli))).toMatchObject({ action, completed: true, download: { state: 'completed', path: rig.path } })
      expect(recordingRunner.calls).toEqual([{ argv: action === 'open' ? ['open', rig.path] : ['open', '-R', rig.path], options: openOptions }])
      pending.resolve(result({ truncated: { stdout: true, stderr: true } }))
      await pending.promise
      await Promise.resolve()
      expect(rig.logs).toEqual([])
    } finally { pending.resolve(result()); await rig.cleanup() }
  })

  test('download guards refuse plugins, incomplete files, directories, escaped paths and unsupported platforms', async () => {
    const runner = recording()
    const rig = await paneRig(runner.process)
    try {
      await expect(rig.open()).rejects.toThrow('only a completed owned download')
      await rig.complete()
      await expect(rig.open('open', { role: 'plugin', pluginId: 'fixture' })).rejects.toThrow('explicit user action')
      rmSync(rig.path)
      mkdirSync(rig.path)
      await expect(rig.open()).rejects.toThrow('not a regular owned file')
      rmSync(rig.path, { recursive: true })
      const outside = join(rig.root, 'outside.pdf')
      writeFileSync(outside, 'private')
      symlinkSync(outside, rig.path)
      await expect(rig.open()).rejects.toThrow('outside the OS Downloads directory')
      rmSync(rig.path)
      writeFileSync(rig.path, 'data')
      platform('linux')
      await expect(rig.open()).rejects.toThrow('supported only on macOS')
      expect(runner.calls).toEqual([])
    } finally { await rig.cleanup() }
  })

  const failures: { name: string; value: RunResult | Error; reason: string; sync?: true }[] = [
    { name: 'exit', value: result({ exitCode: 7 }), reason: 'open exited with 7' },
    { name: 'signal', value: result({ signal: 'SIGTERM' }), reason: 'open terminated by SIGTERM' },
    ...(['timeout', 'aborted', 'overflow'] as const).map(stopped => ({ name: stopped, value: result({ stopped }), reason: `open stopped: ${stopped}` })),
    { name: 'spawn path', value: result({ spawnError: { code: 'ENOENT', message: 'ENOENT: cannot open /Users/fixture/Downloads/report.pdf' } }), reason: 'ENOENT: cannot open [path]' },
    { name: 'spawn mailto', value: result({ spawnError: { code: 'ENOENT', message: 'ENOENT: cannot open mailto:alice@example.test?body=secret' } }), reason: 'ENOENT: cannot open [redacted]' },
    { name: 'rejection path', value: new Error('fixture rejected /Users/fixture/Downloads/report.pdf'), reason: 'fixture rejected [path]' },
    { name: 'rejection mailto', value: new Error('fixture rejected mailto:alice@example.test?body=secret'), reason: 'fixture rejected [redacted]' },
    { name: 'sync path', value: new Error('fixture threw /Users/fixture/Downloads/report.pdf'), reason: 'fixture threw [path]', sync: true },
    { name: 'sync mailto', value: new Error('fixture threw mailto:alice@example.test'), reason: 'fixture threw [redacted]', sync: true }
  ]
  for (const failure of failures) {
    const answer = () => {
      if (failure.sync) throw failure.value
      return failure.value instanceof Error ? Promise.reject(failure.value) : Promise.resolve(failure.value)
    }
    test(`download ${failure.name} logs once with a redacted reason`, async () => {
      const runner = recording(answer)
      const rig = await paneRig(runner.process)
      try {
        await rig.complete()
        expect(await rig.open()).toMatchObject({ completed: true })
        expect(rig.logs).toEqual([`could not open external target: ${failure.reason}`])
      } finally { await rig.cleanup() }
    })
    test(`external prompt ${failure.name} logs once without rejecting the response`, async () => {
      const logs: string[] = []
      const runner = recording(answer)
      const prompt = createExternalPrompt(event(), 'https://site.test/page', () => true, { process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } }, log: message => logs.push(message) })!
      await prompt.respond({ accept: true })
      expect(runner.calls).toEqual([{ argv: ['open', 'mailto:alice@example.test?body=secret'], options: openOptions }])
      expect(logs).toEqual([`could not open external target: ${failure.reason}`])
    })
  }

  for (const failure of ['spawn', 'reject', 'throw']) test(`approved target redaction handles quotes and spaces in ${failure} errors`, async () => {
    const url = "mailto:o'connor@example.test?body=medical history"
    const logs: string[] = []
    const answer = () => {
      const message = `fixture failed ${url}`
      if (failure === 'throw') throw new Error(message)
      if (failure === 'reject') return Promise.reject(new Error(message))
      return Promise.resolve(result({ spawnError: { code: 'ENOENT', message } }))
    }
    const runner = recording(answer)
    const prompt = createExternalPrompt(event(url), undefined, () => true, {
      process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } },
      log: message => logs.push(message)
    })!
    await prompt.respond({ accept: true })
    expect(runner.calls[0]?.argv).toEqual(['open', url])
    expect(logs).toEqual(['could not open external target: fixture failed [redacted]'])
  })

  test('approved target redaction removes a complete download path containing spaces', async () => {
    let path = ''
    const rig = await paneRig(recording(() => Promise.reject(new Error(`fixture failed ${path}`))).process)
    try {
      path = join(rig.downloads, "owner's private report.pdf")
      rig.runtime.openDetached(['open', path], message => rig.logs.push(message))
      await Promise.resolve()
      expect(rig.logs).toEqual(['could not open external target: fixture failed [path]'])
    } finally { await rig.cleanup() }
  })

  test('runtime open uses its configured logger instead of the pane fallback', async () => {
    const logs: string[] = []
    const rig = await paneRig(recording(async () => result({ exitCode: 7 })).process, message => logs.push(message))
    try {
      await rig.complete()
      await rig.open()
      expect(logs).toEqual(['could not open external target: open exited with 7'])
      expect(rig.logs).toEqual([])
    } finally { await rig.cleanup() }
  })

  test('external prompts require a user gesture and only accept mailto URLs', () => {
    const runner = recording()
    const dependencies = { process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } } }
    for (const url of ['https://site.test', 'http://site.test', 'javascript:alert(1)', 'not a URL', 'file:///private/file']) {
      expect(createExternalPrompt(event(url), 'https://site.test/', () => true, dependencies)).toBeNull()
    }
    expect(createExternalPrompt(event(undefined, false), undefined, () => true, dependencies)).toBeNull()
    expect(createExternalPrompt(event(), 'https://site.test/page', () => true, dependencies)).toMatchObject({ kind: 'external', origin: 'https://site.test' })
    expect(createExternalPrompt(event(), 'invalid', () => true, dependencies)?.origin).toBe('unknown origin')
    expect(runner.calls).toEqual([])
  })

  test('external prompt response preserves stale-lease, decline and platform guards', async () => {
    const runner = recording()
    const dependencies = { process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } } }
    let current = true
    const prompt = createExternalPrompt(event(), undefined, () => current, dependencies)!
    await prompt.respond({ accept: false })
    current = false
    await expect(prompt.respond({ accept: true })).rejects.toThrow('browser_tab_changed')
    current = true
    platform('linux')
    await expect(prompt.respond({ accept: true })).rejects.toThrow('browser_unavailable')
    expect(runner.calls).toEqual([])
  })

  test('external prompt acceptance resolves while open remains pending', async () => {
    const pending = Promise.withResolvers<RunResult>()
    const runner = recording(() => pending.promise)
    const logs: string[] = []
    try {
      const prompt = createExternalPrompt(event(), undefined, () => true, { process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } }, log: message => logs.push(message) })!
      await promptly(prompt.respond({ accept: true }))
      expect(runner.calls).toEqual([{ argv: ['open', 'mailto:alice@example.test?body=secret'], options: openOptions }])
      pending.resolve(result({ truncated: { stdout: true, stderr: true } }))
      await pending.promise
      await Promise.resolve()
      expect(logs).toEqual([])
    } finally { pending.resolve(result()) }
  })

  test('paneRespond requires the UI and acknowledges an external launch before open exits', async () => {
    const pending = Promise.withResolvers<RunResult>()
    const runner = recording(() => pending.promise)
    const rig = await paneRig(runner.process)
    const delivery = rig.panes as unknown as {
      watches: Map<string, unknown>
      receivePrompt(watch: unknown, prompt: RuntimePanePrompt): void
    }
    try {
      const prompt = createExternalPrompt(event(), 'https://site.test/', () => true, {
        process: { ...runner.process, spawn() { throw new Error('unexpected spawn') } }
      })!
      const watch = { paneId: rig.tab.id, watchId: 'fixture-watch' }
      delivery.watches.set(rig.tab.id, watch)
      delivery.receivePrompt(watch, prompt)
      await expect(rig.panes.call('paneRespond', { pane: rig.tab.id, prompt: prompt.id, accept: true }, cli)).rejects.toThrow('only be accepted by the browser UI')
      expect(runner.calls).toEqual([])
      expect(await promptly(rig.panes.call('paneRespond', { pane: rig.tab.id, prompt: prompt.id, accept: true }, ui))).toEqual({ responded: true })
      expect(runner.calls).toEqual([{ argv: ['open', 'mailto:alice@example.test?body=secret'], options: openOptions }])
      await expect(rig.panes.call('paneRespond', { pane: rig.tab.id, prompt: prompt.id, accept: true }, ui)).rejects.toThrow('browser_tab_changed')
    } finally {
      delivery.watches.clear()
      pending.resolve(result())
      await rig.cleanup()
    }
  })

  test('runtime event delivery uses the extracted prompt and declines stale Watch acceptance', async () => {
    const runner = recording()
    const rig = await paneRig(runner.process)
    try {
      const prompts: RuntimePanePrompt[] = []
      const runtime = rig.runtime as unknown as { emitExternalPrompt(watch: unknown, event: CdpEvent): void }
      const watch = { stopped: true, binding: { runtime: { mainFrameUrl: 'https://site.test/page' } }, callbacks: { onPrompt: (prompt: RuntimePanePrompt) => prompts.push(prompt) } }
      runtime.emitExternalPrompt(watch, event('https://site.test'))
      expect(prompts).toEqual([])
      runtime.emitExternalPrompt(watch, event())
      expect(prompts[0]).toMatchObject({ kind: 'external', origin: 'https://site.test' })
      await expect(prompts[0]!.respond({ accept: true })).rejects.toThrow('browser_tab_changed')
      expect(runner.calls).toEqual([])
    } finally { await rig.cleanup() }
  })

})

for (const crash of [false, true]) test(`runner-owned sleep ${crash ? 'crashes' : 'stops gracefully'} and unregisters`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-owned-sleep-'))
  const runner = createProcessRunner({ owner: 'quirky.browser.test' })
  try {
    const child = createBrowserSpawn(runner)(['/bin/sleep', '30'], { cwd: root, env: { ...process.env, QUIRKY_HOME: root } as Record<string, string>, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    expect(typeof child.pid).toBe('number')
    if (crash) await child.stop({ signal: 'SIGKILL' })
    else await stopOwned(child, 5_000)
    expect(await child.exited).toMatchObject(crash ? { signal: 'SIGKILL' } : { stopped: 'stop' })
    expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  } finally { await runner.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('browser requires the streaming process API', () => {
  expect(JSON.parse(readFileSync(join(import.meta.dir, '../quirky-plugin.json'), 'utf8')).apiVersion).toBe('1.11.0')
})
