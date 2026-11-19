import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CropFn, inlineImages, locateCompanion } from './companion'

const entry = join(import.meta.dir, 'companion.ts')
const SUFFIX = join('skills', 'writing-html-artifacts', 'scripts', 'companion.py')
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FAKE_COMPANION = `import json, os, sys
print(json.dumps(sys.argv[1:]))
sys.exit(int(os.environ.get("FAKE_EXIT", "0")))
`

let root: string
let home: string

function touch(path: string, content = ''): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

function cachePath(marketplace: string, version: string): string {
  return join(home, '.claude', 'plugins', 'cache', marketplace, 'quirk', version, SUFFIX)
}

function writeMarketplaces(value: unknown): void {
  touch(join(home, '.claude', 'plugins', 'known_marketplaces.json'), typeof value === 'string' ? value : JSON.stringify(value))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'companion-test-'))
  home = join(root, 'home')
  mkdirSync(home, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('locateCompanion', () => {
  test('prefers CLAUDE_PLUGIN_ROOT over the cache and marketplaces', () => {
    const pluginRoot = join(root, 'plugin')
    const fromRoot = touch(join(pluginRoot, SUFFIX))
    touch(cachePath('mkt', '1.0.0'))
    expect(locateCompanion({ CLAUDE_PLUGIN_ROOT: pluginRoot, HOME: home })).toBe(fromRoot)
  })

  test('falls through when CLAUDE_PLUGIN_ROOT has no companion', () => {
    const cached = touch(cachePath('mkt', '1.0.0'))
    expect(locateCompanion({ CLAUDE_PLUGIN_ROOT: join(root, 'nowhere'), HOME: home })).toBe(cached)
  })

  test('picks the newest cached version by numeric compare', () => {
    touch(cachePath('mkt', '1.9.0'))
    touch(cachePath('mkt', '1.10.0'))
    const newest = touch(cachePath('mkt', '2026.11.2'))
    touch(cachePath('mkt', '2026.9.30'))
    expect(locateCompanion({ HOME: home })).toBe(newest)
  })

  test('skips a newer version directory that lacks the companion', () => {
    const older = touch(cachePath('mkt', '1.0.0'))
    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'mkt', 'quirk', '9.0.0'), { recursive: true })
    expect(locateCompanion({ HOME: home })).toBe(older)
  })

  test('compares versions across marketplaces', () => {
    touch(cachePath('a', '1.0.0'))
    const newest = touch(cachePath('b', '1.2.0'))
    expect(locateCompanion({ HOME: home })).toBe(newest)
  })

  test('uses a directory marketplace when nothing is cached', () => {
    const checkout = join(root, 'quirk-checkout')
    const found = touch(join(checkout, SUFFIX))
    writeMarketplaces({
      remote: { source: { source: 'github', repo: 'a/b' } },
      local: { source: { source: 'directory', path: checkout } },
    })
    expect(locateCompanion({ HOME: home })).toBe(found)
  })

  test('prefers the cache over a directory marketplace', () => {
    const cached = touch(cachePath('mkt', '1.0.0'))
    const checkout = join(root, 'quirk-checkout')
    touch(join(checkout, SUFFIX))
    writeMarketplaces({ local: { source: { source: 'directory', path: checkout } } })
    expect(locateCompanion({ HOME: home })).toBe(cached)
  })

  test('ignores non-directory marketplace sources', () => {
    const checkout = join(root, 'quirk-checkout')
    touch(join(checkout, SUFFIX))
    writeMarketplaces({ remote: { source: { source: 'github', path: checkout } } })
    expect(locateCompanion({ HOME: home })).toBeNull()
  })

  test.each([
    ['invalid json', '{not json'],
    ['an array', '[]'],
    ['null entries', '{"a": null, "b": {"source": "directory"}}'],
  ])('skips a malformed known_marketplaces.json (%s)', (_name, body) => {
    writeMarketplaces(body)
    expect(locateCompanion({ HOME: home })).toBeNull()
  })

  test('returns null when no source has the file', () => {
    expect(locateCompanion({ HOME: home })).toBeNull()
  })
})

