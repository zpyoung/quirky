// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode, type Ref } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { queuePanePtyResizeIfHeld } from '@/lib/pane-manager/pane-pty-resize-hold'
import {
  terminalDockAutoUndockHighThresholdPx,
  terminalDockAutoUndockLowThresholdPx,
  terminalDockGutterHeightPx
} from './TerminalDock'
import { DEFAULT_GUTTER_ROWS } from './terminal-dock-pane-state'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/agent-paste-draft', () => ({
  getSettingsForAgentTabRuntimeOwner: () => ({})
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false,
  sendRuntimePtyInput: vi.fn()
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))
vi.mock('../../native-chat/NativeChatSessionOptionPickers', () => ({
  NativeChatSessionOptionPickers: () => <div data-testid="session-option-pickers" />
}))
const composerScreenReaders = vi.hoisted(() => [] as (() => string | null)[])
vi.mock('./TerminalDockComposer', async () => {
  const React = await import('react')
  return {
    TerminalDockComposer: ({
      ref,
      readTerminalScreen
    }: {
      ref?: Ref<unknown>
      readTerminalScreen?: () => string | null
    }) => {
      if (readTerminalScreen) {
        composerScreenReaders.push(readTerminalScreen)
      }
      const textareaRef = React.useRef<HTMLTextAreaElement>(null)
      React.useImperativeHandle(ref, () => ({
        focus: () => {
          textareaRef.current?.focus()
          return true
        },
        insertTypedText: () => false,
        handlePasteEvent: () => {},
        pasteFromClipboard: () => {}
      }))
      return <textarea ref={textareaRef} />
    }
  }
})
vi.mock('../../native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => ({ cancel: vi.fn(), settleAfterMs: 0 })),
  sendNativeChatMessageWithImageAttachments: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))

import {
  REMOTE_CONPTY_UNVERIFIED_DATASET_KEY,
  TerminalPaneDockMount,
  terminalPaneUsesConptyBelowWrapMarkers
} from './TerminalPaneDockMount'

afterEach(() => {
  composerScreenReaders.length = 0
  cleanup()
  // makeFakePane's container (and any manually appended focus targets) are plain DOM
  // nodes outside React's tree, so RTL's cleanup() never removes them on its own.
  document.body.replaceChildren()
  vi.clearAllMocks()
})

function makeFakePane(): ManagedPane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = '1'
  const xtermContainer = document.createElement('div')
  xtermContainer.className = 'xterm-container'
  container.appendChild(xtermContainer)
  const dockSlot = document.createElement('div')
  dockSlot.className = 'pane-dock-slot'
  container.appendChild(dockSlot)
  document.body.appendChild(container)
  // Why: happy-dom's getBoundingClientRect is a 0-box by default, which would put every
  // pane below the auto-undock threshold before TerminalDock ever gets a chance to mount.
  container.getBoundingClientRect = () =>
    ({ height: terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 100 }) as DOMRect
  return {
    container,
    // Why: unmeasurable in jsdom (proposeDimensions null) so safeFit's pre-fit
    // measurability gate returns cleanly instead of throwing on a pane with no real xterm.
    fitAddon: { proposeDimensions: () => null, fit: () => {} },
    terminal: { cols: 0, rows: 0, resize: () => {}, focus: () => {} }
  } as unknown as ManagedPane
}

const baseProps = {
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  agent: 'claude' as const,
  gutterRows: DEFAULT_GUTTER_ROWS,
  targetPtyId: 'pty-1',
  disabledReason: null,
  readTerminalScreen: () => null,
  onCommitGutterRows: vi.fn(),
  passthroughActive: false
}

