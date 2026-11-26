// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { findDockComposerInput, focusPaneOrDockComposer } from './dock-composer-focus-redirect'

function createPaneSurface(): {
  pane: HTMLDivElement
  surface: HTMLTextAreaElement
} {
  const pane = document.createElement('div')
  pane.className = 'pane'
  pane.dataset.leafId = '11111111-1111-4111-8111-111111111111'
  const surface = document.createElement('textarea')
  surface.className = 'xterm-helper-textarea'
  pane.appendChild(surface)
  document.body.appendChild(pane)
  return { pane, surface }
}

function createDockInput(editable = true): HTMLDivElement {
  const input = document.createElement('div')
  input.className = 'cm-content'
  input.setAttribute('contenteditable', String(editable))
  return input
}

function appendDock(pane: HTMLElement): HTMLDivElement {
  const dock = document.createElement('div')
  dock.dataset.terminalDock = ''
  pane.appendChild(dock)
  return dock
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('findDockComposerInput', () => {
  it('finds the enabled composer in the surface pane', () => {
    const { pane, surface } = createPaneSurface()
    const composer = createDockInput()
    appendDock(pane).appendChild(composer)

    expect(findDockComposerInput(surface)).toBe(composer)
  })

  it('returns null when the pane has no dock', () => {
    const { surface } = createPaneSurface()

    expect(findDockComposerInput(surface)).toBeNull()
  })

  it('returns null when the only composer is disabled', () => {
    const { pane, surface } = createPaneSurface()
    const composer = createDockInput(false)
    appendDock(pane).appendChild(composer)

    expect(findDockComposerInput(surface)).toBeNull()
  })

  it('returns null while the dock is in passthrough mode', () => {
    const { pane, surface } = createPaneSurface()
    const dock = appendDock(pane)
    dock.dataset.terminalDockPassthrough = ''
    dock.appendChild(createDockInput())

    expect(findDockComposerInput(surface)).toBeNull()
  })

  it('returns null when the surface has no pane ancestor', () => {
    const surface = document.createElement('textarea')

    expect(findDockComposerInput(surface)).toBeNull()
  })

  it('does not match the interactive card input', () => {
    const { pane, surface } = createPaneSurface()
    const overlay = document.createElement('div')
    overlay.dataset.terminalDockCardOverlay = ''
    overlay.appendChild(document.createElement('input'))
    appendDock(pane).appendChild(overlay)

    expect(findDockComposerInput(surface)).toBeNull()
  })
})

describe('focusPaneOrDockComposer', () => {
  it('prefers the enabled dock composer over the terminal', () => {
    const { pane } = createPaneSurface()
    const composer = createDockInput()
    const terminal = { focus: vi.fn() }
    appendDock(pane).appendChild(composer)
    const composerFocus = vi.spyOn(composer, 'focus')

    focusPaneOrDockComposer({ container: pane, terminal })

    expect(composerFocus).toHaveBeenCalledOnce()
    expect(terminal.focus).not.toHaveBeenCalled()
  })

  it('falls back to the terminal when no enabled composer exists', () => {
    const { pane } = createPaneSurface()
    const terminal = { focus: vi.fn() }

    focusPaneOrDockComposer({ container: pane, terminal })

    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('falls back to the terminal while the dock is in passthrough mode', () => {
    const { pane } = createPaneSurface()
    const dock = appendDock(pane)
    dock.dataset.terminalDockPassthrough = ''
    dock.appendChild(createDockInput())
    const terminal = { focus: vi.fn() }

    focusPaneOrDockComposer({ container: pane, terminal })

    expect(terminal.focus).toHaveBeenCalledOnce()
  })

  it('does nothing without a pane', () => {
    expect(() => focusPaneOrDockComposer(null)).not.toThrow()
    expect(() => focusPaneOrDockComposer(undefined)).not.toThrow()
  })
})
