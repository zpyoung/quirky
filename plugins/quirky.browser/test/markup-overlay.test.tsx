import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { createRoot as CreateReactRoot, Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { DesignScreenshot } from '../src/design-contract'
import { dispatchDesignControl } from '../src/ui-control'

import type { MarkupOverlay as MarkupOverlayExport } from '../src/markup/MarkupOverlay'

let createRoot: typeof CreateReactRoot
let MarkupOverlay: typeof MarkupOverlayExport

const DESIGN = 'command:quirky.browser/designControl'
const RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)

const mountedViews = new Set<() => void>()
const restorers: Array<() => void> = []
beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of nativeGlobals) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  // ReactDOM reads DOM input support at import; load ReactDOM and its portal consumer after HappyDOM.
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkupOverlay } = await import('../src/markup/MarkupOverlay'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterEach(async () => {
  await act(async () => {
    for (const unmount of [...mountedViews]) unmount()
  })
  for (const restore of restorers.splice(0).reverse()) restore()
})
afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => { document.body.innerHTML = '' })

const screenshot: DesignScreenshot = {
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA',
  width: 10,
  height: 10
}

type ClipboardRecord = Record<string, Blob | Promise<Blob>>
type LocalClipboardItem = { types: string[]; record: ClipboardRecord }
type PlatformOptions = { decode?: Promise<void>; afterData?: Promise<void>; logData?: boolean }

type TestPlatform = {
  log: string[]
  writes: LocalClipboardItem[][]
  restore(): void
}

function restoreDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor)
  else Reflect.deleteProperty(target, key)
}

function installPlatform(log: string[], options: PlatformOptions = {}): TestPlatform {
  const writes: LocalClipboardItem[][] = []
  const imageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Image')
  const itemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem')
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const getContextDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')
  const toBlobDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')

  class TestImage {
    naturalWidth = 10
    naturalHeight = 10
    src = ''
    decode(): Promise<void> {
      log.push('decode')
      return options.decode ?? Promise.resolve()
    }
  }

  class TestClipboardItem {
    readonly types: string[]
    readonly record: ClipboardRecord
    constructor(record: ClipboardRecord) {
      this.types = Object.keys(record)
      this.record = record
    }
  }

  const canvasContext = {
    clearRect() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {},
    moveTo() {}, lineTo() {}, stroke() {}, strokeRect() {}, ellipse() {}, fillText() {}
  } as unknown as CanvasRenderingContext2D

  Object.defineProperty(globalThis, 'Image', { configurable: true, value: TestImage })
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: TestClipboardItem })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      write: async (items: LocalClipboardItem[]) => {
        log.push('write')
        writes.push(items)
        for (const item of items) {
          for (const type of item.types) await item.record[type]
        }
        if (options.logData) log.push('data')
        if (options.afterData) await options.afterData
        log.push('write-settled')
      }
    }
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => canvasContext
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => {
      log.push('toBlob')
      callback(new Blob(['png'], { type: 'image/png' }))
    }
  })

  const restore = () => {
    restoreDescriptor(globalThis, 'Image', imageDescriptor)
    restoreDescriptor(globalThis, 'ClipboardItem', itemDescriptor)
    restoreDescriptor(navigator, 'clipboard', clipboardDescriptor)
    restoreDescriptor(HTMLCanvasElement.prototype, 'getContext', getContextDescriptor)
    restoreDescriptor(HTMLCanvasElement.prototype, 'toBlob', toBlobDescriptor)
  }
  restorers.push(restore)
  return { log, writes, restore }
}

type RecordedCommand = { id: string; args: unknown; options: unknown }
type MountOptions = PlatformOptions & { screenshot?: DesignScreenshot }
type OverlayMount = {
  context: UiPluginContext
  calls: RecordedCommand[]
  failure(error: Error | null): void
  log: string[]
  writes: LocalClipboardItem[][]
  dialog(): HTMLDivElement
  unmount(): void
}

