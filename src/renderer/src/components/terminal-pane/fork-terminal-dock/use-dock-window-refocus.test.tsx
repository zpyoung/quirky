// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDockWindowRefocus } from './use-dock-window-refocus'

function Dock({ focus }: { focus: () => void }): React.JSX.Element {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const composer = useRef({ focus })
  useDockWindowRefocus(root, composer)
  return (
    <div ref={setRoot}>
      <input aria-label="composer" />
    </div>
  )
}

afterEach(cleanup)

function renderDock(focus: () => void) {
  return render(<Dock focus={focus} />)
}

describe('useDockWindowRefocus', () => {
  it('returns focus to the composer when the window refocuses onto the body after the composer held focus', () => {
    const focus = vi.fn()
    const view = renderDock(focus)
    view.getByLabelText('composer').focus()

    act(() => {
      window.dispatchEvent(new Event('blur'))
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      window.dispatchEvent(new Event('focus'))
    })

    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when the composer did not hold it at blur', () => {
    const focus = vi.fn()
    renderDock(focus)

    act(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(focus).not.toHaveBeenCalled()
  })

  it('does not take focus from an element the window restored itself', () => {
    const focus = vi.fn()
    const view = renderDock(focus)
    const input = view.getByLabelText('composer')
    input.focus()

    act(() => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(document.activeElement).toBe(input)
    expect(focus).not.toHaveBeenCalled()
  })
})
