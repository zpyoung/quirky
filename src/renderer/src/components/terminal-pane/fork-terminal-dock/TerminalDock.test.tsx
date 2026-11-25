// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useImperativeHandle, useRef, type Ref } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposerHandle } from '../../chat/composer/composer-types'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
// the composer itself is covered by TerminalDockComposer.test; the dock owns layout and focus here
vi.mock('./TerminalDockComposer', () => ({
  TerminalDockComposer: function StubComposer({
    ref,
    canSend
  }: {
    ref: Ref<ComposerHandle>
    canSend: boolean
  }) {
    const textarea = useRef<HTMLTextAreaElement>(null)
    useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }))
    return <textarea ref={textarea} disabled={!canSend} />
  }
}))

import {
  TerminalDock,
  terminalDockAutoUndockHighThresholdPx,
  terminalDockAutoUndockLowThresholdPx,
  terminalDockGutterHeightPx
} from './TerminalDock'
import { DEFAULT_GUTTER_ROWS, MAX_GUTTER_ROWS, MIN_GUTTER_ROWS } from './terminal-dock-pane-state'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const baseProps = {
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  targetPtyId: 'pty-1',
  agent: 'claude' as const,
  paneHeightPx: terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS) + 100,
  disabledReason: null
}

describe('TerminalDock', () => {
  it('renders the composer and accepts typing', () => {
    render(<TerminalDock {...baseProps} />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea).toBeEnabled()
    fireEvent.change(textarea, { target: { value: 'hello dock' } })
    expect(textarea.value).toBe('hello dock')
  })

  it('recovers from a null pty id when a late attach re-renders it in', () => {
    // The pane's transport has no id until the deferred attach lands, so the dock's first
    // render is legitimately null; it must come back live on the re-render, not stay stuck.
    const { rerender } = render(
      <TerminalDock {...baseProps} targetPtyId={null} disabledReason="No terminal session" />
    )
    expect(screen.getByRole('status')).toHaveTextContent('No terminal session')
    expect(screen.getByRole('textbox')).toBeDisabled()

    rerender(<TerminalDock {...baseProps} targetPtyId="pty-1" disabledReason={null} />)

    expect(screen.getByRole('status')).not.toHaveTextContent('No terminal session')
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('exposes the composer imperative handle through its own forwarded ref', () => {
    const ref = createRef<ComposerHandle>()
    render(<TerminalDock {...baseProps} ref={ref} />)

    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
    ref.current?.focus()
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('marks its interactive dock chrome so pointerdown never yanks terminal focus', () => {
    render(<TerminalDock {...baseProps} />)
    const dock = screen.getByRole('status').closest('[data-terminal-dock]')
    expect(dock).toHaveAttribute('data-pane-prevent-terminal-focus')
  })

  it('shows a specific disabled reason and disables the composer, without changing layout', () => {
    const { container: enabledContainer } = render(<TerminalDock {...baseProps} />)
    const enabledHeight = (enabledContainer.firstChild as HTMLElement).style.height
    cleanup()

    render(<TerminalDock {...baseProps} disabledReason="Reconnecting" />)
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting')
    expect(screen.getByRole('textbox')).toBeDisabled()

    const disabledContainer = screen.getByRole('status').closest('[data-terminal-dock]')
    expect((disabledContainer as HTMLElement).style.height).toBe(enabledHeight)
  })

  it('reserves space for the reason even when there is none, so the reason toggling does not reflow', () => {
    render(<TerminalDock {...baseProps} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('')
    expect(status.firstElementChild).toHaveClass('invisible')
  })

  it('uses a 180px default gutter with 240/280 auto-undock thresholds', () => {
    expect(terminalDockGutterHeightPx(DEFAULT_GUTTER_ROWS)).toBe(180)
    expect(terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)).toBe(240)
    expect(terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)).toBe(280)
  })

  it('claims paste for the composer instead of letting the terminal pane swallow it', () => {
    render(<TerminalDock {...baseProps} />)
    const dock = screen.getByRole('status').closest('[data-terminal-dock]')
    expect(dock).toHaveAttribute('data-native-chat-root', 'true')
  })

  it('unmounts below the low threshold', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('stays mounted between the low and high thresholds once already mounted (no flap on 1px)', () => {
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high - 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('stays unmounted between the low and high thresholds once already unmounted (no flap on 1px)', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={low + 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('re-mounts once the height reaches the high threshold', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const high = terminalDockAutoUndockHighThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} paneHeightPx={high} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('does not mount a 15-row gutter in a pane too short to fit it', () => {
    const gutterRows = MAX_GUTTER_ROWS
    const tooShort = terminalDockGutterHeightPx(gutterRows)
    render(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={tooShort} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('does not mount the default gutter in a pane too short to fit it', () => {
    render(<TerminalDock {...baseProps} gutterRows={DEFAULT_GUTTER_ROWS} paneHeightPx={180} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('scales thresholds with gutterRows: a height that mounts a 3-row gutter rejects a 15-row one', () => {
    const paneHeightPx = terminalDockAutoUndockHighThresholdPx(MIN_GUTTER_ROWS)

    render(<TerminalDock {...baseProps} gutterRows={MIN_GUTTER_ROWS} paneHeightPx={paneHeightPx} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
    cleanup()

    render(<TerminalDock {...baseProps} gutterRows={MAX_GUTTER_ROWS} paneHeightPx={paneHeightPx} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('reports mount and unmount edges exactly once each, not on every render', () => {
    const onMountedChange = vi.fn()
    const { rerender } = render(<TerminalDock {...baseProps} onMountedChange={onMountedChange} />)
    expect(onMountedChange).toHaveBeenCalledTimes(1)
    expect(onMountedChange).toHaveBeenLastCalledWith(true)

    rerender(<TerminalDock {...baseProps} onMountedChange={onMountedChange} gutterRows={6} />)
    expect(onMountedChange).toHaveBeenCalledTimes(1)

    const low = terminalDockAutoUndockLowThresholdPx(6)
    rerender(
      <TerminalDock
        {...baseProps}
        onMountedChange={onMountedChange}
        gutterRows={6}
        paneHeightPx={low - 1}
      />
    )
    expect(onMountedChange).toHaveBeenCalledTimes(2)
    expect(onMountedChange).toHaveBeenLastCalledWith(false)
  })

  it('reports an unmount edge when the host removes the component outright', () => {
    const onMountedChange = vi.fn()
    const { unmount } = render(<TerminalDock {...baseProps} onMountedChange={onMountedChange} />)
    onMountedChange.mockClear()

    unmount()

    expect(onMountedChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('renders a gutter drag handle only when a pointerdown handler is supplied', () => {
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(document.querySelector('[data-terminal-dock-gutter-handle]')).not.toBeInTheDocument()

    const onGutterPointerDown = vi.fn()
    rerender(<TerminalDock {...baseProps} onGutterPointerDown={onGutterPointerDown} />)
    const handle = document.querySelector('[data-terminal-dock-gutter-handle]')
    expect(handle).toBeInTheDocument()
    fireEvent.pointerDown(handle as Element)
    expect(onGutterPointerDown).toHaveBeenCalledTimes(1)
  })

  it('makes the composer inert while passthrough owns input', () => {
    const { rerender } = render(<TerminalDock {...baseProps} passthroughActive={true} />)
    expect(screen.getByText(/passthrough active/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
    const dock = screen.getByRole('status').closest('[data-terminal-dock]')
    expect(dock).toHaveAttribute('data-terminal-dock-passthrough')
    expect(screen.getByRole('textbox').closest('[inert]')).not.toBeNull()

    rerender(<TerminalDock {...baseProps} passthroughActive={false} />)
    expect(screen.queryByText(/passthrough active/i)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeEnabled()
  })

  it('suspends auto-undock while a gutter drag is active, then evaluates once it ends', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    const { rerender } = render(<TerminalDock {...baseProps} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterDragActive={true} paneHeightPx={low - 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    // Reverting past the threshold mid-drag must not remount either — no flip-flop.
    rerender(<TerminalDock {...baseProps} gutterDragActive={true} paneHeightPx={low + 100} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterDragActive={false} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('still auto-undocks from a pane-height change when no drag is active', () => {
    const low = terminalDockAutoUndockLowThresholdPx(DEFAULT_GUTTER_ROWS)
    render(<TerminalDock {...baseProps} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('does not flap at +/-1px around the derived thresholds for a non-default gutterRows', () => {
    const gutterRows = MAX_GUTTER_ROWS
    const low = terminalDockAutoUndockLowThresholdPx(gutterRows)
    const high = terminalDockAutoUndockHighThresholdPx(gutterRows)

    const { rerender } = render(
      <TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high + 100} />
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={low + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={low - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high - 1} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    rerender(<TerminalDock {...baseProps} gutterRows={gutterRows} paneHeightPx={high + 1} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })
})