function mount(options: MountOptions = {}): OverlayMount {
  const log: string[] = []
  const platform = installPlatform(log, options)
  const calls: RecordedCommand[] = []
  let executeCommandFailure: Error | null = null
  let context: UiPluginContext
  context = {
    executeCommand: async (id: string, args: unknown, commandOptions: unknown) => {
      calls.push({ id, args, options: commandOptions })
      if (executeCommandFailure) throw executeCommandFailure
      await Promise.resolve()
      return dispatchDesignControl(context, args)
    }
  } as unknown as UiPluginContext

  const host = document.createElement('div')
  document.body.append(host)
  const root: Root = createRoot(host)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    mountedViews.delete(unmount)
    root.unmount()
  }
  mountedViews.add(unmount)
  act(() => root.render(<MarkupOverlay
    context={context}
    pane="pane-1"
    screenshot={options.screenshot ?? screenshot}
    onClose={() => { log.push('onClose') }}
    onCopied={() => { log.push('onCopied') }}
    onError={(message) => { log.push(`onError:${message}`) }}
  />))

  return {
    context,
    calls,
    failure: (error) => { executeCommandFailure = error },
    log,
    writes: platform.writes,
    dialog: () => {
      const dialog = document.querySelector<HTMLDivElement>('[role="dialog"]')
      if (!dialog) throw new Error('Markup dialog was not found')
      return dialog
    },
    unmount
  }
}

function button(ui: OverlayMount, label: string): HTMLButtonElement {
  const found = [...ui.dialog().querySelectorAll<HTMLButtonElement>('button')].find((entry) =>
    entry.textContent?.trim() === label || entry.getAttribute('aria-label') === label
  )
  if (!found) throw new Error(`Button ${label} was not found`)
  return found
}

const M = (args: Record<string, unknown>) => ({ id: DESIGN, args: { pane: 'pane-1', ...args } })
const recorded = (ui: OverlayMount) => ui.calls.map(({ id, args }) => ({ id, args }))

async function clickButton(ui: OverlayMount, label: string): Promise<void> {
  await act(async () => {
    button(ui, label).click()
    await Promise.resolve()
  })
}

function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 80 && !predicate(); attempt++) await wait(5)
  expect(predicate()).toBe(true)
}

async function delay(milliseconds: number): Promise<void> {
  await wait(milliseconds)
}

function setTextInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('keyup', { bubbles: true }))
}

async function addTextMarkup(ui: OverlayMount): Promise<void> {
  await clickButton(ui, 'Text')
  const input = ui.dialog().querySelector<HTMLInputElement>('[aria-label="Text to place"]')
  if (!input) throw new Error('Text to place field was not found')
  await act(async () => {
    setTextInput(input, 'Hi')
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.defineProperties(pointer, {
      button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: 1 }, clientY: { value: 1 }
    })
    const canvas = ui.dialog().querySelector<HTMLCanvasElement>('[aria-label="Markup canvas"]')
    if (!canvas) throw new Error('Markup canvas was not found')
    canvas.dispatchEvent(pointer)
  })
}

test('routes Text through designControl before changing the selected tool', async () => {
  const ui = mount()
  act(() => {
    button(ui, 'Text').click()
    expect(recorded(ui)).toEqual([M({ action: 'markup-tool', tool: 'text' })])
    expect(button(ui, 'Text').getAttribute('aria-pressed')).toBe('false')
    expect(ui.dialog().querySelector('[aria-label="Text to place"]')).toBeNull()
  })
  await act(async () => { await Promise.resolve() })

  expect(button(ui, 'Text').getAttribute('aria-pressed')).toBe('true')
  expect(ui.dialog().querySelector('[aria-label="Text to place"]')).not.toBeNull()
})