describe('inlineImages', () => {
  const fakeCrop: CropFn = (file, x, y, w, h) => Buffer.from(`crop:${file}:${x},${y},${w},${h}`)

  function writeImage(name: string, bytes: Buffer | string = Buffer.from(PNG_1X1, 'base64')): string {
    return touch(join(root, name), bytes as string)
  }

  test('replaces placeholders in nested objects and arrays and leaves other strings', () => {
    writeImage('a.png', 'AAA')
    writeImage('shots/b.jpg', 'BBB')
    const screen = {
      title: 'No placeholder here',
      options: [
        { id: 'one', label: 'One', html: '<img src="{{img:a.png}}">' },
        { id: 'two', label: 'Two', html: '<p>{{img:shots/b.jpg}} and {{img:a.png}}</p>' },
      ],
      select: 'single',
      count: 3,
      flag: true,
      nothing: null,
    }
    const before = JSON.stringify(screen)
    const out = inlineImages(screen, root) as typeof screen
    const a = `data:image/png;base64,${Buffer.from('AAA').toString('base64')}`
    const b = `data:image/jpeg;base64,${Buffer.from('BBB').toString('base64')}`
    expect(out.title).toBe('No placeholder here')
    expect(out.options[0]?.html).toBe(`<img src="${a}">`)
    expect(out.options[1]?.html).toBe(`<p>${b} and ${a}</p>`)
    expect(out.options[0]?.label).toBe('One')
    expect(out.count).toBe(3)
    expect(out.flag).toBe(true)
    expect(out.nothing).toBeNull()
    expect(JSON.stringify(screen)).toBe(before)
  })

  test('maps extensions to MIME types', () => {
    for (const [ext, mime] of [
      ['png', 'image/png'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['svg', 'image/svg+xml'],
    ] as const) {
      writeImage(`x.${ext}`, 'X')
      expect(inlineImages(`{{img:x.${ext}}}`, root)).toBe(`data:${mime};base64,${Buffer.from('X').toString('base64')}`)
    }
  })

  test('resolves absolute paths and relative paths against the screen directory', () => {
    const abs = writeImage('abs/img.png', 'ABS')
    writeImage('screens/rel.png', 'REL')
    const out = inlineImages({ a: `{{img:${abs}}}`, b: '{{img:rel.png}}' }, join(root, 'screens')) as Record<string, string>
    expect(out.a).toBe(`data:image/png;base64,${Buffer.from('ABS').toString('base64')}`)
    expect(out.b).toBe(`data:image/png;base64,${Buffer.from('REL').toString('base64')}`)
  })

  test('throws with the path when an image is missing', () => {
    try {
      inlineImages({ html: '{{img:missing.png}}' }, root)
      throw new Error('expected inlineImages to throw')
    } catch (error) {
      expect((error as { path?: string }).path).toBe(join(root, 'missing.png'))
      expect((error as Error).message).toContain('not found')
    }
  })

  test('hands the crop rectangle to the injected CropFn and embeds its bytes', () => {
    const file = writeImage('full.png', 'FULL')
    const out = inlineImages('{{img:full.png@10,20,300,400}}', root, fakeCrop)
    expect(out).toBe(`data:image/png;base64,${Buffer.from(`crop:${file}:10,20,300,400`).toString('base64')}`)
  })

  test('does not call the CropFn for an uncropped placeholder', () => {
    writeImage('full.png', 'FULL')
    const crop: CropFn = () => {
      throw new Error('crop should not run')
    }
    expect(inlineImages('{{img:full.png}}', root, crop)).toContain('base64,')
  })

  test.skipIf(process.platform !== 'darwin')('crops with the real sips on macOS', () => {
    const big = join(root, 'big.png')
    const source = join(root, 'src.png')
    writeFileSync(source, Buffer.from(PNG_1X1, 'base64'))
    const resize = Bun.spawnSync(['sips', '-z', '8', '8', source, '--out', big])
    expect(resize.exitCode).toBe(0)
    const out = inlineImages('{{img:big.png@2,2,4,4}}', root) as string
    const prefix = 'data:image/png;base64,'
    expect(out.startsWith(prefix)).toBe(true)
    const png = Buffer.from(out.slice(prefix.length), 'base64')
    expect(png.readUInt32BE(16)).toBe(4)
    expect(png.readUInt32BE(20)).toBe(4)
  })
})

describe('cli', () => {
  let env: Record<string, string>
  let session: string

  function run(args: string[], extra: Record<string, string> = {}) {
    const result = Bun.spawnSync([process.execPath, entry, ...args], {
      env: { ...env, ...extra },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  beforeEach(() => {
    const pluginRoot = join(root, 'plugin')
    touch(join(pluginRoot, SUFFIX), FAKE_COMPANION)
    env = { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot }
    session = join(root, 'session')
  })

  test('locate prints the companion path', () => {
    const { code, stdout } = run(['locate'])
    expect(code).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ companion: join(root, 'plugin', SUFFIX) })
  })

  test('locate exits 2 with the searched paths when nothing is found', () => {
    const { code, stdout } = run(['locate'], { CLAUDE_PLUGIN_ROOT: '' })
    expect(code).toBe(2)
    const body = JSON.parse(stdout)
    expect(body.error).toBe('companion-not-found')
    expect(Array.isArray(body.searched)).toBe(true)
    expect(body.searched.length).toBeGreaterThan(0)
  })

  test('start, wait and stop pass arguments, stdout and exit code through', () => {
    const start = run(['start', session])
    expect(start.code).toBe(0)
    expect(JSON.parse(start.stdout)).toEqual(['start', session])

    const wait = run(['wait', session, '--timeout', '5'], { FAKE_EXIT: '1' })
    expect(wait.code).toBe(1)
    expect(JSON.parse(wait.stdout)).toEqual(['wait', session, '--timeout', '5'])

    const stop = run(['stop', session])
    expect(stop.code).toBe(0)
    expect(JSON.parse(stop.stdout)).toEqual(['stop', session])
  })

  test('start exits 2 with companion-not-found when no companion exists', () => {
    const { code, stdout } = run(['start', session], { CLAUDE_PLUGIN_ROOT: '' })
    expect(code).toBe(2)
    expect(JSON.parse(stdout).error).toBe('companion-not-found')
  })

  test('show builds the screen with embedded images and shows the built file', () => {
    const screens = join(root, 'screens')
    touch(join(screens, 'before.png'), 'IMG')
    touch(join(screens, 'one.json'), JSON.stringify({ title: 'T', question: 'Q', content: '<img src="{{img:before.png}}">' }))
    const { code, stdout } = run(['show', session, join(screens, 'one.json')])
    expect(code).toBe(0)
    const built = join(session, 'built', 'one.json')
    expect(JSON.parse(stdout)).toEqual(['show', session, built])
    expect(JSON.parse(readFileSync(built, 'utf8')).content).toBe(
      `<img src="data:image/png;base64,${Buffer.from('IMG').toString('base64')}">`,
    )
  })

  test('show passes the companion exit code through', () => {
    touch(join(root, 'plain.json'), JSON.stringify({ title: 'T' }))
    expect(run(['show', session, join(root, 'plain.json')], { FAKE_EXIT: '1' }).code).toBe(1)
  })

  test('show exits 2 with the path before calling the companion when an image is missing', () => {
    touch(join(root, 'bad.json'), JSON.stringify({ content: '{{img:gone.png}}' }))
    const { code, stdout } = run(['show', session, join(root, 'bad.json')])
    expect(code).toBe(2)
    const body = JSON.parse(stdout)
    expect(body.path).toBe(join(root, 'gone.png'))
    expect(typeof body.error).toBe('string')
  })

  test('show exits 2 when the built screen is over 8 MB', () => {
    touch(join(root, 'huge.png'), Buffer.alloc(7 * 1024 * 1024) as unknown as string)
    touch(join(root, 'huge.json'), JSON.stringify({ a: '{{img:huge.png}}', b: '{{img:huge.png}}' }))
    const { code, stdout } = run(['show', session, join(root, 'huge.json')])
    expect(code).toBe(2)
    expect(JSON.parse(stdout).error).toContain('8 MB')
  })

  test('unknown commands and missing arguments exit 2 with a JSON error', () => {
    for (const args of [[], ['bogus'], ['start'], ['show', session]]) {
      const { code, stdout } = run(args)
      expect(code).toBe(2)
      expect(typeof JSON.parse(stdout).error).toBe('string')
    }
  })
})
