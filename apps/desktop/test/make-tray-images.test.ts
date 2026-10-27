import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { renderDot, writeTrayImages } from '../scripts/make-tray-images'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const assets = join(import.meta.dir, '..', 'assets')
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qtray-'))
  dirs.push(dir)
  return dir
}

function decode(png: Buffer): { width: number; height: number; pixels: Buffer } {
  expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  expect(png[24]).toBe(8)
  expect(png[25]).toBe(6)
  const data: Buffer[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * 4
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0)
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1))
  }
  return { width, height, pixels }
}

const pixel = (image: { width: number; pixels: Buffer }, x: number, y: number) =>
  Array.from(image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4))

describe('make-tray-images', () => {
  test('writes tray-dot.png at 16x16 and tray-dot@2x.png at 32x32 with a PNG signature', () => {
    const dir = temp()
    writeTrayImages(dir)
    const one = decode(readFileSync(join(dir, 'tray-dot.png')))
    const two = decode(readFileSync(join(dir, 'tray-dot@2x.png')))
    expect([one.width, one.height]).toEqual([16, 16])
    expect([two.width, two.height]).toEqual([32, 32])
  })

  test('is deterministic and matches the committed assets', () => {
    const a = temp()
    const b = temp()
    writeTrayImages(a)
    writeTrayImages(b)
    for (const name of ['tray-dot.png', 'tray-dot@2x.png']) {
      expect(readFileSync(join(a, name)).equals(readFileSync(join(b, name)))).toBe(true)
      expect(readFileSync(join(a, name)).equals(readFileSync(join(assets, name)))).toBe(true)
    }
  })

  test('the dot is amber at the centre, ringed in white, transparent in the corners', () => {
    const one = decode(readFileSync(join(assets, 'tray-dot.png')))
    expect(pixel(one, 8, 8)).toEqual([0xf5, 0x9e, 0x0b, 255])
    expect(pixel(one, 0, 0)[3]).toBe(0)
    expect(pixel(one, 15, 15)[3]).toBe(0)
    const ring = pixel(one, 8, 1)
    expect(ring[3]).toBeGreaterThan(200)
    expect(ring[0]).toBeGreaterThan(0xf5 - 1)
    expect(ring[1]).toBeGreaterThan(0xe0)
    expect(ring[2]).toBeGreaterThan(0xe0)
  })

  test('renderDot returns RGBA for the requested size', () => {
    expect(renderDot(32).length).toBe(32 * 32 * 4)
  })
})
