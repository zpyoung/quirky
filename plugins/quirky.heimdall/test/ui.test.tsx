import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { FleetSnapshot } from '../src/control-contracts'

type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
type DetailReply = (params: Record<string, unknown>) => unknown | Promise<unknown>
type FakeContext = {
  context: UiPluginContext
  failRefresh(): void
  provided: Map<string, unknown>
  closeViewCalls(): number
}

const FLEET_VIEW_ID = 'view:quirky.heimdall/fleet'
const FLEET_METHOD = 'quirky.heimdall/fleet'
const DETAIL_METHOD = 'quirky.heimdall/detail'
const snapshot = {
  generatedAtMs: 1,
  rows: [],
  actionHistory: [],
  buckets: { needsYou: 0, lostContact: 0, active: 0, inactive: 0 },
  activeCount: 0,
  attentionCount: 0
} satisfies FleetSnapshot

const mountedDisposers: (() => void)[] = []
let activate: (context: UiPluginContext) => void
let previousActEnvironment: unknown
let hadActEnvironment = false

function makeContext(detailReply: DetailReply = () => null): FakeContext {
  const provided = new Map<string, unknown>()
  let closeViewCalls = 0
  let fleetReads = 0
  let refreshFails = false
  const context = {
    pluginId: 'quirky.heimdall',
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      if (method === FLEET_METHOD) {
        if (++fleetReads > 1 && refreshFails) throw new Error('fleet offline')
        return snapshot
      }
      if (method === DETAIL_METHOD) return detailReply(params)
      throw new Error(`Unexpected RPC method: ${method}`)
    },
    subscribe(_listener: (event: QuirkyEvent) => void | Promise<void>) { return () => {} },
    onConnection(_listener: (status: string) => void) { return () => {} },
    closeView() { closeViewCalls += 1 }
  } as unknown as UiPluginContext

  return {
    context,
    failRefresh() { refreshFails = true },
    provided,
    closeViewCalls: () => closeViewCalls
  }
}

async function settleUi(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    window.setTimeout(resolve, 0)
    await promise
  })
}

async function mountFleet(fake: FakeContext, input?: unknown): Promise<HTMLElement> {
  activate(fake.context)
  const implementation = fake.provided.get(FLEET_VIEW_ID)
  if (typeof implementation !== 'function') throw new Error(`Missing contribution ${FLEET_VIEW_ID}`)

  const element = document.createElement('div')
  document.body.append(element)
  await act(async () => {
    const dispose = (implementation as Mount)(element, { input })
    if (typeof dispose === 'function') mountedDisposers.push(dispose)
  })
  await settleUi()
  return element
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('button')].find((entry) =>
    (entry.getAttribute('aria-label') ?? entry.textContent?.trim()) === label
  )
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
}

function expectNoBackAffordance(root: ParentNode): void {
  const labels = [...root.querySelectorAll('button')].map((entry) => entry.getAttribute('aria-label') ?? entry.textContent?.trim())
  expect(labels).not.toContain('Back')
  expect(labels).not.toContain('Back to fleet')
}

async function click(root: ParentNode, label: string): Promise<void> {
  await act(async () => { button(root, label).click() })
  await settleUi()
}

async function pressEscape(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settleUi()
}

beforeAll(async () => {
  GlobalRegistrator.register()
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  hadActEnvironment = Object.prototype.hasOwnProperty.call(reactGlobal, 'IS_REACT_ACT_ENVIRONMENT')
  previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM binds its scheduler to the DOM globals available at import.
  ;({ activate } = await import('../src/ui'))
})

afterEach(async () => {
  await act(async () => {
    for (const dispose of mountedDisposers.splice(0)) dispose()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  })
  document.body.innerHTML = ''
})

afterAll(async () => {
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  if (hadActEnvironment) reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment as boolean
  else delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

test.skipIf(!existsSync(chromium.executablePath()))('keeps the complete fleet summary inside a narrow panel', async () => {
  const root = await mountFleet(makeContext())
  const browser = await chromium.launch({ headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] })
  try {
    const page = await browser.newPage({ viewport: { width: 646, height: 900 } })
    await page.setContent(`<style>* { box-sizing: border-box } body { margin: 0 }</style><div id="panel" style="width:116px">${root.innerHTML}</div>`)
    for (const name of ['compatibility-tokens', 'tokens', 'components']) {
      await page.addStyleTag({ content: readFileSync(resolve(import.meta.dir, `../../../packages/ui/src/design-system/${name}.css`), 'utf8') })
    }
    for (const width of [116, 200, 320]) {
      await page.locator('#panel').evaluate((element, width) => { (element as HTMLElement).style.width = `${width}px` }, width)
      const summary = await page.locator('.ui-badge').evaluate((element) => {
        const panel = document.querySelector('#panel')!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(element)
        return {
          panel: { left: panel.left, right: panel.right },
          lines: [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right })),
          text: element.textContent,
        }
      })
      expect(summary.text).toContain('0 active')
      expect(summary.text).toContain('0 need attention')
      for (const line of summary.lines) {
        expect(line.left).toBeGreaterThanOrEqual(summary.panel.left)
        expect(line.right).toBeLessThanOrEqual(summary.panel.right)
      }
    }
  } finally {
    await browser.close()
  }
}, 60_000)

describe('Heimdall fleet navigation', () => {
  test('keeps the fleet open without Back controls and retains its snapshot on refresh failure', async () => {
    const fake = makeContext()
    const root = await mountFleet(fake)

    expect(root.textContent).toContain('No watchers in the fleet.')
    expectNoBackAffordance(document.body)
    expect(fake.closeViewCalls()).toBe(0)
    fake.failRefresh()

    await click(document.body, 'Refresh fleet')

    expect(root.querySelector('[role="alert"]')?.textContent).toContain('fleet offline')
    expect(root.textContent).toContain('No watchers in the fleet.')
    expectNoBackAffordance(document.body)
    expect(fake.closeViewCalls()).toBe(0)
  })

  test('returns from a missing initial watcher to the fleet without closing the view', async () => {
    const fake = makeContext(() => null)
    const root = await mountFleet(fake, { watcherId: 'unavailable-watcher' })

    expect(root.textContent).toContain('This watcher is no longer available in the fleet.')

    await click(document.body, 'Back to fleet')

    expect(root.textContent).toContain('Watcher fleet')
    expect(root.textContent).toContain('No watchers in the fleet.')
    expectNoBackAffordance(document.body)
    expect(fake.closeViewCalls()).toBe(0)
  })

  test('Escape returns from a failed initial detail to the fleet, then closes from the fleet', async () => {
    const fake = makeContext(() => { throw new Error('detail unavailable') })
    const root = await mountFleet(fake, { watcherId: 'unavailable-watcher' })

    expect(root.textContent).toContain('detail unavailable')

    await pressEscape()

    expect(root.textContent).toContain('Watcher fleet')
    expect(root.textContent).toContain('No watchers in the fleet.')
    expect(fake.closeViewCalls()).toBe(0)

    await pressEscape()

    expect(fake.closeViewCalls()).toBe(1)
  })
})
