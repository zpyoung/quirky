import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginErrorKind, PluginStore, QuirkyEvent } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { ComposerDrafts, MAX_PASTED_IMAGE_BYTES, type Draft } from '../src/drafts'
import { sessionMigrations } from '../src/records'
import { memoryStore } from './memory-store'

const draft: Draft = {
  text: 'hello',
  images: ['/tmp/a.png'],
  pastes: [{ id: 'p1', text: 'pasted' }],
  picks: { model: 'opus', effort: null, mode: 'plan', plan: true }
}

const fail = (kind: PluginErrorKind, message: string) => Object.assign(new Error(message), { kind })
const kindOf = (run: () => unknown): string | undefined => {
  try {
    run()
  } catch (error) {
    return (error as { kind?: string }).kind
  }
  return undefined
}

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})
const tempDir = () => {
  const dir = makeTempHome('quirky-drafts-')
  homes.push(dir)
  return dir
}
const make = (store: PluginStore = memoryStore(), dataDir = tempDir(), known = ['s_1']) =>
  new ComposerDrafts(store, dataDir, (id) => known.includes(id), fail)

describe('composer drafts', () => {
  test('save, read and clear round trip', () => {
    const drafts = make()
    expect(drafts.draft({ session: 's_1' })).toBeNull()
    expect(drafts.saveDraft({ session: 's_1', draft })).toEqual({ ok: true })
    expect(drafts.draft({ session: 's_1' })).toEqual(draft)
    drafts.saveDraft({ session: 's_1', draft: { ...draft, text: 'second' } })
    expect(drafts.draft({ session: 's_1' })?.text).toBe('second')
    expect(drafts.clearDraft({ session: 's_1' })).toEqual({ ok: true })
    expect(drafts.draft({ session: 's_1' })).toBeNull()
  })

  test('drafts are not checked against session records', () => {
    const drafts = make(memoryStore(), tempDir(), [])
    drafts.saveDraft({ session: 'unborn', draft })
    expect(drafts.draft({ session: 'unborn' })).toEqual(draft)
  })

  test('a draft survives reopening the store', () => {
    const home = tempDir()
    const open = () => openPluginStore({ home, pluginId: 'quirky.session', migrations: sessionMigrations(home), isActive: () => true })
    const first = open()
    make(first.store, home).saveDraft({ session: 's_1', draft })
    first.close()
    const second = open()
    expect(make(second.store, home).draft({ session: 's_1' })).toEqual(draft)
    second.close()
  })

  test('rejects drafts that do not match the schema or exceed 64 KiB', () => {
    const drafts = make()
    const bad: unknown[] = [
      null,
      'text',
      { ...draft, text: 3 },
      { ...draft, images: [1] },
      { ...draft, pastes: [{ id: 'p' }] },
      { ...draft, picks: { ...draft.picks, plan: 'yes' } },
      { ...draft, extra: true },
      { text: 'x'.repeat(64 * 1024), images: [], pastes: [], picks: draft.picks }
    ]
    for (const value of bad) expect(kindOf(() => drafts.saveDraft({ session: 's_1', draft: value }))).toBe('invalid-params')
    expect(kindOf(() => drafts.saveDraft({ draft }))).toBe('invalid-params')
    expect(drafts.draft({ session: 's_1' })).toBeNull()
  })

  test('the removed event deletes the draft and the pasted directory', () => {
    const dataDir = tempDir()
    const drafts = make(memoryStore(), dataDir, ['s_1', 's_2'])
    drafts.saveDraft({ session: 's_1', draft })
    drafts.saveDraft({ session: 's_2', draft })
    const { path } = drafts.pasteImage({ session: 's_1', mime: 'image/png', data: 'iVBORw0=' })
    const other = drafts.pasteImage({ session: 's_2', mime: 'image/png', data: 'iVBORw0=' }).path

    drafts.onEvent({ type: 'other/removed', data: { sessionId: 's_2' } } as QuirkyEvent)
    expect(drafts.draft({ session: 's_2' })).toEqual(draft)

    drafts.onEvent({ type: 'quirky.session/removed', data: { sessionId: 's_1' } } as QuirkyEvent)
    expect(drafts.draft({ session: 's_1' })).toBeNull()
    expect(existsSync(join(dataDir, 'pasted', 's_1'))).toBe(false)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(other)).toBe(true)
    expect(drafts.draft({ session: 's_2' })).toEqual(draft)
  })

  test('a removed event with a path-like id never deletes outside pasted/', () => {
    const dataDir = tempDir()
    const drafts = make(memoryStore(), dataDir)
    drafts.onEvent({ type: 'quirky.session/removed', data: { sessionId: '..' } } as QuirkyEvent)
    expect(existsSync(dataDir)).toBe(true)
  })
})

describe('pasteImage', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

  test('writes the decoded bytes under dataDir/pasted/<session>', () => {
    const dataDir = tempDir()
    const { path } = make(memoryStore(), dataDir).pasteImage({ session: 's_1', mime: 'image/png', data: png.toString('base64') })
    expect(path.startsWith(join(dataDir, 'pasted', 's_1') + '/')).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    expect(readFileSync(path).equals(png)).toBe(true)
  })

  test('uses the extension of each allowed mime', () => {
    const drafts = make()
    const extensions = (['image/jpeg', 'image/gif', 'image/webp'] as const).map((mime) =>
      drafts.pasteImage({ session: 's_1', mime, data: png.toString('base64') }).path.split('.').pop())
    expect(extensions).toEqual(['jpg', 'gif', 'webp'])
  })

  test('rejects another mime, bad base64 and oversize data', () => {
    const drafts = make()
    const data = png.toString('base64')
    expect(kindOf(() => drafts.pasteImage({ session: 's_1', mime: 'image/svg+xml', data }))).toBe('invalid-params')
    expect(kindOf(() => drafts.pasteImage({ session: 's_1', mime: 'image/png', data: 'not base64!' }))).toBe('invalid-params')
    expect(kindOf(() => drafts.pasteImage({ session: 's_1', mime: 'image/png', data: 5 }))).toBe('invalid-params')
    const big = Buffer.alloc(MAX_PASTED_IMAGE_BYTES + 1).toString('base64')
    expect(kindOf(() => drafts.pasteImage({ session: 's_1', mime: 'image/png', data: big }))).toBe('invalid-params')
    const exact = Buffer.alloc(MAX_PASTED_IMAGE_BYTES).toString('base64')
    expect(drafts.pasteImage({ session: 's_1', mime: 'image/png', data: exact }).path).toContain('/pasted/s_1/')
  })

  test('an unknown or path-like session is not-found and writes nothing', () => {
    const dataDir = tempDir()
    const drafts = make(memoryStore(), dataDir, ['s_1', '../escape'])
    const data = png.toString('base64')
    expect(kindOf(() => drafts.pasteImage({ session: 'ghost', mime: 'image/png', data }))).toBe('not-found')
    expect(kindOf(() => drafts.pasteImage({ session: '../escape', mime: 'image/png', data }))).toBe('not-found')
    expect(existsSync(join(dataDir, 'pasted'))).toBe(false)
  })
})
