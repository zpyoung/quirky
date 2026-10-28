import { Buffer } from 'node:buffer'
import { expect, test } from 'bun:test'
import { PNG } from 'pngjs'
import type { DesignScreenshot } from '../src/design-contract'
import { cropViewportPng } from '../src/design/png'

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

function screenshot(width: number, height: number, pixels: Buffer): DesignScreenshot {
  const image = new PNG()
  image.width = width
  image.height = height
  image.data = pixels
  // Keep noisy fixture encoding cheap; the production crop still uses its normal encoder.
  const png = PNG.sync.write(image, { filterType: 0, deflateLevel: 0 })
  return {
    mimeType: 'image/png',
    dataUrl: PNG_DATA_URL_PREFIX + png.toString('base64'),
    width,
    height
  }
}

function patternedScreenshot(width: number, height: number): DesignScreenshot {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      pixels[offset] = x * 23
      pixels[offset + 1] = y * 31
      pixels[offset + 2] = (x * 19 + y * 7) % 256
      pixels[offset + 3] = 255
    }
  }
  return screenshot(width, height, pixels)
}

function pixel(image: DesignScreenshot, x: number, y: number): number[] {
  const decoded = PNG.sync.read(Buffer.from(image.dataUrl.slice(PNG_DATA_URL_PREFIX.length), 'base64'))
  const offset = (y * decoded.width + x) * 4
  return [...decoded.data.subarray(offset, offset + 4)]
}

test('crops viewport CSS coordinates at bitmap scale with floor and ceil pixel boundaries', () => {
  const image = patternedScreenshot(8, 6)
  const crop = cropViewportPng(image, 4, { x: 0.25, y: 0.25, width: 1.25, height: 1.25 })

  expect(crop).not.toBeNull()
  expect(crop).toMatchObject({ width: 3, height: 3 })
  expect(pixel(crop!, 0, 0)).toEqual(pixel(image, 0, 0))
  expect(pixel(crop!, 2, 2)).toEqual(pixel(image, 2, 2))
})

test('clips partially offscreen rectangles and rejects empty or fully offscreen crops', () => {
  const image = patternedScreenshot(8, 6)
  const crop = cropViewportPng(image, 4, { x: -0.25, y: 2.25, width: 1.25, height: 1 })

  expect(crop).not.toBeNull()
  expect(crop).toMatchObject({ width: 2, height: 2 })
  expect(pixel(crop!, 0, 0)).toEqual(pixel(image, 0, 4))
  expect(pixel(crop!, 1, 1)).toEqual(pixel(image, 1, 5))
  expect(cropViewportPng(image, 4, { x: 4, y: 1, width: 1, height: 1 })).toBeNull()
  expect(cropViewportPng(image, 4, { x: 1, y: 1, width: 0, height: 1 })).toBeNull()
})

test('returns null for malformed PNG data and images above the decode pixel limit', () => {
  const image = patternedScreenshot(8, 6)
  expect(cropViewportPng({ ...image, dataUrl: `${PNG_DATA_URL_PREFIX}AAAA` }, 4, { x: 0, y: 0, width: 1, height: 1 })).toBeNull()

  const oversizedHeader = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedHeader, 0)
  oversizedHeader.writeUInt32BE(13, 8)
  oversizedHeader.write('IHDR', 12, 'ascii')
  oversizedHeader.writeUInt32BE(6_000, 16)
  oversizedHeader.writeUInt32BE(6_000, 20)
  const oversized: DesignScreenshot = {
    mimeType: 'image/png',
    dataUrl: PNG_DATA_URL_PREFIX + oversizedHeader.toString('base64'),
    width: 6_000,
    height: 6_000
  }
  expect(cropViewportPng(oversized, 6_000, { x: 0, y: 0, width: 10, height: 10 })).toBeNull()
})

test('rejects an encoded crop above 2 MiB rather than downscaling it', () => {
  const width = 900
  const height = 800
  const pixels = Buffer.allocUnsafe(width * height * 4)
  let state = 0x12345678
  for (let offset = 0; offset < pixels.length; offset += 4) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    pixels[offset] = state & 0xff
    pixels[offset + 1] = (state >>> 8) & 0xff
    pixels[offset + 2] = (state >>> 16) & 0xff
    pixels[offset + 3] = 255
  }
  const image = screenshot(width, height, pixels)

  expect(cropViewportPng(image, width, { x: 0, y: 0, width: 875, height })).toBeNull()
})
