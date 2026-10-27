import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { acquireAttachment } from '../src/attachments.ts'

const roots: string[] = []

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-dock-attachments-'))
  roots.push(root)
  return root
}

function file(root: string, path: string, content: string | Buffer): string {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  return target
}

function context(root: string): PluginContext {
  const dataDir = join(root, 'plugin-data')
  mkdirSync(dataDir, { recursive: true })
  return {
    home: join(root, '.quirky'),
    dataDir,
    error: (_kind: string, message: string) => new Error(message)
  } as unknown as PluginContext
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('acquireAttachment', () => {
  test('copies an existing regular path into private storage without deleting the source', async () => {
    const root = sandbox()
    const source = file(root, 'caller/source.txt', 'attachment text')
    const ctx = context(root)

    const attachment = await acquireAttachment(ctx, { path: source })

    expect(attachment).toMatchObject({
      id: expect.any(String),
      name: 'source.txt',
      mime: 'text/plain',
      image: false
    })
    expect(attachment.path.startsWith(ctx.dataDir)).toBe(true)
    expect(attachment.path).not.toBe(source)
    expect(readFileSync(attachment.path, 'utf8')).toBe('attachment text')
    expect(readFileSync(source, 'utf8')).toBe('attachment text')
  })

  test('stores strict uploaded bytes under a generated name and preserves display metadata', async () => {
    const root = sandbox()
    const ctx = context(root)
    const bytes = Buffer.from('fake png bytes')

    const attachment = await acquireAttachment(ctx, {
      name: '../diagram.png',
      mime: 'image/png',
      base64: bytes.toString('base64')
    })

    expect(attachment).toMatchObject({ name: '../diagram.png', mime: 'image/png', image: true })
    expect(attachment.path.startsWith(ctx.dataDir)).toBe(true)
    expect(attachment.path).not.toContain('../diagram.png')
    expect(attachment.path.split('/').at(-1)).toMatch(/^upload-[0-9a-f-]+\.png$/)
    expect(readFileSync(attachment.path)).toEqual(bytes)
    const duplicate = await acquireAttachment(ctx, {
      name: '../diagram.png',
      mime: 'image/png',
      base64: bytes.toString('base64')
    })
    expect(duplicate.id).not.toBe(attachment.id)
    expect(duplicate.path).not.toBe(attachment.path)
  })

  test('rejects symlink paths and browser-only fake paths without creating a copy', async () => {
    const root = sandbox()
    const outside = file(root, 'caller/real.txt', 'caller data')
    const link = join(root, 'caller/link.txt')
    symlinkSync(outside, link)
    const ctx = context(root)

    await expect(acquireAttachment(ctx, { path: link })).rejects.toThrow()
    await expect(acquireAttachment(ctx, { path: 'C:\\fakepath\\image.png' })).rejects.toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('caller data')
    expect(await readdir(ctx.dataDir)).toEqual([])
  })

  test('rejects malformed and oversized uploads and files above ten MiB', async () => {
    const root = sandbox()
    const ctx = context(root)
    const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1, 7)
    const oversizedSource = file(root, 'caller/large.bin', tooLarge)

    await expect(acquireAttachment(ctx, { name: 'bad.txt', base64: 'not base64!' })).rejects.toThrow()
    await expect(acquireAttachment(ctx, { name: 'noncanonical.txt', base64: 'AB==' })).rejects.toThrow()
    await expect(acquireAttachment(ctx, { name: 'large.bin', base64: tooLarge.toString('base64') })).rejects.toThrow()
    await expect(acquireAttachment(ctx, { path: oversizedSource })).rejects.toThrow()
    expect(readFileSync(oversizedSource).byteLength).toBe(10 * 1024 * 1024 + 1)
    expect(await readdir(ctx.dataDir)).toEqual([])
  })
})
