/**
 * Writes the amber tray attention dot to `apps/desktop/assets/` (`tray-dot.png` at 16x16 and
 * `tray-dot@2x.png` at 32x32). Output is byte-stable so the committed files can be diffed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const AMBER = [0xf5, 0x9e, 0x0b] as const
const WHITE = [0xff, 0xff, 0xff] as const
const BASE_SIZE = 16
const SAMPLES = 4

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** A PNG file (8-bit RGBA, no interlace, filter 0) for `rgba` pixels in row-major order. */
export function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * RGBA pixels of the dot at `size` pixels square: an amber disc ringed in white, transparent
 * outside. Geometry is defined at 16 px (disc radius 6, ring 1 px) and scales with `size`;
 * edges are antialiased by supersampling.
 */
export function renderDot(size: number): Buffer {
  const scale = size / BASE_SIZE
  const centre = size / 2
  const discRadius = 6 * scale
  const ringRadius = 7 * scale
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let amber = 0
      let white = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const distance = Math.hypot(x + (sx + 0.5) / SAMPLES - centre, y + (sy + 0.5) / SAMPLES - centre)
          if (distance <= discRadius) amber += 1
          else if (distance <= ringRadius) white += 1
        }
      }
      const covered = amber + white
      if (covered === 0) continue
      const offset = (y * size + x) * 4
      for (let channel = 0; channel < 3; channel++) {
        out[offset + channel] = Math.round(
          ((AMBER[channel] as number) * amber + (WHITE[channel] as number) * white) / covered
        )
      }
      out[offset + 3] = Math.round((covered * 255) / (SAMPLES * SAMPLES))
    }
  }
  return out
}

/** Writes `tray-dot.png` and `tray-dot@2x.png` into `dir`, creating it if needed. */
export function writeTrayImages(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const [name, size] of [
    ['tray-dot.png', BASE_SIZE],
    ['tray-dot@2x.png', BASE_SIZE * 2]
  ] as const) {
    writeFileSync(join(dir, name), encodePng(size, size, renderDot(size)))
  }
}

if (import.meta.main) {
  const dir = join(import.meta.dir, '..', 'assets')
  writeTrayImages(dir)
  console.log(`wrote tray images to ${dir}`)
}
