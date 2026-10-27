import { describe, expect, test } from 'bun:test'
import { pathsFromDrop } from '../../src/window/pane/drop'
import { KittyFlags } from '../../src/window/pane/kitty'
import { OSC52_MAX_BASE64, createOsc52Base64, createOsc52Provider } from '../../src/window/pane/osc52'
import { trimGutter } from '../../src/window/pane/selection'
import { ContextLossGuard, WebglBudget, MAX_WEBGL_PANES, loseWebglContext } from '../../src/window/pane/webgl'

describe('trimGutter', () => {
  test('SC-36: drops the leading spaces every selected line shares', () => {
    expect(trimGutter('  alpha\n  beta')).toBe('alpha\nbeta')
  })

  test('keeps relative indentation', () => {
    expect(trimGutter('    a\n      b\n    c')).toBe('a\n  b\nc')
  })

  test('a line at column zero keeps the selection as it was', () => {
    expect(trimGutter('  a\nb')).toBe('  a\nb')
  })

  test('blank lines do not count towards the shared indent', () => {
    expect(trimGutter('  a\n\n  b')).toBe('a\n\nb')
    expect(trimGutter('   \n   ')).toBe('   \n   ')
  })

  test('a single unindented line is unchanged', () => {
    expect(trimGutter('alpha')).toBe('alpha')
  })
})

describe('pathsFromDrop', () => {
  test('SC-38: reads file paths from the dropped files', () => {
    const files = [{ path: '/tmp/w/api/a b.txt' }, { path: '/tmp/w/api/c.txt' }]
    expect(pathsFromDrop({ files, getData: () => '' })).toEqual(['/tmp/w/api/a b.txt', '/tmp/w/api/c.txt'])
  })

  test('reads file URLs from a URI list and decodes them', () => {
    const list = '# comment\r\nfile:///tmp/w/api/a%20b.txt\r\nhttps://example.com/x\r\nfile:///tmp/w/api/c.txt\r\n'
    expect(pathsFromDrop({ files: [], getData: (type) => (type === 'text/uri-list' ? list : '') })).toEqual(['/tmp/w/api/a b.txt', '/tmp/w/api/c.txt'])
  })

  test('reads file URLs from plain text and drops duplicates', () => {
    const text = 'file:///tmp/x.txt\nfile:///tmp/x.txt'
    expect(pathsFromDrop({ files: [{ path: '/tmp/x.txt' }], getData: (type) => (type === 'text/plain' ? text : '') })).toEqual(['/tmp/x.txt'])
  })

  test('text that is not a file URL yields nothing', () => {
    expect(pathsFromDrop({ files: [], getData: () => 'hello world' })).toEqual([])
    expect(pathsFromDrop({ files: [{}], getData: () => '' })).toEqual([])
  })

  test('refuses a path with control characters', () => {
    expect(pathsFromDrop({ files: [{ path: '/tmp/a\nb' }], getData: () => '' })).toEqual([])
  })
})

describe('KittyFlags', () => {
  test('push, set and pop follow the keyboard protocol stack', () => {
    const kitty = new KittyFlags()
    expect(kitty.flags).toBe(0)
    kitty.push(1)
    kitty.push(5)
    expect(kitty.flags).toBe(5)
    kitty.pop(1)
    expect(kitty.flags).toBe(1)
    kitty.set(8, 1)
    expect(kitty.flags).toBe(8)
    kitty.set(1, 2)
    expect(kitty.flags).toBe(9)
    kitty.set(8, 3)
    expect(kitty.flags).toBe(1)
    kitty.pop(10)
    expect(kitty.flags).toBe(0)
  })
})

describe('OSC 52', () => {
  test('SC-61: a write within the cap reaches the clipboard and an oversized one does not', async () => {
    const written: string[] = []
    const provider = createOsc52Provider((text) => void written.push(text))
    const base64 = createOsc52Base64()
    await provider.writeText('c' as never, base64.decodeText(btoa('hello')))
    expect(written).toEqual(['hello'])
    expect(base64.decodeText('A'.repeat(OSC52_MAX_BASE64 + 4))).toBe('')
  })

  test('reads are never answered with clipboard text', async () => {
    const provider = createOsc52Provider(() => {})
    expect(await provider.readText('c' as never)).toBe('')
  })

  test('an empty decoded write does not clear the clipboard', async () => {
    const written: string[] = []
    const provider = createOsc52Provider((text) => void written.push(text))
    await provider.writeText('c' as never, '')
    expect(written).toEqual([])
  })
})

describe('WebglBudget', () => {
  test('SC-75: hands out at most 12 slots and takes one back on release', () => {
    const budget = new WebglBudget(MAX_WEBGL_PANES)
    const taken = Array.from({ length: 14 }, () => budget.tryAcquire())
    expect(taken.filter(Boolean)).toHaveLength(12)
    expect(budget.count).toBe(12)
    budget.release()
    expect(budget.count).toBe(11)
    expect(budget.tryAcquire()).toBe(true)
    expect(budget.tryAcquire()).toBe(false)
  })

  test('release never goes below zero', () => {
    const budget = new WebglBudget(2)
    budget.release()
    expect(budget.count).toBe(0)
  })
})

describe('ContextLossGuard', () => {
  test('three losses within 60 s trip it, older losses do not count', () => {
    let now = 0
    const guard = new ContextLossGuard(3, 60_000, () => now)
    expect(guard.record()).toBe(false)
    now = 30_000
    expect(guard.record()).toBe(false)
    now = 70_000
    expect(guard.record()).toBe(false)
    now = 80_000
    expect(guard.record()).toBe(true)
  })
})

describe('loseWebglContext', () => {
  test('asks the canvas context to lose itself and tolerates canvases without one', () => {
    let lost = 0
    const plain = {
      getContext: () => {
        throw new Error('boom')
      }
    }
    const gl = {
      getContext: (type: string) =>
        type === 'webgl2' ? { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => void (lost += 1) } : null) } : null
    }
    const root = { querySelectorAll: () => [plain, gl] } as unknown as Element
    loseWebglContext(root)
    expect(lost).toBe(1)
    loseWebglContext(undefined)
  })
})
