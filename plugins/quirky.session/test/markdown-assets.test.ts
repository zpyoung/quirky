import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginErrorKind } from '@quirky/protocol'
import { createMarkdownAssets, type MarkdownAssetsResult } from '../src/markdownAssets'

let base: string
let root: string
let outside: string
let resources: { path: string; contentType: string; disposition?: string }[]
let worktreeCalls: unknown[]
let handler: ReturnType<typeof createMarkdownAssets>

class KindError extends Error {
  constructor(readonly kind: PluginErrorKind, message: string) {
    super(message)
  }
}

const context = {
  call: async (method: string, params: unknown) => {
    worktreeCalls.push({ method, params })
    return { id: 'wt', path: root }
  },
  error: (kind: PluginErrorKind, message: string) => new KindError(kind, message),
  createFileResource: async (options: { path: string; contentType: string; disposition?: 'inline' | 'attachment' }) => {
    resources.push(options)
    return { url: `/resource/${resources.length}`, revoke() {} }
  }
}

const ask = (params: Record<string, unknown>) => handler(params) as Promise<MarkdownAssetsResult>
const kindOf = async (promise: Promise<unknown>) => {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof KindError ? error.kind : 'other'
  }
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'markdown-assets-')))
  root = join(base, 'work')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(outside)
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}\n')
  writeFileSync(join(root, 'docs', 'shot.png'), 'png')
  writeFileSync(join(root, 'docs', 'logo.svg'), '<svg/>')
  writeFileSync(join(root, 'docs', 'notes.txt'), 'text')
  writeFileSync(join(outside, 'secret.ts'), 'secret')
  writeFileSync(join(outside, 'secret.png'), 'png')
  symlinkSync(outside, join(root, 'escape'))
  symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'link.ts'))
  symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside.ts'))
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const fresh = () => {
  resources = []
  worktreeCalls = []
  handler = sessionIn(root)
}

const sessionIn = (cwd: string, worktreeId = 'wt') => createMarkdownAssets({ context, sessionOf: (session) => {
  if (session !== 'chat') throw context.error('not-found', `no such session: ${session}`)
  return { cwd, worktreeId }
} })

describe('markdownAssets files', () => {
  test('resolves a relative file to its root-relative path and strips the line suffix', async () => {
    fresh()
    const result = await ask({ session: 'chat', files: ['src/a.ts', 'src/a.ts:12', 'src/a.ts:12:4', './src/a.ts:3'] })
    expect(result.files).toEqual({
      'src/a.ts': { path: 'src/a.ts' },
      'src/a.ts:12': { path: 'src/a.ts', line: 12 },
      'src/a.ts:12:4': { path: 'src/a.ts', line: 12 },
      './src/a.ts:3': { path: 'src/a.ts', line: 3 }
    })
    expect(result.images).toEqual({})
  })

  test('answers null for a missing file and for a directory', async () => {
    fresh()
    const result = await ask({ session: 'chat', files: ['src/missing.ts', 'src/nope/deep.ts:4', 'src'] })
    expect(result.files).toEqual({ 'src/missing.ts': null, 'src/nope/deep.ts:4': null, src: null })
  })

  test('accepts an absolute path inside the root and refuses one outside it', async () => {
    fresh()
    const inside = join(root, 'src', 'a.ts')
    const result = await ask({ session: 'chat', files: [inside, join(outside, 'secret.ts')] })
    expect(result.files[inside]).toEqual({ path: 'src/a.ts' })
    expect(result.files[join(outside, 'secret.ts')]).toBeNull()
  })

  test('refuses a .. that leaves the root and accepts one that stays inside', async () => {
    fresh()
    const result = await ask({ session: 'chat', files: ['../outside/secret.ts', 'src/../../outside/secret.ts', 'docs/../src/a.ts'] })
    expect(result.files['../outside/secret.ts']).toBeNull()
    expect(result.files['src/../../outside/secret.ts']).toBeNull()
    expect(result.files['docs/../src/a.ts']).toEqual({ path: 'src/a.ts' })
  })

  test('refuses a symlink that escapes the root and follows one that stays inside', async () => {
    fresh()
    const result = await ask({ session: 'chat', files: ['escape/secret.ts', 'src/link.ts', 'src/inside.ts'] })
    expect(result.files['escape/secret.ts']).toBeNull()
    expect(result.files['src/link.ts']).toBeNull()
    expect(result.files['src/inside.ts']).toEqual({ path: 'src/a.ts' })
  })
})

