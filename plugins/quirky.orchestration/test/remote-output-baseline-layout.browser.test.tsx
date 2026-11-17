import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { browserExecutable } from '../../../scripts/test-support/browser'

const ROOT = resolve(import.meta.dir, '../../..')
const MODULES = join(ROOT, 'plugins/quirky.orchestration/node_modules')
const BROWSER_IMPORTS: Record<string, string> = {
  react: join(MODULES, 'react/index.js'),
  'react/jsx-runtime': join(MODULES, 'react/jsx-runtime.js'),
  'react/jsx-dev-runtime': join(MODULES, 'react/jsx-dev-runtime.js'),
  'react-dom': join(MODULES, 'react-dom/index.js'),
  'react-dom/client': join(MODULES, 'react-dom/client.js'),
  '@quirky/ui': join(ROOT, 'packages/ui/src/design-system/index.ts')
}

type ResponsePlan =
  | { kind: 'value'; value: unknown }
  | { kind: 'reject'; message: string }
  | { kind: 'deferred'; id: string }
type WorkerReadCall = { method: string; params: Record<string, unknown> }
type BrowserFixture = {
  calls: WorkerReadCall[]
  setResponses(responses: ResponsePlan[]): void
  queueResponse(response: ResponsePlan): void
  resolve(id: string, value: unknown): void
  reject(id: string, message: string): void
  mount(dispatchId?: string): void
  unmount(): void
}
declare global {
  interface Window {
    __remoteOutputFixture: BrowserFixture
  }
}

const browserDependencyResolver: Bun.BunPlugin = {
  name: 'remote-output-browser-dependencies',
  setup(builder) {
    builder.onResolve(
      { filter: /^(?:react|react\/.*|react-dom|react-dom\/.*|@quirky\/ui)$/ },
      ({ path }) => ({ path: BROWSER_IMPORTS[path] ?? path })
    )
  }
}

let browser: Browser | null = null
let browserBundle = ''
let productionCss = ''
let temporaryHome = ''
let previousQuirkyHome: string | undefined

function browserEntry(): string {
  const uiModule = join(ROOT, 'plugins/quirky.orchestration/src/ui.tsx')
  return `
    import { activate } from ${JSON.stringify(uiModule)}

    const provided = new Map()
    const pending = new Map()
    const calls = []
    let responses = []
    let unmountView = null
    const nativeSetInterval = window.setInterval.bind(window)
    window.setInterval = (callback, delay, ...args) => delay === 2000 ? 0 : nativeSetInterval(callback, delay, ...args)

    const context = {
      pluginId: 'quirky.orchestration',
      provide(id, implementation) { provided.set(id, implementation) },
      async call(method, params = {}) {
        calls.push({ method, params })
        if (method !== 'quirky.orchestration/workerRead') throw new Error('Unexpected UI call: ' + method)
        const response = responses.shift()
        if (!response) throw new Error('No fake workerRead response was queued.')
        if (response.kind === 'reject') throw new Error(response.message)
        if (response.kind === 'deferred') {
          const deferred = Promise.withResolvers()
          pending.set(response.id, deferred)
          return deferred.promise
        }
        return response.value
      }
    }

    activate(context)
    window.__remoteOutputFixture = {
      calls,
      setResponses(next) { responses = [...next] },
      queueResponse(response) { responses.push(response) },
      resolve(id, value) {
        const request = pending.get(id)
        if (!request) throw new Error('No deferred workerRead response: ' + id)
        pending.delete(id)
        request.resolve(value)
      },
      reject(id, message) {
        const request = pending.get(id)
        if (!request) throw new Error('No deferred workerRead response: ' + id)
        pending.delete(id)
        request.reject(new Error(message))
      },
      mount(dispatchId = 'ctx_1') {
        const mount = provided.get('view:quirky.orchestration/remote-worker-output')
        if (typeof mount !== 'function') throw new Error('The remote output view was not provided.')
        unmountView = mount(document.getElementById('root'), { input: { dispatchId } })
      },
      unmount() {
        unmountView?.()
        unmountView = null
      }
    }
  `
}

