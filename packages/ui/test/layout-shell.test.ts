import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

afterEach(closeWindows)

const SECTION = 'sidebar-section:acme.shell/list'
const PAGE = 'view:acme.shell/page'
const OTHER = 'view:acme.shell/other'
const OUTLINE = 'panel:acme.shell/outline'

const slot = (id: string) => `[data-plugin-slot="${id}"]`
const region = (name: string) => `[data-region="${name}"]`

/** A plugin with a sidebar section, two views and a panel; each fills its element with a marker the tests look for. */
function writeShellPlugin(installed: string): void {
  installUiPlugin(
    installed,
    'acme.shell',
    {
      'sidebar-section': [{ id: 'list', title: 'Notes' }],
      panel: [{ id: 'outline', title: 'Outline' }],
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
  await env.win.waitFor(() => env.win.host.getState().slots[SECTION]?.status === 'mounted')
  return env
}

const text = (env: WindowEnv) => env.win.document.body.textContent ?? ''

test('the window shows the sidebar section, an empty main area and a toggle for each panel', async () => {
  const env = await boot()
  const { win } = env
  expect(win.document.querySelector(`${region('sidebar')} ${slot(SECTION)}`)).not.toBeNull()
  expect(text(env)).toContain('Add a repo and pick a worktree to get started.')
  const toggle = win.document.querySelector('.main-header button') as HTMLButtonElement
  expect(toggle.textContent).toBe('Outline')
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
})

test('SC-36: the window follows ui.view.open, ui.panel.open and ui.focus from another client', async () => {
  const env = await boot()
  const { win, agent } = env

  await agent.callAny('ui.view.open', { id: PAGE, input: { n: 1 } })
  await win.waitFor(() => win.document.querySelector('#page-text')?.textContent === 'page {"n":1}')
  expect(win.document.querySelector(`${region('view')} ${slot(PAGE)}`)).not.toBeNull()
  expect(win.document.querySelector('.main-title')?.textContent).toBe('Page')

  await agent.callAny('ui.panel.open', { id: OUTLINE })
  await win.waitFor(() => win.document.querySelector(slot(OUTLINE))?.textContent === 'outline panel')
  expect(win.document.querySelector('.main-header button')?.getAttribute('aria-pressed')).toBe('true')

  await agent.callAny('ui.focus', { target: 'panel' })
  await win.waitFor(() => win.document.activeElement === win.document.querySelector(region('panel')))

  await agent.callAny('ui.panel.close', {})
  await win.waitFor(() => win.document.querySelector(region('panel')) === null)

  await agent.callAny('ui.view.close', {})
  await win.waitFor(() => text(env).includes('Add a repo and pick a worktree to get started.'))
})

test('SC-36: hiding the sidebar removes its sections but keeps the settings gear', async () => {
  const { win, agent } = await boot()

  await agent.callAny('ui.sidebar.set', { visible: false })
  await win.waitFor(() => win.document.querySelector(slot(SECTION)) === null)
  expect(win.document.querySelector('button[aria-label="Settings"]')).not.toBeNull()

  await agent.callAny('ui.sidebar.set', { visible: true })
  await win.waitFor(() => win.document.querySelector(slot(SECTION)) !== null)
})

test('SC-36: a view stays mounted while only focus changes', async () => {
  const { win, agent } = await boot()
  await agent.callAny('ui.view.open', { id: PAGE, input: { n: 1 } })
  await win.waitFor(() => win.document.querySelector('#page-text'))
  const before = win.document.querySelector('#page-text')

  await agent.callAny('ui.focus', { target: 'sidebar' })
  await win.waitFor(() => win.host.getState().layout.focus === 'sidebar')
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

test('SC-37: a click in the sidebar section opens a view, and a click on a panel toggle opens and closes the panel', async () => {
  const { win, agent } = await boot()
  const layout = async () =>
    ((await agent.callAny('ui.state', {})) as { layout: { view: { id: string } | null; panel: string | null } }).layout

  await win.click('#go-other')
  await win.waitFor(async () => (await layout()).view?.id === OTHER)

  await win.click('.main-header button')
  await win.waitFor(async () => (await layout()).panel === OUTLINE)
  await win.click('.main-header button')
  await win.waitFor(async () => (await layout()).panel === null)
})

test('SC-37: a click in a region tells the daemon where focus is', async () => {
  const { win, agent } = await boot()
  const focus = async () => ((await agent.callAny('ui.state', {})) as { layout: { focus: string | null } }).layout.focus

  await win.click(region('sidebar'))
  await win.waitFor(async () => (await focus()) === 'sidebar')
  await win.click(region('view'))
  await win.waitFor(async () => (await focus()) === 'view')
})

test('the layout reaches a window that connects later', async () => {
  const env = await boot()
  await env.agent.callAny('ui.view.open', { id: OTHER, input: { late: true } })
  await env.agent.callAny('ui.panel.open', { id: OUTLINE })
  await env.win.waitFor(() => env.win.document.querySelector(region('panel')))
  const state = env.win.host.getState()
  expect(state.layout.view).toEqual({ id: OTHER, input: { late: true } })
  expect(state.layout.panel).toBe(OUTLINE)
})

test('a plugin with no views leaves the main area saying there is nothing to show', async () => {
  const env = await bootWindow((installed) =>
    installUiPlugin(installed, 'acme.panels', { panel: [{ id: 'only', title: 'Only' }] }, provide('panel:acme.panels/only', 'element.textContent = "x"'))
  )
  expect(text(env)).toContain('Nothing to show here.')
  expect(text(env)).not.toContain('Add a repo')
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
  expect(dialog.textContent).toContain('Really remove it?')
  const buttons = [...dialog.querySelectorAll('button')]
  expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Remove'])
  await env.win.click('.dialog-actions button:last-child')

  await env.win.waitFor(async () => {
    const state = (await env.agent.callAny('ui.state', {})) as { layout: { view: { input?: { answer: boolean } } } }
    return state.layout.view?.input?.answer === true
  })
  expect(env.win.document.querySelector('[role="dialog"]')).toBeNull()
})

test('a toast from a notify event opens its view through the daemon', async () => {
  const { win } = await boot()
  win.store.dispatch({
    type: 'event',
    event: { type: 'notify', title: 'Done', body: 'main finished', desktop: false, open: { view: OTHER, input: { from: 'toast' } } }
  })
  await win.waitFor(() => win.document.querySelector('.toast'))
  await win.click('.toast')
  await win.waitFor(() => win.document.querySelector(slot(OTHER))?.textContent === 'other {"from":"toast"}')
  expect(win.document.querySelector('.toast')).toBeNull()
})

const HUD = 'overlay:acme.hud/hud'
const QUIET = 'overlay:acme.hud/quiet'
const overlayLayer = (env: WindowEnv) => env.win.document.querySelector('.overlay-layer')
const overlayBody = (env: WindowEnv, id: string) => env.win.document.querySelector(`.overlay-layer [data-plugin-overlay="${id}"]`)
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

test('SC-67: the window mounts each overlay in a full-window layer after the layout', async () => {
  const env = await bootWindow(writeOverlayPlugin)
  await env.win.waitFor(() => overlayBody(env, HUD)?.querySelector('#hud-hide'))
  await env.win.waitFor(() => overlayBody(env, QUIET)?.textContent === 'quiet')

  const layer = overlayLayer(env)!
  expect(layer.parentElement).toBe(env.win.document.querySelector('.app'))
  expect(env.win.document.querySelector('.layout')!.nextElementSibling).toBe(layer)
  expect([...layer.children].map((child) => child.getAttribute('data-plugin-overlay'))).toEqual([HUD, QUIET])
  expect(env.win.host.getState().slots[HUD]).toEqual({ status: 'mounted' })
})

test('SC-67: the layer lets clicks through and sits below the dialogs', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'src', 'styles.css'), 'utf8')
  const rule = /\.overlay-layer\s*\{([^}]*)\}/.exec(css)![1]
  expect(rule).toContain('position: fixed')
  expect(rule).toContain('inset: 0')
  expect(rule).toContain('pointer-events: none')
  const zOf = (selector: string) => Number(new RegExp(`\\${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`).exec(css)![1])
  expect(Number(/z-index:\s*(\d+)/.exec(rule)![1])).toBeLessThan(zOf('.overlay'))
})

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

test('SC-67: a window with no overlays still has an empty layer, and the layout is untouched', async () => {
  const env = await bootWindow(writeShellPlugin)
  await env.win.waitFor(() => env.win.host.getState().slots[SECTION]?.status === 'mounted')
  expect(overlayLayer(env)!.children).toHaveLength(0)
  expect(env.win.document.querySelector(`${region('sidebar')} ${slot(SECTION)}`)).not.toBeNull()
})
