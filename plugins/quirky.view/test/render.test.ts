import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement, type ReactNode } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
import bundleSize from './fixtures/bundle-size.json'
import authFlowV1 from './fixtures/auth-flow-v1.json'
import authFlowV2 from './fixtures/auth-flow-v2.json'
import visualKinds from './fixtures/visual-kinds.json'
import { CATALOG_TYPES, COMPONENTS, type Refused, type ViewRecord, type ViewSpec } from '../src/core/catalog'
import { fakeContext, mountView, record, settle, type FakeContext } from './ui-fake'
import { createViewUiController } from '../src/control'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type { ViewsPane as ViewsPaneComponent } from '../src/Pane'
import type { ViewCardView as ViewCardViewComponent } from '../src/render/ViewCard'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { collectInventory } from '../../../scripts/ui-scoreboard/inventory'
import { checkPlugin } from '../../../scripts/ui-scoreboard/tokens'
import { discoverUiFiles } from '../../../scripts/ui-scoreboard/audit-discovery'

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
    expect(element.querySelector('[data-streamdown="strong"]')!.textContent).toBe('bold')
    expect(element.querySelector('code[data-streamdown="inline-code"]')!.textContent).toBe('code')
    expect(element.querySelectorAll('table td')).toHaveLength(2)
  })

  test('shows raw HTML as literal text and never makes it live', async () => {
    const { element } = await rendered(
      ['<script>window.pwned = 1</script>', '', '![tracker](https://example.com/t.png)', '', '<img src="https://example.com/x.png" onerror="alert(1)">', '', '<div style="color:red" onclick="alert(1)">raw</div>', '', 'plain text'].join('\n')
    )
    expect(element.querySelector('script')).toBeNull()
    expect(element.querySelector('img')).toBeNull()
    expect(element.querySelector('[onclick]')).toBeNull()
    expect(element.querySelector('[onerror]')).toBeNull()
    expect(text(element)).toContain('plain text')
    expect((window as { pwned?: unknown }).pwned).toBeUndefined()
    expect(element.querySelector('[onclick], [onerror], [style*="color:red"]')).toBeNull()
  })

  test('renders a GitHub alert as a styled alert', async () => {
    const { element } = await rendered('> [!NOTE]\n> Heads up\n')
    const alert = element.querySelector('[data-alert="note"]')
    expect(alert).not.toBeNull()
    expect(alert!.textContent).toContain('Heads up')
  })

  test('renders a fenced code block with its header', async () => {
    const { element } = await rendered('```ts\nconst answer = 42\n```\n')
    const block = element.querySelector('[data-streamdown="code-block"]')
    expect(block).not.toBeNull()
    expect(block!.querySelector('[data-streamdown="code-block-header"]')).not.toBeNull()
    expect(text(block!)).toContain('const answer = 42')
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

  test.each([RENDER, PANE])('a failed refresh command rejects and retains last-good content in %s', async (surface) => {
    let offline = false
    const current = record(markdownSpec('last-good body'), { placement: surface === PANE ? 'pane' : 'inline' })
    const read = () => {
      if (offline) throw new Error('offline')
      return current
    }
    const fake = start([current], {
      'quirky.view/get': read,
      'quirky.view/list': () => [read()]
    })
    const view = surface === PANE ? await mountPane(fake) : await mountCard(fake)
    const instance = await instanceFor(fake, surface)
    offline = true
    await act(async () => {
      await expect(fake.runCommand(CONTROL, { instance, action: 'refresh' })).rejects.toThrow('offline')
    })
    expect(text(view.element)).toContain('last-good body')
    expect(view.element.querySelector('.ui-inline-error__message')?.textContent)
      .toBe(`Could not load ${surface === PANE ? 'views' : 'view'}: offline`)
    offline = false
    await act(async () => void await fake.runCommand(CONTROL, { instance, action: 'refresh' }))
    expect(view.element.querySelector('[role="alert"]')).toBeNull()
    expect(text(view.element)).toContain('last-good body')
  })

  test.each([RENDER, PANE])('a refreshed spec invalidates pending confirmation before %s commands return', async (surface) => {
    const records = [record(markdownSpec('[docs](https://example.test/docs)'), { placement: surface === PANE ? 'pane' : 'inline' })]
    const fake = start(records)
    const view = surface === PANE ? await mountPane(fake) : await mountCard(fake)
    const instance = await instanceFor(fake, surface)
    await view.click(view.element.querySelector('a')!)
    records[0] = record(markdownSpec('changed content'), { placement: surface === PANE ? 'pane' : 'inline' })
    await act(async () => {
      await fake.runCommand(CONTROL, { instance, action: 'refresh' })
      expect((await instances(fake)).find((state) => state.instance === instance)?.pendingLink).toBeNull()
      await expect(fake.runCommand(CONTROL, { instance, action: 'link-confirm', viewId: 'view_1' }))
        .rejects.toThrow('No link is awaiting confirmation.')
    })
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })

  test('selecting a pane card and preparing its link in one command turn opens the new card dialog', async () => {
    const fake = start([paneRecord('view_1', 'First'), paneRecord('view_2', 'Second')])
    await mountPane(fake)
    const instance = await instanceFor(fake, PANE)
    await act(async () => {
      await fake.runCommand(CONTROL, { instance, action: 'select-tab', viewId: 'view_2' })
      await fake.runCommand(CONTROL, { instance, action: 'link-preview', viewId: 'view_2', href: 'https://example.test/docs' })
    })
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('https://example.test/docs')
    expect((await instances(fake)).find((state) => state.instance === instance)?.pendingLink).toBe('https://example.test/docs')
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })

  test.each(['closed', 'pane'])('a render card becoming %s clears its pending link without a spec change', async (change) => {
    const spec = markdownSpec('[docs](https://example.test/docs)')
    const records = [record(spec)]
    const fake = start(records)
    const view = await mountCard(fake)
    const instance = await instanceFor(fake, RENDER)
    await view.click(view.element.querySelector('a')!)
    records[0] = record(spec, change === 'closed' ? { closed: true } : { placement: 'pane' })
    await act(async () => {
      await fake.runCommand(CONTROL, { instance, action: 'refresh' })
      expect((await instances(fake)).find((state) => state.instance === instance)?.pendingLink).toBeNull()
      await expect(fake.runCommand(CONTROL, { instance, action: 'link-confirm', viewId: 'view_1' }))
        .rejects.toThrow('No link is awaiting confirmation.')
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })
})

const POINT = 'command:quirky.session/chat-point'
const EXPAND = 'command:quirky.session/chat-expand-visual'

type Served = { fake: FakeContext; state: { latest: number; refused: Refused | null }; specs: ViewSpec[] }

/** A view with `specs` as versions 1..n; `get` honours `version`, and the state can move on or mark the newest version refused. */
function startVersions(specs: ViewSpec[], extra: Record<string, (params: Record<string, unknown>) => unknown> = {}): Served {
  const state = { latest: specs.length, refused: null as Refused | null }
  const fake = start([], {
    'quirky.view/get': (params) => {
      const version = typeof params.version === 'number' ? params.version : state.latest
      const spec = specs[version - 1]
      if (!spec || version > state.latest) throw new RpcError(RpcErrorCode.NotFound, 'unknown version')
      return record(spec, { viewId: params.viewId as string, version, latestVersion: state.latest, updates: state.latest - 1, refused: state.refused })
    },
    'desktop.capabilities': () => ({ auxiliaryWindows: true }),
    'quirky.view/render-failed': () => ({ ok: true }),
    ...extra
  })
  return { fake, state, specs }
}

async function mountSurface(fake: FakeContext, input: Record<string, unknown> = {}) {
  const view = await mountView(fake, RENDER, { viewId: 'view_1', surface: 'panel', ...input })
  mounted.push(view)
  return { ...view, press: async (target: Element) => { await view.click(target); await settle() } }
}

const pointCalls = (fake: FakeContext) => routedArgs(fake, POINT) as Record<string, unknown>[]
const buttonByLabel = (root: Element, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const authFlow = [authFlowV1, authFlowV2] as ViewSpec[]

describe('every visual kind', () => {
  test('the fixture with all the new kinds draws each of them, with math through the markdown node', async () => {
    const fake = start([record(visualKinds as ViewSpec)])
    const { element } = await mountSurface(fake)
    for (const kind of ['diagram', 'image', 'html', 'live-preview', 'timeline', 'board', 'matrix', 'annotated-code', 'file-map', 'plot', 'sketch']) {
      expect(element.querySelector(`[data-view-node="${kind}"]`), kind).not.toBeNull()
    }
    expect(element.querySelector('.katex')).not.toBeNull()
  })

  test('a timeline, board, matrix, file map, plot and sketch show their content', async () => {
    const fake = start([record(visualKinds as ViewSpec)])
    const { element } = await mountSurface(fake)
    const timeline = element.querySelector('[data-view-node="timeline"]')!
    expect([...timeline.querySelectorAll('[data-point-key]')].map((row) => row.getAttribute('data-point-key'))).toEqual(['item:design', 'item:build', 'item:2'])
    expect(text(element.querySelector('[data-view-node="board"]')!)).toContain('Write docs')
    expect(text(element.querySelector('[data-view-node="board"]')!)).toContain('README and guide')
    const matrix = element.querySelector('[data-view-node="matrix"]')!
    expect([...matrix.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Claude', 'Codex', 'pi'])
    expect(matrix.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(text(element.querySelector('[data-view-node="file-map"]')!)).toContain('plugins/quirky.view/src/core/catalog.ts')
    expect(element.querySelectorAll('[data-view-node="plot"] svg polyline')).toHaveLength(2)
    expect(element.querySelectorAll('[data-view-node="sketch"] svg path').length).toBeGreaterThan(3)
  })

  test('annotated code numbers its lines and shows each note after its last line', async () => {
    const fake = start([record(visualKinds as ViewSpec)])
    const { element } = await mountSurface(fake)
    const code = element.querySelector('[data-view-node="annotated-code"]')!
    expect(code.querySelectorAll('[data-point-key^="line:"]')).toHaveLength(4)
    expect(text(code)).toContain('Skip while the token is fresh.')
    expect(text(code)).toContain('Renew inside the five minute window.')
  })

  test('an image of the session resolves through the markdown assets', async () => {
    const spec: ViewSpec = { title: 'Shot', root: { type: 'image', props: { path: 'docs/shots/login.png', alt: 'The login screen', caption: 'Before' } } }
    const fake = start([record(spec)], {
      'quirky.session/markdownAssets': (params) => ({ images: Object.fromEntries((params.images as string[]).map((path) => [path, `http://localhost/file/${path}`])) }),
      'quirky.view/render-failed': () => ({ ok: true })
    })
    const { element } = await mountSurface(fake)
    expect(fake.callsTo('quirky.session/markdownAssets').map((call) => call.params)).toEqual([{ session: 's1', images: ['docs/shots/login.png'] }])
    expect(element.querySelector('img')!.getAttribute('src')).toBe('http://localhost/file/docs/shots/login.png')
    expect(element.querySelector('img')!.getAttribute('alt')).toBe('The login screen')
    expect(text(element)).toContain('Before')
    expect(fake.callsTo('quirky.view/render-failed')).toHaveLength(0)
  })

  test('an image that is not in the worktree says so and is reported once for its version', async () => {
    const spec: ViewSpec = { title: 'Shot', root: { type: 'image', props: { path: 'docs/none.png', alt: 'Nothing' } } }
    const fake = start([record(spec, { viewId: 'view_noimg' })], {
      'quirky.session/markdownAssets': () => ({ images: { 'docs/none.png': null } }),
      'quirky.view/render-failed': () => ({ ok: true })
    })
    const { element } = await mountSurface(fake, { viewId: 'view_noimg' })
    expect(element.querySelector('img')).toBeNull()
    expect(text(element)).toContain('docs/none.png is not an image in this worktree')
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_noimg' } })
    await settle()
    expect(fake.callsTo('quirky.view/render-failed').map((call) => call.params)).toEqual([
      { viewId: 'view_noimg', version: 1, error: 'docs/none.png is not an image in this worktree' }
    ])
  })

  test('a diagram is drawn through the markdown mermaid fence and keeps the caption', async () => {
    const spec: ViewSpec = { title: 'Flow', root: { type: 'diagram', props: { source: 'flowchart LR\n  a --> b', caption: 'A path' } } }
    const fake = start([record(spec)])
    const { element } = await mountSurface(fake)
    expect(text(element)).toContain('A path')
    expect(element.querySelector('[data-view-node="diagram"] [data-qmd-data="mermaid"], [data-view-node="diagram"] [data-qmd-error], [data-view-node="diagram"] pre')).not.toBeNull()
  })

  test('a diagram that loads remote images is refused by the shared safety path and reported once per version', async () => {
    const spec: ViewSpec = { title: 'Flow', root: { type: 'diagram', props: { source: 'flowchart LR\n  a[<img src="https://example.test/x.png">]' } } }
    const fake = start([record(spec, { viewId: 'view_remote' })], { 'quirky.view/render-failed': () => ({ ok: true }) })
    const { element } = await mountSurface(fake, { viewId: 'view_remote' })
    await settle()
    expect(text(element)).toContain("Couldn't draw this diagram: it loads remote images")
    expect(fake.callsTo('quirky.view/render-failed').map((call) => call.params)).toEqual([{ viewId: 'view_remote', version: 1, error: 'it loads remote images' }])
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_remote' } })
    await settle()
    expect(fake.callsTo('quirky.view/render-failed')).toHaveLength(1)
  })

  test('a drawn diagram node is pointable by its mermaid id', async () => {
    const spec: ViewSpec = { title: 'Flow', root: { type: 'diagram', props: { source: 'flowchart LR\n  a --> b' } } }
    const fake = start([record(spec)])
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake)
    const host = element.querySelector('[data-view-node="diagram"] > div')!
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('class', 'node default')
    group.setAttribute('data-id', 'Daemon')
    group.setAttribute('id', 'flowchart-Daemon-3')
    group.textContent = 'The daemon'
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.appendChild(group)
    await act(async () => void host.appendChild(svg))
    await settle()

    expect(group.getAttribute('data-point-key')).toBe('dg:daemon')
    await press(group)
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'dg:daemon', label: 'The daemon' }])
  })

  test('the diagram helpers read the failure note and the node id mermaid gives', async () => {
    const { failureReason, fenceFor, nodeId } = await import('../src/render/Diagram')
    expect(failureReason("Couldn't draw this diagram: line 4: unexpected \"-->>\". Showing the source.")).toBe('line 4: unexpected "-->>"')
    expect(failureReason('something else')).toBe('something else')
    expect(fenceFor('a --> b')).toBe('```')
    expect(fenceFor('x\n````\ny')).toBe('`````')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('id', 'qmd-mermaid-_r_1_')
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('id', 'qmd-mermaid-_r_1_-flowchart-client-app-7')
    svg.appendChild(group)
    expect(nodeId(group)).toBe('client-app')
    group.setAttribute('id', 'flowchart-client-7')
    svg.removeAttribute('id')
    expect(nodeId(group)).toBe('client')
    group.setAttribute('data-id', 'Daemon')
    expect(nodeId(group)).toBe('Daemon')
    expect(nodeId(document.createElementNS('http://www.w3.org/2000/svg', 'g'))).toBeUndefined()
  })
})

describe('pointing', () => {
  async function pointAtFixture(selector: string) {
    const fake = start([record(visualKinds as ViewSpec)])
    fake.commands[POINT] = () => {}
    const view = await mountSurface(fake)
    const target = view.element.querySelector(selector)
    if (!target) throw new Error(`nothing matches ${selector}`)
    await view.press(target)
    return { fake, view, target }
  }

  test.each([
    ['a timeline item', '[data-point-key="item:build"]', 'item:build', 'Build'],
    ['a timeline item without an id, by position', '[data-point-key="item:2"]', 'item:2', 'Launch'],
    ['a board card', '[data-point-key="item:card-docs"]', 'item:card-docs', 'Write docs'],
    ['a matrix cell', '[data-point-key="cell:visual-guidance:codex"]', 'cell:visual-guidance:codex', 'Visual guidance › Codex'],
    ['a file map entry', '[data-point-key="file:1"]', 'file:1', 'plugins/quirky.view/src/core/patch.ts'],
    ['an annotated code line', '[data-point-key="line:2"]', 'line:2', 'line 2'],
    ['a sketch shape', '[data-point-key="item:frame"]', 'item:frame', 'Window']
  ])('%s points with its key and label', async (_name, selector, element, label) => {
    const { fake } = await pointAtFixture(selector)
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element, label }])
  })

  test('a node with an id is pointable as node:<id> and the click outlines it', async () => {
    const spec: ViewSpec = { title: 'Notes', root: { type: 'stack', id: 'root', children: [{ type: 'callout', id: 'warning', props: { tone: 'warn', text: 'Mind the gap' } }] } }
    const fake = start([record(spec)])
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake)
    expect(element.querySelector('[data-point-key="node:root"]')).toBeNull()
    const callout = element.querySelector<HTMLElement>('[data-point-key="node:warning"]')!
    expect(callout.style.outlineColor).toBe('')
    await press(callout.firstElementChild!)
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'node:warning', label: 'callout' }])
    expect(callout.style.outlineColor).toBe('var(--ui-accent)')
  })

  test('table rows and chart bars and points point at the row, the category and the value', async () => {
    const spec: ViewSpec = {
      title: 'Data',
      root: {
        type: 'stack',
        children: [
          { type: 'table', props: { columns: ['Route', 'Size'], rows: [['/home', '12'], ['/settings', '96']] } },
          { type: 'bar-chart', props: { unit: 'KB', series: [{ label: '/settings', value: 96 }] } },
          { type: 'line-chart', props: { unit: 'ms', points: [{ x: 'Mon', y: 3 }, { x: 'Tue', y: 5 }] } }
        ]
      }
    }
    const fake = start([record(spec)])
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake)
    await press(element.querySelectorAll('tbody tr')[1]!.firstElementChild!)
    await press(element.querySelector('[data-point-key="pt:settings"]')!)
    await press(element.querySelector('[data-point-key="pt:tue"]')!)
    expect(pointCalls(fake).map((call) => [call.element, call.label])).toEqual([
      ['row:1', '/settings'],
      ['pt:settings', '/settings 96 KB'],
      ['pt:tue', 'Tue 5 ms']
    ])
  })

  test('a click on a button inside a pointable node keeps its own action and does not point', async () => {
    const spec: ViewSpec = { title: 'Ask', root: { type: 'section', id: 'choices', props: { title: 'Choices' }, children: [{ type: 'button', props: { label: 'Go', action: 'go' } }] } }
    const fake = start([record(spec)])
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake)
    await press(buttonLabelled(element, 'Go'))
    expect(pointCalls(fake)).toEqual([])
    expect(routedArgs(fake, ACTION)).toEqual([{ viewId: 'view_1', name: 'go', source: 'button' }])
  })

  test('a click on an image points at the region as percentages of the picture', async () => {
    const spec: ViewSpec = { title: 'Shot', root: { type: 'image', props: { path: 'a.png', alt: 'A' } } }
    const fake = start([record(spec)], { 'quirky.session/markdownAssets': () => ({ images: { 'a.png': 'http://localhost/a.png' } }) })
    fake.commands[POINT] = () => {}
    const { element } = await mountSurface(fake)
    const image = element.querySelector('img')!
    image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) })
    await act(async () => void image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 110, clientY: 45 })))
    await settle()
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'region:50-25', label: 'region near 50%,25%' }])
  })

  test('a click on an image rings the clicked region and moves the ring on the next click', async () => {
    const spec: ViewSpec = { title: 'Shot', root: { type: 'image', props: { path: 'a.png', alt: 'A' } } }
    const fake = start([record(spec)], { 'quirky.session/markdownAssets': () => ({ images: { 'a.png': 'http://localhost/a.png' } }) })
    fake.commands[POINT] = () => {}
    const { element } = await mountSurface(fake)
    const image = element.querySelector('img')!
    image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) })
    expect(element.querySelector('[data-point-marker]')).toBeNull()
    await act(async () => void image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 110, clientY: 45 })))
    await settle()
    const rings = element.querySelectorAll('[data-point-marker]')
    expect(rings).toHaveLength(1)
    expect(rings[0]!.parentElement).toBe(image.parentElement)
    await act(async () => void image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 70 })))
    await settle()
    expect(element.querySelectorAll('[data-point-marker]')).toHaveLength(1)
  })

  test('a key press on a focused pointable element points like a click', async () => {
    const { fake, target } = await pointAtFixture('[data-point-key="file:0"]')
    expect(pointCalls(fake)).toHaveLength(1)
    await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    await settle()
    expect(pointCalls(fake)).toHaveLength(2)
    await act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })))
    await settle()
    expect(pointCalls(fake)).toHaveLength(2)
  })

  test('the point carries the version the person is looking at', async () => {
    const { fake } = startVersions(authFlow)
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake)
    await press(buttonByLabel(element, 'Older version')!)
    await press(element.querySelectorAll('tbody tr')[0]!.firstElementChild!)
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'row:0', label: 'Authority' }])
  })

  test('without the chat command a click only warns and does not fail', async () => {
    const fake = start([record(visualKinds as ViewSpec)])
    const warn = console.warn
    const warnings: string[] = []
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      const { element, press } = await mountSurface(fake)
      await press(element.querySelector('[data-point-key="file:0"]')!)
    } finally {
      console.warn = warn
    }
    expect(warnings.some((message) => message.includes(POINT))).toBe(true)
    expect(fake.toasts).toEqual([])
  })

  test('a point from the control command is checked like one from a click', async () => {
    const fake = start([record(visualKinds as ViewSpec)])
    fake.commands[POINT] = () => {}
    await mountSurface(fake)
    const instance = await instanceFor(fake, RENDER)
    await expect(fake.runCommand(CONTROL, { instance, action: 'point', viewId: 'view_1', element: 'Not A Key', label: 'x' })).rejects.toThrow('Invalid view element.')
    await expect(fake.runCommand(CONTROL, { instance, action: 'point', viewId: 'view_1', element: 'row:1', label: 'x'.repeat(121) })).rejects.toThrow('Invalid view element label.')
    await expect(fake.runCommand(CONTROL, { instance, action: 'point', viewId: 'view_2', element: 'row:1', label: 'x' })).rejects.toThrow('View is not the active card.')
    await fake.runCommand(CONTROL, { instance, action: 'point', viewId: 'view_1', element: 'row:1', label: 'Second row' })
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'row:1', label: 'Second row' }])
  })
})

