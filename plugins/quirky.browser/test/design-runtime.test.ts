import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { startBrowserHarness, type BrowserTestHarness } from './harness'

const call = (h: BrowserTestHarness, name: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(`quirky.browser/${name}`, params)

type Fixture = { url: string; stop(): void }
function startDesignFixture(): Fixture {
  const html = `<!doctype html><title>Design fixture</title><style>body{margin:0}#paragraph{position:absolute;left:40px;top:40px;width:200px;height:80px}#button{position:absolute;left:300px;top:40px;width:160px;height:60px}</style><p id="paragraph">Coordinate-only paragraph</p><button id="button">Second element</button><script>window.__designClicks=0;window.__designContexts=0;document.addEventListener('click',()=>window.__designClicks++);document.addEventListener('contextmenu',()=>window.__designContexts++)</script>`
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
  })
  return { url: server.url.href, stop: () => server.stop(true) }
}

function startCaptureFixture(): Fixture {
  const html = '<!doctype html><title>Capture fixture</title><style>html,body{margin:0;background:rgb(0,20,220);height:1800px}#target{position:absolute;left:80px;top:900px;width:120px;height:80px;background:rgb(240,10,20)}</style><div id=\"target\"></div>'
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch() {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
  })
  return { url: server.url.href, stop: () => server.stop(true) }
}

function pngPixel(image: { dataUrl: string; width: number; height: number }, x: number, y: number): [number, number, number] {
  const data = Buffer.from(image.dataUrl.slice('data:image/png;base64,'.length), 'base64')
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  for (let offset = 8; offset + 12 <= data.length;) {
    const size = data.readUInt32BE(offset)
    const type = data.toString('ascii', offset + 4, offset + 8)
    const chunk = data.subarray(offset + 8, offset + 8 + size)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]!
      colorType = chunk[9]!
    } else if (type === 'IDAT') idat.push(chunk)
    offset += size + 12
    if (type === 'IEND') break
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0
  if (width !== image.width || height !== image.height || bitDepth !== 8 || channels === 0 || x < 0 || x >= width || y < 0 || y >= height) {
    throw new Error('capture fixture returned an unsupported PNG')
  }
  const stride = width * channels
  const pixels = inflateSync(Buffer.concat(idat))
  let previous = Buffer.alloc(stride)
  let row = Buffer.alloc(stride)
  for (let rowIndex = 0; rowIndex <= y; rowIndex++) {
    const inputOffset = rowIndex * (stride + 1)
    const filter = pixels[inputOffset]!
    for (let index = 0; index < stride; index++) {
      const raw = pixels[inputOffset + index + 1]!
      const left = index >= channels ? row[index - channels]! : 0
      const up = rowIndex > 0 ? previous[index]! : 0
      const upperLeft = rowIndex > 0 && index >= channels ? previous[index - channels]! : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const base = left + up - upperLeft
        const leftDistance = Math.abs(base - left)
        const upDistance = Math.abs(base - up)
        const diagonalDistance = Math.abs(base - upperLeft)
        predictor = leftDistance <= upDistance && leftDistance <= diagonalDistance ? left : upDistance <= diagonalDistance ? up : upperLeft
      } else if (filter !== 0) throw new Error(`unsupported PNG filter: ${filter}`)
      row[index] = (raw + predictor) & 0xff
    }
    if (rowIndex === y) {
      const offset = x * channels
      const red = row[offset]!
      const green = channels === 1 || channels === 2 ? red : row[offset + 1]!
      const blue = channels === 1 || channels === 2 ? red : row[offset + 2]!
      return [red, green, blue]
    }
    const swap = previous
    previous = row
    row = swap
  }
  throw new Error('capture pixel was not found')
}

async function clickAt(h: BrowserTestHarness, pane: string, x: number, y: number): Promise<void> {
  await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mousePressed', x, y, button: 'left' })
  await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mouseReleased', x, y, button: 'left' })
}

async function rightClickAt(h: BrowserTestHarness, pane: string, x: number, y: number): Promise<void> {
  await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mousePressed', x, y, button: 'right' })
  await call(h, 'paneInput', { pane, kind: 'mouse', type: 'mouseReleased', x, y, button: 'right' })
}

async function pressKey(h: BrowserTestHarness, pane: string, key: string): Promise<void> {
  const code = `Key${key.toUpperCase()}`
  await call(h, 'paneInput', { pane, kind: 'key', type: 'keyDown', key, code })
  await call(h, 'paneInput', { pane, kind: 'key', type: 'keyUp', key, code })
}