test('routes undo, redo and clear while updating markup history', async () => {
  const ui = mount()
  await addTextMarkup(ui)
  expect(button(ui, 'Undo').disabled).toBe(false)

  await clickButton(ui, 'Undo')
  expect(recorded(ui)).toEqual([
    M({ action: 'markup-tool', tool: 'text' }),
    M({ action: 'markup-undo' })
  ])
  expect(button(ui, 'Undo').disabled).toBe(true)
  expect(button(ui, 'Redo').disabled).toBe(false)

  await clickButton(ui, 'Redo')
  expect(recorded(ui)).toEqual([
    M({ action: 'markup-tool', tool: 'text' }),
    M({ action: 'markup-undo' }),
    M({ action: 'markup-redo' })
  ])
  expect(button(ui, 'Clear all').disabled).toBe(false)

  await clickButton(ui, 'Clear all')
  expect(recorded(ui)).toEqual([
    M({ action: 'markup-tool', tool: 'text' }),
    M({ action: 'markup-undo' }),
    M({ action: 'markup-redo' }),
    M({ action: 'markup-clear' })
  ])
  expect(button(ui, 'Clear all').disabled).toBe(true)
})

test('routes Cancel through designControl and closes the overlay once', async () => {
  const ui = mount()
  await clickButton(ui, 'Cancel')

  expect(recorded(ui)).toEqual([M({ action: 'markup-close' })])
  expect(ui.log).toEqual(['onClose'])
})

test('Copy Markup preserves clipboard task ordering and writes one PNG item', async () => {
  const ui = mount()
  const platformLog = ui.log
  setTimeout(() => platformLog.push('timer'), 0)

  await act(async () => {
    button(ui, 'Copy Markup').click()
    await settleUntil(() => platformLog.includes('onCopied') && !button(ui, 'Copy Markup').disabled)
  })

  expect(recorded(ui)).toEqual([M({ action: 'markup-copy' })])
  expect(platformLog).toEqual(['write', 'decode', 'toBlob', 'write-settled', 'onCopied', 'timer'])
  expect(platformLog.filter((entry) => entry === 'onCopied')).toHaveLength(1)
  expect(platformLog.some((entry) => entry.startsWith('onError:'))).toBe(false)
  expect(ui.writes).toHaveLength(1)
  expect(ui.writes[0]![0]!.types).toEqual(['image/png'])
  const png = await ui.writes[0]![0]!.record['image/png']
  expect(png).toBeInstanceOf(Blob)
  expect(png.type).toBe('image/png')
  expect(button(ui, 'Copy Markup').disabled).toBe(false)
})

test('back-to-back copy deliveries start one write and keep history frozen until it settles', async () => {
  const decode = Promise.withResolvers<void>()
  const ui = mount({ decode: decode.promise })
  await addTextMarkup(ui)
  expect(button(ui, 'Undo').disabled).toBe(false)
  act(() => {
    dispatchDesignControl(ui.context, { action: 'markup-copy', pane: 'pane-1' })
    dispatchDesignControl(ui.context, { action: 'markup-copy', pane: 'pane-1' })
    dispatchDesignControl(ui.context, { action: 'markup-undo', pane: 'pane-1' })
    dispatchDesignControl(ui.context, { action: 'markup-clear', pane: 'pane-1' })
  })
  expect(ui.writes).toHaveLength(1)
  decode.resolve()
  await act(async () => { await settleUntil(() => ui.log.includes('onCopied')) })
  expect(ui.log.filter((entry) => entry === 'onCopied')).toHaveLength(1)
  expect(button(ui, 'Undo').disabled).toBe(false)
  expect(button(ui, 'Clear all').disabled).toBe(false)
})

test('Cancel before the PNG is ready rejects clipboard data without reporting an error', async () => {
  const decode = Promise.withResolvers<void>()
  const ui = mount({ decode: decode.promise })
  await clickButton(ui, 'Copy Markup')
  await settleUntil(() => ui.log.includes('decode'))

  await clickButton(ui, 'Cancel')
  decode.resolve()
  await act(async () => { await delay(20) })

  expect(recorded(ui)).toEqual([
    M({ action: 'markup-copy' }),
    M({ action: 'markup-close' })
  ])
  expect(ui.log).toEqual(['write', 'decode', 'onClose'])
})