describe('markdownAssets in a session below the worktree root', () => {
  test('resolves from the session directory and answers worktree-relative paths', async () => {
    fresh()
    handler = sessionIn(join(root, 'src'))
    const result = await ask({ session: 'chat', files: ['a.ts', 'a.ts:7', './a.ts', '../docs/notes.txt', join(root, 'docs', 'notes.txt'), 'src/a.ts'] })
    expect(result.files).toEqual({
      'a.ts': { path: 'src/a.ts' },
      'a.ts:7': { path: 'src/a.ts', line: 7 },
      './a.ts': { path: 'src/a.ts' },
      '../docs/notes.txt': { path: 'docs/notes.txt' },
      [join(root, 'docs', 'notes.txt')]: { path: 'docs/notes.txt' },
      'src/a.ts': null
    })
    expect(worktreeCalls).toEqual([{ method: 'quirky.worktree/resolve', params: { selector: 'id:wt' } }])
  })

  test('the returned path reaches the same file from the worktree root', async () => {
    fresh()
    handler = sessionIn(join(root, 'docs'))
    const hit = (await ask({ session: 'chat', files: ['../src/a.ts'] })).files['../src/a.ts']
    expect(hit && realpathSync(join(root, hit.path))).toBe(join(root, 'src', 'a.ts'))
  })

  test('refuses a .. that leaves the worktree root, from the root and from below it', async () => {
    fresh()
    handler = sessionIn(join(root, 'src'))
    const below = await ask({ session: 'chat', files: ['../../outside/secret.ts', '../../../work/../outside/secret.ts', join(outside, 'secret.ts'), '../escape/secret.ts', 'link.ts'] })
    expect(Object.values(below.files).every((hit) => hit === null)).toBe(true)
    handler = sessionIn(root)
    const atRoot = await ask({ session: 'chat', files: ['../outside/secret.ts'] })
    expect(atRoot.files['../outside/secret.ts']).toBeNull()
  })

  test('serves a worktree image named from the session directory', async () => {
    fresh()
    handler = sessionIn(join(root, 'docs'))
    const result = await ask({ session: 'chat', images: ['shot.png', '../../outside/secret.png'] })
    expect(result.images).toEqual({ 'shot.png': '/resource/1', '../../outside/secret.png': null })
  })

  test('answers null everywhere when the worktree cannot be resolved', async () => {
    fresh()
    handler = createMarkdownAssets({
      context: { ...context, call: async () => { throw new Error('no such worktree') } },
      sessionOf: () => ({ cwd: root, worktreeId: 'gone' })
    })
    expect(await ask({ session: 'chat', files: ['src/a.ts'], images: ['docs/shot.png'] })).toEqual({ files: { 'src/a.ts': null }, images: { 'docs/shot.png': null } })
  })

  test('a floating session opens no files and keeps images inside its directory', async () => {
    fresh()
    handler = sessionIn(root, 'floating')
    const result = await ask({ session: 'chat', files: ['src/a.ts'], images: ['docs/shot.png', '../outside/secret.png'] })
    expect(result).toEqual({ files: { 'src/a.ts': null }, images: { 'docs/shot.png': '/resource/1', '../outside/secret.png': null } })
    expect(worktreeCalls).toEqual([])
  })
})

