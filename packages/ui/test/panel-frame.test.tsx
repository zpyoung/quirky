import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Tabs, ToolPanelFrame, ToolPanelTabs, ToolPanelTools } from '../src/design-system'

let root: Root | null = null
let container: HTMLDivElement
const extraRoots = new Set<Root>()

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  for (const extra of [...extraRoots].reverse()) await act(async () => extra.unmount())
  extraRoots.clear()
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const render = (node: ReactNode) => act(async () => root!.render(node))
function mountIn(target: HTMLElement): Root {
  const next = createRoot(target)
  extraRoots.add(next)
  return next
}

const cssSource = readFileSync(join(import.meta.dir, '../src/design-system/components.css'), 'utf8')
const rulesFor = (selectorFragment: string) =>
  [...cssSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1]!.includes(selectorFragment))
    .map((match) => ({ selector: match[1]!.trim(), body: match[2]! }))

describe('panel frame slots', () => {
  test('tabs and tools props render in the header after the title and in the left rail', async () => {
    await render(
      <ToolPanelFrame title="Ledger" tabs={<button>Today</button>} tools={<button aria-label="Filter">F</button>}>
        <p>rows</p>
      </ToolPanelFrame>
    )
    const header = container.querySelector('header')!
    const children = [...header.children]
    const title = header.querySelector('h2')!
    const tab = header.querySelector('[data-ui-tool-panel-tabs-target] button')
    expect(tab?.textContent).toBe('Today')
    expect(children.indexOf(tab!.closest('[data-ui-tool-panel-tabs-target]')!)).toBeGreaterThan(children.indexOf(title))
    const rail = container.querySelector('section > .ui-tool-panel-frame__rail')!
    expect(rail.querySelector('button[aria-label="Filter"]')).not.toBeNull()
    expect(rail.nextElementSibling?.classList.contains('ui-tool-panel-frame__body')).toBe(true)
    expect(container.querySelector('.ui-tool-panel-frame__body')?.textContent).toBe('rows')
  })

  test('the rail and tab targets exist but hold nothing when unused', async () => {
    await render(<ToolPanelFrame title="Plain"><p>rows</p></ToolPanelFrame>)
    const tabs = container.querySelector('[data-ui-tool-panel-tabs-target]')!
    const rail = container.querySelector('[data-ui-tool-panel-rail-target]')!
    expect(tabs.parentElement?.tagName).toBe('HEADER')
    expect(rail.parentElement?.tagName).toBe('SECTION')
    expect(tabs.childNodes).toHaveLength(0)
    expect(rail.childNodes).toHaveLength(0)
    expect(cssSource).toMatch(/\[data-ui-tool-panel-tabs-target\]:empty|\.ui-tool-panel-frame__tabs:empty/)
    expect(cssSource).toMatch(/\.ui-tool-panel-frame__rail:empty/)
  })

  test('ToolPanelTools and ToolPanelTabs portal into the nearest frame only', async () => {
    const second = document.createElement('div')
    document.body.append(second)
    const secondRoot = mountIn(second)
    await act(async () => {
      root!.render(<ToolPanelFrame title="First"><div data-plugin="first" /></ToolPanelFrame>)
      secondRoot.render(<ToolPanelFrame title="Second"><div data-plugin="second" /></ToolPanelFrame>)
    })
    const firstPlugin = mountIn(container.querySelector<HTMLElement>('[data-plugin="first"]')!)
    const orphan = document.createElement('div')
    document.body.append(orphan)
    const orphanRoot = mountIn(orphan)
    await act(async () => {
      firstPlugin.render(<><ToolPanelTools><button aria-label="Refresh">R</button></ToolPanelTools><ToolPanelTabs><button>Week</button></ToolPanelTabs></>)
      orphanRoot.render(<><ToolPanelTools><button aria-label="Lost tool">L</button></ToolPanelTools><ToolPanelTabs><button>Lost tab</button></ToolPanelTabs></>)
    })
    expect(container.querySelector('.ui-tool-panel-frame__rail button[aria-label="Refresh"]')).not.toBeNull()
    expect(container.querySelector('header [data-ui-tool-panel-tabs-target] button')?.textContent).toBe('Week')
    expect(second.querySelector('.ui-tool-panel-frame__rail')?.childNodes).toHaveLength(0)
    expect(second.querySelector('[data-ui-tool-panel-tabs-target]')?.childNodes).toHaveLength(0)
    expect(document.querySelector('button[aria-label="Lost tool"]')).toBeNull()
    expect(document.body.textContent).not.toContain('Lost tab')
  })

  test('a nested frame forwards tabs, tools and actions to the host and renders only its body', async () => {
    await render(<ToolPanelFrame title="Tasks"><div data-plugin="tasks" /></ToolPanelFrame>)
    const plugin = mountIn(container.querySelector<HTMLElement>('[data-plugin="tasks"]')!)
    await act(async () => {
      plugin.render(
        <ToolPanelFrame
          title="Tasks"
          tabs={<button>Open</button>}
          tools={<button aria-label="Sort">S</button>}
          actions={<button aria-label="Add task">+</button>}
        >
          <p>Issues</p>
        </ToolPanelFrame>
      )
    })
    expect(container.querySelectorAll('h2')).toHaveLength(1)
    expect(container.querySelectorAll('section')).toHaveLength(1)
    expect(container.querySelector('header [data-ui-tool-panel-tabs-target] button')?.textContent).toBe('Open')
    expect(container.querySelector('.ui-tool-panel-frame__rail button[aria-label="Sort"]')).not.toBeNull()
    expect(container.querySelector('header .ui-tool-panel-frame__actions button[aria-label="Add task"]')).not.toBeNull()
    expect(container.querySelector('.ui-tool-panel-frame__body')?.textContent).toBe('Issues')
  })

  test('minimize shows the minus control icon under its Minimize label', async () => {
    const calls: number[] = []
    await render(<ToolPanelFrame title="Changes" onMinimize={() => calls.push(1)}><p>x</p></ToolPanelFrame>)
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Minimize Changes"]')!
    expect(button.querySelector('svg.ui-control-icon')).not.toBeNull()
    expect(button.textContent).not.toContain('−')
    await act(async () => { button.click() })
    expect(calls).toEqual([1])
  })

  test('Tabs renders a muted count after the label', async () => {
    await render(<Tabs label="Range" value="today" onChange={() => {}} items={[{ id: 'today', label: 'Today', count: 12 }, { id: 'week', label: 'Week' }]} />)
    const [today, week] = [...container.querySelectorAll('[role="tab"]')]
    expect(today!.textContent).toBe('Today12')
    expect(today!.querySelector('.ui-tabs__count')?.textContent).toBe('12')
    expect(week!.querySelector('.ui-tabs__count')).toBeNull()
  })
})

