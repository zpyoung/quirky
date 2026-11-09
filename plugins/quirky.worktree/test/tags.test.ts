import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type Worktree } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { call, failure, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import type { WorktreeControl } from '../src/control-types'
import type { Tag } from '../src/view-types'
import { addExternalWorktree, listWorktrees, startRealProject, type RealProject } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
setDefaultTimeout(60_000)

let p: RealProject | undefined
afterEach(async () => {
  await p?.t.cleanup()
  p = undefined
})

async function start() {
  p = await startRealProject(scratch)
  return p
}

type TagsResult = { tags: Tag[]; assignments: Record<string, string[]> }
const tags = async (w: RealProject) => (await call(w.client, 'quirky.worktree/tags')) as TagsResult
const create = async (w: RealProject, name: string, color?: string | null) =>
  ((await call(w.client, 'quirky.worktree/tagCreate', { name, ...(color === undefined ? {} : { color }) })) as { tag: Tag }).tag

async function twoWorktrees(w: RealProject): Promise<[Worktree, Worktree]> {
  addExternalWorktree(w.repoDir, join(scratch(), 'fix-login'), 'zoe/fix-login')
  addExternalWorktree(w.repoDir, join(scratch(), 'docs'), 'zoe/docs')
  const listed = await listWorktrees(w.client, { repo: w.repo.id })
  return [listed.find((wt) => wt.name === 'fix-login')!, listed.find((wt) => wt.name === 'docs')!]
}

describe('tags: create, rename, recolor, delete', () => {
  test('no tags to start with', async () => {
    const w = await start()
    expect(await tags(w)).toEqual({ tags: [], assignments: {} })
  })

  test('a new tag is trimmed, grey unless given a color, and has a tag_ id', async () => {
    const w = await start()
    const plain = await create(w, '  urgent  ')
    const blue = await create(w, 'release', 'blue')
    expect(plain).toMatchObject({ name: 'urgent', color: null })
    expect(plain.id).toMatch(/^tag_[0-9a-f]+$/)
    expect(blue.color).toBe('blue')
    expect((await tags(w)).tags.map((tag) => tag.name)).toEqual(['release', 'urgent'])
  })

  test('creating a name that exists, in any case, returns the existing tag and emits nothing', async () => {
    const w = await start()
    const first = await create(w, 'Urgent', 'teal')
    const watcher = await w.t.h.connectWithEvents('cli')
    const again = await create(w, ' urgent ', 'rose')
    expect(again).toEqual(first)
    expect((await tags(w)).tags).toHaveLength(1)
    await call(w.client, 'quirky.worktree/tagCreate', { name: 'other' })
    await waitFor(() => watcher.events.find((e) => e.type === 'quirky.worktree/tagsChanged'))
    expect(watcher.events.filter((e) => e.type === 'quirky.worktree/tagsChanged')).toHaveLength(1)
  })

  test('names must be 1 to 40 characters after trimming and colors must be one of the eight hues', async () => {
    const w = await start()
    for (const name of ['', '   ', 'x'.repeat(41)]) {
      expect((await failure(call(w.client, 'quirky.worktree/tagCreate', { name }))).code).toBe(RpcErrorCode.InvalidParams)
    }
    expect(await create(w, 'x'.repeat(40))).toMatchObject({ name: 'x'.repeat(40) })
    expect((await failure(call(w.client, 'quirky.worktree/tagCreate', { name: 'a', color: 'green' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('update renames, recolors and greys a tag; a name clash is refused naming the other tag', async () => {
    const w = await start()
    const urgent = await create(w, 'urgent')
    await create(w, 'later')
    const renamed = (await call(w.client, 'quirky.worktree/tagUpdate', { id: urgent.id, name: 'Soon', color: 'coral' })) as { tag: Tag }
    expect(renamed.tag).toEqual({ id: urgent.id, name: 'Soon', color: 'coral' })
    const grey = (await call(w.client, 'quirky.worktree/tagUpdate', { id: urgent.id, color: null })) as { tag: Tag }
    expect(grey.tag).toEqual({ id: urgent.id, name: 'Soon', color: null })
    const sameName = (await call(w.client, 'quirky.worktree/tagUpdate', { id: urgent.id, name: 'SOON' })) as { tag: Tag }
    expect(sameName.tag.name).toBe('SOON')
    const clash = await failure(call(w.client, 'quirky.worktree/tagUpdate', { id: urgent.id, name: 'LATER' }))
    expect(clash.code).not.toBe(RpcErrorCode.Internal)
    expect(clash.message).toContain('later')
    expect((await failure(call(w.client, 'quirky.worktree/tagUpdate', { id: 'tag_missing', name: 'x' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('assign and unassign show in tags and as tagIds on the listed worktree', async () => {
    const w = await start()
    const [fix, docs] = await twoWorktrees(w)
    const urgent = await create(w, 'urgent')
    const release = await create(w, 'release')
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id, docs.id], tagId: urgent.id, assigned: true })
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: release.id, assigned: true })
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: urgent.id, assigned: true })

    const result = await tags(w)
    expect(result.assignments[fix.id]).toEqual([release.id, urgent.id])
    expect(result.assignments[docs.id]).toEqual([urgent.id])

    const listed = (await listWorktrees(w.client, { repo: w.repo.id })) as WorktreeControl[]
    expect(listed.find((wt) => wt.id === fix.id)!.tagIds).toEqual([release.id, urgent.id])
    expect(listed.find((wt) => wt.id === docs.id)!.tagIds).toEqual([urgent.id])
    expect(listed.find((wt) => wt.isMain)!.tagIds).toEqual([])

    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: urgent.id, assigned: false })
    expect((await tags(w)).assignments[fix.id]).toEqual([release.id])
  })

  test('assigning ignores a worktree that does not exist and refuses an unknown tag', async () => {
    const w = await start()
    const [fix] = await twoWorktrees(w)
    const urgent = await create(w, 'urgent')
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: ['wt_gone', fix.id], tagId: urgent.id, assigned: true })
    expect((await tags(w)).assignments).toEqual({ [fix.id]: [urgent.id] })
    const unknown = await failure(call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: 'tag_missing', assigned: true }))
    expect(unknown.code).toBe(RpcErrorCode.NotFound)
    const bad = await failure(call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: fix.id, tagId: urgent.id, assigned: true }))
    expect(bad.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('deleting a tag drops its assignments and the tagIds that carried it', async () => {
    const w = await start()
    const [fix] = await twoWorktrees(w)
    const urgent = await create(w, 'urgent')
    const release = await create(w, 'release')
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: urgent.id, assigned: true })
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: release.id, assigned: true })
    await call(w.client, 'quirky.worktree/tagDelete', { id: urgent.id })
    expect(await tags(w)).toEqual({ tags: [release], assignments: { [fix.id]: [release.id] } })
    expect((await failure(call(w.client, 'quirky.worktree/tagDelete', { id: urgent.id }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('deleting a worktree drops its assignments', async () => {
    const w = await start()
    const [fix, docs] = await twoWorktrees(w)
    const urgent = await create(w, 'urgent')
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id, docs.id], tagId: urgent.id, assigned: true })
    await call(w.client, 'quirky.worktree/remove', { worktree: fix.id, yes: true, force: true })
    expect((await tags(w)).assignments).toEqual({ [docs.id]: [urgent.id] })
  })

  test('every tag mutation emits tagsChanged', async () => {
    const w = await start()
    const [fix] = await twoWorktrees(w)
    const watcher = await w.t.h.connectWithEvents('cli')
    const urgent = await create(w, 'urgent')
    await call(w.client, 'quirky.worktree/tagUpdate', { id: urgent.id, color: 'blue' })
    await call(w.client, 'quirky.worktree/tagAssign', { worktreeIds: [fix.id], tagId: urgent.id, assigned: true })
    await call(w.client, 'quirky.worktree/tagDelete', { id: urgent.id })
    await waitFor(() => (watcher.events.filter((e) => e.type === 'quirky.worktree/tagsChanged').length === 4 ? true : undefined))
  })
})
