import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement, type ReactNode } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
import bundleSize from './fixtures/bundle-size.json'
import { CATALOG_TYPES, COMPONENTS, type ViewSpec } from '../src/core/catalog'
import { fakeContext, mountView, record, settle, type FakeContext } from './ui-fake'
import { createViewUiController } from '../src/control'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type { ViewsPane as ViewsPaneComponent } from '../src/Pane'
import type { ViewCardView as ViewCardViewComponent } from '../src/render/ViewCard'

const RENDER = 'view:quirky.view/render'
const PANE = 'view:quirky.view/pane'

let activate: (context: UiPluginContext) => void
let createRoot: typeof CreateRoot
let ViewsPane: typeof ViewsPaneComponent
let ViewCardView: typeof ViewCardViewComponent
const MOVE = 'command:quirky.view/move'
const ACTION = 'command:quirky.view/action'
const CONTROL = 'command:quirky.view/control'

const mounted: Awaited<ReturnType<typeof mountView>>[] = []
async function mountDirect(node: ReactNode) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const root = createRoot(element)
  await act(async () => root.render(node))
  await settle()
  const view = {
    element,
    click: (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))),
    unmount: () => act(async () => void root.unmount())
  }
  mounted.push(view)
  return {
    ...view,
    render: async (next: ReactNode) => {
      await act(async () => root.render(next))
      await settle()
    }
  }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // react-dom must detect the registered DOM before initializing its input events
  activate = ((await import('../src/ui')) as { activate: typeof activate }).activate
  createRoot = (await import('react-dom/client')).createRoot
  ViewsPane = (await import('../src/Pane')).ViewsPane
  ViewCardView = (await import('../src/render/ViewCard')).ViewCardView
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  for (const view of mounted.splice(0)) await view.unmount()
  document.body.innerHTML = ''
})

const markdownSpec = (text: string): ViewSpec => ({ title: 'Notes', root: { type: 'markdown', props: { text } } })

function start(records: ReturnType<typeof record>[], extra: Record<string, (params: Record<string, unknown>) => unknown> = {}): FakeContext {
  const fake = fakeContext({
    'quirky.view/get': (params) => records.find((candidate) => candidate.viewId === params.viewId),
    'quirky.view/list': (params) => records.filter((candidate) => candidate.sessionId === params.session),
    'quirky.session/get': () => ({ id: 's1', agent: 'omp' }),
    'quirky.view/action': () => ({ delivered: 'message' }),
    'quirky.view/move': () => ({}),
    'quirky.terminal/openExternal': () => ({ ok: true }),
    ...extra
  })
  activate(fake.context)
  return fake
}

async function mountCard(fake: FakeContext, viewId = 'view_1', report?: (state: unknown) => void) {
  const view = await mountView(fake, RENDER, { viewId }, report)
  mounted.push(view)
  return view
}

type InstanceState = { instance: string; surface: string; viewId?: string; session?: string; activeViewId: string | null; phase: string; tabs: { viewId: string; title: string }[]; pendingLink: string | null }

async function instances(fake: FakeContext): Promise<InstanceState[]> {
  const result = await fake.runCommand(CONTROL, { action: 'state' }) as { instances: InstanceState[] }
  return result.instances
}

async function instanceFor(fake: FakeContext, surface: string, match: (state: InstanceState) => boolean = () => true): Promise<string> {
  const state = (await instances(fake)).find((candidate) => candidate.surface === surface && match(candidate))
  if (!state) throw new Error(`no mounted instance for ${surface}`)
  return state.instance
}

const text = (root: Element) => root.textContent ?? ''
const buttonLabelled = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === label) as HTMLButtonElement
const routedArgs = (fake: FakeContext, id: string) => fake.routedTo(id).map((call) => call.args)