async function expandStyleImports(url: URL, ancestors: Set<string> = new Set()): Promise<string> {
  if (ancestors.has(url.href)) throw new Error(`Cyclic production CSS import: ${url.href}`)
  const nextAncestors = new Set(ancestors).add(url.href)
  const source = await Bun.file(url).text()
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?\s*([^;]*);/g
  let result = ''
  let cursor = 0
  for (const match of source.matchAll(importPattern)) {
    const index = match.index
    result += source.slice(cursor, index)
    const importedUrl = new URL(match[2]!, url)
    const imported = importedUrl.protocol === 'file:'
      ? await expandStyleImports(importedUrl, nextAncestors)
      : match[0]
    const media = match[3]?.trim()
    result += media && importedUrl.protocol === 'file:' ? `@media ${media} {\n${imported}\n}` : imported
    cursor = index + match[0].length
  }
  return result + source.slice(cursor)
}

async function readProductionStyles(): Promise<string> {
  const shell = await expandStyleImports(new URL('../../../packages/ui/src/shell/chrome.css', import.meta.url))
  const app = await expandStyleImports(new URL('../../../packages/ui/src/styles.css', import.meta.url))
  return `${shell}\n${app}`
}

beforeAll(async () => {
  previousQuirkyHome = process.env.QUIRKY_HOME
  const executable = browserExecutable()
  temporaryHome = mkdtempSync(join(tmpdir(), 'quirky-orchestration-remote-output-'))
  process.env.QUIRKY_HOME = temporaryHome
  try {
    const entrypoint = join(temporaryHome, 'remote-output-browser-entry.ts')
    writeFileSync(entrypoint, browserEntry())
    const [result, styles] = await Promise.all([
      Bun.build({
        entrypoints: [entrypoint],
        target: 'browser',
        format: 'iife',
        plugins: [browserDependencyResolver],
        define: { 'process.env.NODE_ENV': '"production"' }
      }),
      readProductionStyles()
    ])
    if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'))
    const output = result.outputs[0]
    if (!output) throw new Error('The remote output browser bundle was empty.')
    browserBundle = await output.text()
    productionCss = styles
    browser = await chromium.launch({
      headless: true,
      executablePath: executable,
      args: process.platform === 'linux' ? ['--no-sandbox'] : []
    })
  } catch (error) {
    if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
    else process.env.QUIRKY_HOME = previousQuirkyHome
    rmSync(temporaryHome, { recursive: true, force: true })
    temporaryHome = ''
    throw error
  }
}, 60_000)

afterAll(async () => {
  await browser?.close()
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true })
}, 60_000)

async function createRemotePage(width = 1000): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport: { width, height: 900 } })
  const page = await context.newPage()
  await page.setContent('<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>')
  await page.addStyleTag({ content: productionCss })
  await page.addScriptTag({ content: browserBundle })
  return { context, page }
}

function remotePage(content: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dispatchId: 'ctx_1',
    sessionId: null,
    source: 'terminal',
    archived: false,
    sourceExact: true,
    fallbackReason: null,
    content,
    contentComplete: true,
    clipping: { clipped: false, maxBytes: 0 },
    nextCursor: null,
    terminalLiveness: 'live',
    agentLiveness: { status: 'live', reason: null },
    warnings: [],
    sourceIdentity: 'source-1',
    remote: { peerId: 'peer', bindingId: 'binding', hostDispatchId: 'ctx_host', hostIncarnation: 'incarnation-1' },
    ...overrides
  }
}

async function mountRemoteOutput(page: Page, initial: unknown, dispatchId = 'ctx_1'): Promise<void> {
  await page.evaluate(({ response, id }) => {
    window.__remoteOutputFixture.setResponses([{ kind: 'value', value: response }])
    window.__remoteOutputFixture.mount(id)
  }, { response: initial, id: dispatchId })
}

async function workerReadCalls(page: Page): Promise<WorkerReadCall[]> {
  return page.evaluate(() => window.__remoteOutputFixture.calls)
}

const outputFixture = `> prompt\n<b>text</b>\n${'x'.repeat(240)}`
const readParams = { dispatchId: 'ctx_1', source: 'auto', limit: 40 }

