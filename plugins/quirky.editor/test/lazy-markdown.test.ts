import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { PluginCaller } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { runProcess } from '../src/markdown/pdf'
import { createMarkdownMethods } from '../src/markdown/service'
import { createLazyMarkdownMethods } from '../src/markdown/lazy'
import type { EditorServices, FeatureMethods } from '../src/types'

const roots: string[] = []
const runners: OwnedProcessRunner[] = []
const originalQuirkyHome = process.env.QUIRKY_HOME
const MARKDOWN_METHOD_NAMES = ['markdown', 'markdownPreview', 'notes', 'workspaceNotes']
type MarkdownServiceModule = { createMarkdownMethods(host: EditorServices): FeatureMethods }
type MethodHandler = FeatureMethods['methods'][string]
type HostError = (kind: string, message: string) => Error

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-lazy-markdown-'))
  roots.push(root)
  return root
}

function editorHost(error: HostError = (_kind, message) => new Error(message)): EditorServices {
  return {
    context: { error },
    onClose: () => () => {}
  } as unknown as EditorServices
}

function handlerModule(handlers: Record<string, MethodHandler>, dispose: () => void = () => {}): MarkdownServiceModule {
  return { createMarkdownMethods: () => ({ methods: handlers, dispose }) }
}

function processFixture(root: string, scriptName: string, script: string, owner: string) {
  const scriptPath = join(root, scriptName)
  writeFileSync(scriptPath, script)
  const runner = createProcessRunner({ owner })
  runners.push(runner)
  return { scriptPath, runner }
}

