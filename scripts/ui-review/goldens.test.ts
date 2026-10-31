import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GOLDEN_ROOT,
  SCREENSHOT_SIZE,
  VIEWPORT,
  DEVICE_SCALE_FACTOR,
  goldenFor,
  loadGoldenReferences,
  pngDimensions,
  referenceFor
} from './goldens'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function fakeRepoWithGoldens(size: { width: number; height: number }, skip: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-ui-review-golden-test-'))
  temporaryRoots.push(root)
  const directory = join(root, GOLDEN_ROOT)
  mkdirSync(directory, { recursive: true })
  for (const kind of ['shell', 'scoped', 'popups']) {
    for (const theme of ['dark', 'light']) {
      const name = `golden-${kind}-${theme}.png`
      if (!skip.includes(name)) writeFileSync(join(directory, name), pngHeader(size.width, size.height))
    }
  }
  return root
}

describe('capture geometry', () => {
  test('screenshots are the 1400x880 viewport at device scale 2', () => {
    expect(VIEWPORT).toEqual({ width: 1400, height: 880 })
    expect(DEVICE_SCALE_FACTOR).toBe(2)
    expect(SCREENSHOT_SIZE).toEqual({ width: 2800, height: 1760 })
  })

  test('every approved golden on disk has the screenshot size', () => {
    for (const kind of ['shell', 'scoped', 'popups']) {
      for (const theme of ['dark', 'light'] as const) {
        const bytes = readFileSync(join(repoRoot, GOLDEN_ROOT, `golden-${kind}-${theme}.png`))
        expect(pngDimensions(bytes)).toEqual(SCREENSHOT_SIZE)
      }
    }
  })
})

describe('goldenFor', () => {
  test('returns the shell golden for ordinary targets', () => {
    for (const id of ['host:shell', 'host:settings', 'host:palette', 'panel:acme.git/changes', 'view:acme.editor/document']) {
      expect(basename(goldenFor(id, 'dark'))).toBe('golden-shell-dark.png')
      expect(basename(goldenFor(id, 'light'))).toBe('golden-shell-light.png')
    }
  })

  test('maps host:scoped and host:popups to their own goldens', () => {
    expect(basename(goldenFor('host:scoped', 'dark'))).toBe('golden-scoped-dark.png')
    expect(basename(goldenFor('host:scoped', 'light'))).toBe('golden-scoped-light.png')
    expect(basename(goldenFor('host:popups', 'dark'))).toBe('golden-popups-dark.png')
    expect(basename(goldenFor('host:popups', 'light'))).toBe('golden-popups-light.png')
  })

  test('resolves under the repository root it is given', () => {
    expect(goldenFor('host:shell', 'dark', '/some/root')).toBe(join('/some/root', GOLDEN_ROOT, 'golden-shell-dark.png'))
  })
})

describe('loadGoldenReferences', () => {
  test('records path and digest for every golden, selected per target and theme', () => {
    const references = loadGoldenReferences(repoRoot)
    const scoped = referenceFor(references, 'host:scoped', 'light')
    const path = goldenFor('host:scoped', 'light', repoRoot)

    expect(scoped.path).toBe(path)
    expect(scoped.sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'))
    expect(referenceFor(references, 'panel:anything', 'dark').path).toBe(goldenFor('host:shell', 'dark', repoRoot))
  })

  test('a missing golden names its path', () => {
    const root = fakeRepoWithGoldens(SCREENSHOT_SIZE, ['golden-popups-light.png'])
    expect(() => loadGoldenReferences(root)).toThrow(join(root, GOLDEN_ROOT, 'golden-popups-light.png'))
  })

  test('a golden of the wrong size names the file and both sizes', () => {
    const root = fakeRepoWithGoldens({ width: 1340, height: 600 })
    expect(() => loadGoldenReferences(root)).toThrow(/golden-shell-dark\.png.*1340x600.*2800x1760/)
  })
})
