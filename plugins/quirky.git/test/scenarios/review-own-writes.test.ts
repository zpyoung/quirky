import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcErrorCode, type QuirkyEvent, type Repo, type ReviewModel, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { makeTempDir } from '../../../../packages/daemon/test/plugins/fixtures'
import { waitForAsync } from '../../../../packages/daemon/test/helpers'
import { keepReviewAfterEditorSave } from '../../src/daemon/review'
import type { DaemonEnv } from '../../src/daemon/env'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../../quirky.repo/test/harness'
import { makeOrigin, makeProject } from '../../../quirky.worktree/test/fixtures/repos'

setDefaultTimeout(60_000)
const { scratch } = isolateGitConfig()

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

type World = { t: PluginHarness; feat: Worktree; events: QuirkyEvent[]; cleanup(): Promise<void> }
let w: World | undefined
afterEach(async () => {
  await w?.cleanup()
  w = undefined
})

/** A daemon with the real repo, worktree, git and editor plugins on real git, and worktree feat of project api. */
async function startWorld(): Promise<World> {
  const t = await startPluginHarness({ plugins: ['quirky.repo', 'quirky.worktree', 'quirky.git', 'quirky.terminal', 'quirky.editor'], realGit: true })
  const root = realpathSync(makeTempDir('qs-'))
  await t.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const originDir = makeOrigin(join(scratch(), 'origin.git'), { files: { 'a.ts': 'one\n', 'b.ts': 'bee\n' } })
  const repoDir = makeProject(join(scratch(), 'api'), { origin: originDir })
  const repo = (await t.client.callAny('quirky.repo/add', { path: repoDir })) as Repo
  const made = (await t.client.callAny('quirky.worktree/create', {
    repo: repo.id,
    name: 'feat',
    branchName: 'zoe/feat',
    base: 'origin/main',
    setup: 'skip'
  })) as WorktreeCreateResult
  const watcher = await t.h.connectWithEvents('cli')
  // the editor reports canonical paths, and macOS temp directories sit behind a symlink
  return { t, feat: { ...made.worktree, path: realpathSync(made.worktree.path) }, events: watcher.events, cleanup: () => t.cleanup() }
}

const events = (): QuirkyEvent[] => w!.events
const savedEvents = () => events().filter((event) => event.type === 'quirky.editor/saved')
const call = (method: string, params: Record<string, unknown> = {}): Promise<any> => w!.t.client.callAny(method, params)
const api = (method: string, params: Record<string, unknown> = {}): Promise<any> => call(`quirky.git/${method}`, { worktree: w!.feat.id, ...params })
const write = (rel: string, text: string) => {
  mkdirSync(dirname(join(w!.feat.path, rel)), { recursive: true })
  writeFileSync(join(w!.feat.path, rel), text)
}
const markOf = async (path: string) => ((await api('review')) as ReviewModel).files.find((file) => file.path === path)?.mark
const markAs = (path: string, expected?: string | null) => api('setReviewMark', { path, reviewed: true, ...(expected === undefined ? {} : { expected }) })

/** Opens `rel` in the editor, replaces its text with `content` and saves it. */
async function editorSave(rel: string, content: string): Promise<void> {
  const buffer = (await call('quirky.editor/open', { worktree: w!.feat.id, path: rel })) as { id: string; contentRevision: number }
  await call('quirky.editor/draft', { bufferId: buffer.id, content, expectedRevision: buffer.contentRevision })
  await call('quirky.editor/save', { bufferId: buffer.id, trigger: 'user' })
}

describe('quirky.git/save', () => {
  test('with expected equal to the marked hash, the file stays reviewed and the stored hash moves', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')

    const saved = await api('save', { path: 'a.ts', content: 'one\ntwo\nthree\n', expected: sha256('one\ntwo\n') })
    expect(saved).toEqual({ hash: sha256('one\ntwo\nthree\n') })
    expect(await markOf('a.ts')).toBe('reviewed')
    expect(await api('reviewedContent', { path: 'a.ts' })).toEqual({
      content: 'one\ntwo\nthree\n',
      hash: sha256('one\ntwo\nthree\n'),
      binary: false,
      tooLarge: false
    })

    write('a.ts', 'one\ntwo\nthree\nfour\n')
    expect(await markOf('a.ts')).toBe('changed')
  })

  test('with an expected that is not the marked hash, the mark stays and the file shows changed', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')
    write('a.ts', 'one\nagent\n')

    await api('save', { path: 'a.ts', content: 'one\nmine\n', expected: sha256('one\nagent\n') })
    expect(await markOf('a.ts')).toBe('changed')
    expect(await api('reviewedContent', { path: 'a.ts' })).toMatchObject({ content: 'one\ntwo\n' })
  })

  test('a refused save, or one without expected, leaves the mark alone', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')

    const refused = await api('save', { path: 'a.ts', content: 'x\n', expected: sha256('stale') }).catch((error) => error)
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, data: { reason: 'changed-on-disk' } })
    expect(await markOf('a.ts')).toBe('reviewed')

    await api('save', { path: 'a.ts', content: 'overwritten\n' })
    expect(await markOf('a.ts')).toBe('changed')
  })

  test('announces reviewChanged when a mark moves', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')
    const before = events().filter((event) => event.type === 'quirky.git/reviewChanged').length

    await api('save', { path: 'a.ts', content: 'one\n2\n', expected: sha256('one\ntwo\n') })
    await waitForAsync(() => events().filter((event) => event.type === 'quirky.git/reviewChanged').length > before)
  })
})

