import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { activate } from '../main'
import { FEEDBACK_FULL, MAX_COMMENT_LENGTH, MAX_COMMENTS, type Capture, type Comment } from '../src/contract'
import { FeedbackStore } from '../src/store'

class KindError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message)
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quirky-feedback-'))
})

afterEach(() => {
  try { chmodSync(dir, 0o700) } catch { /* directory may already be gone */ }
  rmSync(dir, { recursive: true, force: true })
})

function fakeContext(dataDir: string) {
  const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  const context = {
    pluginId: 'quirky.feedback',
    dataDir,
    provide(id: string, implementation: unknown) {
      handlers.set(id, implementation as (params: Record<string, unknown>) => unknown)
    },
    error(kind: string, message: string) { return new KindError(kind, message) }
  } as unknown as PluginContext
  return { context, handlers }
}

function newStore(dataDir = dir): FeedbackStore {
  return new FeedbackStore(fakeContext(dataDir).context)
}

function capture(overrides: Record<string, unknown> = {}): Capture {
  return {
    kind: 'element',
    owner: 'quirky.git',
    elementPath: 'main > button',
    selector: '[data-x]',
    role: 'button',
    accessibleName: 'Save',
    visibleText: 'Save',
    nearbyText: [],
    attributes: {},
    rect: { x: 1, y: 2, width: 3, height: 4 },
    computedStyles: { color: 'red' },
    component: null,
    source: null,
    sourceCaller: null,
    build: { version: '1.0.0', commit: 'abc', channel: 'dev' },
    ...overrides
  } as Capture
}

function input(comment = 'tighten this', extra: Record<string, unknown> = {}) {
  return { intent: 'change', comment, capture: capture(), ...extra }
}

function kindOf(run: () => unknown): string | undefined {
  try { run() } catch (error) { return error instanceof KindError ? `${error.kind}:${error.message}` : `raw:${String(error)}` }
  return undefined
}

const file = () => join(dir, 'comments.json')