async function watchPage(h: BrowserTestHarness, worktree: string, url: string) {
  await h.client.call('events.subscribe', {})
  const firstFrame = Promise.withResolvers<void>()
  const unsubscribe = h.client.onEvent((event) => {
    if (event.type === 'event:quirky.browser/paneFrame') firstFrame.resolve()
  })
  try {
    const page = await call(h, 'tabCreate', { worktree: `id:${worktree}`, url }) as { browserPageId: string }
    const pane = await call(h, 'paneOpen', { worktree: `id:${worktree}`, mode: 'watch', page: page.browserPageId }) as { id: string; page: string }
    const watch = await call(h, 'paneWatch', { pane: pane.id }) as { watchId: string }
    await firstFrame.promise
    return { page: page.browserPageId, pane: pane.id, watchId: watch.watchId }
  } finally {
    unsubscribe()
  }
}


test('Watch picker selects click coordinates without a prior hover, blocks page clicks, and rearms for a second element', async () => {
  const h = await startBrowserHarness()
  const fixture = startDesignFixture()
  try {
    const worktree = await h.addFolderWorktree('design-picker')
    const page = await watchPage(h, worktree, fixture.url)

    const first = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    expect(await call(h, 'designHover', { pane: page.pane, opId: first.opId })).toEqual({ payload: null })
    await clickAt(h, page.pane, 60, 60)
    const firstRead = await call(h, 'designRead', { pane: page.pane, opId: first.opId }) as { status: string; selection?: { kind: string; payload: { target: { textSnippet: string; attributes: Record<string, string>; computedStyles: Record<string, string> } } } }
    expect(firstRead.selection).toMatchObject({ kind: 'selected', payload: { target: { textSnippet: 'Coordinate-only paragraph', attributes: { id: 'paragraph' } } } })
    expect(Object.keys(firstRead.selection!.payload.target.computedStyles)).toHaveLength(16)

    const second = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    expect(second.opId).not.toBe(first.opId)
    await clickAt(h, page.pane, 320, 55)
    const secondRead = await call(h, 'designRead', { pane: page.pane, opId: second.opId }) as { selection?: { payload: { target: { selector: string; textSnippet: string } } } }
    expect(secondRead.selection?.payload.target).toMatchObject({ textSnippet: 'Second element' })
    expect(secondRead.selection?.payload.target.selector).toContain('#button')

    expect(await call(h, 'eval', { page: page.page, expression: 'window.__designClicks' })).toEqual({ value: 0 })
  } finally {
    fixture.stop()
    await h.cleanup()
  }
}, 90_000)

test('Watch picker cancels the old operation after navigation or pane close and rejects Native execution', async () => {
  const h = await startBrowserHarness()
  const fixture = startDesignFixture()
  try {
    const worktree = await h.addFolderWorktree('design-lifetime')
    const page = await watchPage(h, worktree, fixture.url)
    const armed = await call(h, 'designArm', { pane: page.pane, mode: 'annotate' }) as { opId: string }
    await call(h, 'paneNavigate', { pane: page.pane, input: `${fixture.url}next` })
    const afterNavigation = await call(h, 'designRead', { pane: page.pane, opId: armed.opId }) as { status: string; selection?: unknown }
    expect(afterNavigation).toMatchObject({ opId: armed.opId, status: 'cancelled' })
    expect(afterNavigation.selection).toBeUndefined()

    const second = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    await call(h, 'paneClose', { pane: page.pane })
    const afterClose = await call(h, 'designRead', { pane: page.pane, opId: second.opId }) as { status: string }
    expect(afterClose.status).toBe('cancelled')

    const native = await call(h, 'paneOpen', { worktree: `id:${worktree}`, url: fixture.url }) as { id: string }
    await expect(call(h, 'designArm', { pane: native.id, mode: 'grab' })).rejects.toBeInstanceOf(Error)
  } finally {
    fixture.stop()
    await h.cleanup()
  }
}, 90_000)