describe('the view card', () => {
  test('renders the bundle-size fixture: stats, chart, table and buttons', async () => {
    const fake = start([record(bundleSize as ViewSpec)])
    const { element } = await mountCard(fake)

    expect(text(element)).toContain('Bundle size by route')
    expect(text(element)).toContain('by omp')
    expect(text(element)).toContain('Total (gzip)')
    expect(text(element)).toContain('412 KB')
    expect(text(element)).toContain('+38 KB')
    expect(element.querySelectorAll('[data-view-node="stat"]')).toHaveLength(3)

    const chart = element.querySelector('[data-view-node="bar-chart"] [role="img"]')!
    expect(chart.getAttribute('aria-label')).toContain('/settings 96 KB')
    expect(chart.querySelector('svg')).not.toBeNull()
    expect(text(element)).toContain('/dashboard')

    const headers = [...element.querySelectorAll('table th')].map((cell) => cell.textContent)
    expect(headers).toEqual(['New in /settings', 'Size', 'Added'])
    expect(element.querySelectorAll('table tbody tr')).toHaveLength(3)

    expect(buttonLabelled(element, 'Lazy-load zxcvbn')).toBeTruthy()
    expect(buttonLabelled(element, 'Replace date-fns-tz')).toBeTruthy()
    expect(buttonLabelled(element, 'Move to pane')).toBeTruthy()
  })

  test.each(CATALOG_TYPES.map((type) => [type]))('renders a %s', async (type) => {
    const fake = start([record({ title: `A ${type}`, root: COMPONENTS[type].example })])
    const { element } = await mountCard(fake)
    expect(element.querySelector(`[data-view-node="${type}"]`)).not.toBeNull()
  })

  test('renders every tone and state the catalog allows', async () => {
    const root = {
      type: 'stack' as const,
      children: [
        { type: 'stat' as const, props: { label: 'A', value: '1', delta: '+1', tone: 'good' } },
        { type: 'stat' as const, props: { label: 'B', value: '2', tone: 'warn' } },
        { type: 'callout' as const, props: { tone: 'info', text: 'info text' } },
        { type: 'callout' as const, props: { tone: 'bad', text: 'bad text' } },
        { type: 'status-list' as const, props: { items: [{ label: 'Build', state: 'ok' }, { label: 'Lint', state: 'warn', detail: '3 warnings' }, { label: 'Deploy', state: 'bad' }, { label: 'Docs', state: 'pending' }] } },
        { type: 'steps' as const, props: { items: [{ text: 'One', state: 'done' }, { text: 'Two', state: 'active' }, { text: 'Three', state: 'pending' }, { text: 'Four', state: 'failed' }] } },
        { type: 'kv' as const, props: { items: [{ key: 'Branch', value: 'main' }] } },
        { type: 'code' as const, props: { text: 'const a = 1\nconst b = 2', language: 'ts' } },
        { type: 'file-diff' as const, props: { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' } },
        { type: 'line-chart' as const, props: { points: [{ x: 'Mon', y: 3 }, { x: 'Tue', y: 5 }, { x: 4, y: 1 }], unit: 'ms' } },
        { type: 'columns' as const, children: [{ type: 'markdown' as const, props: { text: 'left' } }, { type: 'markdown' as const, props: { text: 'right' } }] },
        { type: 'section' as const, props: { title: 'Details' }, children: [{ type: 'markdown' as const, props: { text: 'inside' } }] }
      ]
    }
    const fake = start([record({ title: 'All', root })])
    const { element } = await mountCard(fake)

    expect(text(element)).toContain('3 warnings')
    expect(text(element)).toContain('bad text')
    expect(text(element)).toContain('Four')
    expect(element.querySelector('[data-view-node="steps"]')!.textContent).toContain('failed')
    expect(element.querySelector('[data-view-node="code"] code')!.textContent).toBe('const a = 1\nconst b = 2')
    expect(element.querySelector('[data-view-node="file-diff"]')!.textContent).toContain('src/a.ts')
    expect(element.querySelector('[data-view-node="line-chart"] [role="img"]')!.getAttribute('aria-label')).toContain('Mon 3 ms')
    expect(element.querySelector('[data-view-node="line-chart"] svg polyline')).not.toBeNull()
    expect(text(element)).toContain('Details')
  })

  test('a button click sends the action named by the button, from the button', async () => {
    const fake = start([record(bundleSize as ViewSpec)])
    const { element, click } = await mountCard(fake)

    await click(buttonLabelled(element, 'Lazy-load zxcvbn'))

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
      { viewId: 'view_1', name: 'lazy-load-zxcvbn', source: 'button' }
    ])
    expect(routedArgs(fake, ACTION)).toEqual([{ viewId: 'view_1', name: 'lazy-load-zxcvbn', source: 'button' }])
  })

  test('a failed action tells the person instead of failing silently', async () => {
    const fake = start([record(bundleSize as ViewSpec)], {
      'quirky.view/action': () => {
        throw new Error('the agent did not take the action: agent-busy')
      }
    })
    const { element, click } = await mountCard(fake)

    await click(buttonLabelled(element, 'Lazy-load zxcvbn'))

    expect(fake.toasts).toEqual([{ title: 'Could not send the action', body: 'the agent did not take the action: agent-busy' }])
  })

  test('a field sends its answer as an action named after the question id', async () => {
    const select = COMPONENTS.field.example
    const fake = start([record({ title: 'Ask', root: { type: 'stack', children: [select] } })])
    const { element, click } = await mountCard(fake)

    await click(buttonLabelled(element, 'Lazy-load'))
    expect(routedArgs(fake, ACTION)).toEqual([])
    await click(buttonLabelled(element, 'Send'))

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
      { viewId: 'view_1', name: 'next-step', source: 'field', data: { value: 'lazy' } }
    ])
    expect(routedArgs(fake, ACTION)).toEqual([{ viewId: 'view_1', name: 'next-step', source: 'field', data: { value: 'lazy' } }])
  })

  test('field form submission uses the same action command with its typed answer', async () => {
    const fake = start([record({ title: 'Ask', root: { type: 'field', props: { question: { id: 'answer', type: 'text', question: 'Answer?' } } } as never })])
    const { element } = await mountCard(fake)
    const input = element.querySelector<HTMLInputElement>('input')!

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'ready')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(routedArgs(fake, ACTION)).toEqual([])
    await act(async () => void element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await settle()

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
      { viewId: 'view_1', name: 'answer', source: 'field', data: { value: 'ready' } }
    ])
    expect(routedArgs(fake, ACTION)).toEqual([{ viewId: 'view_1', name: 'answer', source: 'field', data: { value: 'ready' } }])
  })

  test('text, number and confirm fields send a string, a number and a boolean', async () => {
    const root = {
      type: 'stack' as const,
      children: [
        { type: 'field' as const, props: { question: { id: 'note', type: 'text', question: 'Any note?' } } },
        { type: 'field' as const, props: { question: { id: 'count', type: 'number', question: 'How many?' } } },
        { type: 'field' as const, props: { question: { id: 'go', type: 'confirm', question: 'Go ahead?' } } }
      ]
    }
    const fake = start([record({ title: 'Ask', root })])
    const { element, click } = await mountCard(fake)

    const input = (label: string) => element.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    const type = async (target: HTMLInputElement, value: string) =>
      act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(target, value)
        target.dispatchEvent(new Event('input', { bubbles: true }))
      })
    await type(input('Any note?'), 'ship it')
    await type(input('How many?'), '3')
    await click(buttonLabelled(element, 'Yes'))
    expect(routedArgs(fake, ACTION)).toEqual([])
    const sends = [...element.querySelectorAll('button')].filter((button) => button.textContent === 'Send')
    for (const send of sends) await click(send)

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
      { viewId: 'view_1', name: 'note', source: 'field', data: { value: 'ship it' } },
      { viewId: 'view_1', name: 'count', source: 'field', data: { value: 3 } },
      { viewId: 'view_1', name: 'go', source: 'field', data: { value: true } }
    ])
    expect(routedArgs(fake, ACTION)).toEqual([
      { viewId: 'view_1', name: 'note', source: 'field', data: { value: 'ship it' } },
      { viewId: 'view_1', name: 'count', source: 'field', data: { value: 3 } },
      { viewId: 'view_1', name: 'go', source: 'field', data: { value: true } }
    ])
  })

  test('shows "updated N times" with the time once the view has been updated, and refreshes on change', async () => {
    const records = [record(bundleSize as ViewSpec)]
    const fake = start(records)
    const { element } = await mountCard(fake)
    expect(text(element)).not.toContain('updated')

    const updatedAt = '2026-11-16T10:30:00.000Z'
    records[0] = record({ ...(bundleSize as ViewSpec), title: 'Bundle size, rebuilt' }, { updates: 2, updatedAt })
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()

    const clock = new Date(updatedAt)
    const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
    expect(text(element)).toContain('Bundle size, rebuilt')
    expect(text(element)).toContain(`updated 2 times · ${hhmm}`)
  })

  test('a change to another view does not reload this one', async () => {
    const fake = start([record(bundleSize as ViewSpec)])
    await mountCard(fake)
    const before = fake.callsTo('quirky.view/get').length

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_other' } })
    await settle()

    expect(fake.callsTo('quirky.view/get')).toHaveLength(before)
  })

  test('says "updated 1 time" in the singular', async () => {
    const fake = start([record(bundleSize as ViewSpec, { updates: 1 })])
    const { element } = await mountCard(fake)
    expect(text(element)).toMatch(/updated 1 time · \d\d:\d\d/)
  })

  test('a closed view shows a one-line record instead of its content', async () => {
    const fake = start([record(bundleSize as ViewSpec, { closed: true })])
    const { element } = await mountCard(fake)
    expect(text(element)).toContain('Bundle size by route')
    expect(text(element)).toContain('closed')
    expect(element.querySelector('[data-view-node]')).toBeNull()
  })

  test('a pane view shows a one-line record in the transcript, not its content', async () => {
    const fake = start([record(markdownSpec('PANE ONLY CONTENT'), { placement: 'pane' })])
    const { element, click } = await mountCard(fake)
    expect(text(element)).toContain('Notes is in the Views pane')
    expect(text(element)).not.toContain('PANE ONLY CONTENT')
    expect(element.querySelector('[data-view-node]')).toBeNull()
    await click(buttonLabelled(element, 'Move inline'))
    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
  })

  test('the transcript follows the placement when the view moves inline', async () => {
    const records = [record(markdownSpec('PANE ONLY CONTENT'), { placement: 'pane' })]
    const fake = start(records)
    const { element } = await mountCard(fake)
    records[0] = { ...records[0]!, placement: 'inline' }
    await fake.emit({ type: 'quirky.view/changed', data: { viewId: 'view_1', sessionId: 's1' } })
    expect(text(element)).toContain('PANE ONLY CONTENT')
  })

  test('a text field rejects a value that breaks its pattern or format and sends a valid one', async () => {
    const question = { id: 'email', type: 'text', question: 'Email?', pattern: '^[^ ]+@example\\.com$', format: 'email' }
    const fake = start([record({ title: 'Ask', root: { type: 'field', props: { question } } as never })])
    const { element, click } = await mountCard(fake)
    const input = element.querySelector('input') as HTMLInputElement
    const type = (target: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
        target.dispatchEvent(new Event('input', { bubbles: true }))
      })

    await type(input, 'not an email')
    expect(element.querySelector('[role="alert"]')).not.toBeNull()
    expect(buttonLabelled(element, 'Send').disabled).toBe(true)
    await click(buttonLabelled(element, 'Send'))
    expect(fake.callsTo('quirky.view/action')).toEqual([])

    await type(input, 'a@example.com')
    expect(element.querySelector('[role="alert"]')).toBeNull()
    await click(buttonLabelled(element, 'Send'))
    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([{ viewId: 'view_1', name: 'email', source: 'field', data: { value: 'a@example.com' } }])
  })

  test('renders nothing for an input without a view ID', async () => {
    const fake = start([])
    const view = await mountView(fake, RENDER, {})
    mounted.push(view)
    expect(view.element.innerHTML).toBe('')
  })
})