describe('versions and the change highlight', () => {
  test('the stepper walks back and forth, and the highlight is only on the newest version', async () => {
    const { fake } = startVersions(authFlow)
    const { element, press } = await mountSurface(fake)
    expect(text(element)).toContain('v2 of 2')
    expect(element.querySelector('[data-view-changed-note]')!.textContent).toBe('changed in v2')
    const outlined = [...element.querySelectorAll<HTMLElement>('[data-view-changed]')]
    expect(outlined.map((node) => node.firstElementChild!.getAttribute('data-point-key'))).toEqual(['node:auth-diagram', 'node:token-table'])
    expect(outlined[0]!.style.outlineColor).toBe('var(--ui-working)')
    expect(buttonByLabel(element, 'Newer version')!.disabled).toBe(true)

    await press(buttonByLabel(element, 'Older version')!)
    expect(text(element)).toContain('v1 of 2')
    expect(element.querySelector('[data-view-changed]')).toBeNull()
    expect(element.querySelector('[data-view-changed-note]')).toBeNull()
    expect(element.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(buttonByLabel(element, 'Older version')!.disabled).toBe(true)
    expect(fake.callsTo('quirky.view/get').at(-1)!.params).toEqual({ viewId: 'view_1', version: 1 })

    await press(buttonByLabel(element, 'Newer version')!)
    expect(text(element)).toContain('v2 of 2')
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(element.querySelector('[data-view-changed-note]')).not.toBeNull()
  })

  test('a card pinned to a version stays there while a newer one arrives, and an unpinned card follows', async () => {
    const { fake, state, specs } = startVersions([...authFlow])
    const pinned = await mountSurface(fake, { version: 1 })
    expect(text(pinned.element)).toContain('v1 of 2')
    expect(pinned.element.querySelector('[data-view-changed]')).toBeNull()
    const following = await mountSurface(fake)
    expect(text(following.element)).toContain('v2 of 2')

    specs.push({ title: 'Auth flow', root: { type: 'markdown', props: { text: 'a third version' } } })
    state.latest = 3
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(text(pinned.element)).toContain('v1 of 3')
    expect(text(following.element)).toContain('v3 of 3')
    expect(text(following.element)).toContain('a third version')
    expect(following.element.querySelector('[data-view-changed-note]')!.textContent).toBe('changed in v3')
  })

  test('the highlight matches nodes by id, else by position, and a container changes only with its own props', async () => {
    const before: ViewSpec = { title: 'T', root: { type: 'stack', children: [{ type: 'callout', props: { text: 'same' } }, { type: 'callout', props: { text: 'old' } }, { type: 'callout', id: 'moved', props: { text: 'kept' } }] } }
    const after: ViewSpec = { title: 'T', root: { type: 'stack', children: [{ type: 'callout', props: { text: 'same' } }, { type: 'callout', props: { text: 'new' } }, { type: 'callout', id: 'moved', props: { text: 'kept' } }, { type: 'callout', props: { text: 'added' } }] } }
    const { fake } = startVersions([before, after])
    const { element } = await mountSurface(fake)
    expect([...element.querySelectorAll('[data-view-changed]')].map((node) => node.textContent)).toEqual(['new', 'added'])
  })

  test('a record without version fields counts its updates as versions', async () => {
    const fake = start([record(bundleSize as ViewSpec, { updates: 2 })])
    const { element } = await mountSurface(fake)
    expect(text(element)).toContain('v3 of 3')
  })
})

describe('a version that did not render', () => {
  const refused: Refused = { attempt: 'update', version: null, errors: ['line 4: unexpected "-->>"'], source: 'flowchart TD\n  a -->> b', at: 1 }
  const badge = (root: Element) => [...root.querySelectorAll('button')].find((button) => button.textContent?.includes("didn't render"))

  test('a refused update keeps the last good version and a badge opens the error and the source', async () => {
    const { fake, state, specs } = startVersions([...authFlow])
    state.refused = refused
    const { element, press } = await mountSurface(fake)
    expect(text(element)).toContain('v2 of 2')
    expect(badge(element)!.textContent).toContain("v3 didn't render")
    expect(element.querySelector('[data-view-refused]')).toBeNull()
    await press(badge(element)!)
    const box = element.querySelector('[data-view-refused]')!
    expect(text(box)).toContain('line 4: unexpected "-->>"')
    expect(box.querySelector('pre')!.textContent).toBe('flowchart TD\n  a -->> b')
    expect(text(box)).toContain('showing v2, the last version that rendered')
    await press(badge(element)!)
    expect(element.querySelector('[data-view-refused]')).toBeNull()

    specs.push(authFlowV2 as ViewSpec)
    state.refused = null
    state.latest = 3
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(badge(element)).toBeUndefined()
    expect(text(element)).toContain('v3 of 3')
  })

  test('a version the window could not draw falls back to the one before it, under the same badge', async () => {
    const broken: ViewSpec = { title: 'Auth flow', root: { type: 'markdown', props: { text: 'the broken one' } } }
    const { fake, state } = startVersions([...authFlow, broken])
    state.refused = { attempt: 'render', version: 3, errors: ['a node failed'], source: '', at: 1 }
    const { element } = await mountSurface(fake)
    expect(text(element)).toContain('v2 of 3')
    expect(text(element)).toContain("v3 didn't render")
    expect(text(element)).not.toContain('the broken one')
    expect(element.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(fake.callsTo('quirky.view/render-failed')).toHaveLength(0)
  })

  test('two versions in a row that fail to render leave the card on the last version that rendered', async () => {
    const missing = (title: string): ViewSpec => ({ title, root: { type: 'image', props: { path: `docs/${title}.png`, alt: 'Nothing' } } })
    const good: ViewSpec = { title: 'Auth flow', root: { type: 'markdown', props: { text: 'the good one' } } }
    const { fake, state } = startVersions([good, missing('second'), missing('third')], {
      'quirky.session/markdownAssets': (params) => ({ images: Object.fromEntries((params.images as string[]).map((path) => [path, null])) }),
      'quirky.view/render-failed': (params) => {
        state.refused = { attempt: 'render', version: params.version as number, errors: [String(params.error)], source: '', at: 1 }
        return { ok: true }
      }
    })
    const { element } = await mountSurface(fake)
    await settle()
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    await settle()
    expect(text(element)).toContain('v1 of 3')
    expect(text(element)).toContain('the good one')
    expect(badge(element)!.textContent).toContain("v3 didn't render")
    expect(text(element)).not.toContain('is not an image')
    expect(fake.callsTo('quirky.view/render-failed').map((call) => call.params.version)).toEqual([3])
  })

  test('a frame that navigates is put back and reported once', async () => {
    const spec: ViewSpec = { title: 'Proto', root: { type: 'html', props: { html: '<a href="https://example.test">out</a>', interactive: true } } }
    const { fake } = startVersions([spec])
    const { element } = await mountSurface(fake, { viewId: 'view_nav' })
    await settle()
    const before = element.querySelector('iframe')!
    await act(async () => void before.dispatchEvent(new Event('load')))
    await settle()
    expect(fake.callsTo('quirky.view/render-failed').map((call) => call.params)).toEqual([{ viewId: 'view_nav', version: 1, error: 'navigation is not allowed' }])
    const after = element.querySelector('iframe')!
    expect(after).not.toBe(before)
    expect(after.getAttribute('srcdoc')).toBe(before.getAttribute('srcdoc'))

    await act(async () => void after.dispatchEvent(new Event('load')))
    await settle()
    expect(fake.callsTo('quirky.view/render-failed')).toHaveLength(1)
  })

  test('a version that is not the newest is never reported', async () => {
    const spec: ViewSpec = { title: 'Proto', root: { type: 'html', props: { html: '<p>x</p>', interactive: true } } }
    const { fake } = startVersions([spec, spec])
    const { element } = await mountSurface(fake, { viewId: 'view_old', version: 1 })
    await settle()
    await act(async () => void element.querySelector('iframe')!.dispatchEvent(new Event('load')))
    await settle()
    expect(fake.callsTo('quirky.view/render-failed')).toHaveLength(0)
  })
})

describe('the sandboxed html frame', () => {
  const proto = (interactive: boolean): ViewSpec => ({ title: 'Settings', root: { type: 'html', id: 'proto', props: { html: '<button data-point="save" data-point-label="Save">Save</button><script>window.x = 1</script>', interactive, height: 300 } } })

  const innerOf = (frame: Element) => {
    const wrapper = frame.getAttribute('srcdoc')!
    const holder = document.createElement('div')
    holder.innerHTML = wrapper
    const inner = holder.querySelector('iframe')!
    return { wrapper, inner, innerDoc: inner.getAttribute('srcdoc')! }
  }

  test('an interactive frame allows scripts only, never the same origin, and starts with the wrapper CSP meta', async () => {
    const fake = start([record(proto(true))])
    const { element } = await mountSurface(fake)
    const frame = element.querySelector('iframe')!
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(frame.style.height).toBe('300px')
    const { wrapper } = innerOf(frame)
    expect(wrapper.startsWith('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; frame-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'')).toBe(true)
    expect(wrapper.indexOf('Content-Security-Policy')).toBeLessThan(wrapper.indexOf('<script>'))
    expect(wrapper.indexOf('<script>')).toBeLessThan(wrapper.indexOf('<iframe'))
    for (const grant of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation']) expect(frame.getAttribute('sandbox')).not.toContain(grant)
  })

  test('the agent frame is nested in the wrapper with the page policy first and the same grants', async () => {
    const fake = start([record(proto(true))])
    const { element } = await mountSurface(fake)
    const { inner, innerDoc } = innerOf(element.querySelector('iframe')!)
    expect(inner.getAttribute('sandbox')).toBe('allow-scripts')
    expect(innerDoc.startsWith('<meta http-equiv="Content-Security-Policy" content="')).toBe(true)
    expect(innerDoc.indexOf('Content-Security-Policy')).toBeLessThan(innerDoc.indexOf('<button'))
    expect(innerDoc.indexOf('Content-Security-Policy')).toBeLessThan(innerDoc.indexOf('<script>'))
    expect(innerDoc).toContain("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; base-uri 'none'")
    expect(innerDoc).toContain('quirky-point')
    expect(innerDoc.endsWith('</script>')).toBe(true)
    expect(innerDoc).toContain('<button data-point="save"')
    for (const grant of ['allow-same-origin', 'allow-forms', 'allow-popups', 'allow-top-navigation']) expect(inner.getAttribute('sandbox')).not.toContain(grant)
  })

  test('a static html node runs no script in the agent frame and has no sandbox tag', async () => {
    const fake = start([record(proto(false))])
    const { element } = await mountSurface(fake)
    expect(element.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts')
    expect(innerOf(element.querySelector('iframe')!).inner.getAttribute('sandbox')).toBe('')
    expect(text(element)).not.toContain('sandboxed · no network')
  })

  test('an interactive html node carries the sandboxed, no network tag', async () => {
    const fake = start([record(proto(true))])
    const { element } = await mountSurface(fake)
    expect(text(element)).toContain('sandboxed · no network')
  })

  test('a point message from the frame itself points, and one from anywhere else is ignored', async () => {
    const fake = start([record(proto(true))])
    fake.commands[POINT] = () => {}
    const { element } = await mountSurface(fake)
    const frame = element.querySelector('iframe')!
    const send = async (source: unknown, data: unknown) => {
      await act(async () => void window.dispatchEvent(new MessageEvent('message', { data, source: source as never })))
      await settle()
    }

    await send(window, { type: 'quirky-point', key: 'save', label: 'Save' })
    await send(null, { type: 'quirky-point', key: 'save', label: 'Save' })
    await send(frame.contentWindow, { type: 'something-else', key: 'save' })
    await send(frame.contentWindow, 'quirky-point')
    expect(pointCalls(fake)).toEqual([])

    await send(frame.contentWindow, { type: 'quirky-point', key: 'save', label: 'Save' })
    await send(frame.contentWindow, { type: 'quirky-point', key: 'Not A Key!', label: '' })
    expect(pointCalls(fake)).toEqual([
      { session: 's1', viewId: 'view_1', version: 1, element: 'pt:save', label: 'Save' },
      { session: 's1', viewId: 'view_1', version: 1, element: 'pt:not-a-key', label: 'Not A Key!' }
    ])
  })

  test('the wrapper relays a point from the agent frame to the card, and nothing from anywhere else', async () => {
    const { FRAME_RELAY } = await import('../src/render/HtmlFrame')
    const agent = { name: 'agent' }
    const listeners: Array<(event: unknown) => void> = []
    const posted: unknown[] = []
    new Function('window', 'document', 'parent', FRAME_RELAY)(
      { addEventListener: (_type: string, listener: (event: unknown) => void) => void listeners.push(listener) },
      { getElementById: (id: string) => (id === 'agent' ? { contentWindow: agent } : null) },
      { postMessage: (data: unknown, target: string) => void posted.push([data, target]) }
    )
    const deliver = (source: unknown, data: unknown) => listeners[0]!({ source, data })
    deliver({ name: 'stranger' }, { type: 'quirky-point', key: 'save', label: 'Save' })
    deliver(null, { type: 'quirky-point', key: 'save', label: 'Save' })
    deliver(agent, { type: 'something-else', key: 'save' })
    deliver(agent, 'quirky-point')
    deliver(agent, null)
    expect(posted).toEqual([])
    deliver(agent, { type: 'quirky-point', key: 'save', label: 'Save', extra: 'dropped' })
    expect(posted).toEqual([[{ type: 'quirky-point', key: 'save', label: 'Save' }, '*']])
  })

  test('a point relayed through the wrapper reaches chat-point, and one that skips the wrapper does not', async () => {
    const fake = start([record(proto(true))])
    fake.commands[POINT] = () => {}
    const { element } = await mountSurface(fake)
    const outer = element.querySelector('iframe')!
    const innerWindow = { name: 'inner agent frame' }
    const send = async (source: unknown, data: unknown) => {
      await act(async () => void window.dispatchEvent(new MessageEvent('message', { data, source: source as never })))
      await settle()
    }
    await send(innerWindow, { type: 'quirky-point', key: 'save', label: 'Save' })
    expect(pointCalls(fake)).toEqual([])
    await send(outer.contentWindow, { type: 'quirky-point', key: 'save', label: 'Save' })
    expect(pointCalls(fake)).toEqual([{ session: 's1', viewId: 'view_1', version: 1, element: 'pt:save', label: 'Save' }])
  })

  test('the frame document puts the policy first and the agent html last', async () => {
    const { frameDocument } = await import('../src/render/HtmlFrame')
    const page = frameDocument('<p>hello</p>', ':root{}')
    expect(page.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(page.endsWith('<p>hello</p>')).toBe(true)
    expect(page.indexOf('<script>')).toBeLessThan(page.indexOf('<p>hello</p>'))
  })
})

describe('card chrome by surface', () => {
  const onlyTable: ViewSpec = { title: 'Table', root: { type: 'table', props: { columns: ['A'], rows: [['one']] } } }

  test('an inline card shows the title, who drew it, the stepper, expand, pop out and move', async () => {
    const { fake } = startVersions(authFlow)
    const { element } = await mountSurface(fake, { surface: 'inline' })
    expect(element.querySelector('h3')!.textContent).toBe('Auth flow')
    expect(text(element)).toContain('by omp')
    expect(text(element)).toContain('v2 of 2')
    expect(buttonByLabel(element, 'Expand')).not.toBeNull()
    expect(buttonByLabel(element, 'Pop out')).not.toBeNull()
    expect(buttonLabelled(element, 'Move to pane')).toBeTruthy()
  })

  test('a thumbnail draws an inert copy with no chrome and nothing to point at', async () => {
    const fake = start([record(onlyTable)])
    fake.commands[POINT] = () => {}
    const { element, press } = await mountSurface(fake, { surface: 'thumbnail' })
    expect(element.querySelector('header')).toBeNull()
    expect(element.querySelector('button')).toBeNull()
    expect(element.querySelector('h3')).toBeNull()
    expect(element.querySelector('article')!.hasAttribute('inert')).toBe(true)
    expect(element.querySelector('td')!.textContent).toBe('one')
    await press(element.querySelector('tbody tr')!)
    expect(pointCalls(fake)).toEqual([])
  })

  test('the expanded surface offers pop out but not expand, and a pop-out window offers neither', async () => {
    const { fake } = startVersions(authFlow)
    const expanded = await mountSurface(fake, { surface: 'expanded' })
    expect(buttonByLabel(expanded.element, 'Expand')).toBeNull()
    expect(buttonByLabel(expanded.element, 'Pop out')).not.toBeNull()
    const windowed = await mountSurface(fake, { surface: 'window' })
    expect(buttonByLabel(windowed.element, 'Expand')).toBeNull()
    expect(buttonByLabel(windowed.element, 'Pop out')).toBeNull()
    expect(buttonLabelled(windowed.element, 'Move to pane')).toBeUndefined()
  })

  test('a pop-out window steps through versions itself, because commands run in its owner', async () => {
    const { fake } = startVersions(authFlow)
    const { element, press } = await mountSurface(fake, { surface: 'window' })
    await press(buttonByLabel(element, 'Older version')!)
    expect(text(element)).toContain('v1 of 2')
    expect(fake.routedTo(CONTROL)).toEqual([])
  })

  test('pop out is hidden when the window cannot open auxiliary windows or does not say', async () => {
    const { fake } = startVersions(authFlow, { 'desktop.capabilities': () => ({ auxiliaryWindows: false }) })
    const { element } = await mountSurface(fake)
    expect(buttonByLabel(element, 'Pop out')).toBeNull()
    expect(buttonByLabel(element, 'Expand')).not.toBeNull()

    const bare = await mountSurface(start([record(bundleSize as ViewSpec)]))
    expect(buttonByLabel(bare.element, 'Pop out')).toBeNull()
  })

  test('pop out opens the render view in a window that follows the newest version', async () => {
    const { fake } = startVersions(authFlow, { 'desktop.window.open': () => ({ windowId: 'w1' }) })
    const { element, press } = await mountSurface(fake)
    await press(buttonByLabel(element, 'Pop out')!)
    expect(fake.callsTo('desktop.window.open').map((call) => call.params)).toEqual([
      { view: 'view:quirky.view/render', input: { viewId: 'view_1', surface: 'window' }, title: 'Auth flow' }
    ])
  })

  test('expand asks the chat to expand the visual, following the newest version unless the person stepped back', async () => {
    const { fake } = startVersions(authFlow)
    fake.commands[EXPAND] = () => {}
    const { element, press } = await mountSurface(fake)
    await press(buttonByLabel(element, 'Expand')!)
    await press(buttonByLabel(element, 'Older version')!)
    await press(buttonByLabel(element, 'Expand')!)
    expect(routedArgs(fake, EXPAND)).toEqual([{ session: 's1', viewId: 'view_1' }, { session: 's1', viewId: 'view_1', version: 1 }])
  })

  test('a card whose agent is still drawing says so and shows a pending frame', async () => {
    const { fake } = startVersions([authFlowV1 as ViewSpec])
    const { element } = await mountSurface(fake, { drawing: true })
    expect(element.querySelector('[data-view-drawing]')!.textContent).toBe('drawing Auth flow')
    expect(element.querySelector<HTMLElement>('article')!.style.borderStyle).toBe('dashed')
    const idle = await mountSurface(fake)
    expect(idle.element.querySelector('[data-view-drawing]')).toBeNull()
    expect(idle.element.querySelector<HTMLElement>('article')!.style.borderStyle).toBe('solid')
  })

  test('a pane visual draws on the panel surface, and an inline mount of it is a one-line record', async () => {
    const fake = start([record(markdownSpec('PANEL CONTENT'), { placement: 'pane' })])
    const panel = await mountSurface(fake)
    expect(text(panel.element)).toContain('PANEL CONTENT')
    const inline = await mountSurface(fake, { surface: 'inline' })
    expect(text(inline.element)).not.toContain('PANEL CONTENT')
    expect(text(inline.element)).toContain('Notes is in the Views pane')
  })

  test('the mount input keeps only what the card understands', async () => {
    const { parseRenderInput } = await import('../src/render/ViewCard')
    expect(parseRenderInput({ viewId: 'v', version: 2, surface: 'expanded', drawing: true, focused: false })).toEqual({ viewId: 'v', version: 2, surface: 'expanded', drawing: true, focused: false })
    expect(parseRenderInput({ viewId: 'v', version: 0, surface: 'sideways', drawing: 'yes', extra: 1 })).toEqual({ viewId: 'v' })
    expect(parseRenderInput({ viewId: '' })).toBeNull()
    expect(parseRenderInput(null)).toBeNull()
  })
})

describe('live preview', () => {
  type Mounted = { options: { id: string; url: string; partition: string; zoom: number }; disposed: boolean; requests: unknown[] }
  const previewSpec = (...urls: string[]): ViewSpec => ({ title: 'Preview', root: { type: 'stack', children: urls.map((url) => ({ type: 'live-preview' as const, props: { url } })) } })

  function nativeBrowser(fake: FakeContext) {
    const mountedViews: Mounted[] = []
    fake.environment.nativeBrowser = {
      available: true,
      mount: ((_element: HTMLElement, options: Mounted['options']) => {
        const entry: Mounted = { options, disposed: false, requests: [] }
        mountedViews.push(entry)
        return { request: async (request: unknown) => void entry.requests.push(request), evaluate: async () => null, dispose: () => void (entry.disposed = true) }
      }) as never
    }
    return mountedViews
  }

  test('one preview holds the native browser view, and the others show a placeholder with a Show button that moves it', async () => {
    const fake = start([record(previewSpec('http://localhost:5173/', 'http://localhost:5174/'))])
    const views = nativeBrowser(fake)
    const { element, press } = await mountSurface(fake)
    expect(views).toHaveLength(1)
    expect(views[0]!.options).toMatchObject({ url: 'http://localhost:5173/', partition: 'persist:quirky-browser-default', zoom: 0 })
    expect([...element.querySelectorAll('button')].filter((button) => button.textContent === 'Show')).toHaveLength(1)
    expect(text(element)).toContain('http://localhost:5174/')

    await press(buttonLabelled(element, 'Show'))
    expect(views).toHaveLength(2)
    expect(views[0]!.disposed).toBe(true)
    expect(views[1]!.options.url).toBe('http://localhost:5174/')
    expect(views[1]!.disposed).toBe(false)
    expect([...element.querySelectorAll('button')].filter((button) => button.textContent === 'Show')).toHaveLength(1)
  })

  test('the expanded preview takes the native view even when another one holds it', async () => {
    const holder = start([record(previewSpec('http://localhost:5173/'), { viewId: 'view_a' })])
    const views = nativeBrowser(holder)
    await mountSurface(holder, { viewId: 'view_a' })
    expect(views).toHaveLength(1)
    const other = start([record(previewSpec('http://localhost:5175/'), { viewId: 'view_b' })])
    other.environment.nativeBrowser = holder.environment.nativeBrowser
    await mountSurface(other, { viewId: 'view_b', surface: 'expanded' })
    expect(views).toHaveLength(2)
    expect(views[0]!.disposed).toBe(true)
    expect(views[1]!.options.url).toBe('http://localhost:5175/')
  })

  test('reload asks the native view to reload', async () => {
    const fake = start([record(previewSpec('http://localhost:5173/'))])
    const views = nativeBrowser(fake)
    const { element, press } = await mountSurface(fake)
    await press(buttonByLabel(element, 'Reload preview')!)
    expect(views[0]!.requests).toEqual([{ action: 'reload' }])
  })

  test('without a native browser the card shows the URL and offers the browser pane', async () => {
    const fake = start([record(previewSpec('http://localhost:5173/'))])
    fake.commands['command:quirky.browser/new-tab'] = () => {}
    const { element, press } = await mountSurface(fake)
    expect(text(element)).toContain('http://localhost:5173/')
    await press(buttonLabelled(element, 'Open in browser pane'))
    expect(routedArgs(fake, 'command:quirky.browser/new-tab')).toEqual([{ url: 'http://localhost:5173/' }])
  })

  test('a thumbnail never mounts the native browser', async () => {
    const fake = start([record(previewSpec('http://localhost:5173/'))])
    const views = nativeBrowser(fake)
    await mountSurface(fake, { surface: 'thumbnail' })
    expect(views).toHaveLength(0)
  })

  test('a failure to mount tells the person instead of leaving a blank box', async () => {
    const fake = start([record(previewSpec('http://localhost:5173/'))])
    fake.environment.nativeBrowser = { available: true, mount: (() => { throw new Error('unsupported native browser URL') }) as never }
    const { element } = await mountSurface(fake)
    expect(element.querySelector('[role="alert"]')!.textContent).toBe('Could not show the page: unsupported native browser URL')
  })
})

describe('the control command for card actions', () => {
  test('rejects card actions for a stale mount, the wrong card or bad arguments', async () => {
    const { fake } = startVersions(authFlow)
    await mountSurface(fake)
    const instance = await instanceFor(fake, RENDER)
    await expect(fake.runCommand(CONTROL, { instance, action: 'show-version', viewId: 'view_1', version: 0 })).rejects.toThrow('Invalid view version.')
    await expect(fake.runCommand(CONTROL, { instance, action: 'show-version', viewId: 'view_1' })).rejects.toThrow('Invalid view version.')
    await expect(fake.runCommand(CONTROL, { instance, action: 'expand', viewId: 'view_1', extra: true })).rejects.toThrow('Invalid view control arguments.')
    await expect(fake.runCommand(CONTROL, { instance: 'gone', action: 'expand', viewId: 'view_1' })).rejects.toThrow('View UI instance is no longer mounted.')
    await expect(fake.runCommand(CONTROL, { instance, action: 'show-preview', viewId: 'view_1', node: '' })).rejects.toThrow('Invalid live preview.')
    await fake.runCommand(CONTROL, { instance, action: 'show-version', viewId: 'view_1', version: 1 })
    expect(fake.callsTo('quirky.view/get').at(-1)!.params).toEqual({ viewId: 'view_1', version: 1 })
  })

  test('a pane has no stepper, and a card command it cannot run is refused', async () => {
    const fake = start([record(bundleSize as ViewSpec, { placement: 'pane', updates: 1, latestVersion: 2, version: 2 })])
    const view = await mountView(fake, PANE, { session: 's1' })
    mounted.push(view)
    expect(view.element.querySelector('[data-view-stepper]')).toBeNull()
    const instance = await instanceFor(fake, PANE)
    await expect(fake.runCommand(CONTROL, { instance, action: 'show-version', viewId: 'view_1', version: 1 })).rejects.toThrow('View action is not available for this mount.')
  })
})

test('view surfaces pass every applicable static scoreboard check and ratchet', () => {
  const root = resolve(import.meta.dir, '../../..')
  const inventory = collectInventory(root)
  const plugin = inventory.plugins.find((entry) => entry.id === 'quirky.view')!
  const checks = checkPlugin(inventory, plugin.id)
  expect(checks.map(({ id, status, applicable }) => ({ id, status, applicable }))).toEqual(
    (['compatibility-tokens', 'loading', 'empty', 'error', 'commands'] as const).map((id) => ({ id, status: 'pass', applicable: true }))
  )
  const coverage = JSON.parse(plugin.coverage!.content)
  expect(Object.keys(coverage.surfaces).sort()).toEqual([PANE, RENDER].sort())
  for (const surface of [PANE, RENDER]) {
    for (const state of ['loading', 'empty', 'error']) expect(coverage.surfaces[surface][state]).toEqual({ applicable: true })
  }
  const graph = discoverUiFiles(plugin)
  expect(graph.failures).toEqual([])
  expect(graph.files).toContain('plugins/quirky.view/src/core/contract.ts')
  expect(graph.files).not.toContain('plugins/quirky.view/src/core/catalog.ts')
  const ratchet = JSON.parse(readFileSync(resolve(root, 'scripts/ui-scoreboard-ratchet.json'), 'utf8'))
  expect(ratchet['quirky.view']?.slice().sort()).toEqual(['commands', 'compatibility-tokens', 'empty', 'error', 'loading'])
})