afterEach(async () => {
  try {
    for (const runner of runners.splice(0)) await runner.dispose()
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    if (originalQuirkyHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = originalQuirkyHome
  }
})

describe('lazy Markdown service', () => {
  test('does not import Markdown dependencies when the editor main module is imported in a fresh process', async () => {
    const root = temporaryRoot()
    const resultPath = join(root, 'loaded-modules.json')
    const mainPath = resolve(import.meta.dir, '../main.ts')
    const fixture = processFixture(root, 'markdown-import-check.ts', `
import { writeFileSync } from 'node:fs'
// A static import would populate this process cache before the main-module boundary can be checked.
await import(${JSON.stringify(mainPath)})
const excluded = [
  '/quirky.editor/src/markdown/service',
  'isomorphic-dompurify',
  '/jsdom/',
  '/@tiptap/',
  '/react-markdown/'
]
const loaded = Object.keys(require.cache).filter((key) => excluded.some((part) => key.includes(part)))
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(loaded))
`, 'lazy-markdown-import-exclusion')
    const previousHome = process.env.QUIRKY_HOME
    process.env.QUIRKY_HOME = root
    try {
      const result = await runProcess(fixture.runner, process.execPath, ['run', fixture.scriptPath], {
        timeoutMs: 15_000,
        home: root
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = previousHome
    }
  })

  test('shares one load, forwards concurrent calls, and exposes the service method names', async () => {
    const host = editorHost()
    const caller = { pluginId: 'fixture' } as PluginCaller
    const params = { action: 'fixture', bufferId: 'buffer-1' }
    const loaded = Promise.withResolvers<MarkdownServiceModule>()
    const markdownResult = { method: 'markdown' }
    const notesResult = { method: 'notes' }
    const workspaceNotesResult = { method: 'workspaceNotes' }
    const forwarded: Array<{ name: string; params: Record<string, unknown>; caller: PluginCaller }> = []
    const loadCount: number[] = []
    const creations: EditorServices[] = []
    const makeHandler = (name: string, result: unknown): MethodHandler => async (receivedParams, receivedCaller) => {
      forwarded.push({ name, params: receivedParams, caller: receivedCaller })
      return result
    }
    const handlers = {
      markdown: makeHandler('markdown', markdownResult),
      markdownPreview: makeHandler('markdownPreview', { method: 'markdownPreview' }),
      notes: makeHandler('notes', notesResult),
      workspaceNotes: makeHandler('workspaceNotes', workspaceNotesResult)
    }
    const methods = createLazyMarkdownMethods(host, () => {
      loadCount.push(1)
      return loaded.promise
    })
    const serviceModule: MarkdownServiceModule = {
      createMarkdownMethods(receivedHost) {
        creations.push(receivedHost)
        return { methods: handlers, dispose() {} }
      }
    }

    const markdown = methods.methods.markdown(params, caller)
    const notes = methods.methods.notes(params, caller)
    expect(loadCount).toHaveLength(1)
    expect(creations).toHaveLength(0)
    loaded.resolve(serviceModule)
    await expect(Promise.all([markdown, notes])).resolves.toEqual([markdownResult, notesResult])
    expect(creations).toEqual([host])
    expect(creations[0]).toBe(host)
    expect(forwarded).toEqual([
      { name: 'markdown', params, caller },
      { name: 'notes', params, caller }
    ])
    expect(forwarded[0]!.params).toBe(params)
    expect(forwarded[0]!.caller).toBe(caller)

    await expect(methods.methods.workspaceNotes(params, caller)).resolves.toBe(workspaceNotesResult)
    expect(loadCount).toHaveLength(1)
    expect(creations).toHaveLength(1)
    expect(Object.keys(methods.methods)).toEqual(MARKDOWN_METHOD_NAMES)
    const realService = createMarkdownMethods(host)
    expect(Object.keys(methods.methods)).toEqual(Object.keys(realService.methods))
    realService.dispose()
    methods.dispose()
  })

  test('retries a rejected service load on the next Markdown call', async () => {
    const host = editorHost()
    const boom = new Error('boom')
    let loadCount = 0
    let creationCount = 0
    const methods = createLazyMarkdownMethods(host, async () => {
      loadCount += 1
      if (loadCount === 1) throw boom
      return {
        createMarkdownMethods: () => {
          creationCount += 1
          return { methods: { markdown: async () => 'loaded' }, dispose() {} }
        }
      }
    })

    await expect(methods.methods.markdown({}, {} as PluginCaller)).rejects.toBe(boom)
    await expect(methods.methods.markdown({}, {} as PluginCaller)).resolves.toBe('loaded')
    expect(loadCount).toBe(2)
    expect(creationCount).toBe(1)
    methods.dispose()
  })

  test('disposes the loaded service synchronously', async () => {
    let disposeCount = 0
    const methods = createLazyMarkdownMethods(editorHost(), async () => handlerModule({
      markdown: async () => 'loaded'
    }, () => { disposeCount += 1 }))

    await expect(methods.methods.markdown({}, {} as PluginCaller)).resolves.toBe('loaded')
    expect(disposeCount).toBe(0)
    methods.dispose()
    expect(disposeCount).toBe(1)
  })

  test('does not load an unused service and rejects calls made after disposal', async () => {
    const stopping = new Error('The editor is stopping.')
    const errors: Array<[string, string]> = []
    let loadCount = 0
    const methods = createLazyMarkdownMethods(editorHost((kind, message) => {
      errors.push([kind, message])
      return stopping
    }), async () => {
      loadCount += 1
      return handlerModule({ markdown: async () => 'unexpected' })
    })

    methods.dispose()
    await Promise.resolve()
    expect(loadCount).toBe(0)
    await expect(methods.methods.markdown({}, {} as PluginCaller)).rejects.toBe(stopping)
    expect(errors).toContainEqual(['conflict', 'The editor is stopping.'])
    expect(loadCount).toBe(0)
  })

  test('cancels an in-flight load before creating its service', async () => {
    const stopping = new Error('The editor is stopping.')
    const loaded = Promise.withResolvers<MarkdownServiceModule>()
    let loadCount = 0
    let creationCount = 0
    const methods = createLazyMarkdownMethods(editorHost(() => stopping), () => {
      loadCount += 1
      return loaded.promise
    })
    const pending = methods.methods.markdown({}, {} as PluginCaller)
    expect(loadCount).toBe(1)
    methods.dispose()
    loaded.resolve({
      createMarkdownMethods: () => {
        creationCount += 1
        return { methods: { markdown: async () => 'unexpected' }, dispose() {} }
      }
    })

    await expect(pending).rejects.toBe(stopping)
    expect(creationCount).toBe(0)
  })

  test('uses a new activation service after the plugin is reactivated in one process', async () => {
    const root = temporaryRoot()
    const resultPath = join(root, 'activation-services.json')
    const pluginRoot = resolve(import.meta.dir, '..')
    const fixture = processFixture(root, 'markdown-reactivation.fixture.ts', `
import { expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
const coreServices = []
const serviceHosts = []
let activation = 0
class FakeCore {
  constructor() {
    this.services = { activation: ++activation }
    coreServices.push(this.services)
  }
  methods = {}
  projectPublic(_name, value) { return value }
  async restore() {}
  async dispose() {}
}
mock.module(${JSON.stringify(join(pluginRoot, 'src/daemon/service.ts'))}, () => ({ EditorDaemon: FakeCore }))
mock.module(${JSON.stringify(join(pluginRoot, 'src/markdown/service.ts'))}, () => ({
  createMarkdownMethods(host) {
    serviceHosts.push(host)
    return { methods: { markdown: async () => host.activation }, dispose() {} }
  }
}))
mock.module(${JSON.stringify(join(pluginRoot, 'src/notebook/service.ts'))}, () => ({
  createNotebookMethods: () => ({ methods: {}, dispose() {} })
}))
mock.module(${JSON.stringify(join(pluginRoot, 'src/viewers/service.ts'))}, () => ({
  createViewerMethods: () => ({ methods: {}, dispose() {} })
}))
test('routes calls to the service made for each activation', async () => {
  // Dynamic import must follow the mocks to exercise lifecycle state in this isolated process.
  const main = await import(${JSON.stringify(join(pluginRoot, 'main.ts'))})
  const activate = () => {
    const handlers = new Map()
    return {
      handlers,
      context: {
        pluginId: 'quirky.editor',
        subscribe: () => () => {},
        provide: (name, handler) => handlers.set(name, handler)
      }
    }
  }
  const first = activate()
  await main.activate(first.context)
  expect(serviceHosts).toHaveLength(0)
  const firstHandler = first.handlers.get('method:quirky.editor/markdown')
  expect(await firstHandler({}, {})).toBe(1)
  expect(serviceHosts[0]).toBe(coreServices[0])
  await main.deactivate()

  const second = activate()
  await main.activate(second.context)
  expect(serviceHosts).toHaveLength(1)
  const secondHandler = second.handlers.get('method:quirky.editor/markdown')
  expect(await secondHandler({}, {})).toBe(2)
  expect(serviceHosts).toHaveLength(2)
  expect(serviceHosts[1]).toBe(coreServices[1])
  await main.deactivate()
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(serviceHosts.map((host) => host.activation)))
})
`, 'lazy-markdown-reactivation')
    const previousHome = process.env.QUIRKY_HOME
    process.env.QUIRKY_HOME = root
    try {
      const result = await runProcess(fixture.runner, process.execPath, ['test', fixture.scriptPath], {
        timeoutMs: 15_000,
        home: root
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual([1, 2])
    } finally {
      if (previousHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = previousHome
    }
  })
})