test('keeps remote output readout tokens, literal text, and wrapping at desktop and narrow widths in both themes', async () => {
  const { context, page } = await createRemotePage()
  try {
    await mountRemoteOutput(page, remotePage(outputFixture))
    await page.waitForFunction((text) => document.querySelector('pre.ui-readout')?.textContent === text, outputFixture)

    for (const theme of ['dark', 'light']) {
      await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), theme)
      for (const width of [1000, 320]) {
        await page.setViewportSize({ width, height: 900 })
        await page.waitForFunction(() => {
          const readout = document.querySelector('pre.ui-readout')
          return readout !== null && readout.clientWidth > 0
        })

        const metrics = await page.locator('pre.ui-readout').evaluate((element) => {
          const style = getComputedStyle(element)
          const token = (name: string, property: string) => {
            const probe = document.createElement('span')
            probe.style.setProperty(property, `var(${name})`)
            document.body.append(probe)
            const value = getComputedStyle(probe).getPropertyValue(property).trim()
            probe.remove()
            return value
          }
          const text = element.firstChild?.textContent ?? ''
          const range = document.createRange()
          range.setStart(element.firstChild!, text.length - 240)
          range.setEnd(element.firstChild!, text.length)
          return {
            text,
            html: element.innerHTML,
            children: element.childElementCount,
            inputs: document.querySelectorAll('input').length,
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
            borderStyles: [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle],
            borderColors: [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor],
            tokenBorder: token('--ui-border', 'border-color'),
            background: style.backgroundColor,
            tokenRail: token('--ui-rail', 'background-color'),
            foreground: style.color,
            tokenText: token('--ui-text', 'color'),
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            wrappedFragments: range.getClientRects().length,
            overflowWrap: style.overflowWrap,
            whiteSpace: style.whiteSpace,
            pseudoContent: [getComputedStyle(element, '::before').content, getComputedStyle(element, '::after').content]
          }
        })

        expect(metrics.text).toBe(outputFixture)
        expect(metrics.html).toContain('&lt;b&gt;text&lt;/b&gt;')
        expect(metrics.children).toBe(0)
        expect(metrics.inputs).toBe(0)
        expect(metrics.padding).toEqual(['8px', '8px', '8px', '8px'])
        expect(metrics.borderWidths).toEqual(['1px', '1px', '1px', '1px'])
        expect(metrics.borderStyles).toEqual(['solid', 'solid', 'solid', 'solid'])
        expect(metrics.borderColors).toEqual(Array(4).fill(metrics.tokenBorder))
        expect(metrics.background).toBe(metrics.tokenRail)
        expect(metrics.foreground).toBe(metrics.tokenText)
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth)
        expect(metrics.wrappedFragments).toBeGreaterThan(1)
        expect(metrics.overflowWrap).toBe('anywhere')
        expect(metrics.whiteSpace).toBe('pre-wrap')
        expect(metrics.pseudoContent).toEqual(['none', 'none'])
      }
    }
    expect(await workerReadCalls(page)).toEqual([{ method: 'quirky.orchestration/workerRead', params: readParams }])
  } finally {
    await context.close()
  }
}, 60_000)

