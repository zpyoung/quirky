import { afterEach, expect, test } from 'bun:test'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(closeWindows)

const SECTION = 'sidebar-section:acme.shell/list'
const PAGE = 'view:acme.shell/page'
const OTHER = 'view:acme.shell/other'
const OUTLINE = 'panel:acme.shell/outline'

const slot = (id: string) => `[data-plugin-slot="${id}"]`
const region = (name: string) => `[data-region="${name}"]`

/** A plugin with a tool contribution, two views and a panel. */
function writeShellPlugin(installed: string): void {
  installUiPlugin(
    installed,
    'acme.shell',
    {
      'sidebar-section': [{ id: 'list', title: 'Notes' }],
      panel: [{ id: 'outline', title: 'Outline', defaultSlot: 'left-top', icon: 'git-branch' }],
      view: [
        { id: 'page', title: 'Page' },
        { id: 'other', title: 'Other' }
      ]
    },
    [
      provide(
        SECTION,
        `const b = document.createElement('button'); b.id = 'go-other'; b.textContent = 'Go other'
         b.onclick = () => context.openView(${JSON.stringify(OTHER)}, { from: 'sidebar' })
         element.append(b)`
      ),
      provide(
        PAGE,
        `const b = document.createElement('button'); b.id = 'page-open-other'; b.textContent = 'Open other'
         b.onclick = () => context.openView(${JSON.stringify(OTHER)}, { n: 2 })
         const t = document.createElement('p'); t.id = 'page-text'; t.textContent = 'page ' + JSON.stringify(props.input ?? null)
         element.append(t, b)`
      ),
      provide(OTHER, `element.textContent = 'other ' + JSON.stringify(props.input ?? null)`),
      provide(OUTLINE, `element.textContent = 'outline panel'`)
    ].join('\n')
  )
}

async function boot(): Promise<WindowEnv> {
  const env = await bootWindow(writeShellPlugin)
  await env.agent.callAny('ui.tool.open', { id: SECTION })
  await env.win.waitFor(() => env.win.host.getState().slots[SECTION]?.status === 'mounted')
  return env
}