describe('add and list', () => {
  test('lists comments in insertion order and starts unrecovered', () => {
    const store = newStore()
    expect(store.list()).toEqual({ comments: [], recovered: false })
    const a = store.add(input('first'))
    const b = store.add(input('second'))
    const c = store.add(input('third'))
    expect(store.list().comments.map((entry) => entry.id)).toEqual([a.id, b.id, c.id])
  })

  test('assigns id and createdAt, ignoring caller-supplied values', () => {
    const before = Date.now()
    const added = newStore().add(input('x', { id: 'mine', createdAt: 5 }))
    expect(added.id).not.toBe('mine')
    expect(added.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(added.createdAt).toBeGreaterThanOrEqual(before)
  })

  test('trims text and rejects empty or over-long comments', () => {
    const store = newStore()
    expect(store.add(input('  padded  ')).comment).toBe('padded')
    expect(kindOf(() => store.add(input('   ')))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('')))).toStartWith('invalid-params')
    expect(store.add(input('a'.repeat(MAX_COMMENT_LENGTH))).comment).toHaveLength(MAX_COMMENT_LENGTH)
    expect(kindOf(() => store.add(input('a'.repeat(MAX_COMMENT_LENGTH + 1))))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input(` ${'a'.repeat(MAX_COMMENT_LENGTH)} `)))).toBeUndefined()
    expect(kindOf(() => store.add({ intent: 'change', comment: 7, capture: capture() }))).toStartWith('invalid-params')
  })

  test('rejects a bad intent and malformed captures', () => {
    const store = newStore()
    expect(kindOf(() => store.add(input('x', { intent: 'rant' })))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('x', { capture: null })))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('x', { capture: [] })))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('x', { capture: capture({ kind: 'page' }) })))).toStartWith('invalid-params')
    for (const key of ['owner', 'elementPath', 'selector']) {
      expect(kindOf(() => store.add(input('x', { capture: capture({ [key]: 3 }) })))).toStartWith('invalid-params')
    }
    expect(kindOf(() => store.add(input('x', { capture: capture({ build: { version: '1', commit: 'a' } }) })))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('x', { capture: capture({ build: null }) })))).toStartWith('invalid-params')
    expect(kindOf(() => store.add(input('x', { capture: capture({ computedStyles: { big: 'x'.repeat(70 * 1024) } }) })))).toStartWith('invalid-params')
    expect(store.list().comments).toEqual([])
  })

  test('rejects every incomplete or mistyped capture field', () => {
    const store = newStore()
    const bad: unknown[] = []
    for (const key of ['role', 'accessibleName', 'visibleText', 'nearbyText', 'attributes', 'rect', 'computedStyles', 'component', 'source', 'sourceCaller']) {
      const { [key]: _omitted, ...rest } = capture() as Record<string, unknown>
      bad.push(rest)
    }
    const mistyped: Record<string, unknown>[] = [
      { role: 3 }, { accessibleName: {} }, { visibleText: 1 }, { component: [] }, { source: false }, { sourceCaller: 2 },
      { nearbyText: 'x' }, { nearbyText: [1] }, { attributes: [] }, { attributes: { a: 1 } },
      { computedStyles: null }, { computedStyles: [] }, { computedStyles: { a: 1 } },
      { rect: null }, { rect: {} }, { rect: { x: 1, y: 2, width: 3 } }, { rect: { x: 1, y: 2, width: 3, height: '4' } },
      { rect: { x: Number.NaN, y: 2, width: 3, height: 4 } }, { rect: { x: 1, y: 2, width: Number.POSITIVE_INFINITY, height: 4 } }
    ]
    bad.push(...mistyped.map((overrides) => capture(overrides)))
    for (const value of bad) expect(kindOf(() => store.add(input('x', { capture: value })))).toStartWith('invalid-params')
    expect(store.list().comments).toEqual([])
  })

  test('accepts null and empty optional capture fields', () => {
    const store = newStore()
    const sparse = capture({ role: null, accessibleName: null, visibleText: null, nearbyText: null, attributes: null, computedStyles: {}, selector: '' })
    expect(store.add(input('x', { capture: sparse })).capture).toEqual(sparse)
  })

  test('refuses the 51st comment as a conflict without dropping anything', () => {
    const store = newStore()
    const added: Comment[] = []
    for (let index = 0; index < MAX_COMMENTS; index += 1) added.push(store.add(input(`c${index}`)))
    const failure = kindOf(() => store.add(input('one too many')))
    expect(failure).toStartWith(`conflict:${FEEDBACK_FULL}`)
    expect(store.list().comments).toEqual(added)
    expect(newStore().list().comments).toHaveLength(MAX_COMMENTS)
  })
})

describe('update, remove, clear', () => {
  test('update changes only text and intent', () => {
    const store = newStore()
    const original = store.add(input('before'))
    const updated = store.update({ id: original.id, comment: '  after ', intent: 'question', capture: capture({ owner: 'evil' }), createdAt: 1 })
    expect(updated).toEqual({ ...original, comment: 'after', intent: 'question' })
    expect(updated.capture).toEqual(original.capture)
    expect(store.update({ id: original.id, intent: 'change' }).comment).toBe('after')
    expect(store.update({ id: original.id, comment: 'only text' }).intent).toBe('change')
    expect(store.list().comments).toEqual([{ ...original, comment: 'only text', intent: 'change' }])
  })

  test('update validates input and unknown ids', () => {
    const store = newStore()
    const original = store.add(input('keep'))
    expect(kindOf(() => store.update({ id: original.id }))).toStartWith('invalid-params')
    expect(kindOf(() => store.update({ id: original.id, comment: ' ' }))).toStartWith('invalid-params')
    expect(kindOf(() => store.update({ id: original.id, comment: 'a'.repeat(MAX_COMMENT_LENGTH + 1) }))).toStartWith('invalid-params')
    expect(kindOf(() => store.update({ id: original.id, intent: 'nope' }))).toStartWith('invalid-params')
    expect(kindOf(() => store.update({ comment: 'x' }))).toStartWith('invalid-params')
    expect(kindOf(() => store.update({ id: 'missing', comment: 'x' }))).toStartWith('not-found')
    expect(store.list().comments).toEqual([original])
  })

  test('remove deletes one comment and reports unknown ids', () => {
    const store = newStore()
    const a = store.add(input('a'))
    const b = store.add(input('b'))
    expect(store.remove({ id: a.id })).toEqual({ removed: true })
    expect(store.list().comments).toEqual([b])
    expect(kindOf(() => store.remove({ id: a.id }))).toStartWith('not-found')
    expect(kindOf(() => store.remove({}))).toStartWith('invalid-params')
  })

  test('clear reports how many comments it removed', () => {
    const store = newStore()
    store.add(input('a'))
    store.add(input('b'))
    expect(store.clear()).toEqual({ cleared: 2 })
    expect(store.clear()).toEqual({ cleared: 0 })
    expect(newStore().list().comments).toEqual([])
  })
})

