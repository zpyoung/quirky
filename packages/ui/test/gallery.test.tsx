import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { Gallery as GalleryComponent } from '../src/gallery'

let Gallery: typeof GalleryComponent
let createRoot: (element: HTMLElement) => Root
let root: Root | null = null

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const [gallery, client] = await Promise.all([import('../src/gallery'), import('react-dom/client')])
  Gallery = gallery.Gallery
  createRoot = client.createRoot
})

afterAll(() => GlobalRegistrator.unregister())
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function mountGallery() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(createElement(Gallery)))
  return container
}

function accessibleText(node: Node): string {
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return ''
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  return [...node.childNodes].map(accessibleText).join('')
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((candidate) =>
    (candidate.getAttribute('aria-label')?.trim() || accessibleText(candidate).trim()) === label
  )
  if (!found) throw new Error(`Gallery button not found: ${label}`)
  return found
}

function status(scope: ParentNode, name: string): string {
  const found = scope.querySelector<HTMLOutputElement>(`[data-demo-status="${name}"]`)
  if (!found) throw new Error(`Gallery status not found: ${name}`)
  return found.textContent ?? ''
}

test('keeps the button examples and their action feedback functional in both themes', async () => {
  const container = await mountGallery()
  const scopes = [...container.querySelectorAll('.ui-gallery-theme')]
  for (const scope of scopes) {
    expect(status(scope, 'button')).toBe('Button actions: 0')
    await act(async () => button(scope, 'Primary action').click())
    expect(status(scope, 'button')).toBe('Button actions: 1')
    const disabled = button(scope, 'Unavailable primary action')
    expect(disabled.disabled).toBe(true)
    await act(async () => disabled.click())
    expect(status(scope, 'button')).toBe('Button actions: 1')
  }
})

test('exposes and runs the accessible icon control in both themes', async () => {
  const container = await mountGallery()
  for (const scope of container.querySelectorAll('.ui-gallery-theme')) {
    const refresh = scope.querySelector<HTMLButtonElement>('button[aria-label="Refresh gallery activity"]')
    expect(refresh).not.toBeNull()
    await act(async () => refresh!.click())
    expect(status(scope, 'icon-button')).toBe('Refreshes: 1')
  }
})

test('section, empty-state, and tool-panel actions update their local status', async () => {
  const container = await mountGallery()
  for (const scope of container.querySelectorAll('.ui-gallery-theme')) {
    await act(async () => button(scope, 'Add workspace').click())
    expect(status(scope, 'section-header')).toBe('Workspace added locally')

    await act(async () => button(scope, 'Create a sample agent').click())
    expect(status(scope, 'empty-state')).toBe('Sample agent created locally')

    await act(async () => button(scope, 'Minimize panel').click())
    expect(status(scope, 'tool-panel')).toBe('Tool panel minimized')
    await act(async () => button(scope, 'Restore panel').click())
    expect(status(scope, 'tool-panel')).toBe('Tool panel open')
  }
})

test('typing, selecting a tab, and selecting a menu item update local status in both themes', async () => {
  const container = await mountGallery()
  for (const scope of container.querySelectorAll('.ui-gallery-theme')) {
    const theme = (scope as HTMLElement).dataset.theme!
    const field = scope.querySelector<HTMLInputElement>(`#gallery-workspace-${theme}`)
    if (!field) throw new Error(`Workspace field not found in ${theme} theme`)
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(field, 'new-workspace')
      field.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    expect(status(scope, 'text-field')).toBe('Workspace draft: new-workspace')

    await act(async () => button(scope, 'Activity').click())
    expect(status(scope, 'tabs')).toBe('Active tab: Activity')

    await act(async () => button(scope, 'Open menu').click())
    await act(async () => button(document.body, 'Mark active').click())
    expect(status(scope, 'menu')).toBe('Menu action: Mark active')
  }
})

test('dialog, toast, and inline agent card actions visibly update their local demos', async () => {
  const container = await mountGallery()
  for (const scope of container.querySelectorAll('.ui-gallery-theme')) {
    await act(async () => button(scope, 'Open dialog').click())
    expect(document.body.textContent).toContain('Gallery dialog is open.')
    await act(async () => button(document.body, 'Close dialog').click())
    expect(status(scope, 'dialog')).toBe('Dialog status: Closed')
    await act(async () => button(scope, 'Open sheet').click())
    expect(document.body.textContent).toContain('Gallery sheet is open.')
    await act(async () => button(document.body, 'Close sheet').click())
    expect(status(scope, 'dialog')).toBe('Dialog status: Closed')

    await act(async () => button(scope, 'Review update').click())
    expect(status(scope, 'toast')).toBe('Toast action: Review update')
    await act(async () => button(scope, 'Show toast again').click())
    expect(status(scope, 'toast')).toBe('Toast is visible')
    await act(async () => button(scope, 'Dismiss toast').click())
    expect(status(scope, 'toast')).toBe('Toast dismissed')

    await act(async () => button(scope, 'Open agent details').click())
    expect(status(scope, 'agent-card')).toBe('Agent action: Open agent details')
  }
})
