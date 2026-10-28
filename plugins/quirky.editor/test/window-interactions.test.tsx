import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import { CloseOverlay } from '../src/window/CloseOverlay'
import { QuickOpenOverlay } from '../src/window/QuickOpenOverlay'
import { clearOverlayRequests, requestSingleClose, showQuickOpen } from '../src/window/overlayState'


beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  clearOverlayRequests()
  document.body.innerHTML = ''
})

test('Escape cancels the shared dirty-close dialog without saving or closing its draft', async () => {
  const calls: string[] = []
  const context = {
    call: async (method: string) => {
      calls.push(method)
      if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
      if (method === 'quirky.editor/state') {
        return { buffers: [{ id: 'buffer-1', tabId: 'tab-1', name: 'notes.md', dirty: true }] }
      }
      throw new Error(`Unexpected call: ${method}`)
    },
    toast() {},
  } as unknown as UiPluginContext
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  let result!: Promise<boolean>

  await act(async () => {
    root.render(<CloseOverlay />)
    result = requestSingleClose(context, 'buffer-1', 'tab-1')
    await Promise.resolve()
    await Promise.resolve()
  })

  const dialog = element.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog).not.toBeNull()
  expect(dialog!.contains(document.activeElement)).toBe(true)
  await act(async () => {
    dialog!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  expect(await result).toBe(false)
  expect(calls).toEqual(['quirky.editor/close', 'quirky.editor/state'])
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { root.unmount() })
})

async function flushTimers(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await act(async () => { await promise })
}

test('Quick Open keeps focus and arrow/Enter navigation inside the shared dialog', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.editor/quickOpen') {
        return {
          results: [
            { path: 'src/alpha.ts', name: 'alpha.ts', score: 1 },
            { path: 'src/beta.ts', name: 'beta.ts', score: 1 }
          ],
          truncated: false,
          history: []
        }
      }
      return {}
    },
    toast() {},
  } as unknown as UiPluginContext
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  showQuickOpen(context, 'worktree-1')

  await act(async () => { root.render(<QuickOpenOverlay context={context} />) })
  await flushTimers()

  const input = element.querySelector<HTMLInputElement>('input[aria-label="Go to file"]')
  expect(input).not.toBeNull()
  expect(document.activeElement).toBe(input)
  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  expect(element.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('beta.ts')

  await act(async () => {
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  await flushTimers()
  expect(calls).toContainEqual(expect.objectContaining({
    method: 'quirky.editor/open',
    params: expect.objectContaining({ path: 'src/beta.ts', focus: true, preview: false })
  }))
  expect(element.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { root.unmount() })
})