test('tool stripes toggle panels and move tools with pointer and keyboard context menus', async () => {
  const env = await boot()
  const tools = async () => {
    const state = (await env.agent.callAny('ui.state', {})) as {
      layout: {
        tools?: {
          open: Record<string, string | null>
          placements: Record<string, string>
        }
      }
    }
    return state.layout.tools
  }
  const menu = () => env.win.document.querySelector<HTMLElement>('[role="menu"][aria-label="Move Outline"]')
  const menuItems = (element: HTMLElement) => [...element.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const itemNamed = (element: HTMLElement, label: string) => menuItems(element).find((item) => item.textContent?.includes(label))
  const key = async (element: Element, value: string, options: KeyboardEventInit = {}) => {
    element.dispatchEvent(new KeyboardEvent('keydown', { ...options, key: value, bubbles: true, cancelable: true }))
    await Promise.resolve()
  }
  const icon = await env.win.waitFor(() => env.win.document.querySelector<HTMLButtonElement>('button[aria-label="Outline"]'))

  expect(icon.getAttribute('title')).toBe('Outline')
  expect(icon.getAttribute('aria-pressed')).toBe('false')
  expect(icon.getAttribute('draggable')).toBe('true')
  expect(icon.parentElement?.querySelectorAll('button')).toHaveLength(1)
  await env.win.click('button[aria-label="Outline"]')
  await env.win.waitFor(async () => (await tools())?.open['left-top'] === OUTLINE)
  expect(env.win.document.querySelector('button[aria-label="Outline"]')?.getAttribute('aria-pressed')).toBe('true')
  await env.win.click('button[aria-label="Outline"]')
  await env.win.waitFor(async () => (await tools())?.open['left-top'] === null)
  expect(env.win.document.querySelector('button[aria-label="Outline"]')?.getAttribute('aria-pressed')).toBe('false')

  const pointerIcon = await env.win.waitFor(() => env.win.document.querySelector<HTMLButtonElement>('button[aria-label="Outline"]'))
  pointerIcon.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 50 }))
  const pointerMenu = await env.win.waitFor(menu)
  expect(menuItems(pointerMenu).map((item) => item.textContent?.trim())).toHaveLength(6)
  for (const destination of ['Left top', 'Left bottom', 'Right top', 'Right bottom', 'Bottom left', 'Bottom right']) {
    expect(itemNamed(pointerMenu, destination)).toBeDefined()
  }
  expect(itemNamed(pointerMenu, 'Left top')?.disabled).toBe(true)
  expect(itemNamed(pointerMenu, 'Left top')?.getAttribute('aria-disabled')).toBe('true')
  itemNamed(pointerMenu, 'Left bottom')!.click()
  await env.win.waitFor(async () => (await tools())?.placements[OUTLINE] === 'left-bottom')

  const keyboardIcon = await env.win.waitFor(() => env.win.document.querySelector<HTMLButtonElement>('button[aria-label="Outline"]'))
  keyboardIcon.focus()
  keyboardIcon.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
  const keyboardMenu = await env.win.waitFor(menu)
  expect(itemNamed(keyboardMenu, 'Left bottom')?.disabled).toBe(true)
  await key(keyboardMenu, 'ArrowDown')
  await key(keyboardMenu, 'Enter')
  await env.win.waitFor(async () => {
    const placement = (await tools())?.placements[OUTLINE]
    return placement === 'left-top' || placement === 'right-top'
  })

  const focusedIcon = await env.win.waitFor(() => env.win.document.querySelector<HTMLButtonElement>('button[aria-label="Outline"]'))
  focusedIcon.focus()
  focusedIcon.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }))
  const dismissMenu = await env.win.waitFor(menu)
  await key(dismissMenu, 'Escape')
  await env.win.waitFor(() => !menu() && env.win.document.activeElement === focusedIcon)
  expect(env.win.document.activeElement).toBe(focusedIcon)
})


test('the window follows view, panel compatibility, and focus APIs through canonical tool state', async () => {
  const env = await boot()
  const { win, agent } = env

  await agent.callAny('ui.view.open', { id: PAGE, input: { n: 1 } })
  await win.waitFor(() => win.document.querySelector('#page-text')?.textContent === 'page {\"n\":1}')
  expect(win.document.querySelector(`${region('view')} ${slot(PAGE)}`)).not.toBeNull()
  expect([...win.document.querySelectorAll('[role=\"tab\"]')].some((tab) => tab.textContent === 'Page')).toBe(true)

  await agent.callAny('ui.panel.open', { id: OUTLINE })
  await win.waitFor(() => win.document.querySelector(slot(OUTLINE))?.textContent === 'outline panel')
  const opened = (await agent.callAny('ui.state', {})) as {
    layout: { panel: string | null; tools?: { open: Record<string, string | null> } }
  }
  expect(opened.layout.panel).toBe(OUTLINE)
  expect(Object.values(opened.layout.tools?.open ?? {}).includes(OUTLINE)).toBe(true)

  await agent.callAny('ui.focus', { target: 'panel' })
  await win.waitFor(() => win.host.getState().layout.focus === 'panel')

  await agent.callAny('ui.panel.close', {})
  await win.waitFor(() => win.document.querySelector(slot(OUTLINE)) === null)
  expect(Object.values(win.host.getState().layout.tools?.open ?? {})).not.toContain(OUTLINE)

  await agent.callAny('ui.view.close', {})
  await win.waitFor(() => win.host.getState().layout.view === null)
})
test('a view stays mounted while canonical focus changes', async () => {
  const { win, agent } = await boot()
  await agent.callAny('ui.view.open', { id: PAGE, input: { n: 1 } })
  await win.waitFor(() => win.document.querySelector('#page-text'))
  const before = win.document.querySelector('#page-text')

  await agent.callAny('ui.focus', { target: 'panel' })
  await win.waitFor(() => win.host.getState().layout.focus === 'panel')
  await agent.callAny('ui.focus', { target: 'view' })
  await win.waitFor(() => win.host.getState().layout.focus === 'view')

  expect(win.document.querySelector('#page-text')).toBe(before)
})