describe('panel focus styles', () => {
  test('hidden header buttons use opacity, never display or visibility, so they stay in the tab order', () => {
    const hidden = rulesFor('.ui-tool-panel-frame__actions').filter((rule) => rule.selector.includes('[data-tool-panel]') && !rule.selector.includes(':hover') && !rule.selector.includes('data-panel-focused') && !rule.selector.includes(':focus-within'))
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.map((rule) => rule.body).join('\n')).toMatch(/opacity:\s*0\b/)
    for (const rule of hidden) expect(rule.body).not.toMatch(/display:\s*none|visibility:\s*hidden/)
  })

  test('reveal covers a focused, hovered or focus-within panel and is limited to tool panels', () => {
    const reveal = rulesFor('.ui-tool-panel-frame__actions').filter((rule) => /opacity:\s*1\b/.test(rule.body))
    const selectors = reveal.map((rule) => rule.selector).join(',')
    expect(selectors).toContain('[data-tool-panel][data-panel-focused]')
    expect(selectors).toContain('[data-tool-panel]:hover')
    expect(selectors).toContain('[data-tool-panel]:focus-within')
    const hiding = rulesFor('.ui-tool-panel-frame__actions').filter((rule) => /opacity:\s*0\b/.test(rule.body))
    for (const rule of hiding) {
      for (const part of rule.selector.split(',')) expect(part).toContain('[data-tool-panel]')
    }
  })

  test('an accent selected row lives under data-panel-focused and beats the tree rule', () => {
    const accent = rulesFor('[data-panel-focused]').filter((rule) => rule.selector.includes('.ui-list-row--selected') && /background:\s*var\(--ui-accent\)/.test(rule.body))
    expect(accent.length).toBeGreaterThan(0)
    expect(accent.map((rule) => rule.selector).join(',')).toContain('.ui-tree .ui-list-row--selected')
    expect(accent.map((rule) => rule.body).join('\n')).toMatch(/color:\s*var\(--ui-rail\)/)
    const plain = rulesFor('.ui-list-row--selected').filter((rule) => !rule.selector.includes('data-panel-focused'))
    expect(plain.map((rule) => rule.body).join('\n')).toContain('var(--ui-selected)')
    expect(plain.map((rule) => rule.body).join('\n')).not.toContain('var(--ui-accent)')
  })

  test('a status dot in an accent row gets a ring', () => {
    const ring = rulesFor('.ui-status-dot').filter((rule) => rule.selector.includes('[data-panel-focused]') && rule.selector.includes('.ui-list-row--selected'))
    expect(ring.length).toBeGreaterThan(0)
    expect(ring.map((rule) => rule.body).join('\n')).toMatch(/outline|box-shadow/)
  })

  test('the inactive window dims by opacity, not filter', () => {
    const stylesSource = readFileSync(join(import.meta.dir, '../src/styles.css'), 'utf8')
    const dim = [...stylesSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1]!.includes('.app[data-window-inactive]'))
    expect(dim).toHaveLength(1)
    expect(dim[0]![2]).toMatch(/opacity:\s*var\(--ui-window-inactive-opacity\)/)
    expect(dim[0]![2]).not.toContain('filter')
  })
})
