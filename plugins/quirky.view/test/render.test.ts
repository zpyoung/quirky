import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import bundleSize from './fixtures/bundle-size.json'
import { CATALOG_TYPES, COMPONENTS, type ViewSpec } from '../src/core/catalog'
import { fakeContext, mountView, record, settle, type FakeContext } from './ui-fake'

const RENDER = 'view:quirky.view/render'
const PANE = 'view:quirky.view/pane'

let activate: (context: UiPluginContext) => void
let mounted: Awaited<ReturnType<typeof mountView>> | undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  activate = ((await import('../src/ui')) as { activate: typeof activate }).activate
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  await mounted?.unmount()
  mounted = undefined
  document.body.innerHTML = ''
})

const markdownSpec = (text: string): ViewSpec => ({ title: 'Notes', root: { type: 'markdown', props: { text } } })

function start(records: ReturnType<typeof record>[], extra: Record<string, (params: Record<string, any>) => unknown> = {}): FakeContext {
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

async function mountCard(fake: FakeContext, viewId = 'view_1') {
  mounted = await mountView(fake, RENDER, { viewId })
  return mounted
}

const text = (root: Element) => root.textContent ?? ''
const buttonLabelled = (root: Element, label: string) =>
  [...root.querySelectorAll('button')].find((button) => button.textContent?.trim() === label) as HTMLButtonElement

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
    await click(buttonLabelled(element, 'Send'))

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
      { viewId: 'view_1', name: 'next-step', source: 'field', data: { value: 'lazy' } }
    ])
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
    const sends = [...element.querySelectorAll('button')].filter((button) => button.textContent === 'Send')
    for (const send of sends) await click(send)

    expect(fake.callsTo('quirky.view/action').map((call) => call.params)).toEqual([
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
    mounted = await mountView(fake, RENDER, {})
    expect(mounted.element.innerHTML).toBe('')
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

  test('a link click asks first and opens it only on confirm', async () => {
    const { element, click, fake } = await rendered('[docs](https://example.com/docs)')
    const link = element.querySelector('a')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => void link.dispatchEvent(event))

    expect(event.defaultPrevented).toBe(true)
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('https://example.com/docs')
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)

    await click(buttonLabelled(dialog, 'Open link'))
    expect(fake.callsTo('quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: 'https://example.com/docs' }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  test('cancelling the link dialog opens nothing', async () => {
    const { element, click, fake } = await rendered('[docs](https://example.com/docs)')
    await click(element.querySelector('a')!)
    await click(buttonLabelled(document.querySelector('[role="dialog"]')!, 'Cancel'))

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(fake.callsTo('quirky.terminal/openExternal')).toHaveLength(0)
  })
})

describe('the views pane', () => {
  const paneView = (viewId: string, title: string, over: Partial<ReturnType<typeof record>> = {}) =>
    record(markdownSpec(`${title} body`), { viewId, title, placement: 'pane', ...over })

  const mountPane = async (fake: FakeContext) => {
    mounted = await mountView(fake, PANE, { session: 's1' })
    return mounted
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
  })

  test('renders nothing when the session has no pane views', async () => {
    const fake = start([record(markdownSpec('inline body'), { viewId: 'view_3', placement: 'inline' }), paneView('view_4', 'Gone', { closed: true })])
    const { element } = await mountPane(fake)
    expect(element.innerHTML).toBe('')
  })

  test('Move inline in the pane moves that view and the pane follows the change', async () => {
    const records = [paneView('view_1', 'Bundle size')]
    const fake = start(records)
    const { element, click } = await mountPane(fake)

    await click(buttonLabelled(element, 'Move inline'))
    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])

    records[0] = { ...records[0], placement: 'inline', movedByUser: true }
    await fake.emit({ type: 'quirky.view/changed', data: { sessionId: 's1', viewId: 'view_1' } })
    await settle()
    expect(element.innerHTML).toBe('')
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
  })

  test('a card whose view is in the pane offers Move inline', async () => {
    const fake = start([record(bundleSize as ViewSpec, { placement: 'pane' })])
    const { element, click } = await mountCard(fake)

    expect(buttonLabelled(element, 'Move to pane')).toBeUndefined()
    await click(buttonLabelled(element, 'Move inline'))

    expect(fake.callsTo('quirky.view/move').map((call) => call.params)).toEqual([{ viewId: 'view_1', placement: 'inline' }])
  })
})
