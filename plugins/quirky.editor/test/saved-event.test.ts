import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QuirkyClient, QuirkyEvent } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import type { EditorBufferInfo } from '../src/types'

type SavedData = { path: string; beforeHash: string | null; afterHash: string }
type Fixture = { h: Harness; client: QuirkyClient; root: string; worktreeId: string; saved: SavedData[] }

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

let current: Fixture | undefined

afterEach(async () => {
  if (!current) return
  await current.h.cleanup()
  rmSync(current.root, { recursive: true, force: true })
  current = undefined
})

async function boot(): Promise<Fixture> {
  const home = makeHomeWithoutAutoHooks('quirky-editor-saved-')
  // the editor reports canonical paths, and macOS tmpdir is a symlink
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-editor-saved-repo-')))
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' })
  if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`)
  const h = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  const client = await h.connect('cli', 'editor-saved-test')
  await client.callAny('quirky.repo/add', { path: root })
  const worktree = await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` }) as { id: string }
  const saved: SavedData[] = []
  await client.callAny('events.subscribe', {})
  client.onEvent((event: QuirkyEvent) => {
    if ((event as { type: string }).type === 'quirky.editor/saved') saved.push((event as unknown as { data: SavedData }).data)
  })
  current = { h, client, root, worktreeId: worktree.id, saved }
  return current
}

const open = (t: Fixture, path: string) =>
  t.client.callAny('quirky.editor/open', { worktree: t.worktreeId, path }) as Promise<EditorBufferInfo>
const draft = (t: Fixture, buffer: EditorBufferInfo, content: string) =>
  t.client.callAny('quirky.editor/draft', { bufferId: buffer.id, content, expectedRevision: buffer.contentRevision }) as Promise<EditorBufferInfo>
const save = (t: Fixture, bufferId: string, trigger?: 'user' | 'overwrite') =>
  t.client.callAny('quirky.editor/save', { bufferId, ...(trigger ? { trigger } : {}) })

describe('quirky.editor/saved', () => {
  test('a user save of an existing file reports the previous and written hashes', async () => {
    const t = await boot()
    const path = join(t.root, 'a.txt')
    writeFileSync(path, 'before\n')
    const buffer = await open(t, 'a.txt')
    await draft(t, buffer, 'after\n')
    await save(t, buffer.id, 'user')
    await waitForAsync(() => t.saved.length > 0)
    expect(t.saved).toEqual([{ path, beforeHash: sha256('before\n'), afterHash: sha256('after\n') }])
  })

  test('saving a file that no longer exists on disk reports beforeHash null', async () => {
    const t = await boot()
    const path = join(t.root, 'gone.txt')
    writeFileSync(path, 'keep me\n')
    const buffer = await open(t, 'gone.txt')
    rmSync(path)
    await t.client.callAny('quirky.editor/view', { bufferId: buffer.id, action: 'reveal' })
    await save(t, buffer.id, 'user')
    await waitForAsync(() => t.saved.length > 0)
    expect(t.saved).toEqual([{ path, beforeHash: null, afterHash: sha256('keep me\n') }])
  })

  test('a save refused because the disk changed underneath emits nothing', async () => {
    const t = await boot()
    const raced = join(t.root, 'raced.txt')
    writeFileSync(raced, 'old\n')
    const buffer = await open(t, 'raced.txt')
    await draft(t, buffer, 'mine\n')
    writeFileSync(raced, 'theirs\n')
    await expect(save(t, buffer.id)).rejects.toThrow()

    // events arrive in order, so a later successful save proves the refused one emitted nothing
    const control = join(t.root, 'control.txt')
    writeFileSync(control, 'c1\n')
    const other = await open(t, 'control.txt')
    await draft(t, other, 'c2\n')
    await save(t, other.id, 'user')
    await waitForAsync(() => t.saved.length > 0)
    expect(t.saved.map((event) => event.path)).toEqual([control])
  })

  test('an overwrite save reports beforeHash null', async () => {
    const t = await boot()
    const path = join(t.root, 'over.txt')
    writeFileSync(path, 'old\n')
    const buffer = await open(t, 'over.txt')
    await draft(t, buffer, 'mine\n')
    writeFileSync(path, 'theirs\n')
    await save(t, buffer.id, 'overwrite')
    await waitForAsync(() => t.saved.length > 0)
    expect(t.saved).toEqual([{ path, beforeHash: null, afterHash: sha256('mine\n') }])
  })
})