test('Watch picker highlights, handles C/S and context selection, and restores overlays after real PNG capture', async () => {
  const h = await startBrowserHarness()
  const fixture = startDesignFixture()
  try {
    const worktree = await h.addFolderWorktree('design-actions')
    const page = await watchPage(h, worktree, fixture.url)
    await call(h, 'eval', {
      page: page.page,
      expression: `window.__designTouches=0;Object.defineProperty(window,'__quirkyBrowserDesignPicker',{configurable:true,get(){window.__designTouches++;return {destroy(){window.__designTouches++}}}});true`
    })
    const armed = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    expect(await call(h, 'eval', {
      page: page.page,
      expression: `document.querySelector('[data-quirky-browser-design-owner="design-picker-v1"]').shadowRoot`
    })).toEqual({ value: null })
    expect(await call(h, 'designHover', { pane: page.pane, opId: armed.opId })).toEqual({ payload: null })
    await pressKey(h, page.pane, 'c')
    const noHover = await call(h, 'designRead', { pane: page.pane, opId: armed.opId }) as { selection?: unknown }
    expect(noHover.selection).toBeUndefined()

    await call(h, 'paneInput', { pane: page.pane, kind: 'mouse', type: 'mouseMoved', x: 60, y: 60 })
    const hover = await call(h, 'designHover', { pane: page.pane, opId: armed.opId }) as { payload: { target: { textSnippet: string } } | null }
    expect(hover.payload?.target.textSnippet).toBe('Coordinate-only paragraph')
    await pressKey(h, page.pane, 'c')
    const copied = await call(h, 'designRead', { pane: page.pane, opId: armed.opId }) as { selection?: { kind: string } }
    expect(copied.selection?.kind).toBe('copy')

    const screenshotOp = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    await call(h, 'paneInput', { pane: page.pane, kind: 'mouse', type: 'mouseMoved', x: 60, y: 60 })
    await call(h, 'designHover', { pane: page.pane, opId: screenshotOp.opId })
    await pressKey(h, page.pane, 's')
    const screenshotSelection = await call(h, 'designRead', { pane: page.pane, opId: screenshotOp.opId }) as { selection?: { kind: string } }
    expect(screenshotSelection.selection?.kind).toBe('screenshot')
    const capture = await call(h, 'designCapture', { pane: page.pane, opId: screenshotOp.opId }) as { screenshot: { mimeType: string; dataUrl: string; width: number; height: number } | null }
    expect(capture.screenshot?.mimeType).toBe('image/png')
    expect(capture.screenshot?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(capture.screenshot?.width).toBeGreaterThan(0)
    await call(h, 'paneInput', { pane: page.pane, kind: 'mouse', type: 'mouseMoved', x: 61, y: 61 })
    expect((await call(h, 'designHover', { pane: page.pane, opId: screenshotOp.opId }) as { payload: unknown }).payload).toBeTruthy()

    const contextOp = await call(h, 'designArm', { pane: page.pane, mode: 'grab' }) as { opId: string }
    await rightClickAt(h, page.pane, 60, 60)
    const context = await call(h, 'designRead', { pane: page.pane, opId: contextOp.opId }) as { selection?: { kind: string } }
    expect(context.selection?.kind).toBe('context-selected')
    await call(h, 'designCancel', { pane: page.pane, opId: contextOp.opId })
    expect(await call(h, 'eval', { page: page.page, expression: 'window.__designTouches' })).toEqual({ value: 0 })
    expect(await call(h, 'eval', { page: page.page, expression: '({ clicks: window.__designClicks, contexts: window.__designContexts })' })).toEqual({ value: { clicks: 0, contexts: 0 } })
  } finally {
    fixture.stop()
    await h.cleanup()
  }
}, 90_000)

test('Watch crop uses page-offset clips and the actual screenshot scale on a scrolled DPR-2 viewport', async () => {
  const h = await startBrowserHarness()
  const fixture = startCaptureFixture()
  try {
    const worktree = await h.addFolderWorktree('design-capture-scale')
    const page = await watchPage(h, worktree, fixture.url)
    await call(h, 'paneControl', { pane: page.pane, action: 'viewport', preset: 'mobile-m' })
    const measured = await call(h, 'eval', {
      page: page.page,
      expression: `(() => {
        window.scrollTo(0, 850)
        const rect = document.querySelector('#target').getBoundingClientRect()
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY }
      })()`
    }) as { value: { rect: { x: number; y: number; width: number; height: number }; width: number; height: number; scrollY: number } }
    expect(measured.value.scrollY).toBe(850)
    expect(measured.value.rect).toEqual({ x: 80, y: 50, width: 120, height: 80 })

    const full = await call(h, 'designCapture', { pane: page.pane }) as { screenshot: { dataUrl: string; width: number; height: number } | null }
    expect(full.screenshot).not.toBeNull()
    const ratio = full.screenshot!.width / measured.value.width
    expect(ratio).toBe(2)

    const crop = await call(h, 'designCapture', { pane: page.pane, rect: measured.value.rect }) as { screenshot: { dataUrl: string; width: number; height: number } | null }
    expect(crop.screenshot).not.toBeNull()
    expect(crop.screenshot!.width).toBe(Math.round(measured.value.rect.width * ratio))
    expect(crop.screenshot!.height).toBe(Math.round(measured.value.rect.height * ratio))
    const [red, green, blue] = pngPixel(crop.screenshot!, Math.floor(crop.screenshot!.width / 2), Math.floor(crop.screenshot!.height / 2))
    expect(red).toBeGreaterThan(200)
    expect(green).toBeLessThan(60)
    expect(blue).toBeLessThan(60)
  } finally {
    fixture.stop()
    await h.cleanup()
  }
}, 90_000)
