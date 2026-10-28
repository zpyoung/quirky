import { Buffer } from 'node:buffer'
import { PNG } from 'pngjs'
import type { DesignRect, DesignScreenshot } from '../design-contract'
import { MAX_SCREENSHOT_BYTES } from './payload'

const DATA_URL_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = 'iVBORw0KGgo'
const MAX_DECODE_PIXELS = 32_000_000
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64ByteLength(value: string): number | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z\d+/]*={0,2}$/.test(value)) return null
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length * 3 / 4 - padding
}

function base64ByteAt(value: string, byteIndex: number): number {
  const group = Math.floor(byteIndex / 3) * 4
  const position = byteIndex % 3
  const a = BASE64.indexOf(value[group] ?? '')
  const b = BASE64.indexOf(value[group + 1] ?? '')
  const c = BASE64.indexOf(value[group + 2] ?? '')
  const d = BASE64.indexOf(value[group + 3] ?? '')
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1
  if (position === 0) return (a << 2) | (b >> 4)
  if (position === 1) return ((b & 15) << 4) | (c >> 2)
  return ((c & 3) << 6) | d
}

function pngDimensions(base64: string): { width: number; height: number; byteLength: number } | null {
  const byteLength = base64ByteLength(base64)
  if (byteLength === null || byteLength < 33 || !base64.startsWith(PNG_SIGNATURE)) return null

  const ihdr = [0, 0, 0, 13, 73, 72, 68, 82]
  for (let index = 0; index < ihdr.length; index++) {
    if (base64ByteAt(base64, 8 + index) !== ihdr[index]) return null
  }

  let width = 0
  let height = 0
  for (let index = 0; index < 4; index++) {
    const widthByte = base64ByteAt(base64, 16 + index)
    const heightByte = base64ByteAt(base64, 20 + index)
    if (widthByte < 0 || heightByte < 0) return null
    width = width * 256 + widthByte
    height = height * 256 + heightByte
  }
  return width > 0 && height > 0 ? { width, height, byteLength } : null
}

export function screenshotFromPngBase64(base64: string): DesignScreenshot | null {
  const dimensions = pngDimensions(base64)
  if (!dimensions) return null
  return {
    mimeType: 'image/png',
    dataUrl: DATA_URL_PREFIX + base64,
    width: dimensions.width,
    height: dimensions.height
  }
}

export function cropViewportPng(
  screenshot: DesignScreenshot,
  viewportWidth: number,
  rect: DesignRect
): DesignScreenshot | null {
  if (screenshot.mimeType !== 'image/png' || !screenshot.dataUrl.startsWith(DATA_URL_PREFIX) ||
      !Number.isFinite(viewportWidth) || viewportWidth <= 0 ||
      !Number.isFinite(rect.x) || !Number.isFinite(rect.y) ||
      !Number.isFinite(rect.width) || !Number.isFinite(rect.height) ||
      rect.width <= 0 || rect.height <= 0) return null

  const base64 = screenshot.dataUrl.slice(DATA_URL_PREFIX.length)
  const dimensions = pngDimensions(base64)
  if (!dimensions || dimensions.width !== screenshot.width || dimensions.height !== screenshot.height ||
      dimensions.height > Math.floor(MAX_DECODE_PIXELS / dimensions.width)) return null

  const scale = dimensions.width / viewportWidth
  if (!Number.isFinite(scale) || scale <= 0) return null
  const cssRight = rect.x + rect.width
  const cssBottom = rect.y + rect.height
  if (!Number.isFinite(cssRight) || !Number.isFinite(cssBottom)) return null

  const sourceLeft = Math.floor(rect.x * scale)
  const sourceTop = Math.floor(rect.y * scale)
  const sourceRight = Math.ceil(cssRight * scale)
  const sourceBottom = Math.ceil(cssBottom * scale)
  if (![sourceLeft, sourceTop, sourceRight, sourceBottom].every(Number.isFinite)) return null

  const left = Math.max(0, Math.min(dimensions.width, sourceLeft))
  const top = Math.max(0, Math.min(dimensions.height, sourceTop))
  const right = Math.max(0, Math.min(dimensions.width, sourceRight))
  const bottom = Math.max(0, Math.min(dimensions.height, sourceBottom))
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return null

  if (left === 0 && top === 0 && right === dimensions.width && bottom === dimensions.height &&
      dimensions.byteLength > MAX_SCREENSHOT_BYTES) return null

  try {
    const decoded = PNG.sync.read(Buffer.from(base64, 'base64'))
    if (decoded.width !== dimensions.width || decoded.height !== dimensions.height ||
        decoded.data.length !== dimensions.width * dimensions.height * 4) return null

    if (left === 0 && top === 0 && right === dimensions.width && bottom === dimensions.height) return screenshot

    const cropped = new PNG()
    cropped.width = width
    cropped.height = height
    cropped.data = Buffer.allocUnsafe(width * height * 4)
    const pixels = cropped.data
    const rowBytes = width * 4
    for (let row = 0; row < height; row++) {
      const sourceOffset = ((top + row) * dimensions.width + left) * 4
      decoded.data.copy(pixels, row * rowBytes, sourceOffset, sourceOffset + rowBytes)
    }
    const encoded = PNG.sync.write(cropped)
    if (encoded.length > MAX_SCREENSHOT_BYTES) return null

    return {
      mimeType: 'image/png',
      dataUrl: DATA_URL_PREFIX + encoded.toString('base64'),
      width,
      height
    }
  } catch {
    return null
  }
}