test('SC-37: a click inside a view that calls context.openView changes the daemon layout', async () => {
  const { win, agent } = await boot()
  await agent.callAny('ui.view.open', { id: PAGE })
  await win.waitFor(() => win.document.querySelector('#page-open-other'))

  await win.click('#page-open-other')

  await win.waitFor(async () => {
    const state = (await agent.callAny('ui.state', {})) as { layout: { view: { id: string; input: unknown } | null } }
    return state.layout.view?.id === OTHER && JSON.stringify(state.layout.view.input) === '{"n":2}'
  })
  await win.waitFor(() => win.document.querySelector(slot(OTHER))?.textContent === 'other {"n":2}')
})

test('an open tool contribution can navigate to a view without losing its slot placement', async () => {
  const { win, agent } = await boot()
  await win.click('#go-other')

  await win.waitFor(async () => {
    const state = (await agent.callAny('ui.state', {})) as {
      layout: { view: { id: string; input?: unknown } | null; tools: { open: Record<string, string | null> } }
    }
    return state.layout.view?.id === OTHER && JSON.stringify(state.layout.view.input) === '{\"from\":\"sidebar\"}'
  })
  const state = (await agent.callAny('ui.state', {})) as { layout: { tools: { open: Record<string, string | null> } } }
  expect(Object.values(state.layout.tools.open)).toContain(SECTION)
})

test('clicking an open tool and the main view reports canonical focus', async () => {
  const { win, agent } = await boot()
  const focus = async () => ((await agent.callAny('ui.state', {})) as { layout: { focus: string | null } }).layout.focus

  await win.click(slot(SECTION))
  await win.waitFor(async () => (await focus()) === 'panel')
  await win.click(region('view'))
  await win.waitFor(async () => (await focus()) === 'view')
})

test('view and compatibility panel updates reach the same tool layout', async () => {
  const env = await boot()
  await env.agent.callAny('ui.view.open', { id: OTHER, input: { late: true } })
  await env.agent.callAny('ui.panel.open', { id: OUTLINE })
  await env.win.waitFor(() => env.win.document.querySelector(slot(OUTLINE)))
  const state = env.win.host.getState()
  expect(state.layout.view).toEqual({ id: OTHER, input: { late: true } })
  expect(state.layout.panel).toBe(OUTLINE)
  expect(Object.values(state.layout.tools?.open ?? {}).includes(OUTLINE)).toBe(true)
})


test('the confirm dialog backs context.confirm', async () => {
  const env = await bootWindow((installed) =>
    installUiPlugin(
      installed,
      'acme.ask',
      { view: [{ id: 'page', title: 'Ask' }] },
      provide(
        'view:acme.ask/page',
        `const b = document.createElement('button'); b.id = 'ask'; b.textContent = 'Ask'
         b.onclick = async () => {
           const ok = await context.confirm({ title: 'Remove it', body: 'Really remove it?', confirmLabel: 'Remove' })
           await context.call('ui.view.open', { id: 'view:acme.ask/page', input: { answer: ok } })
         }
         element.append(b)`
      )
    )
  )
  await env.agent.callAny('ui.view.open', { id: 'view:acme.ask/page' })
  await env.win.waitFor(() => env.win.document.querySelector('#ask'))
  await env.win.click('#ask')

  const dialog = await env.win.waitFor(() => env.win.document.querySelector('[role="dialog"]'))
  const buttons = dialog.querySelectorAll('button')
  buttons[1]!.click()

  await env.win.waitFor(async () => {
    const state = (await env.agent.callAny('ui.state', {})) as { layout: { view: { input?: { answer: boolean } } } }
    return state.layout.view?.input?.answer === true
  })
  expect(env.win.document.querySelector('[role="dialog"]')).toBeNull()
})