describe('quirky.editor/saved', () => {
  test('a save whose beforeHash is the marked hash keeps the file reviewed at the saved content', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')

    await editorSave('a.ts', 'one\ntwo\nthree\n')
    await waitForAsync(async () => (await api('reviewedContent', { path: 'a.ts' })).hash === sha256('one\ntwo\nthree\n'))
    expect(await markOf('a.ts')).toBe('reviewed')
    expect(savedEvents()).toHaveLength(1)
  })

  test('a save over bytes the user did not review leaves the file changed', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await markAs('a.ts')
    write('a.ts', 'one\nagent\n')

    await editorSave('a.ts', 'one\nagent\nmine\n')
    await waitForAsync(() => savedEvents().length === 1)
    // a second marked file saved afterwards shows the first event has been handled by then
    write('b.ts', 'bee\nbuzz\n')
    await markAs('b.ts')
    await editorSave('b.ts', 'bee\nbuzz\nbang\n')
    await waitForAsync(async () => (await api('reviewedContent', { path: 'b.ts' })).hash === sha256('bee\nbuzz\nbang\n'))

    expect(await markOf('a.ts')).toBe('changed')
    expect(await api('reviewedContent', { path: 'a.ts' })).toMatchObject({ content: 'one\ntwo\n' })
  })

  test('a file without a mark gets none', async () => {
    w = await startWorld()
    write('a.ts', 'one\ntwo\n')
    await editorSave('a.ts', 'one\nthree\n')
    await waitForAsync(() => savedEvents().length === 1)
    expect((await api('reviewedContent', { path: 'a.ts' }).catch((error) => error)).code).toBe(RpcErrorCode.NotFound)
    expect(await markOf('a.ts')).toBe('none')
  })
})

describe('the saved handler on its own', () => {
  // the editor cannot open a file outside every worktree, so these events are delivered by hand
  const untouched = new Proxy({}, { get: () => { throw new Error('the store must not be touched') } })
  const envWith = (resolve: () => Promise<unknown>, logs: string[] = []) =>
    ({ context: { call: resolve, log: (line: string) => logs.push(line) }, reviewMarks: untouched }) as unknown as DaemonEnv

  test('a path outside every worktree, a failed resolve and a folder workspace are ignored without throwing', async () => {
    const logs: string[] = []
    const noWorktree = envWith(async () => { throw new Error('no worktree matches current') }, logs)
    await expect(keepReviewAfterEditorSave(noWorktree, { path: '/nowhere/x.txt', beforeHash: null, afterHash: 'h' })).resolves.toBeUndefined()
    expect(logs).toHaveLength(1)

    const folder = envWith(async () => ({ id: 'w', kind: 'folder', path: '/nowhere' }))
    await expect(keepReviewAfterEditorSave(folder, { path: '/nowhere/x.txt', beforeHash: null, afterHash: 'h' })).resolves.toBeUndefined()

    const elsewhere = envWith(async () => ({ id: 'w', kind: 'worktree', path: realpathSync(makeTempDir('wt-')) }))
    await expect(keepReviewAfterEditorSave(elsewhere, { path: '/nowhere/x.txt', beforeHash: null, afterHash: 'h' })).resolves.toBeUndefined()
  })

  test('malformed event data is ignored', async () => {
    const env = envWith(async () => { throw new Error('must not resolve') })
    for (const data of [undefined, null, {}, { path: 'relative.txt', beforeHash: null, afterHash: 'h' }, { path: '/x', beforeHash: 3, afterHash: 'h' }, { path: '/x', beforeHash: null }]) {
      await expect(keepReviewAfterEditorSave(env, data)).resolves.toBeUndefined()
    }
  })
})
