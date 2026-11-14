import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import { CloseOverlay } from '../src/window/CloseOverlay'
import { QuickOpenOverlay } from '../src/window/QuickOpenOverlay'
import { clearOverlayRequests, requestSingleClose, showQuickOpen } from '../src/window/overlayState'
import {
  EditorUiControlProvider,
  createEditorUiControlReportScope,
  runEditorUiControl,
  type EditorUiControlReportScope
} from '../src/window/uiControl'
type ControlAddress = { surface: string; target: string; generation: string; actions: string[] }
type OverlayReport = { uiControls?: ControlAddress[]; requestId?: number | null; busy?: boolean; error?: string | null }
type TrackedRoot = { root: Root; scope: EditorUiControlReportScope; mounted: boolean }
const trackedRoots: TrackedRoot[] = []

function trackRoot(root: Root, scope: EditorUiControlReportScope): TrackedRoot {
  const tracked = { root, scope, mounted: true }
  trackedRoots.push(tracked)
  return tracked
}

async function unmountRoot(tracked: TrackedRoot): Promise<void> {
  if (!tracked.mounted) return
  tracked.mounted = false
  await act(async () => { tracked.root.unmount() })
  tracked.scope.dispose()
}


beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  const roots = trackedRoots.splice(0)
  await act(async () => {
    clearOverlayRequests()
    for (const tracked of roots) {
      if (!tracked.mounted) continue
      tracked.mounted = false
      tracked.root.unmount()
    }
  })
  for (const tracked of roots) tracked.scope.dispose()
  document.body.innerHTML = ''
})

test('Escape cancels the shared dirty-close dialog without saving or closing its draft', async () => {
  const calls: string[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') return { result: await runEditorUiControl(params.args) }
      calls.push(method)
      if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
      if (method === 'quirky.editor/state') {
        return { buffers: [{ id: 'buffer-1', tabId: 'tab-1', name: 'notes.md', dirty: true }] }
      }
      throw new Error(`Unexpected call: ${method}`)
    },
    toast() {},
  } as unknown as UiPluginContext
  const scope = createEditorUiControlReportScope(undefined, { surface: 'overlay:quirky.editor/close' })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  trackRoot(root, scope)
  let result!: Promise<boolean>

  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><CloseOverlay context={context} /></EditorUiControlProvider>)
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
      if (method === 'ui.window.self') return { connId: 22 }
      if (method === 'ui.window.command.run') return { result: await runEditorUiControl(params?.args) }
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
  const scope = createEditorUiControlReportScope(undefined, { surface: 'overlay:quirky.editor/quick-open' })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  trackRoot(root, scope)
  showQuickOpen(context, 'worktree-1')

  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><QuickOpenOverlay context={context} /></EditorUiControlProvider>)
  })
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
})

test('Quick Open refuses an old address after synchronous request replacement', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.editor/quickOpen') {
        return { results: [{ path: 'a.md', name: 'a.md', score: 1 }], history: [], truncated: false }
      }
      return {}
    },
    toast() {}
  } as unknown as UiPluginContext
  let report: OverlayReport = {}
  const scope = createEditorUiControlReportScope((value) => { report = value as OverlayReport }, {
    surface: 'overlay:quirky.editor/quick-open'
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  trackRoot(root, scope)
  showQuickOpen(context, 'w1')
  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><QuickOpenOverlay context={context} /></EditorUiControlProvider>)
  })
  await flushTimers()

  const oldAddress = report.uiControls?.find(({ actions }) => actions.includes('open'))
  expect(oldAddress).toBeDefined()
  let staleResult!: { delivered: boolean }
  await act(async () => {
    showQuickOpen(context, 'w2')
    staleResult = await runEditorUiControl({
      surface: oldAddress!.surface,
      target: oldAddress!.target,
      generation: oldAddress!.generation,
      action: 'open',
      data: { path: 'a.md' }
    })
  })
  expect(staleResult).toEqual({ delivered: false })
  expect(calls.filter(({ method, params }) =>
    method === 'quirky.editor/open' || (method === 'quirky.editor/quickOpen' && params?.action === 'record')
  )).toEqual([])
  const currentAddress = report.uiControls?.find(({ actions }) => actions.includes('cancel'))
  expect(currentAddress).toBeDefined()
  await act(async () => {
    await runEditorUiControl({
      surface: currentAddress!.surface,
      target: currentAddress!.target,
      generation: currentAddress!.generation,
      action: 'cancel'
    })
  })
})