test('a notify toast opens its exact view through the host and clears its presentation state', async () => {
  const { win } = await boot()
  win.store.dispatch({
    type: 'event',
    event: { type: 'notify', title: 'Done', body: 'main finished', desktop: false, open: { view: OTHER, input: { from: 'toast' } } }
  })
  await win.waitFor(() => win.document.querySelector('[role=\"status\"][aria-atomic=\"true\"]'))
  await win.click('[role=\"status\"][aria-atomic=\"true\"]')
  await win.waitFor(() => win.host.getState().layout.view?.id === OTHER)
  expect(win.host.getState().layout.view?.input).toEqual({ from: 'toast' })
  expect(win.store.getState().toasts).toEqual([])
})

const HUD = 'overlay:acme.hud/hud'
const QUIET = 'overlay:acme.hud/quiet'
const overlayBody = (env: WindowEnv, id: string) => env.win.document.querySelector(`[data-plugin-overlay="${id}"]`)
const slotStates = async (env: WindowEnv) =>
  ((await env.agent.callAny('ui.state', {})) as { slots: { id: string; kind: string; shown: boolean; report?: unknown }[] }).slots

/** A plugin with two overlays: `hud` reports its own state, `quiet` never reports. */
function writeOverlayPlugin(installed: string): void {
  installUiPlugin(
    installed,
    'acme.hud',
    {
      overlay: [
        { id: 'hud', title: 'Hud', order: 1 },
        { id: 'quiet', title: 'Quiet', order: 2 }
      ]
    },
    [
      provide(
        HUD,
        `const b = document.createElement('button'); b.id = 'hud-hide'; b.textContent = 'Hide'
         b.onclick = () => props.report({ label: 'hud', shown: false })
         element.append(b)
         props.report({ label: 'hud', shown: true })`
      ),
      provide(QUIET, `element.id = 'quiet-body'; element.textContent = 'quiet'`)
    ].join('\n')
  )
}



test('SC-67: ui state lists the overlays with their reports, and a silent overlay is shown with an empty report', async () => {
  const env = await bootWindow(writeOverlayPlugin)
  await env.win.waitFor(async () => (await slotStates(env)).find((slot) => slot.id === HUD)?.report !== undefined)

  const slots = (await slotStates(env)).filter((slot) => slot.kind === 'overlay')
  expect(slots.map((slot) => slot.id)).toEqual([HUD, QUIET])
  expect(slots.find((slot) => slot.id === HUD)).toMatchObject({ shown: true, report: { label: 'hud', shown: true } })
  await env.win.waitFor(async () => (await slotStates(env)).find((slot) => slot.id === QUIET)?.shown === true)
  expect((await slotStates(env)).find((slot) => slot.id === QUIET)!.report).toEqual({})
})

test('SC-67: the overlay reporting shown false turns shown off in ui state, and a click inside it still reaches the plugin', async () => {
  const env = await bootWindow(writeOverlayPlugin)
  await env.win.waitFor(() => overlayBody(env, HUD)?.querySelector('#hud-hide'))
  await env.win.waitFor(async () => (await slotStates(env)).find((slot) => slot.id === HUD)?.shown === true)

  await env.win.click('#hud-hide')
  await env.win.waitFor(async () => (await slotStates(env)).find((slot) => slot.id === HUD)?.shown === false)
  expect((await slotStates(env)).find((slot) => slot.id === HUD)!.report).toEqual({ label: 'hud', shown: false })
})

test('SC-67: disabling the plugin removes the overlays from the window and from ui state', async () => {
  const env = await bootWindow(writeOverlayPlugin)
  await env.win.waitFor(() => overlayBody(env, HUD)?.querySelector('#hud-hide'))

  await env.agent.callAny('plugin.disable', { id: 'acme.hud' })
  await env.win.waitFor(() => overlayBody(env, HUD) === null && overlayBody(env, QUIET) === null)
  await env.win.waitFor(async () => !(await slotStates(env)).some((slot) => slot.kind === 'overlay'))
})

