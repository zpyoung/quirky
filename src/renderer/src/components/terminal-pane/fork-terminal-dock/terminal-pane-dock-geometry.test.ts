// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { queuePanePtyResizeIfHeld } from '@/lib/pane-manager/pane-pty-resize-hold'
import { applyTerminalDockGeometryChange } from './terminal-pane-dock-geometry'

function makeFakePane(): ManagedPane {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = '1'
  return { container } as unknown as ManagedPane
}

describe('applyTerminalDockGeometryChange', () => {
  it('sends exactly one PTY resize even when fit queues several', () => {
    const pane = makeFakePane()
    let flushCount = 0
    pane.container.addEventListener('quirky-pane-pty-resize-hold-flush', () => {
      flushCount += 1
    })

    applyTerminalDockGeometryChange(pane, () => {
      queuePanePtyResizeIfHeld(pane.container, 80, 24)
      queuePanePtyResizeIfHeld(pane.container, 80, 30)
      return true
    })

    expect(flushCount).toBe(1)
  })

  it('sends no resize when fit never changes the terminal grid', () => {
    const pane = makeFakePane()
    let flushCount = 0
    pane.container.addEventListener('quirky-pane-pty-resize-hold-flush', () => {
      flushCount += 1
    })

    applyTerminalDockGeometryChange(pane, () => true)

    expect(flushCount).toBe(0)
  })

  it('releases the resize hold even when the geometry mutation throws', () => {
    const pane = makeFakePane()

    expect(() =>
      applyTerminalDockGeometryChange(
        pane,
        () => true,
        () => {
          throw new Error('mutation failed')
        }
      )
    ).toThrow('mutation failed')
    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
  })

  it('is not held once the change settles, so the next resize sends immediately', () => {
    const pane = makeFakePane()
    applyTerminalDockGeometryChange(pane, () => true)

    expect(queuePanePtyResizeIfHeld(pane.container, 80, 24)).toBe(false)
  })
})
