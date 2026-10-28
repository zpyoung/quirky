import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { KittyGraphicsDecoder } from './kittyGraphicsDecoder'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_PIXELS = 1024 * 1024
const CACHE_BYTES = 8 * 1024 * 1024
const KEYS = new Set('a f t i p s v c r m q C x y w h X Y o S z d'.split(' '))
type Command = Record<string, string>
type Image = { bitmap: ImageBitmap; bytes: number }
type Placement = { image: number; placement: number; pixels: number; rows: number; decoration: IDecoration; marker: IMarker }
type Upload = { command: Command; parts: string[]; size: number; replay: boolean }

function commandOf(frame: string): { command: Command; payload: string } {
  const separator = frame.indexOf(';')
  const header = separator < 0 ? frame : frame.slice(0, separator)
  if (header.length > 1024) throw new Error('EINVAL: control data is too large')
  const command: Command = Object.create(null)
  for (const field of header.split(',')) {
    if (!field) continue
    const match = /^([a-zA-Z])=([a-zA-Z]|-?\d{1,10})$/.exec(field)
    if (!match || !KEYS.has(match[1]!) || Object.hasOwn(command, match[1]!)) throw new Error('ENOTSUP: unsupported graphics control')
    command[match[1]!] = match[2]!
  }
  return { command, payload: separator < 0 ? '' : frame.slice(separator + 1) }
}

function numberOf(command: Command, key: string, fallback = 0): number {
  if (command[key] === undefined) return fallback
  const number = Number(command[key])
  if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) throw new Error(`EINVAL: invalid ${key}`)
  return number
}

async function inflate(bytes: Uint8Array, signal: AbortSignal): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  const reader = stream.getReader()
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('E2BIG: decompressed graphics data is too large')
      chunks.push(value)
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

async function decode(command: Command, payload: string, signal: AbortSignal): Promise<Image> {
  if ((command.t ?? 'd') !== 'd') throw new Error('ENOTSUP: only direct graphics transmission is authorized')
  if (payload.length > MAX_BYTES || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) throw new Error('EINVAL: invalid or oversized base64 graphics')
  const raw = atob(payload)
  let bytes: Uint8Array = Uint8Array.from(raw, (char) => char.charCodeAt(0))
  if (command.o !== undefined) {
    if (command.o !== 'z') throw new Error('ENOTSUP: unsupported graphics compression')
    bytes = await inflate(bytes, signal)
  }
  const format = numberOf(command, 'f', 32)
  let width = numberOf(command, 's'), height = numberOf(command, 'v')
  let source: Blob | ImageData
  if (format === 100) {
    if (command.o === 'z' && command.S === undefined) throw new Error('EINVAL: compressed PNG requires S')
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ||
        String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') throw new Error('EINVAL: invalid PNG graphics')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    width = view.getUint32(16); height = view.getUint32(20)
    source = new Blob([bytes as BlobPart], { type: 'image/png' })
  } else if (format === 24 || format === 32) {
    if (!width || !height || width * height > MAX_PIXELS || bytes.length !== width * height * (format / 8)) throw new Error('EINVAL: invalid raw graphics dimensions')
    const rgba = new Uint8ClampedArray(width * height * 4)
    if (format === 32) rgba.set(bytes)
    else for (let pixel = 0, input = 0; pixel < rgba.length; pixel += 4, input += 3) {
      rgba[pixel] = bytes[input]!; rgba[pixel + 1] = bytes[input + 1]!; rgba[pixel + 2] = bytes[input + 2]!; rgba[pixel + 3] = 255
    }
    source = new ImageData(rgba, width, height)
  } else throw new Error('ENOTSUP: unsupported graphics pixel format')
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('E2BIG: graphics exceeds one million pixels')
  signal.throwIfAborted()
  const { promise, resolve, reject } = Promise.withResolvers<ImageBitmap>()
  let expired = false
  const timer = setTimeout(() => { expired = true; reject(new Error('ETIMEDOUT: graphics decode timed out')) }, 5000)
  const abort = () => { expired = true; reject(new Error('ECANCELED: graphics renderer was retired')) }
  signal.addEventListener('abort', abort, { once: true })
  void createImageBitmap(source).then((bitmap) => {
    if (expired) bitmap.close()
    else resolve(bitmap)
  }, reject)
  const bitmap = await promise.finally(() => { clearTimeout(timer); signal.removeEventListener('abort', abort) })
  if (bitmap.width !== width || bitmap.height !== height) { bitmap.close(); throw new Error('EINVAL: decoded graphics dimensions differ') }
  return { bitmap, bytes: width * height * 4 }
}

