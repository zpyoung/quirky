import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'

// happy-dom replaces the timers React's scheduler captured; keep the runtime's own
const TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const native = TIMERS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of native) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { activate } = await import('../src/ui')

const ITEM = 'status-bar:quirky.reviews/checks'
const CHECKS_PANEL = 'panel:quirky.reviews/checks'

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

type Check = { name: string; status: string; conclusion: string | null }
const check = ({ name, status, conclusion }: Check, id: number) => ({
  kind: 'check_run', name, status, conclusion, url: null, checkRunId: id, workflowRunId: null, suiteId: null
})

/** What `quirky.reviews/checksGet` returns for the active workspace's review. */
function checksState(checks: Check[] | null, number: number | null = 12) {
  return {
    checks: {
      worktree: 'wt_1',
      review: number === null ? null : { number },
      checks: checks === null ? null : {
        number: 12, headSha: 'a'.repeat(40), rollup: 'failure', partial: false, partialFailures: [], checks: checks.map((item, index) => check(item, index + 1))
      }
    }
  }
}

const SAMPLE: Check[] = [
  { name: 'bun test', status: 'in_progress', conclusion: null },
  { name: 'lint', status: 'completed', conclusion: 'success' },
  { name: 'typecheck', status: 'completed', conclusion: 'failure' },
  { name: 'build', status: 'completed', conclusion: 'success' }
]

function fakeContext(initial: unknown) {
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const layoutListeners = new Set<(layout: unknown) => void>()
  const fake = {
    layout: { view: null, panel: null, sidebar: true, focus: null, worktree: 'wt_1' } as Record<string, unknown>,
    setWorktree: (worktree: string) => {
      fake.layout = { ...fake.layout, worktree }
      for (const listener of [...layoutListeners]) listener(fake.layout)
    },
    result: initial as unknown,
    failing: false,
    calls: [] as string[],
    panels: [] as Array<[string, boolean | undefined]>,
    provided: new Map<string, (element: HTMLElement, props: Record<string, never>) => (() => void) | void>(),
    emit: (event: QuirkyEvent) => { for (const listener of [...listeners]) void listener(event) },
    context: {
      provide: (id: string, implementation: unknown) => void fake.provided.set(id, implementation as never),
      call: async (method: string) => {
        fake.calls.push(method)
        if (fake.failing) throw new Error('reviews are unavailable')
        return fake.result
      },
      subscribe: (listener: (event: QuirkyEvent) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onConnection: () => () => {},
      togglePanel: (id: string, open?: boolean) => void fake.panels.push([id, open]),
      getLayout: () => fake.layout,
      onLayout: (listener: (layout: unknown) => void) => {
        layoutListeners.add(listener)
        return () => layoutListeners.delete(listener)
      }
    }
  }
  return fake
}

async function mountItem(fake: ReturnType<typeof fakeContext>) {
  activate(fake.context as unknown as UiPluginContext)
  const mount = fake.provided.get(ITEM)
  if (!mount) throw new Error(`activate did not provide ${ITEM}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let cleanup: (() => void) | void
  await act(async () => {
    cleanup = mount(element, {})
  })
  await settle()
  return { element, unmount: () => act(async () => { cleanup?.() }) }
}

async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => {})
}

const popup = () => document.querySelector('.ui-popup')
const menuRows = () => [...document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')]

describe('quirky.reviews checks status bar item', () => {
  test('hides when the daemon holds another worktree\'s checks, and follows the selection', async () => {
    const fake = fakeContext(checksState(SAMPLE))
    const { element, unmount } = await mountItem(fake)
    expect(element.textContent).toContain('Checks 2/4')

    await act(async () => fake.setWorktree('wt_2'))
    await settle()
    expect(element.textContent).not.toContain('Checks')

    fake.result = { checks: { ...checksState(SAMPLE).checks, worktree: 'wt_2' } }
    await act(async () => fake.emit({ type: 'quirky.reviews/changed' } as unknown as QuirkyEvent))
    await settle()
    expect(element.textContent).toContain('Checks 2/4')
    await unmount()
  })

  test('the popup lists every check, however many there are', async () => {
    const many: Check[] = Array.from({ length: 45 }, (_, index) => ({ name: `check-${index}`, status: 'completed', conclusion: 'success' }))
    const fake = fakeContext(checksState(many))
    const { element, unmount } = await mountItem(fake)
    await act(async () => element.querySelector('button')!.click())
    await settle()
    const labels = menuRows().map((row) => row.textContent)
    expect(labels.filter((label) => label?.startsWith('check-'))).toHaveLength(45)
    expect(labels.some((label) => label?.includes('more'))).toBe(false)
    await unmount()
  })

  test('the manifest declares the item at order 20 and activate provides it', async () => {
    const manifest = await Bun.file(new URL('../quirky-plugin.json', import.meta.url)).json()
    expect(manifest.contributes['status-bar']).toEqual([{ id: 'checks', title: 'Checks', order: 20 }])
    const fake = fakeContext(checksState(SAMPLE))
    activate(fake.context as unknown as UiPluginContext)
    expect(fake.provided.has(ITEM)).toBe(true)
  })

  test('it shows the passing count and opens a titled list of each check ending with the Checks link', async () => {
    const fake = fakeContext(checksState(SAMPLE))
    const { element, unmount } = await mountItem(fake)

    const button = element.querySelector('button')!
    expect(button.textContent).toBe('Checks 2/4')
    expect(button.getAttribute('aria-haspopup')).toBe('menu')
    expect(fake.calls).toEqual(['quirky.reviews/checksGet'])

    await act(async () => button.click())
    await settle()
    expect(popup()?.querySelector('.ui-popup__title')?.textContent).toBe('Checks')
    const rows = menuRows().map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toBe('typecheckfailed')
    expect(rows[1]).toBe('bun testrunning')
    expect(rows.slice(2, 4).sort()).toEqual(['buildpassed', 'lintpassed'])
    expect(rows[4]).toBe('Open the Checks panel')

    await act(async () => menuRows()[4]!.click())
    expect(fake.panels).toEqual([[CHECKS_PANEL, true]])
    expect(popup()).toBeNull()
    await unmount()
  })

  test('it is hidden when there is no check data', async () => {
    for (const result of [checksState(null), checksState([]), checksState(SAMPLE, null), { checks: null }, 'unexpected']) {
      const fake = fakeContext(result)
      const { element, unmount } = await mountItem(fake)
      expect(element.textContent).toBe('')
      await unmount()
    }
    const failing = fakeContext(checksState(SAMPLE))
    failing.failing = true
    const { element, unmount } = await mountItem(failing)
    expect(element.textContent).toBe('')
    await unmount()
  })

  test('it reads again when reviews change and hides once the data goes away', async () => {
    const fake = fakeContext(checksState([{ name: 'lint', status: 'completed', conclusion: 'success' }]))
    const { element, unmount } = await mountItem(fake)
    expect(element.textContent).toBe('Checks 1/1')

    fake.result = checksState(SAMPLE)
    await act(async () => fake.emit({ type: 'quirky.reviews/changed', data: { revision: 2 } }))
    await settle()
    expect(element.textContent).toBe('Checks 2/4')

    fake.result = checksState(null)
    await act(async () => fake.emit({ type: 'quirky.reviews/changed', data: { revision: 3 } }))
    await settle()
    expect(element.textContent).toBe('')
    await unmount()
  })
})
