// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import { createPaneDOM } from './pane-dom-creation'
import { shouldFocusTerminalFromPanePointerDown } from './pane-pointer-focus'
import { terminalMouseEncodingRestoreAnsi } from './terminal-mouse-encoding-tracker'

const csiHandlers = vi.hoisted(() => new Map<string, (params: (number | number[])[]) => boolean>())

const webLinksAddonMock = vi.hoisted(() => ({
  handler: null as ((event: MouseEvent, uri: string) => void) | null,
  options: null as { hover?: (event: MouseEvent, uri: string) => void; leave?: () => void } | null
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn().mockImplementation(function FitAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: vi.fn().mockImplementation(function SearchAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: vi.fn().mockImplementation(function SerializeAddon() {
    return {}
  })
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: vi.fn().mockImplementation(function Unicode11Addon() {
    return {}
  })
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: vi.fn().mockImplementation(function WebLinksAddon(handler, options) {
    webLinksAddonMock.handler = handler
    webLinksAddonMock.options = options
    return {}
  })
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn().mockImplementation(function Terminal() {
    return {
      options: {},
      loadAddon: vi.fn(),
      open: vi.fn(),
      parser: {
        registerCsiHandler: vi.fn(
          (id: { final: string }, handler: (params: (number | number[])[]) => boolean) => {
            csiHandlers.set(id.final, handler)
            return { dispose: vi.fn() }
          }
        ),
        registerEscHandler: vi.fn(() => ({ dispose: vi.fn() }))
      }
    }
  })
}))

describe('createPaneDOM link tooltips', () => {
  it('anchors WebLinks hover text to the unpadded terminal window corner', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => 'open hint' },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    // Why: corner offsets live in .pane-link-tooltip (terminal.css); JS only
    // toggles visibility so padding/offset cannot drift back into inline styles.
    expect(pane.linkTooltip.classList.contains('pane-link-tooltip')).toBe(true)
    expect(pane.linkTooltip.style.left).toBe('')
    expect(pane.linkTooltip.style.bottom).toBe('')
    expect(pane.linkTooltip.style.display).toBe('none')
  })

  // Why: the caller owns the hint, so dropping the wiring is a compile error rather
  // than a silent fall back to stale copy.
  it('re-resolves the caller hint on every hover so setting changes apply live', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    let hint = 'first hint'
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => hint },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(pane.linkTooltip.textContent).toBe('http://localhost:5180/ (first hint)')

    hint = 'second hint'
    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    expect(pane.linkTooltip.textContent).toBe('http://localhost:5180/ (second hint)')
  })

  it('lets callers replace WebLinks hover text for display-only labels', async () => {
    const labeledText = 'http://main.quirky.localhost:60016/ (localhost:5180; click to open)'
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      {
        linkOpenHint: () => 'open hint',
        formatLinkTooltip: async () => labeledText
      },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')
    await Promise.resolve()

    expect(pane.linkTooltip.textContent).toBe(labeledText)
  })

  // Why: the hovered pane's host decides where its links can go, so both hooks must
  // receive that pane's id rather than resolving against global state.
  it('identifies the hovered pane to both tooltip hooks', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const linkOpenHint = vi.fn(() => 'open hint')
    const formatLinkTooltip = vi.fn(() => null)
    createPaneDOM(
      7,
      leafId,
      { linkOpenHint, formatLinkTooltip },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    webLinksAddonMock.options?.hover?.({} as MouseEvent, 'http://localhost:5180/')

    expect(linkOpenHint).toHaveBeenCalledWith(7)
    expect(formatLinkTooltip).toHaveBeenCalledWith(7, 'http://localhost:5180/', 'open hint')
  })

  it('identifies the clicked pane to link routing', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const onLinkClick = vi.fn()
    createPaneDOM(
      7,
      leafId,
      { linkOpenHint: () => 'open hint', onLinkClick },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )
    const event = {} as MouseEvent

    webLinksAddonMock.handler?.(event, 'https://example.com')

    expect(onLinkClick).toHaveBeenCalledWith(7, event, 'https://example.com')
  })
})

describe('createPaneDOM dock slot', () => {
  const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

  function makePane() {
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => 'open hint' },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )
    const { dockContainer } = pane
    if (!dockContainer) {
      throw new Error('Expected createPaneDOM to create a dock slot')
    }
    return { pane, dockContainer }
  }

  it('appends the dock slot to container as a sibling after xtermContainer', () => {
    const { pane, dockContainer } = makePane()

    expect(dockContainer.parentElement).toBe(pane.container)
    const children = Array.from(pane.container.children)
    expect(children.indexOf(dockContainer)).toBeGreaterThan(children.indexOf(pane.xtermContainer))
  })

  it('gives the dock slot a stable class name', () => {
    const { dockContainer } = makePane()

    expect(dockContainer.classList.contains('pane-dock-slot')).toBe(true)
  })

  it('declares data-pane-prevent-terminal-focus on the dock slot', () => {
    const { dockContainer } = makePane()

    expect(dockContainer.hasAttribute('data-pane-prevent-terminal-focus')).toBe(true)
  })

  it('is honored by shouldFocusTerminalFromPanePointerDown for pointer targets inside the slot', () => {
    const { dockContainer } = makePane()
    const childInsideDock = document.createElement('span')
    dockContainer.appendChild(childInsideDock)

    expect(shouldFocusTerminalFromPanePointerDown(childInsideDock)).toBe(false)
  })

  it('exposes the dock slot on the pane record', () => {
    const { pane } = makePane()

    expect(pane.dockContainer).toBeInstanceOf(HTMLElement)
  })
})

describe('createPaneDOM mouse encoding', () => {
  it('tracks the encoding the pane terminal parses so its snapshot can carry it', () => {
    const leafId = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
    const pane = createPaneDOM(
      1,
      leafId,
      { linkOpenHint: () => 'open hint' },
      { active: null } as never,
      {} as never,
      vi.fn(),
      vi.fn()
    )

    expect(csiHandlers.get('h')?.([1003, 1006])).toBe(false)
    expect(terminalMouseEncodingRestoreAnsi(pane.terminal)).toBe('\x1b[?1006h')
  })
})
