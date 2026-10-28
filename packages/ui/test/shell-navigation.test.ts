import { afterEach, expect, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { makeTempDir } from '../../daemon/test/plugins/fixtures'
import { bootWindow, closeWindows, installUiPlugin, provide, type WindowEnv } from './fixtures/window-env'

const PAGE = 'view:acme.nav/page'
const SECONDARY = 'view:acme.nav/secondary'
const PANEL = 'panel:acme.nav/details'
const COMMAND = 'command:acme.nav/open-secondary'

function writeNavigationPlugin(installed: string, interceptSearch = false): void {
  installUiPlugin(
    installed,
    'acme.nav',
    {
      panel: [{ id: 'details', title: 'Navigator details' }],
      view: [
        { id: 'page', title: 'Navigator page' },
        { id: 'secondary', title: 'Secondary view' }
      ],
      command: [{ id: 'open-secondary', title: 'Open secondary from command', description: 'Switch to the secondary view' }],
      ...(interceptSearch ? { keybinding: [{ id: 'open-secondary', key: 'mod+k', command: 'open-secondary' }] } : {})
    },
    [
      provide(PANEL, `element.textContent = 'navigator panel'`),
      provide(PAGE, `element.textContent = 'page ' + JSON.stringify(props.input ?? null)`),
      provide(SECONDARY, `element.textContent = 'secondary ' + JSON.stringify(props.input ?? null)`),
      `context.provide(${JSON.stringify(COMMAND)}, () => context.openView(${JSON.stringify(SECONDARY)}, { source: 'palette' }))`
    ].join('\n')
  )
}

function navigationBuiltinPlugins(): string {
  const builtins = makeTempDir('ui-shell-navigation-builtins-')
  // Installed quirky.* IDs are reserved; these are genuine built-ins with quirky.worktree's dependencies.
  for (const id of ['quirky.repo', 'quirky.worktree', 'quirky.cli', 'quirky.sidebar-extras', 'quirky.ask']) {
    symlinkSync(resolve(import.meta.dir, '../../../plugins', id), join(builtins, id))
  }
  installUiPlugin(
    builtins,
    'quirky.session',
    { view: [{ id: 'worktree', title: 'Session worktree' }] },
    provide('view:quirky.session/worktree', `element.textContent = 'session worktree ' + JSON.stringify(props.input ?? null)`)
  )
  return builtins
}

afterEach(closeWindows)

const text = (env: WindowEnv) => env.win.document.body.textContent ?? ''
const findTab = (env: WindowEnv, label: string) =>
  [...env.win.document.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes(label))

async function openPalette(env: WindowEnv): Promise<HTMLInputElement> {
  await env.win.click('[aria-label="Search commands, tools, views, and worktrees"]')
  await env.win.waitFor(() => env.win.document.querySelector<HTMLInputElement>('.ui-dialog input'))
  return env.win.document.querySelector<HTMLInputElement>('.ui-dialog input')!
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

test('view tabs preserve each opened input and closing a tab mutates only that exact window', async () => {
  const env = await bootWindow(writeNavigationPlugin, { builtinPluginsDir: navigationBuiltinPlugins() })
  const otherWindow = await env.harness.connect('ui', 'second window')
  await otherWindow.callAny('events.subscribe', {})
  const otherConnId = await otherWindow.callAny('ui.window.self', {}) as { connId: number }
  await otherWindow.callAny('ui.window.view.open', {
    connId: otherConnId.connId, id: PAGE, input: { owner: 'second window', filter: 'kept' }
  })

  const mainConnId = await env.win.connection.callAny('ui.window.self', {}) as { connId: number }
  await env.agent.callAny('ui.window.view.open', {
    connId: mainConnId.connId, id: PAGE, input: { owner: 'main window', filter: 'original' }
  })
  await env.agent.callAny('ui.window.view.open', {
    connId: mainConnId.connId, id: SECONDARY, input: { owner: 'main window', query: 'secondary' }
  })
  await env.win.waitFor(() => env.win.host.getState().layout.viewTabs?.length === 2 && findTab(env, 'Navigator page'))
  expect(env.win.host.getState().layout.viewTabs).toEqual([
    { id: PAGE, input: { owner: 'main window', filter: 'original' } },
    { id: SECONDARY, input: { owner: 'main window', query: 'secondary' } }
  ])

  findTab(env, 'Navigator page')!.click()
  await env.win.waitFor(() => env.win.host.getState().layout.view?.id === PAGE)
  expect(env.win.host.getState().layout.view?.input).toEqual({ owner: 'main window', filter: 'original' })
  await env.win.waitFor(() => env.win.document.querySelector('[data-plugin-slot=\"view:acme.nav/page\"]')?.textContent?.includes('original'))

  await env.win.click('[aria-label=\"Close active view\"]')
  await env.win.waitFor(() => !env.win.host.getState().layout.viewTabs?.some((tab) => tab.id === PAGE))
  const otherState = await otherWindow.callAny('ui.window.state', { connId: otherConnId.connId }) as {
    layout: { view: { id: string; input?: unknown } | null }
  }
  expect(otherState.layout.view).toEqual({ id: PAGE, input: { owner: 'second window', filter: 'kept' } })
  expect(env.win.host.getState().layout.viewTabs?.map((tab) => tab.id)).toEqual([SECONDARY])
})

test('⌘K search exposes effective commands, tools, views, and canonical worktrees with keyboard actions', async () => {
  const env = await bootWindow(writeNavigationPlugin, { builtinPluginsDir: navigationBuiltinPlugins() })
  const projectPath = makeTempDir('ui-shell-search-project-')
  const projectName = basename(projectPath)
  await env.agent.callAny('quirky.repo/add', { path: projectPath, folder: true })
  const worktrees = await env.agent.callAny('quirky.worktree/list', {}) as { id: string; name: string }[]
  const projectWorktree = worktrees.find((worktree) => worktree.name === projectName)
  expect(projectWorktree).toBeDefined()

  const shortcut = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true })
  window.dispatchEvent(shortcut)
  await env.win.waitFor(() => env.win.host.getState().layout.palette === true)
  expect(text(env)).toContain('Command palette')

  const input = env.win.document.querySelector<HTMLInputElement>('.ui-dialog input')!
  typeInto(input, 'Navigator details')
  await env.win.waitFor(() => text(env).includes('Navigator details'))
  expect(env.win.document.querySelector('[role="listbox"]')?.textContent).toContain('Navigator details')

  typeInto(input, 'Secondary view')
  await env.win.waitFor(() => env.win.document.querySelector('[role="listbox"]')?.textContent?.includes('Secondary view'))
  expect(env.win.document.querySelector('[role="listbox"]')?.textContent).toContain('Secondary view')

  typeInto(input, 'Open secondary from command')
  await env.win.waitFor(() => env.win.document.querySelector('[role="option"]'))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await env.win.waitFor(() => env.win.host.getState().layout.view?.id === SECONDARY)
  expect(env.win.host.getState().layout.view?.input).toEqual({ source: 'palette' })

  await openPalette(env)
  const worktreeInput = env.win.document.querySelector<HTMLInputElement>('.ui-dialog input')!
  typeInto(worktreeInput, projectName)
  await env.win.waitFor(() => env.win.document.querySelector('[role="option"]')?.textContent?.includes(projectName))
  worktreeInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await env.win.waitFor(() => env.win.host.getState().layout.view?.input !== undefined &&
    (env.win.host.getState().layout.view?.input as { worktree?: string }).worktree === projectWorktree!.id)
  expect(env.win.host.getState().layout.view?.id).toBe('view:quirky.session/worktree')
})

test('an active contributed Mod+K binding keeps priority over the search fallback', async () => {
  const env = await bootWindow(
    (installed) => writeNavigationPlugin(installed, true),
    { builtinPluginsDir: navigationBuiltinPlugins() }
  )
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true, cancelable: true }))
  await env.win.waitFor(() => env.win.host.getState().layout.view?.id === SECONDARY)
  expect(env.win.host.getState().layout.view?.input).toEqual({ source: 'palette' })
  expect(env.win.host.getState().layout.palette).not.toBe(true)
})