test('keeps Refresh and Load older output reachable, bounded, and locked while their reads are pending', async () => {
  const firstPage = remotePage('newest output', { nextCursor: 'cursor-1' })
  const refreshedPage = remotePage('refreshed output', { nextCursor: 'cursor-1' })
  const olderPage = remotePage('older output', { nextCursor: 'cursor-2' })
  const { context, page } = await createRemotePage()
  try {
    await mountRemoteOutput(page, firstPage)
    await page.getByText('newest output', { exact: true }).waitFor()
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
    const older = page.getByRole('button', { name: 'Load older output', exact: true })
    await refresh.waitFor({ state: 'visible' })
    await older.waitFor({ state: 'visible' })
    expect(await refresh.isDisabled()).toBe(false)
    expect(await older.isDisabled()).toBe(false)
    expect(await workerReadCalls(page)).toEqual([{ method: 'quirky.orchestration/workerRead', params: readParams }])

    await page.evaluate(() => window.__remoteOutputFixture.queueResponse({ kind: 'deferred', id: 'refresh' }))
    await refresh.click()
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('button')]
      return buttons.find((button) => button.textContent?.trim() === 'Refresh')?.disabled === true
        && buttons.find((button) => button.textContent?.trim() === 'Load older output')?.disabled === true
    })
    expect(await workerReadCalls(page)).toEqual([
      { method: 'quirky.orchestration/workerRead', params: readParams },
      { method: 'quirky.orchestration/workerRead', params: readParams }
    ])
    await page.evaluate((response) => window.__remoteOutputFixture.resolve('refresh', response), refreshedPage)
    await page.waitForFunction((text) => document.querySelector('pre.ui-readout')?.textContent === text, 'refreshed output')
    await page.waitForFunction(() => [...document.querySelectorAll('button')].every((button) => !button.disabled))

    await page.evaluate(() => window.__remoteOutputFixture.queueResponse({ kind: 'deferred', id: 'older' }))
    await older.click()
    await page.getByText('Loading older output…', { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll('button')]
      return buttons.find((button) => button.textContent?.trim() === 'Refresh')?.disabled === true
        && buttons.find((button) => button.textContent?.trim() === 'Load older output')?.disabled === true
    })
    expect(await workerReadCalls(page)).toEqual([
      { method: 'quirky.orchestration/workerRead', params: readParams },
      { method: 'quirky.orchestration/workerRead', params: readParams },
      { method: 'quirky.orchestration/workerRead', params: { ...readParams, cursor: 'cursor-1' } }
    ])
    await page.evaluate((response) => window.__remoteOutputFixture.resolve('older', response), olderPage)
    await page.waitForFunction(() => {
      const texts = [...document.querySelectorAll('pre.ui-readout')].map((node) => node.textContent)
      return texts.length === 2 && texts[0] === 'refreshed output' && texts[1] === 'older output'
    })
    await page.waitForFunction(() => [...document.querySelectorAll('button')].every((button) => !button.disabled))
    expect(await page.getByText('Loading older output…', { exact: true }).count()).toBe(0)
  } finally {
    await context.close()
  }
}, 60_000)

const failureScenarios: { name: string; action: 'Refresh' | 'Load older output'; response: ResponsePlan; message: string }[] = [
  {
    name: 'a malformed refresh response',
    action: 'Refresh',
    response: { kind: 'value', value: { content: 'invalid response' } },
    message: 'The worker output response is not a remote output result.'
  },
  {
    name: 'a rejected older-page request',
    action: 'Load older output',
    response: { kind: 'reject', message: 'host offline' },
    message: 'host offline'
  },
  {
    name: 'an older page with a different source identity',
    action: 'Load older output',
    response: { kind: 'value', value: remotePage('untrusted older output', { sourceIdentity: 'source-2' }) },
    message: 'The pinned remote output source changed; refresh to restart reading.'
  }
]

for (const scenario of failureScenarios) {
  test(`keeps already-loaded text and shows the shared error after ${scenario.name}`, async () => {
    const initial = remotePage('already-loaded output', { nextCursor: 'cursor-1' })
    const { context, page } = await createRemotePage()
    try {
      await mountRemoteOutput(page, initial)
      await page.getByText('already-loaded output', { exact: true }).waitFor()
      await page.evaluate((response) => window.__remoteOutputFixture.queueResponse(response), scenario.response)
      await page.getByRole('button', { name: scenario.action, exact: true }).click()
      await page.waitForFunction((message) => {
        const error = document.querySelector('.ui-inline-error[role="alert"] .ui-inline-error__message')
        return error?.textContent === message
      }, scenario.message)

      expect(await page.locator('pre.ui-readout').allTextContents()).toEqual(['already-loaded output'])
      expect(await page.locator('.ui-inline-error[role="alert"] .ui-inline-error__message').textContent()).toBe(scenario.message)
      expect(await page.locator('.ui-error-text').count()).toBe(0)
      expect(await workerReadCalls(page)).toEqual([
        { method: 'quirky.orchestration/workerRead', params: readParams },
        {
          method: 'quirky.orchestration/workerRead',
          params: scenario.action === 'Refresh' ? readParams : { ...readParams, cursor: 'cursor-1' }
        }
      ])
    } finally {
      await context.close()
    }
  }, 60_000)
}