describe('markdownAssets images', () => {
  test('creates an inline resource for an image in the root and reuses it for the same file', async () => {
    fresh()
    const first = await ask({ session: 'chat', images: ['docs/shot.png', './docs/shot.png'] })
    expect(first.images['docs/shot.png']).toBe('/resource/1')
    expect(first.images['./docs/shot.png']).toBe('/resource/1')
    expect(resources).toEqual([{ path: join(root, 'docs', 'shot.png'), contentType: 'image/png', disposition: 'inline' }])
    const again = await ask({ session: 'chat', images: ['docs/shot.png'] })
    expect(again.images['docs/shot.png']).toBe('/resource/1')
    expect(resources).toHaveLength(1)
  })

  test('makes a new resource once the file changed', async () => {
    fresh()
    await ask({ session: 'chat', images: ['docs/shot.png'] })
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(root, 'docs', 'shot.png'), later, later)
    const result = await ask({ session: 'chat', images: ['docs/shot.png'] })
    expect(result.images['docs/shot.png']).toBe('/resource/2')
  })

  test('serves svg and refuses a file whose type is not an image', async () => {
    fresh()
    const result = await ask({ session: 'chat', images: ['docs/logo.svg', 'docs/notes.txt', 'src/a.ts'] })
    expect(result.images['docs/logo.svg']).toBe('/resource/1')
    expect(resources[0]!.contentType).toBe('image/svg+xml')
    expect(result.images['docs/notes.txt']).toBeNull()
    expect(result.images['src/a.ts']).toBeNull()
  })

  test('applies the same containment as files, and refuses remote and missing sources', async () => {
    fresh()
    const result = await ask({
      session: 'chat',
      images: ['../outside/secret.png', 'escape/secret.png', join(outside, 'secret.png'), 'https://x.io/p.png', '//x.io/p.png', 'docs/missing.png']
    })
    expect(Object.values(result.images).every((url) => url === null)).toBe(true)
    expect(Object.keys(result.images)).toHaveLength(6)
    expect(resources).toEqual([])
  })

  test('answers null for an image whose resource cannot be created, then tries again later', async () => {
    fresh()
    let fail = true
    handler = createMarkdownAssets({
      context: {
        ...context,
        createFileResource: async (options) => {
          if (fail) throw new Error('resources are off')
          return context.createFileResource(options)
        }
      },
      sessionOf: () => ({ cwd: root, worktreeId: 'wt' })
    })
    expect((await ask({ session: 'chat', images: ['docs/shot.png'] })).images['docs/shot.png']).toBeNull()
    fail = false
    expect((await ask({ session: 'chat', images: ['docs/shot.png'] })).images['docs/shot.png']).toBe('/resource/1')
  })
})

describe('markdownAssets params', () => {
  test('refuses a session that is not a string, and lists or entries of the wrong shape', async () => {
    fresh()
    expect(await kindOf(ask({}))).toBe('invalid-params')
    expect(await kindOf(ask({ session: 4 }))).toBe('invalid-params')
    expect(await kindOf(ask({ session: 'chat', files: 'src/a.ts' }))).toBe('invalid-params')
    expect(await kindOf(ask({ session: 'chat', files: [1] }))).toBe('invalid-params')
    expect(await kindOf(ask({ session: 'chat', images: [null] }))).toBe('invalid-params')
  })

  test('takes 200 entries and refuses 201, and 1024 characters but not 1025', async () => {
    fresh()
    const entries = (count: number) => Array.from({ length: count }, (_, index) => `src/missing-${index}.ts`)
    expect(Object.keys((await ask({ session: 'chat', files: entries(200) })).files)).toHaveLength(200)
    expect(await kindOf(ask({ session: 'chat', files: entries(201) }))).toBe('invalid-params')
    expect(await kindOf(ask({ session: 'chat', images: entries(201) }))).toBe('invalid-params')
    const long = (length: number) => `${'a'.repeat(length - 3)}.ts`
    expect((await ask({ session: 'chat', files: [long(1024)] })).files[long(1024)]).toBeNull()
    expect(await kindOf(ask({ session: 'chat', files: [long(1025)] }))).toBe('invalid-params')
  })

  test('reports an unknown session as not-found', async () => {
    fresh()
    expect(await kindOf(ask({ session: 'ghost', files: ['src/a.ts'] }))).toBe('not-found')
  })

  test('answers empty maps when asked for nothing', async () => {
    fresh()
    expect(await ask({ session: 'chat' })).toEqual({ files: {}, images: {} })
  })
})