describe('persistence', () => {
  test('writes a 0600 file with the versioned shape and leaves no temp file', () => {
    const store = newStore()
    const added = store.add(input('persist me'))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ version: 1, comments: [added] })
    expect(readdirSync(dir)).toEqual(['comments.json'])
  })

  test('creates the data directory when missing', () => {
    const nested = join(dir, 'nested', 'data')
    newStore(nested).add(input('x'))
    expect(existsSync(join(nested, 'comments.json'))).toBe(true)
  })

  test('a second store on the same directory sees the comments', () => {
    const first = newStore()
    const a = first.add(input('a'))
    const b = first.add(input('b'))
    const second = newStore()
    expect(second.list()).toEqual({ comments: [a, b], recovered: false })
    const c = second.add(input('c'))
    expect(newStore().list().comments).toEqual([a, b, c])
  })

  test('a failed write leaves state unchanged and rejects', () => {
    const store = newStore()
    const kept = store.add(input('kept'))
    chmodSync(dir, 0o500)
    expect(kindOf(() => store.add(input('lost')))).toStartWith('raw:')
    expect(kindOf(() => store.update({ id: kept.id, comment: 'changed' }))).toStartWith('raw:')
    expect(kindOf(() => store.remove({ id: kept.id }))).toStartWith('raw:')
    expect(kindOf(() => store.clear())).toStartWith('raw:')
    expect(store.list().comments).toEqual([kept])
    chmodSync(dir, 0o700)
    expect(readdirSync(dir)).toEqual(['comments.json'])
    expect(newStore().list().comments).toEqual([kept])
  })

  test('a write or fsync failure removes the temporary file and rethrows the original error', () => {
    const store = newStore()
    const kept = store.add(input('kept'))
    for (const name of ['writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'] as const) {
      const failure = new Error(`${name} failed`)
      const real = fs[name] as (...args: unknown[]) => unknown
      let armed = true
      const spy = spyOn(fs, name).mockImplementation(((...args: unknown[]) => {
        if (armed) { armed = false; throw failure }
        return real(...args)
      }) as never)
      try {
        let thrown: unknown
        try { store.add(input('lost')) } catch (error) { thrown = error }
        expect(thrown).toBe(failure)
      } finally {
        spy.mockRestore()
      }
      expect(readdirSync(dir)).toEqual(['comments.json'])
    }
    expect(store.list().comments).toEqual([kept])
  })

  test('loads the file only on the first call', () => {
    const store = newStore()
    expect(store.list().comments).toEqual([])
    const other = newStore()
    const added = other.add(input('from elsewhere'))
    expect(store.list().comments).toEqual([])
    expect(newStore().list().comments).toEqual([added])
  })
})