describe('markdown', () => {
  const rendered = async (markdown: string) => {
    const fake = start([record(markdownSpec(markdown))])
    return { fake, ...(await mountCard(fake)) }
  }

  test('renders formatted text and tables', async () => {
    const { element } = await rendered('# Title\n\nSome **bold** and `code`.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
    expect(element.querySelector('h1')!.textContent).toBe('Title')
    expect(element.querySelector('strong')!.textContent).toBe('bold')
    expect(element.querySelector('code')!.textContent).toBe('code')
    expect(element.querySelectorAll('table td')).toHaveLength(2)
  })

  test('strips scripts, images, raw HTML and attributes', async () => {
    const { element } = await rendered(
      ['<script>window.pwned = 1</script>', '', '![tracker](https://example.com/t.png)', '', '<img src="https://example.com/x.png" onerror="alert(1)">', '', '<div style="color:red" onclick="alert(1)">raw</div>', '', 'plain text'].join('\n')
    )
    expect(element.querySelector('script')).toBeNull()
    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('[onclick]')).toBeNull()
    expect(element.querySelector('[onerror]')).toBeNull()
    expect(text(element)).toContain('plain text')
    expect(text(element)).not.toContain('pwned')
  })

  test('keeps only http and https links', async () => {
    const { element } = await rendered(
      ['[web](https://example.com/a)', '[plain](http://example.com/b)', '[script](javascript:alert(1))', '[mail](mailto:a@example.com)', '[relative](/etc/passwd)', '[scheme-relative](//evil.example.com)', '[data](data:text/html,hi)'].join('\n\n')
    )
    const hrefs = [...element.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'))
    expect(hrefs).toEqual(['https://example.com/a', 'http://example.com/b'])
    for (const label of ['script', 'mail', 'relative', 'scheme-relative', 'data']) expect(text(element)).toContain(label)
  })

  test('a link click asks first and opens it only on confirm through control commands', async () => {
    const { element, click, fake } = await rendered('[docs](https://example.com/docs)')
    const instance = await instanceFor(fake, RENDER)
    const link = element.querySelector('a')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => void link.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('https://example.com/docs')
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
    expect(routedArgs(fake, CONTROL)).toEqual([{ instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.com/docs' }])

    await expect(fake.runCommand(CONTROL, { instance, action: 'link-confirm', viewId: 'other-view' })).rejects.toThrow()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
    await click(buttonLabelled(dialog, 'Open link'))
    expect(fake.callsTo('quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: 'https://example.com/docs' }])
    expect(routedArgs(fake, CONTROL)).toEqual([
      { instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.com/docs' },
      { instance, action: 'link-confirm', viewId: 'view_1' }
    ])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  test('cancelling the link dialog routes cancellation and opens nothing', async () => {
    const { element, click, fake } = await rendered('[docs](https://example.com/docs)')
    const instance = await instanceFor(fake, RENDER)
    await click(element.querySelector('a')!)
    await click(buttonLabelled(document.querySelector('[role="dialog"]')!, 'Cancel'))

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
    expect(routedArgs(fake, CONTROL)).toEqual([
      { instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.com/docs' },
      { instance, action: 'link-cancel', viewId: 'view_1' }
    ])
  })

  test('Escape and backdrop dismiss the link through the cancel control without opening it', async () => {
    const { element, click, fake } = await rendered('[docs](https://example.com/docs)')
    const instance = await instanceFor(fake, RENDER)

    await click(element.querySelector('a')!)
    await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await click(element.querySelector('a')!)
    await click(document.querySelector('.ui-dialog-backdrop')!)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
    expect(routedArgs(fake, CONTROL)).toEqual([
      { instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.com/docs' },
      { instance, action: 'link-cancel', viewId: 'view_1' },
      { instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.com/docs' },
      { instance, action: 'link-cancel', viewId: 'view_1' }
    ])
  })

  test('clears a pending link when its spec changes or its mount unmounts', async () => {
    const records = [record(markdownSpec('[docs](https://example.test/docs)'))]
    const fake = start(records)
    const view = await mountCard(fake)
    const instance = await instanceFor(fake, RENDER)
    await view.click(view.element.querySelector('a')!)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    records[0] = record(markdownSpec('updated spec'), { updatedAt: '2026-11-16T11:00:00.000Z' })
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect((await instances(fake))[0]!.pendingLink).toBeNull()

    await fake.runCommand(CONTROL, { instance, action: 'link-preview', viewId: 'view_1', href: 'https://example.test/docs' })
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    await view.unmount()
    mounted.splice(mounted.indexOf(view), 1)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await expect(fake.runCommand(CONTROL, { instance, action: 'link-confirm', viewId: 'view_1' })).rejects.toThrow('View UI instance is no longer mounted.')
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })
})

describe('the views pane', () => {
  const paneView = (viewId: string, title: string, over: Partial<ReturnType<typeof record>> = {}) =>
    record(markdownSpec(`${title} body`), { viewId, title, placement: 'pane', ...over })

  const mountPane = async (fake: FakeContext, report?: (state: unknown) => void) => {
    const view = await mountView(fake, PANE, { session: 's1' }, report)
    mounted.push(view)
    return view
  }

  test('shows a tab for each pane view and the first view open', async () => {
    const fake = start([paneView('view_1', 'Bundle size'), paneView('view_2', 'Module map'), record(markdownSpec('inline body'), { viewId: 'view_3', title: 'Inline one' })])
    const { element } = await mountPane(fake)

    const tabs = [...element.querySelectorAll('[role="tab"]')]
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Bundle size', 'Module map'])
    expect(text(element)).toContain('Bundle size body')
    expect(text(element)).not.toContain('Module map body')
    expect(text(element)).not.toContain('inline body')
  })

  test('selecting a tab shows that view', async () => {
    const fake = start([paneView('view_1', 'Bundle size'), paneView('view_2', 'Module map')])
    const { element, click } = await mountPane(fake)

    await click(element.querySelectorAll('[role="tab"]')[1])

    expect(text(element)).toContain('Module map body')
    expect(text(element)).not.toContain('Bundle size body')
    const instance = await instanceFor(fake, PANE)
    expect(routedArgs(fake, CONTROL)).toEqual([{ instance, action: 'select-tab', viewId: 'view_2' }])
  })
  test('control state discovers embedded mounts and isolates duplicate pane instances through cleanup', async () => {
    const fake = start([paneView('view_1', 'Bundle size'), paneView('view_2', 'Module map')])
    await mountCard(fake, 'view_1')
    const reports: unknown[] = []
    const first = await mountPane(fake, (state) => reports.push(state))
    const second = await mountPane(fake)

    const callCount = fake.calls.length
    const state = await instances(fake)
    expect(fake.calls).toHaveLength(callCount)
    expect(state).toHaveLength(3)
    expect(new Set(state.map((view) => view.instance)).size).toBe(3)

    const cardState = state.find((view) => view.surface === RENDER)!
    expect(cardState).toMatchObject({ viewId: 'view_1', activeViewId: 'view_1', phase: 'ready', tabs: [], pendingLink: null })
    const paneStates = state.filter((view) => view.surface === PANE)
    expect(paneStates).toHaveLength(2)
    for (const view of paneStates) {
      expect(view.tabs).toEqual([{ viewId: 'view_1', title: 'Bundle size' }, { viewId: 'view_2', title: 'Module map' }])
    }
    expect(fake.reports).toEqual(reports)
    const reportedInstance = fake.reports
      .map((report) => report !== null && typeof report === 'object' && 'instance' in report ? report.instance : undefined)
      .find((instance): instance is string => typeof instance === 'string')!
    expect(reportedInstance).toBeTruthy()
    expect(fake.reports).toContainEqual(expect.objectContaining({ instance: reportedInstance, surface: PANE }))
    const firstState = paneStates.find((view) => view.instance === reportedInstance)!
    const secondState = paneStates.find((view) => view.instance !== firstState.instance)!
    const firstPane = first
    const secondPane = second
    await fake.runCommand(CONTROL, { instance: firstState.instance, action: 'select-tab', viewId: 'view_2' })
    expect(text(firstPane.element)).toContain('Module map body')
    expect(text(secondPane.element)).toContain('Bundle size body')

    await fake.runCommand(CONTROL, { instance: firstState.instance, action: 'dismiss-tab', viewId: 'view_2' })
    expect([...firstPane.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Bundle size'])
    expect([...secondPane.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Bundle size', 'Module map'])
    expect(fake.callsTo('quirky.view/close')).toHaveLength(0)

    await firstPane.unmount()
    mounted.splice(mounted.indexOf(firstPane), 1)
    expect((await instances(fake)).map((view) => view.instance)).not.toContain(firstState.instance)
    expect((await instances(fake)).map((view) => view.instance)).toContain(secondState.instance)
  })

  test('renders nothing when the session has no pane views', async () => {
    const fake = start([record(markdownSpec('inline body'), { viewId: 'view_3', placement: 'inline' }), paneView('view_4', 'Gone', { closed: true })])
    const { element } = await mountPane(fake)
    expect(element.querySelectorAll('[data-ui-tool-panel-frame]')).toHaveLength(1)
    expect(text(element.querySelector('.ui-empty-state__message')!)).toBe('No views in the pane.')
  })

  test('Move inline in the pane moves that view and the pane follows the change', async () => {
    const records = [paneView('view_1', 'Bundle size')]
    const fake = start(records)
    const { element, click } = await mountPane(fake)

    await click(buttonLabelled(element, 'Move inline'))
    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
    expect(routedArgs(fake, MOVE)).toEqual([{ viewId: 'view_1', placement: 'inline' }])

    records[0] = { ...records[0], placement: 'inline', movedByUser: true }
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(element.querySelectorAll('[data-ui-tool-panel-frame]')).toHaveLength(1)
    expect(text(element.querySelector('.ui-empty-state__message')!)).toBe('No views in the pane.')
  })

  test('a new pane view appears when the agent opens one', async () => {
    const records = [paneView('view_1', 'Bundle size')]
    const fake = start(records)
    const { element } = await mountPane(fake)

    records.push(paneView('view_2', 'Module map'))
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_2' } })
    await settle()

    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Bundle size', 'Module map'])
  })

  test('Close hides the active view from the pane until it changes again', async () => {
    const records = [paneView('view_1', 'Bundle size'), paneView('view_2', 'Module map')]
    const fake = start(records)
    const { element, click } = await mountPane(fake)

    await click(element.querySelector('button[aria-label="Close Bundle size"]')!)
    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Module map'])
    const instance = await instanceFor(fake, PANE)
    expect(routedArgs(fake, CONTROL)).toEqual([{ instance, action: 'dismiss-tab', viewId: 'view_1' }])

    records[0] = { ...records[0], updates: 1, updatedAt: '2026-11-16T11:00:00.000Z' }
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Bundle size', 'Module map'])
  })
})

describe('moving a view', () => {
  test('Move to pane on an inline card calls move with the pane placement', async () => {
    const fake = start([record(bundleSize as ViewSpec)])
    const { element, click } = await mountCard(fake)

    await click(buttonLabelled(element, 'Move to pane'))

    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'pane' }])
    expect(routedArgs(fake, MOVE)).toEqual([{ viewId: 'view_1', placement: 'pane' }])
  })

  test('a card whose view is in the pane offers Move inline', async () => {
    const fake = start([record(bundleSize as ViewSpec, { placement: 'pane' })])
    const { element, click } = await mountCard(fake)

    expect(buttonLabelled(element, 'Move to pane')).toBeUndefined()
    await click(buttonLabelled(element, 'Move inline'))

    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
    expect(routedArgs(fake, MOVE)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
  })
})

describe('scriptable view commands', () => {
  test('registers and dispatches move, action, and control commands', async () => {
    const fake = start([record(markdownSpec('command target'))])
    await mountCard(fake)
    for (const id of [MOVE, ACTION, CONTROL]) expect(typeof fake.provided.get(id)).toBe('function')

    await fake.runCommand(MOVE, { viewId: 'view_1', placement: 'pane' })
    await fake.runCommand(ACTION, { viewId: 'view_1', name: 'go', source: 'button' })
    const instance = await instanceFor(fake, RENDER)
    const gets = fake.callsTo('quirky.view/get').length
    await fake.runCommand(CONTROL, { instance, action: 'refresh' })

    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'pane' }])
    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([{ viewId: 'view_1', name: 'go', source: 'button' }])
    expect(fake.callsTo('quirky.view/get')).toHaveLength(gets + 1)
  })

  test('rejects malformed, stale, non-tab, and unsafe link controls before effects', async () => {
    const fake = start([
      record(markdownSpec('inline'), { viewId: 'view_1' }),
      record(markdownSpec('pane'), { viewId: 'view_2', placement: 'pane' })
    ])
    await mountCard(fake, 'view_1')
    const pane = await mountView(fake, PANE, { session: 's1' })
    mounted.push(pane)
    const renderInstance = await instanceFor(fake, RENDER)
    const paneInstance = await instanceFor(fake, PANE)

    await expect(fake.runCommand(MOVE, [])).rejects.toThrow()
    await expect(fake.runCommand(MOVE, { placement: 'pane' })).rejects.toThrow()
    await expect(fake.runCommand(ACTION, [])).rejects.toThrow()
    await expect(fake.runCommand(ACTION, { viewId: ' ', name: 'go', source: 'button' })).rejects.toThrow()
    await expect(fake.runCommand(ACTION, { viewId: 'view_1', name: 'go', source: ' ', extra: true })).rejects.toThrow()
    await expect(fake.runCommand(MOVE, { viewId: 'view_1', placement: 'other' })).rejects.toThrow()
    await expect(fake.runCommand(MOVE, { viewId: 'view_1', placement: 'pane', extra: true })).rejects.toThrow()
    await expect(fake.runCommand(ACTION, { viewId: 'view_1', name: ' ', source: 'button' })).rejects.toThrow()
    await expect(fake.runCommand(ACTION, { viewId: 'view_1', name: 'go' })).rejects.toThrow()
    await expect(fake.runCommand(ACTION, { viewId: 'view_1', name: 'go', source: 'button', data: [] })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { action: 'state', instance: renderInstance })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { action: 'unknown' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: renderInstance, action: 'refresh', extra: true })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: '', action: 'refresh' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: paneInstance, action: 'select-tab' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: renderInstance, action: 'link-preview', viewId: 'other-view', href: 'https://example.test/docs' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: renderInstance, action: 'link-confirm', viewId: 'view_1', href: 'https://example.test/docs' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, [])).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: 'stale-instance', action: 'refresh' })).rejects.toThrow('View UI instance is no longer mounted.')
    await expect(fake.runCommand(CONTROL, { instance: paneInstance, action: 'select-tab', viewId: 'view_1' })).rejects.toThrow('View is not an open pane tab.')
    await expect(fake.runCommand(CONTROL, { instance: paneInstance, action: 'dismiss-tab', viewId: 'view_1' })).rejects.toThrow('View is not an open pane tab.')
    await expect(fake.runCommand(CONTROL, { instance: renderInstance, action: 'link-preview', viewId: 'view_1', href: 'javascript:alert(1)' })).rejects.toThrow()
    await expect(fake.runCommand(CONTROL, { instance: renderInstance, action: 'link-confirm', viewId: 'view_1' })).rejects.toThrow('No link is awaiting confirmation.')

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('quirky.view/action')).toHaveLength(0)
    expect(fake.callsTo('quirky.view/move')).toHaveLength(0)
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })

  test('programmatic command errors reject while UI handlers preserve their failure toasts', async () => {
    const spec = {
      title: 'Actions',
      root: {
        type: 'stack',
        children: [
          { type: 'button', props: { label: 'Run', action: 'go' } },
          { type: 'markdown', props: { text: '[docs](https://example.test/docs)' } }
        ]
      }
    } as ViewSpec
    const fake = start([record(spec)], {
      'quirky.view/action': () => {
        throw new Error('agent-busy')
      },
      'quirky.view/move': () => {
        throw new Error('move denied')
      },
      'quirky.terminal/openExternal': () => {
        throw new Error('open denied')
      }
    })
    const { element, click } = await mountCard(fake)

    await expect(fake.runCommand(ACTION, { viewId: 'view_1', name: 'go', source: 'button' })).rejects.toThrow('agent-busy')
    await expect(fake.runCommand(MOVE, { viewId: 'view_1', placement: 'pane' })).rejects.toThrow('move denied')
    expect(fake.toasts).toEqual([])

    await click(buttonLabelled(element, 'Run'))
    expect(fake.toasts).toEqual([{ title: 'Could not send the action', body: 'agent-busy' }])
    await click(buttonLabelled(element, 'Move to pane'))
    expect(fake.toasts[1]).toEqual({ title: 'Could not move the view', body: 'move denied' })
    await click(element.querySelector('a')!)
    await click(buttonLabelled(document.querySelector('[role="dialog"]')!, 'Open link'))

    expect(fake.toasts).toEqual([
      { title: 'Could not send the action', body: 'agent-busy' },
      { title: 'Could not move the view', body: 'move denied' },
      { title: 'Could not open link', body: 'open denied' }
    ])
    expect(fake.callsTo('quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: 'https://example.test/docs' }])
  })
})
describe('visible view read states', () => {
  const paneRecord = (viewId: string, title: string, sessionId = 's1', over: Partial<ReturnType<typeof record>> = {}) =>
    record(markdownSpec(`${title} body`), { viewId, title, sessionId, placement: 'pane', ...over })

  const mountPane = async (fake: FakeContext, session = 's1') => {
    const view = await mountView(fake, PANE, { session })
    mounted.push(view)
    return view
  }

  const expectPaneFrame = (element: Element) => {
    const frames = element.querySelectorAll('[data-ui-tool-panel-frame]')
    expect(frames).toHaveLength(1)
    expect(frames[0]?.querySelector('h2')?.textContent).toBe('Views')
  }

  test('a valid render mount announces its pending get and replaces the notice with content', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof record> | null>()
    const fake = start([], { 'quirky.view/get': () => pending.promise })
    const { element } = await mountCard(fake)

    expect(text(element.querySelector('.ui-notice-line')!)).toBe('Loading view…')
    expect(element.querySelector('.ui-empty-state')).toBeNull()
    expect(element.querySelector('.ui-inline-error')).toBeNull()

    await act(async () => pending.resolve(record(markdownSpec('ready body'))))
    await settle()

    expect(element.querySelector('.ui-notice-line')).toBeNull()
    expect(text(element)).toContain('ready body')
  })

  test('a pane keeps one Views frame through pending, empty, failed, and recovered list states', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof record>[]>()
    let reads = 0
    const fake = start([], {
      'quirky.view/list': () => {
        reads += 1
        if (reads === 1) return pending.promise
        if (reads === 2) throw new Error('offline')
        return [paneRecord('view_1', 'Ready')]
      }
    })
    const { element, click } = await mountPane(fake)

    expectPaneFrame(element)
    expect(text(element.querySelector('.ui-notice-line')!)).toBe('Loading views…')

    await act(async () => pending.resolve([]))
    await settle()
    expectPaneFrame(element)
    expect(text(element.querySelector('.ui-empty-state__message')!)).toBe('No views in the pane.')

    await fake.emitConnection('connected')
    await settle()
    expectPaneFrame(element)
    expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not load views: offline')
    expect(buttonLabelled(element, 'Retry')).toBeTruthy()

    const instance = await instanceFor(fake, PANE)
    await click(buttonLabelled(element, 'Retry'))
    await settle()
    expect(routedArgs(fake, CONTROL)).toContainEqual({ instance, action: 'refresh' })
    expect(fake.callsTo('quirky.view/list')).toHaveLength(3)
    expectPaneFrame(element)
    expect(element.querySelector('.ui-inline-error')).toBeNull()
    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Ready'])
    expect(text(element)).toContain('Ready body')
  })

  test('a failed get shows its exact alert and Retry refreshes through the control command', async () => {
    let reads = 0
    const fake = start([], {
      'quirky.view/get': () => {
        reads += 1
        if (reads === 1) throw new Error('offline')
        return record(markdownSpec('recovered body'))
      }
    })
    const { element, click } = await mountCard(fake)

    expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not load view: offline')
    expect(buttonLabelled(element, 'Retry')).toBeTruthy()
    const instance = await instanceFor(fake, RENDER)
    await click(buttonLabelled(element, 'Retry'))
    await settle()

    expect(fake.callsTo('quirky.view/get')).toHaveLength(2)
    expect(routedArgs(fake, CONTROL)).toContainEqual({ instance, action: 'refresh' })
    expect(element.querySelector('.ui-inline-error')).toBeNull()
    expect(text(element)).toContain('recovered body')
  })

  test('a failed refresh retains the last good card and an optional agent lookup failure only removes its badge', async () => {
    let reads = 0
    const lastGood = record(markdownSpec('last good content'), { title: 'Last good' })
    const fake = start([], {
      'quirky.view/get': () => {
        reads += 1
        if (reads === 1) return lastGood
        throw new Error('offline')
      },
      'quirky.session/get': () => { throw new Error('agent lookup offline') }
    })
    const { element } = await mountCard(fake)

    expect(text(element)).toContain('last good content')
    expect(text(element)).not.toContain('by omp')
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()

    expect(element.querySelector('[data-view-card="view_1"]')).not.toBeNull()
    expect(text(element)).toContain('last good content')
    expect(element.querySelector('.ui-inline-error__message')?.textContent).toBe('Could not load view: offline')
  })

  test('NotFound, null, and undefined get results replace stale content with the unavailable empty state', async () => {
    for (const outcome of ['NotFound', 'null', 'undefined'] as const) {
      let missing = false
      const fake = start([], {
        'quirky.view/get': () => {
          if (!missing) return record(markdownSpec(`${outcome} old content`))
          if (outcome === 'NotFound') throw new RpcError(RpcErrorCode.NotFound, 'view disappeared')
          return outcome === 'null' ? null : undefined
        }
      })
      const { element } = await mountCard(fake)
      missing = true
      await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
      await settle()

      expect(text(element.querySelector('.ui-empty-state__message')!)).toBe('This view is no longer available.')
      expect(element.querySelector('[data-view-card="view_1"]')).toBeNull()
      expect(text(element)).not.toContain(`${outcome} old content`)
    }
  })

  test('closing the final pane tab shows the pane empty state, makes no close RPC, and a later update restores it', async () => {
    const records = [paneRecord('view_1', 'Notes')]
    const fake = start(records)
    const { element, click } = await mountPane(fake)

    await click(element.querySelector('button[aria-label="Close Notes"]')!)
    expectPaneFrame(element)
    expect(text(element.querySelector('.ui-empty-state__message')!)).toBe('No views in the pane.')
    expect([...element.querySelectorAll('[role="tab"]')]).toHaveLength(0)
    expect(fake.callsTo('quirky.view/close')).toHaveLength(0)

    records[0] = { ...records[0]!, updatedAt: '2026-11-16T11:00:00.000Z' }
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Notes'])
  })

  test('closed and pane-placed transcript records use shared NoticeLine markup on status wrappers', async () => {
    const closedFake = start([record(markdownSpec('must not appear'), { closed: true })])
    const closed = await mountCard(closedFake)
    const closedWrapper = closed.element.querySelector('[data-view-record="view_1"][role="status"]')!
    const closedNotice = closedWrapper.querySelector('.ui-notice-line')!
    expect(closedWrapper).not.toBe(closedNotice)
    expect(closedNotice.tagName).toBe('P')
    expect(closedNotice.querySelector('p')).toBeNull()
    expect(closedNotice.getAttribute('role')).toBeNull()
    expect(closedNotice.getAttribute('data-view-record')).toBeNull()
    expect(text(closedNotice.querySelector('.ui-notice-line__text')!)).toBe('Notes closed')
    expect(closedNotice.querySelector('.ui-notice-line__text button')).toBeNull()
    expect(closedWrapper.querySelector('[data-view-node]')).toBeNull()
    expect(text(closed.element)).not.toContain('must not appear')

    const paneFake = start([record(markdownSpec('pane only content'), { placement: 'pane' })])
    const pane = await mountCard(paneFake)
    const paneWrapper = pane.element.querySelector('[data-view-record="view_1"][role="status"]')!
    const paneNotice = paneWrapper.querySelector('.ui-notice-line')!
    expect(paneWrapper).not.toBe(paneNotice)
    expect(paneWrapper.getAttribute('role')).toBe('status')
    expect(text(paneNotice.querySelector('.ui-notice-line__text')!)).toBe('Notes is in the Views pane')
    expect(paneNotice.querySelector('p')).toBeNull()
    expect(paneNotice.querySelector('.ui-notice-line__text button')).toBeNull()
    expect(buttonLabelled(paneWrapper, 'Move inline')).toBeTruthy()
    expect(paneWrapper.querySelector('[data-view-node]')).toBeNull()
    await pane.click(buttonLabelled(paneWrapper, 'Move inline'))
    expect(paneFake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
  })

  test('invalid render and pane inputs mount nothing and initiate no read', async () => {
    const fake = start([])
    const render = await mountView(fake, RENDER, {})
    const pane = await mountView(fake, PANE, {})
    mounted.push(render, pane)

    expect(render.element.innerHTML).toBe('')
    expect(pane.element.innerHTML).toBe('')
    expect(fake.callsTo('quirky.view/get')).toHaveLength(0)
    expect(fake.callsTo('quirky.view/list')).toHaveLength(0)
  })

  test('a later get success wins over an earlier success for the same mounted target', async () => {
    const first = Promise.withResolvers<ReturnType<typeof record> | null>()
    const second = Promise.withResolvers<ReturnType<typeof record> | null>()
    let reads = 0
    const fake = start([], { 'quirky.view/get': () => [first.promise, second.promise][reads++]! })
    const { element } = await mountCard(fake)

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    await act(async () => second.resolve(record(markdownSpec('new body'), { title: 'New' })))
    await settle()
    await act(async () => first.resolve(record(markdownSpec('old body'), { title: 'Old' })))
    await settle()

    expect(text(element)).toContain('new body')
    expect(text(element)).not.toContain('old body')
  })

  test('an obsolete get rejection cannot replace newer content with an alert', async () => {
    const first = Promise.withResolvers<ReturnType<typeof record> | null>()
    const second = Promise.withResolvers<ReturnType<typeof record> | null>()
    let reads = 0
    const fake = start([], { 'quirky.view/get': () => [first.promise, second.promise][reads++]! })
    const { element } = await mountCard(fake)

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    await act(async () => second.resolve(record(markdownSpec('new body'), { title: 'New' })))
    await settle()
    await act(async () => first.reject(new Error('obsolete offline')))
    await settle()

    expect(text(element)).toContain('new body')
    expect(element.querySelector('.ui-inline-error')).toBeNull()
  })

  test('a later list success wins over an earlier success for the same pane target', async () => {
    const first = Promise.withResolvers<ReturnType<typeof record>[]>()
    const second = Promise.withResolvers<ReturnType<typeof record>[]>()
    let reads = 0
    const fake = start([], { 'quirky.view/list': () => [first.promise, second.promise][reads++]! })
    const { element } = await mountPane(fake)

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_any' } })
    await settle()
    await act(async () => second.resolve([paneRecord('view_new', 'New')]))
    await settle()
    await act(async () => first.resolve([paneRecord('view_old', 'Old')]))
    await settle()

    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['New'])
    expect(text(element)).toContain('New body')
    expect(text(element)).not.toContain('Old body')
  })

  test('an obsolete list rejection cannot replace newer pane content with an alert', async () => {
    const first = Promise.withResolvers<ReturnType<typeof record>[]>()
    const second = Promise.withResolvers<ReturnType<typeof record>[]>()
    let reads = 0
    const fake = start([], { 'quirky.view/list': () => [first.promise, second.promise][reads++]! })
    const { element } = await mountPane(fake)

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_any' } })
    await settle()
    await act(async () => second.resolve([paneRecord('view_new', 'New')]))
    await settle()
    await act(async () => first.reject(new Error('obsolete offline')))
    await settle()

    expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['New'])
    expect(text(element)).toContain('New body')
    expect(element.querySelector('.ui-inline-error')).toBeNull()
  })

  test('an unmounted render request and connection listener cannot revive after remount', async () => {
    const obsolete = Promise.withResolvers<ReturnType<typeof record> | null>()
    const current = Promise.withResolvers<ReturnType<typeof record> | null>()
    let reads = 0
    const fake = start([], {
      'quirky.view/get': () => [obsolete.promise, current.promise][reads++]!
    })
    const oldMount = await mountCard(fake)
    await oldMount.unmount()
    mounted.splice(mounted.indexOf(oldMount), 1)

    await fake.emitConnection('connected')
    expect(fake.callsTo('quirky.view/get')).toHaveLength(1)
    const newMount = await mountCard(fake)
    await act(async () => current.resolve(record(markdownSpec('remounted content'))))
    await settle()
    await act(async () => obsolete.resolve(record(markdownSpec('obsolete content'))))
    await settle()

    expect(text(newMount.element)).toContain('remounted content')
    expect(text(newMount.element)).not.toContain('obsolete content')
  })

  test('an unmounted pane list and connection listener cannot revive after remount', async () => {
    const obsolete = Promise.withResolvers<ReturnType<typeof record>[]>()
    const current = Promise.withResolvers<ReturnType<typeof record>[]>()
    let reads = 0
    const fake = start([], {
      'quirky.view/list': () => [obsolete.promise, current.promise][reads++]!
    })
    const oldMount = await mountPane(fake)
    await oldMount.unmount()
    mounted.splice(mounted.indexOf(oldMount), 1)

    await fake.emitConnection('connected')
    expect(fake.callsTo('quirky.view/list')).toHaveLength(1)
    const newMount = await mountPane(fake)
    await act(async () => current.resolve([paneRecord('view_new', 'Remounted')]))
    await settle()
    await act(async () => obsolete.resolve([paneRecord('view_old', 'Obsolete')]))
    await settle()

    expect([...newMount.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Remounted'])
    expect(text(newMount.element)).toContain('Remounted body')
    expect(text(newMount.element)).not.toContain('Obsolete body')
  })

  test('changing the render target clears its pending card/link and invalidates the old target read', async () => {
    const obsolete = Promise.withResolvers<ReturnType<typeof record> | null>()
    const next = Promise.withResolvers<ReturnType<typeof record> | null>()
    let firstTargetReads = 0
    const fake = fakeContext({
      'quirky.view/get': ({ viewId }) => {
        if (viewId === 'view_1') {
          firstTargetReads += 1
          return firstTargetReads === 1
            ? record(markdownSpec('[docs](https://example.test/docs)'), { title: 'Notes' })
            : obsolete.promise
        }
        return next.promise
      },
      'quirky.session/get': () => ({ id: 's1', agent: 'omp' }),
      'quirky.terminal/openExternal': () => ({ ok: true })
    })
    const controller = createViewUiController(fake.context)
    const oldInstance = controller.mount({ surface: RENDER, viewId: 'view_1' })
    const view = await mountDirect(createElement(ViewCardView, { context: fake.context, instance: oldInstance, viewId: 'view_1' }))

    await view.click(view.element.querySelector('a')!)
    await settle()
    expect(view.element.querySelector('[role="dialog"]')).not.toBeNull()
    expect((await fake.runCommand(CONTROL, { action: 'state' }) as { instances: { pendingLink: string | null }[] }).instances[0]?.pendingLink).toBe('https://example.test/docs')

    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    const nextInstance = controller.mount({ surface: RENDER, viewId: 'view_2' })
    await view.render(createElement(ViewCardView, { context: fake.context, instance: nextInstance, viewId: 'view_2' }))
    oldInstance.dispose()

    expect(view.element.querySelector('[data-view-card="view_1"]')).toBeNull()
    expect(view.element.querySelector('.ui-notice-line')?.textContent).toBe('Loading view…')
    expect(view.element.querySelector('[role="dialog"]')).toBeNull()
    expect((await fake.runCommand(CONTROL, { action: 'state' }) as { instances: { pendingLink: string | null }[] }).instances[0]?.pendingLink).toBeNull()

    await act(async () => next.resolve(record(markdownSpec('new target content'), { viewId: 'view_2', title: 'New target' })))
    await settle()
    await act(async () => obsolete.resolve(record(markdownSpec('obsolete old target content'), { viewId: 'view_1', title: 'Old target' })))
    await settle()

    expect(text(view.element)).toContain('new target content')
    expect(text(view.element)).not.toContain('obsolete old target content')
    const reads = fake.callsTo('quirky.view/get').length
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(fake.callsTo('quirky.view/get')).toHaveLength(reads)
  })

  test('changing the pane target resets tabs, selection, and dismissals and invalidates its old list read', async () => {
    const obsolete = Promise.withResolvers<ReturnType<typeof record>[]>()
    const next = Promise.withResolvers<ReturnType<typeof record>[]>()
    let firstSessionReads = 0
    const oldRecords = [paneRecord('view_1', 'Notes', 's1'), paneRecord('view_2', 'Module map', 's1')]
    const nextRecords = [paneRecord('view_1', 'Notes in s2', 's2'), paneRecord('view_2', 'Map in s2', 's2')]
    const fake = fakeContext({
      'quirky.view/list': ({ session }) => {
        if (session === 's1') {
          firstSessionReads += 1
          return firstSessionReads === 1 ? oldRecords : obsolete.promise
        }
        return next.promise
      },
      'quirky.session/get': () => ({ id: 's1', agent: 'omp' })
    })
    const controller = createViewUiController(fake.context)
    const oldInstance = controller.mount({ surface: PANE, session: 's1' })
    const view = await mountDirect(createElement(ViewsPane, { context: fake.context, instance: oldInstance, session: 's1' }))

    await view.click(view.element.querySelector('button[aria-label="Close Notes"]')!)
    expect([...view.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Module map'])
    await view.click(view.element.querySelector('[role="tab"]')!)
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_2' } })
    await settle()

    const nextInstance = controller.mount({ surface: PANE, session: 's2' })
    await view.render(createElement(ViewsPane, { context: fake.context, instance: nextInstance, session: 's2' }))
    oldInstance.dispose()

    expectPaneFrame(view.element)
    expect(view.element.querySelectorAll('[role="tab"]')).toHaveLength(0)
    expect(text(view.element.querySelector('.ui-notice-line')!)).toBe('Loading views…')
    expect(text(view.element)).not.toContain('Notes body')
    expect(text(view.element)).not.toContain('Module map body')

    await act(async () => next.resolve(nextRecords))
    await settle()
    expect([...view.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Notes in s2', 'Map in s2'])
    expect(text(view.element)).toContain('Notes in s2 body')
    expect(text(view.element)).not.toContain('Map in s2 body')

    await act(async () => obsolete.resolve(oldRecords))
    await settle()
    expect([...view.element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(['Notes in s2', 'Map in s2'])
    expect(text(view.element)).toContain('Notes in s2 body')
    expect(text(view.element)).not.toContain('Notes body')
    const reads = fake.callsTo('quirky.view/list').length
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(fake.callsTo('quirky.view/list')).toHaveLength(reads)
  })
})