describe('TerminalPaneDockMount', () => {
  it('renders nothing when not docked', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('portals the dock into the pane dock slot when docked', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    const dockSlot = pane.container.querySelector('.pane-dock-slot') as HTMLElement
    expect(dockSlot.querySelector('[data-terminal-dock]')).not.toBeNull()
  })

  it('keeps one screen reader while the host hands down fresh pane views', () => {
    // getPanes() rebuilds a pane's public view per render, so the host's reader is a new
    // closure every time. The composer memoizes its session-option surface on that
    // identity, and each rebuild re-reads the agent frame over what the user just picked.
    const pane = makeFakePane()
    const { rerender } = render(
      <TerminalPaneDockMount
        {...baseProps}
        pane={pane}
        docked={true}
        readTerminalScreen={() => 'first'}
      />
    )
    rerender(
      <TerminalPaneDockMount
        {...baseProps}
        pane={{ ...pane }}
        docked={true}
        readTerminalScreen={() => 'second'}
      />
    )

    expect(new Set(composerScreenReaders).size).toBe(1)
    // Stable identity, still reading through to the pane view the host rendered last.
    expect(composerScreenReaders[0]?.()).toBe('second')
  })

  it('owns slot geometry and reports the effective auto-undock surface', () => {
    const pane = makeFakePane()
    const onEffectiveMountedChange = vi.fn()
    const { rerender } = render(
      <TerminalPaneDockMount
        {...baseProps}
        pane={pane}
        docked={true}
        onEffectiveMountedChange={onEffectiveMountedChange}
      />
    )
    const dockSlot = pane.container.querySelector('.pane-dock-slot') as HTMLElement
    expect(dockSlot.style.height).toBe(`${terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)}px`)
    expect(pane.container.style.getPropertyValue('--terminal-dock-height')).toBe(
      `${terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)}px`
    )
    expect(onEffectiveMountedChange).toHaveBeenCalledWith(true)

    rerender(
      <TerminalPaneDockMount
        {...baseProps}
        pane={pane}
        docked={false}
        onEffectiveMountedChange={onEffectiveMountedChange}
      />
    )
    expect(dockSlot.style.height).toBe('0px')
    expect(onEffectiveMountedChange).toHaveBeenLastCalledWith(false)
  })

  it('resets slot geometry on undock while the host churns the pane view identity', () => {
    // getPanes() hands down a fresh pane object per render, so the geometry effect re-runs
    // in the same commit the unmount cleanup zeroed the slot in — it must not undo that.
    const pane = makeFakePane()
    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    const dockSlot = pane.container.querySelector('.pane-dock-slot') as HTMLElement
    expect(dockSlot.style.height).toBe(`${terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)}px`)

    rerender(<TerminalPaneDockMount {...baseProps} pane={{ ...pane }} docked={false} />)

    expect(dockSlot.style.height).toBe('0px')
    expect(pane.container.style.getPropertyValue('--terminal-dock-height')).toBe('0px')
  })

  it('applies slot geometry on dock while the host churns the pane view identity', () => {
    const pane = makeFakePane()
    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    const dockSlot = pane.container.querySelector('.pane-dock-slot') as HTMLElement

    rerender(<TerminalPaneDockMount {...baseProps} pane={{ ...pane }} docked={true} />)

    expect(dockSlot.style.height).toBe(`${terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)}px`)
    expect(pane.container.style.getPropertyValue('--terminal-dock-height')).toBe(
      `${terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)}px`
    )
  })

  it('holds and releases the PTY resize around a dock/undock edge without throwing', () => {
    const pane = makeFakePane()
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)

    const { rerender, unmount } = render(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />
    )
    // The hold must have been released by the time the mount effect settles, so an
    // unrelated resize attempt right after sends immediately instead of queuing forever.
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)

    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
    unmount()
  })

  it.each([
    { name: 'focuses the composer when the active (focused) pane docks', active: true },
    { name: 'does not move focus when a background (unfocused) pane docks', active: false }
  ])('$name', ({ active }) => {
    const pane = makeFakePane()
    // Not a textarea: a real xterm helper textarea would collide with the composer's own
    // role=textbox query once docking mounts it.
    const focusOwner = document.createElement(active ? 'div' : 'input')
    if (active) {
      focusOwner.tabIndex = -1
      pane.container.querySelector('.xterm-container')?.appendChild(focusOwner)
    } else {
      document.body.appendChild(focusOwner)
    }
    act(() => focusOwner.focus())

    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(document.activeElement).toBe(focusOwner)

    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)

    expect(document.activeElement).toBe(active ? screen.getByRole('textbox') : focusOwner)
  })

  it.each([
    { name: 'returns focus to xterm when the active pane undocks', active: true },
    { name: 'does not call terminal.focus() when a background pane undocks', active: false }
  ])('$name', ({ active }) => {
    const pane = makeFakePane()
    const focusSpy = vi.spyOn(pane.terminal, 'focus')
    const externalFocusOwner = document.createElement(active ? 'div' : 'input')
    document.body.appendChild(externalFocusOwner)
    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    act(() => {
      if (active) {
        screen.getByRole('textbox').focus()
      } else {
        externalFocusOwner.focus()
      }
    })
    expect(focusSpy).not.toHaveBeenCalled()

    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)

    expect(focusSpy).toHaveBeenCalledTimes(active ? 1 : 0)
  })

  it('focuses the composer again when passthrough exits while still docked, in the active pane', () => {
    const pane = makeFakePane()
    const { rerender } = render(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={true} passthroughActive={true} />
    )
    const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
    const xtermFocusStandIn = document.createElement('div')
    xtermFocusStandIn.tabIndex = -1
    xtermContainer.appendChild(xtermFocusStandIn)
    // Why: passthrough means xterm, not the composer, currently owns keyboard focus.
    act(() => {
      xtermFocusStandIn.focus()
    })

    rerender(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={true} passthroughActive={false} />
    )

    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('does not fire a focus-steal transition when an already-docked pane first mounts (restored session)', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)

    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
  })

  describe('persisted-docked pane below the auto-undock threshold at startup', () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = []
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        FakeResizeObserver.instances.push(this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }

    function makeShortFakePane(): ManagedPane {
      const pane = makeFakePane()
      pane.container.getBoundingClientRect = () =>
        ({ height: terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS) - 10 }) as DOMRect
      return pane
    }

    it('focuses the composer once a growing pane crosses the high threshold, in the active pane', () => {
      const originalResizeObserver = globalThis.ResizeObserver
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver
      try {
        const pane = makeShortFakePane()
        const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
        const xtermFocusStandIn = document.createElement('div')
        xtermFocusStandIn.tabIndex = -1
        xtermContainer.appendChild(xtermFocusStandIn)

        render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        act(() => {
          xtermFocusStandIn.focus()
        })

        const grownHeight = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 10
        const observer = FakeResizeObserver.instances.at(-1)
        act(() => {
          observer?.callback(
            [{ contentRect: { height: grownHeight } } as ResizeObserverEntry],
            observer as unknown as ResizeObserver
          )
        })

        expect(document.activeElement).toBe(screen.getByRole('textbox'))
      } finally {
        globalThis.ResizeObserver = originalResizeObserver
      }
    })

    it('moves nothing when a growing pane crosses the high threshold in a background (unfocused) pane', () => {
      const originalResizeObserver = globalThis.ResizeObserver
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver
      try {
        const pane = makeShortFakePane()
        const input = document.createElement('input')
        document.body.appendChild(input)
        input.focus()

        render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
        expect(pane.container.querySelector('textarea')).not.toBeInTheDocument()
        expect(document.activeElement).toBe(input)

        const grownHeight = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 10
        const observer = FakeResizeObserver.instances.at(-1)
        act(() => {
          observer?.callback(
            [{ contentRect: { height: grownHeight } } as ResizeObserverEntry],
            observer as unknown as ResizeObserver
          )
        })

        expect(pane.container.querySelector('textarea')).toBeInTheDocument()
        expect(document.activeElement).toBe(input)
      } finally {
        globalThis.ResizeObserver = originalResizeObserver
      }
    })
  })

  it('marks the xterm container to skip pointerdown keyboard focus while docked outside passthrough, and clears it otherwise', () => {
    const pane = makeFakePane()
    const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)
    expect(xtermContainer).not.toHaveAttribute('data-pane-prevent-terminal-focus')

    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    expect(xtermContainer).toHaveAttribute('data-pane-prevent-terminal-focus')

    rerender(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={true} passthroughActive={true} />
    )
    expect(xtermContainer).not.toHaveAttribute('data-pane-prevent-terminal-focus')

    rerender(
      <TerminalPaneDockMount {...baseProps} pane={pane} docked={false} passthroughActive={true} />
    )
    expect(xtermContainer).not.toHaveAttribute('data-pane-prevent-terminal-focus')
  })

  it('reclaims focus after a terminal mousedown steals it, without blocking the mousedown from reaching xterm', () => {
    const pane = makeFakePane()
    render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    const composerTextarea = screen.getByRole('textbox')
    act(() => {
      composerTextarea.focus()
    })
    expect(document.activeElement).toBe(composerTextarea)

    const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
    // Stands in for xterm's real DOM: a descendant with xterm's own always-on MouseService
    // mousedown handler, which focuses its helper textarea before selection is handled —
    // this fires at the target phase, before data-pane-prevent-terminal-focus is ever
    // consulted (that attribute only opts out of Quirky's own pane-pointer-down focus call).
    const xtermHelperTextarea = document.createElement('textarea')
    xtermContainer.appendChild(xtermHelperTextarea)
    let xtermMouseDownFired = false
    xtermHelperTextarea.addEventListener('mousedown', () => {
      xtermMouseDownFired = true
      xtermHelperTextarea.focus()
    })

    act(() => {
      xtermHelperTextarea.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(xtermMouseDownFired).toBe(true)
    expect(document.activeElement).toBe(composerTextarea)
  })

  it('does not reclaim focus from a terminal mousedown once undocked', () => {
    const pane = makeFakePane()
    const { rerender } = render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
    rerender(<TerminalPaneDockMount {...baseProps} pane={pane} docked={false} />)

    const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()

    act(() => {
      xtermContainer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })

    expect(document.activeElement).toBe(input)
  })

  it('releases the prevent-focus attribute and returns focus to xterm when hysteresis auto-hides the dock', () => {
    class FakeResizeObserver {
      static instances: FakeResizeObserver[] = []
      callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
        FakeResizeObserver.instances.push(this)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof globalThis.ResizeObserver

    try {
      const pane = makeFakePane()
      const focusSpy = vi.spyOn(pane.terminal, 'focus')
      render(<TerminalPaneDockMount {...baseProps} pane={pane} docked={true} />)
      act(() => {
        screen.getByRole('textbox').focus()
      })
      const xtermContainer = pane.container.querySelector('.xterm-container') as HTMLElement
      expect(xtermContainer).toHaveAttribute('data-pane-prevent-terminal-focus')

      const shrunkHeight = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS) - 1
      act(() => {
        FakeResizeObserver.instances[0]?.callback(
          [{ contentRect: { height: shrunkHeight } } as ResizeObserverEntry],
          FakeResizeObserver.instances[0] as unknown as ResizeObserver
        )
      })

      expect(xtermContainer).not.toHaveAttribute('data-pane-prevent-terminal-focus')
      expect(focusSpy).toHaveBeenCalledTimes(1)

      // Focus is released, not just the attribute: a terminal mousedown after the auto-hide
      // must reach xterm normally instead of being reclaimed by a now-hidden composer.
      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()
      act(() => {
        xtermContainer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      })
      expect(document.activeElement).toBe(input)
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
  })

  it('never unmounts the composer mid-drag even when live rows cross the auto-undock threshold, and settles once on release', async () => {
    function GutterRowsHarness({ pane }: { pane: ManagedPane }): ReactNode {
      const [gutterRows, setGutterRows] = useState(DEFAULT_GUTTER_ROWS)
      return (
        <TerminalPaneDockMount
          {...baseProps}
          pane={pane}
          docked={true}
          gutterRows={gutterRows}
          onCommitGutterRows={setGutterRows}
        />
      )
    }

    const pane = makeFakePane()
    // A fixed 300px pane: low/high thresholds for the default 5-row gutter are 240/280
    // (mounted), but for the 15-row (max) gutter dragged to below, low is 440 — well past
    // 300px, so growing the drag genuinely should undock once it settles.
    pane.container.getBoundingClientRect = () => ({ height: 300 }) as DOMRect

    render(<GutterRowsHarness pane={pane} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    const handle = pane.container.querySelector('[data-terminal-dock-gutter-handle]') as HTMLElement
    expect(handle).not.toBeNull()

    const dispatchWindowPointer = (type: string, clientY: number): void => {
      const event = new Event(type) as PointerEvent
      Object.defineProperty(event, 'clientY', { value: clientY })
      Object.defineProperty(event, 'pointerId', { value: 1 })
      window.dispatchEvent(event)
    }

    act(() => {
      fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
    })

    // Drag up 200px == 10 rows: 5 -> 15 (clamped max), crossing the low threshold for a
    // 300px pane mid-gesture.
    await act(async () => {
      dispatchWindowPointer('pointermove', -100)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    // Pause, then grow further still — never unmounts while the drag stays live.
    await act(async () => {
      dispatchWindowPointer('pointermove', -140)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    await act(async () => {
      dispatchWindowPointer('pointerup', -140)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    // Release settles at the final (15-row) gutter, which genuinely doesn't fit a 300px
    // pane — auto-undock now applies, evaluated exactly once.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  describe('gutter-drag termination unfreezes auto-undock', () => {
    const noopCommit = (): void => {}
    function GutterRowsHarness({
      pane,
      onCommit = noopCommit
    }: {
      pane: ManagedPane
      onCommit?: (rows: number) => void
    }): ReactNode {
      const [gutterRows, setGutterRows] = useState(DEFAULT_GUTTER_ROWS)
      return (
        <TerminalPaneDockMount
          {...baseProps}
          pane={pane}
          docked={true}
          gutterRows={gutterRows}
          onCommitGutterRows={(rows) => {
            setGutterRows(rows)
            onCommit(rows)
          }}
        />
      )
    }

    function installFakeResizeObserver(): {
      trigger: (height: number) => void
      restore: () => void
    } {
      const original = globalThis.ResizeObserver
      let callback: ResizeObserverCallback | null = null
      class FakeResizeObserver {
        constructor(cb: ResizeObserverCallback) {
          callback = cb
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
      return {
        trigger: (height: number) => {
          act(() => {
            callback?.([{ contentRect: { height } } as ResizeObserverEntry], {} as ResizeObserver)
          })
        },
        restore: () => {
          globalThis.ResizeObserver = original
        }
      }
    }

    function dispatchWindowPointer(type: string, clientY: number, pointerId = 1): void {
      const event = new Event(type) as PointerEvent
      Object.defineProperty(event, 'clientY', { value: clientY })
      Object.defineProperty(event, 'pointerId', { value: pointerId })
      window.dispatchEvent(event)
    }

    const shrunkHeight = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS) - 1

    it('unfreezes auto-undock on a release that lands back on the starting row', async () => {
      const resizeObserver = installFakeResizeObserver()
      try {
        const pane = makeFakePane()
        const onCommit = vi.fn()
        render(<GutterRowsHarness pane={pane} onCommit={onCommit} />)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        const handle = pane.container.querySelector(
          '[data-terminal-dock-gutter-handle]'
        ) as HTMLElement

        act(() => {
          fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
        })
        await act(async () => {
          dispatchWindowPointer('pointermove', 60)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })

        // Pane shrinks below the low threshold mid-drag: frozen, so auto-undock must not fire yet.
        resizeObserver.trigger(shrunkHeight)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        // Move back to the exact start row before releasing — an unchanged-row commit.
        await act(async () => {
          dispatchWindowPointer('pointermove', 100)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })
        await act(async () => {
          dispatchWindowPointer('pointerup', 100)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })

        expect(onCommit).not.toHaveBeenCalled()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      } finally {
        resizeObserver.restore()
      }
    })

    it('leaves a fresh drag able to commit normally after a prior release landed back on the starting row', async () => {
      const pane = makeFakePane()
      const onCommit = vi.fn()
      render(<GutterRowsHarness pane={pane} onCommit={onCommit} />)

      const getHandle = (): HTMLElement =>
        pane.container.querySelector('[data-terminal-dock-gutter-handle]') as HTMLElement

      // First drag: grow away from the start row, then release back on it — no commit.
      act(() => {
        fireEvent.pointerDown(getHandle(), { clientY: 100, pointerId: 1 })
      })
      await act(async () => {
        dispatchWindowPointer('pointermove', 60)
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      await act(async () => {
        dispatchWindowPointer('pointermove', 100)
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      await act(async () => {
        dispatchWindowPointer('pointerup', 100)
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      expect(onCommit).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox')).toBeInTheDocument()

      // A fresh drag that actually changes rows still commits normally afterward.
      act(() => {
        fireEvent.pointerDown(getHandle(), { clientY: 100, pointerId: 1 })
      })
      await act(async () => {
        dispatchWindowPointer('pointermove', 60)
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })
      await act(async () => {
        dispatchWindowPointer('pointerup', 60)
        await new Promise((resolve) => requestAnimationFrame(resolve))
        await new Promise((resolve) => requestAnimationFrame(resolve))
      })

      expect(onCommit).toHaveBeenCalledTimes(1)
    })

    it('unfreezes on pointercancel', async () => {
      const resizeObserver = installFakeResizeObserver()
      try {
        const pane = makeFakePane()
        render(<GutterRowsHarness pane={pane} />)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        const handle = pane.container.querySelector(
          '[data-terminal-dock-gutter-handle]'
        ) as HTMLElement

        act(() => {
          fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
        })
        await act(async () => {
          dispatchWindowPointer('pointermove', 60)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })

        resizeObserver.trigger(shrunkHeight)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        act(() => {
          dispatchWindowPointer('pointercancel', 60)
        })

        expect(baseProps.onCommitGutterRows).not.toHaveBeenCalled()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      } finally {
        resizeObserver.restore()
      }
    })

    it('unfreezes on a window blur', async () => {
      const resizeObserver = installFakeResizeObserver()
      try {
        const pane = makeFakePane()
        render(<GutterRowsHarness pane={pane} />)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        const handle = pane.container.querySelector(
          '[data-terminal-dock-gutter-handle]'
        ) as HTMLElement

        act(() => {
          fireEvent.pointerDown(handle, { clientY: 100, pointerId: 1 })
        })
        await act(async () => {
          dispatchWindowPointer('pointermove', 60)
          await new Promise((resolve) => requestAnimationFrame(resolve))
        })

        resizeObserver.trigger(shrunkHeight)
        expect(screen.getByRole('textbox')).toBeInTheDocument()

        act(() => {
          window.dispatchEvent(new Event('blur'))
        })

        expect(baseProps.onCommitGutterRows).not.toHaveBeenCalled()
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      } finally {
        resizeObserver.restore()
      }
    })
  })
})

describe('terminalPaneUsesConptyBelowWrapMarkers', () => {
  const cases = [
    ['no local or remote ConPTY evidence', undefined, undefined, false],
    ['local ConPTY without a build', { backend: 'conpty' }, undefined, true],
    ['local ConPTY with a build', { backend: 'conpty', buildNumber: 26100 }, undefined, false],
    ['remote unverified ConPTY stamp', undefined, 'true', true],
    ['remote verified ConPTY stamp', undefined, 'false', false]
  ] as const

  it.each(cases)('%s', (_, windowsPty, remoteStamp, expected) => {
    const pane = makeFakePane()
    if (windowsPty) {
      pane.terminal.options = { windowsPty }
    }
    if (remoteStamp) {
      pane.container.dataset[REMOTE_CONPTY_UNVERIFIED_DATASET_KEY] = remoteStamp
    }
    expect(terminalPaneUsesConptyBelowWrapMarkers(pane)).toBe(expected)
  })
})