test('unmount before the PNG is ready suppresses every completion callback', async () => {
  const decode = Promise.withResolvers<void>()
  const ui = mount({ decode: decode.promise })
  await clickButton(ui, 'Copy Markup')
  await settleUntil(() => ui.log.includes('decode'))

  await act(async () => { ui.unmount() })
  decode.resolve()
  await delay(20)

  expect(ui.log).toEqual(['write', 'decode'])
})

test('refuses close commands and Escape after clipboard commit begins', async () => {
  const done = Promise.withResolvers<void>()
  const ui = mount({ afterData: done.promise, logData: true })
  const copyButton = button(ui, 'Copy Markup')
  await clickButton(ui, 'Copy Markup')
  await settleUntil(() => copyButton.textContent?.trim() === 'Writing PNG…')
  expect(button(ui, 'Cancel').disabled).toBe(true)

  expect(dispatchDesignControl(ui.context, { action: 'markup-close', pane: 'pane-1' })).toEqual({
    pane: 'pane-1', action: 'markup-close', delivered: 1
  })
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  expect(ui.log).not.toContain('onClose')

  done.resolve()
  await act(async () => { await settleUntil(() => ui.log.includes('onCopied')) })

  expect(ui.log).toEqual(['write', 'decode', 'toBlob', 'data', 'write-settled', 'onCopied'])
  expect(copyButton.disabled).toBe(false)
})

test('addresses only the mounted pane and unregisters after unmount', async () => {
  const ui = mount()
  expect(dispatchDesignControl(ui.context, { action: 'markup-undo', pane: 'pane-2' })).toEqual({
    pane: 'pane-2', action: 'markup-undo', delivered: 0
  })
  await act(async () => { ui.unmount() })
  expect(dispatchDesignControl(ui.context, { action: 'markup-undo', pane: 'pane-1' })).toEqual({
    pane: 'pane-1', action: 'markup-undo', delivered: 0
  })
})

test('renders an invalid screenshot error as InlineError and reports it once', () => {
  const ui = mount({ screenshot: { mimeType: 'image/png', dataUrl: 'nope', width: 0, height: 0 } })

  expect(ui.dialog().querySelector('.ui-inline-error')?.textContent).toContain('The frozen screenshot cannot be displayed.')
  expect(ui.log).toEqual(['onError:The frozen browser screenshot is invalid or exceeds the supported pixel bounds.'])
})

test('reports a failed Undo command and leaves the history unchanged', async () => {
  const ui = mount()
  await addTextMarkup(ui)
  expect(button(ui, 'Undo').disabled).toBe(false)
  ui.calls.length = 0
  ui.failure(new Error('No command: command:quirky.browser/designControl'))

  await clickButton(ui, 'Undo')
  await settleUntil(() => ui.log.length > 0)

  expect(recorded(ui)).toEqual([M({ action: 'markup-undo' })])
  expect(ui.log).toEqual(['onError:No command: command:quirky.browser/designControl'])
  expect(button(ui, 'Undo').disabled).toBe(false)
})

test('keeps clicks, context menus and keys inside the overlay barrier', () => {
  const ui = mount()
  const seen: string[] = []
  const recordClick = () => { seen.push('click') }
  const recordContextMenu = () => { seen.push('contextmenu') }
  const recordKeyDown = () => { seen.push('keydown') }
  document.addEventListener('click', recordClick)
  document.addEventListener('contextmenu', recordContextMenu)
  window.addEventListener('keydown', recordKeyDown)

  try {
    ui.dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const contextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    ui.dialog().dispatchEvent(contextMenu)
    button(ui, 'Undo').dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))

    expect(seen).toEqual([])
    expect(contextMenu.defaultPrevented).toBe(true)
  } finally {
    document.removeEventListener('click', recordClick)
    document.removeEventListener('contextmenu', recordContextMenu)
    window.removeEventListener('keydown', recordKeyDown)
  }
})