/** Visible-pane-owned direct Kitty raster protocol; never reads files, shared memory or a second history. */
export function createKittyGraphics(terminal: Terminal, reply: (data: string) => void, initiallyEnabled: boolean) {
  const images = new Map<number, Image>()
  const placements = new Set<Placement>()
  const uploads = new Map<number, Upload>()
  let lastUpload = 0, nextId = 1, cachedBytes = 0, queuedBytes = 0
  let placementPixels = 0
  let disposed = false, enabled = initiallyEnabled, replay = false, frameReplay = false
  let generation = 0
  let tail = Promise.resolve()
  let decoding = new AbortController()

  const removePlacements = (image?: number, placement?: number) => {
    for (const entry of [...placements]) {
      if (image !== undefined && entry.image !== image || placement !== undefined && entry.placement !== placement) continue
      if (placements.delete(entry)) placementPixels -= entry.pixels
      entry.decoration.dispose(); entry.marker.dispose()
    }
  }
  const removeImage = (id: number) => {
    removePlacements(id)
    const image = images.get(id)
    if (image) { cachedBytes -= image.bytes; image.bitmap.close(); images.delete(id) }
    uploads.delete(id)
  }
  const clear = () => {
    removePlacements()
    for (const id of [...images.keys()]) removeImage(id)
    uploads.clear(); cachedBytes = 0
  }
  const erase = terminal.parser.registerCsiHandler({ final: 'J' }, (params) => {
    if (params[0] === 2 || params[0] === 3) clear()
    return false
  })
  const reset = terminal.parser.registerEscHandler({ final: 'c' }, () => { clear(); return false })
  const bufferChange = terminal.buffer.onBufferChange(() => removePlacements())
  const respond = (command: Command, message: string, muted: boolean) => {
    const quiet = command.q ?? '0'
    if (muted || disposed || !enabled || quiet === '2' || quiet === '1' && message === 'OK' || command.i === undefined) return
    reply(`\x1b_Gi=${command.i}${command.p === undefined ? '' : `,p=${command.p}`};${message}\x1b\\`)
  }
  const display = async (id: number, command: Command) => {
    const image = images.get(id)
    if (!image) throw new Error('ENOENT: image is not stored')
    const element = terminal.element
    if (!element) throw new Error('EINVAL: terminal surface is absent')
    const screen = element.querySelector('.xterm-screen') as HTMLElement | null
    const cellWidth = (screen?.clientWidth || element.clientWidth) / terminal.cols
    const cellHeight = (screen?.clientHeight || element.clientHeight) / terminal.rows
    if (!(cellWidth > 0 && cellHeight > 0)) throw new Error('EINVAL: terminal has no visible cell dimensions')
    const x = numberOf(command, 'x'), y = numberOf(command, 'y')
    const width = numberOf(command, 'w', image.bitmap.width - x) || image.bitmap.width - x
    const height = numberOf(command, 'h', image.bitmap.height - y) || image.bitmap.height - y
    if (x + width > image.bitmap.width || y + height > image.bitmap.height || width < 1 || height < 1) throw new Error('EINVAL: graphics crop is outside image')
    let columns = numberOf(command, 'c'), rows = numberOf(command, 'r')
    if (!columns && !rows) { columns = Math.ceil(width / cellWidth); rows = Math.ceil(height / cellHeight) }
    else if (!columns) columns = Math.ceil(rows * cellHeight * width / height / cellWidth)
    else if (!rows) rows = Math.ceil(columns * cellWidth * height / width / cellHeight)
    if (columns < 1 || rows < 1 || columns > 512 || rows > 512 || columns * cellWidth * rows * cellHeight > MAX_PIXELS) throw new Error('E2BIG: graphics placement exceeds visible renderer bounds')
    const offsetX = numberOf(command, 'X'), offsetY = numberOf(command, 'Y')
    if (offsetX >= cellWidth || offsetY >= cellHeight || !['0', '1'].includes(command.C ?? '0')) throw new Error('EINVAL: invalid graphics cell offset or cursor mode')
    const z = command.z === undefined ? 0 : Number(command.z)
    if (!Number.isSafeInteger(z) || z < -2147483648 || z > 2147483647) throw new Error('EINVAL: invalid graphics layer')
    const placementId = numberOf(command, 'p')
    if (placementId) removePlacements(id, placementId)
    if (placements.size >= 64) throw new Error('E2BIG: too many graphics placements')
    const pixels = Math.ceil(columns * cellWidth) * Math.ceil(rows * cellHeight)
    if (placementPixels + pixels > CACHE_BYTES / 4) throw new Error('E2BIG: graphics placement canvas budget is full')
    const marker = terminal.registerMarker(0)
    if (!marker) throw new Error('EINVAL: terminal cannot retain graphics anchor')
    const decoration = terminal.registerDecoration({ marker, x: terminal.buffer.active.cursorX, width: columns, height: rows, layer: z < 0 ? 'bottom' : 'top' })
    if (!decoration) { marker.dispose(); throw new Error('EINVAL: terminal cannot place graphics') }
    const placement = { image: id, placement: placementId, pixels, rows, decoration, marker }
    placements.add(placement); placementPixels += pixels
    marker.onDispose(() => {
      if (placements.delete(placement)) placementPixels -= pixels
      decoration.dispose()
    })
    decoration.onRender((container) => {
      if (disposed || !enabled || !images.has(id)) return
      let canvas = container.querySelector('canvas')
      if (!canvas) { canvas = container.ownerDocument.createElement('canvas'); container.appendChild(canvas) }
      canvas.width = Math.max(1, Math.ceil(columns * cellWidth)); canvas.height = Math.max(1, Math.ceil(rows * cellHeight))
      canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.pointerEvents = 'none'
      container.style.pointerEvents = 'none'
      container.dataset.kittyImage = String(id)
      const context = canvas.getContext('2d')
      context?.drawImage(image.bitmap, x, y, width, height, offsetX, offsetY, canvas.width - offsetX, canvas.height - offsetY)
    })
    if (command.C !== '1') {
      const { promise, resolve } = Promise.withResolvers<void>()
      terminal.write(`${'\n'.repeat(rows - 1)}\x1b[${Math.min(terminal.cols, terminal.buffer.active.cursorX + columns + 1)}G`, resolve)
      await promise
    }
  }

  const handle = async (frame: string, muted: boolean, epoch: number) => {
    let command: Command = {}
    try {
      let payload: string
      ;({ command, payload } = commandOf(frame))
      if (!enabled || disposed || epoch !== generation) return
      const action = command.a ?? 't'
      if (action === 'd') {
        const selector = command.d ?? 'a'
        if (!['a', 'A', 'i', 'I'].includes(selector)) throw new Error('ENOTSUP: unsupported graphics delete selector')
        const id = selector.toLowerCase() === 'i' ? numberOf(command, 'i') : undefined
        if (id === 0) throw new Error('EINVAL: image deletion requires an ID')
        const placement = command.p === undefined ? undefined : numberOf(command, 'p')
        const affected = new Set<number>()
        if (id === undefined) {
          uploads.clear()
          for (const entry of [...placements]) {
            const line = entry.marker.line - terminal.buffer.active.viewportY
            if (line + entry.rows <= 0 || line >= terminal.rows) continue
            affected.add(entry.image)
            if (placements.delete(entry)) placementPixels -= entry.pixels
            entry.decoration.dispose(); entry.marker.dispose()
          }
        } else {
          uploads.delete(id); affected.add(id); removePlacements(id, placement)
        }
        if (selector === selector.toUpperCase()) {
          for (const image of affected) if (![...placements].some((entry) => entry.image === image)) removeImage(image)
        }
        respond(command, 'OK', muted); return
      }
      if (action === 'p') { await display(numberOf(command, 'i'), command); respond(command, 'OK', muted); return }
      if (!['t', 'T', 'q'].includes(action)) throw new Error('ENOTSUP: graphics animation and virtual placements are unsupported')
      if (command.m !== undefined && command.m !== '0' && command.m !== '1') throw new Error('EINVAL: invalid graphics chunk mode')
      if (payload.length + [...uploads.values()].reduce((total, upload) => total + upload.size, 0) > MAX_BYTES) {
        uploads.clear()
        throw new Error('E2BIG: total graphics uploads exceed four MiB')
      }
      const key = command.i === undefined && uploads.has(lastUpload) ? lastUpload : numberOf(command, 'i')
      const pending = uploads.get(key)
      if (pending) {
        if (Object.keys(command).some((field) => !['m', 'q', 'i'].includes(field))) { uploads.delete(key); throw new Error('EINVAL: continuation changed graphics metadata') }
        pending.size += payload.length
        if (pending.size > MAX_BYTES) { uploads.delete(key); throw new Error('E2BIG: graphics upload exceeds four MiB') }
        pending.parts.push(payload); pending.replay ||= muted
        if (command.m === '1') return
        uploads.delete(key); payload = pending.parts.join(''); muted ||= pending.replay
        command = { ...pending.command, ...(command.q === undefined ? {} : { q: command.q }) }
      } else if (command.m === '1') {
        if (uploads.size >= 16) throw new Error('E2BIG: too many graphics uploads')
        uploads.set(key, { command, parts: [payload], size: payload.length, replay: muted }); lastUpload = key; return
      }
      const image = await decode(command, payload, decoding.signal)
      if (disposed || !enabled || epoch !== generation) { image.bitmap.close(); return }
      if ((command.a ?? 't') === 'q') { image.bitmap.close(); respond(command, 'OK', muted); return }
      while (images.has(nextId)) nextId++
      const id = numberOf(command, 'i') || nextId++
      removeImage(id)
      while (cachedBytes + image.bytes > CACHE_BYTES || images.size >= 16) removeImage(images.keys().next().value!)
      images.set(id, image); cachedBytes += image.bytes
      if ((command.a ?? 't') === 'T') await display(id, command)
      respond(command, 'OK', muted)
    } catch (error) { respond(command, error instanceof Error ? error.message : 'EINVAL: invalid graphics', muted) }
  }

  let pendingOperations = 0
  const parseBarrier = () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    terminal.write('', resolve)
    return promise
  }
  const enqueue = (operation: () => Promise<void>) => {
    pendingOperations++
    tail = tail.then(async () => {
      try { if (!disposed) await operation() } finally { pendingOperations-- }
    }).catch(() => {})
  }
  const decoder = new KittyGraphicsDecoder(
    (bytes) => {
      // Ordinary terminal output keeps xterm's existing fast path; only image operations queue.
      if (pendingOperations === 0) { terminal.write(bytes); return }
      enqueue(() => {
        const { promise, resolve } = Promise.withResolvers<void>()
        terminal.write(bytes, resolve)
        return promise
      })
    },
    (frame) => {
      if (!enabled || disposed) return
      const muted = replay || frameReplay, epoch = generation
      if (queuedBytes + frame.length > CACHE_BYTES) return
      queuedBytes += frame.length
      const flush = pendingOperations === 0
      enqueue(async () => {
        try { if (flush) await parseBarrier(); await handle(frame, muted, epoch) }
        finally { queuedBytes -= frame.length }
      })
    }
  )
  return {
    write(bytes: Uint8Array, isReplay = false, done?: () => void) {
      if (disposed) return
      replay = isReplay; frameReplay ||= isReplay
      decoder.push(bytes)
      if (!decoder.pending) frameReplay = false
      if (done) enqueue(async () => { await parseBarrier(); done() })
    },
    sync(value: boolean) {
      if (enabled !== value) { generation++; decoding.abort(); decoding = new AbortController() }
      enabled = value
      if (!value) clear()
    },
    dispose() {
      disposed = true; generation++; decoding.abort(); decoder.dispose()
      erase.dispose(); reset.dispose(); bufferChange.dispose(); clear()
    }
  }
}