describe('corrupt files', () => {
  function asideFiles(): string[] {
    return readdirSync(dir).filter((name) => /^comments\.corrupt-\d+\.json$/.test(name))
  }

  function expectRecovered(contents: string): void {
    writeFileSync(file(), contents)
    const store = newStore()
    expect(store.list()).toEqual({ comments: [], recovered: true })
    const aside = asideFiles()
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe(contents)
    expect(existsSync(file())).toBe(false)
    const added = store.add(input('fresh start'))
    expect(store.list()).toEqual({ comments: [added], recovered: true })
    expect(readFileSync(join(dir, aside[0]!), 'utf8')).toBe(contents)
  }

  const valid = (): Comment => ({ id: 'a', createdAt: 1, intent: 'change', comment: 'ok', capture: capture() })

  test('invalid JSON is set aside', () => expectRecovered('{not json'))
  test('a wrong version is set aside', () => expectRecovered(JSON.stringify({ version: 2, comments: [] })))
  test('non-array comments are set aside', () => expectRecovered(JSON.stringify({ version: 1, comments: {} })))
  test('a bad entry is set aside', () => {
    expectRecovered(JSON.stringify({ version: 1, comments: [valid(), { ...valid(), intent: 'rant' }] }))
  })
  test('an entry with a malformed capture is set aside', () => {
    expectRecovered(JSON.stringify({ version: 1, comments: [{ ...valid(), capture: { kind: 'element' } }] }))
  })
  test('an entry with an incomplete capture is set aside', () => {
    const { rect: _rect, ...incomplete } = capture()
    expectRecovered(JSON.stringify({ version: 1, comments: [{ ...valid(), capture: incomplete }] }))
  })
  test('an oversize file is set aside', () => expectRecovered(' '.repeat(8 * 1024 * 1024 + 1)))

  test('a symlink is set aside without following it', () => {
    const target = join(dir, 'target.json')
    writeFileSync(target, JSON.stringify({ version: 1, comments: [valid()] }))
    symlinkSync(target, file())
    const store = newStore()
    expect(store.list()).toEqual({ comments: [], recovered: true })
    expect(asideFiles()).toHaveLength(1)
    expect(readFileSync(target, 'utf8')).toContain('"version":1')
  })

  test('a valid file is not treated as corrupt', () => {
    writeFileSync(file(), JSON.stringify({ version: 1, comments: [valid()] }))
    expect(newStore().list()).toEqual({ comments: [valid()], recovered: false })
    expect(asideFiles()).toEqual([])
  })

  test('recovery persists across calls but a fresh instance starts clean again', () => {
    writeFileSync(file(), 'garbage')
    const store = newStore()
    store.list()
    store.add(input('x'))
    expect(store.list().recovered).toBe(true)
    expect(newStore().list().recovered).toBe(false)
  })

  test('a failed rename rejects every call and leaves the file alone', () => {
    writeFileSync(file(), 'garbage')
    chmodSync(dir, 0o500)
    const store = newStore()
    expect(kindOf(() => store.list())).toStartWith('raw:')
    expect(kindOf(() => store.add(input('x')))).toStartWith('raw:')
    chmodSync(dir, 0o700)
    expect(readFileSync(file(), 'utf8')).toBe('garbage')
    expect(asideFiles()).toEqual([])
  })
})

describe('plugin entry', () => {
  test('every manifest method has a handler and every handler a manifest method', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'quirky-plugin.json'), 'utf8')) as {
      id: string
      contributes: { method: Array<{ id: string }> }
    }
    const { context, handlers } = fakeContext(dir)
    activate(context)
    expect([...handlers.keys()].sort()).toEqual(manifest.contributes.method.map((method) => `method:${manifest.id}/${method.id}`).sort())
  })

  test('handlers drive the store', () => {
    const { context, handlers } = fakeContext(dir)
    activate(context)
    const call = (name: string, params: Record<string, unknown> = {}) => handlers.get(`method:quirky.feedback/${name}`)!(params)
    const added = call('add', input('via handler')) as Comment
    expect(call('list')).toEqual({ comments: [added], recovered: false })
    expect(call('update', { id: added.id, comment: 'edited' })).toEqual({ ...added, comment: 'edited' })
    expect(call('remove', { id: added.id })).toEqual({ removed: true })
    call('add', input('again'))
    expect(call('clear')).toEqual({ cleared: 1 })
  })
})