test('dirty close refuses an old address after synchronous clear', async () => {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
      if (method === 'quirky.editor/state') {
        return { buffers: [{ id: 'buffer-1', tabId: 'tab-1', name: 'notes.md', dirty: true }] }
      }
      return {}
    },
    toast() {}
  } as unknown as UiPluginContext
  let report: OverlayReport = {}
  const scope = createEditorUiControlReportScope((value) => { report = value as OverlayReport }, {
    surface: 'overlay:quirky.editor/close'
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  trackRoot(root, scope)
  let closing!: Promise<boolean>
  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><CloseOverlay context={context} /></EditorUiControlProvider>)
    closing = requestSingleClose(context, 'buffer-1', 'tab-1')
    await Promise.resolve()
    await Promise.resolve()
  })
  const oldAddress = report.uiControls?.find(({ actions }) => actions.includes('choose'))
  expect(oldAddress).toBeDefined()
  let staleResult!: { delivered: boolean }
  await act(async () => {
    clearOverlayRequests()
    staleResult = await runEditorUiControl({
      surface: oldAddress!.surface,
      target: oldAddress!.target,
      generation: oldAddress!.generation,
      action: 'choose',
      data: { choice: 'discard' }
    })
  })
  expect(staleResult).toEqual({ delivered: false })
  expect(calls.filter(({ method, params }) => method === 'quirky.editor/close' && params?.choice === 'discard')).toEqual([])
  expect(await closing).toBe(false)
})

test('close busy state clears when its operation settles after the overlay remounts', async () => {
  const pending = Promise.withResolvers<unknown>()
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.editor/close' && params.choice === 'save') return pending.promise
      if (method === 'quirky.editor/close') return { closed: false, needsDecision: true }
      if (method === 'quirky.editor/state') {
        return { buffers: [{ id: 'buffer-1', tabId: 'tab-1', name: 'notes.md', dirty: true }] }
      }
      return {}
    },
    toast() {}
  } as unknown as UiPluginContext
  const element = document.createElement('div')
  document.body.append(element)
  let report: OverlayReport = {}
  let scope = createEditorUiControlReportScope((value) => { report = value as OverlayReport }, {
    surface: 'overlay:quirky.editor/close'
  })
  let root = createRoot(element)
  let tracked = trackRoot(root, scope)
  let closing!: Promise<boolean>
  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><CloseOverlay context={context} /></EditorUiControlProvider>)
    closing = requestSingleClose(context, 'buffer-1', 'tab-1')
    await Promise.resolve()
    await Promise.resolve()
  })
  const requestId = report.requestId
  const firstAddress = report.uiControls?.find(({ actions }) => actions.includes('choose'))
  expect(firstAddress).toBeDefined()
  let saving!: Promise<{ delivered: boolean }>
  await act(async () => {
    saving = runEditorUiControl({
      surface: firstAddress!.surface,
      target: firstAddress!.target,
      generation: firstAddress!.generation,
      action: 'choose',
      data: { choice: 'save' }
    })
    await Promise.resolve()
  })
  expect(report.busy).toBe(true)
  await unmountRoot(tracked)

  report = {}
  scope = createEditorUiControlReportScope((value) => { report = value as OverlayReport }, {
    surface: 'overlay:quirky.editor/close'
  })
  root = createRoot(element)
  tracked = trackRoot(root, scope)
  await act(async () => {
    root.render(<EditorUiControlProvider scope={scope}><CloseOverlay context={context} /></EditorUiControlProvider>)
  })
  const remountedAddress = report.uiControls?.find(({ actions }) => actions.includes('choose'))
  expect(report.requestId).toBe(requestId)
  expect(report.busy).toBe(true)
  expect(remountedAddress).toBeDefined()
  expect(await runEditorUiControl({
    surface: remountedAddress!.surface,
    target: remountedAddress!.target,
    generation: remountedAddress!.generation,
    action: 'choose',
    data: { choice: 'discard' }
  })).toEqual({ delivered: false })
  expect(calls.filter(({ method, params }) => method === 'quirky.editor/close' && params?.choice === 'discard')).toEqual([])

  await act(async () => { pending.resolve({ closed: false, needsDecision: true }); await saving })
  expect(await saving).toEqual({ delivered: false })
  expect(calls.filter(({ method, params }) => method === 'quirky.editor/close' && params?.choice === 'save')).toHaveLength(1)
  expect(report.requestId).toBe(requestId)
  expect(report.busy).toBe(false)
  expect(element.querySelector('.ui-inline-error')).toBeNull()
  let canceled!: { delivered: boolean }
  await act(async () => {
    canceled = await runEditorUiControl({
      surface: remountedAddress!.surface,
      target: remountedAddress!.target,
      generation: remountedAddress!.generation,
      action: 'choose',
      data: { choice: 'cancel' }
    })
  })
  expect(canceled).toEqual({ delivered: true })
  expect(await closing).toBe(false)
})
