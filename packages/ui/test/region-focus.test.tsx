import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement as h, useState } from 'react'
import type { Root } from 'react-dom/client'
import { ContextMenu } from '../src/design-system/context-menu'
import { AppContext, type AppContextValue } from '../src/context'
import type { HostState, WindowPluginHost } from '../src/plugins/host'
import { useRegion, type Region } from '../src/plugins/useRegion'

let createRoot: (container: HTMLElement) => Root
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  createRoot = (await import('react-dom/client')).createRoot
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  document.body.replaceChildren()
})

function Panel({ opensMenu }: { opensMenu: boolean }) {
  const region = useRegion('panel')
  const [menuOpen, setMenuOpen] = useState(false)
  return h(
    'aside',
    region,
    h('button', {
      type: 'button',
      'aria-label': 'Actions for project',
      onClick: () => {
        if (opensMenu) setMenuOpen(true)
      }
    }, 'Actions'),
    menuOpen && h(ContextMenu, {
      items: [{ label: 'Open ledger' }],
      label: 'Actions for project',
      x: 0,
      y: 0,
      onClose: () => setMenuOpen(false)
    })
  )
}

type FocusRequest = { resolve: (accepted: boolean) => void }

async function mountPanel(initialFocus: Region = 'view', opensMenu = false) {
  const listeners = new Set<() => void>()
  let state = { layout: { focus: initialFocus } } as unknown as HostState
  const focusRequests: FocusRequest[] = []
  const plugins = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    focus: () => {
      const request = Promise.withResolvers<boolean>()
      focusRequests.push({ resolve: request.resolve })
      return request.promise
    }
  } as unknown as WindowPluginHost
  const value = { plugins } as unknown as AppContextValue

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(h(AppContext.Provider, { value }, h(Panel, { opensMenu })))
  })

  return {
    panel: container.querySelector<HTMLElement>('[data-region="panel"]')!,
    trigger: container.querySelector<HTMLButtonElement>('[aria-label="Actions for project"]')!,
    async resolveFocus(index: number, accepted: boolean) {
      const request = focusRequests[index]
      if (!request) throw new Error(`No focus request at index ${index}`)
      await act(async () => {
        request.resolve(accepted)
        await Promise.resolve()
      })
    },
    async publishFocus(focus: Region) {
      state = { ...state, layout: { ...state.layout, focus } }
      await act(async () => {
        for (const listener of listeners) listener()
      })
    }
  }
}

test('useRegion preserves a project Actions menu focus when the click focus update arrives', async () => {
  const panel = await mountPanel('view', true)
  panel.trigger.focus()
  expect(document.activeElement).toBe(panel.trigger)

  await act(async () => panel.trigger.click())
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(menu.getAttribute('aria-label')).toBe('Actions for project')
  expect(document.activeElement).toBe(menu)

  await panel.publishFocus('panel')
  await panel.resolveFocus(0, true)
  expect(document.activeElement).toBe(menu)

  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()

  await panel.publishFocus('view')
  await panel.publishFocus('panel')
  expect(document.activeElement).toBe(panel.panel)
})

test('useRegion clears a failed click snapshot before a later external focus change', async () => {
  const panel = await mountPanel('view', true)
  panel.trigger.focus()
  await act(async () => panel.trigger.click())
  expect(document.activeElement).toBe(document.querySelector('[role="menu"]'))

  await panel.resolveFocus(0, false)
  expect(panel.panel.getAttribute('data-focused')).toBe('false')
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()

  const outside = document.createElement('button')
  document.body.appendChild(outside)
  outside.focus()
  await panel.publishFocus('panel')
  expect(document.activeElement).toBe(panel.panel)
})

test('useRegion ignores a failed older focus request after a newer click', async () => {
  const panel = await mountPanel('view', true)
  panel.trigger.focus()
  await act(async () => panel.trigger.click())
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()

  panel.trigger.focus()
  await act(async () => panel.trigger.click())
  const menu = document.querySelector<HTMLElement>('[role="menu"]')!
  expect(document.activeElement).toBe(menu)

  await panel.resolveFocus(0, false)
  await panel.publishFocus('panel')
  expect(document.activeElement).toBe(menu)
  await panel.resolveFocus(1, true)

  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

test('useRegion takes focus on an external layout focus change', async () => {
  const panel = await mountPanel()
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  outside.focus()
  expect(document.activeElement).toBe(outside)

  await panel.publishFocus('panel')
  expect(document.activeElement).toBe(panel.panel)
})

test('useRegion leaves a clicked child focused after the region focus update', async () => {
  const panel = await mountPanel()
  panel.trigger.focus()

  await act(async () => panel.trigger.click())
  expect(document.activeElement).toBe(panel.trigger)

  await panel.publishFocus('panel')
  await panel.resolveFocus(0, true)
  expect(document.activeElement).toBe(panel.trigger)
})

test('useRegion takes focus after a click that did not move browser focus', async () => {
  const panel = await mountPanel()
  const outside = document.createElement('button')
  document.body.appendChild(outside)
  outside.focus()

  await act(async () => panel.trigger.click())
  expect(document.activeElement).toBe(outside)

  await panel.publishFocus('panel')
  await panel.resolveFocus(0, true)
  expect(document.activeElement).toBe(panel.panel)
})
